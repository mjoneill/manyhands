/**
 * #1471 — `graph_assert` can take a PERSON (a roster seat) as subject, for the
 * one predicate that needs it: `scrum:dependsOn` ("which seats are hurt if X
 * breaks?").
 *
 * Shape (A), decided on the card: a Person has NO record of its own —
 * core/people.mjs re-derives people from the roster on every save — so the edge
 * is STORED on the OBJECT card (`dependentSeats`) and PROJECTED with the person
 * as subject. That makes it a triple with a FOREIGN subject, and subject-scoped
 * deletion gets both of its ends wrong:
 *
 *   the person is re-projected → the edge sits under the person's subject and
 *                                would be WIPED while the card still asserts it
 *   the card drops the seat    → the old edge is not under the card's subject
 *                                and would SURVIVE as a stale row
 *
 * Either way the synced store stops agreeing with a rebuilt one. The replica
 * tests below pin both, against a rebuild; the REST tests pin the verb.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraphStore, queryGraph, syncGraphStore } from '../core/graph-replica.mjs';
import { domainToJsonLd, PERSON_IRI_BASE } from '../core/jsonld.mjs';
import { startRestServer } from './helpers/harness.mjs';

const PFX = 'PREFIX scrum: <https://scrumboard.local/ns#>\nPREFIX schema: <https://schema.org/>\n';
const rows = async (store, q) => { const r = await queryGraph(store, PFX + q); return r.rows ?? r; };
const DEPENDENTS = 'SELECT ?p ?id WHERE { ?p scrum:dependsOn ?c . ?c schema:identifier ?id } ORDER BY ?id ?p';

const card = (id, shortId, dependentSeats) => ({
  '@type': 'CreativeWork', '@id': id, identifier: shortId, name: `substrate ${shortId}`, text: '',
  additionalType: 'scrum:goal',
  board: { column: 'backlog', ...(dependentSeats ? { dependentSeats } : {}) },
});
const person = (key, name) => ({
  '@type': 'Person', '@id': PERSON_IRI_BASE + key, identifier: key, name, 'scrum:resolved': true,
});
const doc = ({ seatsOn1 = ['robin'], seatsOn2 = ['sage'], robinName = 'Robin' } = {}) => domainToJsonLd({
  nodes: [card('u-1', 1, seatsOn1), card('u-2', 2, seatsOn2)],
  messages: [], columns: [],
  people: [person('robin', robinName), person('sage', 'Sage')],
});
// The query layer hands IRIs back in prefixed form (`person:robin`); accept both.
const seatOf = (iri) => String(iri).replace(PERSON_IRI_BASE, '').replace(/^person:/, '');
const shape = (rs) => rs.map((r) => `${seatOf(r.p)}→#${r.id}`);

test('#1471 the edge projects with the PERSON as subject — the registered direction', async () => {
  const store = await buildGraphStore(doc());
  assert.deepEqual(shape(await rows(store, DEPENDENTS)), ['robin→#1', 'sage→#2']);
});

test('#1471 ⛔ re-projecting the PERSON does not wipe an edge the card still asserts', async () => {
  // A roster re-derive changes the Person entity (here: its name), so the sync
  // re-projects it and deletes everything under its subject. The dependsOn
  // triple is under that subject but is OWNED by card #1.
  const store = await buildGraphStore(doc());
  const { hashes } = syncGraphStore(store, doc(), null);
  syncGraphStore(store, doc({ robinName: 'Robin R.' }), hashes);

  const anchor = await rows(store, `SELECT ?n WHERE { <${PERSON_IRI_BASE}robin> schema:name ?n }`);
  assert.equal(String(anchor[0]?.n), 'Robin R.', 'anchor: the person WAS re-projected, or this test proves nothing');
  const synced = shape(await rows(store, DEPENDENTS));
  const rebuilt = shape(await rows(await buildGraphStore(doc({ robinName: 'Robin R.' })), DEPENDENTS));
  assert.deepEqual(synced, ['robin→#1', 'sage→#2'], 'the person\'s re-projection must keep the card-owned edge');
  assert.deepEqual(synced, rebuilt, 'PARITY with a rebuild');
});

test('#1471 ⛔ a card that DROPS a seat drops the edge — no stale row survives', async () => {
  const store = await buildGraphStore(doc());
  const { hashes } = syncGraphStore(store, doc(), null);
  syncGraphStore(store, doc({ seatsOn1: [] }), hashes);

  const synced = shape(await rows(store, DEPENDENTS));
  const rebuilt = shape(await rows(await buildGraphStore(doc({ seatsOn1: [] })), DEPENDENTS));
  assert.deepEqual(rebuilt, ['sage→#2'], 'a rebuild holds only the surviving edge');
  assert.deepEqual(synced, rebuilt, 'PARITY: a removed dependent must not live on in the synced store');
});

test('#1471 and it does not OVER-collect: another card\'s dependents survive', async () => {
  // The paired half of the sweep (#687's lesson): card #1 changing must not
  // take card #2's inbound edge with it.
  const store = await buildGraphStore(doc());
  const { hashes } = syncGraphStore(store, doc(), null);
  syncGraphStore(store, doc({ seatsOn1: ['robin', 'sage'] }), hashes);
  assert.deepEqual(shape(await rows(store, DEPENDENTS)), ['robin→#1', 'sage→#1', 'sage→#2']);
});

// ── the verb ────────────────────────────────────────────────────────────────

const post = (base, p, body) => fetch(`${base}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const assertOne = (base, subject, predicate, object) =>
  post(base, '/api/assert', { by: 'ada', assertions: [{ subject, predicate, object }] });

async function withServer(fn) {
  const s = await startRestServer({});
  try {
    for (const [name, definition] of [
      ['scrum:dependsOn', 'A RUNTIME DEPENDENCY: a seat cannot function without the object substrate. NOT a card → card edge.'],
      ['scrum:blockedBy', 'A work-order constraint between two CARDS.'],
    ]) {
      const r = await post(s.baseUrl, '/api/predicates', { name, definition, by: 'ada' });
      assert.ok([200, 201, 409].includes(r.status), `${name}: ${r.status} ${await r.text()}`);
    }
    const mk = async (title) => {
      const r = await post(s.baseUrl, '/api/cards', { title, by: 'ada', column: 'backlog' });
      const raw = await r.text();
      assert.equal(r.status, 201, raw);
      return JSON.parse(raw).shortId;
    };
    return await fn(s, mk);
  } finally { await s.stop(); }
}
const dependentsOf = async (base, shortId) => {
  const r = await post(base, '/api/graph', {
    query: `SELECT ?p WHERE { ?p scrum:dependsOn ?c . ?c schema:identifier "${shortId}" }`,
  });
  const body = await r.json();
  return (body.rows || []).map((x) => seatOf(x.p));
};

test('#1471 ⭐ person:<seat> dependsOn <card> lands, is stored on the card, and queries back', async () => {
  await withServer(async (s, mk) => {
    const substrate = await mk('a substrate apex');
    const r = await assertOne(s.baseUrl, 'person:robin', 'scrum:dependsOn', substrate);
    const raw = await r.text();
    assert.equal(r.status, 200, raw);
    assert.equal(JSON.parse(raw).applied, 1);

    const cardBody = await (await fetch(`${s.baseUrl}/api/cards/${substrate}`)).json();
    assert.deepEqual((cardBody.card ?? cardBody).dependentSeats, ['robin'], 'where a human finds it: on the card');
    assert.deepEqual(await dependentsOf(s.baseUrl, substrate), ['robin']);

    // The full IRI resolves too, and a repeat is a noop.
    const again = await (await assertOne(s.baseUrl, `${PERSON_IRI_BASE}robin`, 'scrum:dependsOn', substrate)).json();
    assert.equal(again.applied, 0);
    assert.equal(again.results[0].effect, 'noop');
  });
});

test('#1471 the edge survives later writes to its card', async () => {
  await withServer(async (s, mk) => {
    const substrate = await mk('a substrate apex');
    assert.equal((await assertOne(s.baseUrl, 'person:robin', 'scrum:dependsOn', substrate)).status, 200);
    const other = await mk('an unrelated card');
    assert.equal((await assertOne(s.baseUrl, 'person:sage', 'scrum:dependsOn', substrate)).status, 200);
    assert.ok(other);
    assert.deepEqual((await dependentsOf(s.baseUrl, substrate)).sort(), ['robin', 'sage']);
  });
});

test('#1471 refusals: an unknown seat, a person on a card-only predicate, a card subject, a non-card object', async () => {
  await withServer(async (s, mk) => {
    const a = await mk('substrate');
    const b = await mk('another card');
    const cases = [
      ['person:zed', 'scrum:dependsOn', a, /does not resolve/, 'a seat not on the roster'],
      ['person:robin', 'scrum:blockedBy', a, /no store mapping for a PERSON subject/, 'person subject, card-only predicate'],
      [b, 'scrum:dependsOn', a, /takes a PERSON subject/, 'card → card is the NOT clause'],
      ['person:robin', 'scrum:dependsOn', 'not-a-card', /does not resolve to a card/, 'object must be a card'],
      ['robin', 'scrum:dependsOn', a, /does not resolve/, 'a bare word is not a node reference'],
    ];
    for (const [subject, predicate, object, re, why] of cases) {
      const r = await assertOne(s.baseUrl, subject, predicate, object);
      const raw = await r.text();
      assert.equal(r.status, 400, `${why}: expected a refusal, got ${r.status} ${raw}`);
      assert.match(JSON.parse(raw).error, re, why);
    }
    assert.deepEqual(await dependentsOf(s.baseUrl, a), [], 'nothing was applied by any refusal');
  });
});
