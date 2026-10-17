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
 *   F8c  MOVED to tests/attachments-drill-source-1648.test.mjs (S2). It ran the drill on an empty raw executor directory and expected a JSON report with a failed
 *        check; the source rule changed (a raw directory is now an unsafe source, refused), so it is re-based there on a verified backup as the source.
 *   F8d  refusals (the command line named by the PO, 43060 and 43062): each of the three flags is required, there is no default and no env fallback; with one
 *        missing the drill exits 2, says which flag, reads nothing and creates nothing; a scratch that is not empty is refused and left untouched.
 *
 * NOT covered, by name: environment variables other than the nine names F8d offers (a fallback under a name it does not try would not be seen); a CLEAN run on a real executor store
 * (tests/attachments-drill-source-1648.test.mjs, S1); what `check` contains; the capture, the restore and the fence themselves (F1 to F7, G1 to G6).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
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

// ---- F8c and F8d: the command line, run against FIXTURES in a temp directory, never a live path ----
const FLAGS = ['--source-attachments', '--source-executor', '--scratch'];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drill1648-'));
  const att = path.join(root, 'att'); const exe = path.join(root, 'exe'); const scratch = path.join(root, 'scratch'); const cwd = path.join(root, 'cwd');
  for (const d of [att, exe, scratch, cwd]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(att, '11111111-1111-4111-8111-111111111111.txt'), 'fixture bytes');
  return { root, att, exe, scratch, cwd, args: { '--source-attachments': att, '--source-executor': exe, '--scratch': scratch } };
}
const listing = (d) => fs.readdirSync(d, { recursive: true }).sort();
const drill = (fx, flags) => spawnSync(process.execPath, [DRILL, ...flags.flatMap((f) => [f, fx.args[f]])], { cwd: fx.cwd, encoding: 'utf8', timeout: 20000 });

test('#1648 (F8d) each flag is required: one missing -> exit 2, names the flag, creates nothing, reads nothing it was not given', () => {
  assert.ok(fs.existsSync(DRILL), 'PRECONDITION: scripts/attachments-drill.mjs exists');
  for (const missing of FLAGS) {
    const fx = fixture();
    try {
      const before = { att: listing(fx.att), exe: listing(fx.exe), scratch: listing(fx.scratch), cwd: listing(fx.cwd) };
      const envNames = { ATTACHMENTS_DIR: fx.att, ATTACHMENTS_PATH: fx.att, SCRUM_ATTACHMENTS_DIR: fx.att, SOURCE_ATTACHMENTS: fx.att, SOURCE_EXECUTOR: fx.exe, EXECUTOR_STORE: fx.exe, EXECUTOR_DIR: fx.exe, SCRATCH: fx.scratch, SCRATCH_DIR: fx.scratch };
      const r = spawnSync(process.execPath, [DRILL, ...FLAGS.filter((f) => f !== missing).flatMap((f) => [f, fx.args[f]])], { cwd: fx.cwd, encoding: 'utf8', timeout: 20000, env: { ...process.env, ...envNames } });
      assert.equal(r.status, 2, `${missing} missing, with the environment offering a valid directory under the usual names: exit 2, no environment fallback (got ${r.status}, signal ${r.signal}): ${r.stderr.slice(0, 200)}`);
      assert.ok((r.stdout + r.stderr).includes(missing), `and the output names the missing flag ${missing}`);
      assert.deepEqual({ att: listing(fx.att), exe: listing(fx.exe), scratch: listing(fx.scratch), cwd: listing(fx.cwd) }, before, `${missing} missing: nothing created or changed anywhere`);
    } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
  }
  const fx = fixture();
  try {
    const r = spawnSync(process.execPath, [DRILL], { cwd: fx.cwd, encoding: 'utf8', timeout: 20000, env: { ...process.env, SCRUM_BOARD_FILE: '', ATTACHMENTS_DIR: fx.att, SCRATCH: fx.scratch } });
    assert.equal(r.status, 2, `no arguments at all: exit 2, no default and no environment fallback (got ${r.status})`);
    assert.deepEqual(listing(fx.cwd), [], 'and nothing was created in the working directory');
    assert.deepEqual(listing(fx.scratch), [], 'or in the scratch directory the environment pointed at');
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test('#1648 (F8d2) a scratch directory that is not empty is refused and left exactly as it was', () => {
  assert.ok(fs.existsSync(DRILL), 'PRECONDITION: scripts/attachments-drill.mjs exists');
  const fx = fixture();
  try {
    fs.writeFileSync(path.join(fx.scratch, 'precious.txt'), 'not the drill\'s to touch');
    const before = listing(fx.scratch); const attBefore = listing(fx.att);
    const r = drill(fx, FLAGS);
    assert.notEqual(r.status, 0, 'a non-empty --scratch is refused (non-zero exit)');
    assert.ok(!/"check"/.test(r.stdout), `a refusal is not a run: no check result is printed (got ${JSON.stringify(r.stdout.slice(0, 120))})`);
    assert.match(r.stdout + r.stderr, /empty/i, 'and the output says the directory must be empty');
    assert.deepEqual(listing(fx.scratch), before, 'and nothing was added to it, removed from it or changed in it');
    assert.equal(fs.readFileSync(path.join(fx.scratch, 'precious.txt'), 'utf8'), 'not the drill\'s to touch', 'the file in it is intact');
    assert.deepEqual(listing(fx.att), attBefore, 'and the source was not touched');
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});
