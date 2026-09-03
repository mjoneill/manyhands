/**
 * #495 — a stranger stands up a SECOND board following the README.
 *
 * Measured 2026-09-03 on a fresh clone: `SCRUM_PORT=3999 MCP_PORT=3998` gave
 * a board on 3999 and an adapter whose REST target was still 3141 — the
 * FIRST board, or whatever else was listening there. The README promised the
 * two instances would not talk to each other; the adapter never read
 * SCRUM_PORT. On a clean machine that is loud (connection refused). On the
 * machine the sentence is about — a scratch board beside a real one — it is
 * silent: every write lands on the real board and every reply says it worked.
 *
 * So the assertion that matters is about BINDING, not defaults: with two
 * boards up and SCRUM_PORT naming the scratch one, a write through the
 * adapter lands on the scratch board and the other board is untouched. A
 * test that only checked the default target would pass on the machine where
 * the bug cannot happen.
 *
 * The other finding: with no `npm install`, the graph endpoints answer 503
 * and the message said to install — but not that the server must be
 * restarted afterwards, and it stays 503 until it is.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { startRestServer, startMcpServer, mcpSession, freePort } from './helpers/harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Spawn with an env where `undefined` DELETES the variable (a stranger's shell has none of them). */
function spawnUntil(args, env, until, timeoutMs = 15000) {
  const full = { ...process.env };
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete full[k]; else full[k] = v; }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, env: full });
    let out = '';
    const finish = (code) => { clearTimeout(t); resolve({ child, out, code }); };
    const t = setTimeout(() => { child.kill(); reject(new Error(`timeout; output so far:\n${out}`)); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; if (out.includes(until)) finish(null); });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => finish(code));
  });
}

const NONE = { SCRUM_PORT: undefined, SCRUM_BOARD_API: undefined, MCP_PORT: undefined };

test('adapter: SCRUM_PORT alone moves the REST target', async () => {
  const boardPort = await freePort();
  const { child, out } = await spawnUntil(['mcp-server.mjs'],
    { ...NONE, MCP_PORT: String(await freePort()), SCRUM_PORT: String(boardPort) }, 'REST API target');
  child.kill();
  assert.match(out, new RegExp(`REST API target: http://127\\.0\\.0\\.1:${boardPort}\\b`), out);
});

test('adapter: SCRUM_BOARD_API wins over SCRUM_PORT (a board on another host)', async () => {
  const { child, out } = await spawnUntil(['mcp-server.mjs'],
    { ...NONE, MCP_PORT: String(await freePort()), SCRUM_PORT: '4242', SCRUM_BOARD_API: 'http://board.example:8080' },
    'REST API target');
  child.kill();
  assert.match(out, /REST API target: http:\/\/board\.example:8080\b/, out);
});

test('adapter: a non-default MCP_PORT that declares NO board is refused at boot, naming the board it would have attached to', async () => {
  const { out, code } = await spawnUntil(['mcp-server.mjs'],
    { ...NONE, MCP_PORT: String(await freePort()) }, 'MCP server running');
  assert.equal(code, 2, out);
  assert.match(out, /refuses to start/, out);
  assert.match(out, /127\.0\.0\.1:3141/, 'the refusal names the board it would silently have used');
  assert.match(out, /SCRUM_PORT=/, 'the refusal shows the fix');
  assert.doesNotMatch(out, /MCP server running/);
});

test('adapter on the DEFAULT port with nothing declared still boots against 3141 (the first-board case is unchanged)', async () => {
  // Only run when 3001 is free: on the live machine the default is held by the real adapter.
  const held = await fetch('http://127.0.0.1:3001/health').then(() => true, () => false);
  if (held) return; // documented skip: the default port is occupied here
  const { child, out } = await spawnUntil(['mcp-server.mjs'], { ...NONE }, 'REST API target');
  child.kill();
  assert.match(out, /REST API target: http:\/\/127\.0\.0\.1:3141\b/, out);
});

test('BINDING: two boards up, SCRUM_PORT names the scratch one — a write through the adapter lands there and the other board is untouched', async () => {
  const other = await startRestServer();   // stands in for "the real board beside it"
  const scratch = await startRestServer();
  const scratchPort = new URL(scratch.baseUrl).port;
  const mcp = await startMcpServer({
    restApiBase: '',                    // harness would declare one; we want the adapter to DERIVE it
    env: { SCRUM_PORT: String(scratchPort), SCRUM_BOARD_API: '' },
  });
  try {
    const session = await mcpSession(mcp.mcpUrl);
    const created = await session.callTool('card_create', { title: 'scratch card', createdBy: 'stranger' });
    assert.ok(!created.isError, JSON.stringify(created));
    const onScratch = await fetch(`${scratch.baseUrl}/api/board/status`).then((r) => r.json());
    const onOther = await fetch(`${other.baseUrl}/api/board/status`).then((r) => r.json());
    assert.equal(onScratch.cardsTotal, 1, 'the write landed on the board SCRUM_PORT named');
    assert.equal(onOther.cardsTotal, 0, 'the other board received nothing');
  } finally {
    await mcp.stop(); await scratch.stop(); await other.stop();
  }
});

test('board without `npm install`: the graph 503 says to install AND restart', async () => {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stranger-'));
  const { child, out } = await spawnUntil(
    ['--import', path.join(ROOT, 'tests/fixtures/hide-oxigraph-register.mjs'), 'server.js'],
    { ...NONE, SCRUM_PORT: String(port), SCRUM_BOARD_FILE: path.join(dir, 'board-data.json'), SCRUM_MCP_NOTIFY_URL: '' },
    'server running',
  );
  try {
    assert.match(out, /server running/, out);
    const res = await fetch(`http://127.0.0.1:${port}/api/graph`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'ASK { ?s ?p ?o }' }),
    });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.code, 'GRAPH_DEPS_MISSING');
    assert.match(body.error, /npm install/);
    assert.match(body.error, /restart/i, 'the message must say the server needs restarting after the install');
  } finally {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
