/**
 * #1629 slice 2 — `origin.prepare` plus ONE origin-bearing `card.write` commit (O1 / PR1 / T1, primitive half only). TEST AUTHOR's rows,
 * written before any build, against the frozen text: r3 on #1629 (v106) with the contract owner's v98/v99 and v104 dispositions (Q4 option (a)) and the
 * measured Q5 ON case (commons 44276/44278). Black-box over:
 *   core/origin-commit.mjs   readPreparedOrigin, readCommittedOrigin, enumerateOriginRecords, originKeyOf, mutationIdOf
 *   core/graph-vocab.mjs     ORIGIN_TERMS (every name under urn:ex:origin/)
 *   the EXISTING graph client (createGraphClient(...).update) carrying the new record kind and the new card.write member, against a REAL
 *   executor on a throwaway store. The slice-1 allocator is seeded by hand into the bookkeeping graph, exactly as slice 1's rows do.
 *
 * API ASSUMPTIONS these rows make where r3 leaves a key unnamed (each is a FREEZE QUESTION, not a guess the build must honour silently):
 *   - readPreparedOrigin's `prepared` object exposes the stored fields under their predicate names (prepared.occurredAt, .descriptorDigest, ...)
 *     and occurredAt as the STORED lexical string;
 *   - readCommittedOrigin's `committed.origin` exposes committedAt; `committed.obligations[i]` exposes slot/index/status/mode/obligationId;
 *     `committed.reservations[i]` is slice 1's readPostSeqReservation `reservation` object.
 *
 *   I1   identity: originKeyOf is JSON.stringify(["origin-v1", route, subject, requestKey, originActor]); mutationIdOf is UUIDv5 under the frozen
 *        namespace (checked against an INDEPENDENT UUIDv5 written here); collision controls of r3 §1
 *   I2   closed shapes refused at canonicalization (no write): unknown descriptor key, occurredAt IN the prepare descriptor, a caller digest,
 *        a supplied mutationId that differs from the recomputed one, a bad slot, origin together with pending, non-empty people/evidence,
 *        a card-route plan with two card parts, a create part, a remove part, or subject ≠ provenance.cardId
 *   P1   prepare writes ONE Prepared node and nothing else: enumerateOriginRecords lists exactly it; the allocator and the card are unchanged
 *   P2   prepare replay: same op + same content → APPLIED (the original receipt); same op + changed descriptor → REJECTED intent-collision,
 *        the stored Prepared unchanged
 *   C1   the commit (card route): business change, Origin, N obligations, N reservations, allocator +N, committedBy — all present together;
 *        readCommittedOrigin ok; the APPLIED receipt digest = digestOf(canonicalize(the commit intention)); every reserveDigest equals it;
 *        reserveOpId is the commit op and never carries the postseq/reserve prefix; drafts carry the PREPARED occurredAt
 *   C2   replay of the commit op: APPLIED (original receipt), allocator unchanged, nothing duplicated
 *   G*   one failed guard per family — version, prepared-match (absent), origin-absence, reservation-absence, allocator — each:
 *        PRECONDITION_FAILED, the refusal receipt's digest is this intention's, the WHOLE bookkeeping graph except receipts and commitSeq
 *        unchanged (card and agent versions and entityJson, Origin, Obligations, reservations, allocator, the prepared link) and the card's
 *        domain triples unchanged; a replay changes none of that AND leaves commitSeq where the refusal put it
 *   Q4a  a fresh commit whose origin.occurredAt differs from the stored one: PRECONDITION_FAILED, no gated effect — two SEPARATE fresh
 *        origins (lexical form; instant), never two intentions under one already-receipted op
 *   Q4b  the same commit op re-sent with a changed occurredAt after an APPLIED commit: REJECTED intent-collision, nothing allocated
 *   AD*  commit admission (§2a.9 + v99 clarification 1): stored descriptorJson changed while its digest is left matching; planJson missing;
 *        occurredAt duplicated; originActor ≠ the actor — each refused before every gated effect AND read INVALID by readPreparedOrigin
 *   TM*  readback tamper (§2a.8): nine stored-state mutations after an APPLIED commit, each read INVALID, never ok; TM9 first PROVES its
 *        forge hit the receipt and both reservations together and left no triple with the real digest
 *   T1   prepare A, prepare B, commit B, commit A: postSeq(B) < postSeq(A); occurredAt values unchanged; each createdAt = its own committedAt
 *   O2   agent route: cards GENUINELY claimed in the graph, the agent seeded at v1, released in one commit with the agent entity (its real
 *        projection); g1 ISOLATED (an agent releasing everything it holds plus one card it does not hold) with its control; g2 (a held card
 *        left out, every released card held); g3 (a released card's new quads keep claimedBy — refused at compile, nothing sent); a clean
 *        control that also reads the agent's projected state
 *   B1   byte-identical controls: card.write WITHOUT origin compiles to the same SPARQL as at 429e487 (golden captured from main), and so does
 *        postseq.reserve
 *   PR1  prepare, kill the executor, restart on the same store: one Prepared record only, the allocator tuple byte-identical, the card unchanged,
 *        readPreparedOrigin returns the same digests
 *
 * NOT covered, by name: route wiring, REST/HTTP outcomes, the document leg of O1, GET /outbox visibility, generated keys and key delivery,
 * UNKNOWN delivery, the cards-unit-OFF refusal (a WIRING row, 44280/44283), publication, migration, M2's floor, restore (B1 of the contract),
 * L1 timing (E is printed, never asserted). The live probe of 44276 is separate evidence and is not repeated here.
 * Satisfiability: NOT shown — no build exists, so these rows have not been seen GREEN; slice 1's S1 lesson applies (a row nobody has made pass
 * may encode a contract question, which goes back to the owner, never into a silently weakened row).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';
import { createGraphClient } from '../core/graph-client.mjs';
import { canonicalize, digestOf, compile } from '../core/graph-compiler.mjs';
import { cardQuads, priorQuads, cardIriOf } from '../core/cards-graph.mjs';
import { announcePostId } from '../core/announce-outbox.mjs';
import { readPostSeqAllocator, canonAnnouncementDraft } from '../core/postseq-reserve.mjs';
import { entityQuads } from '../core/collections-unit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let M = null, modErr = null, V = null, vocabErr = null;
try { M = await import(pathToFileURL(path.join(HERE, '..', 'core', 'origin-commit.mjs')).href); } catch (e) { modErr = e; }
try { V = (await import(pathToFileURL(path.join(HERE, '..', 'core', 'graph-vocab.mjs')).href)).ORIGIN_TERMS ?? null; } catch (e) { vocabErr = e; }
const need = () => {
  assert.ok(M, `core/origin-commit.mjs does not exist yet (${modErr?.message?.slice(0, 120)})`);
  assert.ok(V, `core/graph-vocab.mjs does not export ORIGIN_TERMS yet (${vocabErr?.message?.slice(0, 120) ?? 'absent'})`);
};

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const T = { skip: SKIP, timeout: 300000 };
const DSID = 'og1629';
const BK = 'urn:scrum:bookkeeping:executor';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const NAMESPACE = 'cd807138-eefc-40d2-9a80-525e666e6269';   // r3 §1, frozen 2026-10-20T03:46:33Z
const OI = (name) => `urn:ex:origin/${name}`;                 // r3 §2: every origin term is urn:ex:origin/<name>
const PS = (name) => `urn:ex:postseq/${name}`;
const ACTOR_SEAT = 'ada';
const ACTOR = `https://scrumboard.local/person/${ACTOR_SEAT}`;
const AGENT_ID = (seat) => `https://scrumboard.local/agent/${encodeURIComponent(seat)}`;   // server.js:5003 at 429e487
const EPOCH = 'e-1629-s2';

/** An INDEPENDENT RFC 4122 v5 (sha-1) — the rows must not test the build's derivation with the build's own function. */
function uuidv5(name, ns) {
  const nsBytes = Buffer.from(ns.replace(/-/g, ''), 'hex');
  const h = crypto.createHash('sha1').update(Buffer.concat([nsBytes, Buffer.from(name, 'utf8')])).digest();
  h[6] = (h[6] & 0x0f) | 0x50; h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}
const keyJson = (route, subject, requestKey, originActor) => JSON.stringify(['origin-v1', route, subject, requestKey, originActor]);
const midOf = (route, subject, requestKey, originActor = ACTOR_SEAT) => uuidv5(keyJson(route, subject, requestKey, originActor), NAMESPACE);
const prepareOp = (mid) => `urn:ex:op/origin/prepare/${mid}`;
const commitOp = (mid) => `urn:ex:op/origin/commit/${mid}`;

// ── fixtures ──
const card = (id, shortId, extra = {}) => ({ id, shortId, title: `card ${shortId}`, description: 'body', column: 'backlog', createdAt: '2026-10-20T06:00:00.000Z', createdBy: 'ada', version: 1, ...extra });
const cpart = (c, expectedVersion, prior = null) => ({ iri: cardIriOf(c.id), expectedVersion, version: c.version, quads: cardQuads(c, new Map()), ...(prior ? { prior: priorQuads(prior, new Map()) } : {}), json: JSON.stringify(c) });
const slots = (n = 2) => Array.from({ length: n }, (_, i) => ({ slot: i === 0 ? 'claim' : `extra-${i}`, author: 'board', body: `announce ${i}`, mentions: ['ada'], notify: true }));

/** A card-route descriptor + plan: claim card `c` (v1 → v2), announcing `n` slots. */
function claimOrigin(c, requestKey, n = 2) {
  const mid = midOf('claim', c.id, requestKey);
  const after = { ...c, version: 2, claimedBy: ACTOR_SEAT };
  const descriptor = { route: 'claim', subject: c.id, requestKey, originActor: ACTOR_SEAT, mutationId: mid, provenance: { cardId: c.id, version: 2 }, slots: slots(n) };
  const plan = { parts: [cpart(after, '1', c)] };
  return { mid, descriptor, plan, after };
}
const prepareIntention = (o) => ({ kind: 'origin.prepare', opId: prepareOp(o.mid), actor: ACTOR, origin: o.descriptor, plan: o.plan });
const commitIntention = (o, occurredAt, extra = {}) => ({ kind: 'card.write', opId: commitOp(o.mid), actor: ACTOR, ...o.plan, origin: { ...o.descriptor, occurredAt }, ...extra });

// ── world ──
const lit = (v) => (typeof v === 'number' ? `"${v}"^^<${XSD}integer>` : JSON.stringify(String(v)));
const allocatorTriples = ({ next = 100, version = 1 } = {}) =>
  `<${PS('allocator')}> a <${PS('Allocator')}> ; <${PS('postSeqEpoch')}> ${lit(EPOCH)} ; <${PS('nextPostSeq')}> ${lit(next)} ; <${PS('version')}> ${lit(version)} .`;
let seedN = 0;
async function rawUpdate(exec, sparql, label = 'seed') {
  const r = await fetch(`${exec.baseUrl}/update`, { method: 'POST', headers: { 'x-op-id': `urn:ex:op/test/og1629-${label}-${process.pid}-${seedN++}` }, body: sparql });
  assert.equal(r.status, 200, `PRECONDITION: the test's own ${label} update was written (${await r.text()})`);
}
const STORES = [];
after(() => { for (const d of STORES) fs.rmSync(d, { recursive: true, force: true }); });
async function world(body, { allocator = true, cards = [] } = {}) {
  need();
  const store = tmpStore('og1629-'); STORES.push(store); fs.rmSync(store, { recursive: true });
  let exec = await startExecutor({ store, datasetId: DSID, create: true });
  const ctx = { store, exec: () => exec, client: null };
  const connect = () => { ctx.client = createGraphClient({ baseUrl: exec.baseUrl, expectedDatasetId: DSID, timeoutMs: 30000, label: 'origin-1629-rows' }); };
  ctx.restart = async () => { await killExecutor(exec); exec = await startExecutor({ store, datasetId: DSID }); connect(); };
  try {
    connect();
    if (allocator) await rawUpdate(exec, `INSERT DATA { GRAPH <${BK}> { ${allocatorTriples()} } }`, 'allocator');
    for (const c of cards) {
      const r = await ctx.client.update({ kind: 'card.write', opId: `urn:ex:op/card/og1629-seed-${process.pid}-${seedN++}`, actor: ACTOR, parts: [cpart(c, null)] });
      assert.equal(r.outcome, 'APPLIED', `PRECONDITION: fixture card ${c.id} created (${JSON.stringify(r)})`);
    }
    await body(ctx);
  } finally { await killExecutor(exec); }
}
const rows = async (client, sparql) => { const q = await client.query(sparql); assert.ok(q.ok, `query answered (${q.reason})`); return q.rows; };
const allocatorTuple = async (client) => JSON.stringify(await readPostSeqAllocator(client));
const cardDomain = async (client, id) => (await rows(client, `SELECT ?p ?o WHERE { <${cardIriOf(id)}> ?p ?o }`)).map((r) => `${r.p.value} ${r.o.value}`).sort();
/** Every subject in the bookkeeping graph under urn:ex:origin/ or urn:ex:postseq/reservation/ (used by P1). */
const gatedState = async (client) => (await rows(client, `SELECT ?s ?p ?o WHERE { GRAPH <${BK}> { ?s ?p ?o FILTER(STRSTARTS(STR(?s), "urn:ex:origin/") || STRSTARTS(STR(?s), "urn:ex:postseq/reservation/")) } }`))
  .map((r) => `${r.s.value} ${r.p.value} ${r.o.value}`).sort();
/** The WHOLE bookkeeping graph except receipts (subjects under urn:ex:op/) and the triples carrying commitSeq: card and agent versions and
 *  entityJson, the allocator, origin, obligation and reservation nodes, the prepared link (review 44433: refusal snapshots include the card
 *  and agent bookkeeping, not only the origin families). */
// a FULL RDF term (kind, lexical value, datatype, language), so a snapshot sees "1" vs "1"^^xsd:integer, or a lost language tag (review 44439)
const term = (t) => JSON.stringify([t?.type ?? null, t?.value ?? null, t?.datatype ?? null, t?.['xml:lang'] ?? null]);
const bkState = async (client) => (await rows(client, `SELECT ?s ?p ?o WHERE { GRAPH <${BK}> { ?s ?p ?o FILTER(!STRSTARTS(STR(?s), "urn:ex:op/") && STR(?p) != "urn:ex:commitSeq") } }`))
  .map((r) => `${term(r.s)} ${term(r.p)} ${term(r.o)}`).sort();
// the store's own sequence lives on <urn:ex:dataset> (every receipt also carries its own commitSeq; those are excluded); an empty read would
// make the replay check trivially equal, so the value must be present (measured: a refusal moved it 1 → 2, its replay left it at 2)
const commitSeq = async (client) => {
  const v = (await rows(client, `SELECT ?v WHERE { GRAPH <${BK}> { <urn:ex:dataset> <urn:ex:commitSeq> ?v } }`)).map((r) => r.v.value);
  assert.equal(v.length, 1, `PRECONDITION: the store has exactly one commitSeq (${JSON.stringify(v)})`);
  return v[0];
};
const domainOf = async (client, iri) => (await rows(client, `SELECT ?p ?o WHERE { <${iri}> ?p ?o }`)).map((r) => `${term(r.p)} ${term(r.o)}`).sort();
async function snapshot(client, cardIds, extraIris = []) {
  const out = { bk: await bkState(client) };
  for (const id of cardIds) out[`card:${id}`] = await domainOf(client, cardIriOf(id));   // full terms; cardDomain (values) is for readable checks
  for (const iri of extraIris) out[iri] = await domainOf(client, iri);
  return out;
}
async function prepared(client, o) {
  const r = await client.update(prepareIntention(o));
  assert.equal(r.outcome, 'APPLIED', `PRECONDITION: prepare APPLIED (${JSON.stringify(r)})`);
  const p = await M.readPreparedOrigin(client, o.mid);
  assert.equal(p.ok, true, `PRECONDITION: the Prepared record reads ok (${JSON.stringify(p)})`);
  assert.ok(p.prepared && typeof p.prepared.occurredAt === 'string', `PRECONDITION (API assumption): prepared.occurredAt is the stored lexical string (${JSON.stringify(p.prepared)})`);
  return p.prepared;
}
/** Assert a refused commit: PRECONDITION_FAILED, the receipt's digest is this intention's, no gated family moved; a replay moves nothing either. */
async function refusedWithNoEffect(client, intention, cardIds, label, extraIris = []) {
  const before = await snapshot(client, cardIds, extraIris);
  const r = await client.update(intention);
  assert.equal(r.outcome, 'PRECONDITION_FAILED', `${label}: refused (${JSON.stringify(r).slice(0, 300)})`);
  const want = digestOf(canonicalize(intention));
  const stored = r.receipt?.digest?.[0]?.value ?? r.digest;
  assert.equal(stored, want, `${label}: the refusal receipt is THIS intention's digest`);
  assert.deepEqual(await snapshot(client, cardIds, extraIris), before, `${label}: every gated family is unchanged`);
  const seqAfterRefusal = await commitSeq(client);   // the refusal itself may advance commitSeq (r3 §4 "Receipts"); its replay must not
  const again = await client.update(intention);
  assert.equal(again.outcome, 'PRECONDITION_FAILED', `${label}: the replay returns the same refusal`);
  assert.deepEqual(await snapshot(client, cardIds, extraIris), before, `${label}: and the replay changed no gated family`);
  assert.equal(await commitSeq(client), seqAfterRefusal, `${label}: and the replay left commitSeq unchanged`);
}

// ── I1 identity ──
test('#1629 s2 (I1) originKeyOf is the closed JSON tuple; mutationIdOf is UUIDv5 under the frozen namespace; the r3 §1 collision controls hold', () => {
  need();
  assert.equal(M.originKeyOf('claim', 'c1', 'k1', 'ada'), keyJson('claim', 'c1', 'k1', 'ada'), 'the key is the JSON array, byte-exact');
  assert.equal(M.mutationIdOf(keyJson('claim', 'c1', 'k1', 'ada')), uuidv5(keyJson('claim', 'c1', 'k1', 'ada'), NAMESPACE), 'UUIDv5 of the key under cd807138-…');
  const ids = (a) => M.mutationIdOf(M.originKeyOf(...a));
  assert.notEqual(ids(['claim', 'a/b', 'c', 'ada']), ids(['claim', 'a', 'b/c', 'ada']), 'a/b+c and a+b/c differ (no slash concatenation)');
  assert.notEqual(ids(['claim', 'a%2Fb', 'k', 'ada']), ids(['claim', 'a/b', 'k', 'ada']), '%2F and / differ (no decoding)');
  assert.notEqual(ids(['claim', 'café', 'k', 'ada']), ids(['claim', 'café', 'k', 'ada']), 'NFC and NFD differ (no normalization)');
  for (const p of ['__proto__', 'constructor', 'toString']) assert.equal(M.originKeyOf('claim', p, p, p), keyJson('claim', p, p, p), `${p} is accepted as a plain string`);
  assert.throws(() => M.originKeyOf('claim', '', 'k', 'ada'), /./, 'an empty subject is refused');
  assert.throws(() => M.originKeyOf('claim', 'c\ud800', 'k', 'ada'), /./, 'a lone surrogate is refused');
  assert.throws(() => M.originKeyOf('teleport', 'c', 'k', 'ada'), /./, 'a route outside the closed set is refused');
});

// ── V vocabulary ──
test('#1629 s2 (V) ORIGIN_TERMS names every r3 §2 term under urn:ex:origin/', () => {
  need();
  for (const name of ['Prepared', 'Origin', 'Obligation', 'mutationId', 'originKeyJson', 'route', 'originActor', 'descriptorJson', 'descriptorDigest', 'planJson', 'planDigest', 'occurredAt', 'committedBy', 'committedAt', 'commitOp', 'slotCount', 'obligationId', 'slot', 'index', 'status', 'mode', 'provenanceJson', 'reservation']) {
    assert.equal(V[name], `<${OI(name)}>`, `ORIGIN_TERMS.${name} is <${OI(name)}>, in the angle-bracket form POSTSEQ_TERMS uses (review 44433)`);
  }
});

// ── I2 closed shapes ──
test('#1629 s2 (I2) closed shapes are refused at canonicalization, before anything is sent', () => {
  need();
  const c = card('cs1', 1);
  const o = claimOrigin(c, 'k-shape');
  const bad = [
    ['unknown descriptor key', prepareIntention({ ...o, descriptor: { ...o.descriptor, extra: 1 } })],
    ['occurredAt in the PREPARE descriptor', prepareIntention({ ...o, descriptor: { ...o.descriptor, occurredAt: '2026-10-20T00:00:00Z' } })],
    ['a caller-supplied digest', prepareIntention({ ...o, descriptor: { ...o.descriptor, descriptorDigest: 'x' } })],
    ['a mutationId that is not the recomputed one', prepareIntention({ ...o, descriptor: { ...o.descriptor, mutationId: uuidv5('other', NAMESPACE) } })],
    ['a slot outside ^[a-z][a-z0-9-]{0,31}$', prepareIntention({ ...o, descriptor: { ...o.descriptor, slots: [{ ...slots(1)[0], slot: 'Bad Slot' }] } })],
    ['duplicate slots', prepareIntention({ ...o, descriptor: { ...o.descriptor, slots: [slots(1)[0], slots(1)[0]] } })],
    ['a derived field in a slot (postSeq)', prepareIntention({ ...o, descriptor: { ...o.descriptor, slots: [{ ...slots(1)[0], postSeq: 1 }] } })],
    ['subject ≠ provenance.cardId', prepareIntention({ ...o, descriptor: { ...o.descriptor, provenance: { cardId: 'other', version: 2 } } })],
    ['provenance.version ≠ the part\'s new version', prepareIntention({ ...o, descriptor: { ...o.descriptor, provenance: { cardId: c.id, version: 9 } } })],
    ['two card parts on a card route', prepareIntention({ ...o, plan: { parts: [...o.plan.parts, cpart(card('cs2', 2, { version: 2 }), '1', card('cs2', 2))] } })],
    ['a create part on a card route', prepareIntention({ ...o, plan: { parts: [cpart({ ...c, version: 2 }, null)] } })],
    ['a counter on a card route', prepareIntention({ ...o, plan: { ...o.plan, counter: { expected: null, next: '2' } } })],
    ['non-empty people on prepare', { ...prepareIntention(o), people: [{ key: 'zed' }] }],
    ['non-empty evidence on prepare', { ...prepareIntention(o), evidence: ['https://example.org/x'] }],
    ['origin together with pending on the commit', commitIntention(o, '2026-10-20T00:00:00Z', { pending: [{ card: cardIriOf(c.id), mutationId: o.mid, json: '{}' }] })],
    ['the commit op is not urn:ex:op/origin/commit/<mid>', { ...commitIntention(o, '2026-10-20T00:00:00Z'), opId: 'urn:ex:op/card/other' }],
    ['non-empty people on an origin commit', { ...commitIntention(o, '2026-10-20T00:00:00Z'), people: [{ key: 'zed' }] }],
    ['the commit\'s origin missing occurredAt', { ...commitIntention(o, '2026-10-20T00:00:00Z'), origin: o.descriptor }],
  ];
  for (const [label, i] of bad) assert.throws(() => compile(i), /./, `REFUSED: ${label}`);
  assert.doesNotThrow(() => compile(prepareIntention(o)), 'CONTROL: the well-formed prepare compiles');
  assert.doesNotThrow(() => compile(commitIntention(o, '2026-10-20T00:00:00Z')), 'CONTROL: the well-formed commit compiles');
});

// ── P1/P2 prepare ──
test('#1629 s2 (P1) prepare writes ONE Prepared node and nothing else', T, async () => {
  const c = card('p1', 1);
  await world(async ({ client }) => {
    const before = { allocator: await allocatorTuple(client), card: await cardDomain(client, c.id) };
    const o = claimOrigin(c, 'k-p1');
    const p = await prepared(client, o);
    assert.equal(p.mutationId, o.mid, 'the stored mutationId is the derived one');
    const e = await M.enumerateOriginRecords(client);
    assert.equal(e.ok, true, JSON.stringify(e));
    assert.deepEqual(e.records.map((r) => [r.type, r.mutationId]), [['Prepared', o.mid]], 'exactly one record, the Prepared one');
    assert.equal(await allocatorTuple(client), before.allocator, 'the allocator is untouched by prepare');
    assert.deepEqual(await cardDomain(client, c.id), before.card, 'the card is untouched by prepare');
    assert.equal((await gatedState(client)).filter((t) => t.startsWith('urn:ex:postseq/reservation/')).length, 0, 'no reservation is written by prepare');
  }, { cards: [c] });
});

test('#1629 s2 (P2) prepare replay: same op and content → APPLIED; same op, changed descriptor → REJECTED intent-collision, the stored record unchanged', T, async () => {
  const c = card('p2', 1);
  await world(async ({ client }) => {
    const o = claimOrigin(c, 'k-p2');
    const first = await prepared(client, o);
    const again = await client.update(prepareIntention(o));
    assert.equal(again.outcome, 'APPLIED', 'the replay returns the original receipt');
    const changed = await client.update(prepareIntention({ ...o, descriptor: { ...o.descriptor, slots: [{ ...slots(1)[0], body: 'changed' }] } }));
    assert.equal(changed.outcome, 'REJECTED', JSON.stringify(changed));
    assert.equal(changed.reason, 'intent-collision');
    const now = await M.readPreparedOrigin(client, o.mid);
    assert.deepEqual(now.prepared, first, 'the stored Prepared is unchanged');
  }, { cards: [c] });
});

// ── C1/C2 the commit ──
test('#1629 s2 (C1) the commit lands business, Origin, obligations, reservations and the allocator advance TOGETHER; the join reads ok', T, async () => {
  const c = card('c1', 1);
  await world(async ({ client }) => {
    const o = claimOrigin(c, 'k-c1', 2);
    const p = await prepared(client, o);
    const intention = commitIntention(o, p.occurredAt);
    const r = await client.update(intention);
    assert.equal(r.outcome, 'APPLIED', JSON.stringify(r).slice(0, 300));
    const want = digestOf(canonicalize(intention));
    assert.ok((await cardDomain(client, c.id)).some((t) => t.includes('claimedBy') && t.endsWith('/person/ada')), 'the business change landed');
    const got = await M.readCommittedOrigin(client, o.mid);
    assert.equal(got.ok, true, `the whole join reads ok (${JSON.stringify(got).slice(0, 300)})`);
    const { origin, obligations, reservations } = got.committed;
    assert.equal(obligations.length, 2); assert.equal(reservations.length, 2);
    assert.deepEqual(obligations.map((x) => [x.slot, x.index, x.status, x.mode, x.obligationId]), [['claim', 0, 'pending', 'publisher', `${o.mid}:claim`], ['extra-1', 1, 'pending', 'publisher', `${o.mid}:extra-1`]]);
    assert.deepEqual(reservations.map((x) => x.postSeq), [100, 101], 'consecutive numbers from the seeded allocator, in slot order');
    for (const [i, x] of reservations.entries()) {
      assert.equal(x.postId, announcePostId(o.mid, o.descriptor.slots[i].slot), 'the reservation is at the derived announcement postId');
      assert.equal(x.reserveOpId, commitOp(o.mid), 'reserveOpId is the COMMIT op');
      assert.ok(!x.reserveOpId.startsWith('urn:ex:op/postseq/reserve/'), 'and never the standalone reserve prefix');
      assert.equal(x.reserveDigest, want, 'reserveDigest is the commit receipt\'s digest');
      const s = o.descriptor.slots[i];
      assert.deepEqual(x.draft, canonAnnouncementDraft({ body: s.body, author: s.author, originActor: ACTOR_SEAT, occurredAt: p.occurredAt, mentions: s.mentions, notify: s.notify }), 'the draft carries the PREPARED occurredAt');
      assert.equal(x.createdAt, origin.committedAt, 'createdAt is the commit\'s NOW()');
    }
    const alloc = await readPostSeqAllocator(client);
    assert.deepEqual([alloc.ok, alloc.allocator?.nextPostSeq, alloc.allocator?.version], [true, 102, 2], `the allocator advanced by N, one version (${JSON.stringify(alloc)})`);
  }, { cards: [c] });
});

test('#1629 s2 (C2) replay of the commit op: APPLIED (original receipt), nothing allocated or written again', T, async () => {
  const c = card('c2', 1);
  await world(async ({ client }) => {
    const o = claimOrigin(c, 'k-c2', 1);
    const p = await prepared(client, o);
    assert.equal((await client.update(commitIntention(o, p.occurredAt))).outcome, 'APPLIED');
    const before = await snapshot(client, [c.id]);
    assert.equal((await client.update(commitIntention(o, p.occurredAt))).outcome, 'APPLIED');
    assert.deepEqual(await snapshot(client, [c.id]), before, 'the replay changed nothing');
  }, { cards: [c] });
});

// ── G: one failed guard per family ──
test('#1629 s2 (G1) a stale card version: refused, every gated family unchanged', T, async () => {
  const c = card('g1', 1);
  await world(async ({ client }) => {
    const o = claimOrigin(c, 'k-g1');
    const p = await prepared(client, o);
    assert.equal((await client.update({ kind: 'card.write', opId: `urn:ex:op/card/bump-${process.pid}`, actor: ACTOR, parts: [cpart({ ...c, version: 2, title: 'moved on' }, '1', c)] })).outcome, 'APPLIED', 'PRECONDITION: the card moved on');
    await refusedWithNoEffect(client, commitIntention(o, p.occurredAt), [c.id], 'G1 version');
  }, { cards: [c] });
});

test('#1629 s2 (G2) no allocator: refused, every gated family unchanged', T, async () => {
  const c = card('g2', 1);
  await world(async ({ client }) => {
    const o = claimOrigin(c, 'k-g2');
    const p = await prepared(client, o);
    await refusedWithNoEffect(client, commitIntention(o, p.occurredAt), [c.id], 'G2 allocator');
  }, { cards: [c], allocator: false });
});

test('#1629 s2 (G3) a reservation already at a derived postId: refused, every gated family unchanged', T, async () => {
  const c = card('g3', 1);
  await world(async ({ client, exec }) => {
    const o = claimOrigin(c, 'k-g3', 1);
    const p = await prepared(client, o);
    await rawUpdate(exec(), `INSERT DATA { GRAPH <${BK}> { <${PS(`reservation/${announcePostId(o.mid, 'claim')}`)}> a <${PS('Reservation')}> } }`, 'squat');
    await refusedWithNoEffect(client, commitIntention(o, p.occurredAt), [c.id], 'G3 reservation-absence');
  }, { cards: [c] });
});

test('#1629 s2 (G4) an Origin already present for the mutationId: refused, every gated family unchanged', T, async () => {
  const c = card('g4', 1);
  await world(async ({ client, exec }) => {
    const o = claimOrigin(c, 'k-g4', 1);
    const p = await prepared(client, o);
    await rawUpdate(exec(), `INSERT DATA { GRAPH <${BK}> { <${OI(`origin/${o.mid}`)}> a <${OI('Origin')}> } }`, 'origin-squat');
    await refusedWithNoEffect(client, commitIntention(o, p.occurredAt), [c.id], 'G4 origin-absence');
  }, { cards: [c] });
});

test('#1629 s2 (G5) no Prepared record at all: refused, every gated family unchanged', T, async () => {
  const c = card('g5', 1);
  await world(async ({ client }) => {
    const o = claimOrigin(c, 'k-g5', 1);
    await refusedWithNoEffect(client, commitIntention(o, '2026-10-20T06:00:00.000Z'), [c.id], 'G5 prepared-match (absent)');
  }, { cards: [c] });
});

// Two SEPARATE fresh origins (review 44433): a second changed intention under the op that already holds the first refusal's receipt would be
// an intent-collision, not a fresh guard refusal, and would hide whether the guard compares occurredAt at all.
test('#1629 s2 (Q4a) a fresh commit whose origin.occurredAt differs from the stored one: refused, no gated effect (two fresh origins)', T, async () => {
  const c1 = card('q4a1', 1), c2 = card('q4a2', 2);
  await world(async ({ client }) => {
    const o1 = claimOrigin(c1, 'k-q4a-lexical', 1), o2 = claimOrigin(c2, 'k-q4a-instant', 1);
    const p1 = await prepared(client, o1), p2 = await prepared(client, o2);
    const other = p1.occurredAt.endsWith('Z') ? p1.occurredAt.replace(/Z$/, '+00:00') : `${p1.occurredAt}Z`;
    await refusedWithNoEffect(client, commitIntention(o1, other), [c1.id], 'Q4a lexical form changed (same instant)');
    await refusedWithNoEffect(client, commitIntention(o2, '2001-01-01T00:00:00Z'), [c2.id], 'Q4a a different instant');
  }, { cards: [c1, c2] });
});

test('#1629 s2 (Q4b) after an APPLIED commit, the same op with a changed occurredAt is REJECTED intent-collision; nothing allocated', T, async () => {
  const c = card('q4b', 1);
  await world(async ({ client }) => {
    const o = claimOrigin(c, 'k-q4b', 1);
    const p = await prepared(client, o);
    assert.equal((await client.update(commitIntention(o, p.occurredAt))).outcome, 'APPLIED');
    const before = await snapshot(client, [c.id]);
    const r = await client.update(commitIntention(o, '2001-01-01T00:00:00Z'));
    assert.equal(r.outcome, 'REJECTED'); assert.equal(r.reason, 'intent-collision');
    assert.deepEqual(await snapshot(client, [c.id]), before, 'no new allocation, nothing written');
  }, { cards: [c] });
});

// ── AD: commit admission (§2a.9) — each corruption refused by the commit AND read INVALID ──
const AD = [
  ['AD1 descriptorJson changed, its digest left matching', (mid) => `DELETE { GRAPH <${BK}> { <${OI(`prepared/${mid}`)}> <${OI('descriptorJson')}> ?d } } INSERT { GRAPH <${BK}> { <${OI(`prepared/${mid}`)}> <${OI('descriptorJson')}> ?e } } WHERE { GRAPH <${BK}> { <${OI(`prepared/${mid}`)}> <${OI('descriptorJson')}> ?d } BIND(REPLACE(?d, "announce 0", "announce X") AS ?e) }`],
  ['AD2 planJson missing', (mid) => `DELETE WHERE { GRAPH <${BK}> { <${OI(`prepared/${mid}`)}> <${OI('planJson')}> ?x } }`],
  ['AD3 occurredAt duplicated', (mid) => `INSERT DATA { GRAPH <${BK}> { <${OI(`prepared/${mid}`)}> <${OI('occurredAt')}> "1999-01-01T00:00:00Z"^^<${XSD}dateTime> } }`],
  ['AD4 originActor ≠ the actor', (mid) => `DELETE { GRAPH <${BK}> { <${OI(`prepared/${mid}`)}> <${OI('originActor')}> ?a } } INSERT { GRAPH <${BK}> { <${OI(`prepared/${mid}`)}> <${OI('originActor')}> "zed" } } WHERE { GRAPH <${BK}> { <${OI(`prepared/${mid}`)}> <${OI('originActor')}> ?a } }`],
  ['AD5 a duplicate descriptorDigest', (mid) => `INSERT DATA { GRAPH <${BK}> { <${OI(`prepared/${mid}`)}> <${OI('descriptorDigest')}> "0000" } }`],
];
for (const [label, mutate] of AD) {
  test(`#1629 s2 (${label.split(' ')[0]}) ${label.slice(label.indexOf(' ') + 1)}: the commit refuses before every gated effect, and readPreparedOrigin reads INVALID`, T, async () => {
    const c = card(`ad${label[2]}`, 1);
    await world(async ({ client, exec }) => {
      const o = claimOrigin(c, `k-${label.split(' ')[0]}`, 1);
      const p = await prepared(client, o);
      await rawUpdate(exec(), mutate(o.mid), 'tamper');
      const read = await M.readPreparedOrigin(client, o.mid);
      assert.equal(read.ok, false, `${label}: the reader refuses it (${JSON.stringify(read).slice(0, 200)})`);
      assert.equal(read.status, 'INVALID');
      await refusedWithNoEffect(client, commitIntention(o, p.occurredAt), [c.id], label);
    }, { cards: [c] });
  });
}

// ── TM: readback tamper after an APPLIED commit (§2a.8) — each read INVALID, never ok ──
const TM = [
  ['TM1 a second descriptorDigest on Prepared', (mid) => `INSERT DATA { GRAPH <${BK}> { <${OI(`prepared/${mid}`)}> <${OI('descriptorDigest')}> "0000" } }`],
  ['TM2 obligation index 1 renumbered to 2', (mid) => `DELETE { GRAPH <${BK}> { ?ob <${OI('index')}> ?i } } INSERT { GRAPH <${BK}> { ?ob <${OI('index')}> "2"^^<${XSD}integer> } } WHERE { GRAPH <${BK}> { ?ob a <${OI('Obligation')}> ; <${OI('mutationId')}> "${mid}" ; <${OI('index')}> ?i FILTER(?i = 1) } }`],
  ['TM3 an extra obligation slot', (mid) => `INSERT DATA { GRAPH <${BK}> { <${OI(`obligation/${mid}/zz`)}> a <${OI('Obligation')}> ; <${OI('mutationId')}> "${mid}" ; <${OI('slot')}> "zz" ; <${OI('index')}> "2"^^<${XSD}integer> } }`],
  ['TM4 a reservation draft body changed', () => `DELETE { GRAPH <${BK}> { ?r <${PS('draftJson')}> ?d } } INSERT { GRAPH <${BK}> { ?r <${PS('draftJson')}> ?e } } WHERE { GRAPH <${BK}> { ?r <${PS('draftJson')}> ?d FILTER(CONTAINS(?d, "announce 0")) } BIND(REPLACE(?d, "announce 0", "announce X") AS ?e) }`],
  ['TM5 reserveDigest swapped for another receipt\'s', () => `DELETE { GRAPH <${BK}> { ?r <${PS('reserveDigest')}> ?d } } INSERT { GRAPH <${BK}> { ?r <${PS('reserveDigest')}> "${'f'.repeat(64)}" } } WHERE { GRAPH <${BK}> { ?r <${PS('reserveDigest')}> ?d ; <${PS('index')}> ?i FILTER(?i = 0) } }`],
  ['TM6 Origin.commitOp pointing at a different op', (mid) => `DELETE { GRAPH <${BK}> { <${OI(`origin/${mid}`)}> <${OI('commitOp')}> ?o } } INSERT { GRAPH <${BK}> { <${OI(`origin/${mid}`)}> <${OI('commitOp')}> <urn:ex:op/card/elsewhere> } } WHERE { GRAPH <${BK}> { <${OI(`origin/${mid}`)}> <${OI('commitOp')}> ?o } }`],
  ['TM7 committedAt ≠ the reservations\' createdAt', (mid) => `DELETE { GRAPH <${BK}> { <${OI(`origin/${mid}`)}> <${OI('committedAt')}> ?t } } INSERT { GRAPH <${BK}> { <${OI(`origin/${mid}`)}> <${OI('committedAt')}> "1999-01-01T00:00:00Z"^^<${XSD}dateTime> } } WHERE { GRAPH <${BK}> { <${OI(`origin/${mid}`)}> <${OI('committedAt')}> ?t } }`],
  ['TM8 the draft occurredAt ≠ Prepared.occurredAt', () => `DELETE { GRAPH <${BK}> { ?r <${PS('draftJson')}> ?d } } INSERT { GRAPH <${BK}> { ?r <${PS('draftJson')}> ?e } } WHERE { GRAPH <${BK}> { ?r <${PS('draftJson')}> ?d ; <${PS('index')}> ?i FILTER(?i = 0) } BIND(REPLACE(?d, "\\"occurredAt\\":\\"[^\\"]*\\"", "\\"occurredAt\\":\\"1999-01-01T00:00:00Z\\"") AS ?e) }`],
  ['TM9 receipt and reserveDigest agree with each other but not with the reconstruction', null],   // needs a forged receipt; see below
];
for (const [label, mutate] of TM) {
  test(`#1629 s2 (${label.split(' ')[0]}) ${label.slice(label.indexOf(' ') + 1)}: readCommittedOrigin reads INVALID`, T, async () => {
    const c = card(`tm${label[2]}`, 1);
    await world(async ({ client, exec }) => {
      const o = claimOrigin(c, `k-${label.split(' ')[0]}`, 2);
      const p = await prepared(client, o);
      const intention = commitIntention(o, p.occurredAt);
      assert.equal((await client.update(intention)).outcome, 'APPLIED', 'PRECONDITION: the commit applied');
      assert.equal((await M.readCommittedOrigin(client, o.mid)).ok, true, 'PRECONDITION (CONTROL): untampered, it reads ok');
      if (mutate) await rawUpdate(exec(), mutate(o.mid), 'tamper');
      else {
        // TM9: overwrite BOTH the receipt digest and every reserveDigest with the digest of a DIFFERENT intention (a changed body), so the
        // two agree with each other and with no stored descriptor — only the §2a.5a reconstruction can see it.
        const forged = digestOf(canonicalize({ ...intention, origin: { ...intention.origin, slots: intention.origin.slots.map((s) => ({ ...s, body: `${s.body}!` })) } }));
        // EXACT targets (review 44439): the commit op's own receipt subject, and the two reservation subjects at the derived postIds — never a
        // value scan. The forged literal keeps the stored datatype (STRDT on DATATYPE), so only its VALUE changes.
        const resvSubjects = o.descriptor.slots.map((sl) => PS(`reservation/${announcePostId(o.mid, sl.slot)}`));
        for (const rs of resvSubjects) await rawUpdate(exec(), `DELETE { GRAPH <${BK}> { <${rs}> <${PS('reserveDigest')}> ?d } } INSERT { GRAPH <${BK}> { <${rs}> <${PS('reserveDigest')}> ?nd } } WHERE { GRAPH <${BK}> { <${rs}> <${PS('reserveDigest')}> ?d } BIND(STRDT("${forged}", DATATYPE(?d)) AS ?nd) }`, 'tamper');
        // the receipt is <commitOp> in the bookkeeping graph with <urn:ex:digest> and <urn:ex:outcome> (read on main's executor, 44440); exact
        // graph and predicates, no suffix match (review 44444)
        await rawUpdate(exec(), `DELETE { GRAPH <${BK}> { <${commitOp(o.mid)}> <urn:ex:digest> ?d } } INSERT { GRAPH <${BK}> { <${commitOp(o.mid)}> <urn:ex:digest> ?nd } } WHERE { GRAPH <${BK}> { <${commitOp(o.mid)}> <urn:ex:digest> ?d } BIND(STRDT("${forged}", DATATYPE(?d)) AS ?nd) }`, 'tamper-receipt');
        const outcome = await rows(client, `SELECT ?o WHERE { GRAPH <${BK}> { <${commitOp(o.mid)}> <urn:ex:outcome> ?o } }`);
        assert.deepEqual(outcome.map((r) => [r.o.type, r.o.value]), [['uri', 'urn:ex:APPLIED']], 'PRECONDITION: the forged receipt still reads exactly <urn:ex:APPLIED> (only its digest was changed)');
        // PRECONDITION (review 44433): the forge hit ALL THREE together — the commit receipt and both reservations now carry `forged`,
        // and nothing still carries the real digest. Otherwise an INVALID below could come from a half-forged store, not from §2a.5a.
        const real = digestOf(canonicalize(intention));
        const receipt = await rows(client, `SELECT ?d WHERE { GRAPH <${BK}> { <${commitOp(o.mid)}> <urn:ex:digest> ?d } }`);
        assert.deepEqual(receipt.map((r) => r.d.value), [forged], 'PRECONDITION: the commit receipt\'s digest is the forged one');
        for (const rs of resvSubjects) assert.deepEqual((await rows(client, `SELECT ?d WHERE { GRAPH <${BK}> { <${rs}> <${PS('reserveDigest')}> ?d } }`)).map((r) => r.d.value), [forged], `PRECONDITION: ${rs} carries exactly the forged digest`);
        assert.equal((await rows(client, `SELECT ?s WHERE { GRAPH ?g { ?s ?p "${real}" } }`)).length, 0, 'PRECONDITION: no triple still carries the real digest');
      }
      const got = await M.readCommittedOrigin(client, o.mid);
      assert.equal(got.ok, false, `${label}: never ok (${JSON.stringify(got).slice(0, 200)})`);
      assert.equal(got.status, 'INVALID');
    }, { cards: [c] });
  });
}

// ── T1 ordering ──
test('#1629 s2 (T1) prepare A, prepare B, commit B, commit A: postSeq(B) < postSeq(A); occurredAt kept; createdAt is each commit\'s own', T, async () => {
  const a = card('t1a', 1), b = card('t1b', 2);
  await world(async ({ client }) => {
    const oa = claimOrigin(a, 'k-t1a', 1), ob = claimOrigin(b, 'k-t1b', 1);
    const pa = await prepared(client, oa);
    await new Promise((r) => setTimeout(r, 20));   // ordering only; nothing asserts a duration
    const pb = await prepared(client, ob);
    assert.equal((await client.update(commitIntention(ob, pb.occurredAt))).outcome, 'APPLIED');
    assert.equal((await client.update(commitIntention(oa, pa.occurredAt))).outcome, 'APPLIED');
    const ca = (await M.readCommittedOrigin(client, oa.mid)).committed, cb = (await M.readCommittedOrigin(client, ob.mid)).committed;
    assert.ok(cb.reservations[0].postSeq < ca.reservations[0].postSeq, 'sequence follows COMMIT order, not prepare order');
    assert.equal(ca.reservations[0].draft.occurredAt, pa.occurredAt, 'A keeps its prepare time'); assert.equal(cb.reservations[0].draft.occurredAt, pb.occurredAt, 'B keeps its prepare time');
    assert.equal(ca.reservations[0].createdAt, ca.origin.committedAt); assert.equal(cb.reservations[0].createdAt, cb.origin.committedAt);
    assert.notEqual(ca.reservations[0].createdAt, pa.occurredAt, 'createdAt is not the prepare time');
  }, { cards: [a, b] });
});

// ── O2 agent route + g1–g3 ──
// the agent is a real collection member at version 1 before the rest (seeded with entity.put, as #1624's rows do); its quads are its real
// projection, never [] — an empty quads list on an update part deletes every projected field of the agent (review 44429)
const agentOf = (seat, state) => ({ '@id': AGENT_ID(seat), '@type': 'scrum:Agent', 'scrum:seatKey': seat, 'scrum:state': state, name: seat });
const seatUnique = (seat) => [{ predicate: 'https://scrumboard.local/ns#seatKey', value: { type: 'literal', value: seat } }];
async function seedAgent(client, seat) {
  const e = agentOf(seat, 'invited');
  const r = await client.update({ kind: 'entity.put', opId: `urn:ex:op/collections/og1629-agent-${process.pid}-${seedN++}`, actor: ACTOR, entity: { kind: 'collection', parts: [{ collection: 'agents', iri: e['@id'], expectedVersion: null, version: '1', quads: entityQuads(e), json: JSON.stringify(e), unique: seatUnique(seat) }] } });
  assert.equal(r.outcome, 'APPLIED', `PRECONDITION: the agent ${seat} exists at version 1 (${JSON.stringify(r).slice(0, 200)})`);
}
const agentDomain = async (client, seat) => (await rows(client, `SELECT ?p ?o WHERE { <${AGENT_ID(seat)}> ?p ?o }`)).map((r) => `${r.p.value} ${r.o.value}`).sort();
function restOrigin(agentSeat, released, requestKey, { omitHeld = [] } = {}) {
  const mid = midOf('agent-rest', agentSeat, requestKey);
  const agentEntity = agentOf(agentSeat, 'resting');
  const parts = released.map((c) => { const { claimedBy, ...rest } = c; return cpart({ ...rest, version: c.version + 1 }, String(c.version), c); });
  const descriptor = { route: 'agent-rest', subject: agentSeat, requestKey, originActor: ACTOR_SEAT, mutationId: mid, provenance: { agent: agentSeat, releasedCards: released.map((c) => c.id) }, slots: [{ slot: 'agent-rest', author: 'board', body: `${agentSeat} is resting`, mentions: [], notify: false }] };
  return { mid, descriptor, plan: { parts, collections: [{ collection: 'agents', iri: AGENT_ID(agentSeat), expectedVersion: '1', version: '2', quads: entityQuads(agentEntity), json: JSON.stringify(agentEntity), unique: seatUnique(agentSeat) }] }, omitHeld };
}
test('#1629 s2 (O2) an agent rest releases two GENUINELY held cards with the agent entity in one commit; g1, g2, g3 each refuse their own case', T, async () => {
  const held1 = card('o2a', 1, { claimedBy: 'zoe' }), held2 = card('o2b', 2, { claimedBy: 'zoe' }), free = card('o2c', 3), held3 = card('o2d', 4, { claimedBy: 'zoe' });
  const yanOnly = card('o2y', 5, { claimedBy: 'yan' });   // yan holds exactly this one card
  await world(async ({ client }) => {
    await seedAgent(client, 'zoe'); await seedAgent(client, 'yan');
    // PRECONDITION: the executor holds the claim edges (the measured ON-case shape, 44276), read the same way the guard must
    for (const c of [held1, held2, held3]) assert.ok((await cardDomain(client, c.id)).some((t) => t.includes('claimedBy') && t.endsWith('/person/zoe')), `PRECONDITION: ${c.id} is held by zoe in the graph`);
    assert.ok((await cardDomain(client, yanOnly.id)).some((t) => t.includes('claimedBy') && t.endsWith('/person/yan')), 'PRECONDITION: yan holds its one card');
    // g1 — ISOLATED (review 44433): yan releases every card it holds (so g2 is satisfied) plus one card it does NOT hold. Only g1 can refuse.
    const g1 = restOrigin('yan', [free, yanOnly], 'k-g1');
    const p1 = await prepared(client, g1);   // prepare checks no claims; the guard lives in the commit
    await refusedWithNoEffect(client, commitIntention(g1, p1.occurredAt), [yanOnly.id, free.id], 'g1 held (only g1 violated)', [AGENT_ID('yan')]);
    // g1 CONTROL: the same agent releasing exactly what it holds is not refused by g1 or g2 (so the refusal above was g1's)
    const g1ok = restOrigin('yan', [yanOnly], 'k-g1-control');
    const p1ok = await prepared(client, g1ok);
    assert.equal((await client.update(commitIntention(g1ok, p1ok.occurredAt))).outcome, 'APPLIED', 'g1 CONTROL: yan releasing exactly its own card is APPLIED');
    // g2 — a card the agent holds, left out of the plan
    const g2 = restOrigin('zoe', [held1, held2], 'k-g2');   // held3 also held by zoe and omitted
    const p2 = await prepared(client, g2);
    await refusedWithNoEffect(client, commitIntention(g2, p2.occurredAt), [held1.id, held2.id, held3.id], 'g2 complete (only g2 violated: both released cards ARE held)', [AGENT_ID('zoe')]);
    // g3 — a released card whose NEW quads keep a claimedBy edge: refused at compile time, nothing sent
    const g3 = restOrigin('zoe', [held1, held2, held3], 'k-g3');
    g3.plan.parts[0] = cpart({ ...held1, version: 2 }, '1', held1);   // keeps claimedBy: 'zoe'
    assert.throws(() => compile(prepareIntention(g3)), /./, 'g3: a released card still claimed BY THE AGENT is refused before anything is sent');
    const g3b = restOrigin('zoe', [held1, held2, held3], 'k-g3b');
    g3b.plan.parts[0] = cpart({ ...held1, version: 2, claimedBy: 'ada' }, '1', held1);   // "released" but handed to a DIFFERENT owner
    assert.throws(() => compile(prepareIntention(g3b)), /./, 'g3: a released card that keeps a claimedBy edge to ANYONE (here a different seat) is refused too');
    // CLEAN CONTROL — all three held cards released, claims dropped: APPLIED, one notify=false obligation, the cards free
    const ok = restOrigin('zoe', [held1, held2, held3], 'k-ok');
    const p = await prepared(client, ok);
    const r = await client.update(commitIntention(ok, p.occurredAt));
    assert.equal(r.outcome, 'APPLIED', JSON.stringify(r).slice(0, 300));
    for (const c of [held1, held2, held3]) assert.ok(!(await cardDomain(client, c.id)).some((t) => t.includes('claimedBy')), `${c.id} is released`);
    const got = await M.readCommittedOrigin(client, ok.mid);
    assert.equal(got.ok, true); assert.equal(got.committed.obligations.length, 1);
    assert.equal(got.committed.reservations[0].draft.notify, false, 'the rest notice is notify=false');
    assert.ok((await agentDomain(client, 'zoe')).some((t) => t.includes('state') && t.endsWith('resting')), 'the agent entity was updated in the same commit, its projected fields intact');
  }, { cards: [held1, held2, free, held3, yanOnly] });
});

// ── B1 compatibility controls (golden captured from main 429e487 by the test author; see the golden file's note) ──
// postseq.reserve still compiles BYTE-IDENTICALLY. card.write does not, BY DESIGN: #1744's frozen contract maintains the card
// reference index on EVERY card write, mode on included (its §0 decision (a), V2-4 D8), and its F5 admits excluding the exact
// index subtree from an old-state comparison ONLY beside a positive check of that subtree. So card.write's control is a STORE
// comparison, never a re-captured golden: 429e487's compiled SPARQL (the golden, sent unchanged) and the head's compile each run
// on one of two IDENTICALLY seeded executors, and the stores must be equal on every quad outside urn:ex:card-ref-index/ —
// receipts, counters, versions and domain triples INCLUDED — while the head's index for each written card validates exactly.
const GOLDEN = path.join(HERE, 'fixtures-1629-s2', 'golden-429e487.json');
const CRI_NS = 'urn:ex:card-ref-index/';
const STORE_OWN = new Set(['urn:ex:incarnation', 'urn:ex:storeHome', 'urn:ex:storeHomeInode']);
test('#1629 s2 (B1) postseq.reserve compiles byte-identically to main 429e487', () => {
  const g = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  const ps = g.cases.filter((k) => k.intention.kind === 'postseq.reserve');
  assert.equal(ps.length, 2, 'PRECONDITION: the golden file holds both postseq.reserve cases');
  for (const k of ps) assert.equal(compile(k.intention).sparql, k.compiled, `${k.label}: compiles exactly as at 429e487`);
});
/** the seed cards the golden's priors were built from (each case's old leg must APPLY on them, which proves they match) */
const B1_SEEDS = { ga: card('ga', 1, { labels: ['x'] }), gb: card('gb', 2, { blockers: [{ person: 'ada', status: 'open' }] }) };
const b1Names = (c) => {   // the board's naming rule, computed here, not by the build
  const n = new Set([...String(`${c.title ?? ''}\n${c.description ?? ''}`).matchAll(/#(\d+)/g)].map((m) => Number(m[1])));
  for (const arr of Object.values(c.relationships || {})) for (const v of arr || []) n.add(Number(v));
  for (const a of c.acceptance || []) for (const v of a?.blockedBy || []) n.add(Number(v));
  return [...n].filter((x) => Number.isSafeInteger(x) && x > 0).sort((a, b) => a - b);
};
async function b1Quads(x) {
  const r = await fetch(`${x.baseUrl}/query`, { method: 'POST', headers: { 'x-op-id': `urn:ex:op/test/b1q-${crypto.randomUUID()}` }, body: 'SELECT ?g ?s ?p ?o WHERE { { ?s ?p ?o } UNION { GRAPH ?g { ?s ?p ?o } } }' });
  assert.equal(r.status, 200, 'the snapshot query answered');
  const t = (b) => (b ? `${b.type}|${b.value}|${b.datatype ?? ''}|${b['xml:lang'] ?? ''}` : '-');
  // NOT compiler output, so normalised (never dropped): each store's own identity, and a receipt's wall-clock time (its
  // presence, predicate and datatype still compare; only the clock value is masked)
  const own = (b) => (STORE_OWN.has(b.p.value) && b.s.value === 'urn:ex:dataset') || b.p.value === 'urn:ex:at';
  return (await r.json()).results.bindings.map((b) => ({ line: [t(b.g), t(b.s), t(b.p), own(b) ? `${b.o.type}|<masked>|${b.o.datatype ?? ''}|` : t(b.o)].join(' '), index: [b.s, b.p, b.o].some((v) => v && v.value.startsWith(CRI_NS)) }));
}
for (const label of ['card.write create with counter', 'card.write update with prior', 'card.write two parts', 'card.write with K4 pending']) {
  test(`#1629 s2 (B1) ${label}: 429e487's SPARQL and the head's leave equal stores outside the index subtree, and the head's index is exact`, T, async () => {
    const k = JSON.parse(fs.readFileSync(GOLDEN, 'utf8')).cases.find((c) => c.label === label);
    assert.ok(k, `PRECONDITION: the golden holds "${label}"`);
    const xs = [];
    try {
      for (const tag of ['old', 'head']) {
        const dir = tmpStore(`b1-${tag}-`); fs.rmSync(dir, { recursive: true });
        xs.push({ dir, x: await startExecutor({ store: dir, datasetId: DSID, create: true }) });
      }
      const [A, B] = xs.map((e) => e.x);
      // identical seeds, written through the HEAD compiler on BOTH stores (so the only differing input is the compiled update)
      const seedIds = k.intention.parts.filter((p) => p.expectedVersion != null).map((p) => p.iri.split('/').pop());
      if (seedIds.length) {
        const seed = { kind: 'card.write', opId: `urn:ex:op/card/b1-seed-${seedIds.join('-')}`, actor: ACTOR, parts: seedIds.map((id) => cpart(B1_SEEDS[id], null)), counter: { expected: null, next: '3' } };
        for (const x of [A, B]) assert.equal((await createGraphClient({ baseUrl: x.baseUrl, expectedDatasetId: DSID }).update(seed)).outcome, 'APPLIED', 'PRECONDITION: the seed applied');
      }
      const s0 = [await b1Quads(A), await b1Quads(B)].map((q) => q.map((r) => r.line).sort().join('\n'));
      assert.equal(s0[0], s0[1], 'PRECONDITION: the two seeded stores are byte-identical');
      // the OLD leg: 429e487's compiled SPARQL, unchanged, as the client sends it
      const ep = String((await (await fetch(`${A.baseUrl}/health`)).json()).epoch);
      const ra = await fetch(`${A.baseUrl}/update`, { method: 'POST', headers: { 'x-op-id': k.intention.opId, 'content-type': 'application/sparql-update', 'x-epoch': ep }, body: k.compiled });
      const ja = await ra.json().catch(() => null);
      assert.equal(ra.status, 200, `the old leg was accepted (${ra.status})`);
      assert.ok(String(JSON.stringify(ja?.receipt ?? '')).includes('APPLIED'), `the old leg APPLIED on the seed, so the seed is the one its priors name (${JSON.stringify(ja).slice(0, 200)})`);
      const rb = await createGraphClient({ baseUrl: B.baseUrl, expectedDatasetId: DSID }).update(k.intention);
      assert.equal(rb.outcome, 'APPLIED', `the head leg APPLIED (${JSON.stringify(rb).slice(0, 200)})`);
      const [qa, qb] = [await b1Quads(A), await b1Quads(B)];
      const outside = (q) => q.filter((r) => !r.index).map((r) => r.line).sort();
      assert.ok(outside(qa).length > 0, 'CONTROL: the compared population is not empty');
      assert.deepEqual(outside(qb), outside(qa), 'every quad outside urn:ex:card-ref-index/ is identical: receipts, counters, versions and domain triples included');
      // F5: the excluded subtree, validated positively on the head's store, for every card the write touched
      const cq = createGraphClient({ baseUrl: B.baseUrl, expectedDatasetId: DSID });
      for (const part of k.intention.parts) {
        const id = part.iri.split('/').pop();
        const row = await cq.query(`SELECT ?v ?j WHERE { GRAPH <${BK}> { <${part.iri}> <urn:ex:ver> ?v ; <https://scrumboard.local/ns#entityJson> ?j } }`);
        assert.equal(row.rows.length, 1, `PRECONDITION: ${id} has one stored version and JSON`);
        const { v, j } = row.rows[0];
        const cov = await cq.query(`SELECT ?p ?o WHERE { GRAPH <${BK}> { <${CRI_NS}card/${id}> ?p ?o } }`);
        const of = (pn) => cov.rows.filter((r) => r.p.value === `${CRI_NS}${pn}`).map((r) => r.o.value);
        assert.deepEqual(of('indexedVersion'), [v.value], `${id}: exactly one indexedVersion, the card's graph version`);
        assert.deepEqual(of('indexedJsonDigest'), [crypto.createHash('sha256').update(j.value).digest('hex')], `${id}: exactly one digest, of its stored JSON`);
        assert.deepEqual(of('namesShortId').map(Number).sort((a, b) => a - b), b1Names(JSON.parse(j.value)), `${id}: exactly its names`);
      }
      const extra = qb.filter((r) => r.index && !r.line.includes(`${CRI_NS}card/`)).map((r) => r.line);
      assert.deepEqual(extra, [], 'the head added no index triple except coverage nodes (no marker: a write never claims completeness)');
    } finally { for (const e of xs) { await killExecutor(e.x); fs.rmSync(e.dir, { recursive: true, force: true }); fs.rmSync(`${e.dir}.checkpoints`, { recursive: true, force: true }); } }
  });
}

// ── PR1 interruption after prepare ──
test('#1629 s2 (PR1) prepare, kill the executor, restart on the same store: one Prepared record, allocator and card unchanged, same digests', T, async () => {
  const c = card('pr1', 1);
  await world(async (ctx) => {
    const o = claimOrigin(c, 'k-pr1', 1);
    const before = { allocator: await allocatorTuple(ctx.client), card: await cardDomain(ctx.client, c.id) };
    const p = await prepared(ctx.client, o);
    await ctx.restart();
    const e = await M.enumerateOriginRecords(ctx.client);
    assert.deepEqual(e.records.map((r) => [r.type, r.mutationId]), [['Prepared', o.mid]], 'exactly the Prepared record survives, nothing else');
    assert.equal(await allocatorTuple(ctx.client), before.allocator, 'the allocator tuple is byte-identical');
    assert.deepEqual(await cardDomain(ctx.client, c.id), before.card, 'the card is unchanged');
    assert.deepEqual((await M.readPreparedOrigin(ctx.client, o.mid)).prepared, p, 'the same record, the same digests: nothing re-rendered');
  }, { cards: [c] });
});
