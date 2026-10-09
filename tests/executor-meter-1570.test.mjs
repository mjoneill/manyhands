/**
 * #1570 (2026-10-07 16:2xZ) — card and post reads failed with "no answer within 3000 ms" while the executor's own log shows
 * the same queries finishing in under 70 ms, and a static file from REST took 3.1 s. The meter records both sides in one
 * line a minute, so a 503 can be lined up against a measured stall. Builder's rows:
 *   EM1 the meter counts calls by label / kind / outcome / route, reports loop delay, and a slow call's line carries the
 *       body's sha256 prefix, never the body.
 *   EM2 the graph client reports every call to the meter: kind from the path, outcome = the HTTP status, 'timeout' on its
 *       own abort, 'refused' on ECONNREFUSED. No meter set → nothing is recorded and nothing changes.
 *   EM3 a read QUEUED behind the gate is metered under its OWN caller's route, not the route of the read that freed the slot.
 *   EM4 real REST + real executor: a card read shows up as a cards/query/200 entry under the card route, and no meter line
 *       contains query text.
 *   EM5 a graph 503 is logged as one "executor-meter 503:" line with its code; SCRUM_EXECUTOR_METER=0 → no meter lines.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createExecutorMeter, createKeepAlive } from '../core/executor-meter.mjs';
import { createGraphClient, setExecutorMeter } from '../core/graph-client.mjs';
import { createReadGate } from '../core/read-admission.mjs';
import { makeBoardFixture, startRestServer } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const ROSTER_FILE = path.join(os.tmpdir(), `em1570-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
const SECRET = 'SELECT ?s WHERE { ?s ?p "a card body nobody should see in a log" }';

test('EM1 the meter: counts by label/kind/outcome/route, loop delay, slow calls by hash only', () => {
  const lines = [];
  let route = 'GET ^\\/api\\/cards$';
  const m = createExecutorMeter({ routeOf: () => route, slowMs: 100, log: (l) => lines.push(l), extras: () => 'readGate={"running":1}' });
  m.record({ label: 'cards', kind: 'query', outcome: '200', elapsedMs: 5, body: 'x' });
  m.record({ label: 'cards', kind: 'query', outcome: '200', elapsedMs: 7, body: 'y' });
  route = 'background';
  m.record({ label: 'posts', kind: 'query', outcome: 'timeout', elapsedMs: 250, body: SECRET });
  const slow = lines.filter((l) => /executor-meter slow:/.test(l));
  assert.equal(slow.length, 1, 'only the call over slowMs gets its own line');
  assert.match(slow[0], /250ms label=posts kind=query outcome=timeout route=background rid=- caller=- peer=- body=[0-9a-f]{16}$/);
  const minute = m.flush();
  assert.match(minute, /executor-meter minute: calls=3 /);
  assert.match(minute, /cards\/query\/200@GET \^\\\/api\\\/cards\$ n=2 total=12ms max=7ms/);
  assert.match(minute, /posts\/query\/timeout@background n=1 total=250ms max=250ms/);
  assert.match(minute, /loopDelayMs\(res=20\)=/);
  assert.match(minute, /readGate=\{"running":1\}/);
  for (const l of lines) assert.ok(!l.includes('SELECT') && !l.includes('nobody should see'), `no query text in a meter line: ${l}`);
  assert.match(m.flush(), /calls=0 /, 'flush resets the minute');
  m.stop();
});

test('EM2 the graph client reports every call; none without a meter', async () => {
  const seen = [];
  const fake = async (u, opts) => {
    if (String(u).endsWith('/hang')) return new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    return { status: 200, text: async () => JSON.stringify({ head: { vars: ['x'] }, results: { bindings: [] } }) };
  };
  try {
    setExecutorMeter({ record: (r) => seen.push(r) });
    const c = createGraphClient({ baseUrl: 'http://example.invalid', fetchImpl: fake, label: 'cards', timeoutMs: 50 });
    assert.equal((await c.query('SELECT ?x WHERE { BIND(1 AS ?x) }')).ok, true);
    assert.deepEqual({ label: seen[0].label, kind: seen[0].kind, outcome: seen[0].outcome }, { label: 'cards', kind: 'query', outcome: '200' });
    assert.ok(seen[0].elapsedMs >= 0);
    const hang = createGraphClient({ baseUrl: 'http://example.invalid', fetchImpl: (u, o) => fake(`${u}/hang`, o), label: 'posts', timeoutMs: 30 });
    assert.equal((await hang.query('SELECT ?x WHERE { BIND(1 AS ?x) }')).ok, false);
    assert.equal(seen[1].outcome, 'timeout', 'its own abort is a timeout');
    const refused = createGraphClient({ baseUrl: 'http://example.invalid', fetchImpl: async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }, label: 'x' });
    await refused.query('SELECT ?x WHERE { BIND(1 AS ?x) }');
    assert.equal(seen[2].outcome, 'refused');
    setExecutorMeter(null);
    await c.query('SELECT ?x WHERE { BIND(1 AS ?x) }');
    assert.equal(seen.length, 3, 'no meter set: nothing recorded');
  } finally { setExecutorMeter(null); }
});

test('EM3 a queued read is metered under its own caller, not the read that freed the slot', async () => {
  const ctx = new AsyncLocalStorage();
  const routes = [];
  let release;
  const client = { query: (q) => { routes.push({ q, route: ctx.getStore() }); return q === 'A' ? new Promise((r) => { release = () => r({ ok: true, rows: [] }); }) : Promise.resolve({ ok: true, rows: [] }); } };
  const gate = createReadGate({ max: 1, queueMax: 4 });
  const reader = gate.reader(client, 5000);
  const a = ctx.run('route-A', () => reader.query('A'));
  const b = ctx.run('route-B', () => reader.query('B'));   // queued behind A
  assert.equal(routes.length, 1, 'B waits for the slot');
  ctx.run('route-A', () => release());   // A's answer frees the slot and starts B from A's side
  await Promise.all([a, b]);
  assert.deepEqual(routes, [{ q: 'A', route: 'route-A' }, { q: 'B', route: 'route-B' }]);
});

test('EM4 real REST + executor: a card read is metered under its route; no query text in any meter line', { skip: SKIP, timeout: 300000 }, async () => {
  const exec = await startExecutor({ store: tmpStore('em-'), datasetId: 'em-test', create: true });
  const env = { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: 'em-test', SCRUM_GRAPH_EXECUTOR_URL: exec.baseUrl, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_UNIT_CARDS: '1', SCRUM_EXECUTOR_METER_MS: '300', SCRUM_EXECUTOR_METER_SLOW_MS: '0' };
  const rest = await startRestServer({ board: makeBoardFixture(), env });
  try {
    assert.ok(await rest.waitForStderr(/#1570 executor meter ON/, 10000), 'the meter announces itself');
    const r = await fetch(`${rest.baseUrl}/api/cards`, { signal: AbortSignal.timeout(30000) });
    assert.equal(r.status, 200);
    assert.ok(await rest.waitForStderr(/executor-meter minute: .*cards\/query\/200@GET \^\\\/api\\\/cards/, 10000), `a cards/query entry under the card route (${rest.stderr().split('\n').filter((l) => /executor-meter/.test(l)).slice(-3).join(' || ')})`);
    const meterLines = rest.stderr().split('\n').filter((l) => /executor-meter/.test(l));
    assert.ok(meterLines.some((l) => /executor-meter slow: .* body=[0-9a-f]{16}$/.test(l)), 'slow-call lines carry a body hash');
    for (const l of meterLines) assert.ok(!/SELECT|WHERE \{/.test(l), `no query text: ${l.slice(0, 200)}`);
  } finally { await rest.stop(); await killExecutor(exec); }
});

test('EM5 a graph 503 is one "executor-meter 503:" line; SCRUM_EXECUTOR_METER=0 means no meter', { skip: SKIP, timeout: 300000 }, async () => {
  const exec = await startExecutor({ store: tmpStore('em5-'), datasetId: 'em5-test', create: true });
  const env = { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: 'em5-test', SCRUM_GRAPH_EXECUTOR_URL: exec.baseUrl, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_EXECUTOR_METER_MS: '300' };
  const rest = await startRestServer({ board: makeBoardFixture(), env });
  try {
    await killExecutor(exec);
    const r = await fetch(`${rest.baseUrl}/api/conversations/00000000-0000-0000-0000-000000000001`, { signal: AbortSignal.timeout(30000) });
    assert.equal(r.status, 503, 'CONTROL: the post read cannot reach the graph');
    const code = (await r.json()).code;
    assert.ok(await rest.waitForStderr(new RegExp(`executor-meter 503: code=${code} route=GET `), 5000), `the 503 is logged with its code (${code})`);
  } finally { await rest.stop(); }
  const exec2 = await startExecutor({ store: tmpStore('em5b-'), datasetId: 'em5b-test', create: true });
  const off = await startRestServer({ board: makeBoardFixture(), env: { ...env, SCRUM_GRAPH_DATASET_ID: 'em5b-test', SCRUM_GRAPH_EXECUTOR_URL: exec2.baseUrl, SCRUM_EXECUTOR_METER: '0' } });
  try {
    await fetch(`${off.baseUrl}/api/conversations?limit=1`, { signal: AbortSignal.timeout(30000) });
    await new Promise((r) => setTimeout(r, 900));
    assert.ok(!/executor-meter|#1570 executor meter ON/.test(off.stderr()), 'off means off');
  } finally { await off.stop(); await killExecutor(exec2); }
});

test('EM6 the daily keep-alive: the summary counts the day and says how to turn it off; REST posts it to the board as "board"', { skip: SKIP, timeout: 300000 }, async () => {
  const m = createExecutorMeter({ slowMs: 100, log: () => {} });
  m.record({ label: 'cards', kind: 'query', outcome: '200', elapsedMs: 5 });
  m.record({ label: 'posts', kind: 'query', outcome: 'timeout', elapsedMs: 250 });
  m.unavailable('GRAPH_UNAVAILABLE');
  const { text, snap } = m.prepareDaily({ pid: 4242 });
  assert.match(text, /executor meter is still running in REST \(pid 4242\)/);
  assert.match(text, /2 executor calls, 1 slow \(>= 100 ms\), 1 graph-unavailable 503s/);
  assert.match(text, /To turn it off: set SCRUM_EXECUTOR_METER=0/);
  m.record({ label: 'cards', kind: 'query', outcome: '200', elapsedMs: 5 });   // arrives between prepare and ack
  m.ackDaily(snap);
  assert.match(m.prepareDaily().text, / 1 executor calls, 0 slow/, 'the ack subtracts exactly what was reported; a later call survives');
  m.stop();
  const exec = await startExecutor({ store: tmpStore('em6-'), datasetId: 'em6-test', create: true });
  const env = { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: 'em6-test', SCRUM_GRAPH_EXECUTOR_URL: exec.baseUrl, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_EXECUTOR_METER_FIRST_POST_MS: '500', SCRUM_EXECUTOR_METER_DAILY_MS: '600000' };
  const rest = await startRestServer({ board: makeBoardFixture(), env });
  try {
    let post = null;
    for (let i = 0; i < 60 && !post; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const list = await (await fetch(`${rest.baseUrl}/api/conversations?limit=20`, { signal: AbortSignal.timeout(30000) })).json();
      post = (Array.isArray(list) ? list : list.conversations || []).find((c) => /#1570 executor meter is still running/.test(c.body || ''));
    }
    assert.ok(post, `the keep-alive reached the board (${rest.stderr().split('\n').filter((l) => /keep-alive/.test(l)).join(' | ')})`);
    assert.equal(post.author, 'board');
  } finally { await rest.stop(); await killExecutor(exec); }
});

// A delay histogram the test controls: the accounting is what EM7 tests, not node's sampler.
function fakeLoop() {
  const h = { max: 0, count: 0, enable() {}, disable() {}, reset() { h.max = 0; h.count = 0; }, percentile() { return h.max; }, stall(ms) { h.max = Math.max(h.max, ms * 1e6); h.count += 1; } };
  return h;
}

test('EM7 a keep-alive that fails is retried with the SAME text and requestId, and the day is reset only after confirmed delivery', async () => {
  const loop = fakeLoop();
  loop.stall(20);   // before the snapshot: belongs to the first post
  const m = createExecutorMeter({ slowMs: 100, log: () => {}, loopFactory: () => loop });
  m.record({ label: 'cards', kind: 'query', outcome: '200', elapsedMs: 5 });
  const sent = [];
  let answer = [false, 'throw', true];
  const timers = [];
  const ka = createKeepAlive({
    meter: m, retryMs: 1, log: () => {}, newId: () => 'req-00000001', setTimer: (fn) => timers.push(fn),
    post: async (text, requestId) => { sent.push({ text, requestId }); const a = answer.shift(); if (a === 'throw') throw new Error('connection reset'); return a; },
  });
  assert.equal(await ka.fire(), false, 'a refusal is not delivery');
  assert.ok(ka.pending(), 'the summary is kept');
  m.record({ label: 'posts', kind: 'query', outcome: '200', elapsedMs: 5 });   // keeps counting meanwhile
  assert.equal(await timers.shift()(), false, 'a thrown post is not delivery either');
  loop.stall(150);   // a 150 ms stall AFTER the snapshot, during the retries
  m.flush();         // the minute line takes it out of the histogram, as it does in production, before delivery is confirmed
  assert.equal(await timers.shift()(), true, 'the third attempt is confirmed');
  assert.equal(sent.length, 3);
  assert.ok(sent.every((x) => x.requestId === 'req-00000001' && x.text === sent[0].text), 'every retry is the same post');
  assert.match(sent[0].text, / 1 executor calls,/);
  assert.equal(ka.pending(), null);
  const next = m.prepareDaily().text;
  assert.match(next, / 1 executor calls,/, 'only the reported call was subtracted; the one made during the retries remains');
  const peak = Number(/worst event-loop delay (\d+) ms/.exec(next)[1]);
  assert.equal(peak, 150, `the 150 ms stall during the retries survives the ack (${peak} ms)`);
  assert.equal(Number(/worst event-loop delay (\d+) ms/.exec(sent[0].text)[1]), 20, 'and the acknowledged post reported only the stall before its snapshot');
  m.stop();
});

test('EM8 a slow call and the 503 it caused carry the SAME server-generated request id', { skip: SKIP, timeout: 300000 }, async () => {
  const exec = await startExecutor({ store: tmpStore('em8-'), datasetId: 'em8-test', create: true });
  const env = { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: 'em8-test', SCRUM_GRAPH_EXECUTOR_URL: exec.baseUrl, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_EXECUTOR_METER_SLOW_MS: '0' };
  const rest = await startRestServer({ board: makeBoardFixture(), env });
  try {
    await killExecutor(exec);
    const r = await fetch(`${rest.baseUrl}/api/conversations/00000000-0000-0000-0000-000000000002`, { signal: AbortSignal.timeout(30000) });
    assert.equal(r.status, 503, 'CONTROL: the read fails');
    assert.ok(await rest.waitForStderr(/executor-meter 503: .* rid=[0-9a-f-]{36} /, 5000), 'the 503 line names its request');
    const rid = /executor-meter 503: .* rid=([0-9a-f-]{36}) /.exec(rest.stderr())[1];
    const slow = rest.stderr().split('\n').filter((l) => /executor-meter slow: /.test(l) && l.includes(`rid=${rid}`));
    assert.ok(slow.length >= 1, `the executor call made for that request carries the same rid (${rid})`);
    assert.ok(!/executor-meter minute: .*[0-9a-f]{8}-[0-9a-f]{4}-/.test(rest.stderr()), 'request ids never enter the aggregate buckets');
  } finally { await rest.stop(); }
});
