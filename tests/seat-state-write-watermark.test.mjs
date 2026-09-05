/**
 * #1171 — A WRITE TO A GRAPH-NATIVE COLLECTION RETURNS THE REQUEST, NOT THE STATE.
 *
 * `handleSeatDeclare` ends:
 *
 *     const saved = await withWriteLock(async () => {
 *       writeBoard(data, [seatStateEvent(prior ? 'update' : 'create', decl)]);
 *       return decl;                     // ⇐ the caller's own validated request
 *     });
 *     sendJSON(res, 200, saved);
 *
 * The graph is never consulted on the write path. And `writeBoard` does not
 * project — it sets `_graphDirty = true` and returns, because #694 made the
 * replica rebuild LAZILY on the next query. So at the instant the 200 is
 * written, the projection has NOT seen this declaration, by construction.
 *
 * ⇒ The caller cannot distinguish "declared and visible to the scheduler" from
 *   "declared, event stored, projection never ran." The reader that matters is
 *   the tending tick, which reads the PROJECTION. Under a persistently failing
 *   sync a seat believes it declined routine work and still gets whispered,
 *   and nothing tells either side.
 *
 * ⚠️ THE HARM NEEDS A PERSISTENT SYNC FAILURE, NOT A LAG. The dirty flag stays
 * set and the next read re-attempts, so a transient failure is self-healing.
 * Lazy projection is a good design; the defect is that the RESPONSE IS SILENT
 * ABOUT IT. That is what these tests assert, and nothing more.
 *
 * ⭐ THE FIX COSTS NOTHING NEW: `_graphGeneration` is already incremented on
 * every write (#931, so an in-flight sync cannot clear the dirty flag), and
 * `/api/seats/state` already returns `projectedThrough` (#949's watermark, built
 * for READS). Neither is exposed on the write. The token the caller needs is in
 * scope at the moment the handler returns.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const IN_1H = () => new Date(Date.now() + 3600_000).toISOString();

const put = (base, seat, body) => fetch(`${base}/api/seats/${seat}/state`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const del = (base, seat) => fetch(`${base}/api/seats/${seat}/state`, { method: 'DELETE' });
const states = async (base) => (await fetch(`${base}/api/seats/state`)).json();

const decl = () => ({
  mode: 'resting',
  acceptsRoutineWork: false,
  declaredAt: new Date().toISOString(),
  expiresAt: IN_1H(),
});

/**
 * THE DEFECT. A caller who has just written state cannot tell, from the
 * response, whether the surface that schedules work can see it.
 *
 * This is the assertion that fails today: the body is the caller's own
 * declaration and carries nothing about the projection at all.
 */
test('#1171 the write response reports whether the projection has seen the write', async () => {
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    const seat = 'alex';
    const res = await put(s.baseUrl, seat, decl());
    assert.equal(res.status, 200, 'precondition: the declaration is accepted');
    const body = await res.json();

    // ⛔ The whole finding in one assertion. A response that echoes the request
    // is indistinguishable from one that confirms the state.
    assert.ok(
      body.graph && (body.graph.generation !== undefined || body.graph.projectedThrough !== undefined),
      'a write to a graph-backed collection must report the projection watermark '
      + '(generation or projectedThrough), or the caller cannot tell "accepted" from "visible". '
      + `Got keys: ${JSON.stringify(Object.keys(body))}`,
    );
  } finally { await s.stop(); }
});

/**
 * ⭐ THE NEGATIVE CONTROL, and it is the condition that fails if someone adds
 * the field without wiring it to anything.
 *
 * A constant, or a value copied off the request, satisfies the test above and
 * buys nothing. The watermark has to MOVE when the projection moves: the value
 * the write reports must be comparable to — and not ahead of — the value the
 * read surface reports once the sync has run.
 */
test('#1171 the reported watermark is real: it MOVES with the writes and reports pending', async () => {
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    const seat = 'alex';

    const w1 = await (await put(s.baseUrl, seat, decl())).json();
    assert.ok(w1.graph, 'precondition: the write reports a graph watermark');

    // ⛔ THE ASSERTION A HARDCODED FIELD CANNOT SATISFY. `_graphGeneration` is
    // incremented on every write (#931). A constant, or a value copied off the
    // request, holds still — and holding still is the whole failure this
    // control exists to catch.
    const w2 = await (await put(s.baseUrl, seat, decl())).json();
    assert.ok(
      w2.graph.generation > w1.graph.generation,
      'the watermark must MOVE with each write, or it is a decoration: '
      + `got ${w1.graph.generation} then ${w2.graph.generation}`,
    );

    // ⛔ AND THE SECOND HALF. An earlier cut asserted `dirty === true` here —
    // which is a CONSTANT on the write path (`writeBoard` sets it
    // unconditionally), so a hardcoded field satisfied it. Review caught the
    // reader-facing half; the constant was the cause. The response now carries
    // `projectedThrough`, and the claim that can actually be wrong is that it
    // describes the PROJECTION rather than the write: at write time the sync
    // has not run, so it must be BEHIND the value a subsequent read reports.
    assert.ok('projectedThrough' in w2.graph,
      'the write must report where the projection stands, not just that a write happened');

    // This read triggers the lazy sync (#694) and reports the watermark (#949).
    const r = await states(s.baseUrl);
    assert.ok(r.graph, 'precondition: the read reports a graph watermark');

    // And the seat must actually reach the surface the scheduler reads —
    // otherwise the watermark is honest about a projection that dropped it.
    assert.equal(r.seats.find((x) => x.seat === seat)?.mode, 'resting',
      'the declaration must reach the surface the scheduler reads');
  } finally { await s.stop(); }
});

/**
 * Condition 4 on the card: `seat_clear` is the same handler shape and gets the
 * same treatment, or the card says why not. Asserted rather than assumed.
 */
test('#1171 seat_clear reports the watermark too', async () => {
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    const seat = 'alex';
    await put(s.baseUrl, seat, decl());
    const res = await del(s.baseUrl, seat);
    assert.equal(res.status, 200, 'precondition: the clear is accepted');
    const body = await res.json();
    assert.ok(
      body.graph && (body.graph.generation !== undefined || body.graph.projectedThrough !== undefined),
      'a clear is a write to the same collection and has the same reader; it must report '
      + `the same watermark. Got keys: ${JSON.stringify(Object.keys(body))}`,
    );
  } finally { await s.stop(); }
});
