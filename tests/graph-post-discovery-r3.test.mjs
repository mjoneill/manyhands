/**
 * R3 — GRAPH POST DISCOVERY BY COMMIT ORDER. ⚠ ENDPOINT AND MODULE SUBSTRATE ONLY. Pre-registered by the separate test author BEFORE it exists. Copy
 * unchanged into tests/ and build to it; if the contract needs a change the test changes first and the change is announced on #1574.
 * REAL executor (a python with pyoxigraph); without one every test is SKIPPED, and a skip is NOT a pass.
 *
 * ⚠ THIS FILE IS NOT R3's ACCEPTANCE. R3 is done only when the three promised consumers (the commons reader `conversation-view`, the unread badge
 * `commons-panel`, the resident mention scan `guest-loop`) each demonstrate discovery on a real runtime. Those are the `todo` rows at the end and a
 * separate addendum. A green run of this file proves the endpoint and its cursor, nothing about any consumer. The production graph flag stays OFF.
 *
 * WHY: every commons poller keys on a post's createdAt, so a post that BECOMES VISIBLE LATE with an older time or a lower postSeq is skipped by every
 * client whose cursor has moved on. Discovery position here is the executor's durable `commitSeq`. `postSeq` stays the DISPLAY order.
 *
 * CONTRACT PINNED HERE (settled in the #1574 thread; the spec is diagnostics/unit2-r3-20261005/graph-post-discovery-contract.md, hash 8c8b10f1…)
 *   ROUTE     GET /api/conversations?afterCommit=<token>[&limit=n][&mentions_me=<name>][&attachedTo=<id>][&conversation=<id>], FLAG ON ONLY
 *             (SCRUM_GRAPH_UNIT_CONVERSATIONS=1). Flag OFF: 400 and the executor is never contacted. Combining afterCommit with since, before, afterSeq,
 *             beforeSeq or tail: 400 naming both parameters. Existing document-path parameters are untouched.
 *   TOKENS    live       gc1.<incarnation>.<epoch>.<commitSeq>.<scope>          bootstrap  gb1.<incarnation>.<epoch>.<B>.<lastPostSeq>.<scope>
 *             incarnation = the executor's incarnation UUID, epoch = its epoch integer. <scope> = the FULL sha256 (64 hex) of the CANONICAL JSON
 *             {"v":1,"mentions_me":<name lowercased, or null>,"attachedTo":<id or null>,"conversation":<id or null>}  (that field order, explicit nulls, no
 *             truncation, no sentinel string; recomputed independently here). The scope establishes filter CONTINUITY, not authorization.
 *             `afterCommit=start` begins a bootstrap. A request whose filters hash to a different scope than the token's: 400 CURSOR_FILTER_MISMATCH.
 *   RESPONSE  {conversations: [...], phase: 'bootstrap'|'live', nextAfterCommit}. Each post carries id, body, author, createdAt, postSeq and commitSeq.
 *   LIVE      posts COMMITTED after the cursor, ascending commitSeq, excluding `post.import`. nextAfterCommit = the token of the LAST DELIVERED commit,
 *             NEVER the snapshot head; on an empty page it echoes the request's own cursor. With limit 1 every qualifying post is reachable.
 *   BOOTSTRAP `afterCommit=start` captures a baseline commitSeq B and pages the posts COMMITTED AT OR BELOW B (imports INCLUDED) in postSeq order under a
 *             gb1 token carrying B and the last postSeq delivered. B bounds snapshot MEMBERSHIP: a post committed after B is NEVER a bootstrap row, whatever
 *             its postSeq. The client pages with the gb1 token until a response carries phase 'live' and a gc1 cursor at B; only then is B the live cursor.
 *             A restart mid-bootstrap resumes with the same gb1 token (same remaining rows, nothing re-baselined).
 *   FENCING   a token from another incarnation or epoch, a `ps1` document token, or a `gc1`/`gb1` token on afterSeq: 409 POST_CURSOR_EPOCH_CHANGED with
 *             resync: 'afterCommit=start' in the body. A malformed token: 400 UNKNOWN_CURSOR. Never reinterpreted, never a jump to the head.
 *   ELIGIBLE  an item exists only for a post whose operation has a matching APPLIED receipt AND a queryable node. A reservation, UNKNOWN, UNAVAILABLE,
 *             REJECTED or PRECONDITION_FAILED make none; a retry of the same opId makes no second item.
 *   FAILURES  503 GRAPH_DISCOVERY_UNAVAILABLE (the observation failed) or GRAPH_DISCOVERY_INCONSISTENT (a receipt whose node is absent, with no redaction
 *             record), and NO cursor movement: the same cursor, retried when readable, still delivers what was owed.
 *
 * NOT PINNED, BY NAME: the three consumers; attribution of the item's `by`; the representation of a legitimately REDACTED post and what a redaction-driven
 * fresh store does to cursors (R4: the cursor must resync; the interface is undefined); the exact shape of the 503 body beyond `code`; page-size ceilings;
 * authenticated identity for mentions_me (the route does not authenticate that parameter today; the scope binds the REQUESTED name).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freePort, waitForHttp, makeBoardFixture, startRestServer, PROJECT_DIR } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor, PY } from './helpers/graph-executor-proc.mjs';
import { announcePostId, postCreateIntention } from '../core/announce-outbox.mjs';
import { createGraphClient } from '../core/graph-client.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const DSID = 'r3-test';
const ENTITY = 'https://scrumboard.local/entity/';
const EPOCH_DOC = '11111111-2222-4333-8444-555555555555';
const T0 = '2026-10-04T12:00:00.000Z';
const GC = /^gc1\.([0-9a-f-]{36})\.(\d+)\.(\d+)\.([0-9a-f]{64})$/;
const GB = /^gb1\.([0-9a-f-]{36})\.(\d+)\.(\d+)\.(\d+)\.([0-9a-f]{64})$/;
// the scope is the FULL sha256 of canonical JSON with explicit nulls and a fixed field order (an absent filter is null, never a sentinel string)
const scopeOf = (f = {}) => crypto.createHash('sha256').update(JSON.stringify({ v: 1, mentions_me: f.mentions_me == null ? null : String(f.mentions_me).toLowerCase(), attachedTo: f.attachedTo ?? null, conversation: f.conversation ?? null })).digest('hex');
const commitOf = (token) => Number(token.split('.')[3]);

// ---- fixtures: publisher-mode obligations seeded into a MIGRATED board, so their reservations start at `base + 1`
const payloadOf = (mut, mentions = []) => ({ author: 'board', body: `post ${mut}`, mentions, notify: false, occurredAt: T0, originActor: 'ada', origin: { cardId: 'c1', version: 2 }, mutationId: mut, slot: 'claim' });
const entryOf_ = (mut, mentions) => ({ obligationId: `${mut}:claim`, mutationId: mut, slot: 'claim', status: 'pending', mode: 'publisher', payload: payloadOf(mut, mentions) });
const originOf_ = (mut) => ({ mutationId: mut, slots: ['claim'], origin: { cardId: 'c1', version: 2 }, committedAt: T0, occurredAt: T0, originActor: 'ada', mode: 'publisher' });
const docPosts = (n) => Array.from({ length: n }, (_, i) => ({ id: `d${i + 1}`, body: `doc ${i + 1}`, author: 'ada', attachedTo: null, attachments: [], mentions: [], createdAt: T0, postSeq: i + 1 }));
function entriesBoard(muts, { base = 40, mentions = {} } = {}) {
  const origins = {}, entries = {};
  for (const m of muts) { origins[m] = originOf_(m); entries[`${m}:claim`] = entryOf_(m, mentions[m] || []); }
  return makeBoardFixture({ conversations: docPosts(base), postSeqEpoch: EPOCH_DOC, nextPostSeq: base + 1, announcementOutbox: { origins, entries } });
}
const idOf = (m) => announcePostId(m, 'claim');

async function api(base, method, route, body) {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text };
}
const publish = (base, mut) => api(base, 'POST', `/api/outbox/${encodeURIComponent(`${mut}:claim`)}/publish`, {});
const entryOf = async (base, mut) => (await api(base, 'GET', '/api/outbox')).body.entries.find((e) => e.obligationId === `${mut}:claim`);
const feed = (base, qs) => api(base, 'GET', `/api/conversations?${qs}`);
const ids = (r) => r.body.conversations.map((c) => c.id);

/** A proxy in front of the executor that can HOLD the next /update BEFORE forwarding it (a write that is reserved but not committed). */
async function startProxy(execUrl) {
  let target = execUrl;
  const p = { updates: 0, requests: 0, armed: null, down: false, swap: null };
  p.server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    p.requests++;
    if (p.down) { req.socket.destroy(); return; }
    if (req.method === 'POST' && req.url === '/update') {
      p.updates++;
      if (p.armed) { const a = p.armed; p.armed = null; a.arrive(); await a.released; }
    }
    const fwd = { ...req.headers }; delete fwd.host; delete fwd['content-length']; delete fwd.connection;
    try {
      const f = await fetch(`${target}${req.url}`, { method: req.method, headers: fwd, ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) });
      const text = await f.text(); res.statusCode = f.status; res.end(text);
      if (p.swap && req.url === '/query' && ++p.swap.seen === p.swap.after) target = p.swap.to;   // the executor behind the proxy is REPLACED after the Nth query of the swap
    } catch { try { req.socket.destroy(); } catch { /* gone */ } }
  });
  await new Promise((r) => p.server.listen(0, '127.0.0.1', r));
  p.url = `http://127.0.0.1:${p.server.address().port}`;
  p.hold = () => { let arrive, release; const arrived = new Promise((r) => { arrive = r; }); const released = new Promise((r) => { release = r; }); p.armed = { arrive, released }; return { arrived, release }; };
  p.swapAfter = (n, url) => { p.swap = { after: n, to: url, seen: 0 }; };
  p.unswap = () => { p.swap = null; target = execUrl; };
  p.stop = () => new Promise((r) => { p.server.closeAllConnections?.(); p.server.close(() => r()); });
  return p;
}

async function spawnServer(boardFile, execUrl, { flag = true } = {}) {
  const port = await freePort();
  const env = { ...process.env, SCRUM_BOARD_FILE: boardFile, SCRUM_PORT: String(port), SCRUM_MCP_NOTIFY_URL: '', SCRUM_ATTACHMENTS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'r3-attach-')),
    SCRUM_CHANNEL_CONFIG_FILE: path.join(os.tmpdir(), `r3-chan-${process.pid}-${port}.json`), SCRUM_INSTANCE_ID: `r3-${port}`,
    SCRUM_GRAPH_DATASET_ID: DSID, SCRUM_GRAPH_EXECUTOR_URL: execUrl, ...(flag ? { SCRUM_GRAPH_UNIT_CONVERSATIONS: '1' } : {}) };
  const child = spawn('node', ['server.js'], { cwd: PROJECT_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const err = []; child.stderr.on('data', (d) => err.push(String(d)));
  const base = `http://127.0.0.1:${port}`;
  await waitForHttp(`${base}/api/board`, 15000);
  return { base, stop: () => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, stderr: () => err.join('') };
}

/** A board file, a real executor behind a proxy, and a server: each of the three can be restarted on the same state. */
async function stack(board, body, { flag = true } = {}) {
  const store = tmpStore('r3-store-');
  let exec = await startExecutor({ store, datasetId: DSID, create: true }); const port = exec.port;
  const proxy = await startProxy(exec.baseUrl);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-')); const file = path.join(dir, 'board.json'); fs.writeFileSync(file, JSON.stringify(board, null, 2));
  let srv = await spawnServer(file, proxy.url, { flag });
  const api_ = {
    get base() { return srv.base; }, proxy, file, store, get exec() { return exec; },
    restartServer: async () => { srv.stop(); srv = await spawnServer(file, proxy.url, { flag }); },
    restartExecutor: async () => { await killExecutor(exec); exec = await startExecutor({ store, datasetId: DSID, create: false, port }); },
    killExecutor: async () => { await killExecutor(exec); },
    startExecutor: async () => { exec = await startExecutor({ store, datasetId: DSID, create: false, port }); },
    stderr: () => srv.stderr(),
  };
  try { return await body(api_); } finally { srv.stop(); await proxy.stop(); await killExecutor(exec); }
}

// ------------------------------------------------------------------ route, flag, mixing
test('D0 flag OFF: afterCommit is a 400 and the executor is NEVER contacted', { skip: SKIP }, async () => {
  await stack(entriesBoard(['m-a']), async (s) => {
    const before = s.proxy.requests;
    const r = await feed(s.base, 'afterCommit=start');
    assert.equal(r.status, 400, r.text);
    assert.equal(s.proxy.requests, before, 'no request reached the executor');
  }, { flag: false });
  // the CONTROL: with the flag ON the very same request is a real feed. Without it, a build that has never heard of the parameter passes this row
  // by refusing it as "unsupported" (which is also a 400 with no executor contact).
  await stack(entriesBoard(['m-a']), async (s) => {
    const r = await feed(s.base, 'afterCommit=start');
    assert.equal(r.status, 200, `flag ON: afterCommit=start must be served: ${r.text}`);
  });
});
test('D1 afterCommit combined with since, before, afterSeq, beforeSeq or tail is a 400 that NAMES both parameters', { skip: SKIP }, async () => {
  await stack(entriesBoard(['m-a']), async (s) => {
    assert.equal((await feed(s.base, 'afterCommit=start')).status, 200, 'control: the parameter is supported on its own, so the refusals below are about the COMBINATION');
    for (const other of ['since=2026-01-01T00:00:00.000Z', 'before=2031-01-01T00:00:00.000Z', 'afterSeq=start', 'beforeSeq=ps1.x.1', 'tail=3']) {
      const r = await feed(s.base, `afterCommit=start&${other}`);
      assert.equal(r.status, 400, `${other}: ${r.text}`);
      const name = other.split('=')[0];
      assert.ok(r.text.includes('afterCommit') && r.text.includes(name), `${other}: the refusal names both: ${r.text}`);
      assert.doesNotMatch(r.text, /unsupported param/i, `${other}: this is a refusal of the combination, not the generic unsupported-parameter message`);
    }
  });
});

// ------------------------------------------------------------------ bootstrap, tokens, paging
test('D2 an EMPTY graph bootstraps straight to live: no rows, phase live, a gc1 cursor at the baseline, and an empty page ECHOES its cursor', { skip: SKIP }, async () => {
  await stack(entriesBoard(['m-a']), async (s) => {
    const boot = await feed(s.base, 'afterCommit=start&limit=5');
    assert.equal(boot.status, 200, boot.text);
    assert.equal(boot.body.phase, 'live'); assert.deepEqual(boot.body.conversations, []);
    assert.match(boot.body.nextAfterCommit, GC);
    assert.equal(boot.body.nextAfterCommit.split('.')[4], scopeOf(), 'the scope segment is the independently recomputed unfiltered scope');
    const again = await feed(s.base, `afterCommit=${boot.body.nextAfterCommit}`);
    assert.equal(again.status, 200, again.text); assert.deepEqual(again.body.conversations, []);
    assert.equal(again.body.nextAfterCommit, boot.body.nextAfterCommit, 'an empty page echoes the request\'s own cursor');
  });
});

test('D3 THE HEADLINE: A reserves postSeq 41 and is HELD before the executor, B reserves 42 and commits and is consumed, then A commits: the next page delivers A ONCE, with its LOWER postSeq and HIGHER commitSeq, and nothing is lost or repeated', { skip: SKIP }, async () => {
  await stack(entriesBoard(['m-a', 'm-b'], { base: 40 }), async (s) => {
    const c0 = (await feed(s.base, 'afterCommit=start')).body.nextAfterCommit;
    const held = s.proxy.hold();
    const pubA = publish(s.base, 'm-a');
    await Promise.race([held.arrived, new Promise((_, rej) => setTimeout(() => rej(new Error('A never reached the executor')), 15000))]);
    assert.equal((await entryOf(s.base, 'm-a')).postSeq, 41, 'A reserved 41 and has not committed');
    assert.equal((await publish(s.base, 'm-b')).body.status, 'published');
    assert.equal((await entryOf(s.base, 'm-b')).postSeq, 42);
    const p1 = await feed(s.base, `afterCommit=${c0}&limit=10`);
    assert.equal(p1.status, 200, p1.text); assert.deepEqual(ids(p1), [idOf('m-b')], 'only B is committed so far: the reservation is not an item');
    assert.equal(p1.body.conversations[0].postSeq, 42);
    held.release();
    assert.equal((await pubA).body.status, 'published');
    const p2 = await feed(s.base, `afterCommit=${p1.body.nextAfterCommit}&limit=10`);
    assert.deepEqual(ids(p2), [idOf('m-a')], 'A is delivered although its postSeq (41) is BELOW the 42 already consumed');
    assert.equal(p2.body.conversations[0].postSeq, 41);
    assert.ok(p2.body.conversations[0].commitSeq > p1.body.conversations[0].commitSeq, 'its commitSeq is the newer one');
    const p3 = await feed(s.base, `afterCommit=${p2.body.nextAfterCommit}`);
    assert.deepEqual(p3.body.conversations, []); assert.equal(p3.body.nextAfterCommit, p2.body.nextAfterCommit);
    const redelivery = await feed(s.base, `afterCommit=${c0}&limit=10`);
    assert.deepEqual(ids(redelivery), [idOf('m-b'), idOf('m-a')], 'from the original cursor, commit order is B then A: exactly two items, each once');
  });
});

test('D4 paging: five posts at limit 2 give 2,2,1,0 in commit order with no skip and no repeat, and each page\'s cursor is the LAST DELIVERED commit, never the head; limit 1 reaches all five', { skip: SKIP }, async () => {
  const muts = ['m1', 'm2', 'm3', 'm4', 'm5'];
  await stack(entriesBoard(muts), async (s) => {
    const c0 = (await feed(s.base, 'afterCommit=start')).body.nextAfterCommit;
    for (const m of muts) assert.equal((await publish(s.base, m)).body.status, 'published');
    const all = await feed(s.base, `afterCommit=${c0}&limit=100`);
    const commits = all.body.conversations.map((c) => c.commitSeq);
    assert.deepEqual(ids(all), muts.map(idOf)); assert.deepEqual([...commits].sort((a, b) => a - b), commits, 'ascending commitSeq');
    const seen = []; let cur = c0; const sizes = [];
    for (let guard = 0; guard < 10; guard++) {
      const r = await feed(s.base, `afterCommit=${cur}&limit=2`);
      assert.equal(r.status, 200, r.text); sizes.push(r.body.conversations.length);
      if (r.body.conversations.length) assert.equal(commitOf(r.body.nextAfterCommit), r.body.conversations.at(-1).commitSeq, 'the cursor is the last DELIVERED commit');
      if (!r.body.conversations.length) { assert.equal(r.body.nextAfterCommit, cur); break; }
      seen.push(...ids(r)); cur = r.body.nextAfterCommit;
    }
    assert.deepEqual(sizes, [2, 2, 1, 0]); assert.deepEqual(seen, muts.map(idOf));
    const one = []; cur = c0;
    for (let guard = 0; guard < 10; guard++) { const r = await feed(s.base, `afterCommit=${cur}&limit=1`); if (!r.body.conversations.length) break; one.push(...ids(r)); cur = r.body.nextAfterCommit; }
    assert.deepEqual(one, muts.map(idOf), 'with limit 1 every qualifying post is reachable');
  });
});

test('D5 BOOTSTRAP over existing posts: pages of at most `limit` in postSeq order under gb1 tokens, then phase live with a gc1 cursor at the baseline; a post committed afterwards is delivered by live discovery ONCE', { skip: SKIP }, async () => {
  const muts = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8'];
  await stack(entriesBoard(muts, { base: 10 }), async (s) => {
    for (const m of muts.slice(0, 7)) assert.equal((await publish(s.base, m)).body.status, 'published');
    const rows = []; const phases = []; let tok = 'start';
    for (let guard = 0; guard < 10; guard++) {
      const r = await feed(s.base, `afterCommit=${tok}&limit=3`);
      assert.equal(r.status, 200, r.text); phases.push(r.body.phase); rows.push(...r.body.conversations);
      assert.ok(r.body.conversations.length <= 3);
      tok = r.body.nextAfterCommit;
      if (r.body.phase === 'bootstrap') assert.match(tok, GB, 'a bootstrap page hands out a gb1 token, never a gc1'); else { assert.match(tok, GC); break; }
    }
    assert.deepEqual(rows.map((c) => c.id), muts.slice(0, 7).map(idOf), 'all seven current posts, in postSeq order, none skipped');
    assert.deepEqual(rows.map((c) => c.postSeq), [11, 12, 13, 14, 15, 16, 17]);
    assert.deepEqual(phases, ['bootstrap', 'bootstrap', 'live'].slice(0, phases.length)); assert.equal(phases.at(-1), 'live');
    const baseline = commitOf(tok);
    assert.equal(baseline, Math.max(...rows.map((c) => c.commitSeq)), 'the baseline is the newest commit that was in the snapshot');
    assert.equal((await publish(s.base, 'm8')).body.status, 'published');
    const live = await feed(s.base, `afterCommit=${tok}`);
    assert.deepEqual(ids(live), [idOf('m8')], 'a post committed after the baseline arrives through live discovery');
    assert.deepEqual(ids(await feed(s.base, `afterCommit=${live.body.nextAfterCommit}`)), [], 'and only once');
  });
});

test('D6 THE BASELINE BOUNDS MEMBERSHIP: a post whose postSeq lies INSIDE the not-yet-paged range but which commits AFTER the baseline is never a bootstrap row; live discovery delivers it once after the drain', { skip: SKIP }, async () => {
  await stack(entriesBoard(['m-b', 'm-c', 'm-a', 'm-d'], { base: 10 }), async (s) => {
    for (const m of ['m-b', 'm-c']) assert.equal((await publish(s.base, m)).body.status, 'published');   // postSeq 11, 12
    const held = s.proxy.hold();
    const pubA = publish(s.base, 'm-a');
    await held.arrived;                                                          // A reserved 13 and is uncommitted
    assert.equal((await entryOf(s.base, 'm-a')).postSeq, 13);
    assert.equal((await publish(s.base, 'm-d')).body.status, 'published');       // postSeq 14, committed before the baseline
    const first = await feed(s.base, 'afterCommit=start&limit=2');
    assert.equal(first.body.phase, 'bootstrap', first.text); assert.deepEqual(ids(first), [idOf('m-b'), idOf('m-c')]);
    held.release(); assert.equal((await pubA).body.status, 'published');         // A commits AFTER the baseline; its postSeq 13 lies between the rows already paged (12) and the one still to come (14)
    const rows = [...ids(first)]; let tok = first.body.nextAfterCommit, last = first;
    for (let guard = 0; guard < 6 && last.body.phase === 'bootstrap'; guard++) { last = await feed(s.base, `afterCommit=${tok}&limit=2`); rows.push(...ids(last)); tok = last.body.nextAfterCommit; }
    assert.equal(last.body.phase, 'live');
    assert.deepEqual(rows, [idOf('m-b'), idOf('m-c'), idOf('m-d')], 'A (postSeq 13) is NOT a bootstrap row, although its postSeq falls inside the range still being paged: it committed after the baseline');
    const live = await feed(s.base, `afterCommit=${tok}`);
    assert.deepEqual(ids(live), [idOf('m-a')], 'live discovery delivers A, once');
    assert.equal(live.body.conversations[0].postSeq, 13);
  });
});

test('D7 IMPORTS: a backfill is part of the BOOTSTRAP (committed at or below the baseline) and is NEVER live activity: a live cursor taken before the import sees nothing from it, and a bootstrap taken after sees the imported posts', { skip: SKIP }, async () => {
  const importedPosts = Array.from({ length: 6 }, (_, i) => ({ id: `imp-${i + 1}`, body: `imported ${i + 1}`, author: 'ada', attachedTo: null, attachments: [], mentions: [], createdAt: `2026-09-0${i + 1}T00:00:00.000Z`, postSeq: i + 1 }));
  const tool = process.env.BACKFILL_SCRIPT || path.join(HERE, '..', 'scripts', 'backfill-posts-r0.mjs');
  await stack(entriesBoard(['m-live'], { base: 40 }), async (s) => {
    const c0 = (await feed(s.base, 'afterCommit=start')).body.nextAfterCommit;
    const bf = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'r3-imp-')), 'board.json');
    fs.writeFileSync(bf, JSON.stringify(makeBoardFixture({ conversations: importedPosts, postSeqEpoch: EPOCH_DOC, nextPostSeq: 7 }), null, 2));
    const run = spawnSync(process.execPath, [tool, '--board-file', bf, '--executor-url', s.exec.baseUrl, '--dataset-id', DSID], { encoding: 'utf8', cwd: PROJECT_DIR });   // the executor DIRECTLY: spawnSync blocks this process's loop, so a tool pointed at the in-process proxy would deadlock
    assert.equal(run.status, 0, `fixture: the R0 tool imports six posts: ${run.stdout}${run.stderr}`);
    assert.deepEqual((await feed(s.base, `afterCommit=${c0}&limit=50`)).body.conversations, [], 'six imports are not six new posts');
    assert.equal((await publish(s.base, 'm-live')).body.status, 'published');
    assert.deepEqual(ids(await feed(s.base, `afterCommit=${c0}&limit=50`)), [idOf('m-live')], 'only the live post is activity');
    const rows = []; let tok = 'start', last;
    for (let guard = 0; guard < 8; guard++) { last = await feed(s.base, `afterCommit=${tok}&limit=4`); rows.push(...last.body.conversations); tok = last.body.nextAfterCommit; if (last.body.phase === 'live') break; }
    assert.deepEqual(rows.map((c) => c.id).slice(0, 6), importedPosts.map((p) => p.id), 'a fresh bootstrap includes the imported posts, in postSeq order');
    assert.ok(rows.map((c) => c.id).includes(idOf('m-live')), 'and the live post');
  });
});

test('D5b BOOTSTRAP ORDER is postSeq, NOT commit order: when a low-postSeq post committed LAST (and before the baseline), the bootstrap lists it FIRST, and a limit-2 page boundary does not repeat or skip it', { skip: SKIP }, async () => {
  await stack(entriesBoard(['m-a', 'm-b', 'm-c', 'm-d'], { base: 20 }), async (s) => {
    const held = s.proxy.hold();
    const pubA = publish(s.base, 'm-a');
    await held.arrived;                                                          // A reserved 21 and is uncommitted
    for (const m of ['m-b', 'm-c', 'm-d']) assert.equal((await publish(s.base, m)).body.status, 'published');   // 22, 23, 24
    held.release(); assert.equal((await pubA).body.status, 'published');         // A commits LAST, but BEFORE the bootstrap's baseline
    const rows = []; let tok = 'start', last;
    for (let guard = 0; guard < 6; guard++) { last = await feed(s.base, `afterCommit=${tok}&limit=2`); assert.equal(last.status, 200, last.text); rows.push(...last.body.conversations); tok = last.body.nextAfterCommit; if (last.body.phase === 'live') break; }
    assert.deepEqual(rows.map((c) => c.postSeq), [21, 22, 23, 24], 'postSeq order, although A committed after B, C and D');
    assert.deepEqual(rows.map((c) => c.id), ['m-a', 'm-b', 'm-c', 'm-d'].map(idOf));
    assert.ok(rows[0].commitSeq > rows[3].commitSeq, 'fixture: A really did commit last');
  });
});

// ------------------------------------------------------------------ restart
test('D8 RESTART: after B was consumed and before A commits the executor AND the server restart on the same store: the cursor is still valid and A is delivered once; and a restart MID-BOOTSTRAP resumes from the same gb1 token with the same remaining rows', { skip: SKIP }, async () => {
  await stack(entriesBoard(['m-a', 'm-b', 'm-c', 'm-d', 'm-e'], { base: 10 }), async (s) => {
    for (const m of ['m-b', 'm-c', 'm-d', 'm-e']) assert.equal((await publish(s.base, m)).body.status, 'published');
    const boot1 = await feed(s.base, 'afterCommit=start&limit=2');
    assert.equal(boot1.body.phase, 'bootstrap'); const gb = boot1.body.nextAfterCommit;
    await s.restartExecutor(); await s.restartServer();
    const resumed = await feed(s.base, `afterCommit=${gb}&limit=2`);
    assert.equal(resumed.status, 200, `an ordinary restart keeps the store's identity, so the bootstrap token still works: ${resumed.text}`);
    assert.deepEqual(ids(resumed), [idOf('m-d'), idOf('m-e')].slice(0, 2), 'the same remaining rows, nothing re-baselined');
    let tok = resumed.body.nextAfterCommit, last = resumed;
    for (let guard = 0; guard < 4 && last.body.phase === 'bootstrap'; guard++) { last = await feed(s.base, `afterCommit=${tok}&limit=2`); tok = last.body.nextAfterCommit; }
    assert.equal(last.body.phase, 'live'); const live0 = tok;
    const held = s.proxy.hold();
    // the server is KILLED while this request is in flight, so its fetch rejects: the rejection is expected and is caught where the request is made
    const pubA = publish(s.base, 'm-a').catch((e) => ({ reset: String(e?.message || e) }));
    await held.arrived;
    const mid = await feed(s.base, `afterCommit=${live0}`); assert.deepEqual(mid.body.conversations, [], 'A is reserved, not committed');
    await s.restartServer();
    held.release(); await Promise.race([pubA, new Promise((r) => setTimeout(r, 4000))]);
    const after = await publish(s.base, 'm-a');
    assert.equal(after.body.status, 'published', after.text);
    const got = await feed(s.base, `afterCommit=${live0}&limit=10`);
    assert.deepEqual(ids(got), [idOf('m-a')], 'the cursor survived the restarts and A arrives exactly once');
  });
});

// ------------------------------------------------------------------ tokens, fencing, filters
test('D9 tokens: malformed is 400 UNKNOWN_CURSOR; a ps1 document token, or a gc1 token on afterSeq, is 409 POST_CURSOR_EPOCH_CHANGED with resync; a forged incarnation or epoch is the same 409; a token whose scope differs from the request\'s filters is 400 CURSOR_FILTER_MISMATCH', { skip: SKIP }, async () => {
  await stack(entriesBoard(['m-a']), async (s) => {
    const live = (await feed(s.base, 'afterCommit=start')).body.nextAfterCommit;
    const bad = await feed(s.base, 'afterCommit=garbage'); assert.equal(bad.status, 400); assert.equal(bad.body.code, 'UNKNOWN_CURSOR');
    const ps = await feed(s.base, `afterCommit=${encodeURIComponent(`ps1.${EPOCH_DOC}.3`)}`); assert.equal(ps.status, 409, ps.text); assert.equal(ps.body.code, 'POST_CURSOR_EPOCH_CHANGED');
    const onSeq = await feed(s.base, `afterSeq=${encodeURIComponent(live)}`); assert.equal(onSeq.status, 409, onSeq.text); assert.equal(onSeq.body.code, 'POST_CURSOR_EPOCH_CHANGED');
    const parts = live.split('.');
    const forgedInc = [parts[0], '00000000-0000-4000-8000-000000000000', parts[2], parts[3], parts[4]].join('.');
    const forgedEp = [parts[0], parts[1], String(Number(parts[2]) + 7), parts[3], parts[4]].join('.');
    for (const t of [forgedInc, forgedEp]) { const r = await feed(s.base, `afterCommit=${t}`); assert.equal(r.status, 409, r.text); assert.equal(r.body.code, 'POST_CURSOR_EPOCH_CHANGED'); assert.equal(r.body.resync, 'afterCommit=start'); }
    const mismatch = await feed(s.base, `afterCommit=${live}&mentions_me=bea`);
    assert.equal(mismatch.status, 400, mismatch.text); assert.equal(mismatch.body.code, 'CURSOR_FILTER_MISMATCH');
    const scoped = (await feed(s.base, 'afterCommit=start&mentions_me=Bea')).body.nextAfterCommit;
    assert.equal(scoped.split('.')[4], scopeOf({ mentions_me: 'bea' }), 'the scope hashes the LOWERCASED name, recomputed independently');
    assert.equal((await feed(s.base, `afterCommit=${scoped}&mentions_me=BEA`)).status, 200, 'the same filter in another case is the same scope');
  });
});

test('D10 FILTERS across page boundaries (and mentions match case-insensitively: m1 mentions `Bea`, the filter is `bea`): with mentions_me and limit 1, a matching post that follows three excluded ones is still reached, and the cursor crosses an excluded row only after it was examined for THAT filter', { skip: SKIP }, async () => {
  const muts = ['m1', 'm2', 'm3', 'm4', 'm5'];
  await stack(entriesBoard([...muts, 'm6'], { mentions: { m1: ['Bea'], m5: ['bea'], m3: ['cy'] } }), async (s) => {
    const c0 = (await feed(s.base, 'afterCommit=start&mentions_me=bea')).body.nextAfterCommit;
    for (const m of muts) assert.equal((await publish(s.base, m)).body.status, 'published');
    const got = []; let cur = c0;
    for (let guard = 0; guard < 10; guard++) { const r = await feed(s.base, `afterCommit=${cur}&limit=1&mentions_me=bea`); assert.equal(r.status, 200, r.text); if (!r.body.conversations.length) break; got.push(...ids(r)); cur = r.body.nextAfterCommit; }
    assert.deepEqual(got, [idOf('m1'), idOf('m5')], 'both matching posts, though three non-matching posts lie between them');
    assert.equal((await publish(s.base, 'm6')).body.status, 'published');           // a NON-matching post committed after the last delivered one: the head is now AHEAD of the cursor
    const quiet = await feed(s.base, `afterCommit=${cur}&limit=5&mentions_me=bea`);
    assert.deepEqual(quiet.body.conversations, []);
    assert.equal(quiet.body.nextAfterCommit, cur, 'an EMPTY filtered page echoes the request\'s own cursor: it does not jump to a head it has not delivered');
    const other = await feed(s.base, `afterCommit=${c0}&limit=10&mentions_me=cy`);
    assert.equal(other.status, 400, 'the token was minted for bea: another filter needs a fresh bootstrap');
  });
});

// ------------------------------------------------------------------ what is NOT an item, and failures
test('D11 NOT ITEMS: a reservation, an UNKNOWN outcome (executor down) and a repeated publish of the same operation produce NO extra item (a REJECTED collision leaves no receipt to discover and is not exercised here)', { skip: SKIP }, async () => {
  await stack(entriesBoard(['m-down', 'm-ok']), async (s) => {
    const c0 = (await feed(s.base, 'afterCommit=start')).body.nextAfterCommit;
    s.proxy.down = true;
    const down = await publish(s.base, 'm-down'); assert.equal(down.body.status, 'pending', down.text);
    s.proxy.down = false;
    assert.deepEqual((await feed(s.base, `afterCommit=${c0}`)).body.conversations, [], 'pending (reserved, UNKNOWN) is not an item');
    assert.equal((await publish(s.base, 'm-ok')).body.status, 'published');
    assert.equal((await publish(s.base, 'm-ok')).body.status, 'published'); assert.equal((await publish(s.base, 'm-ok')).body.status, 'published');
    assert.deepEqual(ids(await feed(s.base, `afterCommit=${c0}&limit=50`)), [idOf('m-ok')], 'a repeated publish of one operation yields one item');
    assert.equal((await publish(s.base, 'm-down')).body.status, 'published');
    assert.deepEqual(ids(await feed(s.base, `afterCommit=${c0}&limit=50`)), [idOf('m-ok'), idOf('m-down')], 'the earlier-reserved post arrives in COMMIT order, after m-ok');
  });
});

test('D12 FAILURES: the executor unreachable is 503 GRAPH_DISCOVERY_UNAVAILABLE and moves nothing; the same cursor, retried when readable, still delivers the owed post; a receipt whose node is gone is 503 GRAPH_DISCOVERY_INCONSISTENT and moves nothing', { skip: SKIP }, async () => {
  await stack(entriesBoard(['m-a', 'm-b']), async (s) => {
    const c0 = (await feed(s.base, 'afterCommit=start')).body.nextAfterCommit;
    assert.equal((await publish(s.base, 'm-a')).body.status, 'published');
    s.proxy.down = true;
    const r = await feed(s.base, `afterCommit=${c0}`);
    assert.equal(r.status, 503, r.text); assert.equal(r.body.code, 'GRAPH_DISCOVERY_UNAVAILABLE'); assert.equal(r.body.nextAfterCommit, undefined, 'no cursor is handed out by a failure');
    s.proxy.down = false;
    assert.deepEqual(ids(await feed(s.base, `afterCommit=${c0}`)), [idOf('m-a')], 'the owed post is still delivered on the same cursor');
    assert.equal((await publish(s.base, 'm-b')).body.status, 'published');
    await s.killExecutor();
    const iri = `${ENTITY}${idOf('m-b')}`;
    const del = spawnSync(PY, ['-c', `import pyoxigraph as ox; s = ox.Store(${JSON.stringify(s.store)}); s.update('DELETE WHERE { GRAPH ?g { <${iri}> ?p ?o } }'); s.update('DELETE WHERE { <${iri}> ?p ?o }')`], { encoding: 'utf8' });
    assert.equal(del.status, 0, `fixture: removing the node: ${del.stderr}`);
    await s.startExecutor();
    const inc = await feed(s.base, `afterCommit=${c0}&limit=10`);
    assert.equal(inc.status, 503, inc.text); assert.equal(inc.body.code, 'GRAPH_DISCOVERY_INCONSISTENT'); assert.equal(inc.body.nextAfterCommit, undefined);
  });
});

test('D13 AN IDENTITY SWITCH BETWEEN THE TWO READS: the store behind the executor is replaced (another incarnation, other posts) after the marker is read and before the batch: the answer is 503 GRAPH_DISCOVERY_UNAVAILABLE with NO rows and NO cursor (so no new-store row ever carries an old-store token), and a client that retries against the real store still gets exactly what it was owed', { skip: SKIP }, async () => {
  await stack(entriesBoard(['m-a', 'm-x']), async (s) => {
    const live = (await feed(s.base, 'afterCommit=start')).body.nextAfterCommit;
    assert.equal((await publish(s.base, 'm-a')).body.status, 'published');
    const storeB = tmpStore('r3-storeB-'); const execB = await startExecutor({ store: storeB, datasetId: DSID, create: true });
    try {
      const clientB = createGraphClient({ baseUrl: execB.baseUrl, expectedDatasetId: DSID });
      const w = await clientB.update(postCreateIntention({ ...entryOf_('m-x'), publicationAt: '2026-10-05T07:30:00.000Z', postSeq: 99 }));
      assert.equal(w.outcome, 'APPLIED', `fixture: the other store holds its own post: ${JSON.stringify(w)}`);
      s.proxy.swapAfter(1, execB.baseUrl);                                        // the marker read goes to store A, every later read to store B
      const r = await feed(s.base, `afterCommit=${live}&limit=10`);
      s.proxy.unswap();
      assert.equal(r.status, 503, `an identity change across the reads is a refusal, never rows under a stale token: ${r.status} ${r.text}`);
      assert.equal(r.body.code, 'GRAPH_DISCOVERY_UNAVAILABLE');
      assert.equal(r.body.conversations, undefined, 'no rows'); assert.equal(r.body.nextAfterCommit, undefined, 'and no cursor');
      assert.deepEqual(ids(await feed(s.base, `afterCommit=${live}&limit=10`)), [idOf('m-a')], 'back on the real store the original cursor still delivers exactly what it was owed');
    } finally { s.proxy.unswap(); await killExecutor(execB); }
  });
});

test('D13b A SWAPPED-IN STORE THAT IS ITSELF INCONSISTENT: the executor behind the proxy is replaced, after the marker read, by a store that holds a receipt whose node is gone: the answer is 503 GRAPH_DISCOVERY_UNAVAILABLE (the store changed), NOT an INCONSISTENCY attributed to the old store; no rows, no cursor', { skip: SKIP }, async () => {
  await stack(entriesBoard(['m-a', 'm-x']), async (s) => {
    const live = (await feed(s.base, 'afterCommit=start')).body.nextAfterCommit;
    assert.equal((await publish(s.base, 'm-a')).body.status, 'published');
    const storeB = tmpStore('r3-storeB-'); let execB = await startExecutor({ store: storeB, datasetId: DSID, create: true }); const portB = execB.port;
    try {
      const clientB = createGraphClient({ baseUrl: execB.baseUrl, expectedDatasetId: DSID });
      const intention = postCreateIntention({ ...entryOf_('m-x'), publicationAt: '2026-10-05T07:30:00.000Z', postSeq: 99 });
      assert.equal((await clientB.update(intention)).outcome, 'APPLIED', 'fixture: store B holds the post');
      await killExecutor(execB);
      const iri = `${ENTITY}${idOf('m-x')}`;
      const del = spawnSync(PY, ['-c', `import pyoxigraph as ox; s = ox.Store(${JSON.stringify(storeB)}); s.update('DELETE WHERE { GRAPH ?g { <${iri}> ?p ?o } }'); s.update('DELETE WHERE { <${iri}> ?p ?o }')`], { encoding: 'utf8' });
      assert.equal(del.status, 0, `fixture: removing store B's node (its receipt stays): ${del.stderr}`);
      execB = await startExecutor({ store: storeB, datasetId: DSID, create: false, port: portB });
      s.proxy.swapAfter(1, execB.baseUrl);                                        // the marker read is store A's; every later read is store B's, which is internally inconsistent
      const r = await feed(s.base, `afterCommit=${live}&limit=10`);
      s.proxy.unswap();
      assert.equal(r.status, 503, r.text);
      assert.equal(r.body.code, 'GRAPH_DISCOVERY_UNAVAILABLE', `the store CHANGED mid-read, so this is UNAVAILABLE; calling it an inconsistency of the store this cursor names would blame the wrong store: ${r.text}`);
      assert.equal(r.body.conversations, undefined); assert.equal(r.body.nextAfterCommit, undefined);
      assert.deepEqual(ids(await feed(s.base, `afterCommit=${live}&limit=10`)), [idOf('m-a')], 'back on the real store the cursor still delivers what it was owed');
    } finally { s.proxy.unswap(); await killExecutor(execB); }
  });
});

test('D14 A POST NODE WITH NO VALID postSeq is a NAMED INCONSISTENCY in a bootstrap: 503 GRAPH_DISCOVERY_INCONSISTENT with no cursor; missing, zero, negative, non-numeric, a numeric string and a decimal postSeq alike; never silently omitted and never listed again on every page', { skip: SKIP }, async () => {
  const PS = 'https://scrumboard.local/ns#postSeq';
  for (const [label, insert] of [['missing', null], ['zero', '"0"^^<http://www.w3.org/2001/XMLSchema#integer>'], ['negative', '"-3"^^<http://www.w3.org/2001/XMLSchema#integer>'], ['non-numeric', '"abc"'], ['a numeric STRING, not an xsd:integer', '"7"'], ['a decimal, not an integer', '"7.5"^^<http://www.w3.org/2001/XMLSchema#decimal>']]) {
    await stack(entriesBoard(['m-a', 'm-b', 'm-c'], { base: 10 }), async (s) => {
      for (const m of ['m-a', 'm-b', 'm-c']) assert.equal((await publish(s.base, m)).body.status, 'published');
      const healthy = await feed(s.base, 'afterCommit=start&limit=10');
      assert.equal(healthy.status, 200, `control: before the damage the bootstrap is served: ${healthy.text}`);
      await s.killExecutor();
      const iri = `${ENTITY}${idOf('m-b')}`;
      const upd = [`DELETE WHERE { GRAPH ?g { <${iri}> <${PS}> ?o } }`, `DELETE WHERE { <${iri}> <${PS}> ?o }`, ...(insert ? [`INSERT DATA { <${iri}> <${PS}> ${insert} }`] : [])];
      const del = spawnSync(PY, ['-c', `import pyoxigraph as ox; s = ox.Store(${JSON.stringify(s.store)}); [s.update(u) for u in ${JSON.stringify(upd)}]`], { encoding: 'utf8' });
      assert.equal(del.status, 0, `fixture (${label}): rewriting the postSeq triple: ${del.stderr}`);
      await s.startExecutor();
      const r = await feed(s.base, 'afterCommit=start&limit=2');
      assert.equal(r.status, 503, `${label}: a post with no valid postSeq must not be silently omitted or relisted: ${r.text}`);
      assert.equal(r.body.code, 'GRAPH_DISCOVERY_INCONSISTENT', label); assert.equal(r.body.nextAfterCommit, undefined, `${label}: no cursor`);
    });
  }
});

test('D14b THE LIVE FEED applies the same validation: a post with a missing, zero, negative, non-numeric or numeric-STRING postSeq is 503 GRAPH_DISCOVERY_INCONSISTENT on a LIVE page too (never delivered with a null postSeq), with no cursor', { skip: SKIP }, async () => {
  const PS = 'https://scrumboard.local/ns#postSeq';
  for (const [label, insert] of [['missing', null], ['zero', '"0"^^<http://www.w3.org/2001/XMLSchema#integer>'], ['negative', '"-3"^^<http://www.w3.org/2001/XMLSchema#integer>'], ['non-numeric', '"abc"'], ['a numeric STRING', '"7"']]) {
    await stack(entriesBoard(['m-a', 'm-b', 'm-c'], { base: 10 }), async (s) => {
      const c0 = (await feed(s.base, 'afterCommit=start')).body.nextAfterCommit;
      for (const m of ['m-a', 'm-b', 'm-c']) assert.equal((await publish(s.base, m)).body.status, 'published');
      const healthy = await feed(s.base, `afterCommit=${c0}&limit=10`);
      assert.deepEqual(ids(healthy), ['m-a', 'm-b', 'm-c'].map(idOf), 'control: before the damage the live feed delivers all three');
      await s.killExecutor();
      const iri = `${ENTITY}${idOf('m-b')}`;
      const upd = [`DELETE WHERE { GRAPH ?g { <${iri}> <${PS}> ?o } }`, `DELETE WHERE { <${iri}> <${PS}> ?o }`, ...(insert ? [`INSERT DATA { <${iri}> <${PS}> ${insert} }`] : [])];
      const del = spawnSync(PY, ['-c', `import pyoxigraph as ox; s = ox.Store(${JSON.stringify(s.store)}); [s.update(u) for u in ${JSON.stringify(upd)}]`], { encoding: 'utf8' });
      assert.equal(del.status, 0, `fixture (${label}): rewriting the postSeq triple: ${del.stderr}`);
      await s.startExecutor();
      const r = await feed(s.base, `afterCommit=${c0}&limit=10`);
      assert.equal(r.status, 503, `${label}: the live feed must refuse an invalid postSeq by name, not deliver it: ${r.text}`);
      assert.equal(r.body.code, 'GRAPH_DISCOVERY_INCONSISTENT', label); assert.equal(r.body.nextAfterCommit, undefined, `${label}: no cursor`);
    });
  }
});

// ------------------------------------------------------------------ NOT FROZEN, NOT SUBSTRATE (visible as todo, never a pass)
const OPEN = 'NOT IN THIS FILE: a separate addendum, and R3 is not Done without it';
test('T1 the commons READER (conversation-view) discovers a late-committed low-postSeq post on a real runtime', { todo: OPEN }, () => assert.fail(OPEN));
test('T2 the unread BADGE (commons-panel) counts a late-committed low-postSeq post exactly once', { todo: OPEN }, () => assert.fail(OPEN));
test('T3 the resident MENTION SCAN (guest-loop) finds a late-committed mentioning post and does not re-process it after a restart', { todo: OPEN }, () => assert.fail(OPEN));
test('T4 R4 JOINT: a redaction-driven fresh store is a new incarnation, so every cursor resyncs; and a legitimately REDACTED post is not a permanent GRAPH_DISCOVERY_INCONSISTENT', { todo: 'UNFROZEN: R4\'s representation is not defined' }, () => assert.fail('UNFROZEN'));
test('T5 the item\'s `by` reflects the declared mutation actor, not the post author or onBehalfOf', { todo: 'UNFROZEN: attribution source not settled' }, () => assert.fail('UNFROZEN'));
test('T6 the served/acked lane and /api/changes represent the same committed write; served-but-unacked replay is not suppressed', { todo: OPEN }, () => assert.fail(OPEN));
