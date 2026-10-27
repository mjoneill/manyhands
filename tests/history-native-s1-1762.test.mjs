/**
 * #1762 S1 — a write's HISTORY is committed in the SAME graph update as the change. The test author's independent RED rows,
 * written BLACK-BOX against the "S1 CONTRACT" on #1762 (the builder's message of 2026-10-26 ~18:33Z, also on the card), before
 * the emitter exists. The builder does not write these rows; the row author does not build S1.
 *
 * THE WORLD: the whole-board fixture (tests/helpers/whole-board-1645.mjs: cards #1–#3, #2 relatedTo/blockedBy #1, #3 in done)
 * migrated into a real executor; REST under all six units and the four executor sources, in PRODUCTION's mode: the board
 * document off (the file present and unreadable), the allocator seeded above every postSeq, the reference index backfilled.
 * Writes go through REST only; every assertion is a graph read from the executor. Nothing here imports the emitter.
 *
 * THE CONTRACT these rows assert (one table, so a rename is one edit): the flag SCRUM_HISTORY_NATIVE=1; per PART of a write,
 * in the DEFAULT graph, a node <https://scrumboard.local/activity/op-<first 32 hex of sha256(opId)>-<part>> typed prov:Activity
 * AND scrum:ChangeActivity, carrying scrum:op, scrum:entityKind, prov:used, scrum:shortId (when the entity has one),
 * prov:wasAssociatedWith, prov:startedAtTime (xsd:dateTime, the receipt's executor time), scrum:part (xsd:integer),
 * scrum:recordedBy (the write's op IRI), scrum:versionAfter (xsd:integer; on delete the last version), and on cards
 * scrum:holderAtWrite (the holder BEFORE the write applies, or scrum:none), scrum:columnAfter on every card op, and
 * scrum:columnBefore on a move or a create (create's is scrum:none).
 *
 * ROWS:
 *   C0  CONTROL, flag unset: a create writes NO ChangeActivity (today's behaviour), and the store has no ChangeActivity at all
 *   A1  create: one activity, every contract field, the IRI shape, the receipt link, the receipt's time
 *   A2  update: op update, versionAfter = the card's new version, columnAfter, NO columnBefore
 *   A3  move: op move, columnBefore and columnAfter as the move made them
 *   A4  claim / an edit by a NON-holder / release: holderAtWrite is the holder BEFORE each write (the board-lint consumer)
 *   A5  delete: op delete, versionAfter = the last version the card had
 *   A6  MULTI-PART (APPLIED ⇒ count == parts): a create that names #1 changes two cards; the op's activities are exactly the
 *       entities whose version moved, distinct parts, one each
 *   A7  REFUSED (stale ifVersion): 409, the card's version and state unchanged, and NO new activity anywhere
 *   A8  REPLAY (same requestId twice): one card, one activity
 *   A9  entity.put (a column rename): one activity, entityKind column
 *   A10 REPROJECT: a card HELD by another seat names the next #N; creating #N re-writes it (its JSON unchanged), and its
 *       part is op reproject, holderAtWrite = its holder, actor = the creator, columnAfter only, its REST version unchanged
 *   R4  commitSeq: every write above has an APPLIED receipt whose commitSeq is strictly above the previous one, and the
 *       marker's commitSeq is at or above the last; plus a STATIC partition of the compiler's exported RECORD_KINDS into
 *       S1 / S1b / not-history, so a kind added later without a home turns this file red
 *   R5  every ChangeActivity is also a prov:Activity, and its op is one of S1's ops
 *
 * SETTLED WITH THE BUILDER (2026-10-26 ~18:38Z, added to the card's S1 CONTRACT):
 *   - versionAfter is the REST-visible `version` (the card JSON's), not the graph stamp urn:ex:ver; where the JSON has none,
 *     scrum:unknown. On a delete it is the REST-visible version immediately BEFORE the delete.
 *   - a column's prov:used is the column's own subject IRI, https://scrumboard.local/column/<id>, exactly.
 *   - parts are exactly 0..n-1 over the CHANGED ENTITIES of the write; a non-entity plan part (the counter) takes none.
 *
 * NOT COVERED, BY NAME: the builder's sabotages (a genuinely invalid term; a mandatory binding removed) — those mutate the
 * emitter, which these rows do not import, and are run against the builder's branch; lost-acknowledgement replay (needs a
 * transport fault between apply and ack); the origin commit's own activity (the wiki-create route, slice-4's world) — S1
 * names it, so it gets a row once the origin emit exists; S1b's record kinds (their own rows).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HAVE_PY } from './helpers/graph-executor-proc.mjs';
import { wholeBoardWorld, WB_DATASET } from './helpers/whole-board-1645.mjs';
import { startRestServer } from './helpers/harness.mjs';
import { createGraphClient } from '../core/graph-client.mjs';
import { cardIriOf, SHORTID_COUNTER_IRI } from '../core/cards-graph.mjs';
import { RECORD_KINDS } from '../core/graph-compiler.mjs';
import { BOOKKEEPING_GRAPH } from '../core/graph-vocab.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const T = { skip: SKIP, timeout: 300000 };
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKFILL = path.join(HERE, '..', 'scripts', 'card-ref-index-1744.mjs');
const BK = BOOKKEEPING_GRAPH;
const RS = 'https://scrumboard.local/ns#';
const PROV = 'http://www.w3.org/ns/prov#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const VER = 'urn:ex:ver';
const PERSON = 'https://scrumboard.local/person/';
const ENTITY = 'https://scrumboard.local/entity/';
const ACT_NS = 'https://scrumboard.local/activity/';
const NONE = `${RS}none`;
const COLUMN = 'https://scrumboard.local/column/';
const UNKNOWN = `${RS}unknown`;

// ── THE CONTRACT ──
const FLAG = { SCRUM_HISTORY_NATIVE: '1' };
const C = {
  ChangeActivity: `${RS}ChangeActivity`, Activity: `${PROV}Activity`,
  op: `${RS}op`, entityKind: `${RS}entityKind`, used: `${PROV}used`, shortId: `${RS}shortId`, actor: `${PROV}wasAssociatedWith`,
  at: `${PROV}startedAtTime`, part: `${RS}part`, recordedBy: `${RS}recordedBy`, versionAfter: `${RS}versionAfter`,
  holderAtWrite: `${RS}holderAtWrite`, columnBefore: `${RS}columnBefore`, columnAfter: `${RS}columnAfter`,
};
const S1_OPS = ['create', 'update', 'delete', 'move', 'claim', 'release', 'reproject'];   // reproject: a card re-written only because a #N it names appeared or disappeared (its JSON unchanged), never a mutation
const activityIri = (opId, part) => `${ACT_NS}op-${crypto.createHash('sha256').update(opId).digest('hex').slice(0, 32)}-${part}`;
// receipt predicates (executor bookkeeping, read in the bookkeeping graph)
const RX = { outcome: 'urn:ex:outcome', commitSeq: 'urn:ex:commitSeq', at: 'urn:ex:at' };

// R4's partition of the compiler's own kind list: every exported kind has exactly one home
// by COMPILER kind: entity.put is S1's (columns, collections); a wake also rides entity.put, through its own branch, and its row lives in the S1b file
const S1_KINDS = ['card.write', 'entity.put'];
const S1B_KINDS = ['memory.create', 'memory.revise', 'decision.create', 'decision.relate', 'seat.declare', 'seat.clear', 'post.create', 'post.write', 'post.redact', 'delivery.create', 'delivery.step', 'modelcall.create'];
const NOT_HISTORY = ['person.import', 'post.import', 'delivery.import', 'origin.prepare', 'refusal.record'];   // migrations (the projected past), the two-phase prepare (the origin COMMIT's activity is its card.write's), and a refusal's audit record (S2: content-free, never a ChangeActivity; its rows are in refusal-record-s2-1762)

const UNITS = { SCRUM_GRAPH_UNIT_CARDS: '1', SCRUM_GRAPH_UNIT_COLUMNS: '1', SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_UNIT_LOGBORN: '1', SCRUM_GRAPH_UNIT_SMALLKINDS: '1', SCRUM_GRAPH_UNIT_DELIVERIES: '1' };
const SOURCES = { SCRUM_GRAPH_QUERY_SOURCE: 'executor', SCRUM_GRAPH_READY_SOURCE: 'executor', SCRUM_GRAPH_CHECKS_SOURCE: 'executor', SCRUM_GRAPH_NEIGHBORS_SOURCE: 'executor' };
const ROSTER = path.join(os.tmpdir(), `hn-1762-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, bea: { name: 'Bea', glyph: 'b', color: '#c47ca0' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
process.once('exit', () => { try { fs.rmSync(ROSTER, { force: true }); } catch { /* best effort */ } });

const runNode = (args) => new Promise((resolve) => {
  const p = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  const timer = setTimeout(() => p.kill('SIGKILL'), 180000);
  p.on('close', (status) => { clearTimeout(timer); resolve({ status, out, err }); });
});

/** one production-mode world; `flag` decides whether REST runs with SCRUM_HISTORY_NATIVE=1 */
async function world(flag, body) {
  const w = await wholeBoardWorld({ env: { ...UNITS, ...SOURCES } });
  const kept = fs.readFileSync(w.boardFile);
  await w.rest.stop(); fs.writeFileSync(w.boardFile, kept);   // the harness unlinks the board file on stop
  const gc = createGraphClient({ baseUrl: w.exec.baseUrl, expectedDatasetId: WB_DATASET, timeoutMs: 30000, label: 'hn-1762' });
  const q = async (sparql) => { const r = await gc.query(sparql); assert.ok(r.ok, `the executor answered (${r.reason})`); return r.rows; };
  let rest = null;
  try {
    // production's mode off: the explicit allocator above every postSeq, as the slice-3/4 rows seed it
    const seqs = (await q(`SELECT ?n WHERE { { ?s ?p ?n } UNION { GRAPH ?g { ?s ?p ?n } } FILTER(STRENDS(STR(?p), "/postSeq") || STRENDS(STR(?p), "#postSeq")) }`)).map((r) => Number(r.n.value)).filter(Number.isSafeInteger);
    const epoch = (/"postSeqEpoch"\s*:\s*"([^"]+)"/.exec(kept.toString('utf8')) || [])[1] || 'e-hn-1762';
    const ep = (await (await fetch(`${w.exec.baseUrl}/health`)).json()).epoch;
    const seed = await fetch(`${w.exec.baseUrl}/update`, { method: 'POST', headers: { 'x-op-id': `urn:ex:op/test/hn-1762-allocator-${process.pid}-${Date.now()}`, 'x-epoch': String(ep) }, body: `INSERT DATA { GRAPH <${BK}> { <urn:ex:postseq/allocator> a <urn:ex:postseq/Allocator> ; <urn:ex:postseq/postSeqEpoch> ${JSON.stringify(epoch)} ; <urn:ex:postseq/nextPostSeq> "${Math.max(0, ...seqs) + 1}"^^<${XSD}integer> ; <urn:ex:postseq/version> "1"^^<${XSD}integer> . } }` });
    assert.equal(seed.status, 200, `PRECONDITION: the allocator is seeded (${await seed.text()})`);
    const b = await runNode([BACKFILL, '--executor', w.exec.baseUrl, '--dataset', WB_DATASET, '--backfill']);
    assert.equal(b.status, 0, `PRECONDITION: the reference index is backfilled (exit ${b.status}: ${(b.err || b.out).slice(-300)})`);
    fs.chmodSync(w.boardFile, 0o000);
    rest = await startRestServer({ boardFile: w.boardFile, env: { SCRUM_GRAPH_DATASET_ID: WB_DATASET, SCRUM_GRAPH_EXECUTOR_URL: w.exec.baseUrl, SCRUM_ROSTER_FILE: ROSTER, ...UNITS, ...SOURCES, SCRUM_BOARD_DOCUMENT: 'off', ...(flag ? FLAG : {}) } });
    const call = async (method, route, payload) => {
      const x = await fetch(`${rest.baseUrl}${route}`, { method, ...(payload ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(60000) });
      const t = await x.text(); let j = null; try { j = JSON.parse(t); } catch { /* not json */ } return { status: x.status, text: t, json: j };
    };
    await body({ q, call });
  } finally {
    try { fs.chmodSync(w.boardFile, 0o644); } catch { /* absent */ }
    if (rest) await rest.stop().catch(() => {});
    try { fs.writeFileSync(w.boardFile, kept); } catch { /* going anyway */ }
    await w.stop();
  }
}

// ── reads, all from the executor ──
/** every ChangeActivity node with all of its (predicate → [values]) */
async function activities(q) {
  const rows = await q(`SELECT ?a ?p ?o WHERE { ?a <${RDF_TYPE}> <${C.ChangeActivity}> . ?a ?p ?o }`);
  const m = new Map();
  for (const r of rows) {
    const a = r.a.value; if (!m.has(a)) m.set(a, {});
    const node = m.get(a); (node[r.p.value] ||= []).push({ type: r.o.type, value: r.o.value, datatype: r.o.datatype ?? null });
  }
  return m;
}
const one = (node, p, label) => { const v = node[p] || []; assert.equal(v.length, 1, `${label}: exactly one ${p} (got ${JSON.stringify(v)})`); return v[0]; };
const none = (node, p, label) => assert.equal((node[p] || []).length, 0, `${label}: no ${p} (got ${JSON.stringify(node[p])})`);
const newSince = (before, after) => [...after.entries()].filter(([a]) => !before.has(a));
// a write may also publish a notice (a post, S1b's kind): rows count the activities FOR THE ENTITY, never all new ones
const forEntity = (fresh, iri) => fresh.filter(([, n]) => (n[C.used] || []).some((u) => u.value === iri));
const restVersion = async (call, id) => { const r = await call('GET', `/api/cards/${id}`); assert.equal(r.status, 200, `PRECONDITION: GET card ${id} (${r.status})`); return r.json.version; };
const versionOf = async (q, id) => { const r = await q(`SELECT ?v WHERE { GRAPH <${BK}> { <${cardIriOf(id)}> <${VER}> ?v } }`); return r.length === 1 ? Number(r[0].v.value) : null; };
const allVersions = async (q) => new Map((await q(`SELECT ?c ?v WHERE { ?c <${RDF_TYPE}> <${RS}Card> . GRAPH <${BK}> { ?c <${VER}> ?v } }`)).map((r) => [r.c.value, Number(r.v.value)]));
async function receipt(q, opIri) {
  const r = await q(`SELECT ?o ?c ?at WHERE { GRAPH <${BK}> { <${opIri}> <${RX.outcome}> ?o ; <${RX.commitSeq}> ?c . OPTIONAL { <${opIri}> <${RX.at}> ?at } } }`);
  assert.equal(r.length, 1, `the op ${opIri} has exactly one receipt in the bookkeeping graph (got ${r.length})`);
  return { outcome: r[0].o.value, commitSeq: Number(r[0].c.value), at: r[0].at?.value ?? null };
}
const markerCommit = async (q) => Number((await q(`SELECT ?s WHERE { GRAPH <${BK}> { <urn:ex:dataset> <${RX.commitSeq}> ?s } }`))[0]?.s.value);

/** every contract field of ONE card activity; returns { opIri, commitSeq } */
async function assertCardActivity(q, iri, node, want, label) {
  const types = (node[RDF_TYPE] || []).map((t) => t.value);
  assert.ok(types.includes(C.Activity) && types.includes(C.ChangeActivity), `${label}: typed prov:Activity AND scrum:ChangeActivity (got ${types})`);
  assert.equal(one(node, C.op, label).value, want.op, `${label}: scrum:op`);
  assert.equal(one(node, C.entityKind, label).value, 'card', `${label}: scrum:entityKind`);
  assert.equal(one(node, C.used, label).value, cardIriOf(want.id), `${label}: prov:used is the card`);
  const sid = one(node, C.shortId, label); assert.equal(sid.value, String(want.shortId), `${label}: scrum:shortId`);
  assert.ok(sid.datatype == null || sid.datatype === `${XSD}string`, `${label}: shortId is a plain string literal (datatype ${sid.datatype})`);
  assert.equal(one(node, C.actor, label).value, `${PERSON}${want.actor}`, `${label}: prov:wasAssociatedWith`);
  const part = one(node, C.part, label); assert.equal(part.datatype, `${XSD}integer`, `${label}: scrum:part is xsd:integer`);
  if (want.part !== undefined) assert.equal(Number(part.value), want.part, `${label}: scrum:part`);
  const opIri = one(node, C.recordedBy, label).value;
  assert.match(opIri, /^urn:ex:op\//, `${label}: scrum:recordedBy is the write's op IRI`);
  assert.equal(iri, activityIri(opIri, Number(part.value)), `${label}: the node IRI is activity/op-<sha256(opId)[:32]>-<part>`);
  const va = one(node, C.versionAfter, label); assert.equal(va.datatype, `${XSD}integer`, `${label}: versionAfter is xsd:integer`);
  assert.equal(Number(va.value), want.versionAfter, `${label}: scrum:versionAfter`);
  assert.equal(one(node, C.holderAtWrite, label).value, want.holder ? `${PERSON}${want.holder}` : NONE, `${label}: scrum:holderAtWrite (the holder BEFORE the write)`);
  assert.equal(one(node, C.columnAfter, label).value, want.columnAfter, `${label}: scrum:columnAfter`);
  if (want.columnBefore === undefined) none(node, C.columnBefore, label);
  else assert.equal(one(node, C.columnBefore, label).value, want.columnBefore, `${label}: scrum:columnBefore`);
  const at = one(node, C.at, label); assert.equal(at.datatype, `${XSD}dateTime`, `${label}: prov:startedAtTime is xsd:dateTime`);
  const rc = await receipt(q, opIri);
  assert.match(rc.outcome, /APPLIED$/, `${label}: the op's receipt is APPLIED`);
  if (rc.at != null) assert.equal(Date.parse(at.value), Date.parse(rc.at), `${label}: startedAtTime is the receipt's executor time`);
  for (const [p, vs] of Object.entries(node)) for (const v of vs) assert.notEqual(v.value, UNKNOWN, `${label}: ${p} is known for an ordinary REST write (scrum:unknown is for what the writer cannot know)`);
  return { opIri, commitSeq: rc.commitSeq };
}

test('#1762 R4 (static) every kind the compiler exports has exactly ONE home: S1, S1b, or not-history (a migration)', () => {
  const homes = [...S1_KINDS, ...S1B_KINDS, ...NOT_HISTORY];
  assert.equal(new Set(homes).size, homes.length, 'no kind is listed in two homes');
  const unhomed = RECORD_KINDS.filter((k) => !homes.includes(k));
  assert.deepEqual(unhomed, [], `every exported kind is placed; a NEW kind needs a home (and, if it writes history, a row): ${unhomed.join(', ')}`);
  const stale = homes.filter((k) => !RECORD_KINDS.includes(k));
  assert.deepEqual(stale, [], `no listed kind is missing from the compiler: ${stale.join(', ')}`);
});

test('#1762 C0 CONTROL — flag unset: a REST create writes NO ChangeActivity, and the store holds none', T, async () => {
  await world(false, async ({ q, call }) => {
    const r = await call('POST', '/api/cards', { title: 'hn control', description: 'x', createdBy: 'ada' });
    assert.equal(r.status, 201, `the create succeeded (${r.status} ${r.text.slice(0, 200)})`);
    assert.ok(await versionOf(q, r.json.id), 'the card is in the store (the write really happened)');
    assert.equal((await activities(q)).size, 0, 'no ChangeActivity anywhere with the flag unset');
  });
});

test('#1762 A1–A9, R4, R5 — flag on: every REST card and column write commits its activity with the change', T, async () => {
  await world(true, async ({ q, call }) => {
    const seqs = [];   // [label, commitSeq] in write order, for R4
    const step = async (label, fn) => { const before = await activities(q); const r = await fn(); const after = await activities(q); return { r, fresh: newSince(before, after), after }; };

    // A1 create
    const a1 = await step('A1', () => call('POST', '/api/cards', { title: 'hn one', description: 'first', createdBy: 'ada' }));
    assert.equal(a1.r.status, 201, `A1 create (${a1.r.status} ${a1.r.text.slice(0, 200)})`);
    const card = a1.r.json;
    a1.fresh = forEntity(a1.fresh, cardIriOf(card.id)); assert.equal(a1.fresh.length, 1, `A1: exactly one new activity for the card (got ${a1.fresh.length})`);
    const v1 = await restVersion(call, card.id); assert.ok(Number.isSafeInteger(v1), `PRECONDITION: a REST-created card has a version (${v1})`);
    seqs.push(['A1', (await assertCardActivity(q, a1.fresh[0][0], a1.fresh[0][1], { op: 'create', id: card.id, shortId: card.shortId, actor: 'ada', versionAfter: v1, part: 0, holder: null, columnBefore: NONE, columnAfter: 'backlog' }, 'A1 create')).commitSeq]);

    // A2 update
    const a2 = await step('A2', () => call('PATCH', `/api/cards/${card.id}`, { description: 'second', by: 'bea' }));
    assert.equal(a2.r.status, 200, `A2 update (${a2.r.status} ${a2.r.text.slice(0, 200)})`);
    a2.fresh = forEntity(a2.fresh, cardIriOf(card.id)); assert.equal(a2.fresh.length, 1, `A2: exactly one new activity for the card (got ${a2.fresh.length})`);
    const v2 = await restVersion(call, card.id); assert.ok(v2 > v1, 'PRECONDITION: the update moved the version');
    seqs.push(['A2', (await assertCardActivity(q, a2.fresh[0][0], a2.fresh[0][1], { op: 'update', id: card.id, shortId: card.shortId, actor: 'bea', versionAfter: v2, part: 0, holder: null, columnBefore: undefined, columnAfter: 'backlog' }, 'A2 update')).commitSeq]);

    // A3 move
    const a3 = await step('A3', () => call('PATCH', `/api/cards/${card.id}`, { column: 'in-progress', by: 'bea' }));
    assert.equal(a3.r.status, 200, `A3 move (${a3.r.status} ${a3.r.text.slice(0, 200)})`);
    a3.fresh = forEntity(a3.fresh, cardIriOf(card.id)); assert.equal(a3.fresh.length, 1, `A3: exactly one new activity for the card (got ${a3.fresh.length})`);
    const v3 = await restVersion(call, card.id);
    seqs.push(['A3', (await assertCardActivity(q, a3.fresh[0][0], a3.fresh[0][1], { op: 'move', id: card.id, shortId: card.shortId, actor: 'bea', versionAfter: v3, part: 0, holder: null, columnBefore: 'backlog', columnAfter: 'in-progress' }, 'A3 move')).commitSeq]);

    // A4 claim by ada (holder BEFORE = none) → an edit by bea while ada holds (holder = ada) → release by ada (holder = ada)
    const c4 = await step('A4 claim', () => call('POST', `/api/cards/${card.id}/claim`, { by: 'ada' }));
    assert.equal(c4.r.status, 200, `A4 claim (${c4.r.status} ${c4.r.text.slice(0, 200)})`);
    const claimActs = c4.fresh.filter(([, n]) => (n[C.used] || []).some((u) => u.value === cardIriOf(card.id)));
    assert.equal(claimActs.length, 1, `A4 claim: exactly one activity for the card (got ${claimActs.length})`);
    seqs.push(['A4 claim', (await assertCardActivity(q, claimActs[0][0], claimActs[0][1], { op: 'claim', id: card.id, shortId: card.shortId, actor: 'ada', versionAfter: await restVersion(call, card.id), part: 0, holder: null, columnBefore: undefined, columnAfter: 'in-progress' }, 'A4 claim')).commitSeq]);
    const e4 = await step('A4 edit', () => call('PATCH', `/api/cards/${card.id}`, { description: 'edited by a non-holder', by: 'bea' }));
    assert.equal(e4.r.status, 200, `A4 non-holder edit (${e4.r.status} ${e4.r.text.slice(0, 200)})`);
    e4.fresh = forEntity(e4.fresh, cardIriOf(card.id)); assert.equal(e4.fresh.length, 1, `A4 edit: exactly one new activity for the card (got ${e4.fresh.length})`);
    seqs.push(['A4 edit', (await assertCardActivity(q, e4.fresh[0][0], e4.fresh[0][1], { op: 'update', id: card.id, shortId: card.shortId, actor: 'bea', versionAfter: await restVersion(call, card.id), part: 0, holder: 'ada', columnBefore: undefined, columnAfter: 'in-progress' }, 'A4 edit while ada holds')).commitSeq]);
    const r4 = await step('A4 release', () => call('DELETE', `/api/cards/${card.id}/claim`, { by: 'ada' }));
    assert.equal(r4.r.status, 200, `A4 release (${r4.r.status} ${r4.r.text.slice(0, 200)})`);
    const relActs = r4.fresh.filter(([, n]) => (n[C.used] || []).some((u) => u.value === cardIriOf(card.id)));
    assert.equal(relActs.length, 1, `A4 release: exactly one activity for the card (got ${relActs.length})`);
    seqs.push(['A4 release', (await assertCardActivity(q, relActs[0][0], relActs[0][1], { op: 'release', id: card.id, shortId: card.shortId, actor: 'ada', versionAfter: await restVersion(call, card.id), part: 0, holder: 'ada', columnBefore: undefined, columnAfter: 'in-progress' }, 'A4 release')).commitSeq]);

    // A7 REFUSED: a stale ifVersion on card #3 changes nothing and records nothing
    // the stale value is read from REST (the version a caller sees), and is nonzero: a fixture card with no stored version
    // accepts ifVersion 0 (measured on main 2026-10-26), which would make this row's refusal a precondition failure
    const seen = (await call('GET', '/api/cards/uuid-3')).json?.version ?? 0;
    const v3before = await versionOf(q, 'uuid-3');
    const a7 = await step('A7', () => call('PATCH', '/api/cards/uuid-3', { title: 'should not land', ifVersion: seen + 7, by: 'bea' }));
    assert.equal(a7.r.status, 409, `A7: a stale ifVersion is refused (${a7.r.status} ${a7.r.text.slice(0, 200)})`);
    assert.equal(await versionOf(q, 'uuid-3'), v3before, 'A7: the card version did not move');
    // a board announcement (a claim's, published from the outbox) may land in this window as its own post activity (S1b);
    // the refusal must add NO card or column activity, and none for the refused card
    const a7cards = a7.fresh.filter(([, n]) => (n[C.entityKind] || []).some((k) => k.value === 'card' || k.value === 'column'));
    assert.equal(a7cards.length, 0, `A7: NO new card or column activity (got ${a7cards.length}; all new: ${a7.fresh.map(([, n]) => `${(n[C.op] || [])[0]?.value}/${(n[C.entityKind] || [])[0]?.value}`).join(', ')})`);
    assert.equal(forEntity(a7.fresh, cardIriOf('uuid-3')).length, 0, 'A7: no activity for the refused card');

    // A8 REPLAY: the same requestId twice is one card and one activity
    const req = `hn-1762-replay-${process.pid}`;
    const a8a = await call('POST', '/api/cards', { title: 'hn replay', description: 'once', createdBy: 'ada', requestId: req });
    assert.equal(a8a.status, 201, `A8 first create (${a8a.status} ${a8a.text.slice(0, 200)})`);
    const a8b = await call('POST', '/api/cards', { title: 'hn replay', description: 'once', createdBy: 'ada', requestId: req });
    assert.ok(a8b.status === 200 || a8b.status === 201, `A8 replay answered (${a8b.status})`);
    assert.equal(a8b.json?.id, a8a.json.id, 'A8: the replay returned the same card');
    const a8acts = [...(await activities(q)).values()].filter((n) => (n[C.used] || []).some((u) => u.value === cardIriOf(a8a.json.id)));
    assert.equal(a8acts.length, 1, `A8: one activity for the replayed create (got ${a8acts.length})`);

    // A6 MULTI-PART: a create naming #1 also writes #1's mirror edge; the op's activities are exactly the changed entities
    const verBefore = await allVersions(q);
    const a6 = await step('A6', () => call('POST', '/api/cards', { title: 'hn multi', description: 'names one', createdBy: 'ada', relationships: { relatedTo: [1] } }));
    assert.equal(a6.r.status, 201, `A6 create (${a6.r.status} ${a6.r.text.slice(0, 200)})`);
    const verAfter = await allVersions(q);
    const changed = [...verAfter.entries()].filter(([c, v]) => verBefore.get(c) !== v).map(([c]) => c).sort();
    assert.ok(changed.length >= 2 && changed.includes(cardIriOf('uuid-1')), `PRECONDITION: the write changed the new card AND #1 (changed ${changed})`);
    const newCardActs = a6.fresh.filter(([, n]) => (n[C.used] || []).some((u) => u.value === cardIriOf(a6.r.json.id)));
    assert.equal(newCardActs.length, 1, 'A6: one activity for the new card');
    const op6 = one(newCardActs[0][1], C.recordedBy, 'A6').value;
    const byOp = [...(await activities(q)).entries()].filter(([, n]) => (n[C.recordedBy] || []).some((r) => r.value === op6));
    const used = byOp.map(([, n]) => one(n, C.used, 'A6 part').value).sort();
    assert.deepEqual(used, changed, 'A6: APPLIED ⇒ the op recorded exactly one activity per changed entity, and nothing else');
    const parts = byOp.map(([, n]) => Number(one(n, C.part, 'A6 part').value));
    assert.deepEqual([...parts].sort((x, y) => x - y), changed.map((_, i) => i), `A6: the parts are exactly 0..n-1 over the changed entities (${parts})`);
    for (const [iri, n] of byOp) assert.equal(iri, activityIri(op6, Number(one(n, C.part, 'A6').value)), 'A6: each part has its own IRI');
    const mirror = byOp.find(([, n]) => one(n, C.used, 'A6').value === cardIriOf('uuid-1'));
    assert.equal(one(mirror[1], C.op, 'A6 mirror').value, 'update', 'A6: the mirrored card\'s part is an update');
    seqs.push(['A6', (await receipt(q, op6)).commitSeq]);

    // A9 entity.put: a column rename
    const a9 = await step('A9', () => call('PATCH', '/api/columns/planned', { name: 'Planned (renamed)', by: 'bea' }));
    assert.equal(a9.r.status, 200, `A9 column rename (${a9.r.status} ${a9.r.text.slice(0, 200)})`);
    a9.fresh = a9.fresh.filter(([, n]) => (n[C.entityKind] || []).some((k) => k.value === 'column')); assert.equal(a9.fresh.length, 1, `A9: exactly one new column activity (got ${a9.fresh.length})`);
    const [i9, n9] = a9.fresh[0];
    assert.equal(one(n9, C.entityKind, 'A9').value, 'column', 'A9: entityKind column');
    assert.equal(one(n9, C.used, 'A9').value, `${COLUMN}planned`, 'A9: prov:used is the column\'s own subject IRI');
    assert.equal(one(n9, C.op, 'A9').value, 'update', 'A9: op update');
    assert.equal(one(n9, C.actor, 'A9').value, `${PERSON}bea`, 'A9: the actor');
    none(n9, C.holderAtWrite, 'A9 (a column has no holder)'); none(n9, C.columnAfter, 'A9 (card-only field)');
    const op9 = one(n9, C.recordedBy, 'A9').value;
    assert.equal(i9, activityIri(op9, Number(one(n9, C.part, 'A9').value)), 'A9: the IRI shape');
    seqs.push(['A9', (await receipt(q, op9)).commitSeq]);

    // A10 REPROJECT: card #3 (held by bea) names the NEXT shortId; the create that mints it re-writes #3 with its JSON unchanged
    const next = Number((await q(`SELECT ?n WHERE { GRAPH <${BK}> { <${SHORTID_COUNTER_IRI}> <${VER}> ?n } }`))[0]?.n.value);
    assert.ok(Number.isSafeInteger(next), `PRECONDITION: the shortId counter reads (${next})`);
    const named = await call('PATCH', '/api/cards/uuid-3', { description: `waits on #${next}`, by: 'bea' });
    assert.equal(named.status, 200, `PRECONDITION: #3 names #${next} (${named.status} ${named.text.slice(0, 200)})`);
    const held = await call('POST', '/api/cards/uuid-3/claim', { by: 'bea' });
    assert.equal(held.status, 200, `PRECONDITION: bea holds #3 (${held.status} ${held.text.slice(0, 200)})`);
    const v3rest = await restVersion(call, 'uuid-3');
    const a10 = await step('A10', () => call('POST', '/api/cards', { title: 'hn named', description: 'the card #3 was waiting on', createdBy: 'ada' }));
    assert.equal(a10.r.status, 201, `A10 create (${a10.r.status} ${a10.r.text.slice(0, 200)})`);
    assert.equal(a10.r.json.shortId, next, `PRECONDITION: the create minted #${next}`);
    const re = forEntity(a10.fresh, cardIriOf('uuid-3'));
    assert.equal(re.length, 1, `A10: #3 has exactly one activity in the create's write (got ${re.length})`);
    const [, rn] = re[0];
    assert.equal(one(rn, C.op, 'A10').value, 'reproject', 'A10: a re-written namer is op reproject, never update');
    assert.equal(one(rn, C.holderAtWrite, 'A10').value, `${PERSON}bea`, 'A10: holderAtWrite is the holder as it stood');
    assert.equal(one(rn, C.actor, 'A10').value, `${PERSON}ada`, 'A10: the actor is the creator');
    assert.equal(one(rn, C.columnAfter, 'A10').value, 'done', 'A10: columnAfter');
    none(rn, C.columnBefore, 'A10');
    assert.equal(Number(one(rn, C.versionAfter, 'A10').value), v3rest, 'A10: the REST version did not move');
    assert.equal(await restVersion(call, 'uuid-3'), v3rest, 'A10: #3 really is unchanged for a reader');
    const createOp = one(forEntity(a10.fresh, cardIriOf(a10.r.json.id))[0][1], C.recordedBy, 'A10 create').value;
    assert.equal(one(rn, C.recordedBy, 'A10').value, createOp, 'A10: the reproject part rides the create\'s own op');
    seqs.push(['A10', (await receipt(q, createOp)).commitSeq]);

    // A5 delete (last, so the card is not needed after)
    const vLast = await restVersion(call, card.id);   // the REST-visible version immediately BEFORE the delete
    // the plain card DELETE takes its declared deleter from the QUERY string, not a body (#675: a DELETE has no body)
    const a5 = await step('A5', () => call('DELETE', `/api/cards/${card.id}?by=bea`));
    assert.ok(a5.r.status === 200 || a5.r.status === 204, `A5 delete (${a5.r.status} ${a5.r.text.slice(0, 200)})`);
    assert.equal(await versionOf(q, card.id), null, 'PRECONDITION: the card is gone');
    const delActs = a5.fresh.filter(([, n]) => (n[C.used] || []).some((u) => u.value === cardIriOf(card.id)));
    assert.equal(delActs.length, 1, `A5: exactly one activity for the deleted card (got ${delActs.length})`);
    seqs.push(['A5', (await assertCardActivity(q, delActs[0][0], delActs[0][1], { op: 'delete', id: card.id, shortId: card.shortId, actor: 'bea', versionAfter: vLast, part: 0, holder: null, columnBefore: undefined, columnAfter: 'in-progress' }, 'A5 delete')).commitSeq]);

    // R4: every write moved commitSeq, in order, and the marker is at or past the last
    for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i][1] > seqs[i - 1][1], `R4: ${seqs[i][0]}'s commitSeq ${seqs[i][1]} is above ${seqs[i - 1][0]}'s ${seqs[i - 1][1]}`);
    assert.ok(await markerCommit(q) >= seqs.at(-1)[1], 'R4: the marker\'s commitSeq is at or past the last write');

    // R5: every ChangeActivity is also a prov:Activity; every CARD or COLUMN activity (S1's emit) has an S1 op. Record
    // activities (S1b's kinds, e.g. a board announcement's post) are held to their own ops by the S1b rows.
    let s1acts = 0;
    for (const [iri, n] of await activities(q)) {
      assert.ok((n[RDF_TYPE] || []).some((t) => t.value === C.Activity), `R5: ${iri} is also a prov:Activity`);
      const kind = one(n, C.entityKind, `R5 ${iri}`).value;
      if (kind !== 'card' && kind !== 'column') continue;
      s1acts += 1;
      assert.ok(S1_OPS.includes(one(n, C.op, `R5 ${iri}`).value), `R5: ${iri}'s op is an S1 op (${one(n, C.op, 'R5').value}/${kind})`);
    }
    assert.ok(s1acts >= 10, `R5 CONTROL: the scope still covers this file's card and column activities (${s1acts})`);
  });
});
