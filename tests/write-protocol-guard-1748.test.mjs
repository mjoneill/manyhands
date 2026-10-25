/**
 * #1748 — the BUILDER's tests for how the floor guard is built (the row author's tests/write-protocol-floor-1748.test.mjs holds the
 * contract rows, including M2e2's tamper shapes). The guard runs INSIDE the update it protects, so these pin what follows from that:
 * a refused tamper leaves a floor that a RESTART still reads; an engine error inside a floored update applies NOTHING (the guard
 * must not turn a half-applied update into a durable one); and a floor that is not a plain string is refused at start, never
 * compared by its lexical value.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WRITE_PROTOCOL, WRITE_PROTOCOL_HEADER } from '../core/graph-client.mjs';
import { spawnExecutor, killExecutor, HAVE_PY, PY } from './helpers/graph-executor-proc.mjs';

const T = { skip: HAVE_PY ? false : `UNAVAILABLE: no python with pyoxigraph at ${PY} (a skip is not a pass)`, timeout: 120000 };
const DSID = 'floor-guard-1748';
const BK = 'urn:scrum:bookkeeping:executor';
const F = '<urn:ex:write-floor> <urn:ex:write-floor/minProtocol>';

const owned = { stores: new Set(), children: new Set() };
after(async () => {
  for (const x of owned.children) await killExecutor(x);
  for (const d of owned.stores) fs.rmSync(d, { recursive: true, force: true });
});
const freshStore = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'floor-guard-')); owned.stores.add(d); fs.rmSync(d, { recursive: true }); return d; };
const start = async (store, extra = []) => { const x = await spawnExecutor(['--store', store, '--port', '0', '--dataset-id', DSID, ...extra]); owned.children.add(x); return x; };
const stop = async (x) => { await killExecutor(x); owned.children.delete(x); };
const health = async (x) => (await fetch(`${x.baseUrl}/health`)).json();
let n = 0;
const update = async (x, sparql, { protocol = WRITE_PROTOCOL } = {}) => {
  const op = `urn:ex:op/test/floor-guard-${process.pid}-${++n}`;
  const headers = { 'content-type': 'application/sparql-update', 'x-op-id': op, 'x-epoch': String((await health(x)).epoch) };
  if (protocol) headers[WRITE_PROTOCOL_HEADER] = protocol;
  const r = await fetch(`${x.baseUrl}/update`, { method: 'POST', headers, body: sparql });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const ask = async (x, q) => {
  const r = await fetch(`${x.baseUrl}/query`, { method: 'POST', headers: { 'content-type': 'application/sparql-query', accept: 'application/sparql-results+json' }, body: q });
  return (await r.json()).boolean;
};
const counters = (h) => [h.updates, h.flushes, h.commitSeq];

test('#1748 (guard) a refused data-dependent tamper leaves a floor that a RESTART still enforces', T, async () => {
  const store = freshStore();
  let x = await start(store, ['--create', '--install-write-floor', WRITE_PROTOCOL]);
  assert.equal((await update(x, 'INSERT DATA { <urn:ex:card/1> <urn:ex:p> "a card" }')).status, 200, 'PRECONDITION: an ordinary write applies');
  const r = await update(x, `DELETE { GRAPH <${BK}> { ${F} ?v } } WHERE { <urn:ex:card/1> ?q ?r . GRAPH <${BK}> { ${F} ?v } }`);
  assert.equal(r.status, 409, `refused (${JSON.stringify(r.body)})`);
  assert.equal(r.body?.error, 'WRITE_FLOOR_PROTECTED');
  await stop(x);
  x = await start(store);
  assert.equal((await health(x)).writeFloor, WRITE_PROTOCOL, 'the restarted executor reads the floor back');
  const bare = await update(x, 'INSERT DATA { <urn:ex:card/2> <urn:ex:p> "b" }', { protocol: null });
  assert.equal(bare.status, 428, 'and still refuses a write without the protocol');
  await stop(x);
});

test('#1748 (guard) an ENGINE error inside a floored update applies nothing: no half of it becomes durable', T, async () => {
  const x = await start(freshStore(), ['--create', '--install-write-floor', WRITE_PROTOCOL]);
  const h0 = await health(x);
  const r = await update(x, 'INSERT DATA { <urn:ex:half> <urn:ex:p> "first half" } ; DROP GRAPH <urn:ex:g/never-created>');
  assert.equal(r.status, 500, `an engine error is not a floor refusal (${JSON.stringify(r.body)})`);
  assert.equal(await ask(x, 'ASK { <urn:ex:half> ?p ?o }'), false, 'the operation before the error was not applied');
  assert.deepEqual(counters(await health(x)), counters(h0), 'nothing counted or flushed');
  assert.equal(await ask(x, `ASK { GRAPH <${BK}> { ${F} "${WRITE_PROTOCOL}" } }`), true, 'the floor is untouched');
  await stop(x);
});

test('#1748 (guard) a floor that is not a plain string (here language-tagged) is refused at start, not matched by its lexical value', T, async () => {
  const store = freshStore();
  let x = await start(store, ['--create']);
  const seed = await update(x, `INSERT DATA { GRAPH <${BK}> { ${F} "${WRITE_PROTOCOL}"@en } }`, { protocol: null });
  assert.equal(seed.status, 200, `PRECONDITION: an unfloored store accepts the seed (${JSON.stringify(seed.body)})`);
  await stop(x);
  await assert.rejects(start(store), (e) => /not a plain string literal/.test(e.stderr ?? e.message), 'the executor refuses to start');
});
