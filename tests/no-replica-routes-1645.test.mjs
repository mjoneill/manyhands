/**
 * #1645 / #1697 — THE FALLBACK GOAL LINE, MEASURED: "every board READ in prod answers from the graph store, and the replica serves no live
 * request" (the PO's line, 43295, with the check the room settled on, 43296 to 43301). TEST AUTHOR's.
 *
 * For each route that used to reach the in-process replica (the PO's slice-2 inventory, 43283): a FRESH REST with production's source flags and
 * units, the route CALLED (so a zero means it was asked and did not build, never that nobody asked), then /api/health: graph.boot must still be
 * null and graph.syncs 0. One row per route, so the result is a LIST of which routes still build the replica, not one yes or no.
 * It needs #1645 slice 1 underneath (before it, /api/health itself kicks the build).
 *
 * MEASURED at bca80e3 (2026-10-18T00:27Z, the top of the slice-1 + 2a stack): green for graph_query, ready, vocabulary, both predicate-shapes
 * lookups and the board-status census (with and without log-born data); RED for /api/checks (the graph-store meter, measuresReplica: the only
 * builder on that route, shown by flipping that one flag: slice 2d) and for graph_neighbors (prod does not set NEIGHBORS_SOURCE: the 2c flip).
 * A red row here is information for the Review, not a defect in a landed slice.
 *
 * NR-LB rows (2b): the same check with LOG-BORN data present, through the whole-board helper's { logborn: true } (a memory, a decision and a
 * seat state written with the unit off, migrate-logborn-1561, then the unit on), each also asserting the route serves the fixture's record.
 *
 * NOT covered, by name: deliveries and model calls (unit3) and the small-kind collections, which no fixture here holds; boot itself (a replica built at boot by something other than these routes is caught by the
 * precondition, which reads graph.boot before any route is called); write routes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HAVE_PY } from './helpers/graph-executor-proc.mjs';
import { wholeBoardWorld } from './helpers/whole-board-1645.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
// production's REST flag NAMES (from the PO's read of the prod plist, 43283), the logborn and deliveries units left out (see NOT covered)
const PROD = { SCRUM_GRAPH_UNIT_SMALLKINDS: '1', SCRUM_GRAPH_QUERY_SOURCE: 'executor', SCRUM_GRAPH_READY_SOURCE: 'executor', SCRUM_GRAPH_CHECKS_SOURCE: 'executor' };
const ROUTES = [
  ['graph_query', 'POST', '/api/graph', { query: 'SELECT ?s WHERE { ?s ?p ?o } LIMIT 5' }],
  ['ready', 'GET', '/api/ready'],
  ['checks', 'GET', '/api/checks?fresh=1'],
  ['vocabulary', 'GET', '/api/graph/vocabulary'],
  ['predicate shapes (named)', 'GET', '/api/predicates?name=schema%3Aname&shapes=1'],
  ['predicate shapes (list)', 'GET', '/api/predicates?shapes=1'],
  ['board status census', 'GET', '/api/board/status'],
  ['graph_neighbors', 'GET', '/api/graph/neighbors?node=1'],
];
// the known reds, as node:test TODO (reported on every run, never failing CI); the slice that fixes the route deletes its line here
const TODO = {
  checks: '2d: the graph-store meter (measuresReplica) builds the replica',
  graph_neighbors: '2c: prod does not set NEIGHBORS_SOURCE',
};

for (const [label, method, route, body] of ROUTES) {
  test(`#1645 (NR, ${label}) a fresh REST answers ${method} ${route.split('?')[0]} and builds no replica`, { skip: SKIP, todo: TODO[label] ?? false, timeout: 240000 }, async () => {
    const w = await wholeBoardWorld({ env: PROD });
    try {
      const h = async () => (await (await fetch(`${w.rest.baseUrl}/api/health`, { signal: AbortSignal.timeout(5000) })).json()).graph;
      const h0 = await h();
      assert.ok(h0 && h0.boot == null && h0.syncs === 0, `PRECONDITION: nothing built the replica before the route was called (graph ${JSON.stringify(h0)})`);
      const r = await fetch(`${w.rest.baseUrl}${route}`, { method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) });
      assert.ok(r.status < 500, `PRECONDITION: the route answered (${r.status} ${(await r.text()).slice(0, 200)})`);
      await new Promise((res) => setTimeout(res, 1500));   // a lazily started build would land by now
      const h1 = await h();
      assert.equal(h1.boot ?? null, null, `${label}: the route built the replica (graph.boot ${JSON.stringify(h1.boot)})`);
      assert.equal(h1.syncs, 0, `${label}: and synced it (graph.syncs ${h1.syncs})`);
    } finally { await w.stop(); }
  });
}

// ---- 2b: the same check with LOG-BORN data present (memories, decisions, seat state), the kinds the first rows could not cover (43373) ----
// The logborn unit ON, as prod runs it. Each row also asserts the route SERVES the fixture's own record, so a [] cannot pass by dropping data.
const LOGBORN_ROUTES = [
  ['memories', '/api/memories', (w, t) => t.includes(w.records.memoryId)],
  ['decisions', '/api/decisions', (w, t) => t.includes(w.records.decisionId)],
  ['seat state', '/api/seats/state', (w, t) => t.includes('the #1645 2b fixture')],
  ['board status census, log-born data present', '/api/board/status', () => true],
];
for (const [label, route, serves] of LOGBORN_ROUTES) {
  test(`#1645 (NR-LB, ${label}) with log-born data, a fresh REST answers GET ${route} from the executor and builds no replica`, { skip: SKIP, timeout: 300000 }, async () => {
    const w = await wholeBoardWorld({ logborn: true, env: PROD });
    try {
      const h = async () => (await (await fetch(`${w.rest.baseUrl}/api/health`, { signal: AbortSignal.timeout(5000) })).json()).graph;
      const h0 = await h();
      assert.ok(h0 && h0.boot == null && h0.syncs === 0, `PRECONDITION: nothing built the replica before the route was called (graph ${JSON.stringify(h0)})`);
      const r = await fetch(`${w.rest.baseUrl}${route}`, { signal: AbortSignal.timeout(60000) });
      const t = await r.text();
      assert.equal(r.status, 200, `${label}: 200 (${t.slice(0, 200)})`);
      assert.ok(serves(w, t), `${label}: and it serves the fixture's own record (${t.slice(0, 200)})`);
      await new Promise((res) => setTimeout(res, 1500));
      const h1 = await h();
      assert.equal(h1.boot ?? null, null, `${label}: the route built the replica (graph.boot ${JSON.stringify(h1.boot)})`);
      assert.equal(h1.syncs, 0, `${label}: and synced it (graph.syncs ${h1.syncs})`);
    } finally { await w.stop(); }
  });
}
