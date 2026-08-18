/**
 * #857 §IV — "labels as a CONTROLLED vocabulary — identities exist, SYNONYMS do not."
 *
 * #687 minted an identity per distinct label string. That was the prerequisite
 * and it deliberately stopped there: `building scrum board` and
 * `building-scrum-board` got two nodes, because merging them needs a mechanism
 * nobody had designed.
 *
 * ⭐ MEASURED BEFORE BUILDING — 393 concepts, SEVEN normalised collisions:
 *
 *     #561 / 561                                          punctuation
 *     autonomous room / autonomous-room                    separator
 *     building scrum board / building-scrum-board /
 *       building-scrum board                               ⇐ THREE, not two
 *     jsonld / json-ld · schema.org / schema-org           separator
 *     MGMT:9230 / mgmt:9230 · vtm / VTM                     case
 *
 * ⚠️ The three-way collision is the finding. Every post tonight said "two
 * spellings of one concept". There were three, and nobody knew, because a
 * bare-string vocabulary cannot be asked what it contains.
 *
 * ⛔ WHAT THIS DOES NOT DO, AND WHY THAT IS THE DESIGN:
 *
 * It does NOT auto-merge on normalisation. Normalisation SURFACES candidates;
 * a seat DECLARES the merge. Two labels that normalise alike are not
 * necessarily one concept, and a system that silently fused them would be
 * making an unfalsifiable judgement at write time — the thing the room refused
 * when it decided the replica emits facts and queries do interpretation.
 *
 * ⇒ Recording a synonym is the prerequisite EVERY candidate design needs —
 *   curated merge, alias list, and emergent co-occurrence all have to write the
 *   answer down somewhere. Building the record does not choose the discovery
 *   method, exactly as minting identities did not choose the merge.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const card = (shortId, labels) => ({
  id: `u-${shortId}`, shortId, title: `card ${shortId}`, description: '',
  type: 'task', labels, assignees: [], column: 'backlog', order: shortId,
  createdAt: '2026-08-01T00:00:00.000Z', relationships: {},
});

const board = () => makeBoardFixture({
  cards: [
    card(1, ['building scrum board']),
    card(2, ['building-scrum-board']),
    card(3, ['building-scrum board']),
    card(4, ['manyhands']),
    card(5, ['unrelated']),
  ],
  nextShortId: 6,
});

const api = async (baseUrl, method, path, body) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method, headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : null };
};

test('#857 collisions are SURFACED as a list of candidates, not a count', async () => {
  const s = await startRestServer({ board: board() });
  try {
    const r = await api(s.baseUrl, 'GET', '/api/labels/collisions');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const three = r.body.collisions.find((c) => c.members.includes('building scrum board'));
    assert.ok(three, 'the live three-way collision must be surfaced');
    assert.deepEqual(three.members.sort(),
      ['building scrum board', 'building-scrum board', 'building-scrum-board'],
      'ALL THREE spellings — a count would have said "1 collision" and taught nobody anything');
    assert.equal(three.declared, false, 'undeclared until a seat says so');
  } finally { await s.stop(); }
});

test('#857 a seat DECLARES the merge — the system never fuses on its own', async () => {
  const s = await startRestServer({ board: board() });
  try {
    const before = await api(s.baseUrl, 'GET', '/api/labels/aliases');
    assert.deepEqual(before.body.aliases, {}, 'control: nothing is merged by default');

    const d = await api(s.baseUrl, 'POST', '/api/labels/aliases', {
      alias: 'building-scrum-board', canonical: 'building scrum board', by: 'ada',
    });
    assert.equal(d.status, 200, JSON.stringify(d.body));

    const after = await api(s.baseUrl, 'GET', '/api/labels/aliases');
    assert.equal(after.body.aliases['building-scrum-board'], 'building scrum board');
  } finally { await s.stop(); }
});

test('#857 a declared synonym resolves in the GRAPH — sameAs, queryable', async () => {
  // §IV's row says CONTROLLED VOCABULARY. If the declaration only lives in a
  // side table, the vocabulary is not controlled in the graph, and the north
  // star's whole argument is that context you cannot query is an archive.
  const s = await startRestServer({ board: board() });
  try {
    await api(s.baseUrl, 'POST', '/api/labels/aliases', {
      alias: 'building-scrum-board', canonical: 'building scrum board', by: 'ada',
    });

    const q = await api(s.baseUrl, 'POST', '/api/graph', {
      query: 'SELECT ?a ?c WHERE { ?x a schema:DefinedTerm ; schema:name ?a ; schema:sameAs ?y . '
        + '?y schema:name ?c }',
    });
    assert.equal(q.status, 200, JSON.stringify(q.body));
    assert.deepEqual(q.body.rows, [{ a: 'building-scrum-board', c: 'building scrum board' }],
      'the alias points at its canonical concept as a real edge');
  } finally { await s.stop(); }
});

test('#857 ONE query reaches every card under a concept and its synonyms', async () => {
  // ⭐ THE PAYOFF, and the thing that was impossible this morning. Three
  // spellings, 3 cards, and no single query could reach all of them.
  const s = await startRestServer({ board: board() });
  try {
    for (const alias of ['building-scrum-board', 'building-scrum board']) {
      await api(s.baseUrl, 'POST', '/api/labels/aliases',
        { alias, canonical: 'building scrum board', by: 'ada' });
    }
    const q = await api(s.baseUrl, 'POST', '/api/graph', {
      query: `SELECT ?id WHERE {
        ?canon a schema:DefinedTerm ; schema:name "building scrum board" .
        ?t (schema:sameAs)* ?canon .
        ?c schema:keywords ?t ; schema:identifier ?id .
      } ORDER BY ?id`,
    });
    assert.deepEqual(q.body.rows.map((r) => r.id), ['1', '2', '3'],
      'all three spellings resolve to one set — the membership question #857 §V leans on');
  } finally { await s.stop(); }
});

test('#857 the collision list CONVERGES — a declared merge stops being open', async () => {
  // ⚠️ The #801 lesson, applied at design time rather than found on prod. A
  // candidate list that keeps reporting a resolved collision is a perishable
  // claim, and a reader planning from it would re-decide what was already decided.
  const s = await startRestServer({ board: board() });
  try {
    const before = await api(s.baseUrl, 'GET', '/api/labels/collisions');
    assert.equal(before.body.open, 1, 'one open collision to start');

    for (const alias of ['building-scrum-board', 'building-scrum board']) {
      await api(s.baseUrl, 'POST', '/api/labels/aliases',
        { alias, canonical: 'building scrum board', by: 'ada' });
    }

    const after = await api(s.baseUrl, 'GET', '/api/labels/collisions');
    assert.equal(after.body.open, 0, 'declared collisions are no longer open');
    const c = after.body.collisions.find((x) => x.members.includes('building scrum board'));
    assert.ok(c, 'the record SURVIVES — evidence the collision was real');
    assert.equal(c.declared, true, 'but marked declared, not still asking to be decided');
  } finally { await s.stop(); }
});

test('#857 a self-alias and an unknown canonical are refused', async () => {
  const s = await startRestServer({ board: board() });
  try {
    const self = await api(s.baseUrl, 'POST', '/api/labels/aliases',
      { alias: 'manyhands', canonical: 'manyhands', by: 'ada' });
    assert.equal(self.status, 400, 'a concept cannot be its own synonym — that is a cycle, not a merge');

    const chain = await api(s.baseUrl, 'POST', '/api/labels/aliases',
      { alias: 'manyhands', canonical: 'does-not-exist-anywhere', by: 'ada' });
    assert.equal(chain.status, 400,
      'the canonical must be a label some card actually carries — otherwise a typo mints '
      + 'a canonical nothing uses and quietly orphans the alias');
  } finally { await s.stop(); }
});
