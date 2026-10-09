/**
 * #1570 follow-up, THE CALLER ON THE METER'S SLOW-CALL LINE: the test author's rows, written BEFORE the build (2026-10-09). Why: after the flip, 143 of 144 slow executor
 * calls in ten minutes were GET /api/deliveries arriving every ~5 s, and nothing in the log says WHO sends them (the REST log keeps no caller per request id). The line must name
 * the caller so a poller can be found in one look. The caller is the request's User-Agent; it is attacker-controlled text, so it is bounded and sanitised, and it can NEVER carry
 * a secret or break the one-line-per-event log format.
 *
 * INTERFACE PINNED HERE (the builder implements against this file):
 *   createExecutorMeter({ ..., callerOf = () => null, peerOf = () => null })   callerOf() returns the current request's caller string, or null/undefined/'' when there is none (a background call);
 *                                                            peerOf() returns the request's socket REMOTE PORT, an integer 1..65535, or null (UA alone says "node" for every Node client, the port names the process via lsof)
 *   a slow line   : "... route=<route> rid=<rid|-> caller=<token|-> peer=<port|-> body=<16 hex>"   (caller sits between rid and body; the existing EM1 and EM4 rows that spell "rid=- body=" and
 *                    "... body=[0-9a-f]{16}$" must be edited by the builder to accept the new token: that edit is the builder's, named here so it is not a surprise)
 *   a 503 line    : "executor-meter 503: code=... route=... rid=... caller=<token|-> peer=<port|-> loopMaxThisMinuteMs=..."
 *   <port>        : an integer 1..65535 as digits; anything else (a string, a float, 0, 99999, NaN, null, a throw) is "-"
 *   <token>       : the caller with every character outside [A-Za-z0-9._/:+()-] replaced by "_", at most 64 characters, "-" when absent or when callerOf throws
 *   the minute line and its buckets NEVER contain a caller (bounded cardinality: the bucket key stays label|kind|outcome|route)
 *   server        : the caller is the request's User-Agent header, per request (not per process); an Authorization header, a Cookie header or a query string never appear in any meter line
 *
 *   C0 CONTROL  a meter with no callerOf: the slow line still carries every old field, and caller=-
 *   C1          the caller appears on the slow line, old fields unchanged
 *   C2          log injection: a caller with newlines and a forged "executor-meter 503:" line is ONE log call, no \n or \r, no whitespace in the token
 *   C3          length: a 500-character caller is cut to at most 64
 *   C4          absent / empty / a throwing callerOf: caller=-, and the line is STILL logged (a meter never breaks the call it observes)
 *   C5          the 503 line carries the caller too
 *   C6          bounded cardinality: two calls from different callers on the same label/kind/outcome/route are ONE bucket (n=2) and the minute line contains neither caller
 *   C7 (server) real REST + executor: GET /api/cards with User-Agent A then with User-Agent B: each slow line names ITS OWN caller (per request, not per process)
 *   C8 (server) a request carrying Authorization, Cookie and a secret in the query string: none of those values appears in ANY line REST writes
 *   C9          peerOf: an integer port is printed as digits; a string, a float, 0, 70000 and a throwing peerOf print peer=-
 *   C10 (server) two clients on two SOCKETS log two different peer= values, a reused keep-alive socket logs the same value twice, and the value is an integer
 *
 * NOT covered, by name: other headers as the caller (Origin, an x-client id): the build may add them, no row pins them; background calls with no request (they read caller=- by C0/C4,
 * not by a server row); the keep-alive post; the cost of reading a header on every request.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createExecutorMeter } from '../core/executor-meter.mjs';
import { makeBoardFixture, startRestServer } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const ROSTER_FILE = path.join(os.tmpdir(), `em1570c-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));

function slowLine({ callerOf, peerOf, route = 'GET ^\\/api\\/deliveries$', rid = 'r1' } = {}) {
  const lines = [];
  const m = createExecutorMeter({ routeOf: () => route, ridOf: () => rid, callerOf, peerOf, slowMs: 100, log: (l) => lines.push(l) });
  return { m, lines, record: () => m.record({ label: 'posts', kind: 'query', outcome: '200', elapsedMs: 250, body: 'x' }) };
}
const tokenOf = (line) => /\bcaller=(\S*)/.exec(line)?.[1];

test('C0 CONTROL: with no callerOf the slow line keeps every old field and reads caller=-', () => {
  const t = slowLine(); t.record(); t.m.stop();
  assert.equal(t.lines.length, 1);
  assert.match(t.lines[0], /executor-meter slow: 250ms label=posts kind=query outcome=200 route=GET \^\\\/api\\\/deliveries\$ rid=r1 caller=- peer=- body=[0-9a-f]{16}$/);
});

test('C1 the caller appears on the slow line and the old fields are unchanged', () => {
  const t = slowLine({ callerOf: () => 'ExampleClient/1.2' }); t.record(); t.m.stop();
  assert.match(t.lines[0], /label=posts kind=query outcome=200 route=GET \^\\\/api\\\/deliveries\$ rid=r1 caller=ExampleClient\/1\.2 peer=- body=[0-9a-f]{16}$/);
});

test('C2 a caller with newlines and a forged meter line is ONE log call with no line break and no whitespace in the token', () => {
  const evil = 'x\n2026-10-09T00:00:00.000Z executor-meter 503: code=FORGED route=forged rid=- loopMaxThisMinuteMs=0\r\nmore';
  const t = slowLine({ callerOf: () => evil }); t.record(); t.m.stop();
  assert.equal(t.lines.length, 1, 'one call -> one log call');
  assert.ok(!/[\r\n]/.test(t.lines[0]), 'the line has no line break in it');
  const tok = tokenOf(t.lines[0]); assert.ok(tok && !/\s/.test(tok), `token ${JSON.stringify(tok)} has no whitespace`);
  assert.ok(!/code=FORGED/.test(t.lines[0].replace(/caller=\S+/, '')), 'and the forged text did not become a field of its own');
  assert.match(tok, /^[A-Za-z0-9._\/:+()_-]+$/);
});

test('C3 a 500-character caller is cut to at most 64 characters', () => {
  const t = slowLine({ callerOf: () => 'A'.repeat(500) }); t.record(); t.m.stop();
  const tok = tokenOf(t.lines[0]); assert.ok(tok.length >= 1 && tok.length <= 64, `token length ${tok.length}`);
  assert.ok(/^A+$/.test(tok), 'what is kept is the front of it');
});

test('C4 absent, empty or a throwing callerOf reads caller=- and the line is STILL logged', () => {
  for (const callerOf of [() => null, () => undefined, () => '', () => { throw new Error('header read failed'); }]) {
    const t = slowLine({ callerOf }); t.record(); t.m.stop();
    assert.equal(t.lines.length, 1, 'still logged');
    assert.equal(tokenOf(t.lines[0]), '-');
  }
});

test('C5 the 503 line carries the caller too', () => {
  const lines = [];
  const m = createExecutorMeter({ routeOf: () => 'GET ^\\/api\\/conversations', ridOf: () => 'r9', callerOf: () => 'Mozilla/5.0_board-tab', slowMs: 100, log: (l) => lines.push(l) });
  m.unavailable('GRAPH_UNAVAILABLE'); m.stop();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /executor-meter 503: code=GRAPH_UNAVAILABLE route=GET \^\\\/api\\\/conversations rid=r9 caller=Mozilla\/5\.0_board-tab peer=- loopMaxThisMinuteMs=/);
});

test('C6 bounded cardinality: two different callers on the same label/kind/outcome/route are ONE bucket, and the minute line names neither', () => {
  let who = 'PollerA/1';
  const lines = [];
  const m = createExecutorMeter({ routeOf: () => 'GET ^\\/api\\/deliveries$', callerOf: () => who, slowMs: 100000, log: (l) => lines.push(l) });
  m.record({ label: 'posts', kind: 'query', outcome: '200', elapsedMs: 10 });
  who = 'PollerB/2';
  m.record({ label: 'posts', kind: 'query', outcome: '200', elapsedMs: 20 });
  const minute = m.flush(); m.stop();
  assert.match(minute, /posts\/query\/200@GET \^\\\/api\\\/deliveries\$ n=2 total=30ms max=20ms/);
  assert.ok(!/Poller[AB]/.test(minute), 'no caller in the aggregate');
});

test('C7 real REST + executor: each request\'s slow line names ITS OWN User-Agent (per request, not per process)', { skip: SKIP, timeout: 300000 }, async () => {
  const exec = await startExecutor({ store: tmpStore('emc-'), datasetId: 'emc-test', create: true });
  const env = { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: 'emc-test', SCRUM_GRAPH_EXECUTOR_URL: exec.baseUrl, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_UNIT_CARDS: '1', SCRUM_EXECUTOR_METER_MS: '300', SCRUM_EXECUTOR_METER_SLOW_MS: '0' };
  const rest = await startRestServer({ board: makeBoardFixture(), env });
  try {
    assert.ok(await rest.waitForStderr(/#1570 executor meter ON/, 10000));
    for (const ua of ['ProbeAgent/9.9', 'OtherAgent/1.0']) {
      const r = await fetch(`${rest.baseUrl}/api/cards`, { headers: { 'user-agent': ua }, signal: AbortSignal.timeout(30000) });
      assert.equal(r.status, 200);
      const re = new RegExp(`executor-meter slow: .* route=GET \\^\\\\/api\\\\/cards.* caller=${ua.replace(/[.\\/]/g, (c) => `\\${c}`)} `);
      assert.ok(await rest.waitForStderr(re, 10000), `a slow line names ${ua} (${rest.stderr().split('\n').filter((l) => /executor-meter slow/.test(l)).slice(-3).join(' | ')})`);
    }
  } finally { await rest.stop(); await killExecutor(exec); }
});

test('C8 real REST: an Authorization header, a Cookie and a secret in the query string appear in NO line REST writes', { skip: SKIP, timeout: 300000 }, async () => {
  const exec = await startExecutor({ store: tmpStore('emc8-'), datasetId: 'emc8-test', create: true });
  const env = { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: 'emc8-test', SCRUM_GRAPH_EXECUTOR_URL: exec.baseUrl, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_UNIT_CARDS: '1', SCRUM_EXECUTOR_METER_MS: '300', SCRUM_EXECUTOR_METER_SLOW_MS: '0' };
  const rest = await startRestServer({ board: makeBoardFixture(), env });
  try {
    assert.ok(await rest.waitForStderr(/#1570 executor meter ON/, 10000));
    await fetch(`${rest.baseUrl}/api/cards?limit=1&token=QSECRET-4242`, { headers: { 'user-agent': 'SecretProbe/1.0', authorization: 'Bearer BEARERSECRET-4242', cookie: 'session=COOKIESECRET-4242' }, signal: AbortSignal.timeout(30000) });
    assert.ok(await rest.waitForStderr(/executor-meter slow: .* caller=SecretProbe\/1\.0 /, 10000), 'CONTROL: the request produced a slow line with its caller');
    await new Promise((r) => setTimeout(r, 400));
    for (const secret of ['BEARERSECRET-4242', 'COOKIESECRET-4242', 'QSECRET-4242']) assert.ok(!rest.stderr().includes(secret), `${secret} must not appear in any REST log line`);
  } finally { await rest.stop(); await killExecutor(exec); }
});

test('C9 peerOf: an integer port is printed as digits; a string, a float, 0, 70000 and a throwing peerOf print peer=-', () => {
  const peerOf1 = (v) => { const t = slowLine({ peerOf: v }); t.record(); t.m.stop(); return /\bpeer=(\S*)/.exec(t.lines[0])?.[1]; };
  assert.equal(peerOf1(() => 51234), '51234');
  for (const bad of ['51234', 5.5, 0, 70000, NaN, null, undefined]) assert.equal(peerOf1(() => bad), '-', `${String(bad)} must read peer=-`);
  assert.equal(peerOf1(() => { throw new Error('socket gone'); }), '-');
});

test('C10 real REST + executor: two clients on two sockets log two different peer= values; a reused keep-alive socket logs the same value twice', { skip: SKIP, timeout: 300000 }, async () => {
  const http = await import('node:http');
  const exec = await startExecutor({ store: tmpStore('emc10-'), datasetId: 'emc10-test', create: true });
  const env = { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: 'emc10-test', SCRUM_GRAPH_EXECUTOR_URL: exec.baseUrl, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_UNIT_CARDS: '1', SCRUM_EXECUTOR_METER_MS: '300', SCRUM_EXECUTOR_METER_SLOW_MS: '0' };
  const rest = await startRestServer({ board: makeBoardFixture(), env });
  const get = (agent, ua) => new Promise((res, rej) => { const u = new URL(`${rest.baseUrl}/api/cards`); const q = http.get({ host: u.hostname, port: u.port, path: u.pathname, agent, headers: { 'user-agent': ua } }, (r) => { r.resume(); r.on('end', () => res(r.statusCode)); }); q.on('error', rej); });
  const agentA = new http.Agent({ keepAlive: true, maxSockets: 1 }); const agentB = new http.Agent({ keepAlive: true, maxSockets: 1 });
  try {
    assert.ok(await rest.waitForStderr(/#1570 executor meter ON/, 10000));
    assert.equal(await get(agentA, 'PeerA/1'), 200); assert.equal(await get(agentA, 'PeerA/1'), 200); assert.equal(await get(agentB, 'PeerB/1'), 200);
    await new Promise((r) => setTimeout(r, 600));
    const lines = rest.stderr().split('\n').filter((l) => /executor-meter slow: /.test(l));
    const peers = (ua) => [...new Set(lines.filter((l) => l.includes(` caller=${ua} `)).map((l) => /\bpeer=(\S+)/.exec(l)?.[1]))];
    const a = peers('PeerA/1'); const b = peers('PeerB/1');
    assert.equal(a.length, 1, `the reused keep-alive socket logs ONE peer value (${a.join(',')})`); assert.equal(b.length, 1);
    assert.match(a[0], /^[0-9]{1,5}$/); assert.match(b[0], /^[0-9]{1,5}$/); assert.notEqual(a[0], b[0], 'two sockets, two peer values');
  } finally { agentA.destroy(); agentB.destroy(); await rest.stop(); await killExecutor(exec); }
});
