/**
 * #1905 — the two doors to POST /api/links/attach: the MCP tool and the guest board tool, each named `link_attach`.
 * Like link_decide (#1851/#1895) the attacher is the seat the session or runner binds, never an argument: an attachment
 * says who made it, so one seat must not be able to make one in another's name.
 *
 *   G1  the guest catalog entry: claim, card, reason and nothing that names a seat; its words say an attach is not a confirm
 *   G2  strictly per grant: offered only when granted, implied by nothing (card_get, link_decide)
 *   G3  the exact request, under the executor's own seat; a smuggled seat/by/onBehalfOf never reaches the wire
 *   G4  refused in a sentence BEFORE any request: no reason, a card that is not a number, a claim that is not a claim IRI
 *   G5  the prompt names link_attach only to a resident granted it
 *   K1  the MCP tool's schema: claim, card, reason and nothing else
 *   K2  an unbound MCP session gets UNBOUND, and nothing reaches the board
 *   K3  a bound session's attach carries by = its seat; a `by` argument is refused by the strict schema and nothing is sent
 * NOT COVERED HERE, BY NAME: the attach landing in the graph (knowledge-linking-attach-rest-1905, rows R1-R7).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { makeExecutor, BOARD_TOOLS, toolsFor } from '../core/board-tools.mjs';
import { buildMessages } from '../core/guest-loop.mjs';
import { startMcpServer, mcpSession } from './helpers/harness.mjs';

const CLAIM = 'https://scrumboard.local/assertion/0b6f6f4e-6a43-4d1e-9a51-2c1f0e1d2a3b';
const names = (ts) => ts.map((t) => t.function.name);

function wired() {
  const posts = []; const other = [];
  const exec = makeExecutor({
    get: async (p) => { other.push(['get', p]); return {}; },
    post: async (p, body) => { posts.push({ p, body }); return { id: 'a'.repeat(64), ...body }; },
    put: async (p) => { other.push(['put', p]); return {}; },
    del: async (p) => { other.push(['del', p]); return {}; },
    patch: async (p) => { other.push(['patch', p]); return {}; },
    by: 'pip',
  });
  return { exec, posts, other };
}

test('G1 link_attach is in the catalog: claim, card, reason and nothing that names a seat; it says an attach is not a confirm', () => {
  const t = BOARD_TOOLS.find((x) => x.function.name === 'link_attach');
  assert.ok(t, 'link_attach is a board tool');
  const p = t.function.parameters;
  assert.deepEqual(Object.keys(p.properties).sort(), ['card', 'claim', 'reason']);
  assert.deepEqual([...p.required].sort(), ['card', 'claim', 'reason']);
  assert.equal(p.properties.card.type, 'integer');
  for (const k of Object.keys(p.properties)) assert.doesNotMatch(k, /seat|by|actor|owner/i, `${k} must not name a seat`);
  const d = t.function.description;
  assert.match(d, /bears on/i, 'says what a link is');
  assert.match(d, /not a confirm/i, 'says attaching is not a verdict of use');
  assert.match(d, /reason/i, 'names the reason');
  assert.match(d, /YOUR (OWN )?seat/i, 'says whose name it is recorded under');
});

test('G2 strictly per grant: link_attach only when granted, implied by nothing', () => {
  assert.deepEqual(names(toolsFor({ toolGrants: ['link_attach'] })), ['link_attach']);
  assert.deepEqual(names(toolsFor({ toolGrants: ['card_get', 'link_decide'] })), ['card_get', 'link_decide'], 'neither brings link_attach');
});

test('G3 the exact request, under the executor\'s own seat; a smuggled seat never reaches the wire', async () => {
  const { exec, posts, other } = wired();
  await exec('link_attach', { claim: CLAIM, card: 1902, reason: '  the inbox the card asks for  ', seat: 'x', by: 'x', onBehalfOf: 'x', actor: 'x' });
  assert.deepEqual(posts, [{ p: '/api/links/attach', body: { claim: CLAIM, card: 1902, reason: 'the inbox the card asks for', by: 'pip' } }]);
  assert.deepEqual(other, [], 'nothing else was called');
});

test('G4 refused in a sentence BEFORE any request: no reason, a card that is not a number, a claim that is not a claim', async () => {
  const { exec, posts } = wired();
  await assert.rejects(() => exec('link_attach', { claim: CLAIM, card: 1902 }), /reason/);
  await assert.rejects(() => exec('link_attach', { claim: CLAIM, card: 1902, reason: '   ' }), /reason/);
  await assert.rejects(() => exec('link_attach', { claim: CLAIM, card: '1902', reason: 'x' }), /card/);
  await assert.rejects(() => exec('link_attach', { claim: CLAIM, card: 1.5, reason: 'x' }), /card/);
  await assert.rejects(() => exec('link_attach', { claim: 'the inbox claim', card: 1902, reason: 'x' }), /claim/);
  await assert.rejects(() => exec('link_attach', { card: 1902, reason: 'x' }), /claim/);
  assert.deepEqual(posts, [], 'no request was made for any of them');
});

test('G6 the claim may be its bare id, as the Reading page shows it: sent as the full address', async () => {
  const { exec, posts } = wired();
  await exec('link_attach', { claim: CLAIM.split('/').pop(), card: 1902, reason: 'x' });
  assert.equal(posts[0].body.claim, CLAIM);
  await assert.rejects(() => exec('link_attach', { claim: '../card/2', card: 1902, reason: 'x' }), /claim/);
});

test('G5 the prompt names link_attach only when it is granted', () => {
  const WAKE = { kind: 'mention', id: 'w1', author: 'ada', body: 'hi', createdAt: '2026-11-15T00:00:00Z' };
  const sys = (grants) => buildMessages({ agent: { seatKey: 'pip', name: 'pip', residency: 'resident', toolGrants: grants }, wake: WAKE, memories: [] })
    .filter((x) => x.role === 'system').map((x) => x.content).join('\n');
  assert.doesNotMatch(sys(['card_get', 'link_decide']), /link_attach/, 'an ungranted tool is never named');
  assert.match(sys(['card_get', 'link_attach']), /link_attach/);
});

// ── the MCP door, against a RECORDING board ──────────────────────────────────────────────────────────────────────────────
const seen = [];
let board, mcp, tokensDir;
before(async () => {
  board = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', () => { seen.push({ method: req.method, url: req.url, body: b ? JSON.parse(b) : null }); res.writeHead(201, { 'content-type': 'application/json' }); res.end('{}'); });
  });
  await new Promise((r) => board.listen(0, '127.0.0.1', r));
  tokensDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl1905-mcp-'));
  const tokens = path.join(tokensDir, 'tokens.json');
  fs.writeFileSync(tokens, JSON.stringify({ tokens: { 'tok-ada': { seat: 'ada', heartbeat_s: 60 } } }));
  mcp = await startMcpServer({ restApiBase: `http://127.0.0.1:${board.address().port}`, env: { SCRUM_SEAT_TOKENS: tokens } });
});
after(async () => {
  if (mcp) await mcp.stop();
  if (board) await new Promise((r) => board.close(r));
  if (tokensDir) fs.rmSync(tokensDir, { recursive: true, force: true });
});
const attaches = () => seen.filter((s) => s.method === 'POST' && s.url === '/api/links/attach');

test('K1 the MCP link_attach schema: claim, card, reason and nothing else', async () => {
  const s = await mcpSession(mcp.mcpUrl, { headers: { Authorization: 'Bearer tok-ada' } });
  const t = ((await s.listTools()).result?.tools ?? []).find((x) => x.name === 'link_attach');
  assert.ok(t, 'link_attach is listed');
  assert.deepEqual(Object.keys(t.inputSchema.properties).sort(), ['card', 'claim', 'reason']);
});

test('K2 an unbound session gets UNBOUND, and nothing reaches the board', async () => {
  const n = attaches().length;
  const r = await (await mcpSession(mcp.mcpUrl)).callTool('link_attach', { claim: CLAIM, card: 2, reason: 'x' });
  assert.match(JSON.stringify(r), /UNBOUND/);
  assert.equal(attaches().length, n);
});

test('K3 a bound session\'s attach carries by = its seat; a `by` argument is refused outright', async () => {
  const s = await mcpSession(mcp.mcpUrl, { headers: { Authorization: 'Bearer tok-ada' } });
  const n = attaches().length;
  const forged = await s.callTool('link_attach', { claim: CLAIM, card: 2, reason: 'x', by: 'bob' });
  assert.match(JSON.stringify(forged), /Unrecognized key/);
  assert.equal(attaches().length, n, 'nothing reached the board');
  await s.callTool('link_attach', { claim: CLAIM, card: 2, reason: 'why it bears' });
  const sent = attaches().slice(n);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].body, { claim: CLAIM, card: 2, reason: 'why it bears', by: 'ada' });
});
