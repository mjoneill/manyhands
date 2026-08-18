/**
 * #857 §VI — THE FALSIFIER CHECKS BECOME QUERYABLE, so `stale: 0` can be audited.
 *
 * ⚰️ THE FINDING THAT WARRANTS THIS, from rereading the apex card at 13:00Z.
 *
 * `GET /api/checks` reports nine checks on #857 and every one says `holds`.
 * They are not the same KIND of thing:
 *
 *   REAL MEASUREMENT   ASK { ?a a prov:Activity }        asks the STORE whether
 *                      ASK { ?a scrum:mentionsCard ?b }  the capability exists
 *   CARD-STATE PROXY   ASK { ?c schema:identifier "651" ; scrum:column column:done }
 *                                                        asks whether a CARD moved
 *
 * ⇒ ⛔ A proxy watches the same human judgement that rotted §IV three times in
 * thirty-one hours, and it can be wrong in both directions: §IV said "NOT BUILT"
 * about #656 steps 1–2 for FIFTEEN DAYS while they were shipped and live.
 *
 * ⚠️ And in the output the two are INDISTINGUISHABLE. A reader of `stale: 0`
 * cannot tell the five measurements from the four proxies. The defect is not
 * that proxies exist — a proxy is the right instrument when the graph genuinely
 * cannot see the capability (`q` on the card API is an HTTP surface no SPARQL
 * query will ever reach). The defect is that nothing marks which one you are
 * reading.
 *
 * ⭐ THE FIX IS §VI's OWN THESIS, TURNED ON §VI: `checks` is a card field the
 * replica does not read, so "which claims are watched, and by what kind of
 * check?" is a REREAD. This makes it a QUERY.
 *
 * ⛔ AND THE CLASSIFICATION IS DELIBERATELY NOT DONE IN CODE. The projection
 * emits the `ask` text verbatim; a query decides what counts as a proxy. Baking
 * "this pattern means proxy" into the replica would put an interpretation in
 * the store where a fact belongs — and the interpretation would then be
 * unfalsifiable from the outside, which is the exact failure this whole card is
 * about.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraphStore, queryGraph, syncGraphStore } from '../core/graph-replica.mjs';
import { domainToJsonLd } from '../core/jsonld.mjs';

const P = 'PREFIX scrum: <https://scrumboard.local/ns#>\nPREFIX schema: <https://schema.org/>\n';
const rows = async (store, q) => {
  const r = await queryGraph(store, P + q);
  return r.rows ?? r;
};

const card = (id, shortId, checks) => ({
  '@type': 'CreativeWork', '@id': id, identifier: shortId, name: 'a card', text: '',
  additionalType: 'scrum:goal',
  board: { column: 'backlog', relationships: { relatedTo: [] }, ...(checks ? { checks } : {}) },
});

const MEASUREMENT = {
  claim: 'activities are built', ask: 'ASK { ?a a prov:Activity }', expect: true,
};
const PROXY = {
  claim: 'MEMORY as a graph type is not built',
  ask: 'ASK { ?c schema:identifier "651" ; scrum:column column:done }',
  expect: false,
};

const doc = (checks = [MEASUREMENT, PROXY]) => domainToJsonLd({
  nodes: [card('u-a', 1, checks), card('u-b', 2, null)],
  messages: [], people: [], columns: [],
});

test('#857 §VI a card\'s checks are reachable by query, paired claim-to-ask', async () => {
  const store = await buildGraphStore(doc());
  const r = await rows(store, `
    SELECT ?claim ?ask ?expect WHERE {
      ?c schema:identifier "1" ; scrum:hasCheck ?chk .
      ?chk scrum:claim ?claim ; scrum:ask ?ask ; scrum:expect ?expect .
    } ORDER BY ?claim`);
  assert.equal(r.length, 2, `both checks must project. got ${JSON.stringify(r)}`);
  // ⭐ PAIRING is the whole reason each check gets a NODE rather than three
  // literals on the card. Two checks flattened onto one subject would give six
  // literals and no way to say which ask belongs to which claim — the same
  // one-container-two-facts defect this card keeps finding.
  const byClaim = Object.fromEntries(r.map((x) => [String(x.claim), String(x.ask)]));
  assert.match(byClaim['activities are built'], /prov:Activity/, 'the measurement keeps its own ask');
  assert.match(byClaim['MEMORY as a graph type is not built'], /identifier "651"/, 'and the proxy keeps its own');
});

test('#857 §VI ⭐ THE QUESTION THIS EXISTS FOR: which checks are proxies?', async () => {
  // The classification lives HERE, in a query, not in the projection.
  const store = await buildGraphStore(doc());
  const proxies = await rows(store, `
    SELECT ?claim WHERE {
      ?c scrum:hasCheck ?chk . ?chk scrum:claim ?claim ; scrum:ask ?ask .
      FILTER(CONTAINS(?ask, "scrum:column"))
    }`);
  const measurements = await rows(store, `
    SELECT ?claim WHERE {
      ?c scrum:hasCheck ?chk . ?chk scrum:claim ?claim ; scrum:ask ?ask .
      FILTER(!CONTAINS(?ask, "scrum:column"))
    }`);
  assert.equal(proxies.length, 1, `exactly one card-state proxy here. got ${JSON.stringify(proxies)}`);
  assert.equal(measurements.length, 1, `and exactly one real measurement. got ${JSON.stringify(measurements)}`);
  // ⭐ CONTROL: the two partitions must be DIFFERENT claims. A filter that
  // matched everything, or nothing, would satisfy one of the counts above by
  // accident on a two-item fixture.
  assert.notEqual(String(proxies[0].claim), String(measurements[0].claim),
    'the partition must actually split — same claim on both sides means the FILTER is inert');
});

test('#857 §VI a card with no checks contributes nothing — control', async () => {
  const store = await buildGraphStore(doc());
  // ⭐ ANCHOR FIRST. This test asserts an ABSENCE, so it passes for free against
  // any query that matches nothing — and the first version did exactly that: it
  // wrote `schema:identifier 2` where the store holds the STRING "2", so the
  // pattern could never bind and the zero measured the literal type, not the
  // projection. An absence assertion needs proof the subject was reachable.
  const anchor = await rows(store, 'SELECT ?c WHERE { ?c schema:identifier "2" }');
  assert.equal(anchor.length, 1, 'anchor: card #2 must be findable, or the absence below is free');

  const r = await rows(store, 'SELECT ?chk WHERE { ?c schema:identifier "2" ; scrum:hasCheck ?chk }');
  assert.equal(r.length, 0, `an unwatched card must emit no check node. got ${JSON.stringify(r)}`);
});

// ── the orphan hazard, which is #687's D5 in a new place ───────────────────

test('#857 §VI ⛔ REMOVING a check removes its node — no orphan survives', async () => {
  // ⚰️ #687 shipped an orphan of exactly this shape: a derived node hanging off
  // a FOREIGN subject, invisible to `updateEntity`'s subject-scoped deletion,
  // present in a synced store and absent from a rebuilt one. A check node is
  // the same shape. The whole suite was green with that orphan in place.
  const store = await buildGraphStore(doc());
  const { hashes } = syncGraphStore(store, doc(), null);
  syncGraphStore(store, doc([MEASUREMENT]), hashes);          // the proxy is dropped

  const synced = await rows(store, 'SELECT ?claim WHERE { ?chk scrum:claim ?claim }');
  const rebuilt = await rows(await buildGraphStore(doc([MEASUREMENT])),
    'SELECT ?claim WHERE { ?chk scrum:claim ?claim }');

  assert.equal(rebuilt.length, 1, 'a rebuild holds only the surviving check');
  assert.equal(
    synced.length, rebuilt.length,
    '#714 PARITY. A dropped check whose node lives on in the synced store is a claim '
    + 'the running server reports as watched and no rebuild agrees with — and nobody '
    + `rebuilds to check. synced ${JSON.stringify(synced.map((x) => String(x.claim)))}, `
    + `rebuilt ${JSON.stringify(rebuilt.map((x) => String(x.claim)))}`,
  );
});

test('#857 §VI ⛔ and it does not OVER-collect: another card\'s checks survive', async () => {
  // ⭐ The paired half of the sweep test, per #687's lesson: over-collecting is
  // the more damaging bug, because it silently narrows every query rather than
  // widening one.
  const twoWatched = (checks) => domainToJsonLd({
    nodes: [card('u-a', 1, checks), card('u-b', 2, [MEASUREMENT])],
    messages: [], people: [], columns: [],
  });
  const store = await buildGraphStore(twoWatched([PROXY]));
  const { hashes } = syncGraphStore(store, twoWatched([PROXY]), null);
  syncGraphStore(store, twoWatched([]), hashes);              // card 1 loses all its checks

  const left = await rows(store, `
    SELECT ?id ?claim WHERE { ?c schema:identifier ?id ; scrum:hasCheck ?chk . ?chk scrum:claim ?claim }`);
  assert.equal(left.length, 1, `card #2's check must survive card #1's sweep. got ${JSON.stringify(left)}`);
  assert.equal(String(left[0].id), '2', 'and it must be the OTHER card that still holds one');
});
