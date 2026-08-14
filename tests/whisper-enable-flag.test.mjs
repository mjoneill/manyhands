/**
 * #804 F3 — the enablement flag is FAIL-CLOSED, proven by a test that could
 * actually fail.
 *
 * ⚠️ WHY THIS EXISTS: the full suite was 1137 green and `grep -rn
 * WHISPER_ENABLED tests/` returned ZERO. Not one of those tests would have
 * noticed the flag ceasing to work: no input existed that would have made the
 * check fail. Surfaced by independent review.
 *
 * ⛔ AND IT MUST SHELL OUT. The flag is read at module scope, so importing the
 * module in-process captures whatever the environment was at first import and
 * caches it — a test that flipped process.env and re-imported would be
 * measuring the module cache, not the behaviour. Each case below boots a real
 * server on a scratch port with a real environment and asks the real
 * tools/list, which is the only thing that answers the actual question:
 * "what does a seat see?"
 *
 * The suite already knows this lesson as: the thing that EXISTS is not the
 * thing that gets USED — test by shelling out.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url)).replace(/\/tests$/, '');

let portSeq = 0;
function nextPort() { return 3960 + (portSeq++); }

/** Boot mcp-server with a given env, ask tools/list, kill it, return the names. */
async function toolNamesWithEnv(extraEnv) {
  const port = nextPort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flag-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'mcp-server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      MCP_PORT: String(port),
      SCRUM_BOARD_API: `http://127.0.0.1:${port + 500}`, // deliberately dead; we never post
      SCRUM_WHISPER_POOL_FILE: path.join(dir, 'pool.json'),
      SCRUM_WHISPER_STATE_FILE: path.join(dir, 'state.json'),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await waitForListening(child);
    const base = `http://127.0.0.1:${port}/mcp`;
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    const init = await fetch(base, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'flag-test', version: '1' } },
      }),
    });
    const sid = init.headers.get('mcp-session-id');
    await fetch(base, { method: 'POST', headers: { ...headers, 'mcp-session-id': sid },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    const res = await fetch(base, { method: 'POST', headers: { ...headers, 'mcp-session-id': sid },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) });
    const text = await res.text();
    const payload = text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).pop() ?? text;
    return JSON.parse(payload).result.tools.map((t) => t.name);
  } finally {
    child.kill('SIGKILL');
  }
}

function waitForListening(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start in time')), 20000);
    const onData = (buf) => {
      if (/MCP server running/.test(String(buf))) { clearTimeout(timer); resolve(); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited early: ${code}`)); });
  });
}

test('⛔ F3 — with the flag UNSET the whisper surface does not exist', async () => {
  const names = await toolNamesWithEnv({ MCP_WHISPER_ENABLED: undefined });
  assert.equal(names.includes('whisper_claim'), false);
  assert.equal(names.includes('whisper_pool'), false);
  // ...and the rest of the server is unaffected — otherwise this test would
  // pass on a server that simply failed to start properly.
  assert.equal(names.includes('board_status'), true, 'positive control: the server really is serving tools');
});

test('⛔ F3 — a NON-"1" value is also closed ("true"/"yes"/"0" do not enable)', async () => {
  for (const v of ['true', 'yes', '0', '']) {
    const names = await toolNamesWithEnv({ MCP_WHISPER_ENABLED: v });
    assert.equal(names.includes('whisper_claim'), false, `MCP_WHISPER_ENABLED=${JSON.stringify(v)} must not enable`);
  }
});

test('✅ F3 POSITIVE CONTROL — with the flag set to "1" the surface IS present', async () => {
  // ⭐ Without this case the two above would pass against a server where the
  // tools had simply been deleted, and the flag would be proven to do nothing.
  // The pair is what makes either meaningful.
  const names = await toolNamesWithEnv({ MCP_WHISPER_ENABLED: '1' });
  assert.equal(names.includes('whisper_claim'), true);
  assert.equal(names.includes('whisper_pool'), true);
});
