/**
 * #1152 — the sink. Deliberately uses `node:fs` through createRequire so it is
 * NOT itself rewritten by the hook: a recorder that records its own writes
 * would fill the file with itself.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
const nodeFs = createRequire(import.meta.url)('node:fs');
const OUT = process.env.SCRUM_FS_RECORD;
// #1645 — SCRUM_FS_RECORD_ALL=1 records EVERY attempt, one line each, not only a path's first: "zero reads after boot" needs a count per
// attempt, and a path first opened at boot is otherwise never written again.
const ALL = process.env.SCRUM_FS_RECORD_ALL === '1';
const seen = new Set();
export function recordPath(p) {
  if (!OUT || typeof p !== 'string' || !p) return;
  try {
    const abs = path.isAbsolute(p) ? p : path.resolve(p);
    if (abs === OUT || (!ALL && seen.has(abs))) return;
    seen.add(abs);
    nodeFs.appendFileSync(OUT, abs + '\n', 'utf8');
  } catch { /* a recorder that throws would fail the run it observes */ }
}
