/**
 * #670 — the verdict pipeline's own controls.
 *
 * A test of a rail needs a positive control (the morning's lesson, applied
 * one level up): a runner that always exits zero is indistinguishable from a
 * green suite until it swallows a red one. So: deliberate-fail fixture must
 * produce nonzero; a green subset must produce zero WITH the exclusion
 * banner; the banner is what makes a subset-green unreportable as a green.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HELPER = path.join(ROOT, 'scripts', 'run-tests.sh');

// The inner `node --test` must not inherit the OUTER runner's context, or it
// reports to our runner instead of exiting on its own verdict — the harness
// itself would mask the exit code, which is this card's entire subject.
function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('NODE_TEST')) delete env[k];
  delete env.NODE_OPTIONS;
  return env;
}

async function helper(...args) {
  try {
    const { stdout } = await run('sh', [HELPER, ...args], { env: cleanEnv() });
    return { code: 0, out: stdout };
  } catch (e) {
    return { code: e.code, out: String(e.stdout) + String(e.stderr) };
  }
}

test('positive control: a deliberately failing fixture exits nonzero and shows the failure', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt670-'));
  const bad = path.join(dir, 'deliberate-red.test.mjs');
  fs.writeFileSync(bad, `
    import { test } from 'node:test';
    import assert from 'node:assert/strict';
    test('deliberately red', () => { assert.equal(1, 2, 'the control failure'); });
  `);
  const r = await helper(bad);
  assert.notEqual(r.code, 0, 'a red fixture must produce a nonzero exit');
  assert.match(r.out, /not ok/, 'the failure is shown, not just counted');
  assert.match(r.out, /SUBSET/, 'a named file is a subset and says so');
});

test('a green subset exits zero but carries the exclusion banner', async () => {
  const r = await helper('tests/cards-query.test.mjs');
  assert.equal(r.code, 0, `known-green subset should pass: ${r.out.slice(0, 300)}`);
  assert.match(r.out, /SUBSET: 1 of \d+ files — NOT a full-suite verdict/,
    'the banner names the narrowing');
  assert.match(r.out, /subset green ≠ suite green/,
    'a green subset explicitly refuses to be read as a suite verdict');
});

test('the no-args invocation declares itself the full suite', async () => {
  // Not running the whole suite inside a suite (recursion, minutes); assert the
  // declaration logic only, via a dry parse of the helper's banner on a
  // single-file "full" universe: point it at a temp repo shaped like ours.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt670full-'));
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.copyFileSync(HELPER, path.join(dir, 'scripts', 'run-tests.sh'));
  fs.writeFileSync(path.join(dir, 'tests', 'only.test.mjs'), `
    import { test } from 'node:test';
    test('green', () => {});
  `);
  const { stdout } = await run('sh', [path.join(dir, 'scripts', 'run-tests.sh')], { env: cleanEnv() });
  assert.match(stdout, /FULL SUITE \(1 files\)/, 'no-args = full suite, declared');
  assert.doesNotMatch(stdout, /SUBSET/, 'a full run carries no subset banner');
});

// ── #735 — the runner must EMIT as it goes, not only at the end ───────────
//
// The 2026-08-08 09:45Z suite watch fired `RED (summary unparsed)` and the log
// held no diagnostics. The run had produced 1,555 lines of perfectly good TAP;
// they were thrown away. `run-tests.sh` buffered everything into a mktemp file
// and printed greps of it only AFTER `node --test` returned, so a run killed by
// the watcher's deadline emitted nothing at all — and the alarm reported the
// blankness as "unparsed", which reads as "the output was garbled" and sends
// the reader hunting a broken parser instead of the hang.
//
// Measured before the fix: killed run → 0 bytes captured, 158,338 bytes of real
// TAP left in the temp file nobody reads.
//
// The fixture is two files chosen for ORDER: node --test emits per file in
// sorted order, so `a-fast` must sort before `b-hang` for its result to be
// released while the second file is still stuck. That is the whole discriminator
// — with buffering, stdout is empty; with streaming, a-fast's `ok` is already
// out. If both files hung, this test would pass for the wrong reason.
test('#735 a run killed mid-flight has ALREADY emitted what it produced', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt735-'));
  fs.writeFileSync(path.join(dir, 'a-fast.test.mjs'),
    'import { test } from "node:test"; test("fast one finishes", () => {});\n');
  // The hang needs a live HANDLE, not just an unresolved promise: a bare
  // `new Promise(() => {})` keeps nothing alive, the event loop drains, and
  // node exits cleanly — which is not a hang at all. Caught by this test's own
  // anti-vacuity assertion on the first run, which is the argument for having
  // written it.
  fs.writeFileSync(path.join(dir, 'b-hang.test.mjs'),
    'import { test } from "node:test";\n'
    + 'test("hangs forever", () => new Promise(() => { setInterval(() => {}, 1000); }));\n');

  const { spawn } = await import('node:child_process');
  const child = spawn('sh', [HELPER, path.join(dir, 'a-fast.test.mjs'), path.join(dir, 'b-hang.test.mjs')],
    { env: cleanEnv(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });

  let seen = '';
  child.stdout.on('data', (d) => { seen += d.toString(); });
  child.stderr.on('data', (d) => { seen += d.toString(); });

  // Long enough for the fast file to finish and be released, far short of any
  // chance the hanging one completes.
  await new Promise((r) => setTimeout(r, 6000));
  const streamedBeforeKill = seen;

  try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  await new Promise((r) => setTimeout(r, 500));

  assert.match(streamedBeforeKill, /ok 1|# Subtest|fast one finishes/,
    'a killed run must have already emitted the results it had; got '
    + `${Buffer.byteLength(streamedBeforeKill)} bytes: ${JSON.stringify(streamedBeforeKill.slice(0, 200))}`);

  // Anti-vacuity: prove the hang was real, i.e. this run genuinely did not
  // finish. If it had completed, "output was emitted" would be trivially true
  // and would say nothing about streaming.
  assert.doesNotMatch(streamedBeforeKill, /# fail \d+/,
    'the run must NOT have completed — otherwise this asserts nothing about streaming');
});
