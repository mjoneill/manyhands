/**
 * #1592 (C5 step 1) — an immutable post sequence on the DOCUMENT path, flag off, with opt-in afterSeq/beforeSeq/tail
 * cursors. Pre-registered by the separate test author BEFORE the implementation exists. Copy unchanged into tests/ and
 * build to it; if the contract needs a change, the test changes first and the change is announced on #1592.
 *
 * WHY A SEQUENCE AND NOT A TIMESTAMP: every commons poller keys its since-cursor on a post's createdAt, so a post that
 * becomes visible LATE and carries an older time is skipped by every client whose cursor has moved on. The sequence is
 * assigned only when the post becomes visible, so a late post gets a HIGHER number than every cursor already served.
 *
 * NOT COVERED HERE, BY NAME: moving the pollers (conversation-view, the unread badge, guest-loop) onto the cursor: each is
 * a behaviour change with its own delayed-publication control, frozen separately; the MCP `conversation_list` field;
 * the GRAPH path (discovery by the executor's commitSeq, the reserve-41/commit-42/complete-41 control, rollback
 * materialisation and the cursor-epoch switch between the two domains); real redaction (a removed post is simulated by
 * editing a stopped board's file); board-status order; the done-nudge, wiki and rest/retire notices on an unmigrated board
 * (only claim and release go through the outbox today: what the others do must be identified before it is changed); power loss.
 *
 * CONTRACT PINNED HERE
 *   FIELD     every post carries an integer `postSeq`, strictly increasing and never reused (NOT promised gap-free:
 *             redaction can leave gaps). It appears in the POST response, the listing and GET by id. A client-sent postSeq is
 *             ignored.
 *   COUNTER   `nextPostSeq` and `postSeqEpoch` are top-level, server-owned board fields. A brand-new board needs no
 *             migration. The epoch is minted ONCE, lazily, by the first thing that needs it (the first post OR the first
 *             seq-mode request) and then PERSISTS (Q6b restarts the server between), so a token handed out on an empty board is
 *             still valid after the first post AND after a restart.
 *   OPT-IN    seq mode exists only when a request carries `afterSeq`, `beforeSeq` or `tail`. A request with NONE of them
 *             behaves EXACTLY as today (a bare array, uncapped without `limit`, the most recent N with `limit`, no cursor), so
 *             every existing caller is unchanged.
 *   CURSORS   a seq-mode response is the envelope {conversations, nextAfterSeq}.
 *             afterSeq=start      catch-up from the OLDEST post, ascending, at most `limit` (the bootstrap and the resync entry);
 *             afterSeq=<token>    posts with postSeq > n, ASCENDING, the OLDEST `limit` of them (a cursor never skips);
 *             beforeSeq=<token>   the MOST RECENT `limit` posts with postSeq < n, listed oldest first;
 *             tail=<n>            the most recent n, ascending, with nextAfterSeq at the newest of them (a first paint).
 *             nextAfterSeq is the token of the highest postSeq returned, the request's own token when nothing came back, and
 *             `ps1.<epoch>.0` for an empty board. A usable token ALWAYS comes back.
             The epoch is PERSISTED when first handed out, so a restart before the first post does not invalidate an issued token.
 *   MINT      concurrent first valid seq-mode requests share ONE durable epoch (Q6c: the mint re-checks inside the write lock).
 *   REFUSALS  a request refused with a 400 has NO side effect: it does not mint or persist the epoch (Q8b); only a request that gets
 *             past validation may. (A GET that writes exists at all only once per board, for the first valid seq-mode request.)
 *   REQUESTS  `tail` with `limit` -> 400 naming both; a non-integer or negative `tail` -> 400 `BAD_TAIL`; `beforeSeq=start` -> 400
 *             `UNKNOWN_CURSOR` (start means "from the oldest" and exists only for afterSeq).
 *   TOKEN     `ps1.<postSeqEpoch>.<n>`. A token from another epoch -> 409 `POST_CURSOR_EPOCH_CHANGED`, the body naming the current
 *             epoch and telling the client to resync with afterSeq=start. A malformed token -> 400 `UNKNOWN_CURSOR` (never read
 *             as a time). A request that would select TWO modes is a 400 naming the conflicting parameters, never a silent choice:
 *             afterSeq+beforeSeq, a seq param with since/before, and `tail` with any of afterSeq, beforeSeq, since or before.
 *   COMMIT    the number is allocated in the SAME document write that makes the post visible: a crash before it leaves neither the
 *             post nor an advanced counter, so the next post takes the number the lost one would have had.
 *   STATES    CLEAN UNMIGRATED (no epoch, no post has a postSeq key): posting behaves exactly as today (no number, no epoch minted), a valid
 *             seq-mode read is 409 `POST_SEQ_MIGRATION_REQUIRED` and writes nothing, no-cursor reads are served. VALID MIGRATED (an epoch, unique
 *             positive safe-integer postSeq on every post, a counter above every one). ANYTHING ELSE is CORRUPT (mixed numbering with no epoch, an
 *             epoch with un-numbered posts, a duplicate, a non-integer, a counter not above every sequence): the WHOLE mutation, a claim included,
 *             is refused BEFORE any event or document write with 500 `POST_SEQ_STATE_CORRUPT`, and a valid seq-mode read the same way; malformed or
 *             conflicting requests are still the 400s above (validation first). An empty board mints normally. Migration is an explicit step on a
 *             STOPPED file, never a side effect of a request or of start-up. The script numbers ONLY a clean unmigrated file; a corrupt one is refused
 *             with exit 3, the un-numbered ids listed, the file byte-identical, --dry-run the same; a fully migrated file is a no-op, exit 0.
 *   INTERNAL  a claim on a clean unmigrated board still commits AND posts its notice as today, with the REAL legacyPostId; migration then preserves
 *             the post and the proof. Nothing is skipped, logged-and-dropped, or blocked as legacy-proof-missing.
 *   ONE SITE  every post is appended by one function, pushPost (Q14 scans server.js): a stray append would corrupt a migrated board.
 *   MIGRATE   node scripts/migrate-post-seq-1592.mjs --board-file F [--dry-run] [--rollback], on a STOPPED board's file, in whatever
 *             shape the file has (the three fields are top-level keys). Only a CLEAN file (no postSeqEpoch AND no postSeq on any post, or an
 *             empty one) is numbered: postSeq = array index + 1, nextPostSeq = count + 1, a new postSeqEpoch (a UUID). A VALID MIGRATED file is
 *             left byte-for-byte alone: no renumbering of survivors after a removal, no reset of the counter. A corrupt one exits 3 (Q12b).
 *             --dry-run writes nothing. --rollback strips the three fields. Migrate, roll back, migrate: identical posts and seqs, a DIFFERENT epoch.
 *   BARRIER   env SCRUM_TEST_BARRIER_DIR with the fifo `after-events` (present since the C3a build).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { freePort, waitForHttp, makeBoardFixture, startRestServer, PROJECT_DIR } from './helpers/harness.mjs';

const MIGRATE = process.env.MIGRATE_POST_SEQ || path.join(PROJECT_DIR, 'scripts', 'migrate-post-seq-1592.mjs');
const TOKEN_RE = /^ps1\.[0-9a-f-]{36}\.\d+$/;
const epochOf = (token) => token.split('.')[1];

async function api(base, method, route, body) {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text, headers: res.headers };
}
const post = (base, body, author = 'ada') => api(base, 'POST', '/api/conversations', { body, author });
const list = (base, qs = '') => api(base, 'GET', `/api/conversations${qs}`);
const seqs = (r) => (Array.isArray(r.body) ? r.body : r.body.conversations).map((c) => c.postSeq);
const bodies = (r) => (Array.isArray(r.body) ? r.body : r.body.conversations).map((c) => c.body);
const tok = (t) => encodeURIComponent(t);

const T = (n) => `2026-10-0${n}T12:00:00.000Z`;
const conv = (id, body, createdAt, extra = {}) => ({ id, body, author: 'ada', attachedTo: null, attachments: [], mentions: [], createdAt, ...extra });
function boardFile(conversations) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps1592-'));
  const file = path.join(dir, 'board.json');
  fs.writeFileSync(file, JSON.stringify(makeBoardFixture({ conversations }), null, 2));
  return file;
}
function migrate(file, ...flags) {
  const r = spawnSync(process.execPath, [MIGRATE, '--board-file', file, ...flags], { encoding: 'utf8', timeout: 30000, cwd: PROJECT_DIR });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const readDoc = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
// startRestServer().stop() DELETES the board file it was given, even one the caller supplied. So the file's ACTUAL bytes are read just
// before teardown and written back after it: `file` stays on disk for the next migrate / rollback / edit AND carries whatever the server
// itself wrote (an epoch, a counter, a post), exactly as a stopped board's file would. Copying only before start-up would hide those.
async function withBoard(file, body) {
  const s = await startRestServer({ boardFile: file });
  try { return await body(s); }
  finally {
    let bytes = null;
    try { bytes = fs.readFileSync(file); } catch { /* the body removed it: nothing to keep */ }
    await s.stop();
    if (bytes) fs.writeFileSync(file, bytes);
  }
}
/** Page through a whole board in seq mode from afterSeq=start, following nextAfterSeq until a page comes back empty. */
async function drain(base, limit) {
  const got = []; let qs = `?afterSeq=start&limit=${limit}`;
  for (let guard = 0; guard < 50; guard++) {
    const r = await list(base, qs);
    assert.equal(r.status, 200, r.text);
    assert.match(r.body.nextAfterSeq, TOKEN_RE);
    if (r.body.conversations.length === 0) return { got, token: r.body.nextAfterSeq, last: r };
    got.push(...r.body.conversations);
    qs = `?afterSeq=${tok(r.body.nextAfterSeq)}&limit=${limit}`;
  }
  throw new Error('did not terminate');
}

// ------------------------------------------------------------------ 1. the field
test('Q1 a new board needs no migration: posts get postSeq 1, 2, 3 in the create response, the listing and GET by id', async () => {
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    const made = [];
    for (const b of ['one', 'two', 'three']) { const r = await post(s.baseUrl, b); assert.equal(r.status, 201, r.text); made.push(r.body); }
    assert.deepEqual(made.map((m) => m.postSeq), [1, 2, 3]);
    assert.deepEqual(seqs(await list(s.baseUrl)), [1, 2, 3]);
    assert.equal((await api(s.baseUrl, 'GET', `/api/conversations/${made[1].id}`)).body.postSeq, 2);
  } finally { await s.stop(); }
});
test('Q2 a client-sent postSeq is ignored, and numbering carries on', async () => {
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    await post(s.baseUrl, 'one');
    const r = await api(s.baseUrl, 'POST', '/api/conversations', { body: 'two', author: 'ada', postSeq: 99 });
    assert.equal(r.body.postSeq, 2);
    assert.equal((await post(s.baseUrl, 'three')).body.postSeq, 3);
  } finally { await s.stop(); }
});

// ------------------------------------------------------------------ 2. opt-in: nothing changes for a caller that asks for no cursor
test('Q3 with NO cursor parameter the listing is exactly as before: a bare array, uncapped, the most recent N under limit, no nextAfterSeq', async () => {
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    for (let i = 1; i <= 5; i++) await post(s.baseUrl, `p${i}`);
    const all = await list(s.baseUrl);
    assert.ok(Array.isArray(all.body), 'a bare array');
    assert.deepEqual(bodies(all), ['p1', 'p2', 'p3', 'p4', 'p5']);
    assert.equal(all.headers.get('x-total-count'), '5');
    assert.deepEqual(bodies(await list(s.baseUrl, '?limit=2')), ['p4', 'p5'], 'limit keeps meaning "the most recent N"');
    assert.equal(all.headers.get('x-next-after-seq'), null);
    assert.equal(all.body.nextAfterSeq, undefined);
  } finally { await s.stop(); }
});

// ------------------------------------------------------------------ 3. the cursors
test('Q4 afterSeq=start catches up from the OLDEST, a page at a time, with no skip and no repeat, and ends on an empty page that echoes the cursor', async () => {
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    for (let i = 1; i <= 7; i++) await post(s.baseUrl, `p${i}`);
    const first = await list(s.baseUrl, '?afterSeq=start&limit=3');
    assert.equal(first.status, 200, first.text);
    assert.ok(!Array.isArray(first.body), 'seq mode answers with the envelope');
    assert.deepEqual(bodies(first), ['p1', 'p2', 'p3'], 'the OLDEST three, not the latest three');
    assert.ok(first.body.nextAfterSeq.endsWith('.3'));
    const d = await drain(s.baseUrl, 3);
    assert.deepEqual(d.got.map((c) => c.body), ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'], 'every post exactly once');
    assert.ok(d.got.map((c) => c.postSeq).every((n, i, a) => i === 0 || n > a[i - 1]), 'ascending');
    assert.ok(d.token.endsWith('.7'));
    assert.equal(d.last.body.nextAfterSeq, d.token);
  } finally { await s.stop(); }
});
test('Q5 beforeSeq returns the most recent `limit` posts below the cursor, listed oldest first; tail=n returns the most recent n with a cursor at the newest', async () => {
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    for (let i = 1; i <= 6; i++) await post(s.baseUrl, `p${i}`);
    const epoch = epochOf((await list(s.baseUrl, '?afterSeq=start&limit=1')).body.nextAfterSeq);
    const before = await list(s.baseUrl, `?beforeSeq=${tok(`ps1.${epoch}.6`)}&limit=2`);
    assert.equal(before.status, 200, before.text);
    assert.deepEqual(seqs(before), [4, 5], 'the two most recent below 6, oldest first');
    const tail = await list(s.baseUrl, '?tail=2');
    assert.equal(tail.status, 200, tail.text);
    assert.deepEqual(seqs(tail), [5, 6]);
    assert.ok(tail.body.nextAfterSeq.endsWith('.6'));
    assert.deepEqual((await list(s.baseUrl, `?afterSeq=${tok(tail.body.nextAfterSeq)}`)).body.conversations, [], 'nothing newer than the tail');
  } finally { await s.stop(); }
});
test('Q6 an EMPTY board still hands out a usable cursor, and that token is still valid after the first post', async () => {
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    for (const qs of ['?afterSeq=start', '?tail=5']) {
      const r = await list(s.baseUrl, qs);
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(r.body.conversations, []);
      assert.match(r.body.nextAfterSeq, TOKEN_RE); assert.ok(r.body.nextAfterSeq.endsWith('.0'));
    }
    const t0 = (await list(s.baseUrl, '?afterSeq=start')).body.nextAfterSeq;
    await post(s.baseUrl, 'first');
    const r = await list(s.baseUrl, `?afterSeq=${tok(t0)}`);
    assert.equal(r.status, 200, `the epoch minted for an empty board must survive the first post: ${r.text}`);
    assert.deepEqual(bodies(r), ['first']);
  } finally { await s.stop(); }
});

test('Q6b the epoch handed out on an EMPTY board is PERSISTED: a restart before the first post does not invalidate the token', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps1592-empty-'));
  const file = path.join(dir, 'board.json'); fs.writeFileSync(file, JSON.stringify(makeBoardFixture(), null, 2));
  const barrierDir = path.join(dir, 'barriers'); fs.mkdirSync(barrierDir);
  let a, b;
  try {
    a = await spawnServer(file, barrierDir);
    const t0 = (await list(a.base, '?afterSeq=start')).body.nextAfterSeq;
    assert.match(t0, TOKEN_RE); assert.ok(t0.endsWith('.0'));
    a.stop();
    b = await spawnServer(file, barrierDir);
    const r = await list(b.base, `?afterSeq=${tok(t0)}`);
    assert.equal(r.status, 200, `a token issued before a restart must still be good (restart-invalidating a handed-out cursor is a contract change): ${r.text}`);
    assert.deepEqual(r.body.conversations, []);
    assert.equal(r.body.nextAfterSeq, t0);
    await post(b.base, 'first');
    assert.deepEqual(bodies(await list(b.base, `?afterSeq=${tok(t0)}`)), ['first']);
  } finally { a?.stop(); b?.stop(); }
});

test('Q6c six CONCURRENT first seq-mode requests on a board with no epoch all see the SAME epoch (one durable mint, not several)', async () => {
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    const rs = await Promise.all([1, 2, 3, 4, 5, 6].map(() => list(s.baseUrl, '?afterSeq=start')));
    for (const r of rs) assert.equal(r.status, 200, r.text);
    assert.equal(new Set(rs.map((r) => epochOf(r.body.nextAfterSeq))).size, 1, 'one epoch for every concurrent caller');
    const later = await list(s.baseUrl, '?afterSeq=start');
    assert.equal(epochOf(later.body.nextAfterSeq), epochOf(rs[0].body.nextAfterSeq), 'and it is the one that persisted');
  } finally { await s.stop(); }
});

// ------------------------------------------------------------------ 4. the decisive control
test('Q7 (decisive) a post that becomes visible LATE, with a createdAt OLDER than the consumer\'s cursor, is fetched by afterSeq exactly once, while a time cursor misses it', async () => {
  const file = boardFile([conv('c1', 'old one', T(1)), conv('c2', 'future-dated', '2099-01-01T00:00:00.000Z')]);
  assert.equal(migrate(file).code, 0);
  await withBoard(file, async (s) => {
    const caughtUp = await drain(s.baseUrl, 10);
    assert.deepEqual(caughtUp.got.map((c) => c.postSeq), [1, 2]);
    const late = await post(s.baseUrl, 'published late');
    assert.equal(late.body.postSeq, 3);
    const tsCursor = '2099-01-01T00:00:00.000Z';
    assert.deepEqual((await list(s.baseUrl, `?since=${tok(tsCursor)}&limit=5`)).body.map((c) => c.body), ['future-dated'], 'the legacy time cursor skips the late post: that is the gap');
    const viaSeq = await list(s.baseUrl, `?afterSeq=${tok(caughtUp.token)}`);
    assert.deepEqual(bodies(viaSeq), ['published late'], 'the sequence cursor finds it');
    const again = await list(s.baseUrl, `?afterSeq=${tok(viaSeq.body.nextAfterSeq)}`);
    assert.deepEqual(again.body.conversations, [], 'and only once');
  });
});

// ------------------------------------------------------------------ 5. tokens and parameters
test('Q8 a malformed token is 400 UNKNOWN_CURSOR and is never read as a time; combinations that mean two things are 400 naming both', async () => {
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    await post(s.baseUrl, 'one');
    const epoch = epochOf((await list(s.baseUrl, '?afterSeq=start')).body.nextAfterSeq);
    for (const bad of ['garbage', '7', '2026-10-04T12:00:00.000Z', 'ps1.', `ps1.${epoch}.x`, `ps1.${epoch}.-1`, `ps1.${epoch}`, `ps2.${epoch}.1`]) {
      for (const p of ['afterSeq', 'beforeSeq']) {
        const r = await list(s.baseUrl, `?${p}=${tok(bad)}`);
        assert.equal(r.status, 400, `${p}=${bad}: ${r.text}`);
        assert.equal(r.body.code, 'UNKNOWN_CURSOR');
      }
    }
    const good = `ps1.${epoch}.1`;
    const both = await list(s.baseUrl, `?afterSeq=${tok(good)}&beforeSeq=${tok(good)}`);
    assert.equal(both.status, 400, both.text);
    assert.match(JSON.stringify(both.body), /afterSeq/); assert.match(JSON.stringify(both.body), /beforeSeq/);
    for (const [seqParam, timeParam] of [['afterSeq', 'since'], ['beforeSeq', 'before'], ['afterSeq', 'before']]) {
      const r = await list(s.baseUrl, `?${seqParam}=${tok(good)}&${timeParam}=2030-01-01T00:00:00.000Z`);
      assert.equal(r.status, 400, `${seqParam}+${timeParam}: ${r.text}`);
      assert.match(JSON.stringify(r.body), new RegExp(seqParam)); assert.match(JSON.stringify(r.body), new RegExp(timeParam));
    }
    for (const other of [`afterSeq=${tok(good)}`, `beforeSeq=${tok(good)}`, 'since=2026-01-01T00:00:00.000Z', 'before=2030-01-01T00:00:00.000Z']) {
      const r = await list(s.baseUrl, `?tail=2&${other}`);
      assert.equal(r.status, 400, `tail + ${other}: ${r.text}`);
      assert.match(JSON.stringify(r.body), /tail/); assert.match(JSON.stringify(r.body), new RegExp(other.split('=')[0]));
    }
    const withLimit = await list(s.baseUrl, '?tail=2&limit=5');
    assert.equal(withLimit.status, 400, withLimit.text);
    assert.match(JSON.stringify(withLimit.body), /tail/); assert.match(JSON.stringify(withLimit.body), /limit/);
    for (const badTail of ['x', '1.5', '-1', '']) {
      const r = await list(s.baseUrl, `?tail=${encodeURIComponent(badTail)}`);
      assert.equal(r.status, 400, `tail=${JSON.stringify(badTail)}: ${r.text}`);
      assert.equal(r.body.code, 'BAD_TAIL');
    }
    const beforeStart = await list(s.baseUrl, '?beforeSeq=start');
    assert.equal(beforeStart.status, 400, 'start is the entry point for afterSeq only: beforeSeq=start has no meaning');
    assert.equal(beforeStart.body.code, 'UNKNOWN_CURSOR');
    assert.equal((await list(s.baseUrl, '?since=2026-01-01T00:00:00.000Z')).status, 200, 'time cursors on their own still work (compatibility)');
  } finally { await s.stop(); }
});
test('Q8b a REFUSED request has no side effects: on a board with no epoch yet, malformed and conflicting seq-mode requests are 400 and leave the board file byte-identical', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps1592-refused-'));
  const file = path.join(dir, 'board.json'); fs.writeFileSync(file, JSON.stringify(makeBoardFixture(), null, 2));
  const barrierDir = path.join(dir, 'barriers'); fs.mkdirSync(barrierDir);
  let a;
  try {
    a = await spawnServer(file, barrierDir);
    const settled = fs.readFileSync(file);                                        // after start-up, before any seq-mode request
    const refused = ['?afterSeq=garbage', '?beforeSeq=garbage', '?beforeSeq=start', '?tail=x', '?tail=2&limit=5', '?afterSeq=start&beforeSeq=start', '?tail=2&since=2026-01-01T00:00:00.000Z', '?afterSeq=start&since=2026-01-01T00:00:00.000Z'];
    for (const qs of refused) {
      const r = await list(a.base, qs);
      assert.equal(r.status, 400, `${qs}: ${r.text}`);
    }
    assert.deepEqual(fs.readFileSync(file), settled, 'refusing a request must not mint or persist an epoch (a GET that is refused writes nothing)');
    const ok = await list(a.base, '?afterSeq=start');
    assert.equal(ok.status, 200, ok.text);
    assert.notDeepEqual(fs.readFileSync(file), settled, 'and the first VALID seq-mode request does persist it');
  } finally { a?.stop(); }
});

// ---- the migration boundary. THREE states, and nothing else:
//   CLEAN UNMIGRATED  no postSeqEpoch and no post has a `postSeq` key: posting behaves exactly as today (no number, no epoch),
//                     a valid seq-mode read is 409 POST_SEQ_MIGRATION_REQUIRED and writes nothing.
//   VALID MIGRATED    an epoch, unique positive safe-integer postSeq on every post, a counter above every one: numbering as built.
//   ANYTHING ELSE     (mixed numbering with no epoch, an epoch with un-numbered posts, a duplicate, a non-integer, a counter that is not
//                     above every sequence): CORRUPT. The WHOLE mutation is refused before any event or document write, 500
//                     POST_SEQ_STATE_CORRUPT, file byte-identical; a valid seq-mode read is refused the same way.
const T3 = () => [conv('c1', 'old one', T(1)), conv('c2', 'old two', T(2)), conv('c3', 'old three', T(3))];
const ids = (r) => (Array.isArray(r.body) ? r.body : r.body.conversations).map((c) => c.id);
function fileFor(conversations, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps1592-mig-'));
  const file = path.join(dir, 'board.json');
  fs.writeFileSync(file, JSON.stringify(makeBoardFixture({ conversations, ...extra }), null, 2));
  const barrierDir = path.join(dir, 'barriers'); fs.mkdirSync(barrierDir);
  return { dir, file, barrierDir };
}
const EPOCH = '11111111-2222-4333-8444-555555555555';
const CORRUPT_BOARDS = [
  ['mixed numbering and NO epoch', () => fileFor([conv('c1', 'a', T(1), { postSeq: 1 }), conv('c2', 'b', T(2)), conv('c3', 'c', T(3), { postSeq: 2 })])],
  ['an epoch and a counter, but a post has no number', () => fileFor([conv('c1', 'a', T(1), { postSeq: 1 }), conv('c2', 'b', T(2))], { postSeqEpoch: EPOCH, nextPostSeq: 3 })],
  ['an epoch, but NO post is numbered', () => fileFor(T3(), { postSeqEpoch: EPOCH, nextPostSeq: 1 })],
  ['a duplicate postSeq', () => fileFor([conv('c1', 'a', T(1), { postSeq: 1 }), conv('c2', 'b', T(2), { postSeq: 1 })], { postSeqEpoch: EPOCH, nextPostSeq: 2 })],
  ['a postSeq that is not an integer', () => fileFor([conv('c1', 'a', T(1), { postSeq: '1' }), conv('c2', 'b', T(2), { postSeq: 2 })], { postSeqEpoch: EPOCH, nextPostSeq: 3 })],
  ['a counter that is not above every sequence', () => fileFor([conv('c1', 'a', T(1), { postSeq: 1 }), conv('c2', 'b', T(2), { postSeq: 2 })], { postSeqEpoch: EPOCH, nextPostSeq: 2 })],
];
for (const [label, make] of CORRUPT_BOARDS) {
  test(`Q12 corrupt (${label}): the whole mutation is 500 POST_SEQ_STATE_CORRUPT with the file byte-identical; valid seq reads too; malformed ones stay 400; no-cursor reads are served`, async () => {
    const { file, barrierDir } = make();
    let a;
    try {
      a = await spawnServer(file, barrierDir);
      const card = (await api(a.base, 'POST', '/api/cards', { title: 'claim me', description: 'x', createdBy: 'ada' })).body;   // a card is not a post: it commits
      assert.ok(card?.id, 'precondition: card creation is not refused');
      const settled = fs.readFileSync(file);
      const before = await list(a.base);
      assert.equal(before.status, 200, before.text);
      assert.ok(Array.isArray(before.body), 'a no-cursor read is the bare array it always was');
      const create = await post(a.base, 'must be refused');
      assert.equal(create.status, 500, create.text);
      assert.equal(create.body.code, 'POST_SEQ_STATE_CORRUPT');
      const claim = await api(a.base, 'POST', `/api/cards/${card.id}/claim`, { by: 'ada' });
      assert.equal(claim.status, 500, `an internal announcement must be refused WITH its change, not after it committed: ${claim.text}`);
      assert.equal(claim.body.code, 'POST_SEQ_STATE_CORRUPT');
      for (const qs of ['?afterSeq=start', '?tail=2', '?afterSeq=start&limit=2']) {
        const r = await list(a.base, qs);
        assert.equal(r.status, 500, `${qs}: ${r.text}`);
        assert.equal(r.body.code, 'POST_SEQ_STATE_CORRUPT');
      }
      for (const qs of ['?afterSeq=garbage', '?tail=x', '?afterSeq=start&beforeSeq=start']) assert.equal((await list(a.base, qs)).status, 400, `${qs}: validation comes before the state check`);
      assert.deepEqual(fs.readFileSync(file), settled, 'a refused mutation writes nothing: no event, no epoch, no counter, no claim, no obligation');
      assert.equal((await api(a.base, 'GET', `/api/cards/${card.id}`)).body.claimedBy ?? null, null, 'the claim did not commit');
      assert.deepEqual((await api(a.base, 'GET', '/api/outbox')).body, { origins: [], entries: [] });
      const after = await list(a.base);
      assert.equal(after.status, 200); assert.deepEqual(after.body, before.body, 'no-cursor reads are served exactly as before');
      assert.equal((await list(a.base, '?limit=2')).status, 200);
    } finally { a?.stop(); }
  });
}
test('Q12a CLEAN unmigrated: posts append exactly as today (no number, NO epoch), a valid seq read is 409 POST_SEQ_MIGRATION_REQUIRED with the file byte-identical, and migration then numbers every post, the new ones included, in array order', async () => {
  const { file, barrierDir } = fileFor(T3());
  let a;
  try {
    a = await spawnServer(file, barrierDir);
    const made = await post(a.base, 'posted before the migration');
    assert.equal(made.status, 201, made.text);
    assert.equal(made.body.postSeq, undefined, 'no number is allocated on an unmigrated board');
    assert.ok(!/postSeqEpoch/.test(fs.readFileSync(file, 'utf8')), 'and no epoch is minted: minting on top of un-numbered posts is the hazard');
    const settled = fs.readFileSync(file);
    for (const qs of ['?afterSeq=start', '?tail=2']) {
      const r = await list(a.base, qs);
      assert.equal(r.status, 409, `${qs}: ${r.text}`);
      assert.equal(r.body.code, 'POST_SEQ_MIGRATION_REQUIRED');
    }
    for (const qs of ['?afterSeq=garbage', '?tail=x']) assert.equal((await list(a.base, qs)).status, 400);
    assert.deepEqual(fs.readFileSync(file), settled, 'a refused read writes nothing');
    assert.deepEqual(bodies(await list(a.base)), ['old one', 'old two', 'old three', 'posted before the migration'], 'no-cursor reads are exactly as before');
    a.stop();
  } finally { a?.stop(); }
  assert.equal(migrate(file).code, 0, 'the clean file migrates');
  await withBoard(file, async (s) => {
    const d = await drain(s.baseUrl, 10);
    assert.deepEqual(d.got.map((c) => c.body), ['old one', 'old two', 'old three', 'posted before the migration']);
    assert.deepEqual(d.got.map((c) => c.postSeq), [1, 2, 3, 4], 'every post, the one posted during the unmigrated window included, in array order');
    assert.equal((await post(s.baseUrl, 'after')).body.postSeq, 5);
  });
});
test('Q12b the migration script refuses every CORRUPT file (exit 3, the un-numbered post ids listed where there are any, the file byte-identical, --dry-run the same), and migrates a clean one', async () => {
  for (const [label, make] of CORRUPT_BOARDS) {
    const { file } = make();
    const before = fs.readFileSync(file);
    const r = migrate(file);
    assert.equal(r.code, 3, `${label}: ${r.out}${r.err}`);
    const said = `${r.out}${r.err}`;
    assert.ok(said.trim().length > 0, `${label}: a refusal says why`);
    for (const c of JSON.parse(before.toString('utf8')).conversations.filter((x) => x.postSeq === undefined)) {
      if (label.includes('NO epoch') || label.includes('has no number') || label.includes('NO post is numbered')) assert.ok(said.includes(c.id), `${label}: the un-numbered id ${c.id} must be listed: ${said}`);
    }
    assert.deepEqual(fs.readFileSync(file), before, `${label}: a refused migration writes nothing`);
    assert.equal(migrate(file, '--dry-run').code, 3, `${label}: --dry-run reports the same refusal`);
  }
  const { file } = fileFor(T3());
  assert.equal(migrate(file).code, 0);
  assert.equal(migrate(file).code, 0, 'a fully migrated file is a no-op, exit 0');
});
test('Q13 a CLAIM on a clean unmigrated board retains its notice: the claim commits, the notice exists, its obligation carries the REAL legacyPostId, publication verifies it, and migration preserves both the post and the proof', async () => {
  const { file, barrierDir } = fileFor(T3());
  let a, b;
  try {
    a = await spawnServer(file, barrierDir);
    const card = (await api(a.base, 'POST', '/api/cards', { title: 'claim me', description: 'x', createdBy: 'ada' })).body;
    const claim = await api(a.base, 'POST', `/api/cards/${card.id}/claim`, { by: 'ada' });
    assert.equal(claim.status, 200, `a claim must never fail because the commons is not migrated: ${claim.text}`);
    assert.equal((await api(a.base, 'GET', `/api/cards/${card.id}`)).body.claimedBy, 'ada');
    const notices = (await list(a.base)).body.filter((c) => c.author === 'board');
    assert.equal(notices.length, 1, 'the notice exists, posted as today');
    assert.equal(notices[0].postSeq, undefined, 'and it is un-numbered until the migration');
    const ob = (await api(a.base, 'GET', '/api/outbox')).body;
    const [e] = ob.entries;
    assert.equal(e.mode, 'legacy'); assert.equal(e.legacyPostId, notices[0].id, 'the obligation carries the REAL proof, not a missing one');
    const pub = await api(a.base, 'POST', `/api/outbox/${encodeURIComponent(e.obligationId)}/publish`, {});
    assert.equal(pub.body.status, 'published', `publication verifies the proof, never blocked as legacy-proof-missing: ${pub.text}`);
    a.stop();
    assert.equal(migrate(file).code, 0);
    b = await spawnServer(file, barrierDir);
    const after = (await list(b.base)).body;
    const kept = after.find((c) => c.id === notices[0].id);
    assert.ok(kept, 'migration preserved the notice'); assert.ok(Number.isSafeInteger(kept.postSeq), 'and numbered it');
    assert.deepEqual(after.map((c) => c.postSeq), [1, 2, 3, 4], 'array order, the notice last');
    const again = await api(b.base, 'POST', `/api/outbox/${encodeURIComponent(e.obligationId)}/publish`, {});
    assert.equal(again.body.status, 'published', 'the proof survived the migration');
    assert.equal((await list(b.base)).body.filter((c) => c.author === 'board').length, 1, 'still exactly one notice');
  } finally { a?.stop(); b?.stop(); }
});
test('Q14 (structural) no code path appends a post except through pushPost: a stray `conversations.push(` would make a migrated board corrupt, and then every post is refused', () => {
  const src = fs.readFileSync(path.join(PROJECT_DIR, 'server.js'), 'utf8');
  const start = src.indexOf('function pushPost(');
  assert.ok(start >= 0, 'server.js must define pushPost(...), the one place a post is appended and numbered');
  let depth = 0, end = -1;
  for (let k = src.indexOf('{', start); k < src.length; k++) { if (src[k] === '{') depth++; else if (src[k] === '}' && --depth === 0) { end = k; break; } }
  assert.ok(end > start, 'could not find the end of pushPost');
  const outside = src.slice(0, start) + src.slice(end);
  const strays = [...outside.matchAll(/\bconversations\s*\.\s*(push|unshift|splice)\s*\(/g)].map((m) => `${m[0]} at offset ${m.index}`);
  assert.deepEqual(strays, [], 'a post appended outside pushPost bypasses numbering and the corruption check');
  assert.match(src.slice(start, end), /conversations\s*\.\s*push\s*\(/, 'pushPost itself is where the append happens');
});

test('Q9 a token from another EPOCH is 409 POST_CURSOR_EPOCH_CHANGED naming the current epoch and afterSeq=start; the same epoch with a higher number is a plain empty page', async () => {
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    await post(s.baseUrl, 'one');
    const epoch = epochOf((await list(s.baseUrl, '?afterSeq=start')).body.nextAfterSeq);
    for (const p of ['afterSeq', 'beforeSeq']) {
      const r = await list(s.baseUrl, `?${p}=${tok('ps1.00000000-0000-4000-8000-000000000000.1')}`);
      assert.equal(r.status, 409, r.text);
      assert.equal(r.body.code, 'POST_CURSOR_EPOCH_CHANGED');
      assert.ok(JSON.stringify(r.body).includes(epoch), 'the body names the current epoch');
      assert.match(JSON.stringify(r.body), /afterSeq=start/);
    }
    const ahead = await list(s.baseUrl, `?afterSeq=${tok(`ps1.${epoch}.50`)}`);
    assert.equal(ahead.status, 200); assert.deepEqual(ahead.body.conversations, []);
  } finally { await s.stop(); }
});

// ------------------------------------------------------------------ 6. the counter survives a save, and a crash before the commit
test('Q10 a real /api/save does not disturb the counter: numbering continues with no reuse, whatever the body carried', async () => {
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    await post(s.baseUrl, 'one'); await post(s.baseUrl, 'two');
    const c = (await api(s.baseUrl, 'POST', '/api/cards', { title: 'retitle me', description: 'x', createdBy: 'ada' })).body;
    const snap = (await api(s.baseUrl, 'GET', '/api/board')).body;
    const save = await api(s.baseUrl, 'POST', '/api/save', { cards: snap.cards.map((x) => (x.id === c.id ? { ...x, title: 'retitled' } : x)), columns: snap.columns, nextShortId: snap.nextShortId, nextPostSeq: 1, postSeqEpoch: 'forged' });
    assert.ok(save.status < 400, save.text);
    assert.equal((await api(s.baseUrl, 'GET', `/api/cards/${c.id}`)).body.title, 'retitled', 'the save really wrote');
    assert.equal((await post(s.baseUrl, 'three')).body.postSeq, 3, 'no reuse, no reset');
    assert.deepEqual(seqs(await list(s.baseUrl)), [1, 2, 3]);
  } finally { await s.stop(); }
});
test('Q10b a /api/save body carrying extra, un-numbered or re-numbered conversations, and a forged counter and epoch, leaves the server\'s conversations, every postSeq, the epoch and the counter exactly as they were', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps1592-save-'));
  const file = path.join(dir, 'board.json'); fs.writeFileSync(file, JSON.stringify(makeBoardFixture(), null, 2));
  const barrierDir = path.join(dir, 'barriers'); fs.mkdirSync(barrierDir);
  let a;
  try {
    a = await spawnServer(file, barrierDir);
    await post(a.base, 'one'); await post(a.base, 'two'); await post(a.base, 'three');
    // The server rewrites a legacy file as JSON-LD on its first save, so the stored state is read in WHICHEVER shape the file now has:
    // the posts are the document's Comment nodes (or its `conversations`), the counter and epoch live on `scrum:meta` (or top level).
    const state = () => {
      const d = readDoc(file), ld = Array.isArray(d['@graph']), meta = ld ? (d['scrum:meta'] || {}) : d;
      return { posts: ld ? d['@graph'].filter((e) => e && e['@type'] === 'Comment') : d.conversations, nextPostSeq: meta.nextPostSeq, postSeqEpoch: meta.postSeqEpoch };
    };
    const before = state();
    assert.equal(before.posts?.length, 3, 'precondition: the reader sees the three stored posts'); assert.ok(before.postSeqEpoch, 'and the epoch'); assert.equal(before.nextPostSeq, 4, 'and the counter');
    const snap = (await api(a.base, 'GET', '/api/board')).body;
    const seen = (await list(a.base)).body;
    const hostile = [
      conv('smuggled', 'an un-numbered post a snapshot tried to introduce', T(4)),
      { ...seen[0], postSeq: 99 },
      { ...seen[1], postSeq: 1 },
    ];
    for (const extra of [{ conversations: hostile }, { conversations: [] }, { conversations: null }, { conversations: hostile, nextPostSeq: 1, postSeqEpoch: 'forged' }]) {
      const save = await api(a.base, 'POST', '/api/save', { cards: snap.cards, columns: snap.columns, nextShortId: snap.nextShortId, ...extra });
      assert.ok(save.status < 500, save.text);   // refused or ignored are both fine; what matters is the state
      assert.deepEqual(state(), before, `${JSON.stringify(Object.keys(extra))}: a save must not introduce, remove or renumber a post, or touch the epoch or counter`);
    }
    assert.deepEqual(seqs(await list(a.base)), [1, 2, 3]);
    assert.equal((await post(a.base, 'four')).body.postSeq, 4, 'numbering carries on');
  } finally { a?.stop(); }
});

async function spawnServer(file, barrierDir) {
  const port = await freePort();
  const env = { ...process.env, SCRUM_BOARD_FILE: file, SCRUM_PORT: String(port), SCRUM_MCP_NOTIFY_URL: '', SCRUM_ATTACHMENTS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'ps1592-attach-')),
    SCRUM_CHANNEL_CONFIG_FILE: path.join(os.tmpdir(), `ps1592-chan-${process.pid}-${port}.json`), SCRUM_INSTANCE_ID: `ps1592-${port}`, SCRUM_TEST_BARRIER_DIR: barrierDir };
  const child = spawn('node', ['server.js'], { cwd: PROJECT_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const err = []; child.stderr.on('data', (d) => err.push(String(d)));
  const base = `http://127.0.0.1:${port}`;
  await waitForHttp(`${base}/api/board`, 15000);
  return { child, base, stop: () => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, stderr: () => err.join('') };
}
test('Q11 a crash AFTER the event append and BEFORE the document write leaves no post and an UNADVANCED counter: the next post takes the lost one\'s number', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps1592-crash-'));
  const file = path.join(dir, 'board.json'); fs.writeFileSync(file, JSON.stringify(makeBoardFixture(), null, 2));
  const barrierDir = path.join(dir, 'barriers'); fs.mkdirSync(barrierDir);
  let a, b;
  try {
    a = await spawnServer(file, barrierDir);
    assert.equal((await post(a.base, 'one')).body.postSeq, 1);
    assert.equal((await post(a.base, 'two')).body.postSeq, 2);
    const fifo = path.join(barrierDir, 'after-events');
    assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
    const inflight = post(a.base, 'lost').then((r) => ({ status: r.status }), (e) => ({ reset: String(e?.message || e) }));
    let fh = null;
    const reached = await Promise.race([fsp.open(fifo, 'w').then((h) => { fh = h; return true; }), new Promise((r) => setTimeout(() => r(false), 8000))]);
    if (!reached) { try { fs.closeSync(fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)); } catch { /* none */ } }
    a.stop();
    const seen = await Promise.race([inflight, new Promise((r) => setTimeout(() => r({ timeout: true }), 8000))]);
    try { await fh?.close(); } catch { /* ignore */ }
    fs.rmSync(fifo, { force: true });
    assert.equal(reached, true, `the server never reached the after-events barrier: ${a.stderr().slice(-300)}`);
    assert.ok(seen.reset !== undefined || seen.timeout || seen.status >= 500, `the client must not be told it succeeded: ${JSON.stringify(seen)}`);
    b = await spawnServer(file, barrierDir);
    assert.deepEqual(bodies(await list(b.base)), ['one', 'two'], 'the lost post is not visible');
    assert.equal((await post(b.base, 'after the crash')).body.postSeq, 3, 'the counter never advanced: the number is the one the lost post would have had');
    assert.deepEqual(seqs(await list(b.base)), [1, 2, 3]);
  } finally { a?.stop(); b?.stop(); }
});

// ------------------------------------------------------------------ 7. migration
test('M1 migrate assigns postSeq = index + 1 in array order, sets nextPostSeq and a UUID epoch, and the server then continues from there', async () => {
  const file = boardFile([conv('c1', 'first', T(3)), conv('c2', 'second', T(1)), conv('c3', 'third', T(2)), conv('c4', 'fourth', T(4))]);   // array order is NOT time order
  const m = migrate(file);
  assert.equal(m.code, 0, m.err);
  await withBoard(file, async (s) => {
    const r = await list(s.baseUrl);
    assert.deepEqual(bodies(r), ['first', 'second', 'third', 'fourth'], 'today\'s order is kept exactly');
    assert.deepEqual(seqs(r), [1, 2, 3, 4]);
    const d = await drain(s.baseUrl, 10);
    assert.match(d.token, TOKEN_RE); assert.ok(d.token.endsWith('.4'));
    assert.equal((await post(s.baseUrl, 'fifth')).body.postSeq, 5, 'nextPostSeq = count + 1');
  });
});
test('M2 --dry-run changes nothing, and a second migrate leaves the file byte-for-byte alone (same epoch, same seqs)', async () => {
  const file = boardFile([conv('c1', 'a', T(1)), conv('c2', 'b', T(2))]);
  const before = fs.readFileSync(file);
  assert.equal(migrate(file, '--dry-run').code, 0);
  assert.deepEqual(fs.readFileSync(file), before, '--dry-run must not write');
  assert.equal(migrate(file).code, 0);
  const once = fs.readFileSync(file);
  assert.notDeepEqual(once, before, 'the real migrate wrote');
  assert.equal(migrate(file).code, 0);
  assert.deepEqual(fs.readFileSync(file), once, 'idempotent: nothing, not even the epoch, changes on a second run');
});
test('M3 migrate, remove a post, migrate again: the survivors keep their numbers and the counter is NOT reset', async () => {
  const file = boardFile([conv('c1', 'a', T(1)), conv('c2', 'b', T(2)), conv('c3', 'c', T(3))]);
  assert.equal(migrate(file).code, 0);
  const doc = readDoc(file);
  assert.ok(Array.isArray(doc.conversations), 'the migration keeps the file\'s own shape (legacy stays legacy)');
  doc.conversations = doc.conversations.filter((c) => c.id !== 'c2');                 // a redaction leaves a gap
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
  const afterRemoval = fs.readFileSync(file);
  assert.equal(migrate(file).code, 0);
  assert.deepEqual(fs.readFileSync(file), afterRemoval, 'an already-migrated file is left alone: no renumbering, no reset to count + 1');
  await withBoard(file, async (s) => {
    assert.deepEqual(seqs(await list(s.baseUrl)), [1, 3], 'the survivors keep 1 and 3: sequences are not gap-free');
    assert.equal((await post(s.baseUrl, 'next')).body.postSeq, 4, 'the counter was 4 and stays 4: the removed 2 is never reused');
  });
});
test('M4 migrate, roll back, migrate: identical posts and seqs, a DIFFERENT epoch, and a token from the first epoch is refused', async () => {
  const file = boardFile([conv('c1', 'a', T(1)), conv('c2', 'b', T(2)), conv('c3', 'c', T(3))]);
  assert.equal(migrate(file).code, 0);
  let first, firstToken;
  await withBoard(file, async (s) => { first = await list(s.baseUrl); firstToken = (await list(s.baseUrl, '?afterSeq=start')).body.nextAfterSeq; });
  assert.equal(migrate(file, '--rollback').code, 0);
  await withBoard(file, async (s) => {
    const r = await list(s.baseUrl);
    assert.deepEqual(bodies(r), ['a', 'b', 'c'], 'rolling back loses no post');
    assert.ok(r.body.every((c) => c.postSeq === undefined), 'rollback strips postSeq');
  });
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!/nextPostSeq|postSeqEpoch/.test(raw), 'rollback strips the counter and the epoch from the document');
  assert.equal(migrate(file).code, 0);
  await withBoard(file, async (s) => {
    const r = await list(s.baseUrl);
    assert.deepEqual(r.body, first.body, 'posts and seqs are identical to the first migration');
    const token = (await list(s.baseUrl, '?afterSeq=start&limit=1')).body.nextAfterSeq;
    assert.notEqual(epochOf(token), epochOf(firstToken), 'but the epoch is new');
    const stale = await list(s.baseUrl, `?afterSeq=${tok(firstToken)}`);
    assert.equal(stale.status, 409, stale.text);
    assert.equal(stale.body.code, 'POST_CURSOR_EPOCH_CHANGED');
  });
});
