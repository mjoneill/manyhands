/**
 * #1574 gate 12 ADDENDUM 2 — the publisher RETAINS the reason a pending answer carried. For a publisher-mode entry on a CLEAN unmigrated board the
 * board answers `200 {status:'pending', reason:'POST_SEQ_MIGRATION_REQUIRED'}` and changes nothing (the reason is response-only by design). The entry
 * on the board therefore shows no sign of why it is stuck, so the ONLY durable trace is the publisher's own status file. Pinned in review:
 *   D1 after a scan, `backoff[<id>].reason` contains POST_SEQ_MIGRATION_REQUIRED; the attempt is a failed attempt for backoff but NOT a publishError
 *      (`publishErrors` 0, `lastError` null), and the board entry is unchanged and still pending; the executor stand-in was never contacted.
 *   D2 (control, so D1 cannot pass by recording every reason the same way) a MIGRATED board whose executor stand-in fails: the retained reason is
 *      the executor's, not the migration one. Copy beside the frozen gate-12 file in tests/; it is untouched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeBoardFixture, startRestServer } from './helpers/harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLISHER = process.env.PUBLISHER_SCRIPT || path.join(HERE, '..', 'scripts', 'announce-publisher.mjs');

// ---- copied from C3b (not imported)
async function api(base, method, route, body, { signal } = {}) {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: signal || AbortSignal.timeout(10000) });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text };
}
const outboxOf = async (base) => { const r = await api(base, 'GET', '/api/outbox'); assert.equal(r.status, 200, `GET /api/outbox: ${r.status} ${r.text}`); return r.body; };
const entryOf = async (base, id) => (await outboxOf(base)).entries.find((e) => e.obligationId === id);
const statusOf = async (base, id) => (await entryOf(base, id))?.status;

const T0 = '2026-10-04T12:00:00.000Z';
const payloadOf = (mut, slot, body, at = T0) => ({ author: 'board', body, mentions: [], notify: true, occurredAt: at, originActor: 'ada', origin: { cardId: 'c1', version: 2 }, mutationId: mut, slot });
const originOf = (mut, mode, slots = ['claim']) => ({ mutationId: mut, slots, origin: { cardId: 'c1', version: 2 }, committedAt: T0, occurredAt: T0, originActor: 'ada', ...(mode ? { mode } : {}) });
const entryFor = (mut, mode, extra = {}, { slot = 'claim', body = `claimed ${mut}`, at = T0 } = {}) => ({ obligationId: `${mut}:${slot}`, mutationId: mut, slot, status: 'pending', ...(mode ? { mode } : {}), payload: payloadOf(mut, slot, body, at), ...extra });
const legacyPost = (id, mut, extra = {}) => ({ id, body: `claimed ${mut}`, author: 'board', attachedTo: null, attachments: [], mentions: [], createdAt: T0, origin: { mutationId: mut, slot: 'claim' }, ...extra });
function seeded(items, conversations = []) {
  return makeBoardFixture({
    announcementOutbox: { origins: Object.fromEntries(items.map((i) => [i.o.mutationId, i.o])), entries: Object.fromEntries(items.map((i) => [i.e.obligationId, i.e])) },
    conversations,
  });
}
const item = (mut, mode, { entry = {}, origin = {}, ...rest } = {}) => ({ o: { ...originOf(mut, mode), ...origin }, e: { ...entryFor(mut, mode, entry, rest) } });
const withServer = async (board, env, body) => { const s = await startRestServer({ board, env }); try { return await body(s); } finally { await s.stop(); } };
// the server refuses to build the graph slice without a dataset id when an executor URL is set (#1567 fencing)
const FLAG = { SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_DATASET_ID: 'g12-test' };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'g12-pub-'));
const at = (iso, ms) => new Date(Date.parse(iso) + ms).toISOString();
const MIN = 60_000, HOUR = 3_600_000;
// A fixed injected instant, deliberately far from the wall clock: a fix that mixes wall time into backoff shows up.
const NOW0 = '2031-01-01T00:00:00.000Z';

// ---- new helpers (gate 12)

/**
 * The publisher, ASYNCHRONOUSLY. (C3b's runPublisher uses spawnSync, which blocks this process's event loop; the proxy
 * and the executor stand-in below live in this process, so a sync spawn would deadlock them until the 15 s fetch
 * timeout.) Reusing `dir` reuses the key file AND the status file, which is where backoff state persists.
 */
function runPublisher(base, dir, extra = []) {
  const key = path.join(dir, 'board.key'); fs.writeFileSync(key, 'sk-test-not-a-secret', { mode: 0o600 });
  const status = path.join(dir, 'publisher-status.json');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [PUBLISHER, '--board', base, '--key-file', key, '--status', status, '--once', ...extra], { stdio: ['ignore', 'ignore', 'pipe'] });
    const err = []; child.stderr.on('data', (d) => err.push(String(d)));
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 30000);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      let st = null; try { st = JSON.parse(fs.readFileSync(status, 'utf8')); } catch { /* none */ }
      resolve({ code, signal, err: err.join(''), status: st });
    });
  });
}

/**
 * A pass-through proxy in front of the board. It logs every POST /api/outbox/:id/publish (decoded id), and answers 500
 * itself — WITHOUT forwarding — for ids in `failIds`, or for every id NOT in `failAllExcept` when that is set.
 * Everything else (the outbox reads included) is forwarded unchanged.
 */
async function startProxy(targetBase) {
  const target = new URL(targetBase);
  const p = { log: [], failIds: new Set(), failAllExcept: null, failOutboxRead: false };
  p.server = http.createServer((req, res) => {
    const chunks = []; req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (p.failOutboxRead && req.method === 'GET' && req.url.split('?')[0] === '/api/outbox') {
        res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"error":"proxy-injected listing failure"}'); return;
      }
      const m = /^\/api\/outbox\/([^/?]+)\/publish$/.exec(req.url.split('?')[0]);
      if (req.method === 'POST' && m) {
        const id = decodeURIComponent(m[1]);
        const fail = p.failIds.has(id) || (p.failAllExcept !== null && !p.failAllExcept.has(id));
        p.log.push({ id, injected500: fail });
        if (fail) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":"proxy-injected failure"}'); return; }
      }
      const up = http.request({ hostname: target.hostname, port: target.port, method: req.method, path: req.url, headers: { ...req.headers, host: target.host } }, (ur) => { res.writeHead(ur.statusCode, ur.headers); ur.pipe(res); });
      up.on('error', (e) => { res.writeHead(502); res.end(String(e.message)); });
      up.end(Buffer.concat(chunks));
    });
  });
  await new Promise((r) => p.server.listen(0, '127.0.0.1', r));
  p.base = `http://127.0.0.1:${p.server.address().port}`;
  p.mark = () => p.log.length;
  p.since = (mark) => p.log.slice(mark).map((x) => x.id);
  p.stop = () => new Promise((r) => { p.server.closeAllConnections?.(); p.server.close(() => r()); });
  return p;
}
const withProxy = async (base, body) => { const p = await startProxy(base); try { return await body(p); } finally { await p.stop(); } };

/** One scan through the proxy; returns the run and the ids it POSTed /publish for, in order. */
async function scanVia(proxy, dir, extra = []) {
  const mark = proxy.mark();
  const run = await runPublisher(proxy.base, dir, extra);
  return { ...run, calls: proxy.since(mark) };
}
/** A COMPLETED scan: exit 0 even when entries failed (EXIT pin). */
const assertRan = (run, label) => {
  assert.equal(run.signal, null, `${label}: killed by ${run.signal}: ${run.err}`);
  assert.equal(run.code, 0, `${label}: exit ${run.code} (0 expected: a completed scan exits 0 even when entries failed; 1 = listing failed, 2 = argument rejected): ${run.err}`);
  assert.ok(run.status && typeof run.status === 'object', `${label}: no status file written`);
};

const EPOCH = '11111111-2222-4333-8444-555555555555';
const unnumbered = (n) => Array.from({ length: n }, (_, i) => legacyPost(`d${i + 1}`, `m-doc${i + 1}`));
const numbered = (n) => unnumbered(n).map((p, i) => ({ ...p, postSeq: i + 1 }));
async function standIn() {
  const seen = [];
  const srv = http.createServer((req, res) => { seen.push(`${req.method} ${req.url}`); req.resume(); res.statusCode = 500; res.setHeader('Content-Type', 'application/json'); res.end('{"error":"stand-in failure"}'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { seen, url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }) };
}
test('D1 a pending answer for a CLEAN unmigrated board: the reason is kept in the status file\'s backoff record, it is not a publishError and sets no lastError, the entry is unchanged and still pending, the executor was never contacted', async () => {
  const exec = await standIn();
  try {
    const board = seeded([item('m-p', 'publisher')], unnumbered(2));
    await withServer(board, { ...FLAG, SCRUM_GRAPH_EXECUTOR_URL: exec.url }, (s) => withProxy(s.baseUrl, async (proxy) => {
      const before = await entryOf(s.baseUrl, 'm-p:claim');
      const r = await scanVia(proxy, tmp());
      assertRan(r, 'scan');
      assert.deepEqual(r.calls, ['m-p:claim'], 'the entry was attempted');
      const rec = r.status.backoff?.['m-p:claim'];
      assert.ok(rec, `the entry is in backoff: ${JSON.stringify(r.status.backoff)}`);
      assert.match(String(rec.reason), /POST_SEQ_MIGRATION_REQUIRED/, `the retained reason must name the cause: ${JSON.stringify(rec)}`);
      assert.equal(r.status.publishErrors, 0, 'a pending answer is a failed attempt for backoff but not a publishError');
      assert.equal(r.status.lastError ?? null, null, 'and it sets no lastError');
      assert.deepEqual(await entryOf(s.baseUrl, 'm-p:claim'), before, 'the board entry is byte-for-byte unchanged: the reason is response-only');
      assert.equal((await entryOf(s.baseUrl, 'm-p:claim')).status, 'pending');
      assert.deepEqual(exec.seen, [], 'the executor stand-in was never contacted');
    }));
  } finally { await exec.close(); }
});
test('D2 (control) a MIGRATED board whose executor stand-in fails: the retained reason is the executor\'s, NOT the migration reason, and the stand-in WAS contacted', async () => {
  const exec = await standIn();
  try {
    const board = { ...seeded([item('m-p', 'publisher')], numbered(2)), postSeqEpoch: EPOCH, nextPostSeq: 3 };
    await withServer(board, { ...FLAG, SCRUM_GRAPH_EXECUTOR_URL: exec.url }, (s) => withProxy(s.baseUrl, async (proxy) => {
      const r = await scanVia(proxy, tmp());
      assertRan(r, 'scan');
      const rec = r.status.backoff?.['m-p:claim'];
      assert.ok(rec, JSON.stringify(r.status.backoff));
      assert.doesNotMatch(String(rec.reason), /POST_SEQ_MIGRATION_REQUIRED/);
      assert.match(String(rec.reason), /executor|pending/i, `the executor-side reason is retained: ${JSON.stringify(rec)}`);
      assert.ok(exec.seen.length >= 1, 'the stand-in was contacted: the board really reserved and called out');
    }));
  } finally { await exec.close(); }
});
