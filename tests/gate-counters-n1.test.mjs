/**
 * THE READ GATE IS VISIBLE (#1574 attempt 3, the gate counters; the board's own proposal at 03:18Z: `GET /api/health` gains a `readGate` object `{running, lost, waiting, max, queueMax}` taken from
 * the gate's own stats, present only when the conversations unit is on and `null` with the flag off, "never a fabricated zero"). Written by the separate test author, before the build.
 * Tonight's two rollbacks were each argued from an INFERRED gate state ("full" because a read recovered); nobody could read the gate. These rows check the counters against the SAME hold
 * proxy as the admission rows, so what the gate reports is compared with what the executor is actually doing, not trusted.
 *
 *   N1 OFF      With the unit off (no executor), `/api/health` carries the key `readGate` and its value is null: not absent, and not a zero.
 *   N2 IDLE     With the unit on and nothing running: `readGate` is exactly {running: 0, lost: 0, waiting: 0, max: C, queueMax: Q}, C and Q being the build's declared numbers (a TODO until
 *               declared: ADMISSION_CAP, ADMISSION_QUEUE).
 *   N3 FLOOD    The executor is held 10 s and 60 distinct reads arrive. At 1.5 s `/api/health` ANSWERS (200, under 1 s: the instrument is readable while the gate is saturated), and the gate's
 *               `running` equals the executor's outstanding queries as the proxy counts them, never exceeds C, and `waiting` is above zero. After every caller is gone and the executor has
 *               answered, `running`, `waiting` and `lost` are all 0.
 *   N4 LOST     The executor is held 4 s and the caller's connection is dropped 300 ms after dispatch (a single post read by id): the read is refused, `lost` equals the number of queries that were
 *               dispatched for it (at least 1) and each lost slot REMAINS COUNTED IN `running` (`lost` is a subset of `running`, as the contract owner read the gate at caa4398), and both STAY that
 *               number after the executor has finished: a lost slot is cleared only by the recorded recovery (an executor restart, then REST), never by the proxy draining. `waiting` is 0.
 *
 * REAL executor behind the hold proxy, REAL REST; without a python with pyoxigraph every test is SKIPPED, and a skip is NOT a pass. Synthetic content only.
 * NOT COVERED, by name: event-loop lag (proposed beside the counters, not specified yet); the counters of any gate other than the posts gate; the recovery sequence itself (executor restart, then REST) and what clears a lost slot; the route's other fields; authentication of the route; whether the numbers are right under the live executor's real behaviour.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { createGraphClient } from '../core/graph-client.mjs';
import { makeBoardFixture, startRestServer } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const DSID = 'adm-test';
const EPOCH_DOC = '11111111-2222-4333-8444-555555555555';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CAP = Number(process.env.ADMISSION_CAP); const QUEUE = Number(process.env.ADMISSION_QUEUE);
const DECLARED = Number.isInteger(CAP) && CAP > 0 && Number.isInteger(QUEUE) && QUEUE >= 0;
const NEEDS_DECLARATION = DECLARED ? false : 'cap C and queue bound Q are not declared yet (ADMISSION_CAP, ADMISSION_QUEUE): this row is a TODO, not a pass';
const needDeclared = () => { if (!DECLARED) assert.fail('cap C and queue bound Q are not declared (set ADMISSION_CAP and ADMISSION_QUEUE from the build\'s own declaration)'); };
const ROSTER_FILE = path.join(os.tmpdir(), `adm-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));

const call = async (base, method, route, body) => {
  const t0 = Date.now();
  try {
    const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) });
    const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
    return { status: res.status, body: json, text, ms: Date.now() - t0 };
  } catch (e) { return { status: 0, body: null, text: String(e.message), ms: Date.now() - t0 }; }
};
/** A forwarding proxy that models an executor which does NOT cancel abandoned queries. */
async function startHoldProxy(execUrl) {
  const p = { holdMs: 0, dropAfterMs: 0, eofAfterMs: 0, errorStatus: 0, outstanding: 0, peak: 0, received: 0, bodies: [], resetCounts() { p.peak = p.outstanding; p.received = 0; p.bodies = []; } };
  p.server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const buf = Buffer.concat(chunks);
    const isQ = req.method === 'POST' && req.url === '/query';
    req.socket.on('error', () => {});
    if (isQ) { p.received++; p.outstanding++; p.peak = Math.max(p.peak, p.outstanding); p.bodies.push(crypto.createHash('sha1').update(buf).digest('hex')); }
    if (isQ && p.dropAfterMs) setTimeout(() => { try { req.socket.destroy(); } catch { /* gone */ } }, p.dropAfterMs);   // the caller's connection is lost AFTER dispatch; the executor's work goes on
    if (isQ && p.errorStatus) { try { res.statusCode = p.errorStatus; res.end('{"error":"executor refused"}'); } catch { /* gone */ } p.outstanding--; return; }   // a COMPLETE answer: the executor's own error response
    if (isQ && p.eofAfterMs) setTimeout(() => { try { req.socket.write('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{"head":{"vars":['); req.socket.end(); } catch { /* gone */ } }, p.eofAfterMs);   // a premature EOF: a status line, a short body, NO length, then a clean close; the client reads a short body without any transport error
    try {
      if (isQ && p.holdMs) await sleep(p.holdMs);
      const fwd = { ...req.headers }; delete fwd.host; delete fwd['content-length']; delete fwd.connection;
      const f = await fetch(`${execUrl}${req.url}`, { method: req.method, headers: fwd, ...(req.method === 'POST' ? { body: buf } : {}) });
      const t = await f.text();
      try { res.statusCode = f.status; res.end(t); } catch { /* the caller left; the executor still did the work */ }
    } catch { try { req.socket.destroy(); } catch { /* gone */ } }
    finally { if (isQ) p.outstanding--; }
  });
  await new Promise((r) => p.server.listen(0, '127.0.0.1', r)); p.url = `http://127.0.0.1:${p.server.address().port}`;
  p.port = p.server.address().port;
  p.stop = () => new Promise((r) => { p.server.closeAllConnections?.(); p.server.close(() => r()); });
  /** the executor goes DOWN (nothing listens: a new connection is REFUSED) and comes back on the same port */
  p.down = () => p.stop();
  p.up = () => new Promise((r, j) => { p.server.once('error', j); p.server.listen(p.port, '127.0.0.1', r); });
  return p;
}
async function stack(body, extraEnv = {}) {
  const exec = await startExecutor({ store: tmpStore('adm-store-'), datasetId: DSID, create: true });
  const proxy = await startHoldProxy(exec.baseUrl);
  const rest = await startRestServer({ board: makeBoardFixture({ conversations: [], postSeqEpoch: EPOCH_DOC, nextPostSeq: 1 }), env: { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: DSID, SCRUM_GRAPH_EXECUTOR_URL: proxy.url, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', ...extraEnv } });
  try {
    const card = await call(rest.baseUrl, 'POST', '/api/cards', { title: 'admission card', description: 'x', createdBy: 'ada' });
    assert.ok(card.status === 200 || card.status === 201, card.text);
    for (let i = 0; i < 12; i++) { const w = await call(rest.baseUrl, 'POST', '/api/conversations', { author: 'ada', body: `admission post ${i}`, attachedTo: card.body.id }); assert.equal(w.status, 201, w.text); }
    const warm = await call(rest.baseUrl, 'GET', '/api/conversations?limit=10'); assert.equal(warm.status, 200, warm.text.slice(0, 200));   // the first reads after boot may do one-off work
    await sleep(300); proxy.resetCounts();
    return await body({ base: rest.baseUrl, proxy, cardId: card.body.id });
  } finally { await rest.stop(); await proxy.stop(); await killExecutor(exec); }
}
async function coldStack(body) {
  const exec = await startExecutor({ store: tmpStore('adm-cold-'), datasetId: DSID, create: true });
  const proxy = await startHoldProxy(exec.baseUrl);
  const docPosts = Array.from({ length: 300 }, (_, i) => ({ id: `adm-cold-${String(i + 1).padStart(3, '0')}`, body: `cold post ${i + 1}`, author: 'ada', attachedTo: null, attachments: [], mentions: [], postSeq: i + 1, createdAt: new Date(Date.UTC(2026, 6, 1) + (i + 1) * 60000).toISOString() }));
  const gc = createGraphClient({ baseUrl: exec.baseUrl, expectedDatasetId: DSID });
  const graphPosts = [...docPosts.slice(0, 100), ...Array.from({ length: 20 }, (_, i) => ({ ...docPosts[0], id: `adm-cold-g${i}`, body: `graph only ${i}`, postSeq: 301 + i }))];
  for (const p of graphPosts) { const r = await gc.update({ kind: 'post.import', opId: `urn:ex:op/backfill/${p.id}`, actor: 'https://scrumboard.local/person/board', post: { id: p.id, body: p.body, author: p.author, createdAt: p.createdAt, attachedTo: null, mentions: [], postSeq: p.postSeq } }); assert.equal(r.outcome, 'APPLIED', JSON.stringify(r)); }
  const rest = await startRestServer({ board: makeBoardFixture({ conversations: docPosts, postSeqEpoch: EPOCH_DOC, nextPostSeq: 321 }), env: { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: DSID, SCRUM_GRAPH_EXECUTOR_URL: proxy.url, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1' } });
  try { proxy.resetCounts(); return await body({ base: rest.baseUrl, proxy }); } finally { await rest.stop(); await proxy.stop(); await killExecutor(exec); }
}
let uniq = 0;
const distinctReads = (base, n, tag) => Array.from({ length: n }, () => call(base, 'GET', `/api/conversations?limit=10&author=${tag}-${++uniq}`));
async function until(fn, ms, step = 250) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(step); } return fn(); }


const health = async (base) => call(base, 'GET', '/api/health');

test('N1 OFF: with the unit off, /api/health carries the key readGate with the value null (not absent, not a fabricated zero)', { skip: SKIP, timeout: 120000 }, async () => {
  const rest = await startRestServer({ board: makeBoardFixture({ conversations: [] }), env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
  try {
    const h = await health(rest.baseUrl);
    assert.equal(h.status, 200, h.text.slice(0, 200));
    assert.ok(h.body && Object.prototype.hasOwnProperty.call(h.body, 'readGate'), `the key readGate is present (keys: ${Object.keys(h.body || {}).join(',')})`);
    assert.equal(h.body.readGate, null, 'and it is null with the flag off');
  } finally { await rest.stop(); }
});

test('N2 IDLE: with the unit on and nothing running, readGate is exactly {running 0, lost 0, waiting 0, max C, queueMax Q}', { skip: SKIP, todo: NEEDS_DECLARATION, timeout: 120000 }, async () => {
  needDeclared();
  await stack(async ({ base, proxy }) => {
    await until(() => proxy.outstanding === 0, 10000);
    const h = await health(base);
    assert.equal(h.status, 200, h.text.slice(0, 200));
    assert.deepEqual(h.body?.readGate, { running: 0, lost: 0, waiting: 0, max: CAP, queueMax: QUEUE });
  });
});

test('N3 FLOOD: under a held flood /api/health answers promptly, running equals the proxy\'s outstanding queries and never exceeds C, waiting is above zero; after the drain all are 0', { skip: SKIP, todo: NEEDS_DECLARATION, timeout: 180000 }, async () => {
  needDeclared();
  await stack(async ({ base, proxy }) => {
    proxy.holdMs = 10000; proxy.resetCounts();
    const flood = distinctReads(base, 60, 'n3');
    await sleep(1500);
    const outstanding = proxy.outstanding;
    const h = await health(base);
    assert.equal(h.status, 200, `the instrument is readable while the gate is saturated: ${h.status} ${h.text.slice(0, 150)}`);
    assert.ok(h.ms < 1000, `and prompt (${h.ms} ms)`);
    const g = h.body?.readGate;
    assert.ok(g && typeof g === 'object', `readGate is an object with the unit on: ${JSON.stringify(h.body?.readGate)}`);
    assert.ok(g.running <= CAP, `running ${g.running} never exceeds C=${CAP}`);
    assert.equal(g.running, outstanding, `the gate says ${g.running} running; the executor has ${outstanding} queries outstanding (counted at the proxy)`);
    assert.ok(g.waiting > 0, `a flood of 60 reads (about 120 queries) against ${CAP} slots leaves reads waiting: ${g.waiting}`);
    await Promise.all(flood);
    proxy.holdMs = 0; await until(() => proxy.outstanding === 0, 60000); await sleep(500);
    const after = (await health(base)).body?.readGate;
    assert.deepEqual({ running: after?.running, waiting: after?.waiting, lost: after?.lost }, { running: 0, waiting: 0, lost: 0 }, 'after every caller is gone and the executor has answered, the gate is empty');
  });
});

test('N4 LOST: a connection dropped after dispatch is counted in lost, which equals the queries dispatched for that read and stays after the executor finishes', { skip: SKIP, todo: NEEDS_DECLARATION, timeout: 180000 }, async () => {
  needDeclared();
  await stack(async ({ base, proxy }) => {
    const list = await call(base, 'GET', '/api/conversations?limit=1'); const id = list.body?.[0]?.id; assert.ok(id, 'CONTROL: a post to read by id');
    proxy.holdMs = 4000; proxy.dropAfterMs = 300; proxy.resetCounts();
    const r = await call(base, 'GET', `/api/conversations/${id}`);
    assert.equal(r.status, 503, `CONTROL: the read whose connection was dropped is refused: ${r.status} ${r.text.slice(0, 150)}`);
    const dispatched = proxy.received; assert.ok(dispatched >= 1, 'CONTROL: the query was dispatched');
    const g1 = (await health(base)).body?.readGate;
    assert.equal(g1?.lost, dispatched, `lost equals the ${dispatched} queries dispatched for the lost read: ${JSON.stringify(g1)}`);
    assert.equal(g1?.running, dispatched, `and every lost slot is still counted in running (lost is a subset of running): ${JSON.stringify(g1)}`);
    proxy.dropAfterMs = 0; await until(() => proxy.outstanding === 0, 30000); await sleep(500);
    const g2 = (await health(base)).body?.readGate;
    assert.equal(g2?.lost, dispatched, `and it STAYS after the executor has finished (a lost slot is cleared only by recovery): ${JSON.stringify(g2)}`);
    assert.equal(g2?.running, dispatched, `the lost slot is still held in running after the proxy drained: draining the executor does not clear admission state: ${JSON.stringify(g2)}`);
    assert.equal(g2?.waiting, 0);
  });
});
