/**
 * #1157 — the per-entity hash pass was the sync floor (~190 ms on every sync
 * at 23.8k entities, 95% of them Comments that have no update route). A Comment
 * whose cheap signal (dateCreated, text length, key count, attachment count)
 * did not move keeps its previous hash; everything else is hashed as before.
 * The bet is pinned by #714's parity invariant and bounded by a verify pass
 * that repairs, loudly, anything the signal let through.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraphStore, syncGraphStore, syncGraphStoreChunked, verifyHashCache, cheapSignal } from '../core/graph-replica.mjs';

const dumpSorted = (store) => store.dump({ format: 'application/n-quads' }).split('\n').filter(Boolean).sort().join('\n');
const doc = () => ({
  '@graph': [
    { '@id': 'a1', '@type': 'CreativeWork', identifier: 1, name: 'first', creator: 'ada', relatedTo: ['b2'] },
    { '@id': 'b2', '@type': 'CreativeWork', identifier: 2, name: 'second', 'scrum:priority': 'p2' },
    { '@id': 'https://scrumboard.local/person/ada', '@type': 'Person', identifier: 'ada', name: 'Ada' },
    { '@id': 'm1', '@type': 'Comment', author: 'ada', about: 'a1', text: 'hello', dateCreated: '2026-09-01T00:00:00.000Z' },
    { '@id': 'm2', '@type': 'Comment', author: 'bo', about: 'a1', text: 'second note', dateCreated: '2026-09-01T00:01:00.000Z' },
    { '@id': 'm3', '@type': 'Comment', author: 'bex', text: 'a third', dateCreated: '2026-09-01T00:02:00.000Z', attachments: [{ id: 'x' }] },
  ],
});

test('#1157 a zero-change sync hashes only the non-Comment entities; Comments reuse; the store equals a full rebuild', () => {
  const d = doc();
  const inc = buildGraphStore({ '@graph': [] });
  const cold = syncGraphStore(inc, d, null);
  assert.equal(cold.hashed, 6, 'cold start hashes everything');
  assert.equal(cold.reused, 0);
  const warm = syncGraphStore(inc, d, cold.hashes, { signals: cold.signals });
  assert.equal(warm.reused, 3, 'the three Comments reused their hash');
  assert.equal(warm.hashed, 3, 'card, card, person hashed');
  assert.equal(warm.updated, 0);
  assert.equal(dumpSorted(inc), dumpSorted(buildGraphStore(d)));
});

test('#1157 a Comment whose text CHANGES LENGTH is re-hashed and re-projected on the very next sync', () => {
  const d = doc();
  const inc = buildGraphStore({ '@graph': [] });
  const cold = syncGraphStore(inc, d, null);
  d['@graph'][3].text = 'hello, edited';
  const warm = syncGraphStore(inc, d, cold.hashes, { signals: cold.signals });
  assert.equal(warm.reused, 2);
  assert.equal(warm.hashed, 4);
  assert.equal(warm.updated, 1);
  assert.equal(dumpSorted(inc), dumpSorted(buildGraphStore(d)));
});

test('#1157 NEGATIVE CONTROL — a Comment mutated WITHOUT its signal moving is stale for one sync and then REPAIRED by the verify pass, which names it', () => {
  const d = doc();
  const inc = buildGraphStore({ '@graph': [] });
  const cold = syncGraphStore(inc, d, null);
  // same length, same keys, same attachments: the signal cannot see this
  d['@graph'][3].text = 'HELLO';
  assert.equal(cheapSignal(d['@graph'][3]), cold.signals.get([...cold.signals.keys()].find((k) => k.endsWith('m1'))), 'the fixture really does keep the signal');
  const warm = syncGraphStore(inc, d, cold.hashes, { signals: cold.signals });
  assert.equal(warm.updated, 0, 'the honest limit: the sync alone did not see it');
  assert.notEqual(dumpSorted(inc), dumpSorted(buildGraphStore(d)), 'and the store IS stale at this point — this is what the verify pass exists for');
  const v = verifyHashCache(inc, d, warm.hashes, warm.signals);
  assert.equal(v.checked, 3, 'every cached Comment was full-hashed');
  assert.equal(v.mismatched.length, 1);
  assert.ok(v.mismatched[0].endsWith('m1'), 'the mismatch names the entity');
  assert.equal(dumpSorted(inc), dumpSorted(buildGraphStore(d)), 'repaired');
  // and the repaired hash sticks: the next sync neither re-flags nor re-projects it
  const again = syncGraphStore(inc, d, warm.hashes, { signals: warm.signals });
  assert.equal(again.updated, 0);
  assert.deepEqual(verifyHashCache(inc, d, again.hashes, again.signals).mismatched, []);
});

test('#1157 the chunked path reuses exactly as the synchronous one and stays triple-for-triple with a full rebuild across edits and a removal', async () => {
  const d = doc();
  const inc = buildGraphStore({ '@graph': [] });
  let s = await syncGraphStoreChunked(inc, d, null, { batchSize: 2 });
  d['@graph'][0].name = 'first EDITED';
  d['@graph'].push({ '@id': 'm4', '@type': 'Comment', author: 'ada', text: 'new', dateCreated: '2026-09-02T00:00:00.000Z' });
  s = await syncGraphStoreChunked(inc, d, s.hashes, { batchSize: 2, signals: s.signals });
  assert.equal(s.reused, 3); assert.equal(s.hashed, 4); assert.equal(s.updated, 2);
  d['@graph'] = d['@graph'].filter((e) => e['@id'] !== 'm2');
  s = await syncGraphStoreChunked(inc, d, s.hashes, { batchSize: 2, signals: s.signals });
  assert.equal(s.removed, 1);
  assert.ok(!s.signals.has([...s.signals.keys()].find((k) => k.endsWith('m2')) ?? 'gone'), 'a removed Comment leaves the signal map too');
  assert.equal(dumpSorted(inc), dumpSorted(buildGraphStore(d)));
});

test('#1157 without signals (the legacy call shape) every entity is hashed — the cache is opt-in and callers that never opted in are unchanged', () => {
  const d = doc();
  const inc = buildGraphStore({ '@graph': [] });
  const cold = syncGraphStore(inc, d, null);
  const warm = syncGraphStore(inc, d, cold.hashes);
  assert.equal(warm.reused, 0); assert.equal(warm.hashed, 6);
});
