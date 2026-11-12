/**
 * #1851 (#1848 slice 2) — the MCP door to "bears on" links. link_decide takes the seat from the BOUND SESSION, never from its
 * arguments (review 52706: a verdict is counted per seat, #1850, so one seat must not be able to write another's count).
 * The MCP server runs against a RECORDING board here, so each row reads exactly what the tool sent.
 *
 *   M1  link_decide's schema has no seat and no `by`: its arguments are link, verdict, workingOn and nothing else
 *   M2  an unbound session gets UNBOUND, and NOTHING reaches the board
 *   M3  a bound session's verdict reaches POST /api/links/<id>/decide with by = the session's seat; a `by` argument is
 *       refused by the strict schema and nothing is sent
 *   M4  link_list forwards status and card to GET /api/links
 *   M5  link_counts (#1850) forwards since to GET /api/links/counts, and takes no seat: it reads every seat's numbers
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startMcpServer, mcpSession } from './helpers/harness.mjs';

const seen = [];
let board, mcp, tokensDir;
const LINK = 'a'.repeat(64);
before(async () => {
  board = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body: b ? JSON.parse(b) : null });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.url.startsWith('/api/links') ? { ok: true, links: [] } : {}));
    });
  });
  await new Promise((r) => board.listen(0, '127.0.0.1', r));
  tokensDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl1851-mcp-'));
  const tokens = path.join(tokensDir, 'tokens.json');
  fs.writeFileSync(tokens, JSON.stringify({ tokens: { 'tok-ada': { seat: 'ada', heartbeat_s: 60 } } }));
  mcp = await startMcpServer({ restApiBase: `http://127.0.0.1:${board.address().port}`, env: { SCRUM_SEAT_TOKENS: tokens } });
});
after(async () => {
  if (mcp) await mcp.stop();
  if (board) await new Promise((r) => board.close(r));
  if (tokensDir) fs.rmSync(tokensDir, { recursive: true, force: true });
});
const text = (r) => JSON.stringify(r);
const decides = () => seen.filter((s) => s.method === 'POST' && s.url.startsWith('/api/links/'));

test('M1 link_decide\'s schema has no seat and no `by`', async () => {
  const s = await mcpSession(mcp.mcpUrl, { headers: { Authorization: 'Bearer tok-ada' } });
  const tools = (await s.listTools()).result?.tools ?? [];
  const t = tools.find((x) => x.name === 'link_decide');
  assert.ok(t, `link_decide is listed (${tools.map((x) => x.name).filter((n) => n.startsWith('link')).join(', ')})`);
  assert.deepEqual(Object.keys(t.inputSchema.properties).sort(), ['link', 'verdict', 'workingOn']);
  assert.ok(tools.some((x) => x.name === 'link_list'), 'link_list is listed');
});

test('M2 an unbound session gets UNBOUND, and nothing reaches the board', async () => {
  const before = decides().length;
  const s = await mcpSession(mcp.mcpUrl);
  const r = await s.callTool('link_decide', { link: LINK, verdict: 'dismissed' });
  assert.match(text(r), /UNBOUND/);
  assert.equal(decides().length, before, 'no decide was sent');
});

test('M3 a bound session\'s verdict carries by = its seat; an argument trying to name another seat is refused outright', async () => {
  const s = await mcpSession(mcp.mcpUrl, { headers: { Authorization: 'Bearer tok-ada' } });
  const before = decides().length;
  const forged = await s.callTool('link_decide', { link: LINK, verdict: 'confirmed', workingOn: 12, by: 'bob' });
  assert.match(text(forged), /Unrecognized key/, 'the strict schema refuses a `by` argument');
  assert.equal(decides().length, before, 'and nothing reached the board');
  await s.callTool('link_decide', { link: LINK, verdict: 'confirmed', workingOn: 12 });
  const sent = decides().slice(before);
  assert.equal(sent.length, 1, text(seen.slice(-3)));
  assert.equal(sent[0].url, `/api/links/${LINK}/decide`);
  assert.deepEqual(sent[0].body, { verdict: 'confirmed', workingOn: 12, by: 'ada' }, 'by is the session\'s seat');
});

test('M4 link_list forwards status and card', async () => {
  const s = await mcpSession(mcp.mcpUrl, { headers: { Authorization: 'Bearer tok-ada' } });
  await s.callTool('link_list', { status: 'proposed', card: 7 });
  const got = seen.filter((x) => x.method === 'GET' && x.url.startsWith('/api/links')).at(-1);
  assert.ok(got, 'a list request reached the board');
  const u = new URL(got.url, 'http://x');
  assert.deepEqual({ status: u.searchParams.get('status'), card: u.searchParams.get('card') }, { status: 'proposed', card: '7' });
});

test('M5 link_counts forwards since to GET /api/links/counts and takes no seat argument (#1850)', async () => {
  const s = await mcpSession(mcp.mcpUrl, { headers: { Authorization: 'Bearer tok-ada' } });
  const tools = (await s.listTools()).result?.tools ?? [];
  const t = tools.find((x) => x.name === 'link_counts');
  assert.ok(t, 'link_counts is listed');
  assert.deepEqual(Object.keys(t.inputSchema.properties ?? {}), ['since']);
  await s.callTool('link_counts', { since: '2026-11-05T00:00:00.000Z' });
  const got = seen.filter((x) => x.method === 'GET' && x.url.startsWith('/api/links/counts')).at(-1);
  assert.ok(got, 'a counts request reached the board');
  assert.equal(got.url, `/api/links/counts?since=${encodeURIComponent('2026-11-05T00:00:00.000Z')}`);
});
