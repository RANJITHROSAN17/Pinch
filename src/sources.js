/**
 * sources.js — what this turn actually looked at.
 *
 * Every other assistant that shows "sources" collects links at the end of an
 * answer, which is decoration: the reader still cannot tell whether the third
 * link backs the third sentence, or whether the link was ever opened. This
 * registry exists so a citation can be *checked* instead of believed.
 *
 * The rule: only things retrieved during this turn enter the registry, and
 * nothing else can be cited. A `[7]` when seven things were never fetched is a
 * fabricated citation, and guard.js says so out loud.
 *
 * Deliberately per-turn and in memory. A source list is evidence for one
 * answer, not a document library; persisting it would turn a verifiable claim
 * into an archived one that no longer matches the page it came from.
 */

export const MAX_SOURCES = 12;
const SNIPPET_CHARS = 200;

/** A fresh, empty registry. One per turn. */
export function createSources() {
  return { items: [], index: new Map() };
}

/**
 * Register something the turn actually retrieved. Returns the id the model
 * should cite. Re-registering the same ref returns the same id, so searching
 * twice for the same page does not produce two "sources".
 */
export function addSource(reg, { kind, title, ref, snippet = "" }) {
  if (!reg || !ref) return null;
  const key = `${kind}:${ref}`;
  const existing = reg.index.get(key);
  if (existing) return existing;
  if (reg.items.length >= MAX_SOURCES) return null;
  const id = reg.items.length + 1;
  reg.items.push({
    id,
    kind,
    title: clean(title || ref),
    ref: String(ref),
    snippet: clean(snippet).slice(0, SNIPPET_CHARS),
  });
  reg.index.set(key, id);
  return id;
}

/** Everything registered, id-ordered. */
export function listSources(reg) {
  return reg ? reg.items.slice() : [];
}

/**
 * Source text went through a model, a search page and a parser before it got
 * here. It is displayed, so it must not be able to become markup, and it must
 * not be able to smuggle a line break into a list item.
 */
function clean(s) {
  return String(s || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
