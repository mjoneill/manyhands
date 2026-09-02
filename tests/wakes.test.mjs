/**
 * #1118 slice C — scrum:Wake: "when did I last wake, and what changed since?"
 *
 * a seat's person node had ZERO subject triples; nothing time-shaped attached to a
 * seat, so wakes, stamps and compactions were invisible to the graph and a
 * seat could only reconstruct itself by re-reading a 30 KB prose desk. A Wake
 * is an append-only node — {seat, at, note} — never edited, so "what changed
 * since MY last wake" is: the newest Wake for me, then changes_since(at).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture, startPair, mcpSession } from './helpers/harness.mjs';

const json = async (baseUrl, method, path, body) => {
  const r = await fetch(`${baseUrl}${path}`, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed = null;
  try { parsed = await r.json(); } catch { /* none */ }
  return { status: r.status, body: parsed };
};

test('#1118-C a wake is recorded with seat, time and note; the newest for a seat is one filtered read', async () => {
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    const w1 = await json(s.baseUrl, 'POST', '/api/wakes', { by: 'ada', note: 'after compaction' });
    assert.equal(w1.status, 201, JSON.stringify(w1.body));
    assert.equal(w1.body.seat, 'ada');
    assert.ok(w1.body.at);
    assert.equal(w1.body.note, 'after compaction');
    await new Promise((r) => setTimeout(r, 5));
    const w2 = await json(s.baseUrl, 'POST', '/api/wakes', { by: 'ada' });
    assert.equal(w2.status, 201);
    assert.ok(w2.body.at > w1.body.at, 'append-only and time-ordered');
    const mine = await json(s.baseUrl, 'GET', '/api/wakes?seat=ada');
    assert.equal(mine.body.length, 2);
    assert.equal(mine.body[0].id, w2.body.id, 'newest first');
    const latest = await json(s.baseUrl, 'GET', '/api/wakes?seat=ada&limit=1');
    assert.equal(latest.body.length, 1);
    assert.equal(latest.body[0].id, w2.body.id, '"my last wake" is limit=1');
    const none = await json(s.baseUrl, 'GET', '/api/wakes?seat=bo');
    assert.deepEqual(none.body, [], 'a seat that never woke is an EMPTY LIST, never an error');
    const nobody = await json(s.baseUrl, 'POST', '/api/wakes', { note: 'x' });
    assert.equal(nobody.status, 400); assert.match(nobody.body.error, /by/i);
  } finally { await s.stop(); }
});

test('#1118-C BORN IN THE GRAPH: the wake is a node, wokeSeat is a person EDGE, and the newest is ORDER BY DESC LIMIT 1', async () => {
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    await json(s.baseUrl, 'POST', '/api/wakes', { by: 'ada', note: 'first' });
    await new Promise((r) => setTimeout(r, 5));
    await json(s.baseUrl, 'POST', '/api/wakes', { by: 'ada', note: 'second' });
    const q = await json(s.baseUrl, 'POST', '/api/graph', {
      by: 'ada',
      query: 'SELECT ?at ?note WHERE { ?w a scrum:Wake ; scrum:wokeSeat person:ada ; scrum:wokeAt ?at ; schema:text ?note } ORDER BY DESC(?at) LIMIT 1',
    });
    assert.equal(q.status, 200, JSON.stringify(q.body).slice(0, 300));
    assert.equal(q.body.rows.length, 1);
    assert.equal(String(q.body.rows[0].note), 'second', 'the newest wake, from the graph alone');
  } finally { await s.stop(); }
});

test('#1118-C the wake anchors changes_since: what changed since MY last wake is one read after one query', async () => {
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    const w = await json(s.baseUrl, 'POST', '/api/wakes', { by: 'ada' });
    await new Promise((r) => setTimeout(r, 5));
    const c = await json(s.baseUrl, 'POST', '/api/cards', { title: 'made after the wake', createdBy: 'bo' });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const since = await json(s.baseUrl, 'GET', `/api/changes?since=${encodeURIComponent(w.body.at)}`);
    assert.equal(since.status, 200, JSON.stringify(since.body).slice(0, 200));
    const items = Array.isArray(since.body) ? since.body : (since.body.changes ?? since.body.events ?? []);
    assert.ok(items.some((x) => JSON.stringify(x).includes('made after the wake')), `the card made after the wake is in the delta: ${JSON.stringify(since.body).slice(0, 300)}`);
  } finally { await s.stop(); }
});

test('#1118-C ⭐ REACHABLE BY AN MCP-ONLY SEAT: seat_wake and wake_list', async () => {
  const p = await startPair();
  try {
    const session = await mcpSession(p.mcp.mcpUrl);
    const r = await session.callTool('seat_wake', { by: 'ada', note: 'fresh context' });
    const text = r.result?.content?.[0]?.text;
    assert.ok(text && !r.result?.isError, `seat_wake failed: ${JSON.stringify(r).slice(0, 300)}`);
    const made = JSON.parse(text);
    assert.equal(made.seat, 'ada');
    assert.equal(made.note, 'fresh context');
    const l = await session.callTool('wake_list', { seat: 'ada', limit: 1 });
    const rows = JSON.parse(l.result.content[0].text);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, made.id);
  } finally { await p.stop(); }
});
