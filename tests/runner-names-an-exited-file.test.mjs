/**
 * #1864 — A RED SUITE NAMES THE FILE THAT MADE IT RED.
 *
 * Seen on PR #186 (CI run 42619159207): the TAP summary read `# fail 0`, then
 * "the suite exited 1, not 0", and nothing in the log said which file. The
 * runner knew: a file whose `node --test` process exits non-zero goes on
 * `failedFiles`, but that list was written only to the verdict ledger on the
 * CI runner's disk. A hang and a tmp leak print their own lines; a plain
 * non-zero exit printed nothing.
 *
 * The shape is reproduced here by a file whose test process dies by a signal
 * after its tests have run: no `not ok` row, `# fail 0`, exit 1.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE_RUNNER = path.join(ROOT, 'scripts', 'run-test-files.mjs');

/** The inner runner must not inherit this process's test context (see runner-bounds-a-hang). */
function cleanEnv() {
  const env = { ...process.env, SCRUM_VERDICT_LEDGER: path.join(os.tmpdir(), `ledger1864-${process.pid}.jsonl`) };
  for (const k of Object.keys(env)) if (k.startsWith('NODE_TEST')) delete env[k];
  delete env.NODE_OPTIONS;
  delete env.RUN_TESTS_LEDGER;
  return env;
}

function runRunner(files) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [FILE_RUNNER, ...files], {
      cwd: ROOT, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const guard = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('close', (code) => { clearTimeout(guard); resolve({ code, out }); });
  });
}

function plant(name, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner1864-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  return { dir, file };
}

const PASSING = "import { test } from 'node:test';\ntest('passes', () => {});\n";
const DIES = `${PASSING}test('then the test process dies', () => { setTimeout(() => process.kill(process.ppid, 'SIGKILL'), 50); });\n`;

test('#1864 E1 a file whose test process dies with no failing row is NAMED, with how it ended', async () => {
  const { dir, file } = plant('dies-quietly.test.mjs', DIES);
  try {
    const { code, out } = await runRunner([file]);
    assert.equal(code, 1, 'the verdict is still red');
    assert.match(out, /^# fail 0$/m, 'the shape under test: no failing row at all');
    const line = out.split('\n').find((l) => l.startsWith('# ⛔ FILE EXITED'));
    assert.ok(line, `a ⛔ FILE EXITED line is printed; got:\n${out.slice(-800)}`);
    assert.ok(line.includes(file), `the line names the file: ${line}`);
    assert.match(line, /SIGKILL/, `the line says how it ended: ${line}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('#1864 E2 control: a green file prints no FILE EXITED line', async () => {
  const { dir, file } = plant('green.test.mjs', PASSING);
  try {
    const { code, out } = await runRunner([file]);
    assert.equal(code, 0);
    assert.doesNotMatch(out, /FILE EXITED/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('#1864 E3 the line sits after the summary, where a reader of a red log looks', async () => {
  const { dir, file } = plant('dies-quietly.test.mjs', DIES);
  try {
    const { out } = await runRunner([file]);
    const summary = out.lastIndexOf('# todo ');
    const named = out.lastIndexOf('# ⛔ FILE EXITED');
    assert.ok(summary >= 0 && named > summary, 'named after the TAP summary block');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('#1864 E4 run-tests.sh shows the FILE EXITED lines in its FAILURES block', () => {
  const sh = fs.readFileSync(path.join(ROOT, 'scripts', 'run-tests.sh'), 'utf8');
  const block = sh.slice(sh.indexOf('── FAILURES ──'));
  assert.match(block, /FILE EXITED/, 'the FAILURES block greps the FILE EXITED lines too');
});
