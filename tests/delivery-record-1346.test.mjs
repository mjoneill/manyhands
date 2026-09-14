/**
 * #1346 slice 2 — a resident's inbox is a DELIVERY RECORD on the board, not a
 * side-file: `scrum:Delivery { to, conversation, events[] }`, one per
 * (seat, message), append-only events with a typed state and a source
 * (`offered → runner-claimed → turn-started → published | declined | failed`).
 * The fanout writes the first event for every channel-mode resident; the
 * runner (slice 3) drains "offered to me, not yet claimed" and appends the
 * rest. `runner-claimed` is the one ATOMIC step — a second claim is refused —
 * so a claim can never be mistaken for a completed delivery and a retry keeps
 * its attempt number.
 *
 * The seam test at the bottom crosses REST↔MCP: a post through the MCP tool,
 * with a channel-mode resident on the roster, leaves exactly one `offered`
 * record from `fanout` — and none for a wake-mode resident, none for the author.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, startPair, mcpSession, makeBoardFixture } from './helpers/harness.mjs';

async function api(base, method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  let parsed = null; try { parsed = await res.json(); } catch { /* empty body */ }
  return { status: res.status, body: parsed };
}
const MODEL = { model: 'fake', protocol: 'ollama-native', baseUrl: 'http://127.0.0.1:1' };
const agent = (base, seatKey, extra = {}) => api(base, 'POST', '/api/agents', { seatKey, prompt: 'Be brief.', residency: 'resident', by: 'ada', model: MODEL, ...extra });
const post = (base, author, body) => api(base, 'POST', '/api/conversations', { author, body });
const fresh = () => makeBoardFixture({ cards: [], nextShortId: 1 });

test('#1346 a delivery is CREATED once per (seat, message) — the second offer returns the first record', async () => {
  const srv = await startRestServer({ board: fresh() });
  try {
    const msg = (await post(srv.baseUrl, 'ada', 'a post for the room')).body;
    const first = await api(srv.baseUrl, 'POST', '/api/deliveries', { to: 'gizmo', conversation: msg.id, source: 'fanout', by: 'board' });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.to, 'gizmo');
    assert.equal(first.body.conversation, msg.id);
    assert.equal(first.body.state, 'offered', 'the latest state rides the wire');
    assert.equal(first.body.events.length, 1);
    assert.equal(first.body.events[0].state, 'offered');
    assert.equal(first.body.events[0].source, 'fanout');
    assert.match(first.body.events[0].at, /^\d{4}-\d{2}-\d{2}T/);

    const again = await api(srv.baseUrl, 'POST', '/api/deliveries', { to: 'gizmo', conversation: msg.id, source: 'fanout', by: 'board' });
    assert.equal(again.status, 200, 'idempotent: a re-offer is not a second inbox item');
    assert.equal(again.body.id, first.body.id);
    assert.equal(again.body.events.length, 1, 'and it did not append a second offered');

    // Read back — a 201 describes the request, not the state.
    const list = (await api(srv.baseUrl, 'GET', '/api/deliveries?to=gizmo')).body;
    assert.equal(list.deliveries.length, 1);
    assert.equal(list.deliveries[0].id, first.body.id);
  } finally { await srv.stop(); }
});

test('#1346 the CLAIM is atomic and the rest is append-only: state names, attempt, open-list membership', async () => {
  const srv = await startRestServer({ board: fresh() });
  try {
    const msg = (await post(srv.baseUrl, 'ada', 'to be drained')).body;
    const d = (await api(srv.baseUrl, 'POST', '/api/deliveries', { to: 'gizmo', conversation: msg.id, source: 'fanout', by: 'board' })).body;
    const ev = (body) => api(srv.baseUrl, 'POST', `/api/deliveries/${encodeURIComponent(d.id)}/events`, { source: 'guest-runner', by: 'gizmo', ...body });

    assert.equal((await api(srv.baseUrl, 'GET', '/api/deliveries?to=gizmo&open=1')).body.deliveries.length, 1, 'offered ⇒ open');

    const claim = await ev({ state: 'runner-claimed' });
    assert.equal(claim.status, 201, JSON.stringify(claim.body));
    assert.equal(claim.body.state, 'claimed', '#1373 — written as runner-claimed, read back as claimed');
    assert.equal(claim.body.events.at(-1).attempt, 1, 'the first claim is attempt 1');
    const second = await ev({ state: 'runner-claimed' });
    assert.equal(second.status, 409, 'a second claim on a claimed item is refused — two runners cannot both hold it');
    assert.equal((await api(srv.baseUrl, 'GET', '/api/deliveries?to=gizmo&open=1')).body.deliveries.length, 0, 'claimed ⇒ no longer open');

    assert.equal((await ev({ state: 'turn-started' })).status, 201);
    const bad = await ev({ state: 'received' });
    assert.equal(bad.status, 400, 'an unknown state is refused');
    assert.match(String(bad.body.error), /published/, 'the refusal names the states that ARE accepted');

    const failed = await ev({ state: 'failed', note: 'model timeout' });
    assert.equal(failed.status, 201);
    const retry = await ev({ state: 'runner-claimed' });
    assert.equal(retry.status, 201, 'a failed delivery may be claimed again');
    assert.equal(retry.body.events.at(-1).attempt, 2, 'and the retry carries the next attempt number');
    // A decline carries WHOSE act it was: state says what happened, reason says who did it.
    const declined = await ev({ state: 'declined', reason: 'explicit' });
    assert.equal(declined.status, 201);
    assert.equal(declined.body.events.at(-1).reason, 'explicit');
    assert.equal((await ev({ state: 'runner-claimed' })).status, 409, 'declined is terminal');
    // (…the story continues on a fresh record below; this one stays declined)
    const done = (await api(srv.baseUrl, 'GET', `/api/deliveries?conversation=${encodeURIComponent(msg.id)}`)).body.deliveries[0];
    assert.equal(done.state, 'declined');
    assert.deepEqual(done.events.map((e) => e.state), ['offered', 'claimed', 'turn-started', 'failed', 'claimed', 'declined'],
      'nothing was overwritten: the whole path is on the record');
    const second_msg = (await post(srv.baseUrl, 'ada', 'and one that publishes')).body;
    const d2 = (await api(srv.baseUrl, 'POST', '/api/deliveries', { to: 'gizmo', conversation: second_msg.id, source: 'fanout', by: 'board' })).body;
    const ev2 = (body) => api(srv.baseUrl, 'POST', `/api/deliveries/${encodeURIComponent(d2.id)}/events`, { source: 'guest-runner', by: 'gizmo', ...body });
    for (const state of ['runner-claimed', 'turn-started', 'published']) assert.equal((await ev2({ state })).status, 201);
    assert.equal((await ev2({ state: 'runner-claimed' })).status, 409, 'a published delivery is not re-claimable');
  } finally { await srv.stop(); }
});

test('#1346 a delivery must name a seat and a message the board holds', async () => {
  const srv = await startRestServer({ board: fresh() });
  try {
    const msg = (await post(srv.baseUrl, 'ada', 'exists')).body;
    assert.equal((await api(srv.baseUrl, 'POST', '/api/deliveries', { conversation: msg.id, source: 'fanout', by: 'board' })).status, 400, 'no seat');
    assert.equal((await api(srv.baseUrl, 'POST', '/api/deliveries', { to: 'gizmo', conversation: 'no-such-message', source: 'fanout', by: 'board' })).status, 400, 'no such message');
    assert.equal((await api(srv.baseUrl, 'POST', '/api/deliveries', { to: 'gizmo', conversation: msg.id, source: 'carrier-pigeon', by: 'board' })).status, 400, 'an unknown source');
    assert.equal((await api(srv.baseUrl, 'GET', '/api/deliveries?to=gizmo')).body.deliveries.length, 0, 'none of the refusals wrote');
  } finally { await srv.stop(); }
});

test('#1346 the record is a GRAPH NODE: deliveredTo is a person edge, ofConversation an entity edge, each event a node', async () => {
  const srv = await startRestServer({ board: fresh() });
  try {
    const msg = (await post(srv.baseUrl, 'ada', 'queryable')).body;
    const d = (await api(srv.baseUrl, 'POST', '/api/deliveries', { to: 'gizmo', conversation: msg.id, source: 'fanout', by: 'board' })).body;
    await api(srv.baseUrl, 'POST', `/api/deliveries/${encodeURIComponent(d.id)}/events`, { state: 'runner-claimed', source: 'guest-runner', by: 'gizmo' });
    // The LIVE graph through REST, not a projection built in the test: the
    // question the record exists for is "what happened to this message, for
    // this seat", and it has to be answerable where seats ask it.
    let q;
    for (let i = 0; i < 40; i++) {
      q = await api(srv.baseUrl, 'POST', '/api/graph', { query: `
        SELECT ?d ?to ?conv ?state ?src WHERE {
          ?d a scrum:Delivery ; scrum:deliveredTo ?to ; scrum:ofConversation ?conv .
          ?e scrum:ofDelivery ?d ; scrum:state ?state ; scrum:source ?src .
        } ORDER BY ?state` });
      if (q.status === 200 && q.body.rows.length === 2) break;
      await new Promise((res) => setTimeout(res, 50));
    }
    assert.equal(q.status, 200, JSON.stringify(q.body));
    const rows = q.body.rows;
    assert.equal(rows.length, 2, `two event nodes for one delivery — got ${JSON.stringify(rows)}`);
    assert.ok(rows.every((r) => String(r.d) === d.id), JSON.stringify(rows));
    assert.ok(rows.every((r) => /^person:gizmo$|person\/gizmo$/.test(String(r.to))), `deliveredTo is a person IRI (the route compacts prefixes) — ${rows[0].to}`);
    assert.ok(rows.every((r) => String(r.conv).endsWith(msg.id) && /^entity:|scrumboard\.local\/entity\//.test(String(r.conv))), `ofConversation is the message's entity IRI — ${rows[0].conv}`);
    // ORDER BY ?state is alphabetical: 'claimed' now sorts before 'offered' (#1373).
    assert.deepEqual(rows.map((r) => String(r.state)), ['claimed', 'offered'], '#1373 — the graph carries the new name for rows written under the old');
    assert.deepEqual(rows.map((r) => String(r.src)), ['guest-runner', 'fanout']);
  } finally { await srv.stop(); }
});

// ── the seam: a post through MCP leaves a delivery for a channel-mode resident ──
test('#1346 FANOUT — a channel-mode resident gets an `offered` record; a wake-mode one and the author get none', async () => {
  const pair = await startPair({ board: fresh() });
  try {
    assert.equal((await agent(pair.rest.baseUrl, 'gizmo', { deliveryMode: 'channel' })).status, 201);
    assert.equal((await agent(pair.rest.baseUrl, 'bo')).status, 201, 'bo stays in wake mode');
    assert.equal((await agent(pair.rest.baseUrl, 'bex', { deliveryMode: 'channel' })).status, 201);

    const session = await mcpSession(pair.mcp.mcpUrl);
    const r = await session.callTool('conversation_post', { author: 'bex', body: 'a resident speaks' });
    assert.ok(!r.error, JSON.stringify(r.error));

    const settle = async (seat) => {
      for (let i = 0; i < 40; i++) {
        const l = (await api(pair.rest.baseUrl, 'GET', `/api/deliveries?to=${seat}`)).body.deliveries;
        if (l.length) return l;
        await new Promise((res) => setTimeout(res, 50));
      }
      return [];
    };
    const gizmo = await settle('gizmo');
    assert.equal(gizmo.length, 1, 'exactly one offer for the channel-mode resident');
    assert.equal(gizmo[0].state, 'offered');
    assert.equal(gizmo[0].events[0].source, 'fanout', 'the fanout wrote it, and says so');
    const convs = (await api(pair.rest.baseUrl, 'GET', '/api/conversations')).body;
    assert.equal(gizmo[0].conversation, convs.find((c) => c.body === 'a resident speaks').id);

    assert.equal((await api(pair.rest.baseUrl, 'GET', '/api/deliveries?to=bo')).body.deliveries.length, 0, 'wake mode: the fanout is not for bo');
    assert.equal((await api(pair.rest.baseUrl, 'GET', '/api/deliveries?to=bex')).body.deliveries.length, 0, 'a seat is never offered its own post');

    // A second post: a second record, never a second offered on the first.
    await session.callTool('conversation_post', { author: 'ada', body: 'again' });
    for (let i = 0; i < 40; i++) {
      if ((await api(pair.rest.baseUrl, 'GET', '/api/deliveries?to=gizmo')).body.deliveries.length === 2) break;
      await new Promise((res) => setTimeout(res, 50));
    }
    const all = (await api(pair.rest.baseUrl, 'GET', '/api/deliveries?to=gizmo')).body.deliveries;
    assert.equal(all.length, 2);
    assert.ok(all.every((d) => d.events.length === 1));
  } finally { await pair.stop(); }
});

// #1373 — the claim state is named for the act. A BRIDGE lane takes a message
// for one attempt exactly as the runner does; `source` says which consumer.
// Written as `claimed`, and as `runner-claimed` (the alias), both read back
// `claimed`, carry the same attempt numbers, and pass the same guard.
test('#1373 the bridge chain offered → claimed(presence-bridge) → turn-started → published is accepted; runner-claimed is an alias on write and read; the guard is unchanged', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    const msg = (await api(srv.baseUrl, 'POST', '/api/conversations', { body: 'a post', author: 'bo' })).body;
    const mk = async (to) => (await api(srv.baseUrl, 'POST', '/api/deliveries', { to, conversation: msg.id, source: 'presence-bridge', by: 'bridge' })).body;
    const ev = (id, body) => api(srv.baseUrl, 'POST', `/api/deliveries/${encodeURIComponent(id)}/events`, { source: 'presence-bridge', by: 'bridge', ...body });
    const d = await mk('lane-a');
    assert.equal((await ev(d.id, { state: 'claimed' })).status, 201);
    assert.equal((await ev(d.id, { state: 'claimed' })).status, 409, 'a second consumer is refused — the record that exactly one turn ran');
    assert.equal((await ev(d.id, { state: 'turn-started' })).status, 201);
    const pub = await ev(d.id, { state: 'published', reason: 'batch-ambiguous' });
    assert.equal(pub.status, 201);
    assert.deepEqual(pub.body.events.map((e) => e.state), ['offered', 'claimed', 'turn-started', 'published']);
    assert.equal(pub.body.events[1].attempt, 1);
    assert.equal(pub.body.events[3].reason, 'batch-ambiguous', 'the digest boundary rides as reason, not as an invented per-message edge');
    assert.equal((await ev(d.id, { state: 'queued' })).status, 409, 'the guard is intact: nothing follows a terminal');

    // the alias: an old runner still writes runner-claimed; a failed retry counts attempts across both spellings
    const d2 = await mk('lane-b');
    assert.equal((await ev(d2.id, { state: 'runner-claimed', source: 'guest-runner' })).status, 201);
    assert.equal((await ev(d2.id, { state: 'claimed' })).status, 409, 'the alias holds the claim: a claimed delivery is not claimable under the other spelling');
    assert.equal((await ev(d2.id, { state: 'failed', source: 'guest-runner' })).status, 201);
    const retry = await ev(d2.id, { state: 'claimed' });
    assert.equal(retry.status, 201);
    assert.deepEqual(retry.body.events.map((e) => [e.state, e.attempt ?? null]), [['offered', null], ['claimed', 1], ['failed', 1], ['claimed', 2]], 'attempts count across both spellings');
    assert.equal((await api(srv.baseUrl, 'POST', `/api/deliveries/${encodeURIComponent(d2.id)}/events`, { state: 'runner-clamed', source: 'guest-runner', by: 'x' })).status, 400, 'a misspelling is still refused');
  } finally { await srv.stop(); }
});
