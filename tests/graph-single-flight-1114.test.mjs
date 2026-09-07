/**
 * #1114 — THE REPLICA SYNC HAD NO IN-FLIGHT GUARD, so N concurrent readers
 * each ran their own full sync of the same document.
 *
 * Measured across all 1,326 syncs on 2026-09-07, from the log line the server
 * has emitted all along (`server.js`, "graph-replica: synced …"):
 *
 *     concurrent syncs   count    median ms      max ms
 *           0               81          316       27,596
 *           2            1,017        3,219      101,060
 *           6+             159      115,807      575,608
 *
 * A sync running alone costs 316 ms. Six or more racing: median 115,807 ms, on
 * a store whose entity count moved 4% all day. The worst observed was
 * "1 updated, 0 removed of 27,721 entities (hashed 2,344, reused 25,377) …
 * in 575,608 ms" — NINE AND A HALF MINUTES TO UPDATE ONE ENTITY, while
 * correctly reusing 25,377 of them. The incremental diff (#714) was never the
 * problem; it was being run many times at once.
 *
 * ⛔ AND A FIX OPENED IT. #884 made the projection CHUNKED so it yields to the
 * event loop between batches — deliberately, so other requests get a turn
 * during a sync. Those requests call warmGraphStore(), find `_graphDirty`
 * still true (it clears only at the end), and start their own. The yield that
 * makes it polite is the yield that lets the herd in.
 *
 * ⚠️ SO THE TESTS BELOW COUNT SYNCS, NEVER TIME THEM. A faster sync run seven
 * times is the same outage, and a timing assertion would pass for the wrong
 * reason on a quiet machine.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer } from './helpers/harness.mjs';

const j = (r) => r.json();
const post = (base, p, body) => fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const graph = (base, query = 'SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o }') =>
  post(base, '/api/graph', { query });

/** The server's own count of completed syncs. */
async function syncCount(base) {
  const r = await j(await graph(base));
  const n = r?.timing?.syncCount;
  assert.equal(typeof n, 'number', `the graph response must report syncCount, got: ${JSON.stringify(r?.timing)}`);
  return n;
}

const makeCard = async (base, title) => {
  const r = await post(base, '/api/cards', { title, by: 'ada', column: 'backlog' });
  // Read the body ONCE: an `await r.text()` inside an assertion MESSAGE is
  // evaluated eagerly even when the assertion passes, and consumes the body.
  const raw = await r.text();
  assert.equal(r.status, 201, raw);
  return JSON.parse(raw).shortId;
};

/**
 * ⛔ THE BOARD MUST EXCEED THE CHUNK BOUNDARY OR THESE TESTS CANNOT FAIL.
 *
 * `syncGraphStoreChunked` yields (`await new Promise(setImmediate)`) once per
 * `batchSize = 250` entities. Below that the sync never yields, so it finishes
 * before a second request is dispatched, `_graphDirty` is already false, and
 * NO HERD FORMS EVEN WITH THE GUARD REMOVED.
 *
 * ⚠️ Measured while writing this: on a 40-entity board, deleting the guard left
 * all seven tests GREEN — an acceptance test that could not fail, on the card
 * about checks that cannot fail. On 1,200 entities the same deletion produces
 * FIVE syncs where there should be one. The fixture size is load-bearing.
 */
const SEEDED_ENTITIES = 1200;

const bigBoard = () => ({
  columns: [{ id: 'backlog', name: 'Backlog' }, { id: 'done', name: 'Done' }],
  nextShortId: SEEDED_ENTITIES + 1,
  cards: Array.from({ length: SEEDED_ENTITIES }, (_, i) => ({
    id: `card-${i}`, shortId: i + 1, title: `seeded card ${i}`, column: 'backlog',
    description: 'x'.repeat(200), version: 1,
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
  })),
});

async function withServer(fn) {
  const s = await startRestServer({ board: bigBoard() });
  try { return await fn(s); } finally { await s.stop(); }
}

test('#1114 ⭐ N CONCURRENT READERS ON A DIRTY STORE PRODUCE EXACTLY ONE SYNC', async () => {
  await withServer(async (s) => {
    await graph(s.baseUrl);                    // warm: get past the cold build
    const before = await syncCount(s.baseUrl);

    await makeCard(s.baseUrl, 'dirties the store');

    // Eight readers, fired without awaiting any of them: they overlap in
    // flight, which is the exact condition that produced the herd.
    const results = await Promise.all(Array.from({ length: 8 }, () => graph(s.baseUrl)));
    for (const r of results) assert.equal(r.status, 200);

    const after = await syncCount(s.baseUrl);
    assert.equal(after - before, 1,
      `eight concurrent readers must produce ONE sync, not ${after - before}`);
  });
});

test('#1114 ⛔ NEGATIVE CONTROL — a SEQUENTIAL reader after a completed sync still gets a FRESH projection', async () => {
  // The failure a memo introduces: one that outlives its sync serves a STALE
  // graph, which is worse than a slow one because it is silent. Each write
  // must still be visible to the next reader.
  await withServer(async (s) => {
    await graph(s.baseUrl);
    const titles = ['first sequential card', 'second sequential card', 'third sequential card'];
    for (const t of titles) {
      await makeCard(s.baseUrl, t);
      const rows = await j(await graph(s.baseUrl, `ASK { ?c schema:name ${JSON.stringify(t)} }`));
      assert.equal(rows.ask, true, `"${t}" must be in the graph on the very next read`);
    }
  });
});

test('#1114 ⛔ …and the memo does not outlive its sync — a later dirty read syncs AGAIN', async () => {
  // The complement: single-flight must collapse CONCURRENT syncs and must not
  // suppress LATER ones. A guard that never releases looks identical to a fast
  // server until the graph is hours stale.
  await withServer(async (s) => {
    await graph(s.baseUrl);
    const start = await syncCount(s.baseUrl);

    await makeCard(s.baseUrl, 'round one');
    await Promise.all([graph(s.baseUrl), graph(s.baseUrl), graph(s.baseUrl)]);
    const afterFirst = await syncCount(s.baseUrl);
    assert.equal(afterFirst - start, 1, 'round one: one sync');

    await makeCard(s.baseUrl, 'round two');
    await Promise.all([graph(s.baseUrl), graph(s.baseUrl), graph(s.baseUrl)]);
    const afterSecond = await syncCount(s.baseUrl);
    assert.equal(afterSecond - afterFirst, 1, 'round two must sync AGAIN — the memo released');
  });
});

test('#1114 — a clean store serves concurrent readers with NO sync at all', async () => {
  // The floor. If nothing changed, nobody should be projecting anything.
  await withServer(async (s) => {
    await makeCard(s.baseUrl, 'settle');
    await graph(s.baseUrl);
    const before = await syncCount(s.baseUrl);
    await Promise.all(Array.from({ length: 6 }, () => graph(s.baseUrl)));
    assert.equal(await syncCount(s.baseUrl), before, 'a clean store must not sync');
  });
});

test('#1114 — every concurrent reader gets a CORRECT answer, not just one of them', async () => {
  // Sharing one sync must not mean sharing one caller's luck: the seven that
  // joined must see the same post-sync graph as the one that ran it.
  await withServer(async (s) => {
    await graph(s.baseUrl);
    await makeCard(s.baseUrl, 'visible to every joiner');
    const answers = await Promise.all(Array.from({ length: 8 }, () =>
      graph(s.baseUrl, 'ASK { ?c schema:name "visible to every joiner" }').then(j)));
    for (const [i, a] of answers.entries()) {
      assert.equal(a.ask, true, `joiner ${i} must see the write that dirtied the store`);
    }
  });
});

test('#1114 ⛔ THE LOG LINE THAT FOUND THIS MUST NOT REGRESS — it still reports compared vs reused', async () => {
  // This line is the only reason the herd was diagnosable, and it had been
  // running 1,326 times a day into a file nobody read. If a refactor drops the
  // hashed/reused fields, the next person has no discriminator at all.
  const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8'));
  const line = src.split('\n').find((l) => l.includes('graph-replica: synced'));
  assert.ok(line, 'the sync log line must still exist');
  for (const field of ['stats.updated', 'stats.removed', 'stats.total', 'stats.hashed', 'stats.reused', 'rebuiltMs']) {
    assert.ok(line.includes(field), `the sync log must still report ${field}`);
  }
});

test('#1114 ⚠️ #884\'s CHUNKING IS KEPT — the guard is the fix, not un-yielding', async () => {
  // Un-chunking would hide the herd by making each run hog the thread outright:
  // the symptom moves, it does not go. #884's own note is that the property is
  // "other requests get a turn", not that the sync is fast.
  const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8'));
  assert.match(src, /syncGraphStoreChunked/, 'the chunked projection must still be the one called');
});
