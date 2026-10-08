/**
 * #1559 latch pins that bae985f's own tests left unprotected. Written by a reviewer
 * in review (diagnostics/review-1559-20261004, sha ec016042…), adopted by the builder,
 * with a third test added for her same-opId finding.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
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
const SKIP = !HAVE_PY ? `UNAVAILABLE: no python with pyoxigraph at ${PY}` : process.getuid?.() === 0 ? 'UNAVAILABLE: root' : false;
function start(store, create) {
  return new Promise((resolve, reject) => {
    const p = spawn(PY, [EXEC, '--store', store, '--port', '0', '--dataset-id', 'latch', ...(create ? ['--create'] : [])], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; if (out.includes('\n')) resolve({ p, base: `http://127.0.0.1:${JSON.parse(out.split('\n')[0]).port}` }); });
    p.stderr.on('data', (d) => { err += d; });
    p.on('exit', (code) => reject(new Error(`exited ${code}: ${err}`)));
  });
}
const rule = (n) => ({ kind: 'rule', opId: `urn:ex:op/rv-${n}`, actor: 'urn:ex:admin', rule: { iri: `urn:ex:R/rv-${n}` } });
const stub = (status, body) => new Promise((res) => { const s = http.createServer((q, r) => { q.resume(); r.writeHead(status, { 'content-type': 'application/json' }); r.end(body); }); s.listen(0, '127.0.0.1', () => res({ s, base: `http://127.0.0.1:${s.address().port}` })); });

test('#1559 only the validated degraded refusal is UNAVAILABLE; any other 503 stays UNKNOWN (a reviewer pin 1)', async () => {
  const plain = await stub(503, JSON.stringify({ error: 'busy' }));
  const latched = await stub(503, JSON.stringify({ error: 'degraded', degraded: { reason: 'x', failedOpId: 'urn:ex:op/z' } }));
  try {
    assert.equal((await createGraphClient({ baseUrl: plain.base }).update(rule(1))).outcome, 'UNKNOWN', 'a generic 503 may have been applied');
    assert.equal((await createGraphClient({ baseUrl: latched.base }).update(rule(2))).outcome, 'UNAVAILABLE', 'twin: the validated degraded body');
  } finally { plain.s.close(); latched.s.close(); }
});

test('#1559 a healthy restart leaves the store content unchanged: the self-check leaves nothing behind', { skip: SKIP }, async () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'rvl-'));
  let e = await start(store, true);
  // the full logical quad set, not a count: a replacement triple would keep the count (a reviewer)
  const count = async (base) => JSON.stringify((await (await fetch(`${base}/query`, { method: 'POST', body: 'SELECT ?s ?p ?o ?g WHERE { { ?s ?p ?o } UNION { GRAPH ?g { ?s ?p ?o } } }' })).json()).results.bindings.map((b) => JSON.stringify(b)).sort());
  try {
    await createGraphClient({ baseUrl: e.base }).update(rule(3));
    const n0 = await count(e.base);
    for (let i = 0; i < 2; i++) { e.p.kill('SIGKILL'); await new Promise((r) => e.p.on('exit', r)); e = await start(store, false); }
    assert.equal(await count(e.base), n0, 'two restarts changed the logical quad set');
  } finally { e.p.kill('SIGKILL'); }
});

test('#1559 a RETRY of the opId whose write faulted stays UNKNOWN (it may have committed); a different op is UNAVAILABLE (a reviewer finding)', { skip: SKIP }, async () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'rvl-'));
  const e = await start(store, true);
  const c = createGraphClient({ baseUrl: e.base });
  try {
    assert.equal((await c.update(rule(10))).outcome, 'APPLIED');
    fs.chmodSync(store, 0o555);
    const failed = rule(11);
    assert.equal((await c.update(failed)).outcome, 'UNKNOWN', 'the faulting attempt');
    const retry = await c.update(failed);
    assert.equal(retry.outcome, 'UNKNOWN', 'the SAME intention: still unknown until reconciled');
    assert.match(retry.reason, /reconcile/);
    assert.equal((await c.update(rule(12))).outcome, 'UNAVAILABLE', 'twin: a different op is provably not applied');
  } finally { fs.chmodSync(store, 0o755); e.p.kill('SIGKILL'); }
});

test('#1559 a stale self-check probe (a crash between insert and delete) is cleaned up at startup', { skip: SKIP }, async () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'rvl-'));
  let e = await start(store, true);
  e.p.kill('SIGKILL'); await new Promise((r) => e.p.on('exit', r));
  // a stale probe in the reserved namespace, AND a lookalike outside it that cleanup must NOT touch
  const plant = spawnSync(PY, ['-c', `import pyoxigraph as px\ns = px.Store(${JSON.stringify(store)})\ns.update('INSERT DATA { GRAPH <urn:scrum:bookkeeping:executor> { <urn:ex:selfcheck/1> <urn:ex:selfCheck> true . <urn:ex:other/1> <urn:ex:selfCheck> true } }')\ns.flush()`]);
  assert.equal(plant.status, 0, String(plant.stderr));
  e = await start(store, false);
  try {
    const left = (await (await fetch(`${e.base}/query`, { method: 'POST', body: 'SELECT ?s WHERE { GRAPH <urn:scrum:bookkeeping:executor> { ?s <urn:ex:selfCheck> true } }' })).json()).results.bindings.map((b) => b.s.value);
    assert.deepEqual(left, ['urn:ex:other/1'], 'only the reserved-namespace probe is removed');
  } finally { e.p.kill('SIGKILL'); }
});
