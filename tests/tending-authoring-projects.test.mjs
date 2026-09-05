/**
 * #1189 — EVERY entity this feature writes must reach the graph.
 *
 * ── WHY THIS FILE EXISTS, and it is the expensive kind of reason ───────────
 * #1189 shipped to production with 2240 tests green and took `graph_query`
 * DOWN for the whole board. The runtime writers introduced three predicates
 * the projector had never been taught — `scrum:shuffle`, `scrum:clockWindow`,
 * and a duplicate `ofPromptVersion` — and `projectTending()` throws on an
 * unknown predicate BY DESIGN, so the entire replica refused to build.
 *
 * That guard is correct and it did its job. The gap was on this side: every
 * existing test drove the authoring modules and the REST surface, and NOT ONE
 * pushed their output through the projector. The modules were pure and their
 * tests were pure, so the one seam that fails loudly was the one seam nothing
 * crossed.
 *
 * ⛔ SO THE RULE THIS FILE ENFORCES: a writer that emits a predicate the
 * projector does not know is a writer that puts a fact in the document and
 * never in the graph — which is the precise condition #1189 was filed to end.
 * Adding a field to any tending writer without adding it to TENDING_PREDICATES
 * must fail HERE, in CI, and not in production on a colleague's verification.
 *
 * Found by an independent acceptance test ~15 minutes after the deploy, which
 * is the argument for a builder not holding their own acceptance gate.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPrompt, editPrompt, setEnabled, reorderPlaylist, removePrompt, setShuffle } from '../core/tending-authoring.mjs';
import { buildGraphStore, queryGraph, SPARQL_PREFIXES, TENDING_PREDICATES } from '../core/graph-replica.mjs';
import { domainToJsonLd } from '../core/jsonld.mjs';
import { promptId, promptVersionId, playlistId, playlistVersionId, mintId } from '../core/tending-ids.mjs';

const AT = '2026-09-05T02:00:00.000Z';

function seed() {
  return [
    { '@id': promptId('alpha'), '@type': 'scrum:TendingPrompt', identifier: 'alpha', 'scrum:importedAt': AT },
    {
      '@id': promptVersionId('alpha', 1), '@type': 'scrum:TendingPromptVersion',
      'scrum:ofPrompt': promptId('alpha'), 'scrum:version': 1, 'scrum:body': 'A body',
      author: 'person:ada', 'scrum:importedAt': AT,
    },
    { '@id': playlistId('room-tending'), '@type': 'scrum:TendingPlaylist', identifier: 'room-tending', 'scrum:importedAt': AT },
    {
      '@id': playlistVersionId('room-tending', 1), '@type': 'scrum:TendingPlaylistVersion',
      'scrum:ofPlaylist': playlistId('room-tending'), 'scrum:version': 1,
      'scrum:orderedPrompts': { '@list': [promptVersionId('alpha', 1)] }, 'scrum:importedAt': AT,
    },
    { '@id': 'https://scrumboard.local/tending/state/current', '@type': 'scrum:TendingState', 'scrum:enabled': true },
  ];
}

/** Build the replica the way production does: entities → document → store. */
const project = (tending) => buildGraphStore(domainToJsonLd({
  nodes: [], messages: [], people: [], columns: [], tending,
}));

/**
 * The whole feature's write surface, exercised end to end. If ANY op emits a
 * predicate the projector has not been taught, buildGraphStore throws and this
 * fails — which is exactly what production did instead.
 */
test('every authoring operation produces a PROJECTABLE graph', () => {
  let e = seed();
  e = createPrompt(e, { slug: 'bravo', body: 'B body', by: 'ada', at: AT });
  e = editPrompt(e, { slug: 'alpha', body: 'A body v2', by: 'bee', at: AT });
  e = setEnabled(e, { slug: 'bravo', enabled: false, at: AT });
  e = reorderPlaylist(e, { slugs: ['bravo', 'alpha'], at: AT });
  e = setShuffle(e, { shuffle: true, at: AT });
  e = removePrompt(e, { slug: 'bravo', at: AT });
  assert.doesNotThrow(() => project(e));
});

test('setShuffle alone projects — the exact entity that took production down', () => {
  // DEFECT (shipped 2026-09-05): scrum:shuffle absent from TENDING_PREDICATES,
  // so writing it made the WHOLE replica unbuildable — not just tending.
  assert.doesNotThrow(() => project(setShuffle(seed(), { shuffle: true, at: AT })));
  const store = project(setShuffle(seed(), { shuffle: true, at: AT }));
  // ⚠️ queryGraph returns {rows, returned, …}, not a bare array. A first cut
  // read `.length` off the envelope, got undefined, and reported a PRODUCT
  // defect that did not exist — the triple was in the store the whole time.
  const { rows } = queryGraph(store, `${SPARQL_PREFIXES}
    SELECT ?v WHERE { ?s a scrum:TendingState ; scrum:shuffle ?v }`);
  assert.equal(rows.length, 1, 'shuffle reached the document and not the graph');
});

test('a firing MINT projects, and its prompt-version edge is queryable', () => {
  // DEFECT: recording the firing with a predicate the projector rejects, so the
  // 393-vs-1 fix would itself have broken every query on the board.
  const mint = {
    '@id': mintId('2026-09-05T04:00:00.000Z', '2026-09-05T04:00:03.000Z'),
    '@type': 'scrum:TendingMint',
    'scrum:clockWindow': '2026-09-05T04:00:00.000Z',
    'scrum:mintedAt': '2026-09-05T04:00:03.000Z',
    'scrum:promptVersion': promptVersionId('alpha', 1),
    'scrum:seatNamesWithOpenStreamsAtSend': ['person:ada'],
    'scrum:importedAt': AT,
  };
  const store = project([...seed(), mint]);
  const { rows } = queryGraph(store, `${SPARQL_PREFIXES}
    SELECT ?w WHERE { ?m a scrum:TendingMint ; scrum:promptVersion ?pv ; scrum:clockWindow ?w }`);
  assert.equal(rows.length, 1, 'a firing cannot be joined back to the words it sent');
});

/**
 * The generic control. The two tests above name the predicates we know about
 * today; this one fails for the NEXT one somebody adds, which is the whole
 * point — a specific-case test only ever catches the case already caught.
 */
test('every predicate any tending writer emits is declared in TENDING_PREDICATES', () => {
  let e = seed();
  e = createPrompt(e, { slug: 'charlie', body: 'C body', by: 'ada', at: AT });
  e = editPrompt(e, { slug: 'charlie', body: 'C v2', by: 'bee', at: AT });
  e = setEnabled(e, { slug: 'charlie', enabled: false, at: AT });
  e = setShuffle(e, { shuffle: false, at: AT });

  const undeclared = new Set();
  for (const entity of e) {
    for (const k of Object.keys(entity)) {
      if (k === '@id' || k === '@type') continue;
      if (!TENDING_PREDICATES[k]) undeclared.add(`${entity['@type']}.${k}`);
    }
  }
  assert.deepEqual([...undeclared], [],
    'a tending writer emits a predicate the projector cannot classify — it will reach the document and never the graph');
});

// ── person identity: the malformed-IRI class ───────────────────────────────

import { person as personIri } from '../core/tending-bootstrap.mjs';

test('an author IRI JOINS to the person node — a double prefix is not caught by existence', () => {
  // DEFECT (shipped 2026-09-05): the authoring module minted `person:<seat>`
  // while the projector prepends the person base to anything non-http, so the
  // stored value became …/person/person:<seat>. It projects, it renders, and it
  // joins to NOTHING — "who wrote this whisper" answers empty, not wrong.
  //
  // ⛔ ASSERTING THE TRIPLE EXISTS WOULD PASS UNDER THE DEFECT. The join is the
  // only assertion that separates a real identity from a plausible string.
  const e = createPrompt(seed(), { slug: 'delta', body: 'D body', by: 'ada', at: AT });
  const store = project(e);
  const { rows } = queryGraph(store, `${SPARQL_PREFIXES}
    SELECT ?a WHERE { ?v a scrum:TendingPromptVersion ; scrum:ofPrompt <${promptId('delta')}> ; schema:author ?a }`);
  assert.equal(rows.length, 1, 'the new version has no author at all');
  assert.equal(rows[0].a, `person:ada`,
    `author IRI is malformed — got ${rows[0].a}; a double-prefixed IRI joins to no person`);
});

test('an already-prefixed `by` does not double-prefix', () => {
  // Callers reasonably pass either shape; only one of them can be stored.
  const e = createPrompt(seed(), { slug: 'echo', body: 'E body', by: 'person:ada', at: AT });
  const v = e.find((x) => x['@id'] === promptVersionId('echo', 1));
  assert.equal(v.author, personIri('ada'), 'a person: prefix was carried into the IRI');
});
