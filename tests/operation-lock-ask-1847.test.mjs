/**
 * #1847 slice 2 (from #1018 condition 3, the spec in post 52060) — the operation lock carries the ASK: the commons post
 * that asked for the operation, so a second seat reading `status` sees not only who holds the lock but why. And a
 * restart that runs INSIDE another operation (a deploy) proves the lock is held by that operation with `holds`, rather
 * than acquiring a second time (which would refuse) or skipping the lock (which is the 19:04Z failure).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/operation-lock.sh', import.meta.url));
const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });   // the suite's temp-leak teardown (#1672) fails a run that leaves them
const fresh = () => { const d = mkdtempSync(join(tmpdir(), 'op-lock-ask-')); made.push(d); return join(d, 'operation-lock.json'); };
const run = (lock, ...args) => spawnSync('sh', [SCRIPT, ...args], { env: { ...process.env, DEPLOY_LOCK: lock }, encoding: 'utf8' });

test('K1 acquire --ask --note: the file holds the ask; a SECOND seat\'s status names the holder AND the ask', () => {
  const lock = fresh();
  const r = run(lock, 'acquire', 'restart', 'alpha', '--ask', 'post-123', '--note', 'restarting the executor');
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(readFileSync(lock, 'utf8'));
  assert.equal(j.ask, 'post-123'); assert.equal(j.note, 'restarting the executor'); assert.equal(j.holder, 'alpha');
  const s = run(lock, 'status');
  assert.match(s.stdout, /alpha/); assert.match(s.stdout, /ask: post-123/); assert.match(s.stdout, /restarting the executor/);
  const refused = run(lock, 'acquire', 'deploy', 'bravo');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /ask: post-123/, 'the refusal carries the ask too');
});

test('K2 the positional note still works (every existing caller, deploy.sh included)', () => {
  const lock = fresh();
  assert.equal(run(lock, 'acquire', 'deploy', 'alpha', 'old style note').status, 0);
  const j = JSON.parse(readFileSync(lock, 'utf8'));
  assert.equal(j.note, 'old style note'); assert.equal(j.ask, '');
});

test('K3 holds <op> <holder>: 0 only when the lock names exactly that op and holder; 1 when free or held by anyone else', () => {
  const lock = fresh();
  assert.equal(run(lock, 'holds', 'deploy', 'alpha').status, 1, 'free is not held');
  assert.equal(run(lock, 'acquire', 'deploy', 'alpha').status, 0);
  assert.equal(run(lock, 'holds', 'deploy', 'alpha').status, 0);
  assert.equal(run(lock, 'holds', 'deploy', 'bravo').status, 1, 'another holder');
  assert.equal(run(lock, 'holds', 'restart', 'alpha').status, 1, 'another op');
});

test('K4 an ask with a quote or backslash is refused like the other fields (the reader is a one-line sed)', () => {
  const lock = fresh();
  assert.equal(run(lock, 'acquire', 'restart', 'alpha', '--ask', 'a"b').status, 2);
});
