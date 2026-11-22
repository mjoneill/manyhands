/**
 * #2029 slice 2 — A REACTION ON YOUR POST IS PUSHED TO YOU (Claude Code seats), and to no one else.
 *
 * A reaction ADD makes REST send MCP an id-only event; MCP reads the post itself and sends ONE channel note straight to
 * the post author's bound session(s). It is a nudge, never the only copy: the durable paths (the room-update hook, the
 * guest ride-along) still carry every reaction. Review conditions (#2029 review, 2026-11-22), each pinned here:
 *   1. straight to the author's transports, NOT through the channel scheduler: no served-cursor or delivery bookkeeping;
 *   2. no push to a guest/resident author (the ride-along covers them);
 *   3. routeHint's refusals reused (redacted or unreadable = no one), and the excerpt sanitised (newlines collapsed,
 *      cut on a code-point boundary);
 *   4. un-react then re-react sends a fresh note (no coalescing yet).
 *
 *   P1 the author's session gets exactly one note, literal and scalar-meta; the reactor, an unrelated seat and an unbound
 *      session get none
 *   P2 removing a reaction sends nothing; reacting again sends a fresh note
 *   P3 reacting to your own post sends nothing
 *   P4 no delivery row is written for the author (condition 1)
 *   P5 a guest author gets no push (condition 2)
 *   P6 the excerpt is one line and never splits a code point (condition 3)
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startPair, startRestServer, mcpSession, openChannelStream } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const ROSTER_FILE = path.join(os.tmpdir(), `p2029-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, grace: { name: 'Grace', glyph: 'g', color: '#c4a07c' }, otto: { name: 'Otto', glyph: 'o', color: '#a07cc4' }, pip: { name: 'Pip', glyph: 'p', color: '#7ca0c4' }, board: { name: 'Board', glyph: 'b', color: '#8899aa', kind: 'system' } } }));
after(() => { try { fs.unlinkSync(ROSTER_FILE); } catch { /* gone */ } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (base, method, route, body) => {
  const r = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(40000) });
  const text = await r.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: r.status, body: json, text };
};
const reactionNotes = (stream) => stream.messages.filter((m) => m?.method === 'notifications/claude/channel' && m?.params?.meta?.kind === 'reaction');

async function withRoom(body, { mode = null } = {}) {
  const dsid = `p2029-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const store = tmpStore('p2029-store-');
  let exec = null, pair = null, tokensFile = null; const streams = [];
  try {
    exec = await startExecutor({ store, datasetId: dsid, create: true });
    const env = { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: dsid, SCRUM_GRAPH_EXECUTOR_URL: exec.baseUrl, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_UNIT_SMALLKINDS: '1' };
    // Sessions are BOUND by a bearer token (#703), as the live Claude Code seats are; a declared author is not a binding.
    tokensFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'p2029-tok-')), 'seat-tokens.json');
    fs.writeFileSync(tokensFile, JSON.stringify({ tokens: Object.fromEntries(['ada', 'grace', 'otto', 'pip'].map((n) => [`tok-${n}`, { seat: n }])) }));
    let cfg = null;
    if (mode) { cfg = path.join(path.dirname(tokensFile), 'channel-config.json'); fs.writeFileSync(cfg, JSON.stringify({ mode, soft: { minMs: 60000, maxMs: 120000 }, hard: { timeoutMs: 300000 }, tokenRing: { timeoutMs: 90000, bearerSeats: ['ada', 'grace'] } })); }
    pair = await startPair({ mcpEnv: { SCRUM_SEAT_TOKENS: tokensFile, MCP_CHANNEL_CONFIG_REFRESH_MS: '100' }, _startRest: (o) => startRestServer({ ...o, ...(cfg ? { channelConfigFile: cfg } : {}), env: { ...(o.env || {}), ...env } }) });
    const seat = async (name) => {
      const s = await mcpSession(pair.mcp.mcpUrl, name ? { headers: { Authorization: `Bearer tok-${name}` } } : undefined);
      const st = await openChannelStream(pair.mcp.mcpUrl, s.sessionId); streams.push(st);
      return { s, st };
    };
    return await body({ base: pair.rest.baseUrl, mcp: pair.mcp, seat });
  } finally {
    for (const st of streams) { try { st.close(); } catch { /* closed */ } }
    if (pair) { await pair.mcp.stop(); await pair.rest.stop(); }
    if (exec) await killExecutor(exec);
    fs.rmSync(store, { recursive: true, force: true });
    if (tokensFile) fs.rmSync(path.dirname(tokensFile), { recursive: true, force: true });
  }
}

test('P1 the author gets exactly one literal note; the reactor, an unrelated seat and an unbound session get none', { skip: SKIP, timeout: 180000 }, () => withRoom(async ({ base, seat }) => {
  const ada = await seat('ada'); const grace = await seat('grace'); const otto = await seat('otto'); const nobody = await seat(null);
  const p = await api(base, 'POST', '/api/conversations', { author: 'ada', body: 'ada writes something worth a nod' });
  assert.equal(p.status, 201);
  await sleep(400);
  assert.equal((await api(base, 'POST', `/api/conversations/${p.body.id}/reactions`, { by: 'grace', emoji: '👍' })).status, 200);
  await sleep(1200);
  const got = reactionNotes(ada.st);
  assert.equal(got.length, 1, `ada gets one note: ${JSON.stringify(ada.st.messages.slice(-3))}`);
  assert.equal(got[0].params.content, 'grace reacted 👍 to your post: "ada writes something worth a nod"');
  for (const [k, v] of Object.entries(got[0].params.meta)) assert.equal(typeof v, 'string', `meta.${k} is a scalar string (#206)`);
  assert.equal(got[0].params.meta.post, p.body.id);
  for (const [who, x] of [['grace (the reactor)', grace], ['otto', otto], ['an unbound session', nobody]]) assert.equal(reactionNotes(x.st).length, 0, `${who} gets no reaction note`);
}));

test('P2 removing a reaction sends nothing; reacting again sends a fresh note', { skip: SKIP, timeout: 180000 }, () => withRoom(async ({ base, seat }) => {
  const ada = await seat('ada'); await seat('grace');
  const p = await api(base, 'POST', '/api/conversations', { author: 'ada', body: 'a post' });
  await api(base, 'POST', `/api/conversations/${p.body.id}/reactions`, { by: 'grace', emoji: '🐊' }); await sleep(1000);
  assert.equal(reactionNotes(ada.st).length, 1);
  await api(base, 'POST', `/api/conversations/${p.body.id}/reactions`, { by: 'grace', emoji: '🐊', on: false }); await sleep(1000);
  assert.equal(reactionNotes(ada.st).length, 1, 'a removal pushes nothing');
  await api(base, 'POST', `/api/conversations/${p.body.id}/reactions`, { by: 'grace', emoji: '🐊' }); await sleep(1000);
  assert.equal(reactionNotes(ada.st).length, 2, 'a re-react is a fresh note (no coalescing yet)');
}));

test('P3 reacting to your own post sends nothing; P4 no delivery row is written for the author', { skip: SKIP, timeout: 180000 }, () => withRoom(async ({ base, seat }) => {
  const ada = await seat('ada'); await seat('grace');
  const p = await api(base, 'POST', '/api/conversations', { author: 'ada', body: 'my own' });
  await sleep(600);
  const before = (await api(base, 'GET', '/api/deliveries?to=ada')).body?.deliveries?.length ?? 0;
  await api(base, 'POST', `/api/conversations/${p.body.id}/reactions`, { by: 'ada', emoji: '😂' }); await sleep(1000);
  assert.equal(reactionNotes(ada.st).length, 0, 'no note for your own reaction');
  await api(base, 'POST', `/api/conversations/${p.body.id}/reactions`, { by: 'grace', emoji: '👀' }); await sleep(1000);
  assert.equal(reactionNotes(ada.st).length, 1, 'CONTROL: another seat\'s reaction still reaches ada');
  const afterN = (await api(base, 'GET', '/api/deliveries?to=ada')).body?.deliveries?.length ?? 0;
  assert.equal(afterN, before, 'the push wrote no delivery row (it bypasses the scheduler)');
}));

test('P5 a guest author (no bound session) gets no push, and the log says 0 sessions: the ride-along covers them', { skip: SKIP, timeout: 180000 }, () => withRoom(async ({ base, mcp, seat }) => {
  const ada = await seat('ada');
  assert.equal((await api(base, 'POST', '/api/agents', { seatKey: 'pip', prompt: 'You are pip.', model: { model: 'fake', protocol: 'openai-completions', baseUrl: 'http://127.0.0.1:1' }, residency: 'guest', by: 'ada' })).status, 201);
  const p = await api(base, 'POST', '/api/conversations', { author: 'pip', body: 'a guest post' });
  await api(base, 'POST', `/api/conversations/${p.body.id}/reactions`, { by: 'ada', emoji: '👍' }); await sleep(1200);
  assert.equal(reactionNotes(ada.st).length, 0, 'the reactor is not pushed');
  assert.match(mcp.stdoutText(), /reaction push: ada 👍 on pip's post -> 0 bound session\(s\)/, 'nothing to aim at, and the log says so');
}));

test('P7 (review) a seat WITH an agent record and a bound stream still gets the note: "has a record" is not "is a guest"', { skip: SKIP, timeout: 180000 }, () => withRoom(async ({ base, seat }) => {
  const otto = await seat('otto'); await seat('grace');
  assert.equal((await api(base, 'POST', '/api/agents', { seatKey: 'otto', prompt: 'You are otto.', model: { model: 'fake', protocol: 'openai-completions', baseUrl: 'http://127.0.0.1:1' }, residency: 'guest', by: 'grace' })).status, 201);
  const p = await api(base, 'POST', '/api/conversations', { author: 'otto', body: 'otto has a record and a session' });
  await api(base, 'POST', `/api/conversations/${p.body.id}/reactions`, { by: 'grace', emoji: '👏' }); await sleep(1200);
  assert.equal(reactionNotes(otto.st).length, 1);
}));

test('P8 (review) the push marks nothing served for the author\'s lane; CONTROL: an ordinary post through the scheduler does', { skip: SKIP, timeout: 180000 }, () => withRoom(async ({ base, seat }) => {
  await seat('ada'); await seat('grace');
  const lanes = async () => JSON.stringify((await api(base, 'GET', '/api/cursors')).body);
  const mine = await api(base, 'POST', '/api/conversations', { author: 'ada', body: 'ada posts' });
  await sleep(800);
  const before = await lanes();
  await api(base, 'POST', '/api/conversations', { author: 'grace', body: 'an ordinary post ada receives' }); await sleep(1500);
  const mid = await lanes();
  assert.notEqual(mid, before, `CONTROL: the scheduler path marks a lane (else this row proves nothing): ${mid.slice(0, 300)}`);
  await api(base, 'POST', `/api/conversations/${mine.body.id}/reactions`, { by: 'grace', emoji: '👍' }); await sleep(1500);
  assert.equal(await lanes(), mid, 'the reaction push marked no lane served');
}));

test('P9 (review) the note still arrives with the channel in token-ring mode', { skip: SKIP, timeout: 180000 }, () => withRoom(async ({ base, seat }) => {
  const ada = await seat('ada'); await seat('grace');
  await sleep(500);
  const p = await api(base, 'POST', '/api/conversations', { author: 'ada', body: 'in a ring' });
  await api(base, 'POST', `/api/conversations/${p.body.id}/reactions`, { by: 'grace', emoji: '🎶' }); await sleep(1500);
  assert.equal(reactionNotes(ada.st).length, 1, `the push bypasses the ring: ${JSON.stringify(ada.st.messages.slice(-2)).slice(0, 300)}`);
}, { mode: 'token-ring' }));

test('P6 the excerpt is one line, cut on a code-point boundary', { skip: SKIP, timeout: 180000 }, () => withRoom(async ({ base, seat }) => {
  const ada = await seat('ada'); await seat('grace');
  const body = `line one\nline two ${'x'.repeat(40)}${'🐊'.repeat(10)}`;
  const p = await api(base, 'POST', '/api/conversations', { author: 'ada', body });
  await api(base, 'POST', `/api/conversations/${p.body.id}/reactions`, { by: 'grace', emoji: '👍' }); await sleep(1200);
  const [n] = reactionNotes(ada.st);
  assert.ok(n, 'a note arrived');
  const c = n.params.content;
  assert.doesNotMatch(c, /\n/, 'one line');
  assert.match(c, /line one line two/, 'the newline became a space');
  assert.doesNotMatch(c, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, 'no split surrogate pair');
  assert.match(c, /…"$/, 'a cut excerpt says so');
}));
