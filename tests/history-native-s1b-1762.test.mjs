/**
 * #1762 S1b — a RECORD write's history is committed in the SAME graph update as the record. The test author's independent RED
 * rows, written BLACK-BOX against the "S1b CONTRACT" on #1762 (the builder's message of 2026-10-26 ~19:02Z and its answers at
 * ~19:04Z) before the emitter exists. The builder does not write these rows; the row author does not build S1b.
 *
 * THE WORLD: as the S1 rows (history-native-s1-1762): the whole-board fixture in a real executor, REST under all six units and
 * the four executor sources, the board document off, the allocator seeded, the reference index backfilled; plus a seat token,
 * because the logborn kinds refuse an unauthenticated write (SCRUM_AUTH required). Every REST call carries ada's token, so
 * every REST-driven activity is ada's.
 *
 * THE CONTRACT (one table, so a rename is one edit): flag SCRUM_HISTORY_NATIVE=1; ONE activity per history-bearing record
 * write, part 0, IRI https://scrumboard.local/activity/op-<first 32 hex of sha256(opId)>-0, in the DEFAULT graph, typed
 * prov:Activity AND scrum:ChangeActivity, with scrum:op, scrum:entityKind, prov:used, prov:wasAssociatedWith,
 * prov:startedAtTime (xsd:dateTime, the receipt's time), scrum:part 0, scrum:recordedBy (the op IRI), scrum:versionAfter, and
 * NO card-only fact (holderAtWrite, columnBefore, columnAfter, shortId). versionAfter is the IRI scrum:unknown except where
 * the KINDS table below gives a number.
 *
 * ROWS:
 *   K0  CONTROL, flag unset: a memory, a decision, a seat declaration, a post, a delivery, a model call and a wake write NO
 *       ChangeActivity
 *   K1  memory.create   K2 memory.revise   K3 decision.create   K4 decision.relate   K5 seat.declare   K6 seat.clear
 *   K7  post.write (POST /api/conversations)   K8 delivery.create   K9 delivery.step   K10 modelcall.create
 *   K11 a wake (smallkinds entity.put, S1's collection path)
 *       each: APPLIED ⇒ exactly one activity recordedBy its op, every contract field, the IRI shape, the receipt link and time
 *   K12 R7 REDACTION, facts only: a post.redact (sent as the compiler intention with `history: true`, the interface the
 *       contract names; no REST route redacts a graph post) records op redact, the post, the actor and when; NO literal of the
 *       activity contains the post's text, before or after
 *   K13 a REPLAYED model call (same requestId) adds no activity
 *   K14 a REFUSED decision (a same-person twin within ten minutes, 409) adds no activity
 *
 * ASSUMPTIONS beyond the contract text, each named:
 *   - prov:used is the record's own subject IRI. For a memory, decision, post, delivery, model call and wake it is located
 *     here as the one typed subject whose IRI ends in the id REST returned (a delivery's, model call's and wake's id IS the
 *     IRI). A seat state node's IRI is not returned by REST; K5/K6 assert only that prov:used is the SAME node for the
 *     declare and the clear, and is a subject the declare typed.
 *   - a wake's entityKind is the projector's family string; the rows assert only that it is a non-empty literal and that
 *     the op is create (the collection path's create).
 *
 * NOT COVERED, BY NAME: post.create (a board announcement published from the outbox: in this world no claim announcement was
 * published within the run, measured 2026-10-26 ~19:04Z, so it cannot be driven black-box here; the builder's rows hold it,
 * with prov:wasAssociatedWith person/board); a REFUSED record write (each REST refusal tried here is a validation 400 that
 * and K14's twin may be refused before the compiler, so "refused ⇒ no activity" at the executor is the builder's row); the emitter sabotages
 * and the durableUpdate forgotten-path refusal (the builder's rows).
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
import { mintToken, hashToken } from '../core/credentials.mjs';
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
const PERSON = 'https://scrumboard.local/person/';
const ENTITY = 'https://scrumboard.local/entity/';
const ACT_NS = 'https://scrumboard.local/activity/';
const UNKNOWN = `${RS}unknown`;

// ── THE CONTRACT ──
const FLAG = { SCRUM_HISTORY_NATIVE: '1' };
const C = {
  ChangeActivity: `${RS}ChangeActivity`, Activity: `${PROV}Activity`,
  op: `${RS}op`, entityKind: `${RS}entityKind`, used: `${PROV}used`, actor: `${PROV}wasAssociatedWith`, at: `${PROV}startedAtTime`,
  part: `${RS}part`, recordedBy: `${RS}recordedBy`, versionAfter: `${RS}versionAfter`,
};
const CARD_ONLY = [`${RS}holderAtWrite`, `${RS}columnBefore`, `${RS}columnAfter`, `${RS}shortId`];
const activityIri = (opId, part) => `${ACT_NS}op-${crypto.createHash('sha256').update(opId).digest('hex').slice(0, 32)}-${part}`;
const RX = { outcome: 'urn:ex:outcome', commitSeq: 'urn:ex:commitSeq', at: 'urn:ex:at' };

const UNITS = { SCRUM_GRAPH_UNIT_CARDS: '1', SCRUM_GRAPH_UNIT_COLUMNS: '1', SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_UNIT_LOGBORN: '1', SCRUM_GRAPH_UNIT_SMALLKINDS: '1', SCRUM_GRAPH_UNIT_DELIVERIES: '1' };
const SOURCES = { SCRUM_GRAPH_QUERY_SOURCE: 'executor', SCRUM_GRAPH_READY_SOURCE: 'executor', SCRUM_GRAPH_CHECKS_SOURCE: 'executor', SCRUM_GRAPH_NEIGHBORS_SOURCE: 'executor' };
const ROSTER = path.join(os.tmpdir(), `hn1b-1762-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
const TOK = mintToken();
const TOKENS = path.join(os.tmpdir(), `hn1b-1762-tokens-${process.pid}.json`);
{ const at = (h) => new Date(Date.now() + h * 3600_000).toISOString(); fs.writeFileSync(TOKENS, JSON.stringify({ seats: { ada: { credentials: [{ tokenHash: hashToken(TOK), scope: 'admin', issuedAt: at(-1), expiresAt: at(24), issuedBy: 'test', revokedAt: null, note: null }] } } })); }
process.once('exit', () => { for (const f of [ROSTER, TOKENS]) { try { fs.rmSync(f, { force: true }); } catch { /* best effort */ } } });

const runNode = (args) => new Promise((resolve) => {
  const p = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  const timer = setTimeout(() => p.kill('SIGKILL'), 180000);
  p.on('close', (status) => { clearTimeout(timer); resolve({ status, out, err }); });
});

async function world(flag, body) {
  const w = await wholeBoardWorld({ env: { ...UNITS, ...SOURCES } });
  const kept = fs.readFileSync(w.boardFile);
  await w.rest.stop(); fs.writeFileSync(w.boardFile, kept);   // the harness unlinks the board file on stop
  const gc = createGraphClient({ baseUrl: w.exec.baseUrl, expectedDatasetId: WB_DATASET, timeoutMs: 30000, label: 'hn1b-1762' });
  const q = async (sparql) => { const r = await gc.query(sparql); assert.ok(r.ok, `the executor answered (${r.reason})`); return r.rows; };
  let rest = null;
  try {
    const seqs = (await q(`SELECT ?n WHERE { { ?s ?p ?n } UNION { GRAPH ?g { ?s ?p ?n } } FILTER(STRENDS(STR(?p), "/postSeq") || STRENDS(STR(?p), "#postSeq")) }`)).map((r) => Number(r.n.value)).filter(Number.isSafeInteger);
    const epoch = (/"postSeqEpoch"\s*:\s*"([^"]+)"/.exec(kept.toString('utf8')) || [])[1] || 'e-hn1b-1762';
    const ep = (await (await fetch(`${w.exec.baseUrl}/health`)).json()).epoch;
    const seed = await fetch(`${w.exec.baseUrl}/update`, { method: 'POST', headers: { 'x-op-id': `urn:ex:op/test/hn1b-1762-allocator-${process.pid}-${Date.now()}`, 'x-epoch': String(ep) }, body: `INSERT DATA { GRAPH <${BK}> { <urn:ex:postseq/allocator> a <urn:ex:postseq/Allocator> ; <urn:ex:postseq/postSeqEpoch> ${JSON.stringify(epoch)} ; <urn:ex:postseq/nextPostSeq> "${Math.max(0, ...seqs) + 1}"^^<${XSD}integer> ; <urn:ex:postseq/version> "1"^^<${XSD}integer> . } }` });
    assert.equal(seed.status, 200, `PRECONDITION: the allocator is seeded (${await seed.text()})`);
    const b = await runNode([BACKFILL, '--executor', w.exec.baseUrl, '--dataset', WB_DATASET, '--backfill']);
    assert.equal(b.status, 0, `PRECONDITION: the reference index is backfilled (exit ${b.status}: ${(b.err || b.out).slice(-300)})`);
    fs.chmodSync(w.boardFile, 0o000);
    rest = await startRestServer({ boardFile: w.boardFile, env: { SCRUM_GRAPH_DATASET_ID: WB_DATASET, SCRUM_GRAPH_EXECUTOR_URL: w.exec.baseUrl, SCRUM_ROSTER_FILE: ROSTER, ...UNITS, ...SOURCES, SCRUM_BOARD_DOCUMENT: 'off', SCRUM_SEAT_TOKENS: TOKENS, SCRUM_AUTH: 'required', ...(flag ? FLAG : {}) } });
    const call = async (method, route, payload) => {
      const headers = { authorization: `Bearer ${TOK}`, ...(payload ? { 'content-type': 'application/json' } : {}) };
      const x = await fetch(`${rest.baseUrl}${route}`, { method, headers, ...(payload ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(60000) });
      const t = await x.text(); let j = null; try { j = JSON.parse(t); } catch { /* not json */ } return { status: x.status, text: t, json: j };
    };
    await body({ q, call, gc });
  } finally {
    try { fs.chmodSync(w.boardFile, 0o644); } catch { /* absent */ }
    if (rest) await rest.stop().catch(() => {});
    try { fs.writeFileSync(w.boardFile, kept); } catch { /* going anyway */ }
    await w.stop();
  }
}

// ── reads, all from the executor ──
async function activities(q) {
  const rows = await q(`SELECT ?a ?p ?o WHERE { ?a <${RDF_TYPE}> <${C.ChangeActivity}> . ?a ?p ?o }`);
  const m = new Map();
  for (const r of rows) {
    const a = r.a.value; if (!m.has(a)) m.set(a, {});
    (m.get(a)[r.p.value] ||= []).push({ type: r.o.type, value: r.o.value, datatype: r.o.datatype ?? null });
  }
  return m;
}
const one = (node, p, label) => { const v = node[p] || []; assert.equal(v.length, 1, `${label}: exactly one ${p} (got ${JSON.stringify(v)})`); return v[0]; };
const newSince = (before, after) => [...after.entries()].filter(([a]) => !before.has(a));
/** the one TYPED subject (default graph) whose IRI ends in `/<id>` (or `#<id>`), or the IRI itself when REST returned one */
async function subjectOf(q, id) {
  if (/^https?:\/\//.test(id)) return id;
  const r = await q(`SELECT DISTINCT ?s WHERE { ?s <${RDF_TYPE}> ?t . FILTER(STRENDS(STR(?s), ${JSON.stringify(`/${id}`)}) || STRENDS(STR(?s), ${JSON.stringify(`#${id}`)})) }`);
  assert.equal(r.length, 1, `PRECONDITION: exactly one typed subject ends in ${id} (got ${r.map((x) => x.s.value)})`);
  return r[0].s.value;
}
async function receipt(q, opIri) {
  const r = await q(`SELECT ?o ?c ?at WHERE { GRAPH <${BK}> { <${opIri}> <${RX.outcome}> ?o ; <${RX.commitSeq}> ?c . OPTIONAL { <${opIri}> <${RX.at}> ?at } } }`);
  assert.equal(r.length, 1, `the op ${opIri} has exactly one receipt (got ${r.length})`);
  return { outcome: r[0].o.value, at: r[0].at?.value ?? null };
}

/** run one REST write and assert its ONE record activity; returns the activity node */
async function recordWrite(s, label, fn, want) {
  const before = await activities(s.q);
  const r = await fn();
  assert.ok(r.status >= 200 && r.status < 300, `${label}: the write succeeded (${r.status} ${r.text.slice(0, 200)})`);
  const fresh = newSince(before, await activities(s.q)).filter(([, n]) => (n[C.entityKind] || []).some((k) => want.kind == null || k.value === want.kind));
  assert.equal(fresh.length, 1, `${label}: exactly one new ${want.kind ?? 'record'} activity (got ${fresh.length})`);
  const [iri, node] = fresh[0];
  const types = (node[RDF_TYPE] || []).map((t) => t.value);
  assert.ok(types.includes(C.Activity) && types.includes(C.ChangeActivity), `${label}: typed prov:Activity AND scrum:ChangeActivity`);
  assert.equal(one(node, C.op, label).value, want.op, `${label}: scrum:op`);
  const kind = one(node, C.entityKind, label);
  if (want.kind != null) assert.equal(kind.value, want.kind, `${label}: scrum:entityKind`);
  else assert.ok(kind.type === 'literal' && kind.value.length > 0, `${label}: scrum:entityKind is a non-empty literal`);
  const used = one(node, C.used, label).value;
  if (want.used !== undefined) assert.equal(used, await want.used(r), `${label}: prov:used is the record`);
  assert.equal(one(node, C.actor, label).value, `${PERSON}${want.actor ?? 'ada'}`, `${label}: prov:wasAssociatedWith`);
  const part = one(node, C.part, label); assert.equal(part.datatype, `${XSD}integer`, `${label}: part is xsd:integer`); assert.equal(part.value, '0', `${label}: part 0`);
  const op = one(node, C.recordedBy, label).value;
  assert.match(op, /^urn:ex:op\//, `${label}: recordedBy is the op IRI`);
  assert.equal(iri, activityIri(op, 0), `${label}: the IRI is activity/op-<sha256(opId)[:32]>-0`);
  const va = one(node, C.versionAfter, label);
  if (want.versionAfter === 'unknown') assert.equal(va.value, UNKNOWN, `${label}: versionAfter is scrum:unknown`);
  else { assert.equal(va.datatype, `${XSD}integer`, `${label}: versionAfter is xsd:integer`); assert.equal(Number(va.value), await want.versionAfter(r), `${label}: versionAfter`); }
  for (const p of CARD_ONLY) assert.equal((node[p] || []).length, 0, `${label}: no card-only fact ${p}`);
  const at = one(node, C.at, label); assert.equal(at.datatype, `${XSD}dateTime`, `${label}: startedAtTime is xsd:dateTime`);
  const rc = await receipt(s.q, op);
  assert.match(rc.outcome, /APPLIED$/, `${label}: the op's receipt is APPLIED`);
  if (rc.at != null) assert.equal(Date.parse(at.value), Date.parse(rc.at), `${label}: startedAtTime is the receipt's time`);
  const byOp = [...(await activities(s.q)).values()].filter((n) => (n[C.recordedBy] || []).some((x) => x.value === op));
  assert.equal(byOp.length, 1, `${label}: APPLIED ⇒ exactly one activity recordedBy the op`);
  return { iri, node, used, r };
}

test('#1762 K0 CONTROL — flag unset: record writes leave NO ChangeActivity', T, async () => {
  await world(false, async ({ q, call }) => {
    const writes = [
      ['memory', () => call('POST', '/api/memories', { owner: 'ada', title: 'hn1b control', body: 'x' })],
      ['decision', () => call('POST', '/api/decisions', { statement: 'hn1b control', decidedBy: 'ada', constrains: ['x'], reopensIf: 'never' })],
      ['seat', () => call('PUT', '/api/seats/ada/state', { mode: 'available', acceptsRoutineWork: true, expiresAt: new Date(Date.now() + 3600_000).toISOString(), note: 'hn1b' })],
      ['post', () => call('POST', '/api/conversations', { body: 'hn1b control post', author: 'ada' })],
      ['delivery', () => call('POST', '/api/deliveries', { to: 'ada', conversation: 'p-1', source: 'fanout' })],
      ['model call', () => call('POST', '/api/model-calls', { by: 'ada', model: 'm1', promptVersion: 'v1', cost: 0, requestId: 'hn1b-control-0001' })],
      ['wake', () => call('POST', '/api/wakes', { by: 'ada', note: 'hn1b control' })],
    ];
    for (const [label, fn] of writes) { const r = await fn(); assert.ok(r.status >= 200 && r.status < 300, `the ${label} write succeeded (${r.status} ${r.text.slice(0, 200)})`); }
    assert.equal((await activities(q)).size, 0, 'no ChangeActivity anywhere with the flag unset');
  });
});

test('#1762 K1–K13 — flag on: every record write commits ONE activity with the record, and a redaction records facts only', T, async () => {
  await world(true, async (s) => {
    const { q, call, gc } = s;
    const idOf = (r) => r.json?.id ?? r.json?.['@id'];

    // K1 / K2 memory
    const k1 = await recordWrite(s, 'K1 memory.create', () => call('POST', '/api/memories', { owner: 'ada', title: 'hn1b memory', body: 'remember' }),
      { op: 'create', kind: 'memory', used: (r) => subjectOf(q, idOf(r)), versionAfter: async () => 1 });
    const mid = idOf(k1.r);
    const k2 = await recordWrite(s, 'K2 memory.revise', () => call('PATCH', `/api/memories/${mid}`, { title: 'hn1b memory, revised' }),
      { op: 'update', kind: 'memory', used: () => subjectOf(q, mid), versionAfter: async (r) => r.json.version });
    assert.equal(k2.used, k1.used, 'K2: the revision names the same memory');

    // K3 / K4 decision
    const k3 = await recordWrite(s, 'K3 decision.create', () => call('POST', '/api/decisions', { statement: 'hn1b decision', decidedBy: 'ada', constrains: ['x'], reopensIf: 'never' }),
      { op: 'create', kind: 'decision', used: (r) => subjectOf(q, idOf(r)), versionAfter: 'unknown' });
    // K14 a REFUSED record write adds nothing: a second ruling by the same person within ten minutes is a twin (409)
    const beforeTwin = (await activities(q)).size;
    const twin = await call('POST', '/api/decisions', { statement: 'hn1b decision, a twin', decidedBy: 'ada', constrains: ['x'], reopensIf: 'never' });
    assert.equal(twin.status, 409, `PRECONDITION: the twin is refused (${twin.status} ${twin.text.slice(0, 160)})`);
    assert.equal((await activities(q)).size, beforeTwin, 'K14: a refused record write adds NO activity');
    // the decision K4 relates to is another person's (a person rules once per ten minutes)
    const other = await call('POST', '/api/decisions', { statement: 'hn1b decision, superseded', decidedBy: 'board', constrains: ['x'], reopensIf: 'never' });
    assert.equal(other.status, 201, `PRECONDITION: a second decision (${other.status} ${other.text.slice(0, 160)})`);
    await recordWrite(s, 'K4 decision.relate', () => call('POST', `/api/decisions/${idOf(k3.r)}/relations`, { supersedes: [idOf(other)] }),
      { op: 'update', kind: 'decision', used: async () => k3.used, versionAfter: 'unknown' });

    // K5 / K6 seat state: the declare and the clear name the SAME node
    const k5 = await recordWrite(s, 'K5 seat.declare', () => call('PUT', '/api/seats/ada/state', { mode: 'available', acceptsRoutineWork: true, expiresAt: new Date(Date.now() + 3600_000).toISOString(), note: 'hn1b' }),
      { op: 'update', kind: 'seat-state', versionAfter: 'unknown' });
    const k6 = await recordWrite(s, 'K6 seat.clear', () => call('DELETE', '/api/seats/ada/state?by=ada'),
      { op: 'delete', kind: 'seat-state', versionAfter: 'unknown' });
    assert.equal(k6.used, k5.used, 'K6: the clear names the node the declare wrote');

    // K7 a post
    const BODY = 'hn1b post text UNIQUEBODYMARK-7f3c';
    const k7 = await recordWrite(s, 'K7 post.write', () => call('POST', '/api/conversations', { body: BODY, author: 'ada' }),
      { op: 'post', kind: 'conversation', used: async (r) => `${ENTITY}${idOf(r)}`, versionAfter: 'unknown' });
    const postId = idOf(k7.r);
    for (const [p, vs] of Object.entries(k7.node)) for (const v of vs) assert.ok(!v.value.includes('UNIQUEBODYMARK'), `K7: the post activity carries no body text (${p})`);

    // K8 / K9 delivery
    const k8 = await recordWrite(s, 'K8 delivery.create', () => call('POST', '/api/deliveries', { to: 'ada', conversation: postId, source: 'fanout' }),
      { op: 'create', kind: 'delivery', used: async (r) => idOf(r), versionAfter: 'unknown' });
    await recordWrite(s, 'K9 delivery.step', () => call('POST', `/api/deliveries/${encodeURIComponent(idOf(k8.r))}/events`, { state: 'queued', requestId: 'hn1b-delivery-step-0001' }),
      { op: 'update', kind: 'delivery', used: async () => idOf(k8.r), versionAfter: 'unknown' });

    // K10 / K13 a model call, and its replay
    const MC = { by: 'ada', model: 'm1', promptVersion: 'v1', cost: 0, requestId: 'hn1b-modelcall-0001' };
    const k10 = await recordWrite(s, 'K10 modelcall.create', () => call('POST', '/api/model-calls', MC),
      { op: 'create', kind: 'model-call', used: async (r) => idOf(r), versionAfter: 'unknown' });
    const beforeReplay = (await activities(q)).size;
    const rep = await call('POST', '/api/model-calls', MC);
    assert.ok(rep.status >= 200 && rep.status < 300, `K13: the replay answered (${rep.status})`);
    assert.equal(idOf(rep), idOf(k10.r), 'K13: the replay is the same model call');
    assert.equal((await activities(q)).size, beforeReplay, 'K13: a replayed record write adds NO activity');

    // K11 a wake (S1's collection path)
    await recordWrite(s, 'K11 wake', () => call('POST', '/api/wakes', { by: 'ada', note: 'hn1b wake' }),
      { op: 'create', kind: null, used: async (r) => idOf(r), versionAfter: 'unknown' });

    // K12 R7: a redaction records facts only
    const before12 = await activities(q);
    const red = await gc.update({ kind: 'post.redact', opId: `urn:ex:op/redact/${postId}`, actor: `${PERSON}ada`, post: { id: postId }, authorityRef: 'hn1b-authority-ref', occurredAt: new Date().toISOString(), history: true });
    assert.equal(red.outcome, 'APPLIED', `K12: the redaction applied (${JSON.stringify(red)})`);
    const fresh12 = newSince(before12, await activities(q));
    assert.equal(fresh12.length, 1, `K12: exactly one new activity (got ${fresh12.length})`);
    const [i12, n12] = fresh12[0];
    assert.equal(one(n12, C.op, 'K12').value, 'redact', 'K12: op redact');
    assert.equal(one(n12, C.entityKind, 'K12').value, 'conversation', 'K12: entityKind conversation');
    assert.equal(one(n12, C.used, 'K12').value, `${ENTITY}${postId}`, 'K12: prov:used is the post');
    assert.equal(one(n12, C.actor, 'K12').value, `${PERSON}ada`, 'K12: the actor');
    assert.equal(one(n12, C.at, 'K12').datatype, `${XSD}dateTime`, 'K12: when');
    assert.equal(i12, activityIri(`urn:ex:op/redact/${postId}`, 0), 'K12: the IRI shape');
    for (const [iri, n] of await activities(q)) for (const [p, vs] of Object.entries(n)) for (const v of vs) {
      assert.ok(!v.value.includes('UNIQUEBODYMARK'), `R7: no activity (${iri}) carries the redacted post's text (${p})`);
    }
  });
});
