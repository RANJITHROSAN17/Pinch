/**
 * test/schedules.test.js — unattended runs, and the wall around them.
 *
 * The feature is "do this every morning and tell me". The risk is that a
 * schedule is an agent turn with nobody to approve anything, so most of these
 * tests are about what a scheduled run is *not* allowed to do.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = mkdtempSync(join(tmpdir(), "pinch-sched-"));
process.env.PINCH_DATA = dataDir;
process.env.LLM_PROVIDER = "mock";

const { ensureData } = await import("../src/store.js");
const { parseCadence, nextRun, addSchedule, listSchedules, deleteSchedule, markRun, dueSchedules, MAX_SCHEDULES } =
  await import("../src/schedules.js");
ensureData();

/* ───────────────────────────── the cadence ─────────────────────────────── */

test("every one of the three cadence shapes parses", () => {
  assert.equal(parseCadence("every 30m").kind, "interval");
  assert.equal(parseCadence("every 2h").everyMs, 2 * 3_600_000);
  assert.equal(parseCadence("daily at 09:00").minuteOfDay, 9 * 60);
  assert.equal(parseCadence("daily at 9am").minuteOfDay, 9 * 60);
  assert.equal(parseCadence("weekly on mon at 8:00").day, 1);
});

test("a cadence nobody can predict is refused rather than guessed", () => {
  for (const bad of ["", "nonsense", "every 1m", "every zero", "daily at 25:00", "daily at 9:99"]) {
    assert.equal(parseCadence(bad), null, `accepted: ${JSON.stringify(bad)}`);
  }
});

test("nextRun is always strictly in the future, so a slot cannot fire twice", () => {
  const at = new Date("2026-10-31T09:00:00");
  // Daily at 09:00, evaluated at exactly 09:00 — tomorrow, not now.
  const cadence = parseCadence("daily at 09:00");
  const next = nextRun({ cadence }, at);
  assert.ok(next.getTime() > at.getTime(), "next run was not in the future");
  assert.equal(next.getTime() - at.getTime(), 86_400_000);
});

test("a weekly schedule lands on the right weekday", () => {
  const friday = new Date("2026-10-30T10:00:00");
  const next = nextRun({ cadence: parseCadence("weekly on mon at 8:00") }, friday);
  assert.equal(next.getDay(), 1, "not a Monday");
  assert.ok(next.getTime() > friday.getTime());
});

test("an interval counts from the last run, not from the clock", () => {
  const cadence = parseCadence("every 2h");
  const now = new Date("2026-10-31T12:00:00");
  const lastRun = "2026-10-31T11:30:00.000Z";
  const next = nextRun({ cadence, lastRun }, now);
  assert.equal(next.toISOString(), "2026-10-31T13:30:00.000Z");
});

/* ────────────────────────────── the store ──────────────────────────────── */

test("a schedule carries where it came from, so the answer goes back there", () => {
  const result = addSchedule({ task: "summarise my unread issues", when: "daily at 09:00", address: "telegram:42", channel: "telegram" });
  assert.equal(result.ok, true);
  assert.equal(result.schedule.address, "telegram:42");
  assert.ok(result.schedule.nextRun, "no next run was computed");
  deleteSchedule(result.schedule.id);
});

test("an unreadable cadence is refused with the shapes that work", () => {
  const result = addSchedule({ task: "x", when: "whenever", address: "web:main" });
  assert.equal(result.ok, false);
  assert.match(result.output, /every 30m/);
});

test("the number of schedules is bounded", () => {
  const created = [];
  for (let i = 0; i < MAX_SCHEDULES; i++) {
    const r = addSchedule({ task: `task ${i}`, when: "every 30m", address: "web:main" });
    if (r.ok) created.push(r.schedule.id);
  }
  const overflow = addSchedule({ task: "one too many", when: "every 30m", address: "web:main" });
  assert.equal(overflow.ok, false);
  assert.match(overflow.output, /Remove one/);
  for (const id of created) deleteSchedule(id);
});

test("markRun advances the schedule and counts the run", () => {
  const { schedule } = addSchedule({ task: "tick", when: "every 30m", address: "web:main" });
  const before = schedule.nextRun;
  const after = markRun(schedule.id, new Date("2026-10-31T10:00:00"));
  assert.equal(after.runs, 1);
  assert.notEqual(after.nextRun, before);
  deleteSchedule(schedule.id);
});

test("only due schedules are picked up", () => {
  const { schedule } = addSchedule({ task: "due", when: "daily at 09:00", address: "web:main" });
  assert.equal(dueSchedules(new Date("2020-01-01T00:00:00Z")).length, 0);
  assert.equal(dueSchedules(new Date("2099-01-01T00:00:00Z")).length, 1);
  deleteSchedule(schedule.id);
});

/* ─────────────── the wall: what an unattended run may not do ───────────── */

test("an unattended run refuses dangerous tools instead of prompting", async () => {
  const { runAgent, pendingApprovals } = await import("../src/agent.js");
  const { record, reset } = await import("../src/telemetry.js");
  reset();

  // The mock brain turns "run <cmd>" into a `shell` call, which is dangerous.
  const result = await runAgent({
    sessionId: "unattended-shell",
    text: "run echo hello",
    channel: "web",
    autonomy: "unattended",
  });

  // Nothing was left waiting for an approval nobody will answer.
  assert.equal(pendingApprovals("web").length, 0, "an approval was raised with no human present");
  // The refusal is in the trace, not silent.
  const denied = result.trace.filter((t) => t.denied);
  assert.equal(denied.length, 1, `expected one refusal, got ${JSON.stringify(result.trace)}`);
  assert.equal(denied[0].reason, "unattended");
  assert.equal(denied[0].tool, "shell");
});

test("an unattended run cannot create another schedule, even if the model asks", async () => {
  const { runAgent } = await import("../src/agent.js");
  const { brain } = await import("../src/brain.js");
  const { TOOL_MAP } = await import("../src/tools.js");

  // A model that does nothing but try to schedule itself is the worst case: the
  // gate is what has to hold, not the prompt.
  const original = brain.chat;
  let scheduleRan = false;
  const originalRun = TOOL_MAP.get("schedule").run;
  TOOL_MAP.get("schedule").run = async () => {
    scheduleRan = true;
    return { ok: true, output: "created" };
  };
  brain.chat = async () => ({
    content: "",
    toolCalls: [{ id: "c1", name: "schedule", arguments: { action: "add", task: "escalate", when: "every 5m" } }],
    provider: "stub",
  });

  try {
    const result = await runAgent({
      sessionId: "unattended-fork",
      text: "keep going",
      channel: "web",
      autonomy: "unattended",
      allowSchedule: false,
    });
    assert.equal(scheduleRan, false, "an unattended run created a schedule");
    const denial = result.trace.find((t) => t.tool === "schedule" && t.denied);
    assert.ok(denial, `no denial recorded: ${JSON.stringify(result.trace)}`);
    assert.match(denial.reason || "", /unattended/);
  } finally {
    brain.chat = original;
    TOOL_MAP.get("schedule").run = originalRun;
  }
});

test("an interactive run still prompts, so the gate is not weakened globally", async () => {
  const { createApproval, pendingApprovals, answerApproval } = await import("../src/agent.js");
  const pending = createApproval({ channel: "web", sessionId: "interactive", description: "run: echo hi" });
  assert.equal(pendingApprovals("web").length, 1, "an interactive approval was not raised");
  answerApproval(pending.id, false);
  await pending.promise;
});

/* ───────────────────── the tick actually runs one ──────────────────────── */

test("a due schedule runs a turn and reports to its channel", async () => {
  const { tick } = await import("../src/scheduler.js");
  const { registerSender } = await import("../src/outbound.js");

  const delivered = [];
  registerSender("web", async (_target, text) => {
    delivered.push(text);
  });

  const { schedule } = addSchedule({ task: "check the build", when: "every 30m", address: "web:main" });
  // Force it due.
  const { updateSchedule } = await import("../src/store.js");
  updateSchedule(schedule.id, { nextRun: new Date(Date.now() - 60_000).toISOString() });

  await tick(new Date());

  const mine = delivered.find((t) => t.includes("check the build"));
  assert.ok(mine, `nothing was delivered for the schedule: ${JSON.stringify(delivered)}`);
  assert.match(mine, /Scheduled/);
  assert.match(mine, /tools needing approval were refused/);

  const after = listSchedules().find((s) => s.id === schedule.id);
  assert.equal(after.runs, 1, "the run was not recorded");
  assert.ok(Date.parse(after.nextRun) > Date.now() - 5_000, "next run did not advance");

  deleteSchedule(schedule.id);
  rmSync(dataDir, { recursive: true, force: true });
});
