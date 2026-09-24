/**
 * #1474 — a seat's dependency on a substrate can be ENDED, and the ending is
 * RECORDED rather than deleted (#1469 P8: "removed from current, still
 * answerable as former").
 *
 *   current  → `person:X scrum:dependsOn <card>`, one hop, no record
 *   ended    → no dependsOn; a scrum:DependencyRecord under
 *              <card>/dependency/<seat>/<endedAt> carrying scrum:dependent,
 *              scrum:endedAt, scrum:endedBy and scrum:note (the reason)
 *
 * The record is a derived node owned by the card (the Blocker/ReleaseCondition
 * family), so the replica tests check it against a REBUILD, as #1471's did.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraphStore, queryGraph, syncGraphStore } from '../core/graph-replica.mjs';
import { domainToJsonLd, PERSON_IRI_BASE } from '../core/jsonld.mjs';
import { startRestServer } from './helpers/harness.mjs';

const PFX = 'PREFIX scrum: <https://scrumboard.local/ns#>\nPREFIX schema: <https://schema.org/>\n';
const rows = async (store, q) => { const r = await queryGraph(store, PFX + q); return r.rows ?? r; };
const seatOf = (iri) => String(iri).replace(PERSON_IRI_BASE, '').replace(/^person:/, '');
const CURRENT = 'SELECT ?p WHERE { ?p scrum:dependsOn ?c . ?c schema:identifier "1" } ORDER BY ?p';
const RECORDS = `SELECT ?who ?at ?by ?why WHERE {
  ?r a scrum:DependencyRecord ; scrum:dependent ?who ; scrum:endedAt ?at .
  OPTIONAL { ?r scrum:endedBy ?by } OPTIONAL { ?r scrum:note ?why } } ORDER BY ?at`;

const ended = (seat, endedAt, reason = 'moved off this substrate') =>
  ({ seat, endedAt, endedBy: 'kit', reason });
const card = (seats) => ({
  '@type': 'CreativeWork', '@id': 'u-1', identifier: 1, name: 'substrate', text: '',
  additionalType: 'scrum:goal', board: { column: 'backlog', dependentSeats: seats },
});
const doc = (seats, { withCard = true } = {}) => domainToJsonLd({
  nodes: withCard ? [card(seats)] : [], messages: [], columns: [],
  people: ['robin', 'kit'].map((k) => ({ '@type': 'Person', '@id': PERSON_IRI_BASE + k, identifier: k, name: k })),
});
const recShape = (rs) => rs.map((r) => `${seatOf(r.who)}@${r.at} by ${seatOf(r.by)}: ${r.why}`);

test('#1474 an ENDED entry projects a DependencyRecord and NO dependsOn', async () => {
  const store = await buildGraphStore(doc([ended('robin', '2026-09-24T21:00:00Z')]));
  assert.deepEqual((await rows(store, CURRENT)).map((r) => seatOf(r.p)), [], 'an ended dependency is not current');
  assert.deepEqual(recShape(await rows(store, RECORDS)),
    ['robin@2026-09-24T21:00:00Z by kit: moved off this substrate'], 'answerable as former: who, when, who ended it, why');
});

test('#1474 ⛔ current → ended through a SYNC matches a rebuild', async () => {
  const store = await buildGraphStore(doc(['robin']));
  const { hashes } = syncGraphStore(store, doc(['robin']), null);
  const next = doc([ended('robin', '2026-09-24T21:00:00Z')]);
  syncGraphStore(store, next, hashes);
  const rebuilt = await buildGraphStore(next);
  assert.deepEqual(await rows(store, CURRENT), await rows(rebuilt, CURRENT), 'the dependsOn triple is gone in both');
  assert.deepEqual(recShape(await rows(store, RECORDS)), recShape(await rows(rebuilt, RECORDS)), 'PARITY on the record');
  assert.equal((await rows(store, RECORDS)).length, 1);
});

test('#1474 two endings leave TWO records, not one merged node', async () => {
  const seats = [ended('robin', '2026-09-24T20:00:00Z', 'first'), ended('robin', '2026-09-24T21:00:00Z', 'second')];
  const store = await buildGraphStore(doc(seats));
  assert.deepEqual((await rows(store, RECORDS)).map((r) => String(r.why)), ['first', 'second']);
});

test('#1474 ⛔ removing the card sweeps its records (no orphan survives a sync)', async () => {
  const store = await buildGraphStore(doc([ended('robin', '2026-09-24T21:00:00Z')]));
  const { hashes } = syncGraphStore(store, doc([ended('robin', '2026-09-24T21:00:00Z')]), null);
  syncGraphStore(store, doc([], { withCard: false }), hashes);
  assert.deepEqual(await rows(store, RECORDS), [], 'a record owned by a removed card must not outlive it');
});

// ── the verb ────────────────────────────────────────────────────────────────

const post = (base, p, body) => fetch(`${base}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const assertAll = (base, assertions, by = 'kit') => post(base, '/api/assert', { by, assertions });
const dep = (object, extra = {}) => ({ subject: 'person:robin', predicate: 'scrum:dependsOn', object, ...extra });

async function withServer(fn) {
  const s = await startRestServer({});
  try {
    for (const [name, definition] of [
      ['scrum:dependsOn', 'A RUNTIME DEPENDENCY of a seat on a substrate card.'],
      ['scrum:blockedBy', 'A work-order constraint between two CARDS.'],
    ]) {
      const r = await post(s.baseUrl, '/api/predicates', { name, definition, by: 'kit' });
      assert.ok([200, 201, 409].includes(r.status));
    }
    const c = await (await post(s.baseUrl, '/api/cards', { title: 'substrate', by: 'kit', column: 'backlog' })).json();
    return await fn(s, c.shortId);
  } finally { await s.stop(); }
}
const graph = async (base, q) => (await (await post(base, '/api/graph', { query: q })).json()).rows || [];
const cardSeats = async (base, id) => { const b = await (await fetch(`${base}/api/cards/${id}`)).json(); return (b.card ?? b).dependentSeats; };

test('#1474 ⭐ end records the ending: gone from current, answerable as former', async () => {
  await withServer(async (s, id) => {
    assert.equal((await assertAll(s.baseUrl, [dep(id)])).status, 200);
    const r = await assertAll(s.baseUrl, [dep(id, { op: 'end', reason: 'moved to another substrate' })]);
    const raw = await r.text();
    assert.equal(r.status, 200, raw);
    assert.equal(JSON.parse(raw).results[0].effect, 'dependency-ended');

    const seats = await cardSeats(s.baseUrl, id);
    assert.equal(seats.length, 1);
    assert.equal(seats[0].seat, 'robin');
    assert.equal(seats[0].endedBy, 'kit');
    assert.equal(seats[0].reason, 'moved to another substrate');
    assert.ok(seats[0].endedAt, 'server-stamped');

    assert.deepEqual(await graph(s.baseUrl, `SELECT ?p WHERE { ?p scrum:dependsOn ?c . ?c schema:identifier "${id}" }`), []);
    const recs = await graph(s.baseUrl, 'SELECT ?who ?why WHERE { ?r a scrum:DependencyRecord ; scrum:dependent ?who ; scrum:note ?why }');
    assert.deepEqual(recs.map((x) => [seatOf(x.who), String(x.why)]), [['robin', 'moved to another substrate']]);
  });
});

test('#1474 end again is a noop; depending again keeps the old record beside a new current edge', async () => {
  await withServer(async (s, id) => {
    await assertAll(s.baseUrl, [dep(id)]);
    await assertAll(s.baseUrl, [dep(id, { op: 'end', reason: 'r1' })]);
    const again = await (await assertAll(s.baseUrl, [dep(id, { op: 'end', reason: 'r2' })])).json();
    assert.equal(again.results[0].effect, 'noop', 'already ended, not current');
    assert.equal((await assertAll(s.baseUrl, [dep(id)])).status, 200, 're-depending is allowed');
    const seats = await cardSeats(s.baseUrl, id);
    assert.equal(seats.filter((x) => x === 'robin').length, 1, 'current again');
    assert.equal(seats.filter((x) => x && typeof x === 'object').length, 1, 'the first ending is still on the record');
  });
});

test('#1474 refusals: no reason, never depended, unknown op, end on a non-person subject', async () => {
  await withServer(async (s, id) => {
    const other = (await (await post(s.baseUrl, '/api/cards', { title: 'other', by: 'kit', column: 'backlog' })).json()).shortId;
    await assertAll(s.baseUrl, [dep(id)]);
    const cases = [
      [dep(id, { op: 'end' }), /needs a reason/, 'no reason'],
      [dep(id, { op: 'end', reason: '   ' }), /needs a reason/, 'a blank reason is no reason'],
      [dep(other, { op: 'end', reason: 'x' }), /no dependency on card/, 'never depended'],
      [dep(id, { op: 'retract', reason: 'x' }), /op must be/, 'unknown op is refused, never read as assert'],
      [{ subject: id, predicate: 'scrum:blockedBy', object: other, op: 'end', reason: 'x' }, /only defined for scrum:dependsOn/, 'end on a card subject'],
    ];
    for (const [a, re, why] of cases) {
      const r = await assertAll(s.baseUrl, [a]);
      const raw = await r.text();
      assert.equal(r.status, 400, `${why}: ${raw}`);
      assert.match(JSON.parse(raw).error, re, why);
    }
    assert.deepEqual(await cardSeats(s.baseUrl, id), ['robin'], 'no refusal changed anything');
  });
});
