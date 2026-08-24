/**
 * #885 — the MCP adapter discards `code` and `hint` from REST errors.
 *
 * #885 shipped a pre-flight guard that refuses a query capable of taking
 * /api/graph off the air. The guard's whole design is that it TEACHES the
 * query that works — its own source says so:
 *
 *   "A guard that refuses without teaching is a guard people learn to
 *    route around."
 *
 * REST honours that: the refusal carries { error, code, hint }, and the hint
 * names the non-obvious half (an anchored path whose FAR end is a free
 * variable still walks every node in the graph).
 *
 * ⇒ Through MCP a seat got the refusal without the teaching. apiCall rendered
 * only `detail.error`, so `code` and `hint` were parsed and dropped one line
 * later. That is #823's class — a structured field the server takes care to
 * send, discarded in transit.
 *
 * These tests drive the REAL tool through a REAL session, because the claim
 * is about what a seat RECEIVES, not about what the server sends.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, startMcpServer, mcpSession, makeBoardFixture } from './helpers/harness.mjs';

// The shape the #885 guard refuses: a transitive quantifier over a negated
// property set. Depth-1 `!<x>` and enumerated `(a|b)*` are both legal and fast;
// only this form is refused outright.
const UNBOUNDED = 'SELECT * WHERE { ?a !<urn:none>* ?b } LIMIT 1';

test('#885 a REST error carrying `hint` surfaces it through MCP — the guard must teach, not just refuse', async () => {
  const rest = await startRestServer({ board: makeBoardFixture() });
  const mcp = await startMcpServer({ restApiBase: rest.baseUrl });
  try {
    // ⭐ ANTI-VACUITY, FIRST: prove the REST side actually sends a hint for this
    // query. If the guard ever stops firing, or stops carrying `hint`, this test
    // would otherwise "pass" against an error that never had one to lose.
    const direct = await fetch(`${rest.baseUrl}/api/graph`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: UNBOUNDED }),
    });
    const restBody = await direct.json();
    assert.equal(direct.status, 400, 'precondition: the unbounded-path guard must refuse this query');
    assert.equal(restBody.code, 'UNBOUNDED_PATH', 'precondition: REST must send a code');
    assert.ok(restBody.hint && restBody.hint.length > 40, 'precondition: REST must send a hint');

    const session = await mcpSession(mcp.mcpUrl);
    const call = await session.callTool('graph_query', { query: UNBOUNDED });
    const surfaced = JSON.stringify(call);

    // The teaching half. This is the assertion that fails before the fix.
    assert.ok(surfaced.includes('CONSTRAIN THE OTHER END'),
      'the hint must reach the seat — it names the half people miss (an anchored '
      + 'path whose far end is free still walks every node). Without it a seat '
      + 'anchors one end, believes it complied, and is refused again with no new '
      + `information. Got: ${surfaced.slice(0, 400)}`);

    assert.ok(surfaced.includes('UNBOUNDED_PATH'),
      `the machine-readable code must reach the seat too. Got: ${surfaced.slice(0, 400)}`);

    // Bar item 3: the existing prefix is load-bearing — tests and habits key on it.
    assert.ok(/HTTP 400 from POST \/api\/graph/.test(surfaced),
      `the existing "HTTP <status> from <method> <path>" prefix must be preserved. Got: ${surfaced.slice(0, 400)}`);
  } finally { await mcp.stop(); await rest.stop(); }
});

test('#885 NEGATIVE CONTROL — an error with no hint renders exactly as it does today', async () => {
  const rest = await startRestServer({ board: makeBoardFixture() });
  const mcp = await startMcpServer({ restApiBase: rest.baseUrl });
  try {
    // ⭐ THE CONTROL THAT MATTERS. "Carries more when there is more" must not
    // become "always noisier": the room has shipped that trade twice tonight
    // through disclosure features. A hint-less error is the common case — it
    // must be byte-identical to today, with no dangling separator and no
    // "undefined" leaking from an absent field.
    const missingId = '00000000-0000-4000-8000-000000000000';

    const direct = await fetch(`${rest.baseUrl}/api/cards/${missingId}`);
    const restBody = await direct.json().catch(() => ({}));
    // Anti-vacuity on the control itself: it only controls for anything if this
    // error genuinely lacks the fields under test.
    assert.equal(restBody.hint, undefined, 'precondition: this error must have NO hint');
    assert.equal(restBody.code, undefined, 'precondition: this error must have NO code');

    const session = await mcpSession(mcp.mcpUrl);
    const call = await session.callTool('card_get', { id: missingId });
    const surfaced = JSON.stringify(call);

    assert.ok(!/undefined/.test(surfaced),
      `an absent code/hint must not leak "undefined" into a seat's error. Got: ${surfaced.slice(0, 400)}`);
    assert.ok(!/hint:/.test(surfaced),
      `an error with no hint must not advertise an empty one. Got: ${surfaced.slice(0, 400)}`);
    assert.ok(!/\[\]|\[\s*\]/.test(surfaced),
      `an absent code must not leave empty brackets. Got: ${surfaced.slice(0, 400)}`);
  } finally { await mcp.stop(); await rest.stop(); }
});
