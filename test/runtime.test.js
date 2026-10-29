/**
 * The support policy, as code.
 *
 * Issue #1 (the tech radar) said: "Node 22 is in maintenance — plan the next
 * major bump before the EOL date." This is the plan, made executable:
 *
 *   - the floor is declared in package.json (`engines` + `pinch.node`),
 *   - the lifecycle dates live in src/runtime.js and mirror docs/SUPPORT.md,
 *   - the boot notice tells the person actually running Node 22,
 *   - and the radar re-escalates on its own if we ever forget the date.
 *
 * Dates are injected, so these tests mean the same thing in 2031.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { nodeSupport, recommendedNode, NODE_MIN, NODE_LIFECYCLE } = await import("../src/runtime.js");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

test("the policy in package.json and the table in code agree", () => {
  assert.equal(NODE_MIN, Number(pkg.pinch.node.min), "engines and pinch.node.min disagree");
  assert.equal(String(pkg.pinch.node.dropMinAt), NODE_LIFECYCLE[pkg.pinch.node.min].eol,
    "the documented drop date is not the upstream end-of-life date");
  assert.ok(pkg.pinch.node.dropMinAt > new Date().toISOString().slice(0, 10),
    "the drop date has passed — this policy needs updating (that is what the radar is for)");
});

test("the documented drop date matches docs/SUPPORT.md", () => {
  const doc = readFileSync(join(root, "docs", "SUPPORT.md"), "utf8");
  assert.match(doc, new RegExp(pkg.pinch.node.dropMinAt), "SUPPORT.md does not mention the drop date");
});

test("running the minimum supported version is supported, with an upgrade plan", () => {
  const r = nodeSupport("v22.23.4", { now: new Date("2026-10-30T00:00:00Z") });
  assert.equal(r.tier, "plan-upgrade");
  assert.match(r.message, /maintenance/i);
  assert.match(r.message, /2027-04-30/, "the notice must name the date, not just say 'soon'");
  assert.match(r.message, /docs\/SUPPORT\.md/, "and point at the policy");
});

test("newer LTS versions are not nagged about", () => {
  for (const v of ["v24.22.2", "v26.13.0"]) {
    const r = nodeSupport(v, { now: new Date("2026-10-30T00:00:00Z") });
    assert.equal(r.tier, "supported", `${v} should be quiet`);
    assert.equal(r.message, null);
  }
});

test("a version past end of life is called unsupported, loudly", () => {
  const r = nodeSupport("v20.20.2", { now: new Date("2026-10-30T00:00:00Z") });
  assert.equal(r.tier, "unsupported");
  assert.match(r.message, /end of life/i);
});

test("the minimum flips to unsupported on its own EOL date, with no code change", () => {
  const before = nodeSupport("v22.23.4", { now: new Date("2027-04-29T00:00:00Z") });
  const after = nodeSupport("v22.23.4", { now: new Date("2027-05-01T00:00:00Z") });
  assert.equal(before.tier, "plan-upgrade");
  assert.equal(after.tier, "unsupported", "the policy must expire by itself");
});

test("a version this table has never heard of is left alone", () => {
  const r = nodeSupport("v30.1.0", { now: new Date("2026-10-30T00:00:00Z") });
  assert.equal(r.tier, "unknown");
  assert.equal(r.message, null, "never warn about a future version we know nothing about");
});

test("an older-than-minimum version is named as such", () => {
  const r = nodeSupport("v21.7.0", { now: new Date("2026-10-30T00:00:00Z"), min: 22 });
  assert.equal(r.tier, "below-minimum");
  assert.match(r.message, /Node 22 or newer/);
});

test("the recommended version is the newest one still receiving patches", () => {
  assert.equal(recommendedNode(new Date("2026-10-30T00:00:00Z")), 26);
  assert.equal(recommendedNode(new Date("2029-05-01T00:00:00Z")), NODE_MIN, "behaves sanely once even 26 is gone");
});

test("the boot path uses it", () => {
  const boot = readFileSync(join(root, "src", "index.js"), "utf8");
  assert.match(boot, /nodeSupport\(\)/, "src/index.js never checks the runtime");
  assert.match(boot, /notice-node-/, "the notice is not de-duplicated per install");
});
