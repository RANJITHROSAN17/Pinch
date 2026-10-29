/**
 * Runtime support — when the Node version you are running stops being
 * patched, and what Pinch does about it.
 *
 * The data here mirrors [docs/SUPPORT.md](../docs/SUPPORT.md), which in turn
 * mirrors endoflife.date. `npm run radar` is what keeps the three honest: it
 * refetches the real lifecycle dates weekly and complains when this table has
 * drifted, so the table is allowed to be static — it is not allowed to be
 * forgotten.
 *
 * Deliberately no network call at boot: a local-first assistant that needs to
 * phone home to tell you your runtime is old would be a poor joke.
 */

import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

/** The oldest Node we support, taken from `engines` so there is one source of truth. */
export const NODE_MIN = Number(String(pkg.engines?.node || ">=22").replace(/[^\d.]/g, "").split(".")[0]);

/**
 * Active support / end of life, per major, from endoflife.date.
 * `support` = when it moved to maintenance (security fixes only).
 */
export const NODE_LIFECYCLE = {
  20: { support: "2024-10-22", eol: "2026-04-30" },
  22: { support: "2025-10-21", eol: "2027-04-30" },
  24: { support: "2026-10-20", eol: "2028-04-30" },
  26: { support: "2027-10-27", eol: "2029-04-30" },
};

const day = (d) => new Date(d).toISOString().slice(0, 10);

/** The newest major that is still receiving security fixes. */
export function recommendedNode(now = new Date()) {
  const today = day(now);
  const alive = Object.entries(NODE_LIFECYCLE)
    .filter(([, row]) => row.eol > today)
    .map(([major]) => Number(major))
    .sort((a, b) => b - a);
  return alive[0] ?? NODE_MIN;
}

/**
 * @returns {{ major:number, tier:string, eol:string|null, message:string|null }}
 *
 * tier is one of:
 *   "unsupported"     past end of life — no security patches at all
 *   "below-minimum"   older than `engines` allows
 *   "plan-upgrade"    the *minimum* supported version, now in maintenance
 *   "supported"       fine, say nothing
 *   "unknown"         a version newer than this table knows about — also silence
 *
 * The "plan-upgrade" tier only ever fires for the minimum supported major.
 * Warning someone on Node 24 that 26 exists would be nagging, not support.
 */
export function nodeSupport(version = process.version, { now = new Date(), min = NODE_MIN } = {}) {
  const major = Number(String(version).replace(/^v/, "").split(".")[0]);
  const today = day(now);
  const row = NODE_LIFECYCLE[major];
  const next = recommendedNode(now);

  if (!row) {
    if (major < min) {
      return {
        major,
        tier: "below-minimum",
        eol: null,
        message: `Pinch needs Node ${min} or newer; you are running ${major}. Upgrade, or install an older Pinch.`,
      };
    }
    return { major, tier: "unknown", eol: null, message: null };
  }

  if (today >= row.eol) {
    return {
      major,
      tier: "unsupported",
      eol: row.eol,
      message: `Node ${major} reached end of life on ${row.eol} — it gets no security patches. Node ${next} is the current supported version. See docs/SUPPORT.md.`,
    };
  }

  if (major < min) {
    return {
      major,
      tier: "below-minimum",
      eol: row.eol,
      message: `Pinch needs Node ${min} or newer; you are on ${major}, which stops being patched on ${row.eol}. See docs/SUPPORT.md.`,
    };
  }

  if (major === min && row.support && today >= row.support) {
    return {
      major,
      tier: "plan-upgrade",
      eol: row.eol,
      message: `Node ${major} is in maintenance — security fixes only, until ${row.eol}. That is still supported; plan the move to Node ${next} before then. See docs/SUPPORT.md.`,
    };
  }

  return { major, tier: "supported", eol: row.eol, message: null };
}
