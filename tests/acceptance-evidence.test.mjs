/**
 * #814 third third — ACCEPTANCE EVIDENCE: which result discharged which
 * release condition.
 *
 * The Banana Test's last clause: for a card, ONE query returns "which test
 * result discharged each release condition", without parsing comment text.
 *
 * Today a release condition is prose in a description and its discharge is
 * prose in a comment. The graph can find both narrations and can answer from
 * neither, so "is this actually accepted, and on what evidence" is a question
 * only a careful reader can settle — which is the state this card exists to end.
 *
 * ⭐ REUSES `scrum:evidencedBy`, WHICH ALREADY EXISTS. The tending vocabulary
 * declared it @id-typed and pointed it at durable sources. Minting a rival
 * predicate for card-level evidence would be the vocabulary-collision shape the
 * room hit with `mentions` — two names for one relation, and every query then
 * has to know which subsystem it is standing in.
 *
 * ⛔ EVIDENCE MUST BE DURABLE AND RESOLVABLE-SHAPED. A 40-char commit sha or an
 * entity uuid — never a sentence. "The tests passed" is the prose this replaces.
 * That rule is the BF4 lesson generalised: `implementedBy` validated LENGTH and
 * not existence, so a padded short sha was accepted as readily as a real one and
 * three of them reached production. A field whose values cannot be resolved is a
 * field that can be confidently wrong.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';
import { patchWithVersion } from './helpers/versioned-patch.mjs';

const SHA = 'c'.repeat(40);
const UUID = '11111111-2222-3333-4444-555555555555';

const api = async (baseUrl, method, path, body) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method, headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : null };
};

const board = () => makeBoardFixture({
  cards: [{
    id: 'u-1', shortId: 1, title: 'a card with release conditions', description: '',
    type: 'task', labels: [], assignees: [], column: 'backlog', order: 1,
    createdAt: '2026-08-01T00:00:00.000Z', relationships: {},
  }],
  nextShortId: 2,
});

test('#814 a release condition records what discharged it, and round-trips', async () => {
  const s = await startRestServer({ board: board() });
  try {
    const r = await patchWithVersion(s.baseUrl, 1, {
      acceptance: [
        { condition: 'a red test blocks the guarded action', evidence: [SHA], note: 'suite run at that commit' },
        { condition: 'the guarded population is named', evidence: [] },
      ], by: 'ada',
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ignoredFields, undefined, 'must not be validated-then-discarded');

    const fresh = await api(s.baseUrl, 'GET', '/api/cards/1');
    assert.equal(fresh.body.acceptance.length, 2);
    assert.deepEqual(fresh.body.acceptance[0].evidence, [SHA], 'read back from a fresh GET');
  } finally { await s.stop(); }
});

test('#814 THE BANANA TEST — which evidence discharged which condition, in ONE query', async () => {
  const s = await startRestServer({ board: board() });
  try {
    await patchWithVersion(s.baseUrl, 1, {
      acceptance: [{ condition: 'RC1 — a red test refuses the push', evidence: [SHA, UUID] }],
      by: 'ada',
    });
    const q = await api(s.baseUrl, 'POST', '/api/graph', {
      query: `SELECT ?card ?condition ?evidence WHERE {
        ?rc a scrum:ReleaseCondition ;
            scrum:ofCard ?c ; schema:name ?condition ; scrum:evidencedBy ?evidence .
        ?c schema:identifier ?card .
      } ORDER BY ?evidence`,
    });
    assert.equal(q.status, 200, JSON.stringify(q.body));
    assert.equal(q.body.rows.length, 2, 'both pieces of evidence, joined to their condition');
    assert.equal(q.body.rows[0].condition, 'RC1 — a red test refuses the push');
    assert.ok(q.body.rows.some((r) => r.evidence === `commit:${SHA}`),
      'a sha resolves into the commit: namespace — a node, not a literal');
    assert.ok(q.body.rows.some((r) => r.evidence === `entity:${UUID}`),
      'a uuid resolves into the entity: namespace');
  } finally { await s.stop(); }
});

test('#814 an UNDISCHARGED condition is visible AS undischarged', async () => {
  // ⚠️ THE POPULATION QUESTION, which is the whole reason to model this rather
  // than count it. If only discharged conditions appeared, "the conditions on
  // this card" would silently mean "the ones already met" — and a card would
  // look accepted precisely because nobody had recorded the outstanding ones.
  const s = await startRestServer({ board: board() });
  try {
    await patchWithVersion(s.baseUrl, 1, {
      acceptance: [
        { condition: 'RC1 met', evidence: [SHA] },
        { condition: 'RC2 outstanding', evidence: [] },
      ], by: 'ada',
    });
    const q = await api(s.baseUrl, 'POST', '/api/graph', {
      query: `SELECT ?condition ?evidence WHERE {
        ?rc a scrum:ReleaseCondition ; schema:name ?condition .
        OPTIONAL { ?rc scrum:evidencedBy ?evidence }
      } ORDER BY ?condition`,
    });
    assert.equal(q.body.rows.length, 2, 'BOTH conditions appear');
    const outstanding = q.body.rows.find((r) => r.condition === 'RC2 outstanding');
    assert.equal(outstanding.evidence, undefined,
      '"not yet discharged" is a QUERY — an unbound evidence, not a missing row');
  } finally { await s.stop(); }
});

test('#814 evidence that cannot be resolved is REFUSED — the BF4 lesson generalised', async () => {
  // ⛔ implementedBy validated LENGTH and not existence, so a real short sha
  // padded to forty was accepted exactly as readily as a real one, and three
  // reached production. Evidence has the same failure mode and a worse
  // consequence: it is the record that a condition was MET.
  const s = await startRestServer({ board: board() });
  try {
    for (const [bad, why] of [
      [['the tests passed'], 'prose is what this field replaces'],
      [['a75a247'], 'a short sha cannot be expanded by the graph'],
      [[''], 'an empty reference names nothing'],
      ['not-an-array', 'evidence must be a list'],
    ]) {
      const r = await patchWithVersion(s.baseUrl, 1, {
        acceptance: [{ condition: 'x', evidence: bad }], by: 'ada',
      });
      assert.equal(r.status, 400, `${why} — got ${r.status} ${JSON.stringify(r.body)}`);
    }
  } finally { await s.stop(); }
});

test('#814 a condition with no text is refused — evidence for nothing is not evidence', async () => {
  const s = await startRestServer({ board: board() });
  try {
    const r = await patchWithVersion(s.baseUrl, 1, {
      acceptance: [{ condition: '', evidence: [SHA] }], by: 'ada',
    });
    assert.equal(r.status, 400);
  } finally { await s.stop(); }
});

test('#814 DELETING the card removes its ReleaseCondition nodes', async () => {
  // ⭐ WRITTEN FIRST THIS TIME. The blocker nodes orphaned on exactly this path
  // and production found it, not the suite — because the test I had covered
  // removing the FIELD and made the delete case feel covered. Same derived
  // subject shape, same sweep, and this time the case is pinned before the code.
  const s = await startRestServer({ board: board() });
  try {
    await patchWithVersion(s.baseUrl, 1, {
      acceptance: [{ condition: 'RC1', evidence: [SHA] }], by: 'ada',
    });
    const before = await api(s.baseUrl, 'POST', '/api/graph', {
      query: 'SELECT (COUNT(?rc) AS ?n) WHERE { ?rc a scrum:ReleaseCondition }',
    });
    assert.equal(before.body.rows[0].n, '1', 'control: it exists while the card does');

    const del = await fetch(`${s.baseUrl}/api/cards/1`, { method: 'DELETE' });
    assert.equal(del.status, 204);

    const after = await api(s.baseUrl, 'POST', '/api/graph', {
      query: 'SELECT (COUNT(?rc) AS ?n) WHERE { ?rc a scrum:ReleaseCondition }',
    });
    assert.equal(after.body.rows[0].n, '0',
      'a record that a condition was met must not outlive the card it was met for');
  } finally { await s.stop(); }
});

test('#814 dropping a condition drops its node — no stale acceptance', async () => {
  const s = await startRestServer({ board: board() });
  try {
    await patchWithVersion(s.baseUrl, 1, {
      acceptance: [{ condition: 'RC1', evidence: [SHA] }, { condition: 'RC2', evidence: [] }], by: 'ada',
    });
    await patchWithVersion(s.baseUrl, 1, {
      acceptance: [{ condition: 'RC1', evidence: [SHA] }], by: 'ada',
    });
    const q = await api(s.baseUrl, 'POST', '/api/graph', {
      query: 'SELECT ?n WHERE { ?rc a scrum:ReleaseCondition ; schema:name ?n } ORDER BY ?n',
    });
    assert.deepEqual(q.body.rows.map((r) => r.n), ['RC1'],
      'the removed condition left no node behind');
  } finally { await s.stop(); }
});
