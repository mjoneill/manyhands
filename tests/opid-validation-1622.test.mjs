/**
 * #1622 — an op id that is not an IRI is refused BEFORE the store is touched. Before this, `update()` applied and flushed the write
 * and only then failed building the receipt query from `<opId>`, so a 500 came back for a write that had landed; and GET /receipt/
 * pasted the decoded path into the same query. The rule is the engine's own: an op id is valid exactly when pyoxigraph accepts it as
 * a NamedNode, which is what the receipt query needs. With a write floor (#1748) the protocol is still checked FIRST (M2l's 428).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WRITE_PROTOCOL, WRITE_PROTOCOL_HEADER } from '../core/graph-client.mjs';
import { spawnExecutor, killExecutor, HAVE_PY, PY } from './helpers/graph-executor-proc.mjs';

const T = { skip: HAVE_PY ? false : `UNAVAILABLE: no python with pyoxigraph at ${PY} (a skip is not a pass)`, timeout: 120000 };
const DSID = 'opid-1622';

const owned = { stores: new Set(), children: new Set() };
after(async () => {
  for (const x of owned.children) await killExecutor(x);
  for (const d of owned.stores) fs.rmSync(d, { recursive: true, force: true });
});
const freshStore = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'opid-1622-')); owned.stores.add(d); fs.rmSync(d, { recursive: true }); return d; };
const start = async (extra = []) => { const x = await spawnExecutor(['--store', freshStore(), '--port', '0', '--dataset-id', DSID, '--create', ...extra]); owned.children.add(x); return x; };
const stop = async (x) => { await killExecutor(x); owned.children.delete(x); };
const health = async (x) => (await fetch(`${x.baseUrl}/health`)).json();
const update = async (x, op, sparql, { protocol = null } = {}) => {
  const headers = { 'content-type': 'application/sparql-update', 'x-op-id': op, 'x-epoch': String((await health(x)).epoch) };
  if (protocol) headers[WRITE_PROTOCOL_HEADER] = protocol;
  const r = await fetch(`${x.baseUrl}/update`, { method: 'POST', headers, body: sparql });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const ask = async (x, q) => {
  const r = await fetch(`${x.baseUrl}/query`, { method: 'POST', headers: { 'content-type': 'application/sparql-query' }, body: q });
  return (await r.json()).boolean;
};
const counters = (h) => [h.updates, h.flushes, h.commitSeq];
const BAD = ['not an iri', 'al7-why-1', 'urn:ex:a> ?p ?o } } UNION { ?s ?p ?o'];

async function assertRefusedUntouched(x, op, subject, opts) {
  const h0 = await health(x);
  const r = await update(x, op, `INSERT DATA { <${subject}> <urn:ex:p> "x" }`, opts);
  assert.equal(r.status, 400, `${JSON.stringify(op)}: refused 400 (${r.status} ${JSON.stringify(r.body)})`);
  assert.equal(r.body?.error, 'INVALID_OP_ID', `${JSON.stringify(op)}: named`);
  assert.equal(r.body?.applied, false, `${JSON.stringify(op)}: applied:false`);
  assert.equal(await ask(x, `ASK { <${subject}> ?p ?o }`), false, `${JSON.stringify(op)}: the data is NOT stored`);
  assert.deepEqual(counters(await health(x)), counters(h0), `${JSON.stringify(op)}: nothing applied or flushed`);
}

test('#1622 R1 no floor: an op id that is not an IRI is refused 400 and NOTHING is stored', T, async () => {
  const x = await start();
  try {
    for (const [i, op] of BAD.entries()) await assertRefusedUntouched(x, op, `urn:ex:r1/${i}`);
  } finally { await stop(x); }
});

test('#1622 R2 floored, header DECLARED: a non-IRI op id is still refused 400 before anything applies', T, async () => {
  const x = await start(['--install-write-floor', WRITE_PROTOCOL]);
  try {
    for (const [i, op] of BAD.entries()) await assertRefusedUntouched(x, op, `urn:ex:r2/${i}`, { protocol: WRITE_PROTOCOL });
  } finally { await stop(x); }
});

test('#1622 R3 CONTROL: an IRI op id applies (so the refusal above can fail) — with and without a floor', T, async () => {
  for (const [extra, protocol] of [[[], null], [['--install-write-floor', WRITE_PROTOCOL], WRITE_PROTOCOL]]) {
    const x = await start(extra);
    try {
      const r = await update(x, `urn:ex:op/test/r3-${process.pid}`, 'INSERT DATA { <urn:ex:r3> <urn:ex:p> "x" }', { protocol });
      assert.equal(r.status, 200, `applied (${JSON.stringify(r.body)})`);
      assert.equal(await ask(x, 'ASK { <urn:ex:r3> ?p ?o }'), true, 'and stored');
    } finally { await stop(x); }
  }
});

test('#1622 R4 GET /receipt/: an op id that is not an IRI is refused 400 and runs no query; a valid unknown one answers null', T, async () => {
  const x = await start();
  try {
    for (const op of BAD) {
      const r = await fetch(`${x.baseUrl}/receipt/${encodeURIComponent(op)}`);
      const b = await r.json().catch(() => null);
      assert.equal(r.status, 400, `${JSON.stringify(op)}: refused (${r.status} ${JSON.stringify(b)})`);
      assert.equal(b?.error, 'INVALID_OP_ID');
    }
    const ok = await fetch(`${x.baseUrl}/receipt/${encodeURIComponent('urn:ex:op/never-written')}`);
    assert.equal(ok.status, 200, 'CONTROL: a valid op id is answered');
    assert.equal((await ok.json()).receipt, null, 'with no receipt');
  } finally { await stop(x); }
});
