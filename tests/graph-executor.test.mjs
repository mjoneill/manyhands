/**
 * #1558 slice — the graph executor (graph-executor/executor.py), exercised as a
 * real process on a throwaway store. Fabricated data only.
 *
 * These are the executor's own contract tests (D2 v1 §3). The pre-registered
 * proofs P1–P8 run separately against compiled output.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXEC = path.join(ROOT, 'graph-executor', 'executor.py');
const PY = process.env.GRAPH_EXECUTOR_PYTHON || path.join(ROOT, 'graph-executor', '.venv', 'bin', 'python');
const HAVE_PY = fs.existsSync(PY)
  && spawnSync(PY, ['-c', 'import pyoxigraph'], { stdio: 'ignore' }).status === 0;
const SKIP = HAVE_PY ? false : `UNAVAILABLE: no python with pyoxigraph at ${PY} (pip install -r graph-executor/requirements.txt)`;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gx-'));

function start(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(PY, [EXEC, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => {
      out += d;
      const line = out.split('\n')[0];
      if (out.includes('\n')) { try { resolve({ proc: p, ready: JSON.parse(line) }); } catch (e) { reject(e); } }
    });
    p.stderr.on('data', (d) => { err += d; });
    p.on('exit', (code) => reject(Object.assign(new Error(`exited ${code}: ${err}`), { code, stderr: err })));
  });
}

const post = (port, p, body, headers = {}) =>
  fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', body, headers });

let srv, port, store, logFile;
before(async () => {
  if (SKIP) return;
  store = tmp();
  logFile = path.join(tmp(), 'exec.log');
  srv = await start(['--store', store, '--port', '0', '--dataset-id', 'trial-dev-1', '--create', '--log', logFile]);
  port = srv.ready.port;
});
after(() => { srv?.proc.kill('SIGKILL'); });

test('#1558 executor starts on an empty store with a marker at epoch 1, commitSeq 0', { skip: SKIP }, () => {
  assert.equal(srv.ready.datasetId, 'trial-dev-1');
  assert.equal(srv.ready.epoch, '1');
  assert.equal(srv.ready.commitSeq, '0');
  assert.equal(srv.ready.syncMode, 'flush');
});

test('#1558 a second read-write process on the same store is refused (RocksDB LOCK)', { skip: SKIP }, async () => {
  await assert.rejects(start(['--store', store, '--port', '0', '--dataset-id', 'trial-dev-1']), /exited/);
});

test('#1558 startup fencing: a store with a different dataset identity is refused', { skip: SKIP }, async () => {
  const s = tmp();
  const a = await start(['--store', s, '--port', '0', '--dataset-id', 'A', '--create']);
  a.proc.kill('SIGKILL');
  await new Promise((r) => a.proc.on('exit', r));
  await assert.rejects(start(['--store', s, '--port', '0', '--dataset-id', 'B']), /dataset identity mismatch/);
});

test('#1558 a store with no marker is refused without --create', { skip: SKIP }, async () => {
  await assert.rejects(start(['--store', tmp(), '--port', '0', '--dataset-id', 'X']), /no dataset marker/);
});

test('#1558 an update without an opId is refused and changes nothing', { skip: SKIP }, async () => {
  const r = await post(port, '/update', 'INSERT DATA { <urn:ex:a> <urn:ex:b> 1 }');
  assert.equal(r.status, 400);
  const q = await post(port, '/query', 'ASK { <urn:ex:a> <urn:ex:b> ?x }');
  assert.equal((await q.json()).boolean, false);
});

test('#1558 an update is flushed before its acknowledgement, and the receipt is read back from the store', { skip: SKIP }, async () => {
  const before = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  const body = 'INSERT DATA { <urn:ex:op/t1> <urn:ex:outcome> <urn:ex:APPLIED> ; <urn:ex:digest> "d1" }';
  const r = await post(port, '/update', body, { 'x-op-id': 'urn:ex:op/t1' });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.flushed, true);
  assert.deepEqual(j.receipt.outcome, [{ type: 'uri', value: 'urn:ex:APPLIED' }]);
  const after = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.equal(after.flushes - before.flushes, 1);
  assert.equal(after.updates - before.updates, 1);
  // the request log carries the body's sha256 (D2 proofs A2 §8)
  const { createHash } = await import('node:crypto');
  const sha = createHash('sha256').update(body).digest('hex');
  assert.equal(j.bodySha256, sha);
  assert.match(fs.readFileSync(logFile, 'utf8'), new RegExp(`urn:ex:op/t1 update OK [0-9.]+ ${sha}`));
});

test('#1558 an update that writes nothing (a replay) is still flushed before acknowledgement', { skip: SKIP }, async () => {
  const before = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  const r = await post(port, '/update', 'DELETE WHERE { <urn:ex:nothing> ?p ?o }', { 'x-op-id': 'urn:ex:op/t1' });
  assert.equal(r.status, 200);
  const after = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.equal(after.flushes - before.flushes, 1);
});

test('#1558 GET /receipt returns the stored receipt, or null when there is none', { skip: SKIP }, async () => {
  const has = await (await fetch(`http://127.0.0.1:${port}/receipt/${encodeURIComponent('urn:ex:op/t1')}`)).json();
  assert.equal(has.receipt.digest[0].value, 'd1');
  const none = await (await fetch(`http://127.0.0.1:${port}/receipt/${encodeURIComponent('urn:ex:op/none')}`)).json();
  assert.equal(none.receipt, null);
});

test('#1558 query results keep term types, datatypes and language tags exactly', { skip: SKIP }, async () => {
  await post(port, '/update',
    'INSERT DATA { <urn:ex:lit> <urn:ex:p> "12.50"^^<http://www.w3.org/2001/XMLSchema#decimal> , "hej"@sv , "plain" , 9007199254740993 }',
    { 'x-op-id': 'urn:ex:op/lit' });
  const j = await (await post(port, '/query', 'SELECT ?o WHERE { <urn:ex:lit> <urn:ex:p> ?o }')).json();
  const got = j.results.bindings.map((b) => b.o);
  // VALUE preserved, LEXICAL form canonicalized by the engine (see the pinned test below)
  assert.ok(got.some((o) => o.value === '12.5' && o.datatype === 'http://www.w3.org/2001/XMLSchema#decimal'));
  assert.ok(got.some((o) => o.value === 'hej' && o['xml:lang'] === 'sv'));
  assert.ok(got.some((o) => o.value === 'plain' && !o.datatype && !o['xml:lang']));
  assert.ok(got.some((o) => o.value === '9007199254740993'), 'a large integer is not rounded through a float');
});

test('#1558 no silent result cap: a 50,000-row query returns all 50,000', { skip: SKIP }, async () => {
  const r = await post(port, '/update',
    'INSERT { ?s <urn:ex:n> ?i } WHERE { VALUES ?a { 0 1 2 3 4 5 6 7 8 9 } VALUES ?b { 0 1 2 3 4 5 6 7 8 9 } VALUES ?c { 0 1 2 3 4 5 6 7 8 9 } VALUES ?d { 0 1 2 3 4 5 6 7 8 9 } VALUES ?e { 0 1 2 3 4 } BIND(?a*10000+?b*1000+?c*100+?d*10+?e AS ?i) BIND(IRI(CONCAT("urn:ex:row/", STR(?i))) AS ?s) }',
    { 'x-op-id': 'urn:ex:op/rows' });
  assert.equal(r.status, 200);
  const j = await (await post(port, '/query', 'SELECT ?s WHERE { ?s <urn:ex:n> ?i }')).json();
  assert.equal(j.results.bindings.length, 50000);
});

test('#1558 a malformed update is an error and is not acknowledged as success', { skip: SKIP }, async () => {
  const r = await post(port, '/update', 'INSERT DATA { this is not sparql', { 'x-op-id': 'urn:ex:op/bad' });
  assert.equal(r.status, 500);
});

test('#1558 PINNED engine fact: Oxigraph canonicalizes typed-literal lexical forms (value kept, timezone never invented)', { skip: SKIP }, async () => {
  // If an engine upgrade changes this, the compiler's canonical-only literal rule
  // (#1565 03:24Z) must be revisited. Measured on pyoxigraph 0.5.11.
  const X = 'http://www.w3.org/2001/XMLSchema#';
  await post(port, '/update',
    `INSERT DATA { <urn:ex:canon> <urn:ex:p> "012"^^<${X}integer> , "1.0E0"^^<${X}double> , "2026-10-04T03:00:00.000Z"^^<${X}dateTime> , "2026-10-04T04:00:00"^^<${X}dateTime> }`,
    { 'x-op-id': 'urn:ex:op/canon' });
  const j = await (await post(port, '/query', 'SELECT ?o WHERE { <urn:ex:canon> <urn:ex:p> ?o }')).json();
  const vals = j.results.bindings.map((b) => b.o.value).sort();
  assert.deepEqual(vals, ['1', '12', '2026-10-04T03:00:00Z', '2026-10-04T04:00:00']);
});

test('#1558 the listen backlog is not the stdlib 5 (P5 run 1: 3 of 8 concurrent writers waited ~30 ms to connect)', { skip: SKIP }, async () => {
  const h = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.ok(h.listenBacklog >= 64, `listenBacklog ${h.listenBacklog}`);
});
