/**
 * #1706 — /api/health's graph.boot names WHAT built the replica, not only when: an instrument for the #1645 slices, so live can show which open
 * slice still pulls the replica in. TEST AUTHOR's, written before any build.
 *
 * Each row is a FRESH REST on the whole-board fixture (the #1645 helper), hit with exactly the routes it names, then /api/health.
 *
 * THE BUILDERS ARE CHOSEN TO OUTLIVE THE SLICES. The first cut used /api/checks and neighbors, the routes the fixture rows had shown to build the
 * replica; 2d then stopped checks building it, and the rows lost their builder (measured at the 2d head, 2026-10-18T03:23Z). These rows use two
 * requests that ASK for the replica, so they build it until the replica itself is deleted, whatever 2b/2c/2d do:
 *   POST /api/graph with `source: "replica"`   (#1658: a request may ask for a store; the answer names it)
 *   GET /api/ready on a REST whose SCRUM_GRAPH_READY_SOURCE is unset (the replica answers; READY_SOURCE is 'replica' unless set to 'executor')
 * Two different paths AND two different methods, so a constant trigger, or one without its method, cannot pass.
 *
 *   BT0  CONTROL: under production's flags, a route that does not build the replica (/api/ready on the executor) leaves graph.boot null, so no
 *        trigger is reported for a build that did not happen. Passes today.
 *   BT1  POST /api/graph source:replica alone: graph.boot is set, and boot.trigger names /api/graph and POST. RED today.
 *   BT2  GET /api/ready alone (READY_SOURCE unset): boot.trigger names /api/ready and GET, and not /api/graph. RED today.
 *   BT3  The FIRST build's trigger is kept: /api/ready first, then a card write, then POST /api/graph source:replica, which re-syncs (a precondition
 *        asserts the sync count rose; without the write a later read does not sync at all, measured at 608dbba); boot.trigger still names
 *        /api/ready. RED today.
 *
 * The trigger's SHAPE is the builder's to choose (a string, or an object with route and method): the rows read it as JSON text and look for the
 * route's path and the method in it, and for the OTHER route's path NOT to be in it.
 *
 * NOT covered, by name: the caller seat ("where one is declared": no fixture request here declares one); a build started by something that is not a
 * request (a timer or boot itself), which no fixture here triggers; the per-sync triggers (the card asks for the first build at least); the live
 * reading (DONE WHEN 3, after deploy); which PRODUCTION routes still build it (that is what the instrument is for, not what these rows assert).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HAVE_PY } from './helpers/graph-executor-proc.mjs';
import { wholeBoardWorld } from './helpers/whole-board-1645.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const PROD = { SCRUM_GRAPH_UNIT_SMALLKINDS: '1', SCRUM_GRAPH_QUERY_SOURCE: 'executor', SCRUM_GRAPH_READY_SOURCE: 'executor', SCRUM_GRAPH_CHECKS_SOURCE: 'executor' };
// the same, with READY_SOURCE left unset so /api/ready answers from (and builds) the replica
const READY_ON_REPLICA = Object.fromEntries(Object.entries(PROD).filter(([k]) => k !== 'SCRUM_GRAPH_READY_SOURCE'));
const T = { skip: SKIP, timeout: 240000 };
const GRAPH = '/api/graph', READY = '/api/ready';

async function world(env, body) {
  const w = await wholeBoardWorld({ env });
  try {
    const health = async () => (await (await fetch(`${w.rest.baseUrl}/api/health`, { signal: AbortSignal.timeout(5000) })).json()).graph;
    const call = async (method, route, payload) => {
      const r = await fetch(`${w.rest.baseUrl}${route}`, { method, ...(payload ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(60000) });
      const t = await r.text(); assert.equal(r.status, 200, `PRECONDITION: ${method} ${route} answered 200 (${t.slice(0, 160)})`); return JSON.parse(t);
    };
    const replicaQuery = async () => {
      const j = await call('POST', GRAPH, { query: 'SELECT ?s WHERE { ?s ?p ?o } LIMIT 1', source: 'replica' });
      assert.equal(j.source, 'replica', `PRECONDITION: the replica answered the replica query (source ${j.source})`);
    };
    const ready = async () => call('GET', READY);
    const patchCard = async () => call('PATCH', '/api/cards/1', { title: 'card 1 renamed', by: 'ada' });
    const settle = () => new Promise((res) => setTimeout(res, 1500));   // a build started by a route lands well inside this (the #1645 rows use the same wait)
    const h0 = await health();
    assert.ok(h0 && h0.boot == null && h0.syncs === 0, `PRECONDITION: nothing built the replica before the first route (graph ${JSON.stringify(h0)})`);
    await body({ health, replicaQuery, ready, patchCard, settle });
  } finally { await w.stop(); }
}
const triggerText = (boot) => JSON.stringify(boot?.trigger ?? null);

test('#1706 (BT0 CONTROL) under prod flags a route that does not build the replica leaves graph.boot null: no trigger for a build that did not happen', T, async () => {
  await world(PROD, async ({ health, ready, settle }) => {
    const j = await ready(); assert.equal(j.source, 'executor', 'PRECONDITION: /api/ready answered from the executor under prod flags');
    await settle();
    const g = await health();
    assert.equal(g.boot ?? null, null, `no build, so no boot record and no trigger (graph.boot ${JSON.stringify(g.boot)})`);
  });
});

test('#1706 (BT1) POST /api/graph source:replica alone builds the replica, and boot.trigger names /api/graph and POST', T, async () => {
  await world(PROD, async ({ health, replicaQuery, settle }) => {
    await replicaQuery(); await settle();
    const g = await health();
    assert.ok(g.boot, `PRECONDITION: the replica query built the replica (graph ${JSON.stringify(g)})`);
    const t = triggerText(g.boot);
    assert.ok(t.includes(GRAPH), `boot.trigger names the route that built it (${GRAPH}); got ${t}`);
    assert.ok(t.includes('POST'), `and its method (POST); got ${t}`);
  });
});

test('#1706 (BT2) GET /api/ready on the replica alone: boot.trigger names /api/ready and GET, not /api/graph', T, async () => {
  await world(READY_ON_REPLICA, async ({ health, ready, settle }) => {
    const j = await ready(); assert.equal(j.source, 'replica', 'PRECONDITION: /api/ready answered from the replica (READY_SOURCE unset)');
    await settle();
    const g = await health();
    assert.ok(g.boot, `PRECONDITION: /api/ready built the replica (graph ${JSON.stringify(g)})`);
    const t = triggerText(g.boot);
    assert.ok(t.includes(READY) && t.includes('GET'), `boot.trigger names ${READY} and GET; got ${t}`);
    assert.ok(!t.includes(GRAPH), `and not the other builder; got ${t}`);
  });
});

test('#1706 (BT3) the first build\'s trigger is kept: /api/ready, then a write, then a replica query that re-syncs, and the trigger still names /api/ready', T, async () => {
  await world(READY_ON_REPLICA, async ({ health, ready, replicaQuery, patchCard, settle }) => {
    await ready(); await settle();
    const first = await health();
    assert.ok(first.boot, `PRECONDITION: the first route built the replica (graph ${JSON.stringify(first)})`);
    await patchCard(); await replicaQuery(); await settle();
    const g = await health();
    assert.ok(g.syncs > first.syncs, `PRECONDITION: the later route synced the replica again (syncs ${first.syncs} -> ${g.syncs})`);
    const t = triggerText(g.boot);
    assert.ok(t.includes(READY) && !t.includes(GRAPH), `boot.trigger still names the FIRST builder (${READY}), not the later one; got ${t}`);
  });
});
