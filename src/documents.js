/** Local, ephemeral passage index. No network, embeddings or persisted document copies.
 * Explicit folder only; refresh on every search so edits/deletions cannot leave stale hits.
 * Lexical retrieval is deliberate: exact words work offline, semantic paraphrases may not.
 */
import { readdir, open } from "node:fs/promises";
import { constants } from "node:fs";
import { join, extname } from "node:path";
import { SKIP_DIRS } from "./scan.js";

const TYPES = new Set([".txt", ".md", ".markdown", ".rst", ".csv"]);
export const DOCUMENT_LIMITS = Object.freeze({ entries: 2000, bytes: 4 * 1024 * 1024, fileBytes: 256 * 1024, depth: 8, lines: 24 });
const terms = (text) => (text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || []).slice(0, 20000);

/** Every directory and file passes the caller's workspace/credential policy.
 * Symlinks (including directory links) are never traversed. O_NOFOLLOW closes
 * the final-component symlink race; this is not an OS sandbox against concurrent
 * replacement of parent directories by another local process.
 */
export async function searchDocuments({ path, query, resolvePath, limit = 5 }) {
  if (typeof query !== "string" || query.length > 1000 || !terms(query).length) {
    throw new Error("Provide a query containing words (maximum 1,000 characters).");
  }
  const root = resolvePath(path);
  const chunks = [];
  let entries = 0, bytes = 0, files = 0, skipped = 0, truncated = false;
  async function walk(dir, depth) {
    resolvePath(dir);
    const children = await readdir(dir, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const item of children) {
      if (++entries > DOCUMENT_LIMITS.entries || bytes >= DOCUMENT_LIMITS.bytes) { truncated = true; return; }
      if (item.name.startsWith(".") || SKIP_DIRS.has(item.name)) continue;
      const full = join(dir, item.name);
      if (item.isSymbolicLink()) { skipped++; continue; }
      if (item.isDirectory()) {
        if (depth >= DOCUMENT_LIMITS.depth) { truncated = true; continue; }
        try { await walk(full, depth + 1); } catch { skipped++; }
        continue;
      }
      if (!item.isFile() || !TYPES.has(extname(item.name).toLowerCase())) continue;
      let handle;
      try {
        resolvePath(full);
        handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > DOCUMENT_LIMITS.fileBytes || stat.size > DOCUMENT_LIMITS.bytes - bytes) {
          skipped++; truncated = true; continue;
        }
        const buffer = Buffer.alloc(Math.min(DOCUMENT_LIMITS.fileBytes, DOCUMENT_LIMITS.bytes - bytes) + 1);
        const read = await handle.read(buffer, 0, buffer.length, 0);
        bytes += read.bytesRead;
        if (read.bytesRead === buffer.length) { skipped++; truncated = true; continue; }
        if (buffer.subarray(0, read.bytesRead).includes(0)) { skipped++; continue; }
        files++;
        const lines = buffer.subarray(0, read.bytesRead).toString("utf8").split("\n");
        for (let i = 0; i < lines.length; i += DOCUMENT_LIMITS.lines) {
          const text = lines.slice(i, i + DOCUMENT_LIMITS.lines).join("\n").slice(0, 4000);
          const counts = new Map();
          for (const word of terms(text)) counts.set(word, (counts.get(word) || 0) + 1);
          chunks.push({ path: full, start: i + 1, end: Math.min(lines.length, i + DOCUMENT_LIMITS.lines), text, counts });
        }
      } catch { skipped++; }
      finally { await handle?.close(); }
    }
  }
  await walk(root, 0);
  const words = [...new Set(terms(query))];
  const frequencies = new Map(words.map((w) => [w, chunks.filter((c) => c.counts.has(w)).length]));
  const hits = chunks.map((c) => ({ ...c, score: words.reduce((score, w) => {
    const tf = c.counts.get(w) || 0;
    return score + (tf ? (1 + Math.log(tf)) * Math.log(1 + chunks.length / (1 + frequencies.get(w))) : 0);
  }, 0) / Math.sqrt(Math.max(1, c.counts.size)) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.start - b.start)
    .slice(0, Math.max(1, Math.min(8, Math.floor(Number(limit) || 5))))
    .map(({ counts, ...hit }) => hit);
  return { hits, files, chunks: chunks.length, skipped, truncated };
}
