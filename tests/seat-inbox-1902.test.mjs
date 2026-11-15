/**
 * #1902 Half 1, slice 1 — the board knows what each seat is owed and what its credential has retrieved. THE PURE RULES AND
 * THE TWO RECORD KINDS, against a real scratch executor. The REST rows are tests/seat-inbox-rest-1902.test.mjs.
 *
 * INTERFACE PINNED HERE:
 *   core/seat-inbox.mjs  seatIndex(roster) · mentionedSeats(text, index) · concernedSeats(post, { index, talk })
 *   delivery.retrieved { target: <delivery IRI>, seat, at }   actor: urn:ex:seat/<seat> (the credential that fetched)
 *     ON THE DELIVERY NODE ITSELF, beside its steps and never one of them: scrum:retrievedAt "at" · scrum:retrievedBy <actor>.
 *     Its version (urn:ex:ver) and its steps are untouched, so the runner's next legal step is what it was. Once per row.
 *   seat.latestFetched { node, seat, post, seq, postAt, at }   actor: urn:ex:seat/<seat>
 *     at latest-fetched/<seat>: scrum:latestFetchedBy <actor> · scrum:latestFetchedPost <post> · scrum:latestFetchedSeq n ·
 *     scrum:latestFetchedPostAt · scrum:latestFetchedAt. ONE node per seat, its values replaced; never moves backwards.
 *
 *   C1  concerns: a key, a display name and an alias each name the seat; a post naming nobody concerns nobody
 *   C2  concerns: never the author, never a system seat or an excluded identity, never a name the roster does not hold
 *   C3  concerns: a 1:1 talk's participants other than the author; a redacted post concerns no one
 *   K1  the two kinds compile; an IRI not derived from its parts, or an actor that is not the seat, is refused
 *   K2  delivery.retrieved lands on a delivery for that seat, ONCE; never on another seat's delivery or on a non-delivery
 *   K3  delivery.retrieved leaves the delivery's version and steps exactly as they were (a fact beside the stages)
 *   K4  seat.latestFetched replaces its values, refuses an equal or lower sequence, and holds one node per seat
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createGraphClient, WRITE_PROTOCOL, WRITE_PROTOCOL_HEADER } from '../core/graph-client.mjs';
import { compile } from '../core/graph-compiler.mjs';
import { HAVE_PY, PY, startExecutor, killExecutor, tmpStore } from './helpers/graph-executor-proc.mjs';
import { seatIndex, mentionedSeats, concernedSeats } from '../core/seat-inbox.mjs';
import { deliveryIriOf, deliveryQuery, splitDeliveryRows, deliveryFromRows, retrievedIntention, latestFetchedIntention, latestFetchedIri } from '../core/unit3-graph.mjs';

const SKIP = HAVE_PY ? false : `UNAVAILABLE: no python with pyoxigraph at ${PY} (a skip is not a pass)`;
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RS = 'https://scrumboard.local/ns#';
const at = () => new Date().toISOString();
const SEAT = (k) => `urn:ex:seat/${k}`;

// a fixture roster: invented seats, one with an alias, one system seat
const ROSTER = {
  ada: { name: 'Ada' }, gizmo: { name: 'Gizmo', aliases: ['Giz'] }, hal: { name: 'Hal' },
  board: { name: 'board', kind: 'system' }, wiki: { name: 'wiki', kind: 'system' }, sprocket: { name: 'Sprocket', kind: 'system' },
};
const IX = seatIndex(ROSTER);
const post = (body, extra = {}) => ({ id: crypto.randomUUID(), author: 'ada', body, mentions: [], ...extra });

test('C1 a key, a display name and an alias each name the seat; a post naming nobody concerns nobody', () => {
  assert.deepEqual(concernedSeats(post('ping @gizmo'), { index: IX }), ['gizmo']);
  assert.deepEqual(concernedSeats(post('ping @Gizmo please'), { index: IX }), ['gizmo'], 'the display name, any case');
  assert.deepEqual(concernedSeats(post('ping @giz'), { index: IX }), ['gizmo'], 'an alias the roster records');
  assert.deepEqual(concernedSeats(post('@GIZMO and @hal'), { index: IX }), ['gizmo', 'hal']);
  assert.deepEqual(concernedSeats(post('nobody in particular'), { index: IX }), [], 'a post naming no seat concerns no one');
  assert.deepEqual(concernedSeats(post('stored mention only', { mentions: ['hal'] }), { index: IX }), ['hal'], 'the post\'s stored canonical mentions count');
});

// #1902 PO decision 2026-11-15: a whole-word, case-insensitive name counts without `@`; a human person's seat never gets a row
const IX2 = seatIndex({ ...ROSTER, nimbus: { name: 'Pippa' }, ash: { name: 'Ash' }, pat: { name: 'Pat', kind: 'human' }, 'ölaf': { name: 'Ölaf' } });
test('C4 a bare whole-word name, key or alias counts, any case; a longer word containing it does not', () => {
  assert.deepEqual(concernedSeats(post('Pippa, can you look'), { index: IX2 }), ['nimbus'], 'the display name, bare');
  assert.deepEqual(concernedSeats(post('hand me the ashtray'), { index: IX2 }), [], 'ashtray is not ash');
  assert.deepEqual(concernedSeats(post('ash and GIZ, both of you'), { index: IX2 }), ['ash', 'gizmo'], 'two seats, one each');
  assert.deepEqual(concernedSeats(post('ash\'s turn; pippa-style'), { index: IX2 }), ['ash', 'nimbus'], 'punctuation is a boundary');
  assert.deepEqual(concernedSeats(post('ÖLAF, bitte'), { index: IX2 }), ['ölaf'], 'Unicode: case folds, and Ö is a letter');
  assert.deepEqual(concernedSeats(post('Ölafsson is someone else'), { index: IX2 }), [], 'Unicode word boundary');
  assert.deepEqual(concernedSeats(post('gizmos everywhere'), { index: IX2 }), []);
});

test('C5 never the author naming herself, never a seat the roster marks as a human person', () => {
  assert.deepEqual(concernedSeats(post('ash here, as ash', { author: 'ash' }), { index: IX2 }), [], 'a seat naming herself');
  assert.deepEqual(concernedSeats(post('Pat, can you look', {}), { index: IX2 }), [], 'kind: human is never offered a row');
  assert.deepEqual(concernedSeats(post('stored', { mentions: ['pat'] }), { index: IX2 }), []);
  assert.equal(IX2.eligible.has('pat'), false);
  assert.deepEqual(concernedSeats(post('in the talk', { conversation: 't' }), { index: IX2, talk: { with: 'ash', openedBy: 'pat' } }), ['ash'], 'a talk opened by a human: only the seat');
});

test('C2 never the author, a system seat, an excluded identity, or a name the roster does not hold', () => {
  assert.deepEqual(concernedSeats(post('@ada talking to myself and @gizmo'), { index: IX }), ['gizmo'], 'the author is never offered her own post');
  assert.deepEqual(concernedSeats(post('@board @wiki @sprocket @unassigned @nobody'), { index: IX }), []);
  assert.deepEqual(mentionedSeats('mail me@gizmo.com or @gizmo', IX), ['gizmo']);
  assert.equal(IX.eligible.has('board'), false); assert.equal(IX.eligible.has('sprocket'), false);
});

test('C3 a talk\'s participants other than the author; a redacted post concerns no one', () => {
  const talk = { with: 'gizmo', openedBy: 'ada' };
  assert.deepEqual(concernedSeats(post('no names here', { conversation: 't1' }), { index: IX, talk }), ['gizmo'], 'ada wrote in her talk with gizmo');
  assert.deepEqual(concernedSeats(post('reply', { author: 'gizmo', conversation: 't1' }), { index: IX, talk }), ['ada']);
  assert.deepEqual(concernedSeats(post('room post', { conversation: null }), { index: IX, talk }), [], 'a talk is used only for a post in it');
  assert.deepEqual(concernedSeats({ id: 'x', redacted: true, body: null, author: 'redacted' }, { index: IX }), []);
});

// ── the two record kinds ──────────────────────────────────────────────────────────────────────────────────────────────
const POSTI = (id) => `https://scrumboard.local/entity/${id}`;

test('K1 the two kinds compile; a non-derived IRI or an actor that is not the seat is refused', () => {
  const d = deliveryIriOf('gizmo', 'p1');
  const r = retrievedIntention({ delivery: d, seat: 'gizmo', actor: SEAT('gizmo'), at: '2026-11-15T03:00:00.000Z' });
  assert.equal(r.kind, 'delivery.retrieved');
  assert.doesNotThrow(() => compile(r));
  assert.throws(() => compile({ ...r, actor: SEAT('hal') }), /actor/);
  assert.throws(() => compile({ ...r, target: 'https://scrumboard.local/entity/p1' }), /delivery/);
  const f = latestFetchedIntention({ seat: 'gizmo', actor: SEAT('gizmo'), post: POSTI('p1'), seq: 7, postAt: '2026-11-15T02:00:00.000Z', at: '2026-11-15T03:00:00.000Z' });
  assert.equal(f.kind, 'seat.latestFetched');
  assert.equal(f.node, latestFetchedIri('gizmo'));
  assert.doesNotThrow(() => compile(f));
  assert.throws(() => compile({ ...f, node: latestFetchedIri('hal') }), /latest-fetched/);
  assert.throws(() => compile({ ...f, actor: SEAT('hal') }), /actor/);
  assert.throws(() => compile({ ...f, seq: 0 }), /seq/);
});

let exec, client, storeDir;
before(async () => {
  if (SKIP) return;
  storeDir = tmpStore('si-1902-');
  exec = await startExecutor({ store: storeDir, datasetId: 'si-1902', create: true });
  client = createGraphClient({ baseUrl: exec.baseUrl, expectedDatasetId: 'si-1902', timeoutMs: 30000 });
});
after(async () => { await killExecutor(exec); if (storeDir) fs.rmSync(storeDir, { recursive: true, force: true }); });
const q = async (sparql) => { const r = await client.query(sparql); assert.ok(r.ok, `query failed: ${r.reason}`); return r.rows; };
const count = async (where) => Number((await q(`SELECT (COUNT(*) AS ?n) WHERE { ${where} }`))[0].n.value);
/** A delivery offered to `to` and claimed, through the existing kinds (the runner's path). */
async function claimedDelivery(to) {
  const pid = crypto.randomUUID();
  const iri = deliveryIriOf(to, pid); const t = at();
  const c = await client.update({ kind: 'delivery.create', opId: `urn:ex:op/delivery/${iri.split('/').pop()}/create`, actor: 'https://scrumboard.local/person/board',
    delivery: { iri, deliveredTo: to, ofConversation: POSTI(pid), source: 'fanout', offeredAt: t, step: { iri: `${iri}/step/1`, index: '1', state: 'offered', at: t, source: 'fanout', creator: 'board' } } });
  assert.equal(c.outcome, 'APPLIED', JSON.stringify(c));
  const s = await client.update({ kind: 'delivery.step', opId: `urn:ex:op/delivery/${iri.split('/').pop()}/req/claim-${crypto.randomUUID()}`, actor: `https://scrumboard.local/person/${to}`,
    target: { iri, expectedVersion: '1' }, step: { iri: `${iri}/step/2`, index: '2', state: 'claimed', at: at(), source: 'guest-runner', creator: to, attempt: 1 } });
  assert.equal(s.outcome, 'APPLIED', JSON.stringify(s));
  return { iri, pid };
}
const delivery = async (iri) => { const { nodeRows, stepRows } = splitDeliveryRows(iri, await q(deliveryQuery(iri))); return deliveryFromRows(iri, nodeRows, stepRows); };

test('K2 delivery.retrieved lands on that seat\'s delivery ONCE; never on another seat\'s, never on a non-delivery', { skip: SKIP }, async () => {
  const { iri } = await claimedDelivery('gizmo');
  const first = await client.update(retrievedIntention({ delivery: iri, seat: 'gizmo', actor: SEAT('gizmo'), at: at() }));
  assert.equal(first.outcome, 'APPLIED', JSON.stringify(first));
  assert.equal(await count(`<${iri}> <${RS}retrievedAt> ?t ; <${RS}retrievedBy> <${SEAT('gizmo')}>`), 1);
  const second = await client.update(retrievedIntention({ delivery: iri, seat: 'gizmo', actor: SEAT('gizmo'), at: at() }));
  assert.notEqual(second.outcome, 'APPLIED', 'a second mark is refused');
  assert.equal(await count(`<${iri}> <${RS}retrievedAt> ?t`), 1, 'still one mark');
  const other = await claimedDelivery('hal');
  const wrong = await client.update(retrievedIntention({ delivery: other.iri, seat: 'gizmo', actor: SEAT('gizmo'), at: at() }));
  assert.equal(wrong.outcome, 'PRECONDITION_FAILED', 'gizmo cannot mark hal\'s row');
  const none = await client.update(retrievedIntention({ delivery: deliveryIriOf('gizmo', crypto.randomUUID()), seat: 'gizmo', actor: SEAT('gizmo'), at: at() }));
  assert.equal(none.outcome, 'PRECONDITION_FAILED', 'no row, no mark');
  assert.equal(await count(`<${other.iri}> <${RS}retrievedAt> ?t`), 0);
});

test('K3 the mark leaves the delivery\'s version and steps exactly as they were; the next step still applies', { skip: SKIP }, async () => {
  const { iri } = await claimedDelivery('gizmo');
  const before = await delivery(iri);
  assert.equal((await client.update(retrievedIntention({ delivery: iri, seat: 'gizmo', actor: SEAT('gizmo'), at: at() }))).outcome, 'APPLIED');
  const afterMark = await delivery(iri);
  assert.equal(afterMark.ver, before.ver, 'the version is unchanged');
  assert.deepEqual(afterMark.entity['scrum:hasEvent'], before.entity['scrum:hasEvent'], 'the steps are unchanged');
  const t = await client.update({ kind: 'delivery.step', opId: `urn:ex:op/delivery/${iri.split('/').pop()}/req/ts-${crypto.randomUUID()}`, actor: 'https://scrumboard.local/person/gizmo',
    target: { iri, expectedVersion: String(before.ver) }, step: { iri: `${iri}/step/${before.ver + 1}`, index: String(before.ver + 1), state: 'turn-started', at: at(), source: 'guest-runner', creator: 'gizmo', attempt: 1 } });
  assert.equal(t.outcome, 'APPLIED', 'the runner\'s next step, written against the version it read before the mark, still applies');
});

test('K4 seat.latestFetched replaces its values, never moves backwards or sideways, one node per seat', { skip: SKIP }, async () => {
  const w = (seq) => client.update(latestFetchedIntention({ seat: 'gizmo', actor: SEAT('gizmo'), post: POSTI(`p${seq}`), seq, postAt: at(), at: at() }));
  assert.equal((await w(5)).outcome, 'APPLIED');
  assert.equal((await w(9)).outcome, 'APPLIED');
  assert.equal((await w(7)).outcome, 'PRECONDITION_FAILED', 'a lower sequence is refused');
  assert.notEqual((await w(9)).outcome, 'APPLIED', 'an equal sequence is refused (the same move twice is one op: a resend with another time is an intent collision)');
  const N = latestFetchedIri('gizmo');
  const rows = await q(`SELECT ?seq ?post WHERE { <${N}> <${RS}latestFetchedSeq> ?seq ; <${RS}latestFetchedPost> ?post }`);
  assert.equal(rows.length, 1, 'one value, replaced, not accumulated');
  assert.equal(rows[0].seq.value, '9'); assert.equal(rows[0].post.value, POSTI('p9'));
  assert.equal(await count(`?n <${RS}latestFetchedBy> <${SEAT('gizmo')}>`), 1, 'one node for the seat');
  assert.equal(await count(`<${N}> <${RDF}type> ?t`), 0, 'no new rdf:type: nothing for the kind registry to declare');
});
