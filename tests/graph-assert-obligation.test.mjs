/**
 * #1118 slice B — THE FIRST ASSERTION WHOSE SUBJECT IS NOT A CARD.
 *
 * Decision aad42bf5 (Option D) promised "any node type". #945 slice 2 shipped
 * the verb with three mappings, all card-subject. This slice adds one row —
 * scrum:dischargedBy(obligation, person | full sha) → the obligation closes —
 * and in doing so teaches the verb to resolve a non-card subject. That is the
 * evidence #1113's deferred store ruling waits on: can the verb earn its keep
 * beyond cards without a parallel storage shape? Everything here rides the
 * same lock, the same events, the same projection as before.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const api = async (baseUrl, method, path, body) => {
  const r = await fetch(`${baseUrl}${path}`, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed = null;
  try { parsed = await r.json(); } catch { /* none */ }
  return { status: r.status, body: parsed };
};

const board = () => makeBoardFixture({
  cards: [
    { id: 'u-1', shortId: 1, title: 'apex', description: '', type: 'goal',
      labels: [], assignees: [], column: 'backlog', order: 1, createdAt: '2026-08-01T00:00:00.000Z', relationships: {} },
    { id: 'u-2', shortId: 2, title: 'leaf', description: '', type: 'task',
      labels: [], assignees: [], column: 'backlog', order: 2, createdAt: '2026-08-01T00:00:00.000Z', relationships: {} },
  ],
  nextShortId: 3,
});

const DISCHARGED_BY = {
  name: 'scrum:dischargedBy',
  definition: 'CLOSURE OF AN OBLIGATION: the object (a person, or a full-sha commit) is what discharged the subject obligation. Asserting it closes the obligation — status becomes discharged and dischargedAt is stamped. The first closure stands; a second is a noop.',
  by: 'ada',
};
const SHA = 'a'.repeat(40);

async function setup() {
  const s = await startRestServer({ board: board() });
  const reg = await api(s.baseUrl, 'POST', '/api/predicates', DISCHARGED_BY);
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const o = await api(s.baseUrl, 'POST', '/api/obligations', { by: 'ada', owedBy: 'ada', about: 2, kind: 'review', note: 'read the leaf' });
  assert.equal(o.status, 201, JSON.stringify(o.body));
  return { s, oid: o.body.id };
}

test('#1118-B asserting scrum:dischargedBy on an OBLIGATION subject closes it — a person object', async () => {
  const { s, oid } = await setup();
  try {
    const r = await api(s.baseUrl, 'POST', '/api/assert', { by: 'bo', assertions: [{ subject: oid, predicate: 'scrum:dischargedBy', object: 'bo' }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.applied, 1);
    assert.equal(r.body.results[0].effect, 'obligation-closed');
    const after = (await api(s.baseUrl, 'GET', '/api/obligations')).body[0];
    assert.equal(after.status, 'discharged');
    assert.equal(after.dischargedBy, 'bo');
    assert.ok(after.dischargedAt);
    // and it is in the graph, as an edge
    const q = await api(s.baseUrl, 'POST', '/api/graph', { by: 'ada', query: 'SELECT ?who WHERE { ?o a scrum:Obligation ; scrum:status "discharged" ; scrum:dischargedBy ?who }' });
    assert.equal(q.body.rows.length, 1, JSON.stringify(q.body));
    assert.equal(String(q.body.rows[0].who), 'person:bo');
    // re-asserting the SAME closer is a silent noop; a DIFFERENT one is LOUD —
    // the caller learns what stands (review item 4: a typo must not vanish)
    const same = await api(s.baseUrl, 'POST', '/api/assert', { by: 'bo', assertions: [{ subject: oid, predicate: 'scrum:dischargedBy', object: 'bo' }] });
    assert.equal(same.body.results[0].effect, 'noop');
    const again = await api(s.baseUrl, 'POST', '/api/assert', { by: 'cy', assertions: [{ subject: oid, predicate: 'scrum:dischargedBy', object: 'cy' }] });
    assert.equal(again.status, 200);
    assert.equal(again.body.applied, 0);
    assert.equal(again.body.results[0].effect, 'already-closed');
    assert.equal(again.body.results[0].existing.dischargedBy, 'bo', 'and says WHAT stands');
    assert.equal((await api(s.baseUrl, 'GET', '/api/obligations')).body[0].dischargedBy, 'bo');
  } finally { await s.stop(); }
});

test('#1118-B ONE object kind per predicate: dischargedBy is a PERSON; the commit that met it is scrum:evidencedBy → a commit: node', async () => {
  const { s, oid } = await setup();
  try {
    // a sha in the person slot is refused, naming the right predicate
    const wrongSlot = await api(s.baseUrl, 'POST', '/api/assert', { by: 'bo', assertions: [{ subject: oid, predicate: 'scrum:dischargedBy', object: SHA }] });
    assert.equal(wrongSlot.status, 400);
    assert.match(wrongSlot.body.error, /evidencedBy/, 'and names the predicate a commit belongs on');
    await api(s.baseUrl, 'POST', '/api/predicates', { name: 'scrum:evidencedBy', definition: 'the object commit is evidence that the subject was met', by: 'ada' });
    // ONE batch: the person closes it, the commit evidences it — two node kinds, one boundary
    const r = await api(s.baseUrl, 'POST', '/api/assert', { by: 'bo', assertions: [
      { subject: oid, predicate: 'scrum:dischargedBy', object: 'bo' },
      { subject: oid, predicate: 'scrum:evidencedBy', object: SHA },
    ] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.results.map((x) => x.effect), ['obligation-closed', 'evidence-recorded']);
    const q = await api(s.baseUrl, 'POST', '/api/graph', { by: 'ada', query: 'SELECT ?who ?c WHERE { ?o a scrum:Obligation ; scrum:dischargedBy ?who ; scrum:evidencedBy ?c }' });
    assert.equal(q.body.rows.length, 1, JSON.stringify(q.body));
    assert.equal(String(q.body.rows[0].who), 'person:bo');
    assert.match(String(q.body.rows[0].c), /^commit:a{40}$/, 'the commit is the SAME node kind implementedBy mints — one encoding of "a commit"');
    const short = await api(s.baseUrl, 'POST', '/api/assert', { by: 'bo', assertions: [{ subject: oid, predicate: 'scrum:evidencedBy', object: 'abc123' }] });
    assert.equal(short.status, 400, 'a short sha is refused — one commit is one node');
  } finally { await s.stop(); }
});

test('#1118-B refusals: the gate still holds (unregistered), a subject that is neither card nor obligation, a card subject for this predicate', async () => {
  const s = await startRestServer({ board: board() });
  try {
    const o = await api(s.baseUrl, 'POST', '/api/obligations', { by: 'ada', owedBy: 'ada', about: 2, kind: 'review' });
    const gated = await api(s.baseUrl, 'POST', '/api/assert', { by: 'bo', assertions: [{ subject: o.body.id, predicate: 'scrum:dischargedBy', object: 'bo' }] });
    assert.equal(gated.status, 400);
    assert.match(gated.body.error, /not registered/i, 'the registry gate is unchanged by widening the subject');
    await api(s.baseUrl, 'POST', '/api/predicates', DISCHARGED_BY);
    const nowhere = await api(s.baseUrl, 'POST', '/api/assert', { by: 'bo', assertions: [{ subject: 'https://scrumboard.local/obligation/nope', predicate: 'scrum:dischargedBy', object: 'bo' }] });
    assert.equal(nowhere.status, 400);
    assert.match(nowhere.body.error, /card.*obligation|obligation.*card/i, 'the refusal names BOTH subject kinds the verb resolves');
    const onCard = await api(s.baseUrl, 'POST', '/api/assert', { by: 'bo', assertions: [{ subject: 2, predicate: 'scrum:dischargedBy', object: 'bo' }] });
    assert.equal(onCard.status, 400);
    assert.match(onCard.body.error, /obligation/i, 'dischargedBy takes an obligation subject, and says so');
    assert.equal((await api(s.baseUrl, 'GET', '/api/obligations')).body[0].status, 'open', 'nothing partial landed');
  } finally { await s.stop(); }
});

test('#1118-B ATOMIC across node kinds: a card assertion and an obligation assertion in one batch land together or not at all', async () => {
  const { s, oid } = await setup();
  try {
    await api(s.baseUrl, 'POST', '/api/predicates', { name: 'schema:isPartOf', definition: 'containment', by: 'ada' });
    // one bad assertion (a dangling card) refuses the whole batch — the obligation stays open
    const bad = await api(s.baseUrl, 'POST', '/api/assert', { by: 'bo', assertions: [
      { subject: oid, predicate: 'scrum:dischargedBy', object: 'bo' },
      { subject: 2, predicate: 'schema:isPartOf', object: 999 },
    ] });
    assert.equal(bad.status, 400);
    assert.equal((await api(s.baseUrl, 'GET', '/api/obligations')).body[0].status, 'open', 'nothing partial ever lands');
    // the good batch lands both, through ONE event boundary
    const ok = await api(s.baseUrl, 'POST', '/api/assert', { by: 'bo', assertions: [
      { subject: oid, predicate: 'scrum:dischargedBy', object: 'bo' },
      { subject: 2, predicate: 'schema:isPartOf', object: 1 },
    ] });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.applied, 2);
    assert.equal((await api(s.baseUrl, 'GET', '/api/obligations')).body[0].status, 'discharged');
    assert.equal((await api(s.baseUrl, 'GET', '/api/cards/2')).body.parent, 'u-1');
  } finally { await s.stop(); }
});
