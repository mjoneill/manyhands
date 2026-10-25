/**
 * #1748 — M2 / F1: the executor's WRITE PROTOCOL FLOOR (contract v2, "Executor-enforced admission fence").
 *
 * Promotion/epoch alone is not an old-writer fence: a freshly started old client adopts the new epoch
 * (core/graph-client.mjs learns it on first use). So activation installs a minimum write protocol,
 * initially `postseq-v1`, in executor bookkeeping. Once it is installed, every /update must declare the
 * matching `x-manyhands-write-protocol` BEFORE anything is applied; otherwise HTTP 428
 * WRITE_PROTOCOL_REQUIRED, applied:false, no commitSeq advance and no receipt. Reads stay available.
 * The floor survives restart and backup/restore, and even a CURRENT-protocol request cannot delete or
 * rewrite it.
 *
 * ROWS ONLY. These are RED until the fence is built: the install flag below does not exist yet, so every
 * floored executor fails to start. The C0 control is GREEN today and proves the harness writes.
 *
 * THE INTERFACE THESE ROWS FIX (the builder implements exactly this, or changes the rows in review):
 *   · install:  executor.py ... --install-write-floor postseq-v1   (the maintenance-activation hook, in the
 *               --promote-epoch idiom: applied at startup, then the executor serves). Installing the SAME
 *               protocol again is a no-op; a DIFFERENT protocol on a floored store refuses to start.
 *   · storage:  FLOOR_S FLOOR_P "postseq-v1" in the bookkeeping graph BK (named below, so the tampering
 *               rows can aim at it). Not reachable through the public dataset, like all bookkeeping.
 *   · header:   x-manyhands-write-protocol: postseq-v1
 *   · refusal:  428 { error: 'WRITE_PROTOCOL_REQUIRED', applied: false, requiredProtocol: 'postseq-v1' }
 *   · health:   /health reports { writeFloor: 'postseq-v1' } once installed, null before.
 *
 * Not claimed (contract v2): the header is a compatibility fence against accidental old runtimes, not
 * authentication; a same-host actor who forges it is out of scope. Disabling old launch paths is the
 * separate deployment half of M2 (#1747 step 6), not tested here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGraphClient } from '../core/graph-client.mjs';
import { spawnExecutor } from './helpers/graph-executor-proc.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = process.env.GRAPH_EXECUTOR_PYTHON || path.join(ROOT, 'graph-executor', '.venv', 'bin', 'python');
const HAVE_PY = fs.existsSync(PY) && spawnSync(PY, ['-c', 'import pyoxigraph'], { stdio: 'ignore' }).status === 0;
const SKIP = HAVE_PY ? false : `UNAVAILABLE: no python with pyoxigraph at ${PY} (a skip is not a pass)`;

const PROTOCOL = 'postseq-v1';
const HEADER = 'x-manyhands-write-protocol';
const BK = 'urn:scrum:bookkeeping:executor';
const FLOOR_S = 'urn:ex:write-floor';
const FLOOR_P = 'urn:ex:write-floor/minProtocol';
const INSTALL = ['--install-write-floor', PROTOCOL];

const start = (store, extra = []) => spawnExecutor(['--store', store, '--port', '0', '--dataset-id', 'floor', ...extra]).then((x) => ({ p: x.proc, base: x.baseUrl }));
const stop = async (e) => { e.p.kill('SIGKILL'); await new Promise((r) => e.p.on('exit', r)); };
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `floor-${p}-`));
let n = 0;
const opId = (tag) => `urn:ex:op/test/floor-${tag}-${process.pid}-${n++}`;

/** POST /update with full control of the headers: the closed-schema client would add its own. */
const update = async (base, sparql, { protocol, op = opId('u'), extraHeaders = {} } = {}) => {
  const headers = { 'x-op-id': op, ...extraHeaders };
  if (protocol !== undefined) headers[HEADER] = protocol;
  const r = await fetch(`${base}/update`, { method: 'POST', headers, body: sparql });
  return { status: r.status, body: await r.json().catch(() => null), op };
};
const query = async (base, sparql) => {
  const r = await fetch(`${base}/query`, { method: 'POST', headers: { 'x-op-id': opId('q') }, body: sparql });
  assert.equal(r.status, 200, `PRECONDITION: a read is served (${r.status})`);
  return (await r.json()).results.bindings;
};
const health = async (base) => (await fetch(`${base}/health`)).json();
const receipt = async (base, op) => (await (await fetch(`${base}/receipt/${encodeURIComponent(op)}`)).json()).receipt;

/**
 * The WHOLE store, every graph, as sorted canonical lines: a count can stay equal while a value is
 * replaced, so "nothing was applied" is asserted on the full content, never on a quad count.
 */
const snapshot = async (base) => {
  const rows = await query(base, 'SELECT ?g ?s ?p ?o WHERE { { ?s ?p ?o } UNION { GRAPH ?g { ?s ?p ?o } } }');
  const t = (b) => (b ? `${b.type}:${b.value}:${b.datatype || ''}:${b['xml:lang'] || ''}` : '-');
  return rows.map((r) => [t(r.g), t(r.s), t(r.p), t(r.o)].join(' ')).sort();
};
const floorValues = async (base) => (await query(base, `SELECT ?v WHERE { GRAPH <${BK}> { <${FLOOR_S}> <${FLOOR_P}> ?v } }`)).map((r) => r.v.value);

const INSERT = (tag) => `INSERT DATA { <urn:ex:floor/${tag}> <urn:ex:floor/p> "v-${tag}" }`;

/** Asserts a refusal that applied NOTHING: 428, the named error, the store byte-identical, commitSeq and receipt untouched. */
async function assertRefused(base, res, before, why) {
  assert.equal(res.status, 428, `${why}: HTTP 428 (got ${res.status} ${JSON.stringify(res.body)})`);
  assert.equal(res.body?.error, 'WRITE_PROTOCOL_REQUIRED', `${why}: the refusal is named`);
  assert.equal(res.body?.applied, false, `${why}: applied:false is explicit`);
  assert.equal(res.body?.requiredProtocol, PROTOCOL, `${why}: it names the protocol it needs`);
  assert.deepEqual(await snapshot(base), before.snap, `${why}: the store is byte-identical`);
  assert.equal((await health(base)).commitSeq, before.commitSeq, `${why}: commitSeq did not advance`);
  assert.equal(await receipt(base, res.op), null, `${why}: no receipt was recorded`);
}
const state = async (base) => ({ snap: await snapshot(base), commitSeq: (await health(base)).commitSeq });

test('#1748 C0 CONTROL (green today): with NO floor installed, an /update without the header applies — the harness writes', { skip: SKIP }, async () => {
  const e = await start(tmp('c0'), ['--create']);
  try {
    const r = await update(e.base, INSERT('c0'));
    assert.equal(r.status, 200, `today's behaviour: ${JSON.stringify(r.body)}`);
    assert.equal((await query(e.base, 'SELECT ?o WHERE { <urn:ex:floor/c0> ?p ?o }')).length, 1, 'and the write is stored');
  } finally { await stop(e); }
});

test('#1748 M2a: installing the floor records it in bookkeeping, reports it on /health, and keeps it out of the public dataset', { skip: SKIP }, async () => {
  const e = await start(tmp('m2a'), ['--create', ...INSTALL]);
  try {
    assert.equal((await health(e.base)).writeFloor, PROTOCOL, '/health names the installed floor');
    assert.deepEqual(await floorValues(e.base), [PROTOCOL], 'exactly one floor value, in the bookkeeping graph');
    const pub = await fetch(`${e.base}/query?dataset=public`, { method: 'POST', headers: { 'x-op-id': opId('pq') }, body: `SELECT ?v WHERE { <${FLOOR_S}> <${FLOOR_P}> ?v }` });
    assert.deepEqual((await pub.json()).results.bindings, [], 'bookkeeping: not reachable through a public read');
  } finally { await stop(e); }
});

test('#1748 M2b: with the floor installed, a write WITHOUT the header is refused 428 and applies nothing', { skip: SKIP }, async () => {
  const e = await start(tmp('m2b'), ['--create', ...INSTALL]);
  try {
    const before = await state(e.base);
    await assertRefused(e.base, await update(e.base, INSERT('m2b')), before, 'no header');
  } finally { await stop(e); }
});

test('#1748 M2c: an OLDER or WRONG protocol declaration is refused the same way (only the exact floor admits)', { skip: SKIP }, async () => {
  const e = await start(tmp('m2c'), ['--create', ...INSTALL]);
  try {
    for (const p of ['postseq-v0', '', 'POSTSEQ-V1', `${PROTOCOL} `]) {
      const before = await state(e.base);
      await assertRefused(e.base, await update(e.base, INSERT(`m2c-${n}`), { protocol: p }), before, `declared ${JSON.stringify(p)}`);
    }
  } finally { await stop(e); }
});

test('#1748 M2d: the MATCHING declaration applies and is stored (the fence admits the new client)', { skip: SKIP }, async () => {
  const e = await start(tmp('m2d'), ['--create', ...INSTALL]);
  try {
    // raw SPARQL writes no receipt and no commitSeq (only a compiled intention does), so this row asserts storage only
    const r = await update(e.base, INSERT('m2d'), { protocol: PROTOCOL });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await query(e.base, 'SELECT ?o WHERE { <urn:ex:floor/m2d> ?p ?o }')).length, 1, 'stored');
  } finally { await stop(e); }
});

// TODAY'S closed-schema client sends no protocol header: after activation it IS the "old binary". Its intention writes a
// receipt and advances commitSeq when it applies (C1 proves both are observable), so M2j's "no receipt, no commitSeq
// advance" is a claim that can fail, unlike the same assertion on raw SPARQL.
const rule = (tag) => ({ kind: 'rule', opId: opId(`rule-${tag}`), actor: 'urn:ex:admin', rule: { iri: `urn:ex:R/floor-${tag}-${n}` } });

test('#1748 C1 CONTROL (green today): with NO floor, today\'s client applies an intention — receipt written, commitSeq advanced (so M2j\'s assertions can fail)', { skip: SKIP }, async () => {
  const e = await start(tmp('c1'), ['--create']);
  try {
    const c0 = (await health(e.base)).commitSeq;
    const intent = rule('c1');
    const out = await createGraphClient({ baseUrl: e.base }).update(intent);
    assert.equal(out.outcome, 'APPLIED', JSON.stringify(out));
    assert.notEqual(await receipt(e.base, intent.opId), null, 'the intention left a receipt');
    assert.notEqual((await health(e.base)).commitSeq, c0, 'and advanced commitSeq');
  } finally { await stop(e); }
});

test('#1748 M2j: with the floor, TODAY\'S client (an old binary: no header) cannot apply — not APPLIED, no receipt, no commitSeq advance, store unchanged', { skip: SKIP }, async () => {
  const e = await start(tmp('m2j'), ['--create', ...INSTALL]);
  try {
    const before = await state(e.base);
    const intent = rule('m2j');
    const out = await createGraphClient({ baseUrl: e.base }).update(intent);
    assert.notEqual(out.outcome, 'APPLIED', `an old client may call it UNKNOWN, never APPLIED (${JSON.stringify(out)})`);
    assert.equal(await receipt(e.base, intent.opId), null, 'no receipt');
    assert.equal((await health(e.base)).commitSeq, before.commitSeq, 'commitSeq unchanged');
    assert.deepEqual(await snapshot(e.base), before.snap, 'store byte-identical');
  } finally { await stop(e); }
});

test('#1748 M2e TAMPERING (the contract\'s negative control): even WITH the current protocol, an update that deletes or rewrites the floor is refused and the floor reads back unchanged', { skip: SKIP }, async () => {
  const e = await start(tmp('m2e'), ['--create', ...INSTALL]);
  try {
    const attacks = {
      'named delete': `DELETE DATA { GRAPH <${BK}> { <${FLOOR_S}> <${FLOOR_P}> "${PROTOCOL}" } }`,
      'rewrite to an older protocol': `DELETE { GRAPH <${BK}> { <${FLOOR_S}> <${FLOOR_P}> ?v } } INSERT { GRAPH <${BK}> { <${FLOOR_S}> <${FLOOR_P}> "postseq-v0" } } WHERE { GRAPH <${BK}> { <${FLOOR_S}> <${FLOOR_P}> ?v } }`,
      // the IRI never appears in this body, so a text match on the floor's name cannot be the mechanism
      'wildcard wipe of the bookkeeping graph': `DELETE WHERE { GRAPH <${BK}> { ?s ?p ?o } }`,
      'CLEAR ALL': 'CLEAR ALL',
      'a second, conflicting floor value': `INSERT DATA { GRAPH <${BK}> { <${FLOOR_S}> <${FLOOR_P}> "postseq-v0" } }`,
    };
    for (const [why, sparql] of Object.entries(attacks)) {
      const before = await state(e.base);
      const r = await update(e.base, sparql, { protocol: PROTOCOL });
      assert.ok(r.status >= 400 && r.status < 500, `${why}: refused with a 4xx (got ${r.status} ${JSON.stringify(r.body)})`);
      assert.equal(r.body?.applied, false, `${why}: applied:false`);
      assert.deepEqual(await floorValues(e.base), [PROTOCOL], `${why}: the floor reads back unchanged`);
      assert.deepEqual(await snapshot(e.base), before.snap, `${why}: nothing else was applied either (refusal is whole, not partial)`);
      assert.equal(await receipt(e.base, r.op), null, `${why}: no receipt`);
    }
    // and the fence still bites afterwards
    const after = await state(e.base);
    await assertRefused(e.base, await update(e.base, INSERT('m2e-after')), after, 'no header, after the tampering attempts');
  } finally { await stop(e); }
});

test('#1748 M2f: the floor SURVIVES RESTART — a fresh executor started WITHOUT the install flag still refuses', { skip: SKIP }, async () => {
  const store = tmp('m2f');
  let e = await start(store, ['--create', ...INSTALL]);
  await stop(e);
  e = await start(store);   // a plain start: what an old launch path would do
  try {
    assert.equal((await health(e.base)).writeFloor, PROTOCOL, 'still reported after restart');
    const before = await state(e.base);
    await assertRefused(e.base, await update(e.base, INSERT('m2f')), before, 'after restart');
  } finally { await stop(e); }
});

test('#1748 M2g: the floor SURVIVES BACKUP AND RESTORE — a store restored from a copy refuses, and so does a promoted restore', { skip: SKIP }, async () => {
  const live = tmp('m2g-live');
  let e = await start(live, ['--create', ...INSTALL]);
  await stop(e);
  for (const extra of [[], ['--promote-epoch']]) {
    const restore = tmp('m2g-restore');
    fs.cpSync(live, restore, { recursive: true });   // an independent copy, like the hourly backup
    e = await start(restore, extra);
    try {
      assert.equal((await health(e.base)).writeFloor, PROTOCOL, `restored${extra.length ? ' and promoted' : ''}: floor present`);
      const h = await health(e.base);
      const before = await state(e.base);
      // a fresh client on the restored store's CURRENT epoch: the epoch fence would admit it, the floor must not
      const r = await update(e.base, INSERT(`m2g-${n}`), { extraHeaders: { 'x-epoch': String(h.epoch) } });
      await assertRefused(e.base, r, before, `restored${extra.length ? ' and promoted' : ''}, current epoch, no header`);
    } finally { await stop(e); }
  }
});

test('#1748 M2h: a FRESH old client may still READ (and learn the epoch) on a floored store — the fence is on writes only', { skip: SKIP }, async () => {
  const e = await start(tmp('m2h'), ['--create', ...INSTALL]);
  try {
    const h = await health(e.base);
    assert.ok(h.epoch !== undefined && h.epoch !== null, '/health still answers with the epoch');
    await query(e.base, 'SELECT * WHERE { ?s ?p ?o } LIMIT 1');   // asserts 200 inside
    assert.equal((await fetch(`${e.base}/receipt/${encodeURIComponent('urn:ex:op/none')}`)).status, 200, 'receipt reconciliation stays available');
  } finally { await stop(e); }
});

test('#1748 M2i: installing the SAME floor again is a no-op; a DIFFERENT protocol on a floored store refuses to start (no downgrade by relaunch)', { skip: SKIP }, async () => {
  const store = tmp('m2i');
  let e = await start(store, ['--create', ...INSTALL]);
  await stop(e);
  e = await start(store, INSTALL);
  try { assert.deepEqual(await floorValues(e.base), [PROTOCOL], 'one value, not two'); } finally { await stop(e); }
  await assert.rejects(start(store, ['--install-write-floor', 'postseq-v0']), (err) => /write.?floor|protocol/i.test(String(err.stderr || err.message)),
    'a relaunch naming an older protocol is refused at startup, naming the floor');
  e = await start(store);
  try { assert.equal((await health(e.base)).writeFloor, PROTOCOL, 'and the refused relaunch changed nothing'); } finally { await stop(e); }
});
