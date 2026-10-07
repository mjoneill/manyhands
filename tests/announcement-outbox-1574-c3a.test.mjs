/**
 * #1574 unit 2, C3a — the announcement OUTBOX: an obligation is committed in the SAME document write as the
 * change that caused it, and nothing else may add, remove or edit it. Pre-registered by the separate test
 * author BEFORE the implementation exists. Copy unchanged into tests/ and build to this file; if the contract
 * needs a change, the test changes first and the change is announced on #1574.
 *
 * C3a is the part that needs only the board server. C3b (a later, separate file) needs the publisher and the
 * real executor and covers: a crash after the post commits and before /complete, two simultaneous reconcilers,
 * the positive /complete path, and notification delivery. NOT COVERED HERE, BY NAME:
 *   - a mutation whose manifest AND obligations are both gone (the slot audit cannot see it);
 *   - rest/retire, done-nudge and wiki origins (they need agent and wiki fixtures; C3b adds rows);
 *   - an obligation removed from a stopped board's file (it depends on the on-disk representation);
 *   - power loss.
 *
 * CONTRACT PINNED HERE
 *   STORAGE   the server-owned board field `announcementOutbox` = { origins: {[mutationId]: {mutationId, slots,
 *             origin:{cardId, version}, committedAt}}, entries: {[obligationId]: {obligationId, mutationId, slot,
 *             status, payload, ...}} }, written in the SAME document write as the card change.
 *   READ      GET /api/outbox[?status=&mutationId=] -> { origins: [...], entries: [...] } (arrays) from ONE locked
 *             read. Origins are returned even when none of their entries exist. Both lists are filtered together.
 *   IDENTITY  mutationId is server-generated (never client supplied), unique per committed mutation. obligationId is
 *             unique; every entry names an origin that exists and whose `slots` contain the entry's slot.
 *   PAYLOAD   frozen at commit: { author:'board', body, mentions[], notify, occurredAt (ISO), originActor, origin, slot }.
 *   STATUS    pending | published | blocked. A fresh entry is `pending`.
 *   SLOTS     a card claim -> slot 'claim', a release of a held card -> slot 'release'. Releasing an unheld card is not
 *             a transition: no origin, no entry.
 *   SAVE      POST /api/save never adds, removes or edits origins or entries: the server's CURRENT outbox, under the
 *             lock, survives, whatever the client sent.
 *   COMPLETE  POST /api/outbox/:obligationId/complete {postId} NEVER trusts a caller-supplied receipt. With the graph
 *             lookup unavailable, or the obligation unknown, nothing is marked published.
 *   COMPACT   core/announce-outbox.mjs exports the PURE compactOutbox(doc, nowMs): a `published` entry whose
 *             publishedAt is MORE than 7 days (604800000 ms) before nowMs is reduced to exactly
 *             {obligationId, mutationId, slot, status:'published', publishedAt, postId}; origins are never touched; a
 *             pending or blocked entry, and a published one with no valid publishedAt, are never touched.
 *   BARRIERS  env SCRUM_TEST_BARRIER_DIR=<dir>. At each of two points in the write path, IF a fifo named
 *             `after-events` / `after-document` exists in that dir, the server opens and reads it (blocking):
 *               after-events    : after the event-log append, BEFORE the board document is written;
 *               after-document  : after the board document is written, BEFORE the HTTP response.
 *             Nothing else is gated, and with the variable unset the server behaves as shipped.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { freePort, waitForHttp, makeBoardFixture, startRestServer, PROJECT_DIR } from './helpers/harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMPACT_MOD = process.env.OUTBOX_MODULE || path.join(HERE, '..', 'core', 'announce-outbox.mjs');
const SEVEN_DAYS = 7 * 24 * 3600 * 1000;

async function api(base, method, route, body) {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(8000) });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text };
}
const newCard = async (base, title = 'outbox probe') => (await api(base, 'POST', '/api/cards', { title, description: 'x', createdBy: 'ada' })).body;
const outbox = async (base, q = '') => { const r = await api(base, 'GET', `/api/outbox${q}`); assert.equal(r.status, 200, `GET /api/outbox: ${r.status} ${r.text}`); return r.body; };
const slotsOf = (ob) => ob.entries.map((e) => e.slot).sort();

// ------------------------------------------------------------------ 1. a claim commits its obligation with the claim
test('O1 a claim commits ONE origin and ONE pending entry, with a frozen payload and server-generated identity', async () => {
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    const empty = await outbox(s.baseUrl);
    assert.deepEqual(empty, { origins: [], entries: [] }, 'a fresh board has an empty outbox');
    const c = await newCard(s.baseUrl);
    assert.deepEqual(await outbox(s.baseUrl), { origins: [], entries: [] }, 'creating a card announces nothing');
    const claim = await api(s.baseUrl, 'POST', `/api/cards/${c.id}/claim`, { by: 'ada' });
    assert.equal(claim.status, 200, claim.text);
    const ob = await outbox(s.baseUrl);
    assert.equal(ob.origins.length, 1, JSON.stringify(ob));
    assert.equal(ob.entries.length, 1);
    const [o] = ob.origins, [e] = ob.entries;
    assert.equal(typeof o.mutationId, 'string'); assert.ok(o.mutationId.length > 0);
    assert.deepEqual(o.slots, ['claim']);
    assert.equal(e.mutationId, o.mutationId);
    assert.equal(e.slot, 'claim');
    assert.equal(e.status, 'pending');
    assert.equal(typeof e.obligationId, 'string'); assert.ok(e.obligationId.length > 0);
    const cardNow = (await api(s.baseUrl, 'GET', `/api/cards/${c.id}`)).body;
    assert.equal(o.origin.cardId, c.id, 'provenance names the card');
    assert.equal(o.origin.version, cardNow.version, 'provenance names the version the claim produced');
    const p = e.payload;
    assert.equal(p.author, 'board'); assert.equal(p.originActor, 'ada'); assert.equal(p.slot, 'claim');
    assert.equal(typeof p.body, 'string'); assert.ok(p.body.length > 0);
    assert.ok(Array.isArray(p.mentions));
    assert.ok(Number.isFinite(Date.parse(p.occurredAt)), `occurredAt ${p.occurredAt}`);
    assert.ok('notify' in p);
  } finally { await s.stop(); }
});

test('O2 a release of a HELD card is a second mutation with a new identity; releasing an unheld card announces nothing', async () => {
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    const c = await newCard(s.baseUrl);
    await api(s.baseUrl, 'POST', `/api/cards/${c.id}/claim`, { by: 'ada' });
    const rel = await api(s.baseUrl, 'DELETE', `/api/cards/${c.id}/claim`, { by: 'ada' });
    assert.equal(rel.status, 200, rel.text);
    const ob = await outbox(s.baseUrl);
    assert.equal(ob.origins.length, 2);
    assert.deepEqual(slotsOf(ob), ['claim', 'release']);
    assert.equal(new Set(ob.origins.map((o) => o.mutationId)).size, 2, 'two mutations, two identities');
    assert.equal(new Set(ob.entries.map((e) => e.obligationId)).size, 2);
    const again = await api(s.baseUrl, 'DELETE', `/api/cards/${c.id}/claim`, { by: 'ada' });   // already unheld: idempotent, NOT a transition
    assert.ok(again.status < 400, again.text);
    assert.equal((await outbox(s.baseUrl)).entries.length, 2, 'an idempotent release adds no obligation');
  } finally { await s.stop(); }
});

test('O3 every entry names an origin that exists and lists its slot; the two filters agree with each other', async () => {
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    const a = await newCard(s.baseUrl, 'one'), b = await newCard(s.baseUrl, 'two');
    await api(s.baseUrl, 'POST', `/api/cards/${a.id}/claim`, { by: 'ada' });
    await api(s.baseUrl, 'POST', `/api/cards/${b.id}/claim`, { by: 'bea' });
    const ob = await outbox(s.baseUrl);
    assert.equal(ob.origins.length, 2);
    for (const e of ob.entries) {
      const o = ob.origins.find((x) => x.mutationId === e.mutationId);
      assert.ok(o, `entry ${e.obligationId} names a missing origin`);
      assert.ok(o.slots.includes(e.slot));
    }
    const one = ob.origins[0].mutationId;
    const f = await outbox(s.baseUrl, `?mutationId=${encodeURIComponent(one)}`);
    assert.deepEqual(f.origins.map((o) => o.mutationId), [one]);
    assert.ok(f.entries.length >= 1 && f.entries.every((e) => e.mutationId === one), 'the filter applies to BOTH lists');
    const none = await outbox(s.baseUrl, '?mutationId=does-not-exist');
    assert.deepEqual(none, { origins: [], entries: [] });
    const pend = await outbox(s.baseUrl, '?status=pending');
    assert.equal(pend.entries.length, 2);
    const pub = await outbox(s.baseUrl, '?status=published');
    assert.deepEqual(pub.entries, []);
  } finally { await s.stop(); }
});

// ------------------------------------------------------------------ 2. a snapshot save never touches the outbox
// ⚠️ EVERY save below makes a REAL card change at the card's CURRENT version, so the server really writes the
// board document. A save that changes nothing skips the write, and a sabotaged save path would look identical to
// a correct one (the trap #1584's F5 fell into). Each test asserts the retitle LANDED before it asserts the outbox.
const titleOf = async (base, id) => (await api(base, 'GET', `/api/cards/${id}`)).body.title;
const retitled = (snapshot, id, title) => ({ cards: snapshot.cards.map((c) => (c.id === id ? { ...c, title } : c)), columns: snapshot.columns, nextShortId: snapshot.nextShortId });

// ------------------------------------------------------------------ 3. completion is verified, never trusted
test('K0 /complete trusts nothing the caller sends: an unknown obligation is refused, and with the graph lookup unavailable a real one stays PENDING', async () => {
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    const a = await newCard(s.baseUrl);
    await api(s.baseUrl, 'POST', `/api/cards/${a.id}/claim`, { by: 'ada' });
    const before = await outbox(s.baseUrl);
    const [e] = before.entries;
    const unknown = await api(s.baseUrl, 'POST', '/api/outbox/not-an-obligation/complete', { postId: 'p1', receipt: { status: 'APPLIED' } });
    assert.equal(unknown.status, 404, unknown.text);
    for (const body of [{ postId: 'p1' }, { postId: 'p1', receipt: { status: 'APPLIED', opId: 'whatever' } }, { postId: 'p1', status: 'published', receipt: { status: 'APPLIED' } }, {}]) {
      const r = await api(s.baseUrl, 'POST', `/api/outbox/${encodeURIComponent(e.obligationId)}/complete`, body);
      assert.ok(r.status >= 400, `a completion with no verifiable receipt must be refused (${JSON.stringify(body)}): ${r.status} ${r.text}`);
    }
    assert.deepEqual(await outbox(s.baseUrl), before, 'nothing was marked published');
  } finally { await s.stop(); }
});

// ------------------------------------------------------------------ 4. crash windows, real SIGKILL at deterministic barriers
async function spawnServer(boardFile, barrierDir) {
  const port = await freePort();
  const attachments = fs.mkdtempSync(path.join(os.tmpdir(), 'c3a-attach-'));
  const env = { ...process.env, SCRUM_BOARD_FILE: boardFile, SCRUM_PORT: String(port), SCRUM_MCP_NOTIFY_URL: '', SCRUM_ATTACHMENTS_DIR: attachments,
    SCRUM_CHANNEL_CONFIG_FILE: path.join(os.tmpdir(), `c3a-chan-${process.pid}-${port}.json`), SCRUM_INSTANCE_ID: `c3a-${port}`, SCRUM_TEST_BARRIER_DIR: barrierDir };
  const child = spawn('node', ['server.js'], { cwd: PROJECT_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const err = []; child.stderr.on('data', (d) => err.push(String(d)));
  const base = `http://127.0.0.1:${port}`;
  await waitForHttp(`${base}/api/board`, 15000);
  return { child, base, stop: () => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, stderr: () => err.join('') };
}

/** Arm `barrier`, fire `action(base)`, wait until the server is BLOCKED at the barrier, SIGKILL it, report what the client saw. */
async function killAtBarrier(server, barrierDir, barrier, action) {
  const fifo = path.join(barrierDir, barrier);
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
  const pending = action(server.base).then((r) => ({ status: r.status }), (e) => ({ reset: String(e && e.message || e) }));
  let fh = null;
  const reached = await Promise.race([fsp.open(fifo, 'w').then((h) => { fh = h; return true; }), new Promise((r) => setTimeout(() => r(false), 8000))]);
  if (!reached) { try { fs.closeSync(fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)); } catch { /* none */ } }
  server.stop();
  const seen = await Promise.race([pending, new Promise((r) => setTimeout(() => r({ timeout: true }), 8000))]);
  try { await fh?.close(); } catch { /* ignore */ }
  fs.rmSync(fifo, { force: true });
  return { reached, seen };
}

function crashFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c3a-crash-'));
  const boardFile = path.join(dir, 'board.json');
  fs.writeFileSync(boardFile, JSON.stringify(makeBoardFixture(), null, 2));
  const barrierDir = path.join(dir, 'barriers'); fs.mkdirSync(barrierDir);
  return { dir, boardFile, barrierDir };
}
const clientSawNoSuccess = (seen) => assert.ok(seen.reset !== undefined || (seen.status !== undefined && seen.status >= 500) || seen.timeout, `the client must not be told the claim succeeded: ${JSON.stringify(seen)}`);

test('X1 (window a) a crash AFTER the event append and BEFORE the document write leaves NO claim, NO origin, NO entry; a retry then yields exactly one', async () => {
  const f = crashFixture();
  let a, b;
  try {
    a = await spawnServer(f.boardFile, f.barrierDir);
    const card = await newCard(a.base);
    const { reached, seen } = await killAtBarrier(a, f.barrierDir, 'after-events', (base) => api(base, 'POST', `/api/cards/${card.id}/claim`, { by: 'ada' }));
    assert.equal(reached, true, `the server never reached the after-events barrier: ${a.stderr().slice(-300)}`);
    clientSawNoSuccess(seen);
    b = await spawnServer(f.boardFile, f.barrierDir);
    const after = (await api(b.base, 'GET', `/api/cards/${card.id}`)).body;
    assert.ok(!after.claimedBy, `the claim must not exist: ${after.claimedBy}`);
    assert.deepEqual(await outbox(b.base), { origins: [], entries: [] }, 'no obligation without the change that caused it');
    const retry = await api(b.base, 'POST', `/api/cards/${card.id}/claim`, { by: 'ada' });
    assert.equal(retry.status, 200, retry.text);
    const ob = await outbox(b.base);
    assert.equal(ob.origins.length, 1); assert.equal(ob.entries.length, 1, 'exactly one: the dead attempt left nothing behind');
  } finally { a?.stop(); b?.stop(); }
});

test('X2 (window b) a crash AFTER the document write and BEFORE the response leaves the claim AND exactly one pending obligation, stable across restarts', async () => {
  const f = crashFixture();
  let a, b, c;
  try {
    a = await spawnServer(f.boardFile, f.barrierDir);
    const card = await newCard(a.base);
    const { reached, seen } = await killAtBarrier(a, f.barrierDir, 'after-document', (base) => api(base, 'POST', `/api/cards/${card.id}/claim`, { by: 'ada' }));
    assert.equal(reached, true, `the server never reached the after-document barrier: ${a.stderr().slice(-300)}`);
    clientSawNoSuccess(seen);
    b = await spawnServer(f.boardFile, f.barrierDir);
    const after = (await api(b.base, 'GET', `/api/cards/${card.id}`)).body;
    assert.equal(after.claimedBy, 'ada', 'the document write committed: the claim is there');
    const ob = await outbox(b.base);
    assert.equal(ob.origins.length, 1, JSON.stringify(ob)); assert.equal(ob.entries.length, 1);
    assert.equal(ob.entries[0].status, 'pending');
    assert.deepEqual(ob.origins[0].slots, ['claim']);
    b.stop();
    c = await spawnServer(f.boardFile, f.barrierDir);                                   // a second restart changes nothing
    assert.deepEqual(await outbox(c.base), ob, 'restarting again neither duplicates nor drops the obligation');
  } finally { a?.stop(); b?.stop(); c?.stop(); }
});

// ------------------------------------------------------------------ 5. compaction: a pure function with an explicit clock
let compact = null, compactErr = null;
try { ({ compactOutbox: compact } = await import(pathToFileURL(COMPACT_MOD).href)); } catch (e) { compactErr = e; }
const NOW = Date.parse('2026-10-20T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const entry = (id, mut, status, extra = {}) => ({ obligationId: id, mutationId: mut, slot: 'claim', status,
  payload: { author: 'board', body: `body ${id}`, mentions: [], notify: 'none', occurredAt: iso(NOW - 40 * 86400000), originActor: 'ada', slot: 'claim' }, ...extra });
const origin = (mut) => ({ mutationId: mut, slots: ['claim'], origin: { cardId: 'c', version: 3 }, committedAt: iso(NOW - 40 * 86400000) });
const docOf = (entries, origins = ['m1', 'm2', 'm3', 'm4', 'm5']) => ({ title: 'kept', announcementOutbox: { origins: Object.fromEntries(origins.map((m) => [m, origin(m)])), entries: Object.fromEntries(entries.map((e) => [e.obligationId, e])) } });

test('K1 the module loads and exports a pure compactOutbox(doc, nowMs)', () => {
  assert.equal(compactErr, null, `core/announce-outbox.mjs must import cleanly: ${compactErr}`);
  assert.equal(typeof compact, 'function');
});
test('K2 a published entry MORE than 7 days old is reduced to its identity; exactly 7 days is kept whole; younger is untouched', () => {
  const old = entry('o1', 'm1', 'published', { postId: 'p1', publishedAt: iso(NOW - SEVEN_DAYS - 1) });
  const edge = entry('o2', 'm2', 'published', { postId: 'p2', publishedAt: iso(NOW - SEVEN_DAYS) });
  const young = entry('o3', 'm3', 'published', { postId: 'p3', publishedAt: iso(NOW - 3600_000) });
  const out = compact(docOf([old, edge, young]), NOW);
  assert.deepEqual(out.announcementOutbox.entries.o1, { obligationId: 'o1', mutationId: 'm1', slot: 'claim', status: 'published', publishedAt: old.publishedAt, postId: 'p1' });
  assert.deepEqual(out.announcementOutbox.entries.o2, edge, 'exactly 7 days is not "more than"');
  assert.deepEqual(out.announcementOutbox.entries.o3, young);
});
test('K3 pending and blocked entries are NEVER compacted, however old; a published entry with no valid publishedAt is never compacted', () => {
  const pending = entry('o4', 'm4', 'pending');
  const blocked = entry('o5', 'm5', 'blocked', { reason: 'payload refused' });
  const noStamp = entry('o6', 'm1', 'published', { postId: 'p6' });
  const badStamp = entry('o7', 'm2', 'published', { postId: 'p7', publishedAt: 'long ago' });
  const out = compact(docOf([pending, blocked, noStamp, badStamp]), NOW);
  for (const e of [pending, blocked, noStamp, badStamp]) assert.deepEqual(out.announcementOutbox.entries[e.obligationId], e, e.obligationId);
});
test('K4 every origin and its slots survive compaction permanently, and the rest of the document is preserved', () => {
  const old = entry('o1', 'm1', 'published', { postId: 'p1', publishedAt: iso(NOW - 30 * 86400000) });
  const doc = docOf([old]);
  const out = compact(doc, NOW);
  assert.deepEqual(out.announcementOutbox.origins, doc.announcementOutbox.origins);
  assert.equal(out.title, 'kept');
});
test('K5 compactOutbox is pure and idempotent: the input is not mutated, and compacting twice equals compacting once', () => {
  const doc = docOf([entry('o1', 'm1', 'published', { postId: 'p1', publishedAt: iso(NOW - 30 * 86400000) }), entry('o2', 'm2', 'pending')]);
  const snapshot = JSON.stringify(doc);
  const once = compact(doc, NOW);
  assert.equal(JSON.stringify(doc), snapshot, 'the input document must not be mutated');
  assert.deepEqual(compact(once, NOW), once);
  assert.deepEqual(compact(doc, NOW + 1000), compact(doc, NOW + 1000), 'same inputs, same output');
  assert.notEqual(compact(doc, NOW), doc, 'a new document is returned');
});
test('K6 a document with no outbox, or an empty one, is returned unchanged', () => {
  assert.deepEqual(compact({ title: 'x' }, NOW), { title: 'x' });
  const empty = { announcementOutbox: { origins: {}, entries: {} } };
  assert.deepEqual(compact(empty, NOW), empty);
});
