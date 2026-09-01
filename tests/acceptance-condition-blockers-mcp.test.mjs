/**
 * #823 / #1041 — a CONDITION-SCOPED BLOCKER must be writable by the seats it
 * exists for, and must land as an EDGE.
 *
 * MEASURED 2026-09-01 (indigo), live board, at two layers rather than one:
 *
 *     scrum:ReleaseCondition nodes in the GRAPH          422
 *       …carrying scrum:ofCard                           422
 *       …carrying scrum:blockedBy                          0
 *     acceptance entries in the stored DOCUMENT          427
 *       …carrying a `blockedBy` key of ANY type            0
 *
 * ⭐ The second count is the discriminating one. Had seats been writing the
 * field in a shape the projection skipped, it would sit in the document and be
 * absent from the graph. It is absent from BOTH — so nothing ever reached disk,
 * which pins the loss on the MCP schema stripping it on the way in, not on the
 * projection dropping it on the way out. One count could not tell those apart.
 *
 * THE CHAIN, read end to end:
 *   projection  core/graph-replica.mjs  — consumes a.blockedBy → scrum:blockedBy  ✅ wired
 *   REST        server.js validateAcceptance — condition/evidence/note only       ✅ passes through
 *   MCP         mcp-server.mjs create + update — no `blockedBy` in the entry      ⛔ THE HOLE
 *
 * ⚠️ THE SHAPE, AND THE CHANGE THAT LOOKED NEEDED AND WAS NOT. #823's own note
 * proposed `z.array(z.number())` and stopped. Numbers ARE right — the domain
 * speaks shortIds, exactly as `relationships.blockedBy` does. What the note got
 * wrong was the projection: its `typeof ref !== 'string' -> continue` guard
 * looks like it would skip those numbers, so the obvious second half of the fix
 * was to coerce them with String().
 *
 * ⛔ THAT COERCION IS DEAD AND HARMFUL, and a MUTATION TEST is what proved it.
 * Replacing the guard with a coercing one SURVIVED this file's first test.
 * `core/jsonld.mjs` already resolves these shortIds to entity UUIDs on the way
 * in, so well-formed input never reaches the projection as a number — and a ref
 * that IS still a number is one that FAILED to resolve, i.e. names a card that
 * does not exist. Coercing it would mint a dangling `entity:<shortId>` IRI and
 * make a genuinely blocked card look condition-scoped. The third test below
 * pins that fail-safe so the "obvious" coercion cannot be reintroduced.
 *
 * ⇒ The surviving mutation was the finding. Had the suite gone green and been
 * shipped on that, the dead branch would have travelled as a fix.
 *
 * ⛔ ANTI-VACUITY, and it is not hypothetical here. `deepStrict` is live, so
 * BEFORE this fix the call below does not silently drop `blockedBy` — it fails
 * the WHOLE tool call with `unrecognized_keys`. A test that only asserted "no
 * edge appeared" would therefore pass against a server that never received the
 * write at all, for the same reason #534's first cut passed. Every assertion
 * below is paired with a control that a KNOWN key landed in the SAME call.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, startMcpServer, mcpSession, makeBoardFixture } from './helpers/harness.mjs';

const SHA = 'd'.repeat(40);

const api = async (baseUrl, method, path, body) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method, headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : null };
};

/** Two cards: #1 carries the conditions, #2 is what one condition waits on. */
const board = () => makeBoardFixture({
  cards: [
    {
      id: 'u-1', shortId: 1, title: 'a card whose conditions block separately', description: '',
      type: 'task', labels: [], assignees: [], column: 'backlog', order: 1,
      createdAt: '2026-09-01T00:00:00.000Z', relationships: {},
    },
    {
      id: 'u-2', shortId: 2, title: 'the upstream card one condition waits on', description: '',
      type: 'task', labels: [], assignees: [], column: 'backlog', order: 2,
      createdAt: '2026-09-01T00:00:00.000Z', relationships: {},
    },
  ],
  nextShortId: 3,
});

test('#1041 a condition-scoped blocker is WRITABLE THROUGH MCP and lands as an edge', async () => {
  const rest = await startRestServer({ board: board() });
  const mcp = await startMcpServer({ restApiBase: rest.baseUrl });
  try {
    const session = await mcpSession(mcp.mcpUrl);
    const call = await session.callTool('card_update', {
      id: '1', by: 'indigo',
      acceptance: [
        // The CONTROL, in the same call: an ordinary discharged condition.
        // If the tool refuses the whole call, this lands nowhere either — so
        // its presence downstream is what proves the call was actually served.
        { condition: 'RC1 — the projection emits the predicate', evidence: [SHA] },
        // The FEATURE: one condition blocked, the rest not.
        { condition: 'RC2 — the upstream card ships', evidence: [], blockedBy: [2] },
      ],
    });

    // ⚠️ The harness returns the RAW JSON-RPC envelope, so the verdict is at
    // `result.isError` — `call.isError` is undefined, and `assert.ok(!undefined)`
    // passes for a call that FAILED. The first cut of this file read the outer
    // field and reported a green control on a refused write.
    assert.ok(!call.result?.isError,
      `card_update must ACCEPT a condition-scoped blocker; got: ${JSON.stringify(call.result?.content)?.slice(0, 400)}`);

    // Layer 1 — the DOCUMENT. Read back rather than trusting the echo: an
    // accepted write is not a stored write, which is the lesson that found
    // this whole family.
    const fresh = await api(rest.baseUrl, 'GET', '/api/cards/1');
    assert.equal(fresh.status, 200);
    const rc2 = fresh.body.acceptance.find((a) => a.condition.startsWith('RC2'));
    const rc1 = fresh.body.acceptance.find((a) => a.condition.startsWith('RC1'));
    assert.ok(rc1, 'CONTROL: the ordinary condition must survive the same write');
    assert.deepEqual(rc1.evidence, [SHA], 'CONTROL: a known key still lands');
    assert.ok(rc2, 'the blocked condition must survive the write');
    assert.deepEqual(rc2.blockedBy, [2], 'blockedBy must reach disk, not be stripped en route');

    // Layer 2 — the GRAPH. The predicate must hang off the ReleaseCondition,
    // which is #1041's whole point: same predicate, different SUBJECT.
    const q = await api(rest.baseUrl, 'POST', '/api/graph', {
      query: `SELECT ?condition ?target WHERE {
        ?rc a scrum:ReleaseCondition ; scrum:ofCard ?c ; schema:name ?condition ;
            scrum:blockedBy ?target .
        ?c schema:identifier "1" .
      }`,
    });
    assert.equal(q.status, 200, JSON.stringify(q.body));
    assert.equal(q.body.rows.length, 1, 'exactly the blocked condition carries the edge — not all of them');
    assert.ok(q.body.rows[0].condition.startsWith('RC2'),
      `the edge must sit on RC2, not RC1; got ${q.body.rows[0].condition}`);

    // Layer 3 — THE FEATURE'S OWN SUCCESS QUERY. `readyConditionBlockersQuery`
    // has been structurally vacuous since it was written; this is the assertion
    // that stops it being so. Shape copied from core/ready-query.mjs.
    const feature = await api(rest.baseUrl, 'POST', '/api/graph', {
      query: `SELECT ?id ?tid WHERE {
        ?rc a scrum:ReleaseCondition ; scrum:ofCard ?card ; scrum:blockedBy ?target .
        ?card schema:identifier ?id .
        OPTIONAL { ?target schema:identifier ?tid } }`,
    });
    assert.equal(feature.status, 200, JSON.stringify(feature.body));
    assert.equal(feature.body.rows.length, 1, 'the queue rule must see the blocker it was written for');
    assert.equal(feature.body.rows[0].id, '1', 'attributed to the card that owns the condition');
  } finally { await mcp.stop(); await rest.stop(); }
});

test('#823 widening by ONE field must not loosen the object — an unknown key inside acceptance is still REFUSED', async () => {
  // ⭐ ONE DIRECTION CERTIFIES THE OTHER. The test above passes just as well if
  // the fix were "drop .strict() on the acceptance entry" — which would reopen
  // #823 at the exact site it was measured. This is the assertion that tells
  // those two implementations apart, and it is the reason to write it here
  // rather than trust that nobody would take the shortcut.
  const rest = await startRestServer({ board: board() });
  const mcp = await startMcpServer({ restApiBase: rest.baseUrl });
  try {
    const session = await mcpSession(mcp.mcpUrl);
    const bad = await session.callTool('card_update', {
      id: '1', by: 'indigo',
      acceptance: [{ condition: 'RC1', evidence: [], blockedByCard: [2] }],
    });
    assert.ok(bad.result?.isError, 'a near-miss key inside an acceptance entry must be REFUSED, not stripped');
    const text = JSON.stringify(bad.result?.content);
    assert.ok(/blockedByCard/.test(text), `the refusal must NAME the field; got ${text.slice(0, 300)}`);

    // CONTROL: the write really was refused rather than partially applied.
    const fresh = await api(rest.baseUrl, 'GET', '/api/cards/1');
    assert.ok(!fresh.body.acceptance || fresh.body.acceptance.length === 0,
      'a refused call must write NOTHING — not the condition, not the key');
  } finally { await mcp.stop(); await rest.stop(); }
});

test('#1041 a blockedBy naming a card that does NOT exist produces NO edge — never a dangling one', async () => {
  // ⛔ THE FAIL-SAFE, and the reason the projection guard is string-only.
  // An unresolvable ref must vanish rather than resolve to `entity:<shortId>`:
  // a dangling target would satisfy `?rc scrum:blockedBy ?target` and report a
  // card as condition-scoped-blocked on a blocker that is not there. Skipping
  // leaves it blocked at the CARD level, which is the safe direction.
  const rest = await startRestServer({ board: board() });
  const mcp = await startMcpServer({ restApiBase: rest.baseUrl });
  try {
    const session = await mcpSession(mcp.mcpUrl);
    const call = await session.callTool('card_update', {
      id: '1', by: 'indigo',
      acceptance: [
        { condition: 'RC1 — resolvable, the CONTROL', evidence: [], blockedBy: [2] },
        { condition: 'RC2 — names card 9999, which does not exist', evidence: [], blockedBy: [9999] },
      ],
    });
    assert.ok(!call.result?.isError,
      `the write is well-FORMED, so it must be accepted; got ${JSON.stringify(call.result?.content)?.slice(0, 300)}`);

    const q = await api(rest.baseUrl, 'POST', '/api/graph', {
      query: `SELECT ?condition WHERE {
        ?rc a scrum:ReleaseCondition ; scrum:ofCard ?c ; schema:name ?condition ;
            scrum:blockedBy ?target .
        ?c schema:identifier "1" .
      }`,
    });
    assert.equal(q.status, 200, JSON.stringify(q.body));
    // CONTROL FIRST: the resolvable one MUST be here, or this test proves
    // nothing — an empty result would "pass" the dangling assertion for the
    // trivial reason that no edges were projected at all.
    assert.ok(q.body.rows.some((r) => r.condition.startsWith('RC1')),
      'CONTROL: the resolvable blocker must project, or the absence below is vacuous');
    assert.ok(!q.body.rows.some((r) => r.condition.startsWith('RC2')),
      'an unresolvable shortId must NOT be projected as a dangling entity IRI');
    assert.equal(q.body.rows.length, 1, 'exactly one edge — the resolvable one');
  } finally { await mcp.stop(); await rest.stop(); }
});
