/**
 * #1748 — M2 / F1: the executor's WRITE PROTOCOL FLOOR (contract v2, "Executor-enforced admission fence").
 *
 * Promotion/epoch alone is not an old-writer fence: a freshly started old client adopts the new epoch
 * (core/graph-client.mjs learns it on first use). So activation installs a minimum write protocol,
 * initially `postseq-v1`, in executor bookkeeping. Once it is installed, every /update must declare the
 * matching `x-manyhands-write-protocol` BEFORE anything is applied; otherwise HTTP 428
 * WRITE_PROTOCOL_REQUIRED, applied:false, no commitSeq advance and no receipt. Reads stay available.
 * The floor survives restart and a supported (promoted) restore, and even a CURRENT-protocol request
 * cannot delete or rewrite it.
 *
 * ROWS ONLY. RED until the fence is built. The C-rows are controls, GREEN today: each proves an
 * observation a fence row relies on can actually fail.
 *
 * THE INTERFACE THESE ROWS FIX (the builder implements exactly this, or changes the rows in review):
 *   · install:  executor.py ... --install-write-floor postseq-v1   (the maintenance-activation hook, in the
 *               --promote-epoch idiom: applied at startup, then the executor serves). Installing the SAME
 *               protocol again is a no-op; a DIFFERENT protocol on a floored store refuses to start.
 *   · storage:  FLOOR_S FLOOR_P "postseq-v1" in the bookkeeping graph BK (named below, so the tampering
 *               rows can aim at it). Not reachable through the public dataset, like all bookkeeping.
 *   · header:   x-manyhands-write-protocol: postseq-v1, sent by the UPDATED core/graph-client.mjs on every
 *               /update (M2k asserts it, positively).
 *   · refusal:  428 { error: 'WRITE_PROTOCOL_REQUIRED', applied: false, requiredProtocol: 'postseq-v1' },
 *               decided under the update lock BEFORE store.update/flush: /health's `updates` and `flushes`
 *               counters do not move on a refusal.
 *   · health:   /health reports { writeFloor: 'postseq-v1' } once installed, null before.
 *
 * THE OLD BINARY is pinned here as `oldWire`: it compiles a REAL intention with today's compiler and posts
 * it exactly as today's client does (x-op-id, x-epoch learned from /health, content-type) and NEVER the
 * protocol header, whatever later changes core/graph-client.mjs. So the builder's client update cannot
 * turn the "old client" rows green by accident.
 *
 * Not claimed (contract v2): the header is a compatibility fence against accidental old runtimes, not
 * authentication; a same-host actor who forges it is out of scope. Disabling old launch paths is the
 * separate deployment half of M2 (#1747 step 6), not tested here.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGraphClient } from '../core/graph-client.mjs';
import { compile } from '../core/graph-compiler.mjs';
import { spawnExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';
import http from 'node:http';
import { durableUpdate } from '../core/durable-update.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = process.env.GRAPH_EXECUTOR_PYTHON || path.join(ROOT, 'graph-executor', '.venv', 'bin', 'python');
const HAVE_PY = fs.existsSync(PY) && spawnSync(PY, ['-c', 'import pyoxigraph'], { stdio: 'ignore' }).status === 0;
const SKIP = HAVE_PY ? false : `UNAVAILABLE: no python with pyoxigraph at ${PY} (a skip is not a pass)`;
const T = { skip: SKIP, timeout: 120000 };

const PROTOCOL = 'postseq-v1';
const HEADER = 'x-manyhands-write-protocol';
const BK = 'urn:scrum:bookkeeping:executor';
const FLOOR_S = 'urn:ex:write-floor';
const FLOOR_P = 'urn:ex:write-floor/minProtocol';
const INSTALL = ['--install-write-floor', PROTOCOL];
const DSID = 'floor-1748';

// ── scratch stores and children: every one is tracked, stopped and removed, also when an assertion fails ──
const owned = { stores: new Set(), children: new Set() };
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `floor-${p}-`)); owned.stores.add(d); return d; };
const freshStore = (p) => { const d = tmp(p); fs.rmSync(d, { recursive: true }); return d; };   // --create wants an absent dir
const start = async (store, extra = []) => {
  const x = await spawnExecutor(['--store', store, '--port', '0', '--dataset-id', DSID, ...extra]);
  owned.children.add(x);
  return x;
};
const stop = async (x) => { await killExecutor(x); owned.children.delete(x); };   // safe on an already-exited child
after(async () => {
  for (const x of owned.children) await killExecutor(x);
  for (const d of owned.stores) fs.rmSync(d, { recursive: true, force: true });
});

let n = 0;
const opId = (tag) => `urn:ex:op/test/floor-${tag}-${process.pid}-${n++}`;

/** POST /update with full control of the headers. */
const update = async (x, sparql, { protocol, op = opId('u'), extraHeaders = {} } = {}) => {
  const headers = { 'x-op-id': op, ...extraHeaders };
  if (protocol !== undefined) headers[HEADER] = protocol;
  const r = await fetch(`${x.baseUrl}/update`, { method: 'POST', headers, body: sparql });
  return { status: r.status, body: await r.json().catch(() => null), op };
};
const query = async (x, sparql) => {
  const r = await fetch(`${x.baseUrl}/query`, { method: 'POST', headers: { 'x-op-id': opId('q') }, body: sparql });
  assert.equal(r.status, 200, `PRECONDITION: a read is served (${r.status})`);
  return (await r.json()).results.bindings;
};
const health = async (x) => (await fetch(`${x.baseUrl}/health`)).json();
const receipt = async (x, op) => (await (await fetch(`${x.baseUrl}/receipt/${encodeURIComponent(op)}`)).json()).receipt;

/** The WHOLE store, every graph, as sorted canonical lines: a count can stay equal while a value is replaced. */
const snapshot = async (x) => {
  const rows = await query(x, 'SELECT ?g ?s ?p ?o WHERE { { ?s ?p ?o } UNION { GRAPH ?g { ?s ?p ?o } } }');
  const t = (b) => (b ? `${b.type}:${b.value}:${b.datatype || ''}:${b['xml:lang'] || ''}` : '-');
  return rows.map((r) => [t(r.g), t(r.s), t(r.p), t(r.o)].join(' ')).sort();
};
const floorValues = async (x) => (await query(x, `SELECT ?v WHERE { GRAPH <${BK}> { <${FLOOR_S}> <${FLOOR_P}> ?v } }`)).map((r) => r.v.value);
const INSERT = (tag) => `INSERT DATA { <urn:ex:floor/${tag}> <urn:ex:floor/p> "v-${tag}" }`;

/** Everything a refusal must leave untouched: the full content, commitSeq, and the executor's own apply/flush counters. */
const state = async (x) => { const h = await health(x); return { snap: await snapshot(x), commitSeq: h.commitSeq, updates: h.updates, flushes: h.flushes }; };
async function assertUntouched(x, before, why) {
  const h = await health(x);
  assert.equal(h.updates, before.updates, `${why}: store.update was never called (updates counter unchanged)`);
  assert.equal(h.flushes, before.flushes, `${why}: nothing was flushed (flushes counter unchanged)`);
  assert.equal(h.commitSeq, before.commitSeq, `${why}: commitSeq did not advance`);
  assert.deepEqual(await snapshot(x), before.snap, `${why}: the store is byte-identical`);
}
async function assertRefused(x, res, before, why) {
  assert.equal(res.status, 428, `${why}: HTTP 428 (got ${res.status} ${JSON.stringify(res.body)})`);
  assert.equal(res.body?.error, 'WRITE_PROTOCOL_REQUIRED', `${why}: the refusal is named`);
  assert.equal(res.body?.applied, false, `${why}: applied:false is explicit`);
  assert.equal(res.body?.requiredProtocol, PROTOCOL, `${why}: it names the protocol it needs`);
  await assertUntouched(x, before, why);
  if (/^urn:/.test(res.op)) assert.equal(await receipt(x, res.op), null, `${why}: no receipt was recorded`);
}

/** A real intention: it writes a receipt and advances commitSeq when it applies (C1 proves both are observable). */
const rule = (tag) => ({ kind: 'rule', opId: opId(`rule-${tag}`), actor: 'urn:ex:admin', rule: { iri: `urn:ex:R/floor-${tag}-${n}` } });
/**
 * THE PINNED OLD BINARY: today's compiler, today's wire shape (x-op-id, the CURRENT epoch learned from /health, content-type),
 * and never the protocol header — independent of whatever core/graph-client.mjs later sends.
 */
const oldWire = async (x, intent) => {
  const { sparql, canonical } = compile(intent);
  const epoch = String((await health(x)).epoch);
  const r = await fetch(`${x.baseUrl}/update`, { method: 'POST', body: sparql,
    headers: { 'x-op-id': canonical.opId, 'content-type': 'application/sparql-update', 'x-epoch': epoch } });
  return { status: r.status, body: await r.json().catch(() => null), op: canonical.opId, epoch };
};

// ── controls: GREEN today ──

test('#1748 C0 CONTROL: with NO floor, an /update without the header applies — the harness writes', T, async () => {
  const x = await start(freshStore('c0'), ['--create']);
  try {
    const r = await update(x, INSERT('c0'));
    assert.equal(r.status, 200, `today's behaviour: ${JSON.stringify(r.body)}`);
    assert.equal((await query(x, 'SELECT ?o WHERE { <urn:ex:floor/c0> ?p ?o }')).length, 1, 'and the write is stored');
  } finally { await stop(x); }
});

test('#1748 C1 CONTROL: with NO floor, the pinned old wire applies a real intention — receipt written, commitSeq, updates and flushes all move', T, async () => {
  const x = await start(freshStore('c1'), ['--create']);
  try {
    const before = await state(x);
    const r = await oldWire(x, rule('c1'));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const h = await health(x);
    assert.notEqual(await receipt(x, r.op), null, 'the intention left a receipt');
    assert.notEqual(h.commitSeq, before.commitSeq, 'commitSeq advanced');
    assert.ok(h.updates > before.updates && h.flushes > before.flushes, 'the apply and flush counters moved, so "unchanged" can fail');
  } finally { await stop(x); }
});

// C2 RETIRED with #1622: it asserted the apply-then-fail bug (a non-IRI op id APPLIED the write, then failed) as the control
// that gave M2l a trigger. #1622 refuses such an op id before the store is touched (its rows R1–R4), so the control cannot
// hold any more. M2l keeps its meaning: on a floored store the PROTOCOL check comes first and answers 428 either way.

test('#1748 C3 CONTROL: an UNPROMOTED copy of a store refuses to serve (the supported restore path is promotion)', T, async () => {
  const live = freshStore('c3-live');
  let x = await start(live, ['--create']);
  await stop(x);
  const copy = tmp('c3-copy'); fs.cpSync(live, copy, { recursive: true });
  await assert.rejects(start(copy), /promote|copied|home/i, 'a writable copy at a new home is refused before serving');
});

// ── fence rows: RED until built ──

test('#1748 M2a: installing the floor records it in bookkeeping, reports it on /health, and keeps it out of the public dataset', T, async () => {
  const x = await start(freshStore('m2a'), ['--create', ...INSTALL]);
  try {
    assert.equal((await health(x)).writeFloor, PROTOCOL, '/health names the installed floor');
    assert.deepEqual(await floorValues(x), [PROTOCOL], 'exactly one floor value, in the bookkeeping graph');
    const pub = await fetch(`${x.baseUrl}/query?dataset=public`, { method: 'POST', headers: { 'x-op-id': opId('pq') }, body: `SELECT ?v WHERE { <${FLOOR_S}> <${FLOOR_P}> ?v }` });
    assert.deepEqual((await pub.json()).results.bindings, [], 'bookkeeping: not reachable through a public read');
  } finally { await stop(x); }
});

test('#1748 M2b: with the floor installed, a write WITHOUT the header is refused 428 before anything is applied or flushed', T, async () => {
  const x = await start(freshStore('m2b'), ['--create', ...INSTALL]);
  try {
    const before = await state(x);
    await assertRefused(x, await update(x, INSERT('m2b')), before, 'no header');
  } finally { await stop(x); }
});

test('#1748 M2c: an OLDER or WRONG protocol is refused the same way — distinct values ON THE WIRE (fetch trims surrounding whitespace, so none is tested)', T, async () => {
  const x = await start(freshStore('m2c'), ['--create', ...INSTALL]);
  try {
    for (const p of ['postseq-v0', 'POSTSEQ-V1', 'postseq-v1x', 'postseq-v1, postseq-v0', '']) {
      assert.equal(new Headers({ [HEADER]: p }).get(HEADER), p, `PRECONDITION: ${JSON.stringify(p)} reaches the wire unchanged`);
      const before = await state(x);
      await assertRefused(x, await update(x, INSERT(`m2c-${n}`), { protocol: p }), before, `declared ${JSON.stringify(p)}`);
    }
  } finally { await stop(x); }
});

test('#1748 M2d: the MATCHING declaration applies and is stored (the fence admits the new client)', T, async () => {
  const x = await start(freshStore('m2d'), ['--create', ...INSTALL]);
  try {
    const r = await update(x, INSERT('m2d'), { protocol: PROTOCOL });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await query(x, 'SELECT ?o WHERE { <urn:ex:floor/m2d> ?p ?o }')).length, 1, 'stored');
  } finally { await stop(x); }
});

test('#1748 M2e TAMPERING (the contract\'s negative control): even WITH the current protocol, an update that deletes or rewrites the floor is refused whole, before application', T, async () => {
  const x = await start(freshStore('m2e'), ['--create', ...INSTALL]);
  try {
    const attacks = {
      'named delete': `DELETE DATA { GRAPH <${BK}> { <${FLOOR_S}> <${FLOOR_P}> "${PROTOCOL}" } }`,
      'rewrite to an older protocol': `DELETE { GRAPH <${BK}> { <${FLOOR_S}> <${FLOOR_P}> ?v } } INSERT { GRAPH <${BK}> { <${FLOOR_S}> <${FLOOR_P}> "postseq-v0" } } WHERE { GRAPH <${BK}> { <${FLOOR_S}> <${FLOOR_P}> ?v } }`,
      // the floor's IRI never appears in these bodies, so a text match on its name cannot be the mechanism
      'wildcard wipe of the bookkeeping graph': `DELETE WHERE { GRAPH <${BK}> { ?s ?p ?o } }`,
      'CLEAR ALL': 'CLEAR ALL',
      'a second, conflicting floor value': `INSERT DATA { GRAPH <${BK}> { <${FLOOR_S}> <${FLOOR_P}> "postseq-v0" } }`,
    };
    for (const [why, sparql] of Object.entries(attacks)) {
      const before = await state(x);
      const r = await update(x, sparql, { protocol: PROTOCOL });
      assert.ok(r.status >= 400 && r.status < 500, `${why}: refused with a 4xx (got ${r.status} ${JSON.stringify(r.body)})`);
      assert.equal(r.body?.applied, false, `${why}: applied:false`);
      assert.deepEqual(await floorValues(x), [PROTOCOL], `${why}: the floor reads back unchanged`);
      await assertUntouched(x, before, `${why} (not mutate-then-restore: the apply counter must not move)`);
      assert.equal(await receipt(x, r.op), null, `${why}: no receipt`);
    }
    const after = await state(x);
    await assertRefused(x, await update(x, INSERT('m2e-after')), after, 'no header, after the tampering attempts');
  } finally { await stop(x); }
});

test('#1748 M2f: the floor SURVIVES A RESTART at the same home — a plain start without the install flag still refuses', T, async () => {
  const store = freshStore('m2f');
  let x = await start(store, ['--create', ...INSTALL]);
  await stop(x);
  x = await start(store);   // a plain start: what an old launch path would do
  try {
    assert.equal((await health(x)).writeFloor, PROTOCOL, 'still reported after restart');
    const before = await state(x);
    await assertRefused(x, await update(x, INSERT('m2f')), before, 'after restart');
  } finally { await stop(x); }
});

test('#1748 M2g: the floor SURVIVES A SUPPORTED RESTORE (copy + --promote-epoch): a fresh old binary that LEARNS the new epoch still cannot apply', T, async () => {
  const live = freshStore('m2g-live');
  let x = await start(live, ['--create', ...INSTALL]);
  const src = await health(x);
  await stop(x);
  const restore = tmp('m2g-restore'); fs.cpSync(live, restore, { recursive: true });
  x = await start(restore, ['--promote-epoch']);
  try {
    const h = await health(x);
    assert.equal(h.datasetId, src.datasetId, 'PRECONDITION: promotion keeps the dataset identity');
    assert.notEqual(String(h.epoch), String(src.epoch), 'PRECONDITION: and bumps the epoch');
    assert.equal(h.writeFloor, PROTOCOL, 'the floor came through the restore');
    const before = await state(x);
    const r = await oldWire(x, rule('m2g'));
    assert.equal(r.epoch, String(h.epoch), 'PRECONDITION: the old binary sent the CURRENT epoch, so the epoch fence alone would admit it');
    await assertRefused(x, r, before, 'promoted restore, old binary on the current epoch');
  } finally { await stop(x); }
});

test('#1748 M2h: a FRESH old binary may still READ (and learn the epoch) on a floored store — the fence is on writes only', T, async () => {
  const x = await start(freshStore('m2h'), ['--create', ...INSTALL]);
  try {
    const h = await health(x);
    assert.ok(h.epoch !== undefined && h.epoch !== null, '/health still answers with the epoch');
    await query(x, 'SELECT * WHERE { ?s ?p ?o } LIMIT 1');   // asserts 200 inside
    assert.equal((await fetch(`${x.baseUrl}/receipt/${encodeURIComponent('urn:ex:op/none')}`)).status, 200, 'receipt reconciliation stays available');
  } finally { await stop(x); }
});

test('#1748 M2i: installing the SAME floor again is a no-op; a DIFFERENT protocol on a floored store refuses to start (no downgrade by relaunch)', T, async () => {
  const store = freshStore('m2i');
  let x = await start(store, ['--create', ...INSTALL]);
  await stop(x);
  x = await start(store, INSTALL);
  try { assert.deepEqual(await floorValues(x), [PROTOCOL], 'one value, not two'); } finally { await stop(x); }
  await assert.rejects(start(store, ['--install-write-floor', 'postseq-v0']), (err) => /write.?floor|protocol/i.test(String(err.stderr || err.message)),
    'a relaunch naming an older protocol is refused at startup, naming the floor');
  x = await start(store);
  try { assert.equal((await health(x)).writeFloor, PROTOCOL, 'and the refused relaunch changed nothing'); } finally { await stop(x); }
});

test('#1748 M2j: with the floor, the PINNED OLD BINARY cannot apply a real intention — 428, no receipt, no commitSeq, no apply, no flush', T, async () => {
  const x = await start(freshStore('m2j'), ['--create', ...INSTALL]);
  try {
    const before = await state(x);
    await assertRefused(x, await oldWire(x, rule('m2j')), before, 'old binary, real intention');
  } finally { await stop(x); }
});

test('#1748 M2k: the UPDATED client sends the protocol and APPLIES on a floored store (positive: the build updates core/graph-client.mjs)', T, async () => {
  const x = await start(freshStore('m2k'), ['--create', ...INSTALL]);
  try {
    const intent = rule('m2k');
    const out = await createGraphClient({ baseUrl: x.baseUrl, expectedDatasetId: DSID }).update(intent);
    assert.equal(out.outcome, 'APPLIED', `the new client is admitted (${JSON.stringify(out).slice(0, 200)})`);
    assert.notEqual(await receipt(x, intent.opId), null, 'and its intention is receipted');
  } finally { await stop(x); }
});

test('#1748 M2l (#1622): with the floor, the apply-then-fail request (no header, a non-IRI op id) is refused 428 BEFORE anything is applied', T, async () => {
  const x = await start(freshStore('m2l'), ['--create', ...INSTALL]);
  try {
    const before = await state(x);
    const r = await update(x, INSERT('m2l'), { op: 'not an iri m2l' });
    await assertRefused(x, r, before, 'the #1622 path (C2 shows it applies without a floor)');
    assert.equal((await query(x, 'SELECT ?o WHERE { <urn:ex:floor/m2l> ?p ?o }')).length, 0, 'the data is not there');
  } finally { await stop(x); }
});

// ── r2 (the first code review, 46367): the shapes a probe cannot see, and the guards no row pinned ──

/** The floor's exact TERM(S): a rewrite to the same lexical value with a language tag or a datatype is still a rewrite. */
const floorTerms = async (x) => (await query(x, `SELECT ?v WHERE { GRAPH <${BK}> { <${FLOOR_S}> <${FLOOR_P}> ?v } }`))
  .map((r) => `${r.v.type}:${r.v.value}:${r.v.datatype || ''}:${r.v['xml:lang'] || ''}`).sort();

test('#1748 M2e2 TAMPERING the probe cannot see: data-dependent, probe-skipping, probe-raising and term-rewriting shapes are refused BEFORE application, never applied-then-restored', T, async () => {
  const x = await start(freshStore('m2e2'), ['--create', ...INSTALL]);
  try {
    const seed = await update(x, `INSERT DATA { <urn:ex:card/1> <urn:ex:floor/p> "a card" . GRAPH <urn:ex:g/data> { <urn:ex:d> <urn:ex:floor/p> "data" } }`, { protocol: PROTOCOL });
    assert.equal(seed.status, 200, `PRECONDITION: the seed applies with the protocol (${seed.status} ${JSON.stringify(seed.body)})`);
    const terms0 = await floorTerms(x);
    assert.equal(terms0.length, 1, 'PRECONDITION: exactly one floor term');
    const F = `<${FLOOR_S}> <${FLOOR_P}>`;
    const attacks = {
      // the floor's removal depends on OTHER data, so a store holding only the floor cannot show it
      'data-dependent delete': `DELETE { GRAPH <${BK}> { ${F} ?v } } WHERE { <urn:ex:card/1> ?q ?r . GRAPH <${BK}> { ${F} ?v } }`,
      'FILTER EXISTS on data': `DELETE { GRAPH <${BK}> { ${F} ?v } } WHERE { GRAPH <${BK}> { ${F} ?v } FILTER EXISTS { <urn:ex:card/1> ?q ?r } }`,
      'a second value conditioned on data': `INSERT { GRAPH <${BK}> { ${F} "postseq-v0" } } WHERE { <urn:ex:card/1> ?q ?r }`,
      // the words LOAD / SERVICE appear only in a comment or a literal: a text match must not switch the guard off
      'SERVICE in a comment': `DELETE WHERE { GRAPH <${BK}> { ${F} ?v } } # SERVICE`,
      'load in a literal': `INSERT DATA { <urn:ex:floor/t> <urn:ex:floor/p> "load test" } ; DELETE WHERE { GRAPH <${BK}> { ${F} ?v } }`,
      // a graph the probe store does not hold: the guard must not fail OPEN
      'DROP of a data graph, then delete': `DROP GRAPH <urn:ex:g/data> ; DELETE WHERE { GRAPH <${BK}> { ${F} ?v } }`,
      // same lexical value, a different TERM
      'rewrite to a language-tagged value': `DELETE { GRAPH <${BK}> { ${F} ?v } } INSERT { GRAPH <${BK}> { ${F} "${PROTOCOL}"@en } } WHERE { GRAPH <${BK}> { ${F} ?v } }`,
      'rewrite to a typed value': `DELETE { GRAPH <${BK}> { ${F} ?v } } INSERT { GRAPH <${BK}> { ${F} "${PROTOCOL}"^^<urn:ex:type> } } WHERE { GRAPH <${BK}> { ${F} ?v } }`,
    };
    for (const [why, sparql] of Object.entries(attacks)) {
      const before = await state(x);
      const r = await update(x, sparql, { protocol: PROTOCOL });
      assert.ok(r.status >= 400 && r.status < 500, `${why}: refused with a 4xx (got ${r.status} ${JSON.stringify(r.body)})`);
      assert.equal(r.body?.applied, false, `${why}: applied:false`);
      assert.deepEqual(await floorTerms(x), terms0, `${why}: the floor reads back as the SAME term`);
      await assertUntouched(x, before, `${why} (refused BEFORE application: a restore after applying moves the updates counter)`);
      assert.equal(await receipt(x, r.op), null, `${why}: no receipt`);
    }
  } finally { await stop(x); }
});

/** A raw request that can send the SAME header twice (fetch joins duplicates into one comma-separated value). */
const rawUpdate = (x, sparql, headers) => new Promise((resolve, reject) => {
  const u = new URL(`${x.baseUrl}/update`);
  const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers }, (res) => {
    let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* not JSON */ } resolve({ status: res.statusCode, body: j, op: headers['x-op-id'] }); });
  });
  req.on('error', reject); req.end(sparql);
});

test('#1748 M2m: the header sent TWICE (two lines, both the right value) is refused 428 — exactly ONE declaration', T, async () => {
  const x = await start(freshStore('m2m'), ['--create', ...INSTALL]);
  try {
    const before = await state(x);
    const r = await rawUpdate(x, INSERT('m2m'), { 'x-op-id': opId('m2m'), [HEADER]: [PROTOCOL, PROTOCOL] });
    await assertRefused(x, r, before, 'a duplicated declaration');
  } finally { await stop(x); }
});

test('#1748 M2n ORDERING: a receipted op id re-sent WITHOUT the header is refused 428, not answered from its receipt (the protocol is checked first)', T, async () => {
  const x = await start(freshStore('m2n'), ['--create', ...INSTALL]);
  try {
    // a COMPILED intention writes a receipt (C1); a raw INSERT does not
    const { sparql, canonical } = compile(rule('m2n'));
    const op = canonical.opId;
    const epoch = String((await health(x)).epoch);
    const ok = await update(x, sparql, { protocol: PROTOCOL, op, extraHeaders: { 'x-epoch': epoch, 'content-type': 'application/sparql-update' } });
    assert.equal(ok.status, 200, `PRECONDITION: applied with the protocol (${ok.status} ${JSON.stringify(ok.body)})`);
    assert.ok(await receipt(x, op), 'PRECONDITION: its receipt exists');
    const before = await state(x);
    const r = await update(x, sparql, { op, extraHeaders: { 'x-epoch': epoch, 'content-type': 'application/sparql-update' } });
    assert.equal(r.status, 428, `the replay without the header is 428 (got ${r.status} ${JSON.stringify(r.body)})`);
    assert.equal(r.body?.applied, false, 'applied:false');
    await assertUntouched(x, before, 'the replay without the header');
  } finally { await stop(x); }
});

test('#1748 M2o CLIENT: 409 WRITE_FLOOR_PROTECTED maps to REJECTED, and durableUpdate sends a refused intention EXACTLY ONCE (428 and 409 alike)', T, async () => {
  const x = await start(freshStore('m2o'), ['--create', ...INSTALL]);
  try {
    let updates = 0;
    const count = (mode) => async (url, init = {}) => {
      if (String(url).endsWith('/update')) {
        updates++;
        if (mode === '409') return new Response(JSON.stringify({ error: 'WRITE_FLOOR_PROTECTED', applied: false }), { status: 409, headers: { 'content-type': 'application/json' } });
        if (mode === 'strip') { const h = new Headers(init.headers); h.delete(HEADER); return fetch(url, { ...init, headers: h }); }
      }
      return fetch(url, init);
    };
    for (const mode of ['409', 'strip']) {
      updates = 0;
      const client = createGraphClient({ baseUrl: x.baseUrl, expectedDatasetId: DSID, fetchImpl: count(mode), label: `m2o-${mode}` });
      const before = await state(x);
      const r = await durableUpdate(client, rule(`m2o-${mode}`));
      assert.equal(r.outcome, 'REJECTED', `${mode}: a definitive REJECTED, never UNKNOWN (${JSON.stringify(r).slice(0, 200)})`);
      assert.equal(updates, 1, `${mode}: durableUpdate sent the /update exactly once (sent ${updates})`);
      await assertUntouched(x, before, `${mode}: nothing applied`);
    }
  } finally { await stop(x); }
});
