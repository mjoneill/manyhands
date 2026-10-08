/**
 * #1559 — restore PROMOTION and epoch fencing (D1 v0.2; D2 section 7; a reviewer 13:58Z).
 * A restored store is promoted to a NEW epoch before it serves. A write from a
 * caller still on the old epoch is refused with RECONCILE_REQUIRED unless its
 * opId already has a receipt here: "receipt absent" after a restore does not
 * make a blind replay safe, because the lost op may already have had effects.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGraphClient } from '../core/graph-client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXEC = path.join(ROOT, 'graph-executor', 'executor.py');
const PY = process.env.GRAPH_EXECUTOR_PYTHON || path.join(ROOT, 'graph-executor', '.venv', 'bin', 'python');
const HAVE_PY = fs.existsSync(PY) && spawnSync(PY, ['-c', 'import pyoxigraph'], { stdio: 'ignore' }).status === 0;
const SKIP = HAVE_PY ? false : `UNAVAILABLE: no python with pyoxigraph at ${PY}`;

function start(store, extra = []) {
  return new Promise((resolve, reject) => {
    const p = spawn(PY, [EXEC, '--store', store, '--port', '0', '--dataset-id', 'epoch', ...extra], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; if (out.includes('\n')) resolve({ p, base: `http://127.0.0.1:${JSON.parse(out.split('\n')[0]).port}` }); });
    p.stderr.on('data', (d) => { err += d; });
    p.on('exit', (code) => reject(new Error(`exited ${code}: ${err}`)));
  });
}
const stop = async (e) => { e.p.kill('SIGKILL'); await new Promise((r) => e.p.on('exit', r)); };
const health = async (base) => (await fetch(`${base}/health`)).json();
const rule = (n) => ({ kind: 'rule', opId: `urn:ex:op/ep-${n}`, actor: 'urn:ex:admin', rule: { iri: `urn:ex:R/ep-${n}` } });

test('#1559 a promoted restore: new epoch before serving; old-epoch writes are RECONCILE_REQUIRED unless already receipted; new-epoch writes apply', { skip: SKIP }, async () => {
  const live = fs.mkdtempSync(path.join(os.tmpdir(), 'ep-live-'));
  let e = await start(live, ['--create']);
  const old = createGraphClient({ baseUrl: e.base });
  const A = rule('A');
  assert.equal((await old.update(A)).outcome, 'APPLIED');
  await stop(e);
  const restore = fs.mkdtempSync(path.join(os.tmpdir(), 'ep-restore-'));
  fs.cpSync(live, restore, { recursive: true });     // the "backup": taken after A, before B
  e = await start(live);
  const oldOnLive = createGraphClient({ baseUrl: e.base });
  const B = rule('B');
  assert.equal((await oldOnLive.update(B)).outcome, 'APPLIED', 'B lands on the live store only');
  await stop(e);

  // the live store is lost; the restore is PROMOTED
  e = await start(restore, ['--promote-epoch']);
  try {
    const h = await health(e.base);
    assert.equal(h.epoch, '2', 'promotion is visible before any write');
    assert.deepEqual([h.promoted.from, h.promoted.to], [1, 2]);
    const stale = createGraphClient({ baseUrl: e.base });
    // an old-epoch caller (it learned epoch 1 before the restore)
    const rB = await stale.update(B, { epoch: '1' });
    assert.equal(rB.outcome, 'RECONCILE_REQUIRED', 'B was lost with the live store: never blindly replayed');
    assert.equal((await stale.reconcile(B)).outcome, 'ABSENT');
    assert.equal((await stale.update(rule('C'), { epoch: '1' })).outcome, 'RECONCILE_REQUIRED', 'even a brand-new op from an old-epoch caller');
    const f0 = (await health(e.base)).flushes;
    const rA = await stale.update(A, { epoch: '1' });
    assert.equal(rA.outcome, 'APPLIED', 'A IS recorded here: its recorded outcome still answers');
    assert.equal((await health(e.base)).flushes - f0, 1, 'that replay acknowledgement was flushed before it was sent (a reviewer)');
    // a caller on the new epoch writes freshly
    const fresh = createGraphClient({ baseUrl: e.base });
    assert.equal((await fresh.update(rule('D'))).outcome, 'APPLIED', 'learns epoch 2 and writes');
  } finally { await stop(e); }
});

test('#1559 promotion leaves commitSeq as the restore recorded it and bumps the epoch once per promotion', { skip: SKIP }, async () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'ep-'));
  let e = await start(store, ['--create']);
  await createGraphClient({ baseUrl: e.base }).update(rule('S'));
  const before = await health(e.base);
  await stop(e);
  e = await start(store, ['--promote-epoch']);
  const p1 = await health(e.base);
  await stop(e);
  e = await start(store, ['--promote-epoch']);
  const p2 = await health(e.base);
  await stop(e);
  e = await start(store);   // no promotion: the epoch stays
  const p3 = await health(e.base);
  await stop(e);
  assert.deepEqual([before.epoch, p1.epoch, p2.epoch, p3.epoch], ['1', '2', '3', '3']);
  assert.deepEqual([p1.commitSeq, p2.commitSeq, p3.commitSeq], [before.commitSeq, before.commitSeq, before.commitSeq]);
});

test('#1559 epoch 1 stays compatible: a write with no epoch header is accepted on an unpromoted store (twin), refused after promotion', { skip: SKIP }, async () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'ep-'));
  let e = await start(store, ['--create']);
  const raw = (base, n) => fetch(`${base}/update`, { method: 'POST', body: `INSERT DATA { <urn:ex:raw/${n}> <urn:ex:p> 1 }`, headers: { 'x-op-id': `urn:ex:op/raw-${n}` } });
  assert.equal((await raw(e.base, 1)).status, 200);
  await stop(e);
  e = await start(store, ['--promote-epoch']);
  try {
    const r = await raw(e.base, 2);
    assert.equal(r.status, 409, 'after a promotion every writer must say which epoch it means');
    assert.equal((await r.json()).reconcileRequired.storeEpoch, 2);
  } finally { await stop(e); }
});

test('#1559 a contradictory marker never kills the executor mid-request: writes and /health keep answering', { skip: SKIP }, async () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'ep-'));
  const e = await start(store, ['--create']);
  try {
    const plant = await fetch(`${e.base}/update`, { method: 'POST', body: 'INSERT DATA { GRAPH <urn:scrum:bookkeeping:executor> { <urn:ex:dataset> <urn:ex:epoch> 7 } }', headers: { 'x-op-id': 'urn:ex:op/plant' } });
    assert.equal(plant.status, 200);
    const h = await (await fetch(`${e.base}/health`)).json();
    assert.match(h.markerError, /marker rows/);
    const w = await fetch(`${e.base}/update`, { method: 'POST', body: 'INSERT DATA { <urn:ex:x> <urn:ex:p> 1 }', headers: { 'x-op-id': 'urn:ex:op/after' } });
    assert.equal(w.status, 200, 'the process is alive and serving');
  } finally { e.p.kill('SIGKILL'); }
});
