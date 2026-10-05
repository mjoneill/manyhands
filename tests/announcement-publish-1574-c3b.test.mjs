/**
 * #1574 unit 2, C3b — PUBLISHING an obligation: the server-owned /publish route, the publisher process as a
 * clock, the audit rule, the publisher's schedule. Pre-registered by the separate test author BEFORE the
 * implementation exists. Copy unchanged into tests/ and build to it; if the contract needs a change, the test
 * changes first and the change is announced on #1574. Builds on the frozen C3a (ca7f67ec…59ea).
 *
 * NOT COVERED HERE, BY NAME: board-key-only authorization of /publish (an explicit CUTOVER GATE, not "covered
 * elsewhere"); notification delivery and its recovery (C4); detection that the PUBLISHER has died (the status
 * file only enables it until a consumer exists); the done-nudge, wiki and rest/retire emitters (rows to be added
 * when they emit); a removed entry in a stopped board's file; power loss; SUCCESSFUL graph publication and the
 * APPLIED-receipt and intention-digest check against the REAL executor (the executor path here is exercised only for
 * "hung" and "unreachable", which are failure paths and prove neither). Freezing this file authorizes its covered
 * publisher slice, NOT enabling the unit-2 flag.
 *
 * CONTRACT PINNED HERE
 *   MODE      every origin AND every entry carries `mode: 'legacy' | 'publisher'`, frozen at commit, never changed.
 *             Missing, unknown, or different between an origin and its entry => MALFORMED => blocked 'malformed-entry'.
 *             Before cutover the claim and release path writes `legacy`.
 *   LEGACY    the direct commons post is written in the SAME document write as the obligation; the entry stores its id
 *             as `legacyPostId`, and that post carries `origin: {mutationId, slot}`.
 *   PUBLISH   POST /api/outbox/:obligationId/publish -> 404 for an unknown id, otherwise a JSON body
 *             {status: 'published'|'pending'|'blocked', postId?, reason?} and an HTTP status below 500. Idempotent.
 *             legacy    : the referenced post must exist AND match the frozen payload and provenance (author, body,
 *                         origin.mutationId, origin.slot) -> published with receipt 'legacy', NO new post. A missing
 *                         proof or missing post -> blocked 'legacy-proof-missing'; a post that does not match ->
 *                         blocked 'legacy-proof-mismatch'. A blocked entry is NEVER republished.
 *             publisher : before the flag the post is a commons conversation {author:'board', body, opId, origin:{mutationId,
 *                         slot}} with opId = `urn:ex:op/announce/<mutationId>/<slot>`, written in ONE document write with the
 *                         entry's move to published (postId = the post's id). A post already holding that opId and matching
 *                         the frozen payload is FOUND, not rewritten; one holding the opId that does NOT match -> blocked.
 *   BARRIER   env SCRUM_TEST_BARRIER_DIR, fifo `after-publish-write`: read (blocking) AFTER that single document write.
 *   FLAG      env SCRUM_GRAPH_UNIT_CONVERSATIONS=1 (the set unit 1's SCRUM_GRAPH_UNIT_LOGBORN belongs to) sends publisher-mode posts through
 *             the executor at SCRUM_GRAPH_EXECUTOR_URL. WITH THE FLAG ON C3b asserts only the publisher's own write and its
 *             verification (the entry, and what the executor was asked), NEVER the conversation listing: moving the post read
 *             routes to the graph is the unit's own slice.
 *             The executor call is made with the board's write lock RELEASED. `/publish` must ATTEMPT an executor call (any HTTP
 *             request to that URL, e.g. the receipt lookup) before it answers; a failing executor leaves the entry `pending`
 *             (nothing guessed); a hung one must not stall other board writes. The tests assert the stand-in SAW the attempt, so a
 *             placeholder that never calls the executor cannot pass them. An unreachable (closed) port is not asserted: whether the
 *             attempt was made is not observable there.
 *   AUDIT     core/announce-outbox.mjs exports the pure auditOutbox(doc) -> {failures:[{kind, mutationId?, slot?,
 *             obligationId?}]}: `missing-entry` (an origin slot with no entry), `orphan-entry` (an entry whose mutation has no
 *             origin), `slot-mismatch` (an entry whose slot is not among its origin's slots).
 *   SCHEDULE  scripts/announce-publisher.mjs exports the pure nextActions({nowMs, lastScanAt, lastAuditAt, scanEveryMs,
 *             auditEveryMs}) -> {scan, audit} (booleans; a never-run side is due; due when now - last >= every). Importing
 *             the module runs nothing.
 *   PUBLISHER node scripts/announce-publisher.mjs --board URL --key-file FILE --status FILE [--once] [--batch N]: --once is
 *             one scan (oldest `pending` first, at most N entries) followed by one audit, exit 0 when the scan completed
 *             (blocked entries do not make it fail), non-zero when the board is unreachable. It writes the status file
 *             {checkedAt, lastScanCompletedAt, pendingCount, oldestPendingAt, blockedCount, lastError, auditIntegrityFailures}
 *             on every run and holds no other state.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { freePort, waitForHttp, makeBoardFixture, startRestServer, PROJECT_DIR } from './helpers/harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUTBOX_MOD = process.env.OUTBOX_MODULE || path.join(HERE, '..', 'core', 'announce-outbox.mjs');
const PUBLISHER = process.env.PUBLISHER_SCRIPT || path.join(HERE, '..', 'scripts', 'announce-publisher.mjs');
let audit = null, auditErr = null, nextActions = null, publisherErr = null;
try { ({ auditOutbox: audit } = await import(pathToFileURL(OUTBOX_MOD).href)); } catch (e) { auditErr = e; }
try { ({ nextActions } = await import(pathToFileURL(PUBLISHER).href)); } catch (e) { publisherErr = e; }

async function api(base, method, route, body, { signal } = {}) {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: signal || AbortSignal.timeout(10000) });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text };
}
const outboxOf = async (base) => { const r = await api(base, 'GET', '/api/outbox'); assert.equal(r.status, 200, `GET /api/outbox: ${r.status} ${r.text}`); return r.body; };
const entryOf = async (base, id) => (await outboxOf(base)).entries.find((e) => e.obligationId === id);
const commons = async (base) => { const b = (await api(base, 'GET', '/api/conversations?attachedTo=null')).body; return Array.isArray(b) ? b : (b?.conversations ?? b?.items ?? []); };
const boardPosts = async (base) => (await commons(base)).filter((c) => c.author === 'board');
const publish = (base, id, opts) => api(base, 'POST', `/api/outbox/${encodeURIComponent(id)}/publish`, {}, opts);

// ---- fixtures: obligations seeded straight into the board file, so malformed and legacy shapes can be built
const T0 = '2026-10-04T12:00:00.000Z';
const payloadOf = (mut, slot, body, at = T0) => ({ author: 'board', body, mentions: [], notify: true, occurredAt: at, originActor: 'ada', origin: { cardId: 'c1', version: 2 }, mutationId: mut, slot });
const originOf = (mut, mode, slots = ['claim']) => ({ mutationId: mut, slots, origin: { cardId: 'c1', version: 2 }, committedAt: T0, occurredAt: T0, originActor: 'ada', ...(mode ? { mode } : {}) });
const entryFor = (mut, mode, extra = {}, { slot = 'claim', body = `claimed ${mut}`, at = T0 } = {}) => ({ obligationId: `${mut}:${slot}`, mutationId: mut, slot, status: 'pending', ...(mode ? { mode } : {}), payload: payloadOf(mut, slot, body, at), ...extra });
const legacyPost = (id, mut, extra = {}) => ({ id, body: `claimed ${mut}`, author: 'board', attachedTo: null, attachments: [], mentions: [], createdAt: T0, origin: { mutationId: mut, slot: 'claim' }, ...extra });
const opIdOf = (mut, slot = 'claim') => `urn:ex:op/announce/${mut}/${slot}`;
function seeded(items, conversations = []) {
  return makeBoardFixture({
    announcementOutbox: { origins: Object.fromEntries(items.map((i) => [i.o.mutationId, i.o])), entries: Object.fromEntries(items.map((i) => [i.e.obligationId, i.e])) },
    conversations,
  });
}
const item = (mut, mode, { entry = {}, origin = {}, ...rest } = {}) => ({ o: { ...originOf(mut, mode), ...origin }, e: { ...entryFor(mut, mode, entry, rest) } });
const withServer = async (board, env, body) => { const s = await startRestServer({ board, env }); try { return await body(s); } finally { await s.stop(); } };

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


function crashFixture(board) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c3b-crash-'));
  const boardFile = path.join(dir, 'board.json');
  fs.writeFileSync(boardFile, JSON.stringify(board, null, 2));
  const barrierDir = path.join(dir, 'barriers'); fs.mkdirSync(barrierDir);
  return { dir, boardFile, barrierDir };
}

// ------------------------------------------------------------------ 1. legacy mode: the direct post is the proof
test('L1 a claim while the direct path is active commits a LEGACY obligation whose proof is the direct post, written in the same write', async () => {
  await withServer(makeBoardFixture(), {}, async (s) => {
    const c = (await api(s.baseUrl, 'POST', '/api/cards', { title: 'legacy', description: 'x', createdBy: 'ada' })).body;
    assert.equal((await api(s.baseUrl, 'POST', `/api/cards/${c.id}/claim`, { by: 'ada' })).status, 200);
    const ob = await outboxOf(s.baseUrl);
    const [o] = ob.origins, [e] = ob.entries;
    assert.equal(o.mode, 'legacy'); assert.equal(e.mode, 'legacy');
    assert.equal(typeof e.legacyPostId, 'string'); assert.ok(e.legacyPostId.length > 0);
    const posts = await boardPosts(s.baseUrl);
    assert.equal(posts.length, 1, 'exactly one commons post for the claim');
    assert.equal(posts[0].id, e.legacyPostId);
    assert.equal(posts[0].body, e.payload.body);
    assert.equal(posts[0].origin?.mutationId, o.mutationId, 'the direct post carries the obligation\'s provenance');
    assert.equal(posts[0].origin?.slot, 'claim');
  });
});

test('L2 publishing a legacy obligation with valid proof marks it published with receipt legacy and writes NO new post, however often it is repeated', async () => {
  await withServer(makeBoardFixture(), {}, async (s) => {
    const c = (await api(s.baseUrl, 'POST', '/api/cards', { title: 'legacy', description: 'x', createdBy: 'ada' })).body;
    await api(s.baseUrl, 'POST', `/api/cards/${c.id}/claim`, { by: 'ada' });
    const [e0] = (await outboxOf(s.baseUrl)).entries;
    for (let i = 0; i < 3; i++) {
      const r = await publish(s.baseUrl, e0.obligationId);
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.status, 'published', r.text);
    }
    const e = await entryOf(s.baseUrl, e0.obligationId);
    assert.equal(e.status, 'published'); assert.equal(e.receipt, 'legacy');
    assert.equal((await boardPosts(s.baseUrl)).length, 1, 'one claim, one commons post, and the publisher added none');
  });
});

const BAD_PROOF = [
  ['no legacyPostId', { entry: {} }, [legacyPost('p-other', 'other')], 'legacy-proof-missing'],
  ['a legacyPostId naming no post', { entry: { legacyPostId: 'ghost' } }, [], 'legacy-proof-missing'],
  ['a post by another author', { entry: { legacyPostId: 'p1' } }, [legacyPost('p1', 'm-bad', { author: 'mallory' })], 'legacy-proof-mismatch'],
  ['a post with a different body', { entry: { legacyPostId: 'p1' } }, [legacyPost('p1', 'm-bad', { body: 'something else entirely' })], 'legacy-proof-mismatch'],
  ['a post for a different mutation', { entry: { legacyPostId: 'p1' } }, [legacyPost('p1', 'm-bad', { origin: { mutationId: 'someone-else', slot: 'claim' } })], 'legacy-proof-mismatch'],
  ['a post for a different slot', { entry: { legacyPostId: 'p1' } }, [legacyPost('p1', 'm-bad', { origin: { mutationId: 'm-bad', slot: 'release' } })], 'legacy-proof-mismatch'],
  ['a post with no provenance', { entry: { legacyPostId: 'p1' } }, [(() => { const p = legacyPost('p1', 'm-bad'); delete p.origin; return p; })()], 'legacy-proof-mismatch'],
];
for (const [label, spec, posts, reason] of BAD_PROOF) {
  test(`L3 legacy proof, ${label}: BLOCKED ${reason}, never republished`, async () => {
    await withServer(seeded([item('m-bad', 'legacy', spec)], posts), {}, async (s) => {
      const before = (await boardPosts(s.baseUrl)).length;
      const id = 'm-bad:claim';
      const r = await publish(s.baseUrl, id);
      assert.ok(r.status < 500, r.text);
      assert.equal(r.body.status, 'blocked', r.text);
      assert.equal(r.body.reason, reason);
      const again = await publish(s.baseUrl, id);
      assert.equal(again.body.status, 'blocked');
      const e = await entryOf(s.baseUrl, id);
      assert.equal(e.status, 'blocked'); assert.equal(e.reason, reason);
      assert.equal((await boardPosts(s.baseUrl)).length, before, 'a blocked entry writes no post');
    });
  });
}
test('L3 twin: the SAME fixture with a matching post is published (so a block is not "everything is refused")', async () => {
  await withServer(seeded([item('m-ok', 'legacy', { entry: { legacyPostId: 'p1' } })], [legacyPost('p1', 'm-ok')]), {}, async (s) => {
    const r = await publish(s.baseUrl, 'm-ok:claim');
    assert.equal(r.body.status, 'published', r.text);
    assert.equal((await entryOf(s.baseUrl, 'm-ok:claim')).receipt, 'legacy');
  });
});

// ------------------------------------------------------------------ 2. malformed mode is blocked, never inferred
const MALFORMED = [
  ['no mode on the entry or the origin', item('m-x', null)],
  ['an unknown mode', item('m-x', 'other')],
  ['an entry mode different from its origin\'s', item('m-x', 'publisher', { origin: { mode: 'legacy' } })],
  ['an origin with no mode', item('m-x', 'publisher', { origin: { mode: undefined } })],
  ['an entry with no mode under a legacy origin', item('m-x', 'legacy', { entry: { mode: undefined, legacyPostId: 'p1' } })],
];
for (const [label, it, ] of MALFORMED) {
  test(`M1 ${label}: BLOCKED malformed-entry, no post, nothing inferred from a legacyPostId`, async () => {
    const o = { ...it.o }; const e = { ...it.e };
    if (label.startsWith('an origin with no mode')) delete o.mode;
    if (label.startsWith('an entry with no mode')) delete e.mode;
    await withServer(seeded([{ o, e }], [legacyPost('p1', 'm-x')]), {}, async (s) => {
      const r = await publish(s.baseUrl, 'm-x:claim');
      assert.ok(r.status < 500, r.text);
      assert.equal(r.body.status, 'blocked', r.text);
      assert.equal(r.body.reason, 'malformed-entry');
      assert.equal((await boardPosts(s.baseUrl)).length, 1, 'the seeded post only: nothing was written');
    });
  });
}

// ------------------------------------------------------------------ 3. publisher mode: the server creates the post, exactly once
test('P1 publisher mode: /publish creates exactly ONE commons post from the frozen payload, records its id and the opId, and marks published', async () => {
  await withServer(seeded([item('m-p', 'publisher')]), {}, async (s) => {
    assert.equal((await boardPosts(s.baseUrl)).length, 0);
    const r = await publish(s.baseUrl, 'm-p:claim');
    assert.equal(r.status, 200, r.text); assert.equal(r.body.status, 'published'); assert.equal(typeof r.body.postId, 'string');
    const posts = await boardPosts(s.baseUrl);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].id, r.body.postId);
    assert.equal(posts[0].body, 'claimed m-p');
    assert.equal(posts[0].opId, opIdOf('m-p'));
    assert.equal(posts[0].origin?.mutationId, 'm-p'); assert.equal(posts[0].origin?.slot, 'claim');
    const e = await entryOf(s.baseUrl, 'm-p:claim');
    assert.equal(e.status, 'published'); assert.equal(e.postId, r.body.postId);
  });
});

test('P2 repeating /publish, and calling it five times at once, still writes exactly ONE post and returns the same postId', async () => {
  await withServer(seeded([item('m-p', 'publisher')]), {}, async (s) => {
    const rs = await Promise.all([1, 2, 3, 4, 5].map(() => publish(s.baseUrl, 'm-p:claim')));
    for (const r of rs) { assert.equal(r.body.status, 'published', r.text); }
    assert.equal(new Set(rs.map((r) => r.body.postId)).size, 1, 'every caller is told the same post');
    assert.equal((await boardPosts(s.baseUrl)).length, 1);
    const again = await publish(s.baseUrl, 'm-p:claim');
    assert.equal(again.body.postId, rs[0].body.postId);
    assert.equal((await boardPosts(s.baseUrl)).length, 1);
  });
});

test('P3 an unknown obligation is 404 and writes nothing, while a KNOWN one is not 404 (an unrouted path would also answer 404)', async () => {
  await withServer(seeded([item('m-p', 'publisher')]), {}, async (s) => {
    const r = await publish(s.baseUrl, 'not-an-obligation');
    assert.equal(r.status, 404, r.text);
    assert.equal((await boardPosts(s.baseUrl)).length, 0);
    const known = await publish(s.baseUrl, 'm-p:claim');
    assert.notEqual(known.status, 404, 'the route exists: a known obligation is answered, not "not found"');
    assert.equal(known.body?.status, 'published', known.text);
  });
});

test('P4 a post that ALREADY holds the opId and matches the frozen payload is FOUND, not rewritten (the crash-recovery shape)', async () => {
  const existing = { id: 'already', body: 'claimed m-p', author: 'board', attachedTo: null, attachments: [], mentions: [], createdAt: T0, opId: opIdOf('m-p'), origin: { mutationId: 'm-p', slot: 'claim' } };
  await withServer(seeded([item('m-p', 'publisher')], [existing]), {}, async (s) => {
    const r = await publish(s.baseUrl, 'm-p:claim');
    assert.equal(r.body.status, 'published', r.text); assert.equal(r.body.postId, 'already');
    assert.equal((await boardPosts(s.baseUrl)).length, 1, 'no second post');
  });
});

test('P5 a post holding the opId whose content does NOT match is BLOCKED and nothing else is written', async () => {
  const forged = { id: 'forged', body: 'something the obligation never said', author: 'board', attachedTo: null, attachments: [], mentions: [], createdAt: T0, opId: opIdOf('m-p'), origin: { mutationId: 'm-p', slot: 'claim' } };
  await withServer(seeded([item('m-p', 'publisher')], [forged]), {}, async (s) => {
    const r = await publish(s.baseUrl, 'm-p:claim');
    assert.equal(r.body.status, 'blocked', r.text);
    assert.equal((await boardPosts(s.baseUrl)).length, 1);
    assert.equal((await entryOf(s.baseUrl, 'm-p:claim')).status, 'blocked');
  });
});

// ------------------------------------------------------------------ 4. crash after the single publish write

test('X3 a crash AFTER the single publish write and BEFORE the response: after restart, publishing again yields exactly ONE post and a published entry', async () => {
  const f = crashFixture(seeded([item('m-p', 'publisher')]));
  let a, b;
  try {
    a = await spawnServer(f.boardFile, f.barrierDir);
    const { reached, seen } = await killAtBarrier(a, f.barrierDir, 'after-publish-write', (base) => publish(base, 'm-p:claim'));
    assert.equal(reached, true, `the server never reached the after-publish-write barrier: ${a.stderr().slice(-300)}`);
    assert.ok(seen.reset !== undefined || seen.timeout || seen.status >= 500, `the client must not be told it succeeded: ${JSON.stringify(seen)}`);
    b = await spawnServer(f.boardFile, f.barrierDir);
    const r = await publish(b.base, 'm-p:claim');
    assert.equal(r.body.status, 'published', r.text);
    const posts = await boardPosts(b.base);
    assert.equal(posts.length, 1, 'the dead attempt and the retry together wrote one post');
    assert.equal(posts[0].opId, opIdOf('m-p'));
    assert.equal((await entryOf(b.base, 'm-p:claim')).postId, posts[0].id);
  } finally { a?.stop(); b?.stop(); }
});

// ------------------------------------------------------------------ 5. the executor path: unlocked, bounded, nothing guessed
// the server refuses to build the graph slice without a dataset id when an executor URL is set (#1567 fencing), so the executor tests name one
const FLAG = { SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_DATASET_ID: 'c3b-test' };
test('H1 a HUNG executor does not stall the board: the executor call is OUTSTANDING (the stand-in saw it, the publish has not answered), and meanwhile a create, claim, save and read all complete in seconds', async () => {
  let connections = 0;
  const hung = net.createServer((sock) => { connections++; sock.on('error', () => {}); /* accepts, never answers */ });
  await new Promise((r) => hung.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${hung.address().port}`;
  try {
    await withServer(seeded([item('m-h', 'publisher')]), { ...FLAG, SCRUM_GRAPH_EXECUTOR_URL: url }, async (s) => {
      const ac = new AbortController();
      let settled = false;
      const pending = publish(s.baseUrl, 'm-h:claim', { signal: ac.signal }).then(() => { settled = true; return 'answered'; }, () => { settled = true; return 'aborted'; });
      const t0 = Date.now();
      while (connections < 1 && Date.now() - t0 < 4000) await new Promise((r) => setTimeout(r, 50));
      assert.ok(connections >= 1, 'the executor stand-in was NEVER contacted: /publish did not attempt the executor call, so this test proves nothing about isolation');
      assert.equal(settled, false, '/publish must still be waiting on the hung executor while the other writes run');
      const t = async (label, fn) => { const t1 = Date.now(); const r = await fn(); const ms = Date.now() - t1; assert.ok(ms < 4000, `${label} took ${ms} ms while /publish was hung`); return r; };
      const card = await t('create', () => api(s.baseUrl, 'POST', '/api/cards', { title: 'during', description: 'x', createdBy: 'ada' }));
      assert.ok(card.status < 400, card.text);
      const claim = await t('claim', () => api(s.baseUrl, 'POST', `/api/cards/${card.body.id}/claim`, { by: 'ada' }));
      assert.equal(claim.status, 200, claim.text);
      const snap = (await t('read', () => api(s.baseUrl, 'GET', '/api/board'))).body;
      const save = await t('save', () => api(s.baseUrl, 'POST', '/api/save', { cards: snap.cards.map((c) => (c.id === card.body.id ? { ...c, title: 'saved during' } : c)), columns: snap.columns, nextShortId: snap.nextShortId }));
      assert.ok(save.status < 400, save.text);
      assert.equal((await t('read back', () => api(s.baseUrl, 'GET', `/api/cards/${card.body.id}`))).body.title, 'saved during');
      assert.equal(settled, false, 'and the publish was still outstanding after those writes: the isolation was real');
      ac.abort(); await pending;
    });
  } finally { hung.close(); }
});

test('H2 a FAILING executor leaves the entry PENDING and records no post: the stand-in saw the attempt and answered 500', async () => {
  const seen = [];
  const bad = http.createServer((req, res) => { seen.push(`${req.method} ${req.url}`); req.resume(); res.statusCode = 500; res.setHeader('Content-Type', 'application/json'); res.end('{"error":"stand-in failure"}'); });
  await new Promise((r) => bad.listen(0, '127.0.0.1', r));
  try {
    await withServer(seeded([item('m-u', 'publisher')]), { ...FLAG, SCRUM_GRAPH_EXECUTOR_URL: `http://127.0.0.1:${bad.address().port}` }, async (s) => {
      const r = await publish(s.baseUrl, 'm-u:claim');
      assert.ok(seen.length >= 1, 'the executor stand-in was NEVER asked anything: /publish did not attempt the executor operation, so this test proves nothing about failure handling');
      assert.ok(r.status < 500, r.text);
      assert.equal(r.body.status, 'pending', r.text);
      const e = await entryOf(s.baseUrl, 'm-u:claim');
      assert.equal(e.status, 'pending');
      assert.equal(e.postId, undefined, 'no post id is recorded for a post that was never made');
      // (the conversation LISTING is not asserted with the flag on: that read path is the unit's own slice)
    });
  } finally { bad.close(); }
});

// ------------------------------------------------------------------ 6. the audit rule, directly
const doc = (origins, entries) => ({ announcementOutbox: { origins, entries } });
const O = (m, slots) => ({ ...originOf(m, 'publisher', slots) });
const E = (m, slot) => entryFor(m, 'publisher', {}, { slot });
test('A0 the module exports a pure auditOutbox(doc)', () => {
  assert.equal(auditErr, null, `core/announce-outbox.mjs must import cleanly: ${auditErr}`);
  assert.equal(typeof audit, 'function');
});
test('A1 a consistent outbox, an empty one, and a document with none audit CLEAN', () => {
  assert.deepEqual(audit(doc({ m1: O('m1', ['claim']) }, { 'm1:claim': E('m1', 'claim') })), { failures: [] });
  assert.deepEqual(audit(doc({}, {})), { failures: [] });
  assert.deepEqual(audit({ title: 'x' }), { failures: [] });
});
test('A2 an origin slot with no entry is missing-entry, naming the mutation and the slot', () => {
  const r = audit(doc({ m1: O('m1', ['claim', 'release']) }, { 'm1:claim': E('m1', 'claim') }));
  assert.equal(r.failures.length, 1, JSON.stringify(r));
  assert.deepEqual([r.failures[0].kind, r.failures[0].mutationId, r.failures[0].slot], ['missing-entry', 'm1', 'release']);
});
test('A3 an entry whose mutation has no origin is orphan-entry, naming the obligation', () => {
  const r = audit(doc({}, { 'm9:claim': E('m9', 'claim') }));
  assert.equal(r.failures.length, 1, JSON.stringify(r));
  assert.deepEqual([r.failures[0].kind, r.failures[0].obligationId], ['orphan-entry', 'm9:claim']);
});
test('A4 an entry whose slot is not among its origin\'s slots is slot-mismatch', () => {
  const r = audit(doc({ m1: O('m1', ['claim']) }, { 'm1:claim': E('m1', 'claim'), 'm1:release': E('m1', 'release') }));
  assert.equal(r.failures.length, 1, JSON.stringify(r));
  assert.deepEqual([r.failures[0].kind, r.failures[0].obligationId], ['slot-mismatch', 'm1:release']);
});
test('A5 every failure is listed, the audit is pure, and it counts a compacted (identity-only) entry as present', () => {
  const d = doc({ m1: O('m1', ['claim', 'release']), m2: O('m2', ['claim']) }, { 'm3:claim': E('m3', 'claim'), 'm2:claim': { obligationId: 'm2:claim', mutationId: 'm2', slot: 'claim', status: 'published', publishedAt: T0, postId: 'p' } });
  const before = JSON.stringify(d);
  const r = audit(d);
  assert.equal(JSON.stringify(d), before, 'the input must not be mutated');
  assert.deepEqual(r.failures.map((f) => f.kind).sort(), ['missing-entry', 'missing-entry', 'orphan-entry']);
});

// ------------------------------------------------------------------ 7. the publisher's schedule, with an injected clock
test('N0 the publisher module exports nextActions and importing it runs nothing', () => {
  assert.equal(publisherErr, null, `scripts/announce-publisher.mjs must import cleanly: ${publisherErr}`);
  assert.equal(typeof nextActions, 'function');
});
test('N1 a never-run side is due; scan is due at 5 s and not at 4.999 s; audit is due at 60 s and not at 59.999 s; the two are independent', () => {
  const base = { scanEveryMs: 5000, auditEveryMs: 60000 };
  const T = 1_000_000_000_000;
  assert.deepEqual(nextActions({ nowMs: T, lastScanAt: null, lastAuditAt: null, ...base }), { scan: true, audit: true });
  assert.deepEqual(nextActions({ nowMs: T, lastScanAt: T - 4999, lastAuditAt: T - 59999, ...base }), { scan: false, audit: false });
  assert.deepEqual(nextActions({ nowMs: T, lastScanAt: T - 5000, lastAuditAt: T - 59999, ...base }), { scan: true, audit: false });
  assert.deepEqual(nextActions({ nowMs: T, lastScanAt: T - 4999, lastAuditAt: T - 60000, ...base }), { scan: false, audit: true });
  assert.deepEqual(nextActions({ nowMs: T, lastScanAt: T - 3600_000, lastAuditAt: T - 3600_000, ...base }), { scan: true, audit: true });
});
test('N2 the intervals are inputs, not constants: other values move the boundaries', () => {
  const T = 1_000_000_000_000;
  assert.deepEqual(nextActions({ nowMs: T, lastScanAt: T - 1000, lastAuditAt: T - 10000, scanEveryMs: 1000, auditEveryMs: 10000 }), { scan: true, audit: true });
  assert.deepEqual(nextActions({ nowMs: T, lastScanAt: T - 999, lastAuditAt: T - 9999, scanEveryMs: 1000, auditEveryMs: 10000 }), { scan: false, audit: false });
});

// ------------------------------------------------------------------ 8. the publisher process, one scan
function runPublisher(base, dir, extra = []) {
  const key = path.join(dir, 'board.key'); fs.writeFileSync(key, 'sk-test-not-a-secret', { mode: 0o600 });
  const status = path.join(dir, 'publisher-status.json');
  const r = spawnSync(process.execPath, [PUBLISHER, '--board', base, '--key-file', key, '--status', status, '--once', ...extra], { encoding: 'utf8', timeout: 20000 });
  let st = null; try { st = JSON.parse(fs.readFileSync(status, 'utf8')); } catch { /* none */ }
  return { code: r.status, err: r.stderr, status: st };
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'c3b-pub-'));
test('S1 one scan publishes every pending entry, OLDEST FIRST, and writes the status file with all its fields', async () => {
  const items = [item('m-c', 'publisher', { at: '2026-10-04T12:03:00.000Z' }), item('m-a', 'publisher', { at: '2026-10-04T12:01:00.000Z' }), item('m-b', 'publisher', { at: '2026-10-04T12:02:00.000Z' })];
  await withServer(seeded(items), {}, async (s) => {
    const r = runPublisher(s.baseUrl, tmp());
    assert.equal(r.code, 0, r.err);
    const posts = await boardPosts(s.baseUrl);
    assert.deepEqual(posts.map((p) => p.origin?.mutationId), ['m-a', 'm-b', 'm-c'], 'oldest obligation first');
    const st = r.status;
    for (const k of ['checkedAt', 'lastScanCompletedAt']) assert.ok(Number.isFinite(Date.parse(st[k])), `${k}: ${st[k]}`);
    assert.equal(st.pendingCount, 0); assert.equal(st.oldestPendingAt, null); assert.equal(st.blockedCount, 0);
    assert.equal(st.lastError, null); assert.equal(st.auditIntegrityFailures, 0);
  });
});
test('S2 --batch bounds a scan: five pending, --batch 2 publishes the two OLDEST and reports the rest as pending', async () => {
  const items = ['e', 'd', 'c', 'b', 'a'].map((m, i) => item(`m-${m}`, 'publisher', { at: `2026-10-04T12:0${5 - i}:00.000Z` }));   // a is oldest
  await withServer(seeded(items), {}, async (s) => {
    const r = runPublisher(s.baseUrl, tmp(), ['--batch', '2']);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual((await boardPosts(s.baseUrl)).map((p) => p.origin?.mutationId), ['m-a', 'm-b']);
    assert.equal(r.status.pendingCount, 3);
    assert.equal(r.status.oldestPendingAt, '2026-10-04T12:03:00.000Z');
  });
});
test('S3 the status reports blocked entries and the audit\'s integrity failures, and a blocked entry does not make the scan fail', async () => {
  const items = [item('m-bad', 'legacy'), item('m-good', 'publisher')];
  const board = seeded(items);
  board.announcementOutbox.origins['m-gap'] = originOf('m-gap', 'publisher', ['claim', 'release']);     // an origin slot with no entry
  board.announcementOutbox.entries['m-gap:claim'] = entryFor('m-gap', 'publisher', { status: 'published', postId: 'p', publishedAt: T0 });
  await withServer(board, {}, async (s) => {
    const r = runPublisher(s.baseUrl, tmp());
    assert.equal(r.code, 0, r.err);
    assert.equal(r.status.blockedCount, 1);
    assert.equal(r.status.auditIntegrityFailures, 1);
    assert.equal((await entryOf(s.baseUrl, 'm-good:claim')).status, 'published');
  });
});
test('S4 an unreachable board is a non-zero exit, with the status file saying why', async () => {
  const port = await freePort();
  const r = runPublisher(`http://127.0.0.1:${port}`, tmp());
  assert.notEqual(r.code, 0);
  assert.equal(typeof r.status?.lastError, 'string'); assert.ok(r.status.lastError.length > 0);
});
