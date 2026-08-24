/**
 * #1104 — A WRONG VOCABULARY TERM MUST REFUSE, NOT RETURN A CLEAN ZERO.
 *
 * ⛔ THE DEFECT. Every catalogued trap on this tool returns a well-formed empty
 * result: `scrum:Card` (no such class), `schema:description` (the body is
 * `schema:text`), `schema:additionalType` (the kind is `scrum:cardType`). Zero
 * rows and a true negative are BYTE-IDENTICAL, so a seat cannot tell "there are
 * none" from "you named the wrong predicate" — opposite facts, one response.
 *
 * ⇒ And the consequence is not merely a bad afternoon: the free-text substring
 *   search CANNOT fail, so the instrument that silently answers LESS feels
 *   reliable and the instrument that is CORRECT feels broken. The graph gets
 *   routed around by the people it was built for.
 *
 * ── WHY THIS CHECKS A DICTIONARY AND NOT THE STORE ────────────────────────
 *
 * The first cut asked the store whether each term had any instances and refused
 * what was absent. That is wrong on somebody else's board: manyhands is open
 * source, and on a FRESH install with three cards `scrum:blockedBy`,
 * `scrum:label` and `scrum:supersedes` are all legitimately absent. A presence
 * check refuses every one of them and the tool looks broken on day one — the
 * same defect this card is about, wearing the fix's clothes.
 *
 * ⇒ ⭐ ABSENT-FROM-DATA and ABSENT-FROM-VOCABULARY are opposite facts, and only
 *   the second is the caller's mistake. Test 2 is the one that pins this.
 *
 * ⚠️ THE GUARD'S OWN FAILURE MODE IS STALENESS — a predicate added to the
 * projection and not to `GRAPH_VOCABULARY` would be refused while working.
 * Test 4 is the drift check: it projects a fixture and fails on any emitted
 * term the dictionary does not carry. Without it this guard rots into exactly
 * the false refusal it exists to prevent.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';
import { GRAPH_VOCABULARY } from '../core/graph-replica.mjs';

// A board with something in it. The default fixture has `cards: []`, and every
// assertion here about "a real term with no instances" is vacuous against an
// empty graph — an empty store answers zero for the right term and the wrong
// one alike, which is the exact confusion under test.
const board = makeBoardFixture({
  nextShortId: 3,
  cards: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      shortId: 1,
      title: 'A card with a label and a relationship',
      description: 'body text',
      type: 'task',
      column: 'backlog',
      priority: 'p1',
      labels: ['manyhands'],
      assignees: ['ada'],
      relationships: { relatedTo: [2], blockedBy: [], supersedes: [], derivedFrom: [], supersededBy: [] },
      createdAt: '2026-08-30T00:00:00.000Z',
      createdBy: 'ada',
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      shortId: 2,
      title: 'The other end of the relationship',
      description: 'body text',
      type: 'bug',
      column: 'done',
      labels: [],
      assignees: ['unassigned'],
      relationships: { relatedTo: [1], blockedBy: [], supersedes: [], derivedFrom: [], supersededBy: [] },
      createdAt: '2026-08-30T00:00:01.000Z',
      createdBy: 'ada',
    },
  ],
});

const graph = async (baseUrl, query) => {
  const r = await fetch(`${baseUrl}/api/graph`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }),
  });
  return { status: r.status, body: await r.json() };
};

test('#1104 a term the projection can never emit is REFUSED, and the refusal NAMES it', async () => {
  const s = await startRestServer({ board });
  try {
    for (const [q, term] of [
      // ⛔ `scrum:Card` USED TO LIVE HERE and no longer can: #962 landed and the
      // projection now emits it, so it is a REAL term and this guard must not
      // refuse it. Removed rather than reworded — a guard example that the
      // projection emits would assert the opposite of what #1104 exists for.
      // The positive half (`scrum:Card` ANSWERS) is asserted in
      // tests/graph-query-prior-art-hazards.test.mjs, in #962's own commit.
      ['SELECT ?d WHERE { ?c schema:description ?d }', 'schema:description'],
      ['SELECT ?t WHERE { ?c schema:additionalType ?t }', 'schema:additionalType'],
    ]) {
      const r = await graph(s.baseUrl, q);
      assert.equal(r.status, 400, `must refuse: ${q} — got ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
      assert.equal(r.body.code, 'UNKNOWN_TERM');
      // ⛔ Naming the term is the entire remedy. "Something is wrong with your
      // query" leaves the caller exactly where the silent zero did.
      assert.ok(
        r.body.error.includes(term),
        `the refusal must name the offending term. got ${JSON.stringify(r.body.error).slice(0, 200)}`,
      );
    }
  } finally { await s.stop(); }
});

test('#1104 NEGATIVE CONTROL — a REAL term with no instances still answers ZERO', async () => {
  // ⛔⛔ THE DISCRIMINATOR. A guard that refuses everything would pass test 1
  // and be worse than no guard: it would break every honest question whose
  // answer happens to be "none", which is most questions on a young board.
  //
  // `scrum:supersedes` is real and in the dictionary; the fixture has no
  // superseding cards. The correct answer is an empty result with status 200.
  const s = await startRestServer({ board });
  try {
    const r = await graph(s.baseUrl, 'SELECT ?a ?b WHERE { ?a scrum:supersedes ?b }');
    assert.equal(
      r.status, 200,
      `a real predicate with no instances must ANSWER, not refuse — got ${r.status} `
      + `${JSON.stringify(r.body).slice(0, 200)}`,
    );
    assert.equal(r.body.returned, 0, 'and the answer is zero rows');
    // And the same query must still work when the term IS populated, or this
    // test would pass against a guard that refuses nothing and a store that
    // holds nothing — two failures cancelling.
    const live = await graph(s.baseUrl, 'SELECT ?c WHERE { ?c a schema:CreativeWork }');
    assert.equal(live.status, 200);
    assert.ok(live.body.returned > 0, 'the fixture must contain cards, or test 2 proves nothing');
  } finally { await s.stop(); }
});

test('#1104 an INSTANCE that does not exist is answered, never refused', async () => {
  // "Does card X exist" is a fair question and its honest answer is empty.
  // Refusing it would answer with an ERROR what the caller asked as a QUERY —
  // and entity:/person:/column: are data, not vocabulary.
  const s = await startRestServer({ board });
  try {
    const r = await graph(
      s.baseUrl,
      'SELECT ?p ?o WHERE { entity:00000000-0000-4000-8000-000000000000 ?p ?o }',
    );
    assert.equal(r.status, 200, `an unknown instance must answer 0, not refuse — got ${r.status}`);
    assert.equal(r.body.returned, 0);
  } finally { await s.stop(); }
});

test('#1104 DRIFT — every schema:/scrum: term the projection emits is in the dictionary', async () => {
  // ⚠️ THE GUARD'S OWN FAILURE MODE, PINNED. A predicate added to the
  // projection and not to GRAPH_VOCABULARY is refused while working — the one
  // way this guard is worse than no guard. This asks the projected store what
  // it actually emits rather than trusting the constant to have kept up.
  const s = await startRestServer({ board });
  try {
    const r = await graph(
      s.baseUrl,
      'SELECT DISTINCT ?p WHERE { ?s ?p ?o . FILTER(STRSTARTS(STR(?p), "https://scrumboard.local/ns#") '
      + '|| STRSTARTS(STR(?p), "https://schema.org/")) }',
    );
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
    const emitted = r.body.rows.map((row) => row.p);
    assert.ok(emitted.length > 0, 'the fixture must project something, or this check is vacuous');
    const undeclared = emitted.filter((p) => !GRAPH_VOCABULARY.has(p));
    assert.deepEqual(
      undeclared, [],
      'these terms are emitted by the projection and missing from GRAPH_VOCABULARY, so the '
      + `guard would REFUSE a working query naming them: ${undeclared.join(', ')}`,
    );

    const types = await graph(s.baseUrl, 'SELECT DISTINCT ?t WHERE { ?s a ?t }');
    assert.equal(types.status, 200);
    const undeclaredTypes = types.body.rows
      .map((row) => row.t)
      .filter((t) => (t.startsWith('schema:') || t.startsWith('scrum:')) && !GRAPH_VOCABULARY.has(t));
    assert.deepEqual(undeclaredTypes, [], `classes missing from GRAPH_VOCABULARY: ${undeclaredTypes.join(', ')}`);
  } finally { await s.stop(); }
});

test('#1104 an undeclared PREFIX is refused by name, not by a parser error', async () => {
  // #907's shape: `xsd:` once produced "expected ENCODE_FOR_URI" — an error
  // naming a function nobody typed. (xsd: is bound now; `foaf:` is not.)
  const s = await startRestServer({ board });
  try {
    const r = await graph(s.baseUrl, 'SELECT ?n WHERE { ?p foaf:name ?n }');
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'UNKNOWN_PREFIX');
    assert.ok(r.body.error.includes('foaf:'), `must name the prefix. got ${r.body.error}`);
  } finally { await s.stop(); }
});

test('#1104 a TRIPWIRE naming an unknown term reports error, not holds', async () => {
  // ⭐⭐⭐ THE SIDE EFFECT WORTH PINNING, found by an existing test failing.
  //
  // /api/checks runs authored falsifiers. A check whose ask names a term the
  // projection can never emit returns zero forever, so `expect: false` is
  // satisfied forever: the tripwire reports `holds` and CAN NEVER FIRE. That is
  // "a check that cannot fail" — the precise thing the checks endpoint exists
  // to prevent — hiding inside the endpoint that prevents it.
  //
  // The guard converts that from a permanent false `holds` into a loud `error`,
  // which is the third outcome /api/checks already models. ⚠️ Deploying this
  // will flip any such existing check from holds to error; that is the defect
  // becoming visible, not a regression.
  const s = await startRestServer({ board });
  try {
    const made = await fetch(`${s.baseUrl}/api/cards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'a tripwire that could never fire',
        createdBy: 'ada',
        checks: [{ claim: 'nothing is typed scrum:Sasquatch', ask: 'ASK { ?x a scrum:Sasquatch }', expect: false }],
      }),
    });
    const card = await made.json();
    const body = await (await fetch(`${s.baseUrl}/api/checks`)).json();
    const mine = body.results.find((r) => r.shortId === card.shortId);
    assert.ok(mine, 'the card with a check must appear in /api/checks');
    assert.equal(
      mine.checks[0].status, 'error',
      'a tripwire naming a term the projection cannot emit must report ERROR — reporting '
      + '`holds` would be a falsifier that is satisfied by its own misspelling',
    );

    // ⭐ PAIRED CONTROL, same run: a REAL term with no instances still holds.
    // Without this, a checker that errored on everything would pass the above.
    const ok = await fetch(`${s.baseUrl}/api/cards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'a tripwire that could fire and has not',
        createdBy: 'ada',
        checks: [{ claim: 'this board holds no Decisions', ask: 'ASK { ?d a scrum:Decision }', expect: false }],
      }),
    });
    const okCard = await ok.json();
    const after = await (await fetch(`${s.baseUrl}/api/checks`)).json();
    const control = after.results.find((r) => r.shortId === okCard.shortId);
    assert.equal(control.checks[0].status, 'holds', 'a real, unpopulated term must still HOLD');
  } finally { await s.stop(); }
});
