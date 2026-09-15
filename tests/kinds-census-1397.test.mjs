/**
 * #1397 — THE KIND CENSUS COUNTS WITH A QUERY, NOT BY ENUMERATING THE STORE.
 *
 * 2026-09-15 17:4xZ: REST wedged at 191 % CPU, 3.3 GB RSS, memory free. The
 * inspector put 39 % of samples in kindsSummary (server.js) and 38 % in the
 * garbage collector: `store.match(null, null, null)` materialises every quad
 * of the 434k-triple replica as a JS object on EVERY GET /api/board/status —
 * hundreds of MB per call, and board_status is every seat's orientation
 * call. A per-type count is one SPARQL aggregate, milliseconds, no
 * allocation proportional to the store.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraphStore, censusByType } from '../core/graph-replica.mjs';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const doc = { '@graph': [
  { '@id': 'https://scrumboard.local/entity/c1', '@type': 'schema:CreativeWork', identifier: '1', name: 'one', additionalType: 'scrum:Card' },
  { '@id': 'https://scrumboard.local/entity/c2', '@type': 'schema:CreativeWork', identifier: '2', name: 'two', additionalType: 'scrum:Card' },
  { '@id': 'https://scrumboard.local/entity/c3', '@type': 'schema:CreativeWork', identifier: '3', name: 'three', additionalType: 'scrum:Card' },
  { '@id': 'https://scrumboard.local/entity/m1', '@type': 'scrum:Memory', identifier: 'm1', name: 'a memory' },
] };

test('#1397 the census counts every rdf:type exactly as a full enumeration would', () => {
  const store = buildGraphStore(doc);
  // the reference: the enumeration the old code did, kept ONLY in this test
  const ref = {};
  for (const q of store.match(null, null, null)) {
    if (q.predicate.value !== 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' || q.object.termType !== 'NamedNode') continue;
    ref[q.object.value] = (ref[q.object.value] ?? 0) + 1;
  }
  const counts = censusByType(store);
  assert.deepEqual(counts, ref, 'same numbers, same keys (full IRIs)');
  assert.ok(Object.keys(counts).length >= 2 && Object.values(counts).includes(3), `control: two types, one with three instances: ${JSON.stringify(counts)}`);
});

test('#1397 the census NEVER enumerates the store — a store that refuses match(null,null,null) is still counted', () => {
  const real = buildGraphStore(doc);
  const guarded = {
    query: (...a) => real.query(...a),
    match: (s, p, o) => {
      if (s == null && p == null && o == null) throw new Error('match(null,null,null) enumerates 434k quads on prod — the census must not do this');
      return real.match(s, p, o);
    },
    get size() { return real.size; },
  };
  const counts = censusByType(guarded);
  assert.ok(Object.values(counts).includes(3), `counted without enumerating: ${JSON.stringify(counts)}`);
});

test('#1397 served — /api/board/status kinds census is live and its Card count is the board\'s', async (t) => {
  const s = await startRestServer({ board: makeBoardFixture({ cards: [
    { id: 'a', shortId: 1, title: 'A', column: 'backlog' }, { id: 'b', shortId: 2, title: 'B', column: 'backlog' },
  ], nextShortId: 3 }) });
  t.after(() => s.stop());
  await fetch(`${s.baseUrl}/api/graph`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'ASK { ?s ?p ?o }' }) });
  const st = await (await fetch(`${s.baseUrl}/api/board/status`)).json();
  assert.equal(st.kinds.census, 'live');
  const card = st.kinds.kinds.find((k) => k.name === 'scrum:Card');
  assert.equal(card.instances, 2, `two cards on the board ⇒ two scrum:Card instances; got ${JSON.stringify(card)}`);
});
