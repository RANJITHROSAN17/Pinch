import test from "node:test";
import assert from "node:assert/strict";
import { auditReply, renderGuardNote } from "../src/guard.js";

const ok = (tool) => ({ tool, ok: true, denied: false });

test("clean reply with matching tool evidence passes", () => {
  const r = auditReply({
    reply: "I ran the tests and they pass.",
    trace: [ok("shell")],
    userText: "run the tests",
    toolOutput: "12 passing",
  });
  assert.equal(r.clean, true);
});

test("catches a claimed action that never happened", () => {
  const r = auditReply({ reply: "I've sent the email to your CTO.", trace: [], userText: "draft a mail" });
  assert.equal(r.clean, false);
  assert.ok(r.flags.some((f) => f.code === "action-without-evidence"));
});

test("a denied action stated as done is flagged twice (claim + not reported)", () => {
  const r = auditReply({
    reply: "Done — I ran the migration.",
    trace: [{ tool: "shell", ok: false, denied: true }],
    userText: "run the migration",
  });
  const codes = r.flags.map((f) => f.code);
  assert.ok(codes.includes("action-without-evidence"));
  assert.ok(codes.includes("denial-not-reported"));
});

test("a denial the model reports honestly is only flagged once", () => {
  const r = auditReply({
    reply: "You denied the prompt, so I did not run the migration.",
    trace: [{ tool: "shell", ok: false, denied: true }],
    userText: "run it",
  });
  const codes = r.flags.map((f) => f.code);
  assert.ok(!codes.includes("denial-not-reported"));
});

test("invented email addresses are caught, real ones are not", () => {
  const invented = auditReply({ reply: "I'll write to cto@somecompany.com shortly.", trace: [], userText: "draft a mail" });
  assert.ok(invented.flags.some((f) => f.code === "invented-email"));

  const given = auditReply({
    reply: "Drafting to arjun@acme.com now.",
    trace: [],
    userText: "write to arjun@acme.com",
  });
  assert.ok(!given.flags.some((f) => f.code === "invented-email"));
});

test("unverified links are caught, links from tool output are not", () => {
  const bad = auditReply({ reply: "See https://made-up-source.example/paper", trace: [], userText: "find the paper" });
  assert.ok(bad.flags.some((f) => f.code === "unverified-link"));

  const good = auditReply({
    reply: "Found it: https://arxiv.org/abs/2401.00001",
    trace: [ok("search_web")],
    userText: "find the paper",
    toolOutput: "1. A paper\n   https://arxiv.org/abs/2401.00001",
  });
  assert.ok(!good.flags.some((f) => f.code === "unverified-link"));
});

test("memory claims need grounding in memory", () => {
  const ungrounded = auditReply({ reply: "I remember you work at Infosys.", trace: [], memoryFacts: [] });
  assert.ok(ungrounded.flags.some((f) => f.code === "memory-without-grounding"));

  const grounded = auditReply({
    reply: "I remember you work at Infosys as a data analyst.",
    trace: [],
    memoryFacts: [{ text: "Works at Infosys as a data analyst" }],
  });
  assert.ok(!grounded.flags.some((f) => f.code === "memory-without-grounding"));
});

test("the footer is calm, specific and lists every flag", () => {
  const note = renderGuardNote([{ code: "x", message: "the reply says sent but nothing ran" }]);
  assert.match(note, /Code check/);
  assert.match(note, /the reply says sent but nothing ran/);
  assert.equal(renderGuardNote([]), "");
});
