/**
 * #1624 K13, WAKES, SECOND PASS: ORDER AND THE UNKNOWN WRITE. Written by the separate test author AFTER the first pass of wake rows (wake-graph-w1, sha 406c06cb…) went green on the build, because
 * a kill-check of that build with eight mutants left TWO alive, and each is a way to lose or mangle a wake:
 *   - M2 "newest-first order dropped" SURVIVED: three wakes 15 ms apart came back newest-first by the store's own luck. A list that returns the OLDEST two for `limit=2` is wrong data, and three rows cannot tell.
 *   - M5 "an UNKNOWN write counts as APPLIED" SURVIVED: the first pass can make the executor ABSENT (a 503), but never UNKNOWN (the request reached it and the answer was lost), which is the case where a 201 would be a lie.
 * These rows close both. Same shape as logborn-unknown-1561 (a fault-injecting proxy that arms ONE `/update`), through REST with a REAL executor, type-agnostic (the wake is found by a marker in its note). Synthetic content.
 * Without a python with pyoxigraph the rows are SKIPPED, and a skip is NOT a pass. `UNIT_ENV` is the same switch as the first pass.
 *
 *   W4  ORDER: twelve wakes created in sequence (more than any store's accidental order survives) list newest-first, `limit=3` is the three NEWEST, and `seat=` keeps newest-first.
 *   W5a APPLIED, REPLY LOST: the executor applied the write and the answer was dropped: the create answers 201, exactly ONE wake with that note exists, the proxy saw ONE `/update`, and the receipt was READ (the unit reconciled, it did not assume).
 *   W5b NEVER APPLIED, REQUEST LOST: the request was dropped before the executor: the receipt is ABSENT, the SAME opId is replayed once, the create answers 201, exactly ONE wake exists.
 *   W5c INDETERMINATE: the write is applied, the reply is lost AND the receipt cannot be read: the create answers 503 and NEVER a 201; afterwards the list holds at most ONE wake with that note (never two), and a later create works.
 *
 * NOT COVERED, by name: the document's wakes from before the switch; concurrency between two creates (wakes are append-only and unguarded, so there is nothing to race on but the count, which W5 pins per write); the order of two wakes in the
 * same millisecond; the MCP wake tools above REST.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { makeBoardFixture, startRestServer } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const UNIT_ENV = 'SCRUM_GRAPH_UNIT_SMALLKINDS';
const ROSTER_FILE = path.join(os.tmpdir(), `w2-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, gizmo: { name: 'Gizmo', glyph: 'g', color: '#c4a07c' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (base, method, route, body) => {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(40000) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text };
};
const MARK = (t) => `w2-${t}-${process.pid}-${Date.now().toString(36)}`;
const wake = (base, by, note) => api(base, 'POST', '/api/wakes', { by, note });
const listWakes = (base, q = '') => api(base, 'GET', `/api/wakes${q}`);

/** a proxy that forwards every request, except ONE armed `/update` (`drop-reply` | `drop-request`), and can fail the next N receipt reads */
async function startFaultProxy(execUrl) {
  const state = { armed: null, failReceipts: 0, receiptReads: 0, log: [] };
  const srv = http.createServer((req, res) => {
    const chunks = []; req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      const fault = req.url === '/update' ? state.armed : null; if (fault) state.armed = null;
      if (req.url === '/update') state.log.push({ op: req.headers['x-op-id'] ?? null, fault });
      if (req.url.startsWith('/receipt/')) { state.receiptReads += 1; if (state.failReceipts > 0) { state.failReceipts -= 1; req.socket.destroy(); return; } }
      if (fault === 'drop-request') { req.socket.destroy(); return; }
      const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !['host', 'connection', 'content-length'].includes(k)));
      try {
        const f = await fetch(`${execUrl}${req.url}`, { method: req.method, headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body });
        const t = await f.text();
        if (fault === 'drop-reply') { req.socket.destroy(); return; }   // the executor HAS answered: it applied
        res.writeHead(f.status, { 'content-type': f.headers.get('content-type') || 'application/json' }); res.end(t);
      } catch { try { req.socket.destroy(); } catch { /* gone */ } }
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { state, url: `http://127.0.0.1:${srv.address().port}`, close: () => { srv.closeAllConnections?.(); srv.close(); } };
}
async function unitOn(body, dsid = 'w2-test') {
  const exec = await startExecutor({ store: tmpStore('w2-store-'), datasetId: dsid, create: true });
  const proxy = await startFaultProxy(exec.baseUrl);
  const rest = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: dsid, SCRUM_GRAPH_EXECUTOR_URL: proxy.url, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', [UNIT_ENV]: '1' } });
  try { return await body({ base: rest.baseUrl, proxy, exec }); } finally { await rest.stop(); proxy.close(); await killExecutor(exec); }
}
const withNote = async (base, note) => ((await listWakes(base)).body ?? []).filter((w) => w.note === note);

test('W4 ORDER: twelve wakes list newest-first, limit=3 is the three NEWEST, and the seat filter keeps the order', { skip: SKIP, timeout: 240000 }, async () => {
  await unitOn(async ({ base }) => {
    const t = MARK('ord'); const notes = [];
    for (let i = 0; i < 12; i++) { const n = `${t} #${String(i).padStart(2, '0')}`; notes.push(n); assert.equal((await wake(base, i % 2 ? 'gizmo' : 'ada', n)).status, 201); await sleep(12); }
    const newest = [...notes].reverse();
    const all = ((await listWakes(base)).body ?? []).map((w) => w.note).filter((n) => n.startsWith(t));
    assert.deepEqual(all, newest, 'all twelve, newest first');
    const three = ((await listWakes(base, '?limit=3')).body ?? []).map((w) => w.note);
    assert.deepEqual(three, newest.slice(0, 3), 'limit=3 is the three NEWEST, not any three');
    const ada = ((await listWakes(base, '?seat=ada')).body ?? []).map((w) => w.note).filter((n) => n.startsWith(t));
    assert.deepEqual(ada, newest.filter((_, i) => (11 - i) % 2 === 0), 'the seat filter keeps newest-first');
  });
});

test('W5a APPLIED, REPLY LOST: 201, exactly one wake, one /update dispatched, and the receipt was READ', { skip: SKIP, timeout: 240000 }, async () => {
  await unitOn(async ({ base, proxy }) => {
    assert.equal((await wake(base, 'ada', MARK('warm'))).status, 201, 'CONTROL: the proxy path writes when no fault is armed');
    const m = MARK('applied-lost'); const n0 = proxy.state.log.length; const rr0 = proxy.state.receiptReads;
    proxy.state.armed = 'drop-reply';
    const w = await wake(base, 'ada', m);
    assert.equal(w.status, 201, `the executor applied it and the unit reconciled it: 201 (${w.status} ${w.text.slice(0, 160)})`);
    const sent = proxy.state.log.slice(n0);
    assert.equal(sent[0]?.fault, 'drop-reply', 'the fault was injected on THIS write');
    assert.equal(sent.length, 1, `the reconcile said APPLIED, so nothing was dispatched again: ${JSON.stringify(sent)}`);
    assert.ok(proxy.state.receiptReads > rr0, 'the unit READ the receipt (reconciled) rather than assuming');
    assert.equal((await withNote(base, m)).length, 1, 'exactly one wake');
  });
});

test('W5b NEVER APPLIED, REQUEST LOST: the receipt is ABSENT, the SAME opId is replayed once, 201, exactly one wake', { skip: SKIP, timeout: 240000 }, async () => {
  await unitOn(async ({ base, proxy }) => {
    assert.equal((await wake(base, 'ada', MARK('warm'))).status, 201, 'CONTROL: the proxy path writes when no fault is armed');
    const m = MARK('request-lost'); const n0 = proxy.state.log.length;
    proxy.state.armed = 'drop-request';
    const w = await wake(base, 'ada', m);
    assert.equal(w.status, 201, `the receipt was ABSENT so the write was replayed: 201 (${w.status} ${w.text.slice(0, 160)})`);
    const sent = proxy.state.log.slice(n0);
    assert.equal(sent.length, 2, `dropped, then replayed exactly once: ${JSON.stringify(sent)}`);
    assert.equal(sent[0].op, sent[1].op, 'the replay is the SAME intention (same opId), never a freshly minted one');
    assert.equal((await withNote(base, m)).length, 1, 'exactly one wake');
  });
});

test('W5c INDETERMINATE: applied, reply lost, receipt unreadable: 503 and NEVER a 201; at most one wake afterwards; a later create works', { skip: SKIP, timeout: 240000 }, async () => {
  await unitOn(async ({ base, proxy }) => {
    assert.equal((await wake(base, 'ada', MARK('warm'))).status, 201, 'CONTROL: the proxy path writes when no fault is armed');
    const m = MARK('indeterminate');
    proxy.state.armed = 'drop-reply'; proxy.state.failReceipts = 50;
    const w = await wake(base, 'ada', m);
    assert.equal(w.status, 503, `the unit cannot tell whether the wake landed, so it must not say 201 (${w.status} ${w.text.slice(0, 160)})`);
    proxy.state.failReceipts = 0;
    const held = await withNote(base, m);
    assert.ok(held.length <= 1, `never TWO wakes from one request (${held.length})`);
    const after = MARK('after'); assert.equal((await wake(base, 'ada', after)).status, 201, 'a later create works');
    assert.equal((await withNote(base, after)).length, 1, 'and lands once');
  });
});
