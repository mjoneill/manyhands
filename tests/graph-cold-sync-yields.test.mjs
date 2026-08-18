/**
 * #884 — a cold projection must not take the server with it.
 *
 * ⛔ MEASURED IN PRODUCTION, 2026-08-18. Every boot re-projects the whole store:
 *
 *     18:10:28  synced 17463 updated, 0 removed OF 17463 entities … 24411ms
 *     slowest today: 13828 · 14795 · 15851 · 17472 · 24411 · 24788 · 28975 · 29500
 *     boots today:   85
 *
 * `oxigraph.store.add` is SYNCHRONOUS. 137,000 triples on the main thread means
 * the node event loop is blocked for the whole projection, so the server answers
 * NOTHING while it warms — not /api/graph, not /api/cards, not the browser.
 *
 * ⇒ "the board is down" has meant "someone restarted it".
 *
 * ⭐ THE PROPERTY THIS FILE PINS IS NOT SPEED. A faster projection that still
 * blocks is the same outage, shorter. The property is that the process REMAINS
 * RESPONSIVE while projecting — so the fix is measured by whether other work
 * runs during the sync, never by how long the sync takes.
 *
 * ⚠️ And parity is non-negotiable: #714's whole invariant is that an
 * incrementally-maintained store is triple-for-triple identical to a full
 * rebuild. A chunked projection that drifts from the synchronous one would trade
 * an outage for a correctness bug, which is a worse trade.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraphStore, syncGraphStore, syncGraphStoreChunked } from '../core/graph-replica.mjs';
import { domainToJsonLd } from '../core/jsonld.mjs';

/** A board big enough that a synchronous projection is visibly non-trivial. */
function bigDoc(n) {
  const nodes = [];
  for (let i = 1; i <= n; i++) {
    nodes.push({
      '@type': 'CreativeWork', '@id': `u-${i}`, identifier: i, name: `card ${i}`,
      text: 'body '.repeat(20), additionalType: 'scrum:task',
      board: {
        column: 'backlog', order: i, assignees: ['ada'], labels: ['x', 'y'], for: '',
        priority: 'p2',
        relationships: {
          relatedTo: i > 1 ? [`u-${i - 1}`] : [], blockedBy: [], supersedes: [],
          derivedFrom: [], supersededBy: [],
        },
      },
    });
  }
  return domainToJsonLd({
    nodes, messages: [], people: [], columns: [{ id: 'backlog', name: 'Backlog', order: 0 }],
    nextShortId: n + 1, lastUpdated: null,
  });
}

test('#884 chunked cold projection is TRIPLE-FOR-TRIPLE identical to the synchronous one', async () => {
  // ⛔ Parity first. #714's invariant is the thing a chunked path could quietly
  // break, and an outage traded for a correctness bug is the worse trade.
  const doc = bigDoc(300);

  const sync = buildGraphStore({ '@graph': [] });
  const syncStats = syncGraphStore(sync, doc, null);

  const chunked = buildGraphStore({ '@graph': [] });
  const chunkStats = await syncGraphStoreChunked(chunked, doc, null, { batchSize: 25 });

  assert.equal(chunked.size, sync.size, 'same triple count');
  assert.equal(chunkStats.updated, syncStats.updated, 'same entities projected');
  assert.equal(chunkStats.removed, syncStats.removed);
  assert.deepEqual([...chunkStats.hashes.keys()].sort(), [...syncStats.hashes.keys()].sort(),
    'same hash map — the incremental path must behave identically afterwards');
});

test('#884 THE PROPERTY — other work runs WHILE the cold projection is in flight', async () => {
  // ⭐ This is the whole card. Not "the sync is faster" — "the server is alive".
  // A timer scheduled before the projection starts must fire DURING it; under
  // the synchronous path it cannot fire until the projection has completely
  // finished, because the event loop never gets a turn.
  const doc = bigDoc(400);
  const store = buildGraphStore({ '@graph': [] });

  let tickedDuringSync = false;
  let syncDone = false;
  const ticker = setInterval(() => { if (!syncDone) tickedDuringSync = true; }, 1);

  await syncGraphStoreChunked(store, doc, null, { batchSize: 20 });
  syncDone = true;
  clearInterval(ticker);

  assert.equal(tickedDuringSync, true,
    'the event loop never got a turn — the projection is still blocking, which is '
    + 'the outage this card exists to remove');
});

test('#884 the SYNCHRONOUS path starves the loop — the control that proves the test discriminates', async () => {
  // ⚠️ Without this, the test above would pass against any implementation,
  // including one that yields for reasons unrelated to the fix. This pins that
  // the OLD behaviour genuinely fails the property.
  const doc = bigDoc(400);
  const store = buildGraphStore({ '@graph': [] });

  let ticked = false;
  const ticker = setInterval(() => { ticked = true; }, 1);
  syncGraphStore(store, doc, null);          // synchronous — no awaits inside
  clearInterval(ticker);

  assert.equal(ticked, false,
    'the synchronous path let a timer fire, so this test cannot tell blocking from '
    + 'non-blocking and proves nothing about the fix');
});

test('#884 chunking is incremental-safe: a warm re-sync still touches only what changed', async () => {
  // The cold path is the one that hurts, but the chunked function is what the
  // server will call every time. If it re-projected everything on a warm sync it
  // would turn a 1s steady state into a 24s one — the opposite of the fix.
  const doc = bigDoc(200);
  const store = buildGraphStore({ '@graph': [] });
  const first = await syncGraphStoreChunked(store, doc, null, { batchSize: 25 });
  assert.equal(first.updated, 200 + 1, 'cold: every entity plus the column');

  const second = await syncGraphStoreChunked(store, doc, first.hashes, { batchSize: 25 });
  assert.equal(second.updated, 0, 'warm: nothing changed, nothing re-projected');
  assert.equal(second.removed, 0);
});
