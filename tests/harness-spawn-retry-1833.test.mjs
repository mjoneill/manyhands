/**
 * #1833 — a test that spawns the board server on a harness-allocated port must
 * survive losing the port race: #1259 detects a stranger on the port, and the
 * harness must answer that with a retry on a fresh port (#1140), not a red test.
 *
 * Rows: the retry (a real stranger holds the first port handed out), exhaustion
 * (a stranger on every attempt fails loudly, naming #1259 and the attempt count),
 * and the GENERIC guard: no test file may hand-roll freePort() + spawn(server.js),
 * except the ones not yet migrated, and that list may only shrink.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { spawnBoardServer, freePort, makeBoardFixture } from './helpers/harness.mjs';

const TESTS = path.dirname(fileURLToPath(import.meta.url));
const ROOT_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-1833-'));
const cleanup = [];
after(async () => {
  for (const c of cleanup) { try { await c(); } catch { /* best effort */ } }
  fs.rmSync(ROOT_TMP, { recursive: true, force: true });
});

/** A server that answers like a board but is not ours: a different instance header. */
async function stranger() {
  const srv = http.createServer((req, res) => { res.setHeader('x-scrum-instance', 'a-stranger'); res.end('{}'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  cleanup.push(() => new Promise((r) => srv.close(r)));
  return srv.address().port;
}
function boardEnv() {
  const dir = fs.mkdtempSync(path.join(ROOT_TMP, 'board-'));
  const file = path.join(dir, 'board-data.json');
  fs.writeFileSync(file, JSON.stringify(makeBoardFixture()));
  return (port) => ({ ...process.env, SCRUM_BOARD_FILE: file, SCRUM_MCP_NOTIFY_URL: '',
    SCRUM_ATTACHMENTS_DIR: path.join(dir, 'attach'), SCRUM_CHANNEL_CONFIG_FILE: path.join(dir, `chan-${port}.json`) });
}

test('#1833 a STRANGER on the first port is a retry on a fresh port, and the server reached is ours', async () => {
  const taken = await stranger();
  const handedOut = [];
  const allocatePort = async () => { const p = handedOut.length === 0 ? taken : await freePort(); handedOut.push(p); return p; };
  const s = await spawnBoardServer({ env: boardEnv(), allocatePort });
  cleanup.push(() => s.stop());
  assert.equal(handedOut[0], taken, 'the first attempt really was offered the stranger\'s port');
  assert.ok(handedOut.length >= 2, 'a second port was allocated');
  assert.notEqual(s.port, taken, 'it did not settle on the stranger');
  const res = await fetch(`${s.baseUrl}/api/board`);
  assert.equal(res.status, 200);
  assert.notEqual(res.headers.get('x-scrum-instance'), 'a-stranger', 'the board it answers with is ours');
});

test('#1833 a stranger on EVERY attempt fails loudly — naming #1259 and the attempt count — rather than looping', async () => {
  const taken = await stranger();
  let calls = 0;
  await assert.rejects(
    spawnBoardServer({ env: boardEnv(), allocatePort: async () => { calls++; return taken; } }),
    (e) => /did not start \(#1259\)/.test(e.message) && /attempt 4\/4/.test(e.message));
  assert.equal(calls, 4, 'bounded: four attempts, then a refusal');
});

// ── THE GENERIC GUARD ───────────────────────────────────────────────────────
// Files still hand-rolling the spawn. This list may only SHRINK: migrate a file
// to spawnBoardServer / startRestServer and delete its line. A new file that
// hand-rolls it fails here, at review, instead of in CI on a lost race.
const NOT_YET_MIGRATED = new Set([
  'announcement-graph-post-1574-c3c.test.mjs', 'announcement-outbox-1574-c3a.test.mjs', 'announcement-publish-1574-c3b.test.mjs',
  'boot-gate.test.mjs', 'conversations-list-r1.test.mjs', 'data-dir-1788.test.mjs', 'delivery-graph-post-d1.test.mjs',
  'first-run.test.mjs', 'graph-post-discovery-r3-badge.test.mjs', 'graph-post-discovery-r3-idle.test.mjs',
  'graph-post-discovery-r3.test.mjs', 'harness-readiness-identity.test.mjs', 'instance-isolation.test.mjs',
  'memories-log-born-971.test.mjs', 'post-redaction-r4a-addendum.test.mjs', 'post-redaction-r4a.test.mjs',
  'post-seq-1592-epoch.test.mjs', 'post-seq-1592.test.mjs', 'post-write-r2.test.mjs',
]);
const handRolls = (src) => /\bfreePort\s*\(\s*\)/.test(src) && /spawn\s*\(\s*(?:'node'|"node"|process\.execPath)\s*,\s*\[[^\]]*server\.js/.test(src);

test('#1833 GUARD — no test file hand-rolls freePort() + spawn(server.js) outside the shrinking not-yet-migrated list', () => {
  // This file is skipped: its self-check below quotes the hand-rolled shape as a STRING to prove the detector.
  const offenders = fs.readdirSync(TESTS).filter((f) => f.endsWith('.test.mjs') && f !== path.basename(fileURLToPath(import.meta.url)))
    .filter((f) => handRolls(fs.readFileSync(path.join(TESTS, f), 'utf8')));
  const unlisted = offenders.filter((f) => !NOT_YET_MIGRATED.has(f));
  assert.deepEqual(unlisted, [], 'spawn the board server with spawnBoardServer() (or startRestServer) from tests/helpers/harness.mjs: '
    + 'it retries a lost port race; a hand-rolled spawn turns that race into a red test (#1833)');
  const stale = [...NOT_YET_MIGRATED].filter((f) => !offenders.includes(f));
  assert.deepEqual(stale, [], 'these files no longer hand-roll the spawn: delete them from NOT_YET_MIGRATED so the list only shrinks');
});

test('#1833 GUARD self-check — the detector matches the hand-rolled shape and not the helper', () => {
  assert.ok(handRolls("const port = await freePort();\nconst c = spawn('node', ['server.js'], { env });"));
  assert.ok(handRolls('const p = await freePort(); spawn(process.execPath, [path.join(ROOT, "server.js")], {})'));
  assert.ok(!handRolls("const s = await spawnBoardServer({ env });"));
  assert.ok(!handRolls("const port = await freePort(); spawn('node', ['mcp-server.mjs'])"), 'only the board server is in scope');
});
