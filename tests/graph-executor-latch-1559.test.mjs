/**
 * #1559 — the durability LATCH, on a REAL storage fault (the store directory
 * made read-only, a reviewer's probe shape). RocksDB's error is sticky for the life
 * of an open store, so recovery is a restart (measured 2026-10-04).
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
const ROOTUSER = process.getuid?.() === 0;   // chmod does not bite for root
const SKIP = !HAVE_PY ? `UNAVAILABLE: no python with pyoxigraph at ${PY}` : ROOTUSER ? 'UNAVAILABLE: running as root, a read-only directory is no fault' : false;

function start(store, create) {
  return new Promise((resolve, reject) => {
    const p = spawn(PY, [EXEC, '--store', store, '--port', '0', '--dataset-id', 'latch', ...(create ? ['--create'] : [])], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; if (out.includes('\n')) resolve({ p, base: `http://127.0.0.1:${JSON.parse(out.split('\n')[0]).port}` }); });
    p.stderr.on('data', (d) => { err += d; });
    p.on('exit', (code) => reject(Object.assign(new Error(`exited ${code}: ${err}`), { stderr: err })));
  });
}
const health = async (base) => (await fetch(`${base}/health`)).json();
const rule = (n) => ({ kind: 'rule', opId: `urn:ex:op/latch-${n}`, actor: 'urn:ex:admin', rule: { iri: `urn:ex:R/latch-${n}` } });

test('#1559 a storage fault LATCHES: the failing write is UNKNOWN, health says DEGRADED, later writes are refused before apply, reads go on; a restart recovers and the failed op is reconciled by its receipt', { skip: SKIP }, async () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'latch-'));
  let e = await start(store, true);
  const c = createGraphClient({ baseUrl: e.base });
  try {
    assert.equal((await c.update(rule(0))).outcome, 'APPLIED', 'twin: the same write before the fault');
    assert.equal((await health(e.base)).status, 'OK');

    fs.chmodSync(store, 0o555);
    const failed = rule(1);
    const r1 = await c.update(failed);
    assert.equal(r1.outcome, 'UNKNOWN', `the faulting write may have committed, so it is UNKNOWN: ${JSON.stringify(r1)}`);
    const h1 = await health(e.base);
    assert.equal(h1.status, 'DEGRADED');
    assert.equal(h1.degraded.failedOpId, failed.opId);
    assert.match(h1.degraded.reason, /IO error/);

    fs.chmodSync(store, 0o755);   // the cause removed: the latch HOLDS (RocksDB's error is sticky)
    const u0 = h1.updates;
    const r2 = await c.update(rule(2));
    assert.equal(r2.outcome, 'UNAVAILABLE', 'refused before apply, so provably not applied');
    assert.match(r2.reason, /executor degraded/);
    assert.equal((await health(e.base)).updates, u0, 'update() was never called for the refused write');
    const q = await c.query('SELECT ?r WHERE { ?r <urn:ex:rev> ?v }');
    assert.equal(q.ok, true, 'reads continue while degraded');

    // recovery = restart; then reconcile the failed op BY ITS RECEIPT, never assuming it failed
    e.p.kill('SIGKILL');
    await new Promise((r) => e.p.on('exit', r));
    e = await start(store, false);
    const c2 = createGraphClient({ baseUrl: e.base });
    assert.equal((await health(e.base)).status, 'OK', 'a fresh process, with a startup flush that succeeded');
    const rec = await c2.reconcile(failed);
    assert.ok(['APPLIED', 'ABSENT'].includes(rec.outcome), `reconciled: ${rec.outcome}`);
    const replay = await c2.update(failed);   // the same intention: applies once at most, never twice
    assert.equal(replay.outcome, 'APPLIED');
    const n = (await c2.query(`SELECT ?o WHERE { GRAPH <urn:scrum:bookkeeping:executor> { <${failed.opId}> <urn:ex:outcome> ?o } }`)).rows.length;
    assert.equal(n, 1, 'exactly one receipt for the failed op after reconcile + replay');
    assert.equal((await c2.update(rule(3))).outcome, 'APPLIED', 'writes are open again');
  } finally {
    try { fs.chmodSync(store, 0o755); } catch {}
    e.p.kill('SIGKILL');
  }
});

test('#1559 a MALFORMED query is a caller error and does NOT latch (twin of the fault above)', { skip: SKIP }, async () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'latch-'));
  const e = await start(store, true);
  try {
    const r = await fetch(`${e.base}/update`, { method: 'POST', body: 'INSERT DATA { this is not sparql', headers: { 'x-op-id': 'urn:ex:op/bad' } });
    assert.equal(r.status, 500);
    assert.equal((await health(e.base)).status, 'OK');
    assert.equal((await createGraphClient({ baseUrl: e.base }).update(rule(9))).outcome, 'APPLIED');
  } finally { e.p.kill('SIGKILL'); }
});

test('#1559 startup self-check: on an unwritable store it REFUSES to serve, naming the self-check; the same store writable serves (twin)', { skip: SKIP }, async () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'latch-'));
  const e = await start(store, true);
  e.p.kill('SIGKILL');
  await new Promise((r) => e.p.on('exit', r));
  fs.chmodSync(store, 0o555);
  try {
    // A read-only directory already fails at OPEN (RocksDB creates its log file there), so this
    // exercises the open refusal. The self-check's OWN contribution (a fault that open survives,
    // e.g. a full disk) is UNEXERCISED here: no permission fault separates the two without
    // fault injection, which would need separate review.
    await assert.rejects(start(store, false), /REFUSED: (store could not be opened for writing|startup self-check write\+flush failed)/);
  } finally { fs.chmodSync(store, 0o755); }
  const ok = await start(store, false);
  try { assert.equal((await health(ok.base)).status, 'OK'); } finally { ok.p.kill('SIGKILL'); }
});

test('#1559 the latch sits INSIDE the write lock: two writes queued under one fault give exactly one UNKNOWN and one UNAVAILABLE', { skip: SKIP }, async () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'latch-'));
  const e = await start(store, true);
  const c = createGraphClient({ baseUrl: e.base });
  try {
    assert.equal((await c.update(rule(10))).outcome, 'APPLIED');
    fs.chmodSync(store, 0o555);
    const outs = (await Promise.all([c.update(rule(11)), c.update(rule(12))])).map((r) => r.outcome).sort();
    assert.deepEqual(outs, ['UNAVAILABLE', 'UNKNOWN']);
    const h = await health(e.base);
    assert.equal(h.status, 'DEGRADED');
    assert.ok(['urn:ex:op/latch-11', 'urn:ex:op/latch-12'].includes(h.degraded.failedOpId));
  } finally { fs.chmodSync(store, 0o755); e.p.kill('SIGKILL'); }
});
