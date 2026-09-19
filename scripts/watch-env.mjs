/**
 * scripts/watch-env.mjs — #1417: two things the nightly suite-watch got wrong
 * about the box it runs on, both read from its own log on 2026-09-19.
 *
 *   rmTreeForce(dir)   remove a tree that contains READ-ONLY directories. The
 *                      deploy fixture a test builds (scripts/deploy.sh) leaves
 *                      `serve/` as dr-xr-xr-x with r--r--r-- files — on purpose,
 *                      it mimics the read-only prod tree — and `fs.rmSync` dies
 *                      EACCES on the first unlink inside it. Twenty nights of
 *                      exit 1 after a verdict nobody then read. Directories are
 *                      made u+wx on the way down, then the tree is removed.
 *   withSystemBins(p)  a PATH that can find `lsof` (/usr/sbin) and the other
 *                      system binaries a test reaches for. The launchd plist
 *                      sets PATH without /usr/sbin, so #884's two tests read
 *                      "lsof: command not found" for four nights — a false red
 *                      that passed locally and in CI. Fixed here, in code,
 *                      because a plist edit needs a launchd reload.
 */
import fs from 'node:fs';
import path from 'node:path';

export const SYSTEM_BIN_DIRS = ['/usr/sbin', '/sbin'];

export function withSystemBins(pathValue) {
  const parts = String(pathValue || '').split(':').filter(Boolean);
  const missing = SYSTEM_BIN_DIRS.filter((d) => !parts.includes(d));
  return [...parts, ...missing].join(':');
}

function makeWritable(dir) {
  let entries;
  try { fs.chmodSync(dir, 0o700); entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && !e.isSymbolicLink()) makeWritable(p);
    else { try { fs.chmodSync(p, 0o600); } catch { /* best effort; rm decides */ } }
  }
}

/** Remove `dir` even when it holds read-only directories; throws only if the removal itself fails after that. */
export function rmTreeForce(dir) {
  if (!dir || !fs.existsSync(dir)) return;
  makeWritable(dir);
  fs.rmSync(dir, { recursive: true, force: true });
}
