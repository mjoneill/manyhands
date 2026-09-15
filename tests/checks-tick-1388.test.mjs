/**
 * #1388 — THE TICKS THAT READ /api/checks MUST NOT PILE UP.
 *
 * On 2026-09-15 two 60 s setIntervals (the #1216 digest and the #1215
 * emitter) each fetched GET /api/checks with no in-flight guard and no
 * timeout. When one call ran longer than a minute the adapter opened a new
 * REST request every minute forever: 40 queued by 01:12Z, REST at 100 % in
 * handleChecks for clients that had already hung up, three wedges in one
 * night. The instrument was `lsof -nP -iTCP:3141` — the count of adapter →
 * REST sockets — and it is the DONE WHEN: a hung REST shows at most one
 * outstanding /api/checks at any moment.
 *
 * Three rails, each with its own sabotage that fails a DIFFERENT case:
 *   guard    a tick that starts while the previous one is still waiting does
 *            nothing but say so           (remove the guard → case 1 fails)
 *   timeout  a hung read is abandoned at the deadline and the tick ends
 *            (pass no signal → case 2 fails by its own deadline)
 *   shared   both consumers read ONE fetch per tick, never two
 *            (fetch per consumer → case 3 fails)
 * and the loud seam: the real adapter against a REST that hangs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { makeChecksTick } from '../core/checks-tick.mjs';
import { startMcpServer } from './helpers/harness.mjs';

const hang = () => new Promise(() => {});          // a fetch that never returns
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

test('#1388 guard — a tick that starts while the previous one is still waiting does not fetch again', async () => {
  let fetches = 0;
  const lines = [];
  const tick = makeChecksTick({
    fetchChecks: () => { fetches += 1; return hang(); },
    consumers: [],
    timeoutMs: 10_000,
    log: (l) => lines.push(l),
  });
  const first = tick();                              // hangs on the fetch
  await settle(20);
  // Raced against a deadline so a missing guard FAILS this case instead of
  // hanging the file (the first sabotage run took the whole suite down with
  // "promise still pending" — a hang is not a red test).
  const second = await Promise.race([tick(), settle(500).then(() => 'deadline')]);
  assert.notEqual(second, 'deadline', 'the second tick queued behind the first instead of returning — no guard');
  assert.equal(fetches, 1, 'the second tick must not open a second read while the first is in flight');
  assert.equal(second.skipped, true);
  assert.equal(second.reason, 'in-flight');
  assert.ok(lines.some((l) => l.includes('[#1388]') && l.includes('skipped')), `a skipped tick must say so; got ${JSON.stringify(lines)}`);
  assert.equal(tick.state().inFlight, true, 'the first tick is still the one in flight');
  void first;
});

test('#1388 timeout — a hung read is abandoned at the deadline and the tick ENDS', async () => {
  const lines = [];
  const consumed = [];
  const tick = makeChecksTick({
    fetchChecks: ({ signal }) => new Promise((_, reject) => {
      // the shape fetch() has: reject when the signal aborts, never otherwise
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
    consumers: [(c) => consumed.push(c)],
    timeoutMs: 60,
    log: (l) => lines.push(l),
  });
  const deadline = settle(2_000).then(() => 'deadline');
  const out = await Promise.race([tick(), deadline]);
  assert.notEqual(out, 'deadline', 'the tick never resolved — the timeout is not wired to the fetch');
  assert.equal(out.skipped, true);
  assert.equal(out.reason, 'timeout');
  assert.equal(consumed.length, 0, 'nothing is consumed from a read that did not complete');
  assert.ok(lines.some((l) => l.includes('[#1388]') && l.includes('aborted')), `an aborted read must say so; got ${JSON.stringify(lines)}`);
  assert.equal(tick.state().inFlight, false, 'the guard is released after an abort');
});

test('#1388 shared — both consumers read the SAME single fetch per tick', async () => {
  let fetches = 0;
  const seen = [];
  const checks = { standing: [{ id: 'unregistered-kinds', rows: [] }] };
  const tick = makeChecksTick({
    fetchChecks: async () => { fetches += 1; return checks; },
    consumers: [(c) => seen.push(['digest', c]), (c) => seen.push(['emitter', c])],
    timeoutMs: 1_000,
  });
  const out = await tick();
  assert.equal(out.ran, true);
  assert.equal(fetches, 1, 'one tick is one read of /api/checks, however many consumers');
  assert.equal(seen.length, 2);
  assert.equal(seen[0][1], checks);
  assert.equal(seen[1][1], checks, 'the emitter reads the object the digest read, not a second fetch');
  assert.equal(tick.state().inFlight, false);
});

test('#1388 a consumer that throws does not take the other consumer or the guard with it', async () => {
  const lines = [];
  const seen = [];
  const tick = makeChecksTick({
    fetchChecks: async () => ({ standing: [] }),
    consumers: [() => { throw new Error('digest exploded'); }, (c) => seen.push(c)],
    timeoutMs: 1_000,
    log: (l) => lines.push(l),
  });
  const out = await tick();
  assert.equal(out.ran, true);
  assert.equal(seen.length, 1, 'the second consumer still runs');
  assert.ok(lines.some((l) => l.includes('digest exploded')), 'the failure is logged, not swallowed');
  assert.equal(tick.state().inFlight, false);
});

// ── THE LOUD SEAM — the real adapter, a REST that hangs on /api/checks ──────
// Pure tests above prove the module; this proves mcp-server.mjs USES it for
// every /api/checks read it makes. The count on the fake REST is the same
// number lsof showed on the night: outstanding /api/checks requests.
test('#1388 SEAM — against a REST that hangs, the running adapter opens ONE /api/checks and says it skipped the rest', async () => {
  let checksHits = 0;
  const rest = http.createServer((req, res) => {
    if (req.url.startsWith('/api/checks')) { checksHits += 1; return; }   // hang: never answer
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(req.url.startsWith('/api/conversations') ? '[]' : '{}');
  });
  await new Promise((r) => rest.listen(0, '127.0.0.1', r));
  const restApiBase = `http://127.0.0.1:${rest.address().port}`;
  const tendingFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tick-1388-')), 'tending.json');
  fs.writeFileSync(tendingFile, JSON.stringify({ enabled: true, quietAfterMinutes: 69 }));
  const mcp = await startMcpServer({
    restApiBase,
    env: {
      SCRUM_TENDING_CONFIG_FILE: tendingFile,
      MCP_WHISPER_TICK_MS: '150',          // six ticks per second of test
      MCP_CHECKS_TIMEOUT_MS: '30000',      // longer than the test: the hang must be guarded, not timed out
    },
  });
  try {
    await settle(1_500);                     // ~10 ticks
    assert.equal(checksHits, 1, `a hung /api/checks must be read ONCE while it hangs; the adapter opened ${checksHits}`);
    const logs = mcp.stdoutText() + mcp.stderrText();
    assert.ok(logs.includes('[#1388]') && logs.includes('skipped'), `the adapter must say it skipped ticks; logs:\n${logs.slice(-800)}`);
  } finally {
    await mcp.stop();
    rest.closeAllConnections?.();
    await new Promise((r) => rest.close(r));
  }
});
