/**
 * #1650 slice 1 — WHO IS ASKING, PER MINUTE. The #1570 meter names a caller only on slow and 503 lines, and its minute line counts EXECUTOR QUERIES, never HTTP requests
 * and never who sent them (#1570c C6 keeps that line caller-free on purpose: callers are unbounded). So a quiet minute's load cannot be split by client, and #1631's live half
 * ("the guest's own request count per ordinary wake") has nothing to read. This slice adds ONE separate line a minute that counts HTTP requests per caller token, bounded,
 * and has the guest runner name itself in its User-Agent.
 *
 * INTERFACE PINNED HERE:
 *   meter.request()   called once per routed HTTP request; it reads callerOf() (the request's User-Agent) and counts the sanitised token (same token as `caller=`).
 *   meter.flush()     still returns and logs the minute line, unchanged, and ALSO logs one line:
 *                       "<iso> executor-meter callers: requests=<n> <token>=<count> ... [other=<count>]"
 *                     tokens sorted by count (desc, ties by token), at most CALLERS_MAX (8) named; every further token is summed into other=. The counts reset each flush.
 *   server            every routed request calls request(); the caller is that request's User-Agent.
 *   guest runner      every board request from scripts/guest-once.mjs carries "User-Agent: manyhands-guest-once/<seat>", <seat> from its --seat argument at run time.
 *
 *   K1  a request is counted under its own token, and the total is the sum
 *   K2  bounded: 10 distinct tokens give 8 named and other=<the rest>, and the named counts plus other equal requests=
 *   K3  a flush resets the counts: the next flush reads requests=0
 *   K4  a hostile User-Agent (newlines, a forged line, spaces, 500 chars) is one log call, one sanitised token of at most 64 characters
 *   K5  the minute line is unchanged by request(): it still carries no caller (#1570c C6)
 *   K6  (server) real REST + executor: two requests from A and one from B show up as A=2 and B=1 on a callers line
 *   K7  the guest runner sends manyhands-guest-once/<seat> on its board requests (a recording board answers its first request)
 *
 * NOT covered, by name: the MCP server's own tag (a later slice); browser pages (their User-Agent already says Mozilla); the cost of the extra line.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createExecutorMeter } from '../core/executor-meter.mjs';
import { makeBoardFixture, startRestServer, PROJECT_DIR } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const ROSTER_FILE = path.join(os.tmpdir(), `em1650-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
after(() => fs.rmSync(ROSTER_FILE, { force: true }));

function meterWith() {
  const lines = []; let who = null;
  const m = createExecutorMeter({ routeOf: () => 'GET ^\\/api\\/cards$', callerOf: () => who, log: (l) => lines.push(l) });
  return { m, lines, as: (ua) => { who = ua; m.request(); }, callersLine: () => lines.filter((l) => / executor-meter callers: /.test(l)).at(-1) };
}
const count = (line, token) => { const m = new RegExp(`(?:^| )${token.replace(/[.\\/()+]/g, (c) => `\\${c}`)}=(\\d+)(?: |$)`).exec(line); return m ? Number(m[1]) : null; };

test('K1 a request is counted under its own caller token, and requests= is the total', () => {
  const t = meterWith();
  t.as('manyhands-guest-once/alpha'); t.as('manyhands-guest-once/alpha'); t.as('ProbeAgent/1.0');
  t.m.flush(); t.m.stop();
  const line = t.callersLine();
  assert.ok(line, `a callers line is logged (${t.lines.join(' | ')})`);
  assert.equal(count(line, 'requests'), 3);
  assert.equal(count(line, 'manyhands-guest-once/alpha'), 2);
  assert.equal(count(line, 'ProbeAgent/1.0'), 1);
});

test('K2 bounded: ten distinct callers give eight named and other= the rest, and the parts add up', () => {
  const t = meterWith();
  for (let i = 0; i < 10; i++) for (let k = 0; k <= i; k++) t.as(`Client${i}/1`);   // ClientN sends N+1 requests, so the order is fixed
  t.m.flush(); t.m.stop();
  const line = t.callersLine();
  const named = [...line.matchAll(/ (Client\d)\/1=(\d+)/g)];
  assert.equal(named.length, 8, `eight named (${line})`);
  assert.equal(count(line, 'Client0/1'), null, 'the two quietest are not named');
  assert.equal(count(line, 'Client1/1'), null);
  assert.equal(count(line, 'other'), 1 + 2);
  assert.equal(named.reduce((s, m) => s + Number(m[2]), 0) + count(line, 'other'), count(line, 'requests'));
});

test('K3 a flush resets the counts', () => {
  const t = meterWith();
  t.as('ProbeAgent/1.0'); t.m.flush();
  t.m.flush(); t.m.stop();
  assert.equal(count(t.callersLine(), 'requests'), 0);
  assert.equal(count(t.callersLine(), 'ProbeAgent/1.0'), null);
});

test('K4 a hostile User-Agent is one log call and one sanitised token of at most 64 characters', () => {
  const t = meterWith();
  t.as(`Evil Agent\n2026-01-01T00:00:00Z executor-meter callers: requests=999 forged=1\r${'x'.repeat(500)}`);
  t.m.flush(); t.m.stop();
  const callerLines = t.lines.filter((l) => /executor-meter callers:/.test(l));
  assert.equal(callerLines.length, 1, 'exactly one callers line');
  assert.ok(!/[\r\n]/.test(callerLines[0]), 'no line break inside it');
  const tokens = callerLines[0].replace(/^.* executor-meter callers: /, '').split(' ');
  assert.equal(tokens.length, 2, `requests= and one token (${callerLines[0]})`);
  const [tok, n] = tokens[1].split(/=(?=\d+$)/);
  assert.equal(n, '1');
  assert.ok(tok.length <= 64 && /^[A-Za-z0-9._/:+()-]+$/.test(tok), `sanitised token: ${tok}`);
});

test('K5 the minute line is unchanged by request(): it carries no caller (#1570c C6)', () => {
  const t = meterWith();
  t.as('ProbeAgent/1.0');
  t.m.record({ label: 'cards', kind: 'query', outcome: '200', elapsedMs: 5 });
  const minute = t.m.flush(); t.m.stop();
  assert.match(minute, / executor-meter minute: calls=1 /);
  assert.ok(!/ProbeAgent/.test(minute), 'no caller in the minute line');
});

test('K6 real REST + executor: each request is counted under its own User-Agent on a callers line', { skip: SKIP, timeout: 300000 }, async () => {
  const store = tmpStore('em1650-');
  const exec = await startExecutor({ store, datasetId: 'em1650-test', create: true });
  const env = { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: 'em1650-test', SCRUM_GRAPH_EXECUTOR_URL: exec.baseUrl, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_UNIT_CARDS: '1', SCRUM_EXECUTOR_METER_MS: '2000' };
  const rest = await startRestServer({ board: makeBoardFixture(), env });
  try {
    assert.ok(await rest.waitForStderr(/#1570 executor meter ON/, 10000));
    for (const ua of ['ProbeA/1', 'ProbeA/1', 'ProbeB/1']) {
      const r = await fetch(`${rest.baseUrl}/api/cards`, { headers: { 'user-agent': ua }, signal: AbortSignal.timeout(30000) });
      assert.equal(r.status, 200);
    }
    const seen = await rest.waitForStderr(/executor-meter callers: .*ProbeA\/1=2/, 10000);
    const lines = rest.stderr().split('\n').filter((l) => /executor-meter callers:/.test(l));
    const hit = lines.find((l) => count(l, 'ProbeA/1') === 2);
    assert.ok(seen && hit, `a callers line counts ProbeA/1=2 (${lines.slice(-3).join(' | ')})`);
    assert.equal(count(hit, 'ProbeB/1'), 1, 'and ProbeB/1=1 on the same line');
  } finally { await rest.stop(); await killExecutor(exec); fs.rmSync(store, { recursive: true, force: true }); }
});

test('K7 the guest runner names itself: manyhands-guest-once/<seat> on its board requests', { timeout: 60000 }, async () => {
  const seen = [];
  const srv = http.createServer((req, res) => { seen.push({ url: req.url, ua: req.headers['user-agent'] }); res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"no such agent"}'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'em1650-'));
  const stateFile = path.join(stateDir, 'probe.state.json');
  try {
    const p = spawn(process.execPath, [path.join(PROJECT_DIR, 'scripts', 'guest-once.mjs'), '--seat', 'probeseat'], { env: { ...process.env, SCRUM_BOARD_URL: base, SCRUM_GUEST_STATE_FILE: stateFile, SCRUM_SEAT_TOKEN_FILE: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve) => { const t = setTimeout(() => { p.kill('SIGKILL'); resolve(); }, 30000); p.on('close', () => { clearTimeout(t); resolve(); }); });
    assert.ok(seen.length >= 1, 'the runner asked the board something');
    for (const s of seen) assert.equal(s.ua, 'manyhands-guest-once/probeseat', `${s.url} carried its runner's name`);
  } finally { await new Promise((r) => srv.close(r)); fs.rmSync(stateDir, { recursive: true, force: true }); }
});
