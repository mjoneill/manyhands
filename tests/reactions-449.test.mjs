/**
 * #449 slice 1, session 1 — EMOJI REACTIONS ON A POST: the store, the REST verb, and the read surface.
 *
 * A reaction is never an edit of the post. Each toggle is its own append-only node (one `entity.put`, kind
 * `reaction`, through the small-kinds unit), and a post's reactions are the fold of those nodes: for each
 * (reactor, emoji), the latest toggle wins. So the post payload and its postSeq cannot change, and history is free.
 *
 *   X0  OFF IS A REFUSAL, NEVER A SILENT NO-OP: with the small-kinds unit off, reacting answers 400 REACTIONS_NEED_GRAPH.
 *   X1  ADD, THEN READ IT BACK: a reaction shows on GET /api/conversations/:id as `reactions: [{emoji, by}]`.
 *   X2  IDEMPOTENT: adding the same reaction twice leaves one; removing it removes it; removing an absent one is a 200 no-op.
 *   X3  ORDER: emoji in the order they were first (still) reacted, reactors in the order they reacted.
 *   X4  REFUSALS: an emoji off the palette, a missing `by`, a non-boolean `on` are 400; an unknown post is 404. None writes.
 *   X5  THE POST IS UNTOUCHED: body, author and postSeq read back identical after reactions, and a post with none has no field.
 *   X6  FAIL LOUD: with the executor unreachable, reacting is 503 (never a 200 that implies it was written).
 *   X7  AN MCP-ONLY SEAT CAN REACT: reaction_add and reaction_remove reach the same store, and conversation_get shows it.
 *
 * NOT COVERED, by name: the list endpoint's reactions (session 1 serves them on the single-post read only); MCP tools
 * a redacted post's reactions; concurrency (two toggles of one (reactor, emoji) in
 * the same millisecond: latest-by-time, ties by IRI, harmless either way); posts held only in the document.
 * Without a python with pyoxigraph the unit-on rows are SKIPPED, and a skip is NOT a pass.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { makeBoardFixture, startRestServer, startPair, mcpSession } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const ROSTER_FILE = path.join(os.tmpdir(), `x449-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, gizmo: { name: 'Gizmo', glyph: 'g', color: '#c4a07c' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (base, method, route, body) => {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(40000) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text };
};
const post = (base, author, body) => api(base, 'POST', '/api/conversations', { author, body });
const react = (base, id, b) => api(base, 'POST', `/api/conversations/${id}/reactions`, b);
const read = (base, id) => api(base, 'GET', `/api/conversations/${id}`);

async function startProxy(execUrl) {
  const p = {};
  p.server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const fwd = { ...req.headers }; delete fwd.host; delete fwd['content-length']; delete fwd.connection;
    try { const f = await fetch(`${execUrl}${req.url}`, { method: req.method, headers: fwd, ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) }); const t = await f.text(); res.statusCode = f.status; res.end(t); } catch { try { req.socket.destroy(); } catch { /* gone */ } }
  });
  await new Promise((r) => p.server.listen(0, '127.0.0.1', r)); p.port = p.server.address().port; p.url = `http://127.0.0.1:${p.port}`;
  p.down = () => new Promise((r) => { p.server.closeAllConnections?.(); p.server.close(() => r()); });
  return p;
}
async function unitOn(body, dsid = 'x449-test') {
  const exec = await startExecutor({ store: tmpStore('x449-store-'), datasetId: dsid, create: true });
  const proxy = await startProxy(exec.baseUrl);
  const rest = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: dsid, SCRUM_GRAPH_EXECUTOR_URL: proxy.url, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_UNIT_SMALLKINDS: '1' } });
  try { return await body({ base: rest.baseUrl, proxy }); } finally { await rest.stop(); try { await proxy.down(); } catch { /* down */ } await killExecutor(exec); }
}
async function aPost(base, text = 'x449 a post to react to') {
  const p = await post(base, 'gizmo', text);
  assert.equal(p.status, 201, `the post is created (${p.text})`);
  return p.body;
}

test('X0 OFF IS A REFUSAL: with the small-kinds unit off, reacting answers 400 REACTIONS_NEED_GRAPH', { timeout: 120000 }, async () => {
  const rest = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
  try {
    const p = await aPost(rest.baseUrl);
    const r = await react(rest.baseUrl, p.id, { by: 'ada', emoji: '👍' });
    assert.equal(r.status, 400, r.text);
    assert.equal(r.body?.code, 'REACTIONS_NEED_GRAPH');
    assert.equal((await read(rest.baseUrl, p.id)).body.reactions, undefined, 'nothing was recorded anywhere');
  } finally { await rest.stop(); }
});

test('X1 ADD, THEN READ IT BACK: the reaction shows on the post', { skip: SKIP, timeout: 120000 }, () => unitOn(async ({ base }) => {
  const p = await aPost(base);
  const r = await react(base, p.id, { by: 'ada', emoji: '👍' });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.reactions, [{ emoji: '👍', by: ['ada'] }], 'the answer carries the post\'s reactions after the write');
  const g = await read(base, p.id);
  assert.equal(g.status, 200);
  assert.deepEqual(g.body.reactions, [{ emoji: '👍', by: ['ada'] }], 'a fresh read shows it');
}));

test('X2 IDEMPOTENT: add twice leaves one, remove removes, removing an absent one is a no-op', { skip: SKIP, timeout: 120000 }, () => unitOn(async ({ base }) => {
  const p = await aPost(base);
  assert.equal((await react(base, p.id, { by: 'ada', emoji: '👀' })).status, 200);
  const again = await react(base, p.id, { by: 'ada', emoji: '👀' });
  assert.equal(again.status, 200);
  assert.deepEqual(again.body.reactions, [{ emoji: '👀', by: ['ada'] }], 'a second add of the same reaction is not a second reaction');
  const off = await react(base, p.id, { by: 'ada', emoji: '👀', on: false });
  assert.equal(off.status, 200, off.text);
  assert.deepEqual(off.body.reactions, [], 'removed');
  assert.equal((await read(base, p.id)).body.reactions, undefined, 'a post with no live reaction carries no field');
  const absent = await react(base, p.id, { by: 'gizmo', emoji: '👏', on: false });
  assert.equal(absent.status, 200, 'removing a reaction that was never there is a no-op, not an error');
  assert.deepEqual(absent.body.reactions, []);
  const back = await react(base, p.id, { by: 'ada', emoji: '👀' });
  assert.deepEqual(back.body.reactions, [{ emoji: '👀', by: ['ada'] }], 'a removed reaction can be added again');
}));

test('X3 ORDER: emoji by first live reaction, reactors in the order they reacted', { skip: SKIP, timeout: 120000 }, () => unitOn(async ({ base }) => {
  const p = await aPost(base);
  for (const [by, emoji] of [['gizmo', '😂'], ['ada', '👍'], ['ada', '😂'], ['board', '👍']]) {
    assert.equal((await react(base, p.id, { by, emoji })).status, 200);
    await sleep(15);
  }
  assert.deepEqual((await read(base, p.id)).body.reactions, [
    { emoji: '😂', by: ['gizmo', 'ada'] },
    { emoji: '👍', by: ['ada', 'board'] },
  ]);
}));

test('X4 REFUSALS: off-palette emoji, missing by, non-boolean on are 400; an unknown post is 404; none writes', { skip: SKIP, timeout: 120000 }, () => unitOn(async ({ base }) => {
  const p = await aPost(base);
  for (const [b, why] of [
    [{ by: 'ada', emoji: '🍌' }, 'an emoji off the palette'],
    [{ by: 'ada', emoji: '👍👍' }, 'two emoji in one'],
    [{ emoji: '👍' }, 'no by'],
    [{ by: '  ', emoji: '👍' }, 'a blank by'],
    [{ by: 'ada', emoji: '👍', on: 'yes' }, 'a non-boolean on'],
  ]) {
    const r = await react(base, p.id, b);
    assert.equal(r.status, 400, `${why} is refused (${r.text})`);
  }
  const unknown = await react(base, '00000000-0000-4000-8000-000000000000', { by: 'ada', emoji: '👍' });
  assert.equal(unknown.status, 404, `an unknown post is 404 (${unknown.text})`);
  assert.equal((await read(base, p.id)).body.reactions, undefined, 'no refused request recorded anything');
}));

test('X5 THE POST IS UNTOUCHED: body, author and postSeq read back identical', { skip: SKIP, timeout: 120000 }, () => unitOn(async ({ base }) => {
  const p = await aPost(base, 'x449 the words that must not change');
  const before = (await read(base, p.id)).body;
  await react(base, p.id, { by: 'ada', emoji: '❤️' });
  await react(base, p.id, { by: 'gizmo', emoji: '🤷' });
  const after = (await read(base, p.id)).body;
  const { reactions, ...rest } = after;
  assert.deepEqual(rest, before, 'everything but the reactions field is byte-for-byte what it was');
  assert.equal(reactions.length, 2);
}));

test('X6 FAIL LOUD: executor unreachable, reacting is 503 and never a 200', { skip: SKIP, timeout: 120000 }, () => unitOn(async ({ base, proxy }) => {
  const p = await aPost(base);
  await proxy.down();
  const r = await react(base, p.id, { by: 'ada', emoji: '👍' });
  assert.equal(r.status, 503, r.text);
}));

test('X7 AN MCP-ONLY SEAT CAN REACT: reaction_add, reaction_remove, and conversation_get shows it', { skip: SKIP, timeout: 120000 }, async () => {
  const dsid = 'x449-mcp';
  const exec = await startExecutor({ store: tmpStore('x449-mcp-store-'), datasetId: dsid, create: true });
  const env = { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: dsid, SCRUM_GRAPH_EXECUTOR_URL: exec.baseUrl, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_UNIT_SMALLKINDS: '1' };
  const p = await startPair({ _startRest: (o) => startRestServer({ ...o, env: { ...(o.env || {}), ...env } }) });
  try {
    const made = await aPost(p.rest.baseUrl);
    const session = await mcpSession(p.mcp.mcpUrl);
    const call = async (name, args) => {
      const r = await session.callTool(name, args);
      const text = r.result?.content?.[0]?.text;
      assert.ok(text && !r.result?.isError, `${name} failed: ${JSON.stringify(r).slice(0, 300)}`);
      return JSON.parse(text);
    };
    assert.deepEqual((await call('reaction_add', { id: made.id, emoji: '👏', by: 'ada' })).reactions, [{ emoji: '👏', by: ['ada'] }]);
    assert.deepEqual((await call('conversation_get', { id: made.id })).reactions, [{ emoji: '👏', by: ['ada'] }], 'a seat reads its reactions where it reads the post');
    assert.deepEqual((await call('reaction_remove', { id: made.id, emoji: '👏', by: 'ada' })).reactions, []);
  } finally { await p.stop(); await killExecutor(exec); }
});

// ── session 2: the batch read the page uses to paint (and refresh) the chips under every loaded post ──
const batch = (base, ids) => api(base, 'GET', `/api/reactions?posts=${ids.map(encodeURIComponent).join(',')}`);

test('X8 BATCH READ, OFF: with the small-kinds unit off, the batch read says reactions are not enabled (so the page shows no button)', { timeout: 120000 }, async () => {
  const rest = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
  try {
    const r = await batch(rest.baseUrl, ['a']);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body, { enabled: false, reactions: {} });
  } finally { await rest.stop(); }
});

test('X9 BATCH READ: the reactions of many posts in one call; a post with none is absent; too many ids is 400; executor away is 503', { skip: SKIP, timeout: 120000 }, () => unitOn(async ({ base, proxy }) => {
  const a = await aPost(base, 'x449 first');
  const b = await aPost(base, 'x449 second');
  const c = await aPost(base, 'x449 third, no reactions');
  await react(base, a.id, { by: 'ada', emoji: '👍' });
  await react(base, b.id, { by: 'gizmo', emoji: '😂' });
  const r = await batch(base, [a.id, b.id, c.id, 'no-such-post']);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body, { enabled: true, reactions: { [a.id]: [{ emoji: '👍', by: ['ada'] }], [b.id]: [{ emoji: '😂', by: ['gizmo'] }] } });
  const many = await batch(base, Array.from({ length: 201 }, (_, k) => `p${k}`));
  assert.equal(many.status, 400, 'more than 200 posts in one read is refused');
  const none = await api(base, 'GET', '/api/reactions');
  assert.equal(none.status, 400, 'no posts named is refused');
  await proxy.down();
  assert.equal((await batch(base, [a.id])).status, 503, 'an unreadable graph is a 503, never an empty answer');
}));
