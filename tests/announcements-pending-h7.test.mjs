/**
 * #1574 1b, THE LAST PIECE: `announcementsPending` ON `GET /api/health`. With the retry tick and the daemon out of scope (decision 012168e4), an announcement whose inline attempt failed stays `pending` until a
 * hand-run `announce-publisher.mjs --once` or the cards migration discharges it, so the count is what makes "stuck" visible without a query. The builder's contract (17:04Z): it counts EVERY pending outbox entry, legacy
 * and publisher; it is recounted from the board each `writeBoard` already holds, plus once at boot; it is `null` until the first count, never a fabricated 0. Written by the separate test author BEFORE trusting it, black-box
 * through REST, a REAL executor behind a proxy that can go down, and the real reconciler script run once as its own process. Synthetic content. Without a python with pyoxigraph the unit-on rows are SKIPPED, and a skip is
 * NOT a pass.
 *
 *   H7a  AT BOOT, NO WRITE NEEDED: a fresh board reads `announcementsPending: 0` (a real number, not null) straight after boot, before any write.
 *   H7b  LEGACY AND PUBLISHER BOTH COUNT: a board whose document already holds two pending entries (one legacy, one publisher) reads 2 at boot.
 *   H7c  IT TRACKS THE STUCK ONES: with the executor down, a claim raises the count by exactly 1 (read straight after the claim's 200); the executor back and ONE `--once` run drops it back to the starting value; a second
 *        run changes nothing.
 *   H7d  IT DROPS BY ITSELF WHEN THE INLINE ATTEMPT SUCCEEDS: with the executor up, a claim's entry is counted and then, once the inline publish and the batched completion have landed, the count is back to its start
 *        (no manual step).
 *   H7e  A BOARD WITHOUT THE UNIT STILL COUNTS ITS LEGACY ENTRIES: with the unit off, a claim leaves a legacy entry pending forever, and the count says 1 (legacy entries are counted, as the builder said).
 *
 * NOT COVERED, by name: the `null` before the first count (the boot count is immediate here, so the state is not observable); a count after a failed write (advisory by design); the live board's baseline (219 legacy
 * entries are pending there, so on the live board the number starts at 219 + whatever is stuck, and an alert threshold must account for that); any use of the number by a watcher.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { makeBoardFixture, startRestServer } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';
import { withAnnouncement, OUTBOX_FIELD } from '../core/announce-outbox.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const DSID = 'h7-test';
const EPOCH_DOC = '11111111-2222-4333-8444-555555555555';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROSTER_FILE = path.join(os.tmpdir(), `h7-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
const PUBLISHER = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'scripts', 'announce-publisher.mjs');
const api = async (base, method, route, body) => {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(40000) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text };
};
async function until(fn, ms, step = 250) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(step); } }
const pendingOf = async (base) => { const h = await api(base, 'GET', '/api/health'); assert.equal(h.status, 200, h.text.slice(0, 200)); return h.body.announcementsPending; };
async function startProxy(execUrl) {
  const p = {};
  p.server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const fwd = { ...req.headers }; delete fwd.host; delete fwd['content-length']; delete fwd.connection;
    try { const f = await fetch(`${execUrl}${req.url}`, { method: req.method, headers: fwd, ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) }); const t = await f.text(); res.statusCode = f.status; res.end(t); } catch { try { req.socket.destroy(); } catch { /* gone */ } }
  });
  await new Promise((r) => p.server.listen(0, '127.0.0.1', r)); p.port = p.server.address().port; p.url = `http://127.0.0.1:${p.port}`;
  p.down = () => new Promise((r) => { p.server.closeAllConnections?.(); p.server.close(() => r()); });
  p.up = () => new Promise((r, j) => { p.server.once('error', j); p.server.listen(p.port, '127.0.0.1', r); });
  return p;
}
const runOnce = (base) => new Promise((resolve) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h7-pub-')); const key = path.join(dir, 'board.key'); fs.writeFileSync(key, 'sk-test-not-a-secret', { mode: 0o600 });
  const ch = spawn(process.execPath, [PUBLISHER, '--board', base, '--key-file', key, '--status', path.join(dir, 'st.json'), '--once'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; ch.stderr.on('data', (d) => { err += d; }); ch.on('exit', (code) => resolve({ code, err }));
});
const card = (n) => ({ id: `c${n}`, shortId: n, title: `card ${n}`, description: '', type: 'task', column: 'backlog', order: n, assignees: ['unassigned'], labels: [], priority: null, version: 1, createdAt: '2026-09-14T00:00:00.000Z', updatedAt: '2026-09-14T00:00:00.000Z', relationships: { relatedTo: [], blockedBy: [] } });
const fixture = (extra = {}) => makeBoardFixture({ cards: [card(1), card(2)], nextShortId: 3, postSeqEpoch: EPOCH_DOC, nextPostSeq: 1, ...extra });
async function unitOn(extra, body) {
  const exec = await startExecutor({ store: tmpStore('h7-store-'), datasetId: DSID, create: true });
  const proxy = await startProxy(exec.baseUrl);
  const rest = await startRestServer({ board: fixture(extra), env: { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: DSID, SCRUM_GRAPH_EXECUTOR_URL: proxy.url, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1' } });
  try { return await body({ base: rest.baseUrl, proxy }); } finally { await rest.stop(); try { await proxy.down(); } catch { /* down */ } await killExecutor(exec); }
}

test('H7a AT BOOT, NO WRITE NEEDED: a fresh board reads announcementsPending 0, a real number, straight after boot', { skip: SKIP, timeout: 120000 }, async () => {
  await unitOn({}, async ({ base }) => {
    const n = await pendingOf(base);
    assert.equal(n, 0, `a fresh board counts zero pending entries, not null and not absent (${JSON.stringify(n)})`);
  });
});

test('H7b LEGACY AND PUBLISHER BOTH COUNT: a board that already holds one pending legacy entry and one pending publisher entry reads 2 at boot', { skip: SKIP, timeout: 120000 }, async () => {
  const at = '2026-09-14T02:00:00.000Z';
  let ob = withAnnouncement(undefined, { mutationId: 'm-legacy', origin: { cardId: 'c1', version: 1 }, at, originActor: 'ada', mode: 'legacy', slots: [{ slot: 'claim', body: 'legacy one', mentions: [], notify: true, legacyPostId: 'p-legacy' }] });
  ob = withAnnouncement(ob, { mutationId: 'm-pub', origin: { cardId: 'c2', version: 1 }, at, originActor: 'ada', mode: 'publisher', slots: [{ slot: 'claim', body: 'publisher one', mentions: [], notify: true }] });
  await unitOn({ [OUTBOX_FIELD]: ob }, async ({ base }) => {
    assert.equal(await pendingOf(base), 2, 'both modes are counted at boot');
  });
});

test('H7c IT TRACKS THE STUCK ONES: with the executor down a claim raises the count by 1; the executor back and one --once run drops it back; a second run changes nothing', { skip: SKIP, timeout: 240000 }, async () => {
  await unitOn({}, async ({ base, proxy }) => {
    const start = await pendingOf(base); assert.equal(start, 0);
    await proxy.down();
    assert.equal((await api(base, 'POST', '/api/cards/c1/claim', { by: 'ada' })).status, 200);
    assert.equal(await pendingOf(base), start + 1, 'straight after the claim the count is one higher');
    await sleep(2500); await proxy.up();
    const rec = await runOnce(base); assert.equal(rec.code, 0, `the reconciler run completes (${rec.code}) ${rec.err.slice(0, 160)}`);
    assert.ok(await until(async () => (await pendingOf(base)) === start, 15000), `one --once run brings the count back to ${start} (it reads ${await pendingOf(base)})`);
    const again = await runOnce(base); assert.equal(again.code, 0);
    await sleep(1500);
    assert.equal(await pendingOf(base), start, 'and a second run changes nothing');
  });
});

test('H7d IT DROPS BY ITSELF WHEN THE INLINE ATTEMPT SUCCEEDS: with the executor up a claim\'s entry is counted and then, once the inline publish and the batched completion have landed, the count is back to its start', { skip: SKIP, timeout: 180000 }, async () => {
  await unitOn({}, async ({ base }) => {
    const start = await pendingOf(base);
    assert.equal(typeof start, 'number', `the count exists before the claim (${JSON.stringify(start)}): without this the row would pass on a build that has no count at all, undefined equal to undefined`);
    assert.equal((await api(base, 'POST', '/api/cards/c1/claim', { by: 'ada' })).status, 200);
    assert.ok(await until(async () => (await pendingOf(base)) === start, 15000), `the count returns to ${start} with no manual step (it reads ${await pendingOf(base)})`);
  });
});

test('H7e A BOARD WITHOUT THE UNIT STILL COUNTS ITS LEGACY ENTRIES: with the unit off a claim leaves a legacy entry pending and the count says 1', { timeout: 120000 }, async () => {
  const rest = await startRestServer({ board: fixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
  try {
    assert.equal(await pendingOf(rest.baseUrl), 0, 'zero at boot');
    assert.equal((await api(rest.baseUrl, 'POST', '/api/cards/c1/claim', { by: 'ada' })).status, 200);
    assert.equal(await pendingOf(rest.baseUrl), 1, 'a legacy entry written by the claim is pending and is counted');
  } finally { await rest.stop(); }
});
