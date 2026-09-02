/**
 * #814 second third — BLOCKER OWNERSHIP as queryable state.
 *
 * The Banana Test: for a card, ONE query returns "each blocker's owner and
 * status", without parsing comment text.
 *
 * Today `blockedBy` is a bare card→card edge. It answers WHAT blocks this, and
 * is silent on WHO is clearing it and WHETHER they still are — so that lives in
 * prose, and the graph can find the narration but cannot answer from it.
 *
 * ⭐ THE SHAPE, and it is the one this room has now settled on twice:
 * KEEP THE EDGE, ADD A TYPED NODE. `blockedBy` stays exactly as it is, because
 * every existing consumer and every traversal reads it — the same reason the
 * label literal survived when concepts arrived (#687), and the same "both, on
 * purpose" #857 §V states. The node carries the state the edge cannot hold.
 *
 * ⚠️ A BLOCKER NODE WITHOUT ITS EDGE WOULD BE A SECOND SOURCE OF TRUTH. So the
 * node is derived from ONE authority — the card's own blockedBy plus its
 * declared owners — and rebuilt every projection. If the edge goes, the node
 * goes; drift is unrepresentable rather than merely discouraged.
 *
 * ⛔ NOT BUILT HERE: acceptance evidence (the third third). It is a different
 * question with a different model, and welding them would make the smaller one
 * hostage to the larger.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';
import { patchWithVersion } from './helpers/versioned-patch.mjs';

const card = (shortId, over = {}) => ({
  id: `u-${shortId}`, shortId, title: `card ${shortId}`, description: '',
  type: 'task', labels: [], assignees: [], column: 'backlog', order: shortId,
  createdAt: '2026-08-01T00:00:00.000Z',
  relationships: { relatedTo: [], blockedBy: [], supersedes: [], derivedFrom: [], supersededBy: [] },
  ...over,
});

const board = () => makeBoardFixture({
  cards: [
    card(1, { relationships: { relatedTo: [], blockedBy: [2, 3], supersedes: [], derivedFrom: [], supersededBy: [] } }),
    card(2), card(3),
  ],
  nextShortId: 4,
});

const api = async (baseUrl, method, path, body) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method, headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : null };
};

test('#814 a blocker can be given an OWNER and a STATUS', async () => {
  const s = await startRestServer({ board: board() });
  try {
    const r = await patchWithVersion(s.baseUrl, 1, {
      blockers: [{ card: 2, owner: 'ada', status: 'open', note: 'waiting on the schema call' }],
      by: 'ada',
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ignoredFields, undefined, 'the field must not be validated-then-discarded');

    const fresh = await api(s.baseUrl, 'GET', '/api/cards/1');
    assert.deepEqual(fresh.body.blockers,
      [{ card: 2, owner: 'ada', status: 'open', note: 'waiting on the schema call' }],
      'read back from a fresh GET, not the write echo');
  } finally { await s.stop(); }
});

test('#814 THE BANANA TEST — each blocker\'s owner and status in ONE graph query', async () => {
  const s = await startRestServer({ board: board() });
  try {
    await patchWithVersion(s.baseUrl, 1, {
      blockers: [
        { card: 2, owner: 'ada', status: 'open' },
        { card: 3, owner: 'grace', status: 'cleared' },
      ], by: 'ada',
    });

    const q = await api(s.baseUrl, 'POST', '/api/graph', {
      query: `SELECT ?blocked ?blocker ?owner ?status WHERE {
        ?b a scrum:Blocker ;
           scrum:blocks ?bc ; scrum:blockedByCard ?kc ;
           scrum:owner ?owner ; scrum:status ?status .
        ?bc schema:identifier ?blocked . ?kc schema:identifier ?blocker .
      } ORDER BY ?blocker`,
    });
    assert.equal(q.status, 200, JSON.stringify(q.body));
    assert.deepEqual(q.body.rows, [
      { blocked: '1', blocker: '2', owner: 'person:ada', status: 'open' },
      { blocked: '1', blocker: '3', owner: 'person:grace', status: 'cleared' },
    ], 'owner is an EDGE to a Person, and no comment text was parsed');
  } finally { await s.stop(); }
});

test('#814 the blockedBy EDGE is untouched — every existing traversal still works', async () => {
  // ⛔ THE BACKWARD-COMPATIBILITY CONTROL. If enriching blockers costs the plain
  // edge, this is a regression dressed as a feature.
  const s = await startRestServer({ board: board() });
  try {
    await patchWithVersion(s.baseUrl, 1, {
      blockers: [{ card: 2, owner: 'ada', status: 'open' }], by: 'ada',
    });
    const fresh = await api(s.baseUrl, 'GET', '/api/cards/1');
    assert.deepEqual(fresh.body.relationships.blockedBy, [2, 3],
      'blockedBy is unchanged, including the blocker that has no ownership declared');

    const q = await api(s.baseUrl, 'POST', '/api/graph', {
      query: 'SELECT ?t WHERE { ?c schema:identifier "1" ; scrum:blockedBy ?o . ?o schema:identifier ?t } ORDER BY ?t',
    });
    assert.deepEqual(q.body.rows.map((r) => r.t), ['2', '3'], 'the plain edge still traverses');
  } finally { await s.stop(); }
});

test('#814 an UNOWNED blocker is visible AS unowned — never silently absent', async () => {
  // ⚠️ The population question, which this board keeps getting wrong. Card 1 is
  // blocked by two cards and only one has an owner. If the query returned one
  // row and said nothing, "blockers with owners" would read as "blockers".
  const s = await startRestServer({ board: board() });
  try {
    await patchWithVersion(s.baseUrl, 1, {
      blockers: [{ card: 2, owner: 'ada', status: 'open' }], by: 'ada',
    });
    const q = await api(s.baseUrl, 'POST', '/api/graph', {
      query: `SELECT ?blocker ?owner WHERE {
        ?c schema:identifier "1" ; scrum:blockedBy ?o . ?o schema:identifier ?blocker .
        OPTIONAL { ?b a scrum:Blocker ; scrum:blocks ?c ; scrum:blockedByCard ?o ; scrum:owner ?owner }
      } ORDER BY ?blocker`,
    });
    assert.equal(q.body.rows.length, 2, 'BOTH blockers appear');
    const unowned = q.body.rows.find((r) => r.blocker === '3');
    assert.equal(unowned.owner, undefined,
      'the unowned one is present with an unbound owner — "nobody is on this" is a QUERY, not an absence');
  } finally { await s.stop(); }
});

test('#814 a blocker naming a card that does not block is REFUSED', async () => {
  // ⛔ Otherwise ownership drifts free of the edge it describes, and the node
  // becomes a second source of truth about what blocks what.
  const s = await startRestServer({ board: board() });
  try {
    const r = await patchWithVersion(s.baseUrl, 1, {
      blockers: [{ card: 99, owner: 'ada', status: 'open' }], by: 'ada',
    });
    assert.equal(r.status, 400, 'a blocker must name a card in this card\'s blockedBy');
    assert.match(r.body.error, /99/);
  } finally { await s.stop(); }
});

test('#814 an unknown status is refused, naming the vocabulary', async () => {
  const s = await startRestServer({ board: board() });
  try {
    const r = await patchWithVersion(s.baseUrl, 1, {
      blockers: [{ card: 2, owner: 'ada', status: 'vibes' }], by: 'ada',
    });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /open|cleared/, 'the refusal teaches the vocabulary');
  } finally { await s.stop(); }
});

test('#814 dropping the blockedBy edge drops its Blocker node — no orphan state', async () => {
  // ⭐ THE D5 LESSON, APPLIED AT DESIGN TIME. A derived node on a foreign subject
  // is invisible to subject-scoped deletion; #687's concepts orphaned exactly
  // this way and 1,438 tests could not see it. Here the node is projected FROM
  // the edge, so removing the edge removes the node by construction.
  const s = await startRestServer({ board: board() });
  try {
    await patchWithVersion(s.baseUrl, 1, {
      blockers: [{ card: 2, owner: 'ada', status: 'open' }], by: 'ada',
    });
    await patchWithVersion(s.baseUrl, 1, {
      relationships: { relatedTo: [], blockedBy: [3], supersedes: [], derivedFrom: [], supersededBy: [] },
      blockers: [], by: 'ada',
    });
    const q = await api(s.baseUrl, 'POST', '/api/graph', {
      query: 'SELECT (COUNT(?b) AS ?n) WHERE { ?b a scrum:Blocker }',
    });
    assert.equal(q.body.rows[0].n, '0', 'the ownership node did not outlive the edge it described');
  } finally { await s.stop(); }
});

test('#814 DELETING the card removes its Blocker nodes — the orphan I asserted away', async () => {
  // ⛔ THIS IS THE TEST THAT CAUGHT ME, AND IT DID NOT EXIST UNTIL PROD DID.
  //
  // The test above covers removing the EDGE. It passes, and it let me write a
  // comment claiming "the node is derived from the edge, so there is nothing to
  // sweep." That was false for the case I did not test: DELETING the card.
  //
  // A Blocker's subject is `entity:<card>/blocker/<target>` — DERIVED from the
  // card's id but not equal to it. `removeEntity` deletes triples whose subject
  // IS the card, so these were never in range. The node outlived its card
  // carrying an owner and a status, pointing at nothing.
  //
  // ⚠️ Which is D5 exactly — a derived node on a foreign subject, invisible to
  // subject-scoped deletion — committed in the same change whose comment cited
  // D5 as the reason it could not happen. Found by deleting two scratch cards on
  // production and counting what was left, not by the suite.
  const s = await startRestServer({ board: board() });
  try {
    await patchWithVersion(s.baseUrl, 1, {
      blockers: [{ card: 2, owner: 'ada', status: 'open' }], by: 'ada',
    });
    const before = await api(s.baseUrl, 'POST', '/api/graph', {
      query: 'SELECT (COUNT(?b) AS ?n) WHERE { ?b a scrum:Blocker }',
    });
    assert.equal(before.body.rows[0].n, '1', 'control: the node exists while the card does');

    const del = await fetch(`${s.baseUrl}/api/cards/1`, { method: 'DELETE' });
    assert.equal(del.status, 204);

    const after = await api(s.baseUrl, 'POST', '/api/graph', {
      query: 'SELECT (COUNT(?b) AS ?n) WHERE { ?b a scrum:Blocker }',
    });
    assert.equal(after.body.rows[0].n, '0',
      'the ownership node must not outlive the card it hangs off — an orphan carrying '
      + 'an owner and a status that points at nothing is worse than no record');
  } finally { await s.stop(); }
});
