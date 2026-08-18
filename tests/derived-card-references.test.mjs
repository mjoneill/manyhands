/**
 * #656 step 3 — A CARD THAT CITES #123 IS CONNECTED TO #123.
 *
 * ⚰️ THE MEASUREMENT THAT WARRANTS THIS. Taken against the live board, not
 * imagined:
 *
 *     cards                              790
 *     ISOLATED (no edge of any kind)     359   (45%)
 *     rescued by a #NNN in their text    265
 *     ⇒ isolated after this slice         94   (11%)
 *     edges to emit                    2,695   across 604 cards
 *
 * Nearly half this board is unreachable by traversal, and the references are
 * already written down — in prose, where only a human eye can follow them.
 * ⭐ The number that matters is not 45%→11%. It is that **94 is a LIST** and
 * 45% was a vibes number: after this, "what is still disconnected?" is a query.
 *
 * ── WHAT THIS EDGE ASSERTS, AND WHAT IT REFUSES TO ────────────────────────
 *
 * WEAK, on purpose: *"this card's text mentions that card."* True of all 2,695
 * with zero interpretation. It is NOT a claim that the cards are related, that
 * one blocks the other, or that anybody meant anything by it.
 *
 * ⛔ WHICH IS WHY IT IS NOT `relatedTo`. `relatedTo` is a DELIBERATE assertion
 * a person made, the server maintains its inverse (#614), and 2,695 derived
 * edges poured into it would drown the deliberate ones in the incidental — with
 * no way left to tell which was which. Deliberate assertions stay deliberate.
 *
 * ⛔ AND NOT `mentions`, THE RULED SPELLING — because that term is TAKEN.
 * `mentions` already rides ~12k Comment nodes holding regex-scraped person
 * handles, and under `@vocab: schema.org` it already expands to
 * https://schema.org/mentions as LITERALS. @context terms are document-wide, so
 * typing it @id for card edges types it @id for those handles too — minting
 * IRIs for strangers who never touched this board. That is exactly #619's
 * consent guard, pinned at `tests/people-nodes.test.mjs` ("mentions must NOT be
 * an @id-typed term"). One container, two facts, opposite treatments.
 * ⇒ The ruling's SEMANTICS (weak, mentions-shaped, not relatedTo) survive
 *   intact; only the spelling moved into our own namespace.
 *
 * ── THE ARCHITECTURAL SHAPE: DERIVED AT PROJECTION, NEVER STORED ──────────
 *
 * The edges are computed in `domainToJsonLd` from the card text that is their
 * only authority, and `jsonLdToDomain` DROPS them. There is no second copy, so
 * there is nothing to keep in step and no sync code to get wrong — edit a
 * card's body and its edges are already correct.
 *
 * ⛔ If a future change ever needs to WRITE this predicate into the store, it
 * has left the pattern and should stop. A stored derived edge is #656's whole
 * defect class (D3) reintroduced under a new name.
 *
 * ⚠️ DELIBERATELY NOT IN THIS SLICE: a footer/inline qualifier on each edge
 * (an A/B on whether references written in prose get promoted to deliberate
 * relationships more often than ones parked in a footer). Qualifying an @id
 * edge means reifying it — edges become nodes — and that is a vocabulary change
 * bought for a measurement nobody has asked a question of yet. Ship the edges,
 * then earn it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { domainToJsonLd, jsonLdToDomain, MENTIONS_CARD } from '../core/jsonld.mjs';

const iri = (short) => `https://scrumboard.local/card/${short}`;

/** A minimal card node in the domain's nested-facet shape. */
const card = (short, { text = '', name = 'a card', ...rest } = {}) => ({
  '@id': iri(short),
  '@type': 'CreativeWork',
  identifier: short,
  name,
  text,
  board: {},
  ...rest,
});

/** Project a domain and return its @graph entities keyed by identifier. */
const projectCards = (nodes) => {
  const doc = domainToJsonLd({ nodes, messages: [], people: [], columns: [] });
  const byShort = new Map();
  for (const e of doc['@graph']) if (e.identifier) byShort.set(e.identifier, e);
  return { doc, byShort };
};

test('#656 a card whose text cites #123 gets a derived edge to #123', () => {
  const { byShort } = projectCards([
    card('7', { text: 'this follows on from #123, which measured it' }),
    card('123', { text: 'the measurement' }),
  ]);
  assert.deepEqual(
    byShort.get('7')[MENTIONS_CARD], [iri('123')],
    'a #NNN in a card body must project as an @id edge to that card. This is the '
    + 'whole slice: 265 of 359 isolated cards are rescued by references they '
    + 'already carry in prose.',
  );
});

test('#656 a card that mentions nothing carries no edge at all — not an empty array', () => {
  const { byShort } = projectCards([card('7', { text: 'no references here' })]);
  assert.ok(
    !(MENTIONS_CARD in byShort.get('7')),
    'ABSENCE, not emptiness. `{[MENTIONS_CARD]: []}` asserts "we looked and found '
    + 'none" on every card in the graph — 790 keys of noise — and the rest of this '
    + 'projection is presence-preserving (see cardNodeToFlat). got '
    + JSON.stringify(byShort.get('7')[MENTIONS_CARD]),
  );
});

test('#656 the title counts as text — a reference in the name is a reference', () => {
  const { byShort } = projectCards([
    card('7', { name: 'follow-up to #123', text: '' }),
    card('123', {}),
  ]);
  assert.deepEqual(
    byShort.get('7')[MENTIONS_CARD], [iri('123')],
    'card titles routinely carry the reference ("fix(#123): …"), and a projection '
    + 'that reads only the body would miss them silently',
  );
});

test('#656 a reference to a card that does not exist is DROPPED', () => {
  const { byShort } = projectCards([card('7', { text: 'see #999 (deleted long ago)' })]);
  assert.ok(
    !(MENTIONS_CARD in byShort.get('7')),
    'An @id edge to a node that is not in the graph is not traversable — it is a '
    + 'dangling pointer wearing an edge\'s clothes. ⚠️ NOTE the deliberate '
    + 'difference from `relationships`, where an unknown shortId rides VERBATIM: '
    + 'that data was STORED by a person and losslessness beats tidiness. This is '
    + 'DERIVED, and re-derivable, so dropping loses nothing.',
  );
});

test('#656 a card does not cite itself', () => {
  const { byShort } = projectCards([card('7', { text: 'this card, #7, is about #7' })]);
  assert.ok(
    !(MENTIONS_CARD in byShort.get('7')),
    'a self-edge is true and useless: it connects nothing to nothing and would '
    + 'make 604 cards look one-degree-less isolated than they are',
  );
});

test('#656 repeated citations collapse to one edge, in first-seen order', () => {
  const { byShort } = projectCards([
    card('7', { text: '#123 said it, and #45 disagreed, and #123 replied' }),
    card('123', {}), card('45', {}),
  ]);
  assert.deepEqual(
    byShort.get('7')[MENTIONS_CARD], [iri('123'), iri('45')],
    'the edge is "mentions", not "mentions N times" — a multiplicity the '
    + 'predicate does not claim must not appear in the data',
  );
});

test('#656 a derived edge does not disturb the deliberate one beside it', () => {
  const { byShort } = projectCards([
    { ...card('7', { text: 'and separately, #45 is worth reading' }),
      board: { relationships: { relatedTo: ['123'] } } },
    card('123', {}), card('45', {}),
  ]);
  const e = byShort.get('7');
  assert.deepEqual(e.relatedTo, [iri('123')], 'the deliberate assertion is untouched (#614)');
  assert.deepEqual(e[MENTIONS_CARD], [iri('45')], 'and the derived one rides beside it');
});

test('#656 both predicates can name the same card and stay distinguishable', () => {
  const { byShort } = projectCards([
    { ...card('7', { text: 'see #123' }),
      board: { relationships: { relatedTo: ['123'] } } },
    card('123', {}),
  ]);
  const e = byShort.get('7');
  assert.deepEqual(e.relatedTo, [iri('123')]);
  assert.deepEqual(
    e[MENTIONS_CARD], [iri('123')],
    '⭐ NOT deduplicated against relatedTo. "someone asserted these are related" '
    + 'and "the text happens to say #123" are different facts about the same pair, '
    + 'and collapsing them is how the deliberate one becomes unrecoverable.',
  );
});

// ── the part that keeps this from becoming the defect it fixes ─────────────

test('#656 ⛔ the derived edge is NEVER stored — it does not survive back into the domain', () => {
  const nodes = [card('7', { text: 'see #123' }), card('123', {})];
  const doc = domainToJsonLd({ nodes, messages: [], people: [], columns: [] });
  const back = jsonLdToDomain(doc);
  const seven = back.nodes.find((n) => n.identifier === '7');

  assert.ok(
    !(MENTIONS_CARD in seven) && !('mentionsCard' in (seven.board || {})),
    'THE WHOLE PATTERN. cardNodeToFlat\'s inverse routes any unrecognised '
    + '`scrum:*` key into the board facet, so without an explicit drop this edge '
    + 'would be WRITTEN BACK on the next save — a second copy of a derived fact, '
    + 'which is the exact defect (D3) this card exists to avoid. It would then '
    + 'persist after the text that produced it was edited away. '
    + `got node keys ${JSON.stringify(Object.keys(seven))}, board keys `
    + JSON.stringify(Object.keys(seven.board || {})),
  );
});

test('#656 the round trip is still the identity pair it was before', () => {
  // ⚠️ `people: []` is deliberately absent from this fixture. An empty people
  // list does NOT survive the round trip — measured against the PRE-CHANGE
  // commit, so it is a pre-existing asymmetry in the projection and not
  // something this slice introduced. Asserting it here would have made this
  // test fail for a reason it does not own, and the next reader would have
  // spent the debugging on #656.
  const domain = {
    nodes: [card('7', { text: 'see #123' }), card('123', { text: 'no refs' })],
    messages: [], columns: [], nextShortId: 900,
  };
  assert.deepEqual(
    jsonLdToDomain(domainToJsonLd(domain)), domain,
    'domainToJsonLd ∘ jsonLdToDomain must remain the exact inverse pair — the '
    + 'replay invariant compares BYTES, and a derived key that leaks into the '
    + 'domain breaks every stored event',
  );
});

test('#656 ⛔ #619\'s consent guard is untouched — `mentions` stays a literal', () => {
  const doc = domainToJsonLd({
    nodes: [], columns: [], people: [],
    messages: [{ '@id': 'm1', '@type': 'Comment', text: 'hi @stranger_handle', mentions: ['stranger_handle'] }],
  });
  assert.equal(
    doc['@context'].mentions, undefined,
    'CONSENT GUARD (#619): an @id-typed `mentions` mints IRIs for real people who '
    + 'never touched this board. This slice must not have quietly bought its edge '
    + 'with their identities.',
  );
  assert.deepEqual(
    doc['@graph'][0].mentions, ['stranger_handle'],
    'and the handles are still strings, not references',
  );
});

test('#656 ⛔ shortIds are NUMBERS on the real board — the regex yields strings', () => {
  // ⚰️ THIS IS THE ONE THE FIXTURES MISSED. Every other test in this file uses
  // string identifiers, and all twelve were green while the projection emitted
  // ZERO edges across all 792 cards of the live board: `shortToId` is keyed by
  // whatever `identifier` holds, which is a number, and the regex yields '123'.
  //
  // ⭐ It was not caught by a test. It was caught because the measuring script
  // refused to print a count it could not distinguish from a broken instrument.
  // The lesson is the fixture's, not the code's: a fixture that types a field
  // differently from production tests a system nobody runs.
  const numeric = (n, text) => ({
    '@id': iri(n), '@type': 'CreativeWork', identifier: n, name: 'a card', text, board: {},
  });
  const doc = domainToJsonLd({
    nodes: [numeric(7, 'follows on from #123'), numeric(123, 'the measurement')],
    messages: [], columns: [],
  });
  const seven = doc['@graph'].find((e) => e.identifier === 7);
  assert.deepEqual(
    seven[MENTIONS_CARD], [iri(123)],
    'a numeric identifier must resolve from a string capture. This is the SHAPE '
    + 'the live board actually stores, on all 792 cards.',
  );
});

test('#656 the predicate is namespaced, and the control proves this test can tell', () => {
  // ⭐ CONTROL. Every assertion above reads MENTIONS_CARD from the module. If
  // that constant were ever set to `mentions`, they would all still pass while
  // silently colliding with the person-handle field — the test would be
  // measuring its own import rather than the vocabulary.
  assert.ok(
    MENTIONS_CARD.startsWith('scrum:'),
    `the derived predicate must live in our namespace, not schema.org's shared '
    + 'terms. got ${MENTIONS_CARD}`,
  );
  assert.notEqual(MENTIONS_CARD, 'mentions', 'and must never be the taken term');
});
