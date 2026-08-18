/**
 * #885 — AN UNBOUNDED PROPERTY PATH TAKES THE GRAPH ENDPOINT DOWN, and it cannot
 * be timed out.
 *
 * ⚰️ MEASURED BY DOING IT, 2026-08-18. Trying to answer "what is reachable from
 * the apex by ANY predicate" without enumerating edge types:
 *
 *     SELECT ... WHERE { ?a schema:identifier "857" .
 *                        ?c a schema:CreativeWork . ?c !<urn:none>* ?a }
 *
 *     ⇒ /api/graph stopped answering. REST stayed up (200 in 0.65s); the graph
 *       endpoint timed out at 20s and stayed down until the server was
 *       restarted. Cold sync after the restart cost another 14s.
 *
 * ⇒ ⛔ ONE SEAT'S CURIOSITY TOOK A SHARED SURFACE OFF THE AIR. The same class as
 * the `fields=all&limit=500` loop that wedged the board an hour earlier, on the
 * other surface — and this one is worse, because the query looked reasonable and
 * is the FIRST thing you write when you want "connected to, by anything".
 *
 * ── WHY THIS IS A PRE-FLIGHT REFUSAL AND NOT A TIMEOUT ────────────────────
 *
 * `store.query()` is SYNCHRONOUS. A runaway query blocks Node's event loop, so a
 * timer cannot fire and nothing can cancel it. There is no timeout to add — the
 * only place to stand is BEFORE the query runs.
 *
 * ⚠️ Which makes the guard's precision load-bearing: it must refuse the
 * unbounded shape and allow everything else, because a false positive here
 * refuses a legal query for a hazard it does not have.
 *
 *     !<x>                 depth-1 over any predicate    ✅ fast, 95 rows, ALLOWED
 *     (a|b)*               enumerated, transitive        ✅ fast, 692 rows, ALLOWED
 *     !<x>*  /  !<x>+      unbounded over any predicate  ⛔ REFUSED
 *
 * ⭐ And the refusal has to TEACH, because the enumerated form is genuinely the
 * right answer and it is not obvious: 692 cards in 25ms versus an endpoint that
 * never comes back.
 *
 * ⛔ WHAT THIS DOES NOT CLAIM: that every expensive query is caught. It catches
 * one shape, measured, that reliably kills the endpoint. A cost estimator is a
 * different and much larger piece of work.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer } from './helpers/harness.mjs';

const ask = async (baseUrl, query) => {
  const r = await fetch(`${baseUrl}/api/graph`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }),
  });
  return { status: r.status, body: await r.json() };
};

test('#885 an unbounded path over a negated property set is REFUSED before it runs', async () => {
  const s = await startRestServer();
  try {
    for (const q of [
      'SELECT ?c WHERE { ?a schema:identifier "1" . ?a !<urn:none>* ?c }',
      'SELECT ?c WHERE { ?a schema:identifier "1" . ?a !<urn:none>+ ?c }',
      'SELECT ?c WHERE { ?a schema:identifier "1" . ?a !(<urn:a>|<urn:b>)* ?c }',
    ]) {
      const r = await ask(s.baseUrl, q);
      assert.equal(r.status, 400, `must refuse: ${q}\ngot ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
      assert.match(
        r.body.error, /unbounded/i,
        'the refusal must name WHAT is wrong, not just that something is',
      );
    }
  } finally { await s.stop(); }
});

test('#885 the refusal TEACHES the query that works', async () => {
  const s = await startRestServer();
  try {
    const r = await ask(s.baseUrl, 'SELECT ?c WHERE { ?a schema:identifier "1" . ?a !<urn:none>* ?c }');
    // Measured: the enumerated form answers the same question over the live
    // corpus in 25ms. A refusal that does not point at it leaves the caller with
    // a working question and no working way to ask it — which is how a guard
    // teaches people to route around the surface it protects.
    assert.match(
      r.body.hint || r.body.error, /enumerat|name the predicates|\|/i,
      `the refusal must show the alternative. got ${JSON.stringify(r.body).slice(0, 220)}`,
    );
    // ⭐⭐ AND IT MUST NAME ANCHORING, WHICH IS THE HALF THAT ACTUALLY MATTERS.
    // The first version of this hint said only "enumerate the predicates".
    // Measured against an isolated copy of the live corpus (17,484 entities),
    // the SAME 7-predicate path:
    //     unbound at both ends   9.97s   ← still blocks the shared event loop
    //     anchored at one end    0.015s  ← 660×
    // A hint that teaches the cheap half of the fix sends the caller back with a
    // query that no longer hangs and still costs the room ten seconds.
    assert.match(
      r.body.hint, /anchor/i,
      `the refusal must tell the caller to ANCHOR the path — enumerating alone leaves a `
      + `10s query. got ${JSON.stringify(r.body.hint)}`,
    );
  } finally { await s.stop(); }
});

test('#885 ⭐ CONTROL — the shapes that are FINE are not refused', async () => {
  const s = await startRestServer();
  try {
    // A false positive here is worse than the bug: it refuses a legal query for
    // a hazard it does not have, and the caller cannot tell the difference.
    const fine = [
      // depth-1 over any predicate: bounded by construction, fast, genuinely useful
      'SELECT ?c WHERE { ?a schema:identifier "1" . ?a !<urn:none> ?c }',
      // enumerated transitive: this is the RECOMMENDED form the refusal points at
      'SELECT ?c WHERE { ?a schema:identifier "1" . ?a (scrum:relatedTo|scrum:mentionsCard)* ?c }',
      // a plain star on ONE named predicate
      'SELECT ?c WHERE { ?a schema:identifier "1" . ?a scrum:relatedTo* ?c }',
      // an ordinary query with no path at all
      'SELECT ?c WHERE { ?c a schema:CreativeWork }',
      // ⚠️ a `!` inside a FILTER is not a property path and must not be caught
      'SELECT ?c WHERE { ?c a schema:CreativeWork FILTER(!BOUND(?x)) }',
    ];
    for (const q of fine) {
      const r = await ask(s.baseUrl, q);
      assert.notEqual(r.status, 400, `must NOT refuse a bounded query: ${q}\n${JSON.stringify(r.body).slice(0, 160)}`);
    }
  } finally { await s.stop(); }
});

test('#885 the guard runs BEFORE the query, so a refusal costs nothing', async () => {
  const s = await startRestServer();
  try {
    const t = Date.now();
    const r = await ask(s.baseUrl, 'SELECT ?c WHERE { ?a schema:identifier "1" . ?a !<urn:none>* ?c }');
    const ms = Date.now() - t;
    assert.equal(r.status, 400);
    // The whole point: the dangerous query must never reach store.query(), which
    // is synchronous and cannot be interrupted once entered. On a fixture this
    // is fast either way, so this pins the ORDER rather than the duration —
    // a refusal carrying query timings would prove the guard ran too late.
    assert.equal(r.body.ms, undefined, 'a refused query must not report an execution time — it must not have executed');
    assert.ok(ms < 5000, `refusal should be immediate, took ${ms}ms`);
  } finally { await s.stop(); }
});
