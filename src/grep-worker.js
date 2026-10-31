/**
 * grep-worker.js — the regex runs here, and never on the main thread.
 *
 * Why a thread: the pattern comes from a model, and a model is a string
 * generator. Node's RegExp engine has no timeout and no RE2, so `(a+)+$` over
 * 400 KB of "a" is exponential — the call never returns and, because it used to
 * run on the main thread, the whole assistant froze with it: every channel, the
 * SSE stream, and the scheduler.
 *
 * Here the catastrophe is contained to a thread the parent can kill.
 *
 * Messages in/out are plain objects; there is no shared memory and no eval.
 */
import { parentPort, workerData } from "node:worker_threads";
import { relative } from "node:path";
import { SKIP_DIRS, BINARY_EXT, walkFiles, readHead } from "./scan.js";

const {
  root,
  pattern,
  glob,
  cap = 400_000,
  capHits = 60,
  maxFiles = 5000,
  maxLine = 2_000,
} = workerData;

const hits = [];

try {
  const re = new RegExp(pattern, "i");
  const suffix = glob ? `.${String(glob).replace(/^\./, "")}` : null;

  for await (const file of walkFiles(root, { maxEntries: maxFiles, skip: SKIP_DIRS })) {
    if (hits.length >= capHits) break;
    if (suffix && !file.endsWith(suffix)) continue;
    if (!suffix && BINARY_EXT.test(file)) continue;

    let text;
    try {
      text = (await readHead(file, cap)).toString("utf8");
    } catch {
      continue;
    }
    if (text.includes("\u0000")) continue; // binary that slipped past the filter

    const lines = text.split("\n");
    for (let i = 0; i < lines.length && hits.length < capHits; i++) {
      // Capping the line does not defeat exponential backtracking on its own,
      // but it removes the cheap quadratic cases and keeps a single minified
      // line from dominating the budget.
      const line = lines[i].length > maxLine ? lines[i].slice(0, maxLine) : lines[i];
      if (re.test(line)) hits.push(`${relative(root, file) || file}:${i + 1}: ${line.trim().slice(0, 180)}`);
    }
  }
  parentPort.postMessage({ ok: true, hits });
} catch (err) {
  parentPort.postMessage({ ok: false, error: String(err.message || err) });
}
