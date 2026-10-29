/**
 * Keeps the self-check honest.
 *
 * `scripts/audit.js` is the thing a user runs on their own install and the thing
 * the nightly workflow runs on main. If it ever stops working — throws, hangs,
 * or quietly reports success without probing anything — every scheduled
 * guarantee in this repo becomes decoration. So the monitor gets a test too.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("the self-check runs, probes everything, and passes on this tree", { timeout: 120_000 }, () => {
  const out = execFileSync(process.execPath, [join(root, "scripts", "audit.js"), "--json"], {
    cwd: root,
    encoding: "utf8",
    timeout: 110_000,
  });
  const report = JSON.parse(out);

  assert.equal(report.ok, true, "the self-check reported a failing guard rail");
  assert.ok(report.checks.length >= 12, `only ${report.checks.length} probes ran — expected at least 12`);
  assert.equal(report.failed, 0);

  // Every probe must have actually run. A checker that silently skips is worse
  // than no checker, because it reports confidence it has not earned.
  for (const check of report.checks) {
    assert.ok(["pass", "fail", "warn", "skip"].includes(check.status), `odd status: ${check.status}`);
    assert.ok(check.detail, `probe "${check.title}" produced no detail`);
  }
  const skipped = report.checks.filter((c) => c.status === "skip").length;
  assert.ok(skipped <= 2, `${skipped} probes skipped — on Linux almost nothing should`);

  // The probes that must never be skipped on a normal machine.
  const mustRun = ["sandbox-symlink", "screen-blocks", "secrets-env", "panel-xss", "http-origin", "http-host"];
  for (const id of mustRun) {
    const found = report.checks.find((c) => c.id === id);
    assert.ok(found, `probe ${id} is missing from the self-check`);
    assert.equal(found.status, "pass", `${id} did not pass: ${found.detail}`);
  }
});

test("the tech radar produces parseable findings without a model", { timeout: 60_000 }, () => {
  // --json never touches the network for its shape; sources fail soft if the
  // runner is offline, which is exactly the behaviour we want to pin.
  const out = execFileSync(process.execPath, [join(root, "scripts", "tech-radar.js"), "--json"], {
    cwd: root,
    encoding: "utf8",
    timeout: 50_000,
    env: { ...process.env, GITHUB_TOKEN: "" },
  });
  const report = JSON.parse(out);
  assert.ok(Array.isArray(report.findings));
  assert.ok(report.findings.every((f) => ["high", "medium", "low", "info"].includes(f.severity)));
  assert.ok(typeof report.engineMin === "string" && report.engineMin.length > 0);

  // Issue #1 was "Node 22 is in maintenance — plan the next major bump". The
  // plan now exists (docs/SUPPORT.md + src/runtime.js), so the radar must stop
  // reporting it as drift. If this assertion starts failing, either the policy
  // quietly expired or someone deleted it — both worth a red build.
  const runtimeDrift = report.findings.filter((f) => f.area === "runtime" && f.severity !== "info");
  assert.deepEqual(runtimeDrift, [], `runtime drift reported: ${JSON.stringify(runtimeDrift)}`);
});
