/**
 * #1645 / #1697 — THE FALLBACK GOAL LINE, MEASURED: "every board READ in prod answers from the graph store, and the replica serves no live
 * request" (the PO's line, 43295, with the check the room settled on, 43296 to 43301). TEST AUTHOR's.
 *
 * For each route that used to reach the in-process replica (the PO's slice-2 inventory, 43283): a FRESH REST with production's source flags and
 * units, the route CALLED, then /api/health: graph.boot must still be null and graph.syncs 0. One row per route, so the result is a LIST of which
 * routes still build the replica, not one yes or no. It needs #1645 slice 1 underneath (before it, /api/health itself kicks the build).
 *
 * A ROUTE THAT DOES NOT ANSWER CANNOT PASS (the code reviewer's P1 and P2 at 5a22fd2, 43401): every row requires a 200 AND content that matches
 * the fixture (`serves` below). A 404, an empty list, or a degraded answer ("census: unavailable", null counts) is red, because "built no
 * replica" proves nothing about a route that never did the work. The first cut asserted only status < 500 and, for the census, nothing.
 *
 * MEASURED at 5a22fd2 (2026-10-18T00:40Z): green for graph_query, ready, vocabulary and both predicate-shapes lookups, and for memories,
 * decisions and seat state with log-born data. TODO (reported, never failing CI; the slice that fixes the route deletes its line in TODO):
 *   graph_neighbors prod does not set NEIGHBORS_SOURCE: 2c
 * A todo that starts passing does not fail either: delete its line, and the row must then pass as a plain test. The census rows' two lines were
 * deleted for 2b (2026-10-18), when the census began counting on the executor; the checks line for 2d (2026-10-18), when the graph-store meter
 * stopped measuring on the executor pass. Those rows are plain tests now.
 *
 * NR-M (2d, the already-WARM branch the fresh-REST rows cannot reach; asked for in review, 43467): something else builds the copy first
 * (neighbors, still a builder until 2c), then /api/checks?fresh=1. The meter's standing entry must still say `disabled` with a reason naming #1645,
 * carry neither an error nor rows, and the checks call must cause no further build or sync (syncs unchanged across it).
 *
 * NOT covered, by name: deliveries and model calls (unit3) and the small-kind collections, which no fixture here holds; boot itself (a replica
 * built at boot by something other than these routes is caught by the precondition, which reads graph.boot before any route is called); write
 * routes (the predicate-list row writes one definition BEFORE the precondition, so a build caused by that write is caught there, not credited).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HAVE_PY } from './helpers/graph-executor-proc.mjs';
import { wholeBoardWorld } from './helpers/whole-board-1645.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
// production's REST flag NAMES (from the PO's read of the prod plist, 43283), the logborn and deliveries units left out (see NOT covered)
const PROD = { SCRUM_GRAPH_UNIT_SMALLKINDS: '1', SCRUM_GRAPH_QUERY_SOURCE: 'executor', SCRUM_GRAPH_READY_SOURCE: 'executor', SCRUM_GRAPH_CHECKS_SOURCE: 'executor' };
const send = (w, method, route, body) => fetch(`${w.rest.baseUrl}${route}`, { method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) });
const kind = (j, name) => j?.kinds?.kinds?.find((k) => k.name === name);
// the census must COUNT: available, and the fixture's own instance counts (3 cards; with log-born data, also 1 memory)
const censusCounts = (want) => (j) => j?.kinds?.census !== 'unavailable' && Object.entries(want).every(([n, c]) => kind(j, n)?.instances === c);
const FIXTURE_PREDICATE = { name: 'scrum:relatedTo', definition: 'the fixture predicate: two cards bear on each other', by: 'ada' };

// [label, method, route, body, serves(json, w), setup(w)?]
const ROUTES = [
  ['graph_query', 'POST', '/api/graph', { query: 'SELECT ?s WHERE { ?s ?p ?o } LIMIT 5' }, (j) => j.source === 'executor' && j.rows?.length === 5],
  ['ready', 'GET', '/api/ready', null, (j) => j.source === 'executor' && j.readyTotal === 1 && j.ready[0]?.shortId === 1],
  ['checks', 'GET', '/api/checks?fresh=1', null, (j) => j.source === 'executor' && typeof j.executorPosition === 'string'],
  ['vocabulary', 'GET', '/api/graph/vocabulary', null, (j) => j.ok === true && j.emitted > 0],
  ['predicate shapes (named)', 'GET', '/api/predicates?name=schema%3Aname&shapes=1', null, (j) => j[0]?.name === 'schema:name' && j[0]?.objectShape?.observed > 0],
  ['predicate shapes (list)', 'GET', '/api/predicates?shapes=1', null, (j) => j.some((p) => p.name === FIXTURE_PREDICATE.name && p.objectShape?.observed > 0),
    async (w) => { const r = await send(w, 'POST', '/api/predicates', FIXTURE_PREDICATE); assert.equal(r.status, 201, `PRECONDITION: the fixture predicate registers (${await r.text()})`); }],
  ['board status census', 'GET', '/api/board/status', null, censusCounts({ 'scrum:Card': 3 })],
  ['graph_neighbors', 'GET', '/api/graph/neighbors?node=1', null, (j) => j.exists === true && j.node?.id === 'entity:uuid-1'],
];
// the known reds, as node:test TODO (reported on every run, never failing CI); the slice that fixes the route deletes its line here
const TODO = {
  graph_neighbors: '2c: prod does not set NEIGHBORS_SOURCE',
};

async function measure(w, label, method, route, body, serves, setup) {
  const h = async () => (await (await fetch(`${w.rest.baseUrl}/api/health`, { signal: AbortSignal.timeout(5000) })).json()).graph;
  if (setup) await setup(w);
  const h0 = await h();
  assert.ok(h0 && h0.boot == null && h0.syncs === 0, `PRECONDITION: nothing built the replica before the route was called (graph ${JSON.stringify(h0)})`);
  const r = await send(w, method, route, body);
  const t = await r.text();
  assert.equal(r.status, 200, `${label}: the route answered 200 (${t.slice(0, 200)})`);
  let j; try { j = JSON.parse(t); } catch { assert.fail(`${label}: the answer is JSON (${t.slice(0, 200)})`); }
  assert.ok(serves(j, w), `${label}: and it serves the fixture's own content (${t.slice(0, 300)})`);
  await new Promise((res) => setTimeout(res, 1500));   // a lazily started build would land by now
  const h1 = await h();
  assert.equal(h1.boot ?? null, null, `${label}: the route built the replica (graph.boot ${JSON.stringify(h1.boot)})`);
  assert.equal(h1.syncs, 0, `${label}: and synced it (graph.syncs ${h1.syncs})`);
}

for (const [label, method, route, body, serves, setup] of ROUTES) {
  test(`#1645 (NR, ${label}) a fresh REST answers ${method} ${route.split('?')[0]} and builds no replica`, { skip: SKIP, todo: TODO[label] ?? false, timeout: 240000 }, async () => {
    const w = await wholeBoardWorld({ env: PROD });
    try { await measure(w, label, method, route, body, serves, setup); } finally { await w.stop(); }
  });
}

// ---- 2b: the same check with LOG-BORN data present (memories, decisions, seat state), the kinds the first rows could not cover (43373) ----
// The logborn unit ON, as prod runs it. Each row also asserts the route SERVES the fixture's own record, so a [] cannot pass by dropping data.
const LOGBORN_ROUTES = [
  ['memories', '/api/memories', (j, w) => JSON.stringify(j).includes(w.records.memoryId)],
  ['decisions', '/api/decisions', (j, w) => JSON.stringify(j).includes(w.records.decisionId)],
  ['seat state', '/api/seats/state', (j) => JSON.stringify(j).includes('the #1645 2b fixture')],
  ['board status census, log-born data present', '/api/board/status', censusCounts({ 'scrum:Card': 3, 'scrum:Memory': 1 })],
];
for (const [label, route, serves] of LOGBORN_ROUTES) {
  test(`#1645 (NR-LB, ${label}) with log-born data, a fresh REST answers GET ${route} from the executor and builds no replica`, { skip: SKIP, todo: TODO[label] ?? false, timeout: 300000 }, async () => {
    const w = await wholeBoardWorld({ logborn: true, env: PROD });
    try { await measure(w, label, 'GET', route, null, serves); } finally { await w.stop(); }
  });
}

// ---- 2d: the meter on an ALREADY-WARM copy (the branch a fresh REST cannot reach) ----
test('#1645 (NR-M, meter on a warm copy) with the copy already built by another route, /api/checks still reports the meter disabled and causes no further sync', { skip: SKIP, timeout: 240000 }, async () => {
  const w = await wholeBoardWorld({ env: PROD });
  try {
    const h = async () => (await (await fetch(`${w.rest.baseUrl}/api/health`, { signal: AbortSignal.timeout(5000) })).json()).graph;
    const warm = await send(w, 'GET', '/api/graph/neighbors?node=1'); const wt = await warm.text(); assert.equal(warm.status, 200, `PRECONDITION: the warming route answered (${wt.slice(0, 200)})`);
    await new Promise((res) => setTimeout(res, 1500));
    const h0 = await h();
    assert.ok(h0.boot, `PRECONDITION: the copy is warm before /api/checks is called (graph ${JSON.stringify(h0)}); without it this row tests the fresh branch again`);
    const r = await send(w, 'GET', '/api/checks?fresh=1'); const t = await r.text();
    assert.equal(r.status, 200, `checks answered 200 (${t.slice(0, 200)})`);
    const meter = (JSON.parse(t).standing ?? []).find((s) => s.id === 'graph-store-meter');
    assert.ok(meter && meter.disabled === true && typeof meter.reason === 'string' && /#1645/.test(meter.reason) && !meter.error && !('rows' in meter),
      `the meter on the executor pass is disabled with a reason naming #1645, no error and no rows, even with a warm copy to measure (${JSON.stringify(meter)})`);
    await new Promise((res) => setTimeout(res, 1500));
    const h1 = await h();
    assert.equal(h1.syncs, h0.syncs, `and the checks call caused no further sync of the copy (syncs ${h0.syncs} -> ${h1.syncs})`);
  } finally { await w.stop(); }
});
