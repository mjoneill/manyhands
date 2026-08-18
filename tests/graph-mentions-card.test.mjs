/**
 * #656 step 3, THE HALF THAT WAS MISSING — the derived edge reaches the
 * TRAVERSAL SURFACE.
 *
 * ⚰️ HOW THIS WAS FOUND, an hour after shipping. The projection was built,
 * tested thirteen ways, mutation-verified, measured against the live board
 * (2,706 edges, isolation 360 → 94), pushed, deployed. Then, against the
 * running binary:
 *
 *   SELECT (COUNT(*) AS ?n) WHERE { ?a scrum:mentionsCard ?b }   ⇒  0
 *
 * The edges were in the document and in no query. `projectEntity` walks
 * `REL_TYPES` — an explicit list — so a predicate not on that list is invisible
 * to SPARQL no matter how correctly it is serialized. The whole warrant of the
 * card is TRAVERSAL, and the traversal surface could not see it.
 *
 * ⇒ ⭐ THE THREE-LIST INVARIANT, failing at the third list: the vocabulary
 * declared it, the projection emitted it, and the consumer did not read it.
 * Two of three green looks exactly like done.
 *
 * ⚠️ WHY NO EXISTING TEST COULD CATCH IT. Every #656 test asserts on the
 * DOCUMENT, which is where the edge correctly was. Same class as #725's
 * activities and #687's concepts: built, tested, unreached. The only instrument
 * that finds this family is one that asks the QUESTION THE FEATURE EXISTS TO
 * ANSWER, on the surface a user would ask it.
 *
 * ⛔ So this file queries. It never inspects the document.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraphStore, queryGraph } from '../core/graph-replica.mjs';
import { domainToJsonLd } from '../core/jsonld.mjs';

const card = (id, shortId, name, text) => ({
  '@type': 'CreativeWork', '@id': id, identifier: shortId, name, text,
  additionalType: 'scrum:task',
  board: { column: 'backlog', relationships: { relatedTo: [] } },
});

// ⚠️ NUMERIC shortIds, which is what the live board stores. A fixture typing
// them as strings was green while the projection emitted zero edges across all
// 792 real cards.
const doc = () => domainToJsonLd({
  nodes: [
    card('u-a', 1, 'alpha', 'this follows on from #2, which measured it'),
    card('u-b', 2, 'beta', 'the measurement'),
    card('u-c', 3, 'gamma', 'mentions nobody'),
  ],
  messages: [], people: [], columns: [],
});

const P = 'PREFIX scrum: <https://scrumboard.local/ns#>\n';

test('#656 a card that cites another is REACHABLE BY QUERY, not just serialized', async () => {
  const store = await buildGraphStore(doc());
  const res = await queryGraph(store, `${P}SELECT ?a ?b WHERE { ?a scrum:mentionsCard ?b }`);
  const rows = res.rows ?? res;
  assert.equal(
    rows.length, 1,
    'THE POINT OF THE CARD. #656 exists so "what connects to what" is a query — '
    + '2,706 edges rescuing 266 isolated cards buy nothing if SPARQL cannot see '
    + `them. got ${JSON.stringify(rows)}`,
  );
  assert.ok(String(rows[0].a).endsWith('u-a'), `subject must be the citing card, got ${rows[0].a}`);
  assert.ok(String(rows[0].b).endsWith('u-b'), `object must be the cited card, got ${rows[0].b}`);
});

test('#656 the query answers the question a person would actually ask', async () => {
  // "What mentions #2?" — the backlink direction, which is where the value is:
  // an isolated card becomes findable from the cards that reference it.
  const store = await buildGraphStore(doc());
  const res = await queryGraph(store, `${P}
    SELECT ?citing WHERE { ?citing scrum:mentionsCard <https://scrumboard.local/entity/u-b> }`);
  const rows = res.rows ?? res;
  assert.equal(rows.length, 1, `expected #1 to be found citing #2, got ${JSON.stringify(rows)}`);
});

test('#656 a card that mentions nothing contributes no triple — control', async () => {
  // ⭐ CONTROL. Without it, a replica that minted an edge for EVERY card would
  // pass the assertions above while making the whole graph meaningless — every
  // card connected to every card is the same information as none.
  const store = await buildGraphStore(doc());
  const res = await queryGraph(store, `${P}
    SELECT ?b WHERE { <https://scrumboard.local/entity/u-c> scrum:mentionsCard ?b }`);
  const rows = res.rows ?? res;
  assert.equal(rows.length, 0, `#3 mentions nobody and must contribute nothing, got ${JSON.stringify(rows)}`);
});

test('#656 ⛔ the derived edge does not masquerade as the deliberate one', async () => {
  // The predicates must stay distinguishable in the store, or the whole reason
  // for not reusing `relatedTo` is lost at the surface where it matters most.
  const store = await buildGraphStore(doc());
  const res = await queryGraph(store, `${P}SELECT ?a ?b WHERE { ?a scrum:relatedTo ?b }`);
  const rows = res.rows ?? res;
  assert.equal(
    rows.length, 0,
    'no card here asserts relatedTo. A derived edge appearing under the '
    + `deliberate predicate would be #614's meaning quietly overwritten. got ${JSON.stringify(rows)}`,
  );
});

// ── #714 parity: a synced store and a rebuilt store must agree ─────────────

/**
 * ⚠️ THE HAZARD THIS SECTION EXISTS FOR, and it is not obvious.
 *
 * Every other projected fact is a property OF THE ENTITY: change card A and
 * only card A's triples are wrong. This edge is different — its validity
 * depends on ANOTHER CARD. Delete the card #NNN names and A's edge must vanish,
 * without A itself having been touched. That is exactly the shape of #687's D5
 * orphan (a derived fact whose lifetime is not the lifetime of the subject it
 * hangs from), and an incremental sync is where it would break.
 *
 * ⭐ It holds — but NOT because anyone guarded it here. `syncGraphStore` hashes
 * the PROJECTED entity, and the projection recomputes derived edges over the
 * whole graph, so deleting #2 changes #1's serialized form and #1 re-projects
 * on its own. The property is real and load-bearing and was inherited, which is
 * the best reason to pin it: nothing in the sync path says "derived edges", so
 * a future change to the hash input could take it away silently.
 */
const docWithout2 = () => domainToJsonLd({
  nodes: [
    card('u-a', 1, 'alpha', 'this follows on from #2, which measured it'),
    card('u-c', 3, 'gamma', 'mentions nobody'),
  ],
  messages: [], people: [], columns: [],
});

const countEdges = async (store) => {
  const res = await queryGraph(store, `${P}SELECT ?a ?b WHERE { ?a scrum:mentionsCard ?b }`);
  return (res.rows ?? res).length;
};

test('#656 deleting the CITED card removes the edge on the CITING one — parity with a rebuild', async () => {
  const { syncGraphStore, buildGraphStore: build } = await import('../core/graph-replica.mjs');

  const store = await build(doc());
  assert.equal(await countEdges(store), 1, 'setup: the edge must exist before it can be removed');

  // Establish the hash baseline the way the server does, then drop card #2.
  const { hashes } = syncGraphStore(store, doc(), null);
  syncGraphStore(store, docWithout2(), hashes);
  const synced = await countEdges(store);

  const rebuilt = await countEdges(await build(docWithout2()));

  assert.equal(
    rebuilt, 0,
    'a rebuild must drop it: #1 still SAYS "#2", but #2 is gone, so the '
    + 'projection resolves nothing and emits nothing',
  );
  assert.equal(
    synced, rebuilt,
    '#714 PARITY. A stale edge to a deleted card surviving only in the synced '
    + 'store is a fact that exists in the running server and in no rebuild — '
    + `invisible precisely because nobody rebuilds to check. synced ${synced}, rebuilt ${rebuilt}`,
  );
});

test('#656 creating the cited card ADDS the edge to the untouched citing card', async () => {
  // The same coupling in the other direction, and the more common case: cards
  // routinely reference a number before that card exists.
  const { syncGraphStore, buildGraphStore: build } = await import('../core/graph-replica.mjs');
  const store = await build(docWithout2());
  const { hashes } = syncGraphStore(store, docWithout2(), null);
  assert.equal(await countEdges(store), 0, 'setup: no edge while #2 does not exist');

  syncGraphStore(store, doc(), hashes);
  assert.equal(
    await countEdges(store), 1,
    'card #1 was NOT edited — only #2 appeared. The edge must appear anyway, or '
    + 'every forward reference stays broken until someone happens to re-save the '
    + 'card that made it.',
  );
});
