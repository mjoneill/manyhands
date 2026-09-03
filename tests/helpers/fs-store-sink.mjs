/**
 * #1152 — the sink. Deliberately uses `node:fs` through createRequire so it is
 * NOT itself rewritten by the hook: a recorder that records its own writes
 * would fill the file with itself.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
const nodeFs = createRequire(import.meta.url)('node:fs');
const OUT = process.env.SCRUM_FS_RECORD;
const seen = new Set();
export function recordPath(p) {
  if (!OUT || typeof p !== 'string' || !p) return;
  try {
    const abs = path.isAbsolute(p) ? p : path.resolve(p);
    if (abs === OUT || seen.has(abs)) return;
    seen.add(abs);
    nodeFs.appendFileSync(OUT, abs + '\n', 'utf8');
  } catch { /* a recorder that throws would fail the run it observes */ }
}
