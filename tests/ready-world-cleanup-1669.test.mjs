/**
 * #1669 — the cleanup MECHANISM of the #1644 executor tests (`withOwned` in tests/helpers/ready-world-1644.mjs), on its FAILURE paths, with no executor involved.
 * The review of the first fix (0549592) found that setup failures, and a cleanup step that throws, would still leave temp directories and processes behind.
 *   C1  a failure half-way through setup releases what was already taken (directories, registered cleanups, a live child process), in reverse order, and the body's error is the one that propagates
 *   C2  a cleanup step that throws does not skip the steps registered before it, and does not change the body's return value
 *   C3  only what was made through `own.dir` is removed: a directory the test did not make survives
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { withOwned } from './helpers/ready-world-1644.mjs';

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitDead = async (pid) => { for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100)); return !alive(pid); };

test('C1 a failure half-way through setup releases what was taken (dirs, cleanups, a live child), in reverse order, and the setup error propagates', { timeout: 30000 }, async () => {
  const made = []; const order = []; let child = null;
  try {
  await assert.rejects(withOwned(async (own) => {
    made.push(own.dir('r44u-a-')); own.adopt(async () => { order.push('first'); });
    child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); child.unref(); own.adopt(async () => { child.kill('SIGKILL'); order.push('child'); });
    made.push(own.dir('r44u-b-')); own.adopt(async () => { order.push('last'); });
    assert.ok(alive(child.pid), 'CONTROL: the child really runs before the failure');
    throw new Error('setup failed half-way');
  }), /setup failed half-way/);
  assert.deepEqual(order, ['last', 'child', 'first'], 'every cleanup ran, newest first');
  for (const d of made) assert.equal(fs.existsSync(d), false, `${d} was removed`);
  assert.ok(await waitDead(child.pid), 'the child process is gone');
  } finally { try { child?.kill('SIGKILL'); } catch { /* gone */ } }   // a broken cleanup must fail this row, never leave a stray process or hang the run
});

test('C2 a cleanup step that throws does not skip the earlier steps and does not change the return value', async () => {
  const order = [];
  const value = await withOwned(async (own) => {
    own.adopt(async () => { order.push('c1'); });
    own.adopt(async () => { order.push('c2'); throw new Error('boom in c2'); });
    own.adopt(async () => { order.push('c3'); });
    return 'the body result';
  });
  assert.equal(value, 'the body result');
  assert.deepEqual(order, ['c3', 'c2', 'c1'], 'c1 still ran after c2 threw');
});

test('C3 only what was made through own.dir is removed', async () => {
  const mine = fs.mkdtempSync(path.join(os.tmpdir(), 'r44u-notowned-'));
  let owned = null;
  try {
    await withOwned(async (own) => { owned = own.dir('r44u-owned-'); fs.writeFileSync(path.join(owned, 'x'), 'x'); });
    assert.equal(fs.existsSync(owned), false, 'the owned directory is gone');
    assert.equal(fs.existsSync(mine), true, 'a directory the test did not make through own.dir is untouched');
  } finally { fs.rmSync(mine, { recursive: true, force: true }); }
});
