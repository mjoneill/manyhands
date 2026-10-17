/**
 * #1648 pre-build gate (1), as a row — F8. TEST AUTHOR's, written before any build.
 *
 * The PO's scope call (commons 43044, accepted by the steward 43046): the attachment fence promises exclusion only for writes made through the app's
 * code. Direct filesystem writes by an operator, a script or another process are OPERATIONALLY EXCLUDED, not fenced, and the drill report must say so
 * in one plain line under "not covered", so the beneficiary sees the gap and does not infer coverage.
 *
 * The drill does not exist yet. Its interface, named by the PO (43057): a new scripts/attachments-drill.mjs runs capture, restore into scratch and the
 * check, then prints ONE JSON result that embeds the checker's result as `check` and carries `notCovered: string[]`, one entry of which is exactly
 *   "direct filesystem writes by an operator, a script or another process are operationally excluded and not fenced".
 *
 *   F8a  the drill script exists and parses                                          RED until it is built
 *   F8b  it exports NOT_COVERED, an array of strings that holds the exact sentence once   (PROPOSED export: the builder may rename it; the row follows)
 *        F8b IMPORTS the module, so the drill must not run itself on import: its entry point is guarded (for example by comparing import.meta.url).
 *
 * OWED, NOT WRITTEN: F8c, that the drill's printed JSON `notCovered` carries the sentence on a real run, and a mutant dropping it fails. That needs the
 * drill's command line (which arguments take the source and scratch paths), which no one has named. I will not guess it. F8b is not a substitute: a
 * constant that is exported but never printed would pass it. Until F8c exists, F8 pins the sentence and the field's home, not that the report prints it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRILL = path.join(ROOT, 'scripts/attachments-drill.mjs');
const SENTENCE = 'direct filesystem writes by an operator, a script or another process are operationally excluded and not fenced';

test('#1648 (F8a) the drill script exists and parses', () => {
  assert.ok(fs.existsSync(DRILL), 'scripts/attachments-drill.mjs exists (the PO\'s named interface, commons 43057)');
  const r = spawnSync(process.execPath, ['--check', DRILL], { encoding: 'utf8' });
  assert.equal(r.status, 0, `it parses: ${r.stderr.slice(0, 300)}`);
});

test('#1648 (F8b) the drill exports NOT_COVERED, and it holds the out-of-band-writer sentence exactly once', async () => {
  assert.ok(fs.existsSync(DRILL), 'PRECONDITION: scripts/attachments-drill.mjs exists');
  const mod = await import(pathToFileURL(DRILL).href);
  assert.ok(Array.isArray(mod.NOT_COVERED), 'NOT_COVERED is an array');
  assert.ok(mod.NOT_COVERED.every((x) => typeof x === 'string'), 'of strings');
  assert.equal(mod.NOT_COVERED.filter((x) => x === SENTENCE).length, 1, `with the exact sentence once (got ${JSON.stringify(mod.NOT_COVERED)})`);
});
