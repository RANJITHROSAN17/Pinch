/**
 * scan.js — the workspace walker, shared by the grep tool and its worker.
 *
 * Both callers need the same skip list and the same bounded read, and a skip
 * list that drifts between two copies means `grep` finds things `list_dir`
 * pretends are not there. One definition, one behaviour.
 */
import { readdir, open } from "node:fs/promises";

/** Directories that are never worth walking: build output, caches, VCS. */
export const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "__pycache__",
  ".venv", "venv", ".cache", "target", "coverage", ".idea", ".DS_Store",
]);

/** Extensions that are binary by definition — never scanned, never decoded. */
export const BINARY_EXT = /\.(png|jpe?g|gif|zip|pdf|mp4|mp3|woff2?|ico|lock)$/i;

/**
 * Depth-first walk that yields files, bounded on both axes.
 *
 * @param {string} root
 * @param {{maxEntries?: number, maxDepth?: number, skip?: Set<string>}} [opts]
 * @returns {AsyncGenerator<string>} absolute paths
 */
export async function* walkFiles(root, { maxEntries = 5000, maxDepth = 8, skip = SKIP_DIRS } = {}) {
  let seen = 0;
  async function* descend(dir, depth) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (seen >= maxEntries) return;
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (skip.has(entry.name) || depth >= maxDepth) continue;
        yield* descend(full, depth + 1);
      } else if (entry.isFile()) {
        seen += 1;
        yield full;
      }
    }
  }
  yield* descend(root, 0);
}

/**
 * Read at most `cap` bytes from a file, opened once.
 *
 * No stat-then-read: the size is discovered by reading, so a file that grows
 * between the two calls cannot pull gigabytes into memory.
 */
export async function readHead(path, cap) {
  const handle = await open(path, "r");
  try {
    const buf = Buffer.allocUnsafe(cap);
    const { bytesRead } = await handle.read(buf, 0, cap, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
