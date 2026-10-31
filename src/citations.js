/**
 * citations.js — read the citations out of a reply, and check them.
 *
 * The model is told to write `[1]` after a sentence it took from source 1. That
 * convention is only worth anything if something verifies it, so this module:
 *
 *   1. extracts the numbers the reply cites,
 *   2. separates them into ones that name a source retrieved this turn and ones
 *      that name nothing — a fabricated citation,
 *   3. and builds the footer that shows the reader what was used.
 *
 * It never edits the model's sentence. A citation that points at nothing is
 * reported, not deleted: silently removing it would leave a claim looking
 * sourced when it is not, which is the exact failure this is here to prevent.
 */

const CITE_RE = /\[(\d{1,2}(?:\s*[,-]\s*\d{1,2})*)\](?!\()/g;

/**
 * Expand `[1]`, `[1,3]`, `[2-4]` into ids. Markdown links (`[text](url)`) are
 * excluded by the lookahead, and so are footnote markers (`[^1]`) because `^`
 * is not a digit.
 */
export function citedIds(text) {
  const out = new Set();
  for (const m of String(text || "").matchAll(CITE_RE)) {
    for (const part of m[1].split(",")) {
      const range = part.trim().split("-");
      if (range.length === 2) {
        const [a, b] = range.map((x) => Number(x.trim()));
        if (Number.isFinite(a) && Number.isFinite(b) && b >= a && b - a <= 12) {
          for (let i = a; i <= b; i++) out.add(i);
        }
      } else {
        const n = Number(range[0]);
        if (Number.isFinite(n)) out.add(n);
      }
    }
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * @param {object} input
 * @param {string} input.text        the model's reply
 * @param {Array}  input.sources     from listSources() — this turn only
 * @returns {{cited:number[], unknown:number[], unused:number[], byId:Map}}
 */
export function validateCitations({ text, sources = [] }) {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const cited = citedIds(text);
  return {
    cited: cited.filter((id) => byId.has(id)),
    unknown: cited.filter((id) => !byId.has(id)),
    unused: sources.filter((s) => !cited.includes(s.id)).map((s) => s.id),
    byId,
  };
}

/**
 * The footer appended to a reply that cites something.
 *
 * Only cited sources are listed. An empty string comes back when the reply
 * cites nothing — an answer from memory should not wear a "Sources" heading
 * with nothing under it, because that heading implies research that did not
 * happen.
 */
export function renderSourceBlock(validation) {
  const { cited, byId } = validation;
  if (!cited.length) return "";
  const lines = cited.map((id) => {
    const s = byId.get(id);
    const label = s.kind === "file" ? `\`${s.ref}\`` : s.ref;
    return `${id}. ${s.title} — ${label}`;
  });
  return `\n\n---\n**Sources**\n${lines.join("\n")}`;
}
