/**
 * #263 — REST /api/config: read current delivery config, save a validated one.
 * Isolated config file per server (harness SCRUM_CHANNEL_CONFIG_FILE).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer } from './helpers/harness.mjs';

function apiTest(name, fn) {
  test(name, async () => {
    const server = await startRestServer();
    try {
      await fn(server);
    } finally {
      await server.stop();
    }
  });
}
const json = (extra = {}) => ({ headers: { 'Content-Type': 'application/json' }, ...extra });

apiTest('GET /api/config returns the default config when none is saved', async ({ baseUrl }) => {
  const res = await fetch(`${baseUrl}/api/config`);
  assert.equal(res.status, 200);
  const cfg = await res.json();
  assert.equal(cfg.mode, 'soft');
  assert.equal(cfg.soft.minMs, 30000);
  assert.equal(cfg.soft.maxMs, 60000);
  assert.equal(cfg.hard.timeoutMs, 300000);
});

apiTest('POST /api/config persists a valid config and GET reflects it', async ({ baseUrl }) => {
  const body = { mode: 'hard', soft: { minMs: 20000, maxMs: 40000 }, hard: { timeoutMs: 240000 } };
  const post = await fetch(`${baseUrl}/api/config`, json({ method: 'POST', body: JSON.stringify(body) }));
  assert.equal(post.status, 200);
  assert.equal((await post.json()).mode, 'hard');
  const got = await (await fetch(`${baseUrl}/api/config`)).json();
  // #410 — the schema always normalizes in a token-ring sub-config (default TTL when
  // the POST omits it); the persisted shape is the input plus that default.
  assert.deepEqual(got, { ...body, tokenRing: { timeoutMs: 300000 } });
});

apiTest('POST /api/config rejects an out-of-bounds config (400)', async ({ baseUrl }) => {
  const res = await fetch(`${baseUrl}/api/config`, json({
    method: 'POST',
    body: JSON.stringify({ mode: 'soft', soft: { minMs: 50000, maxMs: 10000 }, hard: { timeoutMs: 60000 } }),
  }));
  assert.equal(res.status, 400);
});

apiTest('POST /api/config with text/plain is rejected 415 (CSRF guard still applies)', async ({ baseUrl }) => {
  const res = await fetch(`${baseUrl}/api/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ mode: 'off' }),
  });
  assert.equal(res.status, 415);
});
