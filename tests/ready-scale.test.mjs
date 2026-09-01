/**
 * core/ready-query.mjs — #1121: the queue must survive a board larger than
 * one page of its own sub-queries.
 *
 * WHAT BROKE, MEASURED (2026-09-01, live board): `readyFactsQuery` selects
 * every `schema:CreativeWork` with an identifier and a name — **done cards
 * included, no column filter**. Once the board passed 1000 such rows the
 * query hit its `{ limit: 1000 }` cap, set `facts.truncated`, and
 * `readyFromStore` threw `READY_TRUNCATED`. Every call to /api/ready refused,
 * including `explain` for a single card.
 *
 * ⚠️ Moving cards to `done` does NOT relieve it — they are still counted.
 * Measured same-moment: solutions 1005 = COUNT(DISTINCT ?card) 1005 =
 * /api/cards 1005, i.e. exactly one row per card, no OPTIONAL multiplication
 * and no extra entity types. (An earlier note on #1121 claimed a 1006-vs-1001
 * gap from multiplication; that compared two counts taken an hour apart, with
 * cards filed in between. Take comparands at one moment.)
 *
 * The other four capped sub-queries were measured at the same moment and are
 * nowhere near their caps (blockers 26, superseded 12, humanBlockers 33,
 * conditionBlockers 0) — so `facts` is the sole cause and the only one this
 * test needs to drive.
 *
 * ⚠️ THE FAILURE IS NOT "IT THROWS" — that is the surface. Refusing a partial
 * queue is CORRECT and deliberate (a queue computed from part of the blocker
 * set would mistake an UNREAD scoping for an ABSENT one — the false-PASS
 * direction). The defect is that the cap is reachable by ordinary use, so the
 * behaviour under test is **the queue is COMPLETE over a board of any size**:
 * a ready card sitting past the old cap must appear, and readyTotal must
 * count the whole population.
 *
 * A test that only asserted `doesNotThrow` would pass against an
 * implementation that raised the cap and silently dropped row 1001.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { domainToJsonLd } from '../core/jsonld.mjs';
import { buildGraphStore } from '../core/graph-replica.mjs';
import { readyFromStore, pageReady, READY_EXPLAIN } from '../core/ready-query.mjs';

/** One page of the sub-query caps this card is about. */
const SUBQUERY_PAGE = 1000;

/** Comfortably past the cap, and past it by more than the 5 rows the live
 *  board happened to be over — a fixture that clears the bound by one is a
 *  fixture that passes again the moment anything else adds a row. */
const POPULATION = SUBQUERY_PAGE + 200;

const card = (id, shortId, name, extra = {}) => ({
  '@id': id, '@type': 'CreativeWork', identifier: shortId, name, board: {}, ...extra,
});

/** A board of `n` plain backlog cards: unclaimed, unblocked, all READY.
 *  Deliberately homogeneous — this fixture tests SIZE, and every card being
 *  ready makes the completeness assertion exact rather than approximate. */
const bigDomain = (n) => ({
  nodes: Array.from({ length: n }, (_, i) =>
    card(`c${i + 1}`, i + 1, `card-${i + 1}`, { column: 'backlog', 'scrum:priority': 'p2' })),
  messages: [], people: [], columns: [],
});

const storeFor = (d) => buildGraphStore(domainToJsonLd(d));

test('ready: a board past one sub-query page still computes a COMPLETE queue', () => {
  const store = storeFor(bigDomain(POPULATION));

  // The control that names the fixture rather than trusting it: if the
  // fixture failed to build the population, the completeness assertion below
  // would pass vacuously against a truncating implementation.
  // NOTE: the raw oxigraph store has NO pre-declared prefixes (that is a
  // convenience of the MCP surface, not of the store) — declare it here, or
  // the control throws a parse error and a broken control reads exactly like
  // a broken implementation.
  const built = store.query(
    'PREFIX schema: <https://schema.org/> ' +
    'SELECT (COUNT(*) AS ?n) WHERE { ?c a schema:CreativeWork ; schema:identifier ?id ; schema:name ?t }',
  );
  const builtRows = Number(built?.[0]?.get?.('n')?.value ?? built?.rows?.[0]?.n ?? 0);
  assert.ok(
    builtRows > SUBQUERY_PAGE,
    `fixture must exceed the ${SUBQUERY_PAGE}-row cap to exercise this at all; built ${builtRows}`,
  );

  const { ready, readyTotal } = pageReady(readyFromStore(store), { limit: POPULATION });

  // THE BEHAVIOUR: every card is ready, so the queue must carry all of them.
  assert.equal(readyTotal, POPULATION, 'readyTotal must count the whole board, not one page');
  assert.equal(ready.length, POPULATION, 'the paged queue must return every ready card asked for');

  // Position-discriminating: a card past the old cap must be present by name.
  // An implementation that raised the cap but kept a 1000-row ceiling
  // somewhere else fails HERE and passes everything above.
  const last = ready.find((c) => c.shortId === POPULATION);
  assert.ok(last, `card #${POPULATION} (past the ${SUBQUERY_PAGE} cap) must be in the queue`);
  assert.equal(last.title, `card-${POPULATION}`);
});

test('ready: explain answers for a card past the cap', () => {
  const store = storeFor(bigDomain(POPULATION));
  const verdicts = readyFromStore(store);

  // /api/ready?explain=N refused for EVERY card while truncated — a
  // single-card question could not be answered on a board too big to page.
  // Asked through the real explain surface, not by reaching into the verdict
  // shape: this is the call the endpoint makes.
  const verdict = READY_EXPLAIN(verdicts, POPULATION);
  assert.equal(verdict.shortId, POPULATION);
  assert.equal(verdict.ready, true, `card #${POPULATION} is unclaimed and unblocked`);

  // The falsifier for this test itself: explain must still REFUSE a card that
  // genuinely does not exist. A version that answered everything would pass
  // the assertion above while telling the caller nothing.
  assert.throws(() => READY_EXPLAIN(verdicts, POPULATION + 1), (e) => e.code === 'UNKNOWN_CARD');
});
