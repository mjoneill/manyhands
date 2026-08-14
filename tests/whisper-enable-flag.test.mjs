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

// ⚠️ Ports are picked at random from a wide range and the boot is RETRIED on
// collision. A fixed base+counter was the first version, and it is fragile in
// exactly the way that bit on 2026-08-14: a run killed mid-flight left an
// orphaned server holding its port, and the next run's POSITIVE control failed
// with "server exited early" — which reads identically to the feature
// correctly refusing to expose its tools. A collision must never be
// indistinguishable from a fail-closed result.
const usedPorts = new Set();
function nextPort() {
  for (;;) {
    const p = 3800 + Math.floor(Math.random() * 900);
    if (!usedPorts.has(p)) { usedPorts.add(p); return p; }
  }
}

/** Boot mcp-server with a given env, ask tools/list, kill it, return the names. */
async function toolNamesWithEnv(extraEnv, configContents = undefined, attempt = 0) {
  const port = nextPort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flag-'));
  if (configContents !== undefined) fs.writeFileSync(path.join(dir, 'tending.json'), configContents);
  const child = spawn(process.execPath, [path.join(ROOT, 'mcp-server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      MCP_PORT: String(port),
      SCRUM_BOARD_API: `http://127.0.0.1:${port + 500}`, // deliberately dead; we never post
      SCRUM_WHISPER_POOL_FILE: path.join(dir, 'pool.json'),
      SCRUM_WHISPER_STATE_FILE: path.join(dir, 'state.json'),
      SCRUM_TENDING_CONFIG_FILE: path.join(dir, 'tending.json'),
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
  } catch (e) {
    child.kill('SIGKILL');
    // A port collision presents as an immediate non-zero exit. Retry on a
    // fresh port rather than reporting it as a feature result.
    if (attempt < 4 && /server exited early/.test(String(e?.message))) {
      return toolNamesWithEnv(extraEnv, configContents, attempt + 1);
    }
    throw e;
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

test('⛔ F3 — with NO config file the whisper surface does not exist', async () => {
  const names = await toolNamesWithEnv({});
  assert.equal(names.includes('whisper_claim'), false);
  assert.equal(names.includes('whisper_pool'), false);
  assert.equal(names.includes('board_status'), true, 'positive control: the server really is serving tools');
});

test('⛔ F3 — a malformed or non-boolean config is CLOSED, never enabled by accident', async () => {
  // `enabled: "true"` is the trap: a loose Boolean() would open on the string.
  for (const body of ['{not json', '{}', '{"enabled":"true"}', '{"enabled":"1"}', '{"enabled":null}']) {
    const names = await toolNamesWithEnv({}, body);
    assert.equal(names.includes('whisper_claim'), false, `config ${body} must not enable`);
  }
});

test('✅ F3 POSITIVE CONTROL — enabled:true makes the surface present', async () => {
  // Without this, the negatives would pass against a server whose tools were
  // simply deleted, and the switch would be proven to do nothing.
  const names = await toolNamesWithEnv({}, '{"enabled":true}');
  assert.equal(names.includes('whisper_claim'), true);
  assert.equal(names.includes('whisper_pool'), true);
});
