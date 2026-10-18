/**
 * #1706 — /api/health's graph.boot names WHAT built the replica, not only when: an instrument for the #1645 slices, so live can show which open
 * slice still pulls the replica in. TEST AUTHOR's, written before any build.
 *
 * Each row is a FRESH REST under production's source flags on the whole-board fixture (the #1645 helper), hit with exactly ONE route, then
 * /api/health. The routes are the two the fixture rows have shown to build the replica (no-replica-routes-1645: checks and neighbors).
 *
 *   BT0  CONTROL: a route that does not build the replica (/api/ready) leaves graph.boot null, so no trigger is reported for a build that did
 *        not happen. Passes today.
 *   BT1  GET /api/checks?fresh=1 alone: graph.boot is set, and boot.trigger names that route (its path) and its method. RED today.
 *   BT2  GET /api/graph/neighbors alone: boot.trigger names neighbors, NOT checks (two routes, two answers, so a constant cannot pass). RED today.
 *   BT3  The FIRST build's trigger is kept: neighbors first, then a card write, then checks (which re-syncs: a precondition asserts the sync count
 *        rose); boot.trigger still names neighbors. RED today. The write is there because without one the later route does not sync at all, so a
 *        "last trigger wins" build survived the first cut of this row (a mutant showed it).
 *
 * The trigger's SHAPE is the builder's to choose (a string, or an object with route and method): the rows read it as JSON text and look for the
 * route's path and the method in it, and for the OTHER route's path NOT to be in it.
 *
 * NOT covered, by name: the caller seat ("where one is declared": no fixture request here declares one); a build started by something that is not a
 * request (a timer or boot itself), which no fixture here triggers; the per-sync triggers (the card asks for the first build at least); the live
 * reading (DONE WHEN 3, after deploy).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HAVE_PY } from './helpers/graph-executor-proc.mjs';
import { wholeBoardWorld } from './helpers/whole-board-1645.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const PROD = { SCRUM_GRAPH_UNIT_SMALLKINDS: '1', SCRUM_GRAPH_QUERY_SOURCE: 'executor', SCRUM_GRAPH_READY_SOURCE: 'executor', SCRUM_GRAPH_CHECKS_SOURCE: 'executor' };
const T = { skip: SKIP, timeout: 240000 };
const CHECKS = '/api/checks', NEIGHBORS = '/api/graph/neighbors';

async function world(body) {
  const w = await wholeBoardWorld({ env: PROD });
  try {
    const health = async () => (await (await fetch(`${w.rest.baseUrl}/api/health`, { signal: AbortSignal.timeout(5000) })).json()).graph;
    const hit = async (route) => {
      const r = await fetch(`${w.rest.baseUrl}${route}`, { signal: AbortSignal.timeout(60000) });
      const t = await r.text(); assert.equal(r.status, 200, `PRECONDITION: ${route} answered 200 (${t.slice(0, 160)})`);
    };
    // a build started by a route lands well inside this (the #1645 rows use the same wait)
    const settle = () => new Promise((res) => setTimeout(res, 1500));
    const h0 = await health();
    assert.ok(h0 && h0.boot == null && h0.syncs === 0, `PRECONDITION: nothing built the replica before the first route (graph ${JSON.stringify(h0)})`);
    const patchCard = async () => {
      const r = await fetch(`${w.rest.baseUrl}/api/cards/1`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'card 1 renamed', by: 'ada' }), signal: AbortSignal.timeout(60000) });
      assert.equal(r.status, 200, `PRECONDITION: the card write is accepted (${(await r.text()).slice(0, 160)})`);
    };
    await body({ health, hit, settle, patchCard });
  } finally { await w.stop(); }
}
const triggerText = (boot) => JSON.stringify(boot?.trigger ?? null);

test('#1706 (BT0 CONTROL) a route that does not build the replica leaves graph.boot null: no trigger for a build that did not happen', T, async () => {
  await world(async ({ health, hit, settle }) => {
    await hit('/api/ready'); await settle();
    const g = await health();
    assert.equal(g.boot ?? null, null, `no build, so no boot record and no trigger (graph.boot ${JSON.stringify(g.boot)})`);
  });
});

test('#1706 (BT1) GET /api/checks alone builds the replica, and boot.trigger names that route and its method', T, async () => {
  await world(async ({ health, hit, settle }) => {
    await hit(`${CHECKS}?fresh=1`); await settle();
    const g = await health();
    assert.ok(g.boot, `PRECONDITION: the checks route built the replica on this fixture (graph ${JSON.stringify(g)})`);
    const t = triggerText(g.boot);
    assert.ok(t.includes(CHECKS), `boot.trigger names the route that built it (${CHECKS}); got ${t}`);
    assert.ok(t.includes('GET'), `and its method; got ${t}`);
  });
});

test('#1706 (BT2) GET /api/graph/neighbors alone: boot.trigger names neighbors, not checks', T, async () => {
  await world(async ({ health, hit, settle }) => {
    await hit(`${NEIGHBORS}?node=1`); await settle();
    const g = await health();
    assert.ok(g.boot, `PRECONDITION: the neighbors route built the replica on this fixture (graph ${JSON.stringify(g)})`);
    const t = triggerText(g.boot);
    assert.ok(t.includes(NEIGHBORS), `boot.trigger names ${NEIGHBORS}; got ${t}`);
    assert.ok(!t.includes(CHECKS), `and not the other builder; got ${t}`);
  });
});

test('#1706 (BT3) the first build\'s trigger is kept: neighbors, then a write, then checks re-syncs, and the trigger still names neighbors', T, async () => {
  await world(async ({ health, hit, settle, patchCard }) => {
    await hit(`${NEIGHBORS}?node=1`); await settle();
    const first = await health();
    assert.ok(first.boot, `PRECONDITION: the first route built the replica (graph ${JSON.stringify(first)})`);
    // a later builder only re-syncs after a write (measured at 608dbba: checks alone leaves syncs at 1); without one, a "last trigger wins"
    // build could never show itself here
    await patchCard(); await hit(`${CHECKS}?fresh=1`); await settle();
    const g = await health();
    assert.ok(g.syncs > first.syncs, `PRECONDITION: the later route synced the replica again (syncs ${first.syncs} -> ${g.syncs})`);
    const t = triggerText(g.boot);
    assert.ok(t.includes(NEIGHBORS) && !t.includes(CHECKS), `boot.trigger still names the FIRST builder (neighbors), not the later one; got ${t}`);
  });
});
