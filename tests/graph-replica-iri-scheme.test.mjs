/**
 * #1426 — the projection must never take the process down on a VALUE.
 *
 * INCIDENT 2026-09-20 15:32Z: a /api/changes row carried the id
 * `https%3A%2F%2Fscrumboard.local%2Fagent%2Fguest` (a URL-ENCODED IRI, written
 * by a PATCH that 404'd); the resident runner handed it into a model-call row's
 * contextHandedTo; projectModelCall saw a string starting with `http`, called
 * oxigraph.namedNode on it, and oxigraph threw `No scheme found in an absolute
 * IRI` — uncaught, REST exited, launchd restarted it, the warm boot replayed the
 * same snapshot and died again, every ~5 minutes, with every graph-backed read
 * 500 in between.
 *
 * Two guards, each with its own sabotage:
 *   A · safeIri() requires a SCHEME: a string without one is minted under the
 *       entity namespace (percent-encoded) and counted, never handed to oxigraph raw.
 *   B · nn() catches a namedNode throw and falls back the same way, so a value
 *       oxigraph rejects for any OTHER reason cannot end the process either.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import oxigraph from 'oxigraph';
import { syncGraphStore, syncGraphStoreChunked, invalidIriSeen, safeIri } from '../core/graph-replica.mjs';

const ENCODED = 'https%3A%2F%2Fscrumboard.local%2Fagent%2Fguest';
const call = (over = {}) => ({
  '@type': 'scrum:ModelCall',
  '@id': 'https://scrumboard.local/model-call/00000000-0000-4000-8000-000000001426',
  'scrum:agent': 'bubbles',
  'scrum:wakeKind': 'channel',
  'scrum:calledAt': '2026-09-20T14:01:13.311Z',
  'scrum:ok': true,
  'scrum:contextHandedTo': ['7394d270-9b6f-43bf-a830-3fcf0c1b4222', ENCODED, 'https://scrumboard.local/agent/guest'],
  ...over,
});
const doc = (...rows) => ({ '@context': {}, '@graph': rows });
const count = (store, q) => [...store.query(`PREFIX scrum: <https://scrumboard.local/ns#>\nSELECT ?o WHERE { ?s scrum:contextHandedTo ?o . ${q} }`)].length;

test('#1426 A — a scheme-less value that starts with `http` does NOT throw: the sync completes and the value is minted under the entity namespace', () => {
  const store = new oxigraph.Store();
  const before = invalidIriSeen.count;
  assert.doesNotThrow(() => syncGraphStore(store, doc(call()), null), 'the projection must survive the encoded IRI');
  assert.equal(count(store, ''), 3, 'all three contextHandedTo values are projected');
  assert.equal(count(store, 'FILTER(STRSTARTS(STR(?o), "https://scrumboard.local/"))'), 3, 'every projected object is a real IRI under the board namespace');
  assert.equal(count(store, `FILTER(CONTAINS(STR(?o), "${encodeURIComponent(ENCODED)}"))`), 1, 'the encoded value survives as a percent-encoded local name, not a raw scheme-less IRI');
  assert.ok(invalidIriSeen.count > before, 'the guard COUNTS what it repaired, so /api/health can say so');
});

test('#1426 A (chunked, the warm-boot path) — the same doc through syncGraphStoreChunked does not throw', async () => {
  const store = new oxigraph.Store();
  await assert.doesNotReject(() => syncGraphStoreChunked(store, doc(call()), null, { batchSize: 1 }));
  assert.equal(count(store, ''), 3);
});

test('#1426 B — safeIri never returns a string oxigraph rejects, for the incident value and for a bare word', () => {
  for (const bad of [ENCODED, 'not-an-iri', 'guest', '']) {
    const s = safeIri(bad);
    assert.doesNotThrow(() => oxigraph.namedNode(s), `safeIri(${JSON.stringify(bad)}) → ${s}`);
    assert.match(s, /^https:\/\/scrumboard\.local\//);
  }
  assert.equal(safeIri('https://scrumboard.local/agent/guest'), 'https://scrumboard.local/agent/guest', 'a good IRI is untouched');
});

test('#1426 B (the catch) — a value WITH a scheme that oxigraph still rejects (`http://[bad`, `http://x/%zz`) cannot end the sync either: minted under the entity namespace', () => {
  const store = new oxigraph.Store();
  const before = invalidIriSeen.count;
  assert.doesNotThrow(() => syncGraphStore(store, doc(call({ 'scrum:contextHandedTo': ['http://[bad', 'http://x/%zz'] })), null));
  assert.equal(count(store, ''), 2, 'both values are projected');
  assert.equal(count(store, 'FILTER(STRSTARTS(STR(?o), "https://scrumboard.local/entity/"))'), 2, 'both minted under the entity namespace');
  assert.ok(invalidIriSeen.count >= before + 2, 'each rescue is counted');
});
