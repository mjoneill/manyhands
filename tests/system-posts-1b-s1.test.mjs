/**
 * STEP 1b OF PHASE 2: THE BOARD'S OWN POSTS LEAVE THE DOCUMENT (the proposal and its revisions 1 and 2 on #1574; all six slots are obligations, a post published through the graph must still notify
 * where the slot notifies today, the sequence is taken from the same counter as ordinary posts). Written by the separate test author BEFORE the build, black-box through REST, a REAL executor
 * behind a forwarding proxy that can take the executor DOWN, and a recording HTTP sink standing in for the MCP server's notify endpoint. Synthetic content. Without a python with pyoxigraph every row
 * is SKIPPED, and a skip is NOT a pass. This file pins the BEHAVIOUR; the interfaces the build is still to name (the batch-complete route, the reconciler's invocation, the legacy-close script) have
 * their rows listed under NOT COVERED and are written when those names exist.
 *
 *   G0  CONTROL, THE UNIT OFF IS UNCHANGED: with no graph unit a claim writes its announcement into the DOCUMENT and notifies once. (Green today; it must stay green: "with the unit off, behaviour is unchanged".)
 *   G1  ONE CLAIM, ONE POST, ONE NOTIFY, NONE IN THE DOCUMENT: with the unit on, after a claim the post is readable exactly once within 20 s, the sink got exactly one notify naming it, and after a kill
 *       -9 and a restart the document still holds no post.
 *   G2  EVERY DRIVABLE SLOT, WITH TODAY'S NOTIFY POLICY: release (a claimed post and a released post, two notifies), the done-nudge (one post, one notify) and the wiki page notice (one post, NO notify:
 *       the frozen policy) each leave exactly one post per event, none in the document.
 *   G3  A GRAPH OUTAGE NEVER COSTS THE CLAIM AND NEVER LOSES THE ANNOUNCEMENT: with the executor DOWN a claim still answers 200 and the card is claimed; with the executor back and the server restarted,
 *       the separately supervised reconciler (`announce-publisher.mjs --once`, a process of its own: revised 16:30Z for placement A, C2 item 2) runs and exactly one post appears within 20 s, the sink saw at least one and at most two notifies for it (at-least-once, never zero), and the document holds no post.
 *   G4  NO TWO POSTS SHARE A NUMBER: claims, releases and ordinary posts committed back to back, then read: every postSeq is distinct, and the ordinary posts are in submission order.
 *
 * NOT COVERED, by name (rows owed once the build names the interface): agent rest/retire (not drivable by one API call here); the reconciler as a separate process and "two reconcilers, one post"; the batch
 * completion route and "one document write per pass"; the one-write close of the 219 legacy entries and the migration script; the notify-dispatch ordering (publish, APPLIED, dispatch, then completion) and the
 * crash between dispatch and completion; a mutated stored payload becoming a loud collision; that the sequence and publication time are in the ORIGINATING write (an internal field, named by the build).
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
import { loadDomain } from '../core/store.mjs';
import { domainToBoard } from '../core/mapping.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const DSID = 'sys-test';
const EPOCH_DOC = '11111111-2222-4333-8444-555555555555';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROSTER_FILE = path.join(os.tmpdir(), `sys-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, bo: { name: 'Bo', glyph: 'b', color: '#8899aa' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));

const api = async (base, method, route, body) => {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(40000) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text };
};
const docPosts = (file) => domainToBoard(loadDomain(file)).conversations || [];
async function until(fn, ms, step = 250) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(step); } }

/** Stands in for the MCP server's /internal/notify: records every POST {conversation}. */
async function startSink() {
  const s = { events: [] };
  s.server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    try { s.events.push(JSON.parse(Buffer.concat(chunks).toString('utf8')).conversation); } catch { /* not ours */ }
    res.statusCode = 200; res.end('{}');
  });
  await new Promise((r) => s.server.listen(0, '127.0.0.1', r));
  s.url = `http://127.0.0.1:${s.server.address().port}/internal/notify`;
  s.matching = (rx) => s.events.filter((c) => rx.test(String(c?.body)));
  s.stop = () => new Promise((r) => { s.server.closeAllConnections?.(); s.server.close(() => r()); });
  return s;
}
/** A forwarding proxy in front of the executor that can be taken DOWN (a new connection is refused) and brought back on the same port. */
async function startProxy(execUrl) {
  const p = {};
  p.server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const fwd = { ...req.headers }; delete fwd.host; delete fwd['content-length']; delete fwd.connection;
    try { const f = await fetch(`${execUrl}${req.url}`, { method: req.method, headers: fwd, ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) }); const t = await f.text(); res.statusCode = f.status; res.end(t); }
    catch { try { req.socket.destroy(); } catch { /* gone */ } }
  });
  await new Promise((r) => p.server.listen(0, '127.0.0.1', r)); p.port = p.server.address().port; p.url = `http://127.0.0.1:${p.port}`;
  p.down = () => new Promise((r) => { p.server.closeAllConnections?.(); p.server.close(() => r()); });
  p.up = () => new Promise((r, j) => { p.server.once('error', j); p.server.listen(p.port, '127.0.0.1', r); });
  return p;
}
const PUBLISHER = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'scripts', 'announce-publisher.mjs');
/** The separately supervised reconciler, run once as its own process with a board key file (what C2 item 2 specifies). Resolves with its exit code. */
const runPublisherOnce = (base, tag) => new Promise((resolve) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sys-pub-${tag}-`)); const key = path.join(dir, 'board.key'); fs.writeFileSync(key, 'sk-test-not-a-secret', { mode: 0o600 });
  const ch = spawn(process.execPath, [PUBLISHER, '--board', base, '--key-file', key, '--status', path.join(dir, 'status.json'), '--once'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; ch.stderr.on('data', (d) => { err += d; }); ch.on('exit', (code) => resolve({ code, err }));
});
const card = (shortId, title) => ({ id: `c${shortId}`, shortId, title, description: '', type: 'task', column: 'backlog', order: shortId, assignees: ['unassigned'], labels: [], priority: null, version: 1, createdAt: '2026-09-14T00:00:00.000Z', updatedAt: '2026-09-14T00:00:00.000Z', relationships: { relatedTo: [], blockedBy: [] } });

/** unit on: executor + proxy + sink + REST. `restart()` is a kill -9 and a new REST on the SAME board file and executor. */
async function stackOn(body) {
  const exec = await startExecutor({ store: tmpStore('sys-store-'), datasetId: DSID, create: true });
  const proxy = await startProxy(exec.baseUrl);
  const sink = await startSink();
  const env = { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: DSID, SCRUM_GRAPH_EXECUTOR_URL: proxy.url, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1' };
  let rest = await startRestServer({ board: makeBoardFixture({ cards: [card(1, 'one'), card(2, 'two')], nextShortId: 3, postSeqEpoch: EPOCH_DOC, nextPostSeq: 1 }), mcpNotifyUrl: sink.url, env });
  try {
    const ctx = { get base() { return rest.baseUrl; }, file: rest.boardFile, proxy, sink, restart: async () => { rest.kill(); rest = await startRestServer({ boardFile: rest.boardFile, mcpNotifyUrl: sink.url, env }); return rest.baseUrl; } };
    return await body(ctx);
  } finally { try { await rest.stop(); } catch { /* gone */ } try { await proxy.down(); } catch { /* down */ } await sink.stop(); await killExecutor(exec); }
}
const announcements = async (base, rx) => { const l = await api(base, 'GET', '/api/conversations'); return l.status === 200 ? l.body.filter((c) => c.author !== 'ada' && rx.test(String(c.body))) : []; };

test('G0 CONTROL, THE UNIT OFF IS UNCHANGED: a claim writes its announcement into the DOCUMENT and notifies once', { timeout: 120000 }, async () => {
  const sink = await startSink();
  const rest = await startRestServer({ board: makeBoardFixture({ cards: [card(1, 'one')], nextShortId: 2 }), mcpNotifyUrl: sink.url, env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
  try {
    const c = await api(rest.baseUrl, 'POST', '/api/cards/c1/claim', { by: 'ada' });
    assert.equal(c.status, 200, c.text.slice(0, 200));
    await sleep(500);
    rest.kill();
    const held = docPosts(rest.boardFile).filter((p) => /ada claimed #1/.test(String(p.body)));
    assert.equal(held.length, 1, `with the unit off the announcement is a document post (${held.length})`);
    assert.equal(sink.matching(/ada claimed #1/).length, 1, 'and the sink got exactly one notify for it');
  } finally { try { await rest.stop(); } catch { /* gone */ } await sink.stop(); }
});

test('G1 ONE CLAIM, ONE POST, ONE NOTIFY, NONE IN THE DOCUMENT: with the unit on the post is readable exactly once within 20 s, the sink got one notify, and the document holds no post after a kill and restart', { skip: SKIP, timeout: 180000 }, async () => {
  await stackOn(async (ctx) => {
    const c = await api(ctx.base, 'POST', '/api/cards/c1/claim', { by: 'ada' });
    assert.equal(c.status, 200, c.text.slice(0, 200));
    const got = await until(async () => (await announcements(ctx.base, /ada claimed #1/)).length >= 1, 20000);
    assert.ok(got, 'the claim announcement is readable within 20 s');
    await sleep(1500);   // time for a duplicate to show if there is one
    assert.equal((await announcements(ctx.base, /ada claimed #1/)).length, 1, 'exactly one post for one claim');
    assert.equal(ctx.sink.matching(/ada claimed #1/).length, 1, `exactly one notify for one claim (${ctx.sink.matching(/ada claimed #1/).length})`);
    await ctx.restart();
    assert.equal(docPosts(ctx.file).length, 0, `the document holds no post after a restart (it holds ${docPosts(ctx.file).length}: ${docPosts(ctx.file).map((p) => String(p.body).slice(0, 40)).join(' | ')})`);
  });
});

test('G2 EVERY DRIVABLE SLOT, WITH TODAY\'S NOTIFY POLICY: release (two posts, two notifies), the done-nudge (one post, one notify) and the wiki notice (one post, no notify), none in the document', { skip: SKIP, timeout: 240000 }, async () => {
  await stackOn(async (ctx) => {
    assert.equal((await api(ctx.base, 'POST', '/api/cards/c1/claim', { by: 'ada' })).status, 200);
    assert.equal((await api(ctx.base, 'DELETE', '/api/cards/c1/claim', { by: 'ada' })).status, 200);
    assert.equal((await api(ctx.base, 'PATCH', '/api/cards/c2', { column: 'done', by: 'ada' })).status, 200);
    assert.ok([200, 201].includes((await api(ctx.base, 'POST', '/api/nodes', { title: 'a page g2-marker', body: 'x', createdBy: 'ada' })).status));
    const want = [[/ada claimed #1/, 1], [/ada released #1/, 1], [/#2 done — what's the next pull/, 1], [/page created: \*\*a page g2-marker\*\*/, 1]];
    for (const [rx, n] of want) assert.ok(await until(async () => (await announcements(ctx.base, rx)).length >= n, 20000), `${rx} is readable within 20 s`);
    await sleep(1500);
    for (const [rx, n] of want) assert.equal((await announcements(ctx.base, rx)).length, n, `exactly ${n} post for ${rx}`);
    assert.equal(ctx.sink.matching(/ada claimed #1/).length, 1, 'claim notifies once');
    assert.equal(ctx.sink.matching(/ada released #1/).length, 1, 'release notifies once');
    assert.equal(ctx.sink.matching(/#2 done/).length, 1, 'the done-nudge notifies once');
    assert.equal(ctx.sink.matching(/page created/).length, 0, 'the wiki notice notifies nobody (the frozen policy)');
    await ctx.restart();
    assert.equal(docPosts(ctx.file).length, 0, `the document holds no post (it holds ${docPosts(ctx.file).length})`);
  });
});

test('G3 A GRAPH OUTAGE NEVER COSTS THE CLAIM AND NEVER LOSES THE ANNOUNCEMENT: with the executor down the claim answers 200; once it is back and the server restarted, exactly one post appears within 20 s, one or two notifies, none in the document', { skip: SKIP, timeout: 240000 }, async () => {
  await stackOn(async (ctx) => {
    await ctx.proxy.down();
    const c = await api(ctx.base, 'POST', '/api/cards/c1/claim', { by: 'ada' });
    assert.equal(c.status, 200, `a graph outage does not cost the claim: ${c.status} ${c.text.slice(0, 200)}`);
    const board = await api(ctx.base, 'GET', '/api/board');   // the board read, not the card page: the card page reads its comments from the graph, which is down
    assert.equal(board.status, 200, board.text.slice(0, 200));
    assert.equal((board.body.cards || []).find((x) => x.id === 'c1')?.claimedBy, 'ada', 'and the card is claimed');
    await ctx.restart();   // a crash with the obligation committed and the post not yet published
    await ctx.proxy.up();
    // REST makes ONE inline attempt and does not drain by itself (C2 item 2): recovery is the separately supervised reconciler, run here once as its own process.
    const rec = await runPublisherOnce(ctx.base, 'g3'); assert.equal(rec.code, 0, `the reconciler completes its run (${rec.code}) ${rec.err.slice(0, 160)}`);
    const got = await until(async () => (await announcements(ctx.base, /ada claimed #1/)).length >= 1, 20000);
    assert.ok(got, 'the announcement is published within 20 s of the reconciler running: it was not lost');
    await sleep(2000);
    assert.equal((await announcements(ctx.base, /ada claimed #1/)).length, 1, 'exactly one post');
    const n = ctx.sink.matching(/ada claimed #1/).length;
    assert.ok(n >= 1 && n <= 2, `at-least-once, never zero and never more than a replay: ${n} notifies`);
    await ctx.restart();
    assert.equal(docPosts(ctx.file).length, 0, `the document holds no post (it holds ${docPosts(ctx.file).length})`);
  });
});

test('G4 NO TWO POSTS SHARE A NUMBER: claims, releases and ordinary posts back to back are read with distinct numbers, and the ordinary posts in submission order', { skip: SKIP, timeout: 240000 }, async () => {
  await stackOn(async (ctx) => {
    const mine = [];
    for (let i = 0; i < 4; i++) {
      assert.equal((await api(ctx.base, 'POST', '/api/cards/c1/claim', { by: 'ada' })).status, 200);
      const p = await api(ctx.base, 'POST', '/api/conversations', { author: 'ada', body: `ordinary ${i} g4-marker` }); assert.equal(p.status, 201, p.text.slice(0, 200)); mine.push(p.body.id);
      assert.equal((await api(ctx.base, 'DELETE', '/api/cards/c1/claim', { by: 'ada' })).status, 200);
    }
    assert.ok(await until(async () => (await announcements(ctx.base, /ada (claimed|released) #1/)).length >= 8, 25000), 'all eight announcements are readable within 25 s');
    await sleep(1500);
    const l = await api(ctx.base, 'GET', '/api/conversations'); assert.equal(l.status, 200);
    const seqs = l.body.map((c) => c.postSeq);
    assert.ok(seqs.every(Number.isSafeInteger), 'every post is numbered');
    assert.equal(new Set(seqs).size, seqs.length, `no two posts share a number (${seqs.length} posts)`);
    const order = mine.map((id) => l.body.find((c) => c.id === id).postSeq);
    assert.deepEqual([...order].sort((a, b) => a - b), order, `the ordinary posts keep submission order: ${order}`);
  });
});
