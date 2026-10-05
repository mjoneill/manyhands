/**
 * R3 ADDENDUM — THE IDLE LIVE POLL. Pre-registered by the separate test author BEFORE the shortcut was accepted. Copy unchanged into tests/.
 * REAL executor (a python with pyoxigraph); without one every test is SKIPPED, and a skip is NOT a pass.
 *
 * WHY: the live path matched every op after the cursor on every poll even when there were none (~180 ms at 36k posts, measured). The builder's shortcut:
 * when the request's cursor commitSeq EQUALS the marker's, nothing can be newer, so the empty page is answered from the marker read alone. These rows
 * pin what that shortcut must NOT change. They are behaviour rows: they pass on the ordinary path AND on a correct shortcut, so a build is judged by
 * what a client sees, not by which reads it made.
 *
 * CONTRACT PINNED HERE (builder's design 2026-10-05, refined by the contract owner)
 *   EQUAL      a live cursor at the head, polled with nothing newer: 200, phase 'live', no items, nextAfterCommit === the request's OWN cursor, every time.
 *   AHEAD      a cursor above the head is NOT the shortcut. It takes the ordinary path (an empty page echoing its own cursor, then exactly the commits above
 *              it once they exist), unchanged from before.
 *   FENCE      the identity fence is not bypassed: a token from another incarnation or epoch is 409 POST_CURSOR_EPOCH_CHANGED with resync 'afterCommit=start'
 *              EVEN WHEN its commitSeq equals the marker's; a different filter scope is 400 CURSOR_FILTER_MISMATCH; a store swapped between the two marker reads
 *              is 503 GRAPH_DISCOVERY_UNAVAILABLE with no items and no cursor.
 *   RACE       a write that lands BETWEEN the reads of one poll is never skipped and the cursor is never advanced past it: the page is either empty echoing the
 *              request's own cursor, or it carries the write with the cursor at its commit. The write is delivered exactly once across the polls that follow.
 * NOT PINNED, BY NAME: which reads the shortcut avoids (performance is measured separately, at 36k, not asserted here).
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
    if (req.method === 'POST' && req.url === '/query' && p.qhook) { const h = p.qhook; if (++h.seen === h.at) { p.qhook = null; h.fired = true; await h.fn(); } }
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
  p.hookQuery = (at, fn) => { const h = { at, fn, seen: 0, fired: false }; p.qhook = h; return h; };
  p.unhook = () => { p.qhook = null; };
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


// ------------------------------------------------------------------ helpers specific to this file
const liveCursor = async (s) => { let page = await feed(s.base, 'afterCommit=start&limit=200'); while (page.body.phase === 'bootstrap') page = await feed(s.base, `afterCommit=${page.body.nextAfterCommit}&limit=200`); assert.equal(page.status, 200, page.text); assert.match(page.body.nextAfterCommit, GC, 'control: a live cursor'); return page.body.nextAfterCommit; };
const withCommit = (tok, commit) => { const [t, inc, epoch, , scope] = tok.split('.'); return [t, inc, epoch, String(commit), scope].join('.'); };
const MUTS = ['m-a', 'm-b', 'm-c', 'm-d', 'm-e', 'm-f', 'm-g', 'm-h', 'm-late'];
const board8 = () => entriesBoard(MUTS);

test('I1 EQUAL: a live cursor at the head, polled repeatedly with nothing newer, answers 200, phase live, no items and its OWN cursor back every time; then a write is delivered once and the new cursor is idle again', { skip: SKIP }, async () => {
  await stack(board8(), async (s) => {
    for (const m of ['m-a', 'm-b']) assert.equal((await publish(s.base, m)).body.status, 'published');
    const cur = await liveCursor(s);
    for (let i = 0; i < 3; i++) { const r = await feed(s.base, `afterCommit=${cur}&limit=50`); assert.equal(r.status, 200, r.text); assert.equal(r.body.phase, 'live'); assert.deepEqual(r.body.conversations, []); assert.equal(r.body.nextAfterCommit, cur, `idle poll ${i}: the cursor is echoed unchanged`); }
    assert.equal((await publish(s.base, 'm-c')).body.status, 'published');
    const got = await feed(s.base, `afterCommit=${cur}&limit=50`);
    assert.deepEqual(ids(got), [idOf('m-c')], 'control: the shortcut does not make the stream deaf; the write is delivered');
    const idle = await feed(s.base, `afterCommit=${got.body.nextAfterCommit}&limit=50`);
    assert.deepEqual(idle.body.conversations, []); assert.equal(idle.body.nextAfterCommit, got.body.nextAfterCommit, 'idle again at the new head');
  });
});

test('I2 AHEAD: a cursor ABOVE the head is the ordinary path, not the shortcut: an empty page echoing its own cursor, and later exactly the commits above it, once each and in order', { skip: SKIP }, async () => {
  await stack(board8(), async (s) => {
    for (const m of ['m-a', 'm-b']) assert.equal((await publish(s.base, m)).body.status, 'published');
    const head = await liveCursor(s); const c = commitOf(head); const ahead = withCommit(head, c + 3);
    const r0 = await feed(s.base, `afterCommit=${ahead}&limit=50`);
    assert.equal(r0.status, 200, r0.text); assert.deepEqual(r0.body.conversations, []); assert.equal(r0.body.nextAfterCommit, ahead, 'an empty page echoes the request\'s own (ahead) cursor');
    const pub = [];
    for (const m of ['m-c', 'm-d', 'm-e', 'm-f', 'm-g', 'm-h']) { assert.equal((await publish(s.base, m)).body.status, 'published'); pub.push(m); const honest = await feed(s.base, `afterCommit=${head}&limit=50`); if (Math.max(...honest.body.conversations.map((x) => x.commitSeq)) > c + 3) break; }
    const honest = await feed(s.base, `afterCommit=${head}&limit=50`);
    const expected = honest.body.conversations.filter((x) => x.commitSeq > c + 3);
    assert.ok(expected.length > 0, 'control: at least one commit landed above the forged cursor, so the delivery below is not vacuous');
    const r1 = await feed(s.base, `afterCommit=${ahead}&limit=50`);
    assert.deepEqual(ids(r1), expected.map((x) => x.id), 'exactly the commits above the forged cursor, in commit order');
    assert.equal(commitOf(r1.body.nextAfterCommit), expected.at(-1).commitSeq);
  });
});

test('I3 FENCE: a token from ANOTHER incarnation or epoch is a 409 POST_CURSOR_EPOCH_CHANGED with resync, even when its commitSeq EQUALS the head; and a different filter scope at the equal cursor is a 400 CURSOR_FILTER_MISMATCH', { skip: SKIP }, async () => {
  await stack(board8(), async (s) => {
    for (const m of ['m-a', 'm-b']) assert.equal((await publish(s.base, m)).body.status, 'published');
    const cur = await liveCursor(s); const [t, inc, epoch, commit, scope] = cur.split('.');
    assert.equal((await feed(s.base, `afterCommit=${cur}&limit=10`)).status, 200, 'control: the genuine cursor is served');
    const otherInc = [t, '00000000-0000-4000-8000-000000000000', epoch, commit, scope].join('.');
    const otherEpoch = [t, inc, String(Number(epoch) + 1), commit, scope].join('.');
    for (const [label, tok] of [['another incarnation', otherInc], ['another epoch', otherEpoch]]) {
      const r = await feed(s.base, `afterCommit=${tok}&limit=10`);
      assert.equal(r.status, 409, `${label}: ${r.text}`); assert.equal(r.body.code, 'POST_CURSOR_EPOCH_CHANGED'); assert.equal(r.body.resync, 'afterCommit=start');
      assert.equal(r.body.conversations, undefined);
    }
    const mism = await feed(s.base, `afterCommit=${cur}&limit=10&mentions_me=someone`);
    assert.equal(mism.status, 400, mism.text); assert.equal(mism.body.code, 'CURSOR_FILTER_MISMATCH');
  });
});

test('I4 RACE: a write landing BETWEEN the reads of one poll at the head is never skipped and the cursor is never advanced past it: the page is empty echoing the request cursor, or it carries the write with the cursor at its commit; across the polls that follow the write is delivered EXACTLY once', { skip: SKIP }, async (t) => {
  for (const at of [2, 3]) {
    await stack(board8(), async (s) => {
      for (const m of ['m-a', 'm-b']) assert.equal((await publish(s.base, m)).body.status, 'published');
      const cur = await liveCursor(s);
      const h = s.proxy.hookQuery(at, async () => { const r = await publish(s.base, 'm-late'); assert.equal(r.body.status, 'published', 'the write lands between the reads'); });
      const r1 = await feed(s.base, `afterCommit=${cur}&limit=50`);
      s.proxy.unhook();
      if (at === 2) assert.equal(h.fired, true, 'control: the write DID land between the first and second read of the poll (so this row exercises the race, not an idle poll)');
      else { t.diagnostic(`hook at query ${at}: ${h.fired ? 'fired' : 'not reached on this build (the poll makes fewer reads), so nothing was written and nothing is asserted for this variant'}`); if (!h.fired) return; }
      assert.equal(r1.status, 200, r1.text);
      const late = idOf('m-late'); const got = ids(r1);
      if (got.length === 0) assert.equal(r1.body.nextAfterCommit, cur, 'empty page: the request\'s OWN cursor, nothing advanced');
      else { assert.deepEqual(got, [late], 'a non-empty page carries exactly the late write'); assert.equal(commitOf(r1.body.nextAfterCommit), r1.body.conversations[0].commitSeq, 'the cursor is at the delivered commit, not past it'); }
      const r2 = await feed(s.base, `afterCommit=${r1.body.nextAfterCommit}&limit=50`);
      const delivered = [...got, ...ids(r2)];
      assert.deepEqual(delivered, [late], `at=${at}: the late write is delivered exactly once across the polls: ${JSON.stringify(delivered)}`);
      const r3 = await feed(s.base, `afterCommit=${r2.body.nextAfterCommit}&limit=50`);
      assert.deepEqual(r3.body.conversations, [], 'and never again');
    });
  }
});

test('I5 FENCE ACROSS THE READS: the store behind the executor is replaced between the first and later reads of a poll at the head: 503 GRAPH_DISCOVERY_UNAVAILABLE with no items and no cursor (never an empty page echoing the old cursor), and the genuine cursor still works once the real store is back', { skip: SKIP }, async () => {
  await stack(board8(), async (s) => {
    for (const m of ['m-a', 'm-b']) assert.equal((await publish(s.base, m)).body.status, 'published');
    const cur = await liveCursor(s);
    const storeB = tmpStore('r3-idle-storeB-'); const execB = await startExecutor({ store: storeB, datasetId: DSID, create: true });
    try {
      s.proxy.swapAfter(1, execB.baseUrl);
      const r = await feed(s.base, `afterCommit=${cur}&limit=10`);
      s.proxy.unswap();
      assert.equal(r.status, 503, `a swapped store is never answered as "nothing new": ${r.status} ${r.text}`);
      assert.equal(r.body.code, 'GRAPH_DISCOVERY_UNAVAILABLE'); assert.equal(r.body.conversations, undefined); assert.equal(r.body.nextAfterCommit, undefined);
      const back = await feed(s.base, `afterCommit=${cur}&limit=10`);
      assert.equal(back.status, 200, back.text); assert.equal(back.body.nextAfterCommit, cur, 'control: back on the real store the cursor is idle at the head');
    } finally { s.proxy.unswap(); await killExecutor(execB); }
  });
});

test('I6 A FILTERED IDLE POLL echoes a cursor carrying the SAME filter scope: at the head, with mentions_me, the answer is an empty page whose cursor is byte-identical to the request\'s, it is accepted again with that filter, and it is refused (400 CURSOR_FILTER_MISMATCH) without it; a write that matches the filter is then delivered once', { skip: SKIP }, async () => {
  await stack(entriesBoard(MUTS, { mentions: { 'm-a': ['bea'], 'm-c': ['bea'] } }), async (s) => {
    assert.equal((await publish(s.base, 'm-a')).body.status, 'published'); assert.equal((await publish(s.base, 'm-b')).body.status, 'published');
    let page = await feed(s.base, 'afterCommit=start&limit=200&mentions_me=bea');
    while (page.body.phase === 'bootstrap') page = await feed(s.base, `afterCommit=${page.body.nextAfterCommit}&limit=200&mentions_me=bea`);
    assert.equal(page.status, 200, page.text); const cur = page.body.nextAfterCommit; assert.match(cur, GC, 'control: a filtered live cursor');
    assert.notEqual(cur.split('.')[4], scopeOf({}), 'control: its scope is NOT the unfiltered scope, so an echo of the wrong scope is distinguishable');
    const idle = await feed(s.base, `afterCommit=${cur}&limit=50&mentions_me=bea`);
    assert.equal(idle.status, 200, idle.text); assert.deepEqual(idle.body.conversations, []); assert.equal(idle.body.nextAfterCommit, cur, 'the echoed cursor is byte-identical to the request cursor');
    assert.equal((await feed(s.base, `afterCommit=${idle.body.nextAfterCommit}&limit=50&mentions_me=bea`)).status, 200, 'the echoed cursor is accepted again with the same filter');
    const mism = await feed(s.base, `afterCommit=${idle.body.nextAfterCommit}&limit=50`);
    assert.equal(mism.status, 400, mism.text); assert.equal(mism.body.code, 'CURSOR_FILTER_MISMATCH');
    assert.equal((await publish(s.base, 'm-c')).body.status, 'published');
    assert.deepEqual(ids(await feed(s.base, `afterCommit=${cur}&limit=50&mentions_me=bea`)), [idOf('m-c')], 'a matching write is delivered once');
  });
});
