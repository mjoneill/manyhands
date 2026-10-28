/**
 * #1629 slice 3 — CONTROLS on the slice-2 primitive as landed, written before the r2 build (r2 §7(i) and R-A0; non-builder review 45023:
 * the unchanged actor and guard controls may be authored now). TEST AUTHOR's. They run against what is on main today, so each
 * passes or fails NOW; nothing here is a TODO.
 *
 *   A1   THE BOARD ACTOR (r2 §7(i), read from source as admissible, 45022): an origin whose originActor is `board` and whose intention
 *        actor is https://scrumboard.local/person/board prepares and commits APPLIED, the committed join reads ok with originActor
 *        `board`, and each reservation's draft carries originActor `board`. CONTROL: the same origin with an EMPTY originActor is
 *        refused before anything is written, so A1's pass is not "any actor string goes".
 *   RA0  A PREPARATION APPLIES OR NOT BY ITS GUARDS, NOT BY ITS REQUEST'S FATE (the narrowing in 45023 §1):
 *        (a) prepared, then an UNRELATED card moves, then the commit is sent: APPLIED. An ended request alone does not retire it.
 *        (b) prepared, then ITS card moves (a conflicting state change), then the commit is sent: PRECONDITION_FAILED, and neither the
 *            card nor any origin, obligation or reservation changed. (b) restates G1's guard in the same world as (a), as a pair.
 *
 * NOT covered, by name: outcome states after UNKNOWN (R-A1, waits on the r2 corrections); settlement; W1; E1/E2; a receipt actor
 * naming a Person NODE (the executor holds none here; A1 says the IRI is accepted, not that it resolves).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';
import { createGraphClient } from '../core/graph-client.mjs';
import { canonicalize } from '../core/graph-compiler.mjs';
import { cardQuads, priorQuads, cardIriOf } from '../core/cards-graph.mjs';
import { canonAnnouncementDraft } from '../core/postseq-reserve.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let M = null, modErr = null;
try { M = await import(pathToFileURL(path.join(HERE, '..', 'core', 'origin-commit.mjs')).href); } catch (e) { modErr = e; }
const need = () => assert.ok(M, `core/origin-commit.mjs does not exist (${modErr?.message?.slice(0, 120)})`);
const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const T = { skip: SKIP, timeout: 300000 };
const DSID = 'og1629c';
const BK = 'urn:scrum:bookkeeping:executor';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const NAMESPACE = 'cd807138-eefc-40d2-9a80-525e666e6269';
const PS = (name) => `urn:ex:postseq/${name}`;
const PERSON = (seat) => `https://scrumboard.local/person/${seat}`;
const EPOCH = 'e-1629-s3c';

/** An INDEPENDENT RFC 4122 v5: the rows do not test the build's derivation with the build's own function. */
function uuidv5(name, ns) {
  const h = crypto.createHash('sha1').update(Buffer.concat([Buffer.from(ns.replace(/-/g, ''), 'hex'), Buffer.from(name, 'utf8')])).digest();
  h[6] = (h[6] & 0x0f) | 0x50; h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}
const midOf = (route, subject, requestKey, originActor) => uuidv5(JSON.stringify(['origin-v1', route, subject, requestKey, originActor]), NAMESPACE);
const card = (id, shortId, extra = {}) => ({ id, shortId, title: `card ${shortId}`, description: 'body', column: 'backlog', createdAt: '2026-10-22T06:00:00.000Z', createdBy: 'ada', version: 1, ...extra });
const cpart = (c, expectedVersion, prior = null) => ({ iri: cardIriOf(c.id), expectedVersion, version: c.version, quads: cardQuads(c, new Map()), ...(prior ? { prior: priorQuads(prior, new Map()) } : {}), json: JSON.stringify(c) });

/** A claim-shaped origin on card `c` (v1 → v2) by `seat`, announcing one slot. */
function claimOrigin(c, requestKey, seat) {
  const mid = midOf('claim', c.id, requestKey, seat);
  const descriptor = { route: 'claim', subject: c.id, requestKey, originActor: seat, mutationId: mid, provenance: { cardId: c.id, version: 2 }, slots: [{ slot: 'claim', author: 'board', body: `${seat} claimed #${c.shortId}`, mentions: [], notify: false }] };
  return { mid, seat, descriptor, plan: { parts: [cpart({ ...c, version: 2, claimedBy: seat }, '1', c)] } };
}
const prepareIntention = (o, actor) => ({ kind: 'origin.prepare', opId: `urn:ex:op/origin/prepare/${o.mid}`, actor, origin: o.descriptor, plan: o.plan });
const commitIntention = (o, actor, occurredAt) => ({ kind: 'card.write', opId: `urn:ex:op/origin/commit/${o.mid}`, actor, ...o.plan, origin: { ...o.descriptor, occurredAt } });

const lit = (v) => (typeof v === 'number' ? `"${v}"^^<${XSD}integer>` : JSON.stringify(String(v)));
let seedN = 0;
const STORES = [];
after(() => { for (const d of STORES) fs.rmSync(d, { recursive: true, force: true }); });
async function world(body, cards) {
  need();
  const store = tmpStore('og1629c-'); STORES.push(store); fs.rmSync(store, { recursive: true });
  const exec = await startExecutor({ store, datasetId: DSID, create: true });
  try {
    const client = createGraphClient({ baseUrl: exec.baseUrl, expectedDatasetId: DSID, timeoutMs: 30000, label: 'origin-1629-s3-controls' });
    const r = await fetch(`${exec.baseUrl}/update`, { method: 'POST', headers: { 'x-op-id': `urn:ex:op/test/og1629c-alloc-${process.pid}-${seedN++}` }, body: `INSERT DATA { GRAPH <${BK}> { <${PS('allocator')}> a <${PS('Allocator')}> ; <${PS('postSeqEpoch')}> ${lit(EPOCH)} ; <${PS('nextPostSeq')}> ${lit(100)} ; <${PS('version')}> ${lit(1)} . } }` });
    assert.equal(r.status, 200, `PRECONDITION: the allocator was seeded (${await r.text()})`);
    for (const c of cards) {
      const w = await client.update({ kind: 'card.write', opId: `urn:ex:op/card/og1629c-seed-${process.pid}-${seedN++}`, actor: PERSON('ada'), parts: [cpart(c, null)] });
      assert.equal(w.outcome, 'APPLIED', `PRECONDITION: fixture card ${c.id} created (${JSON.stringify(w)})`);
    }
    await body({ client, exec });
  } finally { await killExecutor(exec); }
}
const rows = async (client, sparql) => { const q = await client.query(sparql); assert.ok(q.ok, `query answered (${q.reason})`); return q.rows; };
const cardTriples = async (client, id) => (await rows(client, `SELECT ?p ?o WHERE { <${cardIriOf(id)}> ?p ?o }`)).map((r) => `${r.p.value} ${r.o.value}`).sort();
const gated = async (client) => (await rows(client, `SELECT ?s ?p ?o WHERE { GRAPH <${BK}> { ?s ?p ?o FILTER(STRSTARTS(STR(?s), "urn:ex:origin/") || STRSTARTS(STR(?s), "urn:ex:postseq/")) } }`))
  .map((r) => `${r.s.value} ${r.p.value} ${r.o.value}`).sort();
async function prepare(client, o, actor) {
  const r = await client.update(prepareIntention(o, actor));
  assert.equal(r.outcome, 'APPLIED', `PRECONDITION: prepare APPLIED (${JSON.stringify(r).slice(0, 300)})`);
  const p = await M.readPreparedOrigin(client, o.mid);
  assert.equal(p.ok, true, `PRECONDITION: the Prepared record reads ok (${JSON.stringify(p).slice(0, 300)})`);
  return p.prepared;
}

test('#1629 s3 (A1) the `board` actor: an origin by `board` prepares and commits APPLIED and reads back as `board`; CONTROL: an empty originActor is refused before any write', T, async () => {
  const c = card('a1', 1), e = card('a1e', 2);
  await world(async ({ client }) => {
    const o = claimOrigin(c, 'k-a1', 'board');
    const p = await prepare(client, o, PERSON('board'));
    const r = await client.update(commitIntention(o, PERSON('board'), p.occurredAt));
    assert.equal(r.outcome, 'APPLIED', `A1: the commit by the board actor is APPLIED (${JSON.stringify(r).slice(0, 300)})`);
    const got = await M.readCommittedOrigin(client, o.mid);
    assert.equal(got.ok, true, `A1: the committed join reads ok (${JSON.stringify(got).slice(0, 300)})`);
    // the committed Origin carries its actor inside originKeyJson (the closed tuple), not as a field of its own (measured 12:06Z)
    assert.equal(JSON.parse(got.committed.origin.originKeyJson)[4], 'board', `A1: the origin key's actor reads back as board (${got.committed.origin.originKeyJson})`);
    assert.equal(got.committed.reservations.length, 1, 'A1: one reservation');
    const s = o.descriptor.slots[0];
    assert.deepEqual(got.committed.reservations[0].draft, canonAnnouncementDraft({ body: s.body, author: s.author, originActor: 'board', occurredAt: p.occurredAt, mentions: s.mentions, notify: s.notify }), 'A1: the reservation draft carries originActor board');
    assert.ok((await cardTriples(client, c.id)).some((t) => t.includes('claimedBy') && t.endsWith('/person/board')), 'A1: the business change landed, claimed by the board person');
    // CONTROL: the same shape with an EMPTY originActor never reaches the store
    const empty = claimOrigin(e, 'k-a1e', '');
    const before = await gated(client);
    let threw = null, outcome = null;
    try { canonicalize(prepareIntention(empty, PERSON('board'))); } catch (err) { threw = err; }
    if (!threw) { const x = await client.update(prepareIntention(empty, PERSON('board'))); outcome = x.outcome; }
    assert.ok(threw || (outcome && outcome !== 'APPLIED'), `A1 CONTROL: an empty originActor is refused (threw: ${threw?.message?.slice(0, 120) ?? 'no'}; outcome: ${outcome})`);
    assert.deepEqual(await gated(client), before, 'A1 CONTROL: and nothing was written for it');
  }, [c, e]);
});

test('#1629 s3 (RA0) a preparation applies by its guards, not by its request\'s fate: (a) an unrelated move leaves it committable; (b) its own card moving refuses it with no effect', T, async () => {
  const a = card('ra0a', 1), b = card('ra0b', 2), other = card('ra0x', 3);
  await world(async ({ client }) => {
    const oa = claimOrigin(a, 'k-ra0a', 'ada'), ob = claimOrigin(b, 'k-ra0b', 'ada');
    const pa = await prepare(client, oa, PERSON('ada'));
    const pb = await prepare(client, ob, PERSON('ada'));
    // the requests that prepared these are over; nothing here sends them again
    assert.equal((await client.update({ kind: 'card.write', opId: `urn:ex:op/card/og1629c-other-${process.pid}`, actor: PERSON('ada'), parts: [cpart({ ...other, version: 2, title: 'unrelated move' }, '1', other)] })).outcome, 'APPLIED', 'PRECONDITION: an UNRELATED card moved');
    assert.equal((await client.update({ kind: 'card.write', opId: `urn:ex:op/card/og1629c-conflict-${process.pid}`, actor: PERSON('ada'), parts: [cpart({ ...b, version: 2, title: 'b moved on' }, '1', b)] })).outcome, 'APPLIED', 'PRECONDITION: card b itself moved (a conflicting change)');
    // (a) still committable
    const ra = await client.update(commitIntention(oa, PERSON('ada'), pa.occurredAt));
    assert.equal(ra.outcome, 'APPLIED', `RA0(a): a preparation whose request ended, with no conflicting change, still commits (${JSON.stringify(ra).slice(0, 300)})`);
    assert.equal((await M.readCommittedOrigin(client, oa.mid)).ok, true, 'RA0(a): and its join reads ok');
    // (b) refused, nothing moved
    const cardBefore = await cardTriples(client, b.id), gatedBefore = await gated(client);
    const rb = await client.update(commitIntention(ob, PERSON('ada'), pb.occurredAt));
    assert.equal(rb.outcome, 'PRECONDITION_FAILED', `RA0(b): after its own card moved, the preparation is refused (${JSON.stringify(rb).slice(0, 300)})`);
    assert.deepEqual(await cardTriples(client, b.id), cardBefore, 'RA0(b): card b is unchanged');
    assert.deepEqual(await gated(client), gatedBefore, 'RA0(b): no origin, obligation, reservation or allocator change');
    const committed = await M.readCommittedOrigin(client, ob.mid);
    // an absent commit reads { ok: true, committed: null } (measured 12:06Z), so the absence is the null, not a false ok
    assert.equal(committed.ok, true, `RA0(b): the read itself answered (${JSON.stringify(committed).slice(0, 200)})`);
    assert.equal(committed.committed, null, `RA0(b): and there is no committed origin for it (${JSON.stringify(committed).slice(0, 200)})`);
  }, [a, b, other]);
});
