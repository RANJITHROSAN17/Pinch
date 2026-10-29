import test from "node:test";
import assert from "node:assert/strict";
import { parseWhen, parseClock, humaniseDuration, formatClock } from "../src/timeparse.js";

const NOW = new Date("2026-10-30T10:00:00"); // local 10:00

const mins = (a, b) => Math.round((a.getTime() - b.getTime()) / 60000);

test("relative durations", () => {
  assert.equal(mins(parseWhen("in 30 minutes", NOW).at, NOW), 30);
  assert.equal(mins(parseWhen("in 2 hours", NOW).at, NOW), 120);
  assert.equal(mins(parseWhen("in 45m", NOW).at, NOW), 45);
  assert.equal(mins(parseWhen("in 1 day", NOW).at, NOW), 1440);
  assert.equal(mins(parseWhen("in half an hour", NOW).at, NOW), 30);
  assert.equal(mins(parseWhen("in an hour", NOW).at, NOW), 60);
  assert.equal(mins(parseWhen("remind me in 10 mins to drink water", NOW).at, NOW), 10);
});

test("absolute clock times roll to tomorrow when already past", () => {
  const at6pm = parseWhen("at 6pm", NOW);
  assert.equal(at6pm.at.getHours(), 18);
  assert.equal(mins(at6pm.at, NOW), 8 * 60);

  const past = parseWhen("at 9am", NOW); // 9am already gone
  assert.equal(past.at.getHours(), 9);
  assert.equal(mins(past.at, NOW), 23 * 60);

  assert.equal(parseWhen("at 18:30", NOW).at.getMinutes(), 30);
  assert.equal(parseWhen("noon", NOW).at.getHours(), 12);
});

test("tomorrow", () => {
  const t = parseWhen("tomorrow at 9am", NOW);
  assert.equal(t.at.getDate(), 31);
  assert.equal(t.at.getHours(), 9);
  const bare = parseWhen("tomorrow", NOW);
  assert.equal(bare.at.getHours(), 9); // default 9am
});

test("iso dates", () => {
  const iso = parseWhen("2026-11-05 14:30", NOW);
  assert.equal(iso.at.getFullYear(), 2026);
  assert.equal(iso.at.getMonth(), 10);
  assert.equal(iso.at.getDate(), 5);
  assert.equal(iso.at.getHours(), 14);
});

test("nonsense returns null instead of a guess", () => {
  assert.equal(parseWhen("whenever you feel like it", NOW), null);
  assert.equal(parseWhen("", NOW), null);
  assert.equal(parseWhen("soon", NOW), null);
});

test("parseClock edge cases", () => {
  assert.deepEqual(parseClock("6pm"), { h: 18, m: 0 });
  assert.deepEqual(parseClock("12am"), { h: 0, m: 0 });
  assert.deepEqual(parseClock("12pm"), { h: 12, m: 0 });
  assert.deepEqual(parseClock("23:45"), { h: 23, m: 45 });
  assert.deepEqual(parseClock("midnight"), { h: 0, m: 0 });
});

test("humaniseDuration reads like a person", () => {
  assert.equal(humaniseDuration(30 * 60000), "30 minutes");
  assert.equal(humaniseDuration(60 * 60000), "1 hour");
  assert.equal(humaniseDuration(90 * 60000), "1 hour 30 min");
  assert.equal(humaniseDuration(48 * 3600000), "2 days");
});

test("formatClock respects a timezone", () => {
  const d = new Date("2026-10-30T00:30:00Z");
  assert.match(formatClock(d, "Asia/Kolkata"), /6:00/); // +5:30
});
