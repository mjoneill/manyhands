/**
 * #1167 — THE ROOM CAN SEE ITS REFUSALS. Acceptance 1 and 2 of that card, proven
 * by CAUSING a real contended claim rather than asserted from the code.
 *
 * The card's narrowing (2026-09-04): the seat-facing half of refusal was already
 * solved wherever a precondition exists — the 409 reaches its caller, explains
 * itself, names the incumbent. What did not exist was any DURABLE trace: nothing
 * landed, so no activity row, so the refusal was unrecoverable the instant the
 * caller moved on. #1217 gave refusals a shape in the log; this file pins that a
 * coordination-rail refusal specifically lands there with the fields an audit
 * needs — attempted actor, incumbent, card, time — and that a successful claim
 * does NOT, because a rail that inflates the activity count corrupts the very
 * history it was added to measure.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const api = async (baseUrl, method, p, body) => {
  const r = await fetch(`${baseUrl}${p}`, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed = null;
  try { parsed = await r.json(); } catch { /* none */ }
  return { status: r.status, body: parsed };
};
const refusals = (boardFile) => {
  const dir = boardFile.replace(/\.json$/, '') + '-events';
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort()
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)))
    .filter((e) => e.op === 'refused');
};
const board = () => makeBoardFixture({
  cards: [{ id: 'u-7', shortId: 7, title: 'contended', description: '', type: 'task',
    labels: [], assignees: [], column: 'backlog', order: 1, createdAt: '2026-08-01T00:00:00.000Z', relationships: {} }],
  nextShortId: 8,
});

test('#1167 a contended card_claim leaves a durable row naming challenger, incumbent, card and time', async () => {
  const srv = await startRestServer({ board: board() });
  try {
    const first = await api(srv.baseUrl, 'POST', '/api/cards/7/claim', { by: 'ada' });
    assert.equal(first.status, 200, 'the first claim wins');
    assert.deepEqual(refusals(srv.boardFile), [], 'NEGATIVE CONTROL: a successful claim produces no refusal row');

    const second = await api(srv.baseUrl, 'POST', '/api/cards/7/claim', { by: 'bo' });
    assert.equal(second.status, 409, 'the second claim is refused, as before');
    assert.equal(second.body.holder, 'ada', 'and the caller is still told the incumbent — the seat-facing half was never the gap');

    const rows = refusals(srv.boardFile);
    assert.equal(rows.length, 1, 'ONE durable row for the refusal');
    const row = rows[0];
    assert.equal(row.actor, 'bo', 'the ATTEMPTED actor');
    assert.equal(row.response.holder, 'ada', 'the INCUMBENT, from the refusal body that went back');
    assert.equal(row.entity.kind, 'card');
    assert.equal(row.entity.id, '7', 'the card');
    assert.equal(row.status, 409);
    assert.equal(row.route, 'POST /api/cards/7/claim');
    assert.ok(row.recorded_at && row.seq > 0, 'the time, as an ordinary event');
    assert.equal(row.state, null, 'distinguishable from a normal activity WITHOUT reading prose: state is null and op is refused');
  } finally { await srv.stop(); }
});

test('#1167 the audit question is ONE query on the changes surface: who was refused what, by which rule, when', async () => {
  // An EMPTY board, with the card created through the API: a fixture card that
  // predates the log makes /api/changes refuse any `since` older than the first
  // event (#679's honest-partial rule), and under suite load the claim's own
  // stamp can land a millisecond before its event's — a flake that was real.
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 7 }) });
  try {
    const made = await api(srv.baseUrl, 'POST', '/api/cards', { title: 'contended', createdBy: 'ada' });
    assert.equal(made.status, 201);
    const first = await api(srv.baseUrl, 'POST', `/api/cards/${made.body.shortId}/claim`, { by: 'ada' });
    assert.equal(first.status, 200);
    // since = the first claim's stamp: strictly after the create event, which is
    // now the log's oldest line, so the retention rule cannot refuse it.
    const since = first.body.claimedAt;
    await api(srv.baseUrl, 'POST', `/api/cards/${made.body.shortId}/claim`, { by: 'bo' });
    await api(srv.baseUrl, 'POST', `/api/cards/${made.body.shortId}/claim`, { by: 'cy' });

    const res = await api(srv.baseUrl, 'GET', `/api/changes?since=${encodeURIComponent(since)}&history=true`);
    assert.equal(res.status, 200);
    const refused = res.body.changes.filter((r) => r.op === 'refused');
    assert.deepEqual(refused.map((r) => [r.by, r.response.holder, r.status]), [['bo', 'ada', 409], ['cy', 'ada', 409]],
      'two refusals, each naming challenger and incumbent, in seq order');
    // and the successful claim is still there as an ordinary update, not inflated
    assert.equal(res.body.changes.filter((r) => r.op === 'update' && r.kind === 'card').length, 1,
      'the successful claim is one ordinary update, and the refusals did not inflate it');
  } finally { await srv.stop(); }
});

/**
 * The rails #1167 was actually filed about refuse INSIDE the MCP adapter and
 * never reach the server. So the durable row cannot come from the server's own
 * chokepoint; the adapter has to REPORT what it refused. This is the end-to-end
 * proof for the one rail the card's decision contract names by number: a #755
 * cooldown refusal, made by the adapter, findable afterwards in the log with
 * the rule that made it.
 */
import { startMcpServer, mcpSession } from './helpers/harness.mjs';
const payload = (res) => JSON.parse(res.result.content[0].text);
const until = async (fn, ms = 3000) => {
  const t0 = Date.now();
  for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) return fn(); await new Promise((r) => setTimeout(r, 50)); }
};

test('#1167 a #755 cooldown refusal made by the ADAPTER lands in the server log with its rule', async () => {
  const rest = await startRestServer();
  const mcp = await startMcpServer({ restApiBase: rest.baseUrl, env: { SCRUM_CLAIM_THROTTLE: 'on' } });
  try {
    const session = await mcpSession(mcp.mcpUrl);
    const first = payload(await session.callTool('card_create', { createdBy: 'ada', title: 'first in' }));
    assert.equal(first.title, 'first in');
    const second = payload(await session.callTool('card_create', { createdBy: 'bo', title: 'racing bo', description: 'the composed body' }));
    assert.equal(second.refused, true, 'the adapter refuses, as #755 wiring already proves');

    // The report is fire-and-forget; give it a moment, then read the LOG, not the response.
    const rows = await until(() => { const r = refusals(rest.boardFile); return r.length ? r : null; });
    assert.equal(rows.length, 1, 'exactly one durable row for the adapter-side refusal');
    const row = rows[0];
    assert.equal(row.rule, '#755 claim cooldown', 'WHICH RULE denied it');
    assert.equal(row.actor, 'bo', 'WHOM');
    assert.equal(row.request.title, 'racing bo', 'WHAT they tried — the payload, recoverable');
    assert.equal(row.request.description, 'the composed body');
    assert.equal(row.route, 'mcp card_create');
    assert.equal(row.state, null);
    // NEGATIVE CONTROL: the successful create is an ordinary create event, not a refusal.
    const dir = rest.boardFile.replace(/\.json$/, '') + '-events';
    const all = fs.readdirSync(dir).sort().flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
    assert.equal(all.filter((e) => e.op === 'create' && e.entity.kind === 'card').length, 1);
  } finally { await mcp.stop(); await rest.stop(); }
});

test('#1167 POST /api/refusals refuses a report with no rule — and that refusal is itself logged', async () => {
  const srv = await startRestServer({ board: board() });
  try {
    const bad = await api(srv.baseUrl, 'POST', '/api/refusals', { actor: 'ada', reason: 'x', entity: { kind: 'card', id: '7' } });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /rule is required/);
    const rows = refusals(srv.boardFile);
    assert.equal(rows.length, 1, 'a report that could not be recorded is a refusal too');
    assert.equal(rows[0].entity.kind, 'request', 'against no entity kind the route knows — honest fallback');
    assert.equal(rows[0].route, 'POST /api/refusals');

    const good = await api(srv.baseUrl, 'POST', '/api/refusals',
      { actor: 'ada', rule: '#889 card-targeting gate', reason: 'window held by bo', entity: { kind: 'card', id: 7 }, request: { title: 'x' } });
    assert.equal(good.status, 201);
    assert.ok(good.body.seq > 0);
    const after = refusals(srv.boardFile);
    assert.equal(after.length, 2);
    assert.equal(after[1].rule, '#889 card-targeting gate');
    assert.equal(after[1].entity.id, '7', 'a numeric id is stored as the string every other card event uses');
  } finally { await srv.stop(); }
});
