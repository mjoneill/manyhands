/**
 * #1775 — the publisher's AUDIT (the unfiltered GET /api/outbox survey, one executor read per stored origin) no longer
 * rides on every scan, and a failed audit never touches the scan.
 *   A1 two --once runs with --audit-every-ms 1 h: the first audits (one unfiltered read), the second does NOT (zero), and
 *      both report pendingCount / oldestPendingAt from the scan's own pending read; blockedCount is carried from the audit.
 *   A2 (control, so A1 cannot pass by never auditing) --audit-every-ms 0: every run makes exactly one unfiltered read.
 *   A3 the unfiltered read fails: the scan still ATTEMPTS AND SETTLES the entry, lastScanCompletedAt is set, lastError names the audit, and
 *      lastAuditAt stays null while lastAuditAttemptAt is set (so the next run does not retry it inside the interval).
 *   A4 the LOOP (#1775 done-when 3): with every unfiltered read failing, scans keep completing (scanCount rises) and a
 *      newly pending entry is still attempted; the audit is retried no more often than --audit-every-ms.
 */
import { test, after } from 'node:test';
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
// every temp dir this file makes is removed after the file (the suite's leak check refuses a new leak)
const madeDirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pub1775-')); madeDirs.push(d); return d; };
after(() => { for (const d of madeDirs) fs.rmSync(d, { recursive: true, force: true }); });
const at = (iso, ms) => new Date(Date.parse(iso) + ms).toISOString();
const MIN = 60_000, HOUR = 3_600_000;
// A fixed injected instant, deliberately far from the wall clock: a fix that mixes wall time into backoff shows up.
const NOW0 = '2031-01-01T00:00:00.000Z';


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


/** A pass-through proxy that COUNTS outbox reads by kind and can fail the unfiltered one. */
async function startProxy(targetBase) {
  const target = new URL(targetBase);
  const p = { unfiltered: 0, pending: 0, publishes: [], failUnfiltered: false };
  p.server = http.createServer((req, res) => {
    const chunks = []; req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const [route, qs = ''] = req.url.split('?');
      if (req.method === 'GET' && route === '/api/outbox') {
        if (qs === '') {
          p.unfiltered += 1;
          if (p.failUnfiltered) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"error":"proxy-injected survey failure"}'); return; }
        } else if (/(^|&)status=pending(&|$)/.test(qs)) p.pending += 1;
      }
      const m = /^\/api\/outbox\/([^/?]+)\/publish$/.exec(route);
      if (req.method === 'POST' && m) p.publishes.push(decodeURIComponent(m[1]));
      const up = http.request({ hostname: target.hostname, port: target.port, method: req.method, path: req.url, headers: { ...req.headers, host: target.host } }, (ur) => { res.writeHead(ur.statusCode, ur.headers); ur.pipe(res); });
      up.on('error', (e) => { res.writeHead(502); res.end(String(e.message)); });
      up.end(Buffer.concat(chunks));
    });
  });
  await new Promise((r) => p.server.listen(0, '127.0.0.1', r));
  p.base = `http://127.0.0.1:${p.server.address().port}`;
  p.stop = () => new Promise((r) => { p.server.closeAllConnections?.(); p.server.close(() => r()); });
  return p;
}
const withProxy = async (base, body) => { const p = await startProxy(base); try { return await body(p); } finally { await p.stop(); } };

/** g12c's executor stand-in: every call answers 500, so a publisher-mode entry stays PENDING on a clean board (D1). */
async function standIn() {
  const seen = [];
  const srv = http.createServer((req, res) => { seen.push(`${req.method} ${req.url}`); req.resume(); res.statusCode = 500; res.setHeader('Content-Type', 'application/json'); res.end('{"error":"stand-in failure"}'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { seen, url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }) };
}
const withBoard = async (board, body) => { const exec = await standIn(); try { return await withServer(board, { ...FLAG, SCRUM_GRAPH_EXECUTOR_URL: exec.url }, body); } finally { await exec.close(); } };
const HOUR_MS = String(3_600_000);
// an entry the board keeps PENDING on a clean unmigrated board (g12c D1), and one BLOCKED entry for the audit's count
const stuck = item('m-stuck', 'publisher', { at: at(T0, -5 * MIN) });
const blocked = item('m-blocked', 'publisher', { entry: { status: 'blocked' } });

test('A1 two --once runs, --audit-every-ms 1 h: the first audits (ONE unfiltered read), the second makes NONE, and both take pendingCount/oldestPendingAt from the scan; blockedCount is carried', async () => {
  const board = seeded([stuck, blocked]);
  await withBoard(board, (s) => withProxy(s.baseUrl, async (proxy) => {
    const dir = tmp();
    const r1 = await runPublisher(proxy.base, dir, ['--audit-every-ms', HOUR_MS]);
    assert.equal(r1.code, 0, `run 1 exit ${r1.code}: ${r1.err}`);
    assert.equal(proxy.unfiltered, 1, 'run 1 audits: one unfiltered read');
    assert.ok(proxy.pending >= 1, 'run 1 scans: the pending read');
    assert.equal(r1.status.pendingCount, 1, `pendingCount from the scan (${JSON.stringify(r1.status)})`);
    assert.equal(r1.status.oldestPendingAt, at(T0, -5 * MIN), 'oldestPendingAt from the scan');
    assert.equal(r1.status.blockedCount, 1, 'blockedCount from the audit');
    assert.ok(r1.status.lastAuditAt && r1.status.lastAuditAttemptAt, 'the audit is recorded as done');
    const r2 = await runPublisher(proxy.base, dir, ['--audit-every-ms', HOUR_MS]);
    assert.equal(r2.code, 0, `run 2 exit ${r2.code}: ${r2.err}`);
    assert.equal(proxy.unfiltered, 1, 'run 2 makes NO unfiltered read: the audit is not due');
    assert.ok(proxy.pending >= 2, 'run 2 still scans');
    assert.equal(r2.status.pendingCount, 1); assert.equal(r2.status.blockedCount, 1, 'blockedCount carried from the last audit');
    assert.equal(r2.status.lastAuditAt, r1.status.lastAuditAt, 'and the audit time is the one run 1 recorded');
  }));
});

test('A2 (control) --audit-every-ms 0: EVERY --once run makes exactly one unfiltered read', async () => {
  const board = seeded([stuck, blocked]);
  await withBoard(board, (s) => withProxy(s.baseUrl, async (proxy) => {
    const dir = tmp();
    for (let i = 1; i <= 3; i++) {
      const r = await runPublisher(proxy.base, dir, ['--audit-every-ms', '0']);
      assert.equal(r.code, 0, `run ${i}: ${r.err}`);
      assert.equal(proxy.unfiltered, i, `run ${i}: one more unfiltered read`);
    }
  }));
});

test('A3 the unfiltered read FAILS: the scan still settles the entry and completes, lastError names the audit, lastAuditAt stays null and lastAuditAttemptAt is set; the next run inside the interval does not retry it', async () => {
  const ok = item('m-ok', null);   // a legacy (non-publisher) entry: with no proof post the board settles it as blocked
  const board = seeded([ok]);
  await withBoard(board, (s) => withProxy(s.baseUrl, async (proxy) => {
    proxy.failUnfiltered = true;
    const dir = tmp();
    const r = await runPublisher(proxy.base, dir, ['--audit-every-ms', HOUR_MS]);
    assert.deepEqual(proxy.publishes, ['m-ok:claim'], 'the scan attempted the entry despite the failing audit');
    assert.notEqual(await statusOf(s.baseUrl, 'm-ok:claim'), 'pending', 'and the scan SETTLED it (blocked here: the fixture holds no legacy proof post; settled is the point, not the outcome)');
    assert.ok(r.status.lastScanCompletedAt, 'the scan completed');
    assert.match(String(r.status.lastError), /^audit: /, `lastError names the audit: ${r.status.lastError}`);
    assert.equal(r.status.lastAuditAt, null, 'no successful audit');
    assert.ok(r.status.lastAuditAttemptAt, 'but the attempt is recorded');
    assert.equal(r.code, 1, 'the run reports the failed listing (exit 1)');
    const before = proxy.unfiltered;
    await runPublisher(proxy.base, dir, ['--audit-every-ms', HOUR_MS]);
    assert.equal(proxy.unfiltered, before, 'a failed audit is not retried on the next run inside the interval');
  }));
});

test('A4 the LOOP with every unfiltered read failing: scans keep completing and a newly pending entry is attempted; the audit is attempted no more often than --audit-every-ms', async () => {
  const board = seeded([item('m-first', null)]);
  await withBoard(board, (s) => withProxy(s.baseUrl, async (proxy) => {
    proxy.failUnfiltered = true;
    const dir = tmp();
    const key = path.join(dir, 'board.key'); fs.writeFileSync(key, 'sk-test-not-a-secret', { mode: 0o600 });
    const status = path.join(dir, 'publisher-status.json');
    const child = spawn(process.execPath, [PUBLISHER, '--board', proxy.base, '--key-file', key, '--status', status, '--scan-every-ms', '200', '--audit-every-ms', '60000'], { stdio: ['ignore', 'ignore', 'ignore'] });
    try {
      const read = () => { try { return JSON.parse(fs.readFileSync(status, 'utf8')); } catch { return null; } };
      const until = async (pred, ms, label) => { const end = Date.now() + ms; for (;;) { const v = read(); if (v && pred(v)) return v; if (Date.now() > end) assert.fail(`${label}: ${JSON.stringify(v)}`); await new Promise((r) => setTimeout(r, 100)); } };
      await until((v) => v.scanCount >= 3, 10000, 'scans advance while the audit fails');
      assert.notEqual(await statusOf(s.baseUrl, 'm-first:claim'), 'pending', 'the first entry was settled by a scan');
      const created = await api(s.baseUrl, 'POST', '/api/cards', { title: 'card for a claim', column: 'backlog' });
      assert.ok(created.status === 201 || created.status === 200, `PRECONDITION: a card (${created.status})`);
      const claim = await api(s.baseUrl, 'POST', `/api/cards/${created.body.id}/claim`, { by: 'ada' });
      assert.ok(claim.status < 300, `PRECONDITION: a claim makes a new pending announcement (${claim.status} ${claim.text.slice(0, 200)})`);
      const mark = (read()?.scanCount ?? 0);
      await until((v) => v.scanCount >= mark + 3, 10000, 'scans keep advancing');
      assert.ok(proxy.publishes.length >= 2, `the new announcement was attempted too (${JSON.stringify(proxy.publishes)})`);
      assert.equal(proxy.unfiltered, 1, `the failing audit was attempted ONCE in this window, not on every loop tick (${proxy.unfiltered})`);
    } finally { child.kill('SIGTERM'); }
  }));
});

test('A5 (review of 439adb3) a MALFORMED pending entry, one with no string obligationId, is never published but still COUNTS in pendingCount, as the old survey counted it', async () => {
  const malformed = item('m-bad', 'publisher', { at: at(T0, -9 * MIN) });
  delete malformed.e.obligationId;   // keyed in the outbox, but the entry itself carries no obligationId
  const board = makeBoardFixture({
    announcementOutbox: {
      origins: { [stuck.o.mutationId]: stuck.o, [malformed.o.mutationId]: malformed.o },
      entries: { [stuck.e.obligationId]: stuck.e, 'm-bad:claim': malformed.e },
    },
  });
  await withBoard(board, (s) => withProxy(s.baseUrl, async (proxy) => {
    const listed = (await api(s.baseUrl, 'GET', '/api/outbox?status=pending')).body?.entries ?? [];
    assert.ok(listed.some((e) => e && typeof e.obligationId !== 'string'), `PRECONDITION: the board lists the malformed entry as pending (${JSON.stringify(listed).slice(0, 300)})`);
    // the FIRST run audits (no prior audit), and the survey's own count would mask the scan's; the SECOND run's audit is not
    // due (--audit-every-ms 1 h), so its pendingCount is the scan's alone (the 439adb3 review: A5 passed on that script otherwise)
    const dir = tmp();
    await runPublisher(proxy.base, dir, ['--audit-every-ms', HOUR_MS]);
    const before = proxy.unfiltered;
    const r = await runPublisher(proxy.base, dir, ['--audit-every-ms', HOUR_MS]);
    assert.equal(proxy.unfiltered, before, 'PRECONDITION: the asserted run did not audit, so the count is the scan\'s');
    assert.ok(!proxy.publishes.includes('m-bad:claim'), 'the malformed entry is never attempted');
    assert.equal(r.status.pendingCount, listed.length, `pendingCount counts every listed pending entry, the malformed one included (${r.status.pendingCount} of ${listed.length})`);
  }));
});
