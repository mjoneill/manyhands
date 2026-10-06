/**
 * STEP 1b, SECOND FILE: the rows on the names the builder gave at 15:07Z (agent rest/retire through `PATCH /api/agents/:seat`, the reconciler `scripts/announce-publisher.mjs --once` as a separate process,
 * the originating write carrying the sequence and publication time, the test barrier `after-dispatch-before-complete`). Written by the separate test author BEFORE the build. Black-box through REST, a REAL
 * executor behind a proxy that can go DOWN, a recording sink for the MCP notify endpoint. Synthetic content. Without a python with pyoxigraph every row is SKIPPED, and a skip is NOT a pass.
 *
 *   H1  AGENT REST: `PATCH /api/agents/bo {state:'resting'}` for an agent holding one card gives exactly ONE origin and ONE obligation (slot `agent-rest`, mode `publisher`), the post is readable exactly
 *       once within 20 s, NOBODY is notified (the frozen policy: agent-rest is no-notify), and the document holds no post. Releasing ZERO cards gives no origin, no obligation and no post.
 *       (The builder's note said `status:'resting'`; the route's field is `state`, so this file sends `state`.)
 *   H2  AGENT RETIRE: the same with `state:'retired'` and slot `agent-retire`; one card gives one origin and one obligation, zero cards none, the post is readable exactly once, none in the document.
 *       Retire is no-notify too: today's code pings on neither rest nor retire, and the builder confirmed at 15:11Z that "freeze today's policy" makes `agent-retire` notify:false.
 *   H3  THE ORIGINATING WRITE CARRIES THE ORDER: with the executor down, straight after a claim's 200 the pending obligation already holds an integer `postSeq` and a string `publicationAt` and is in
 *       `publisher` mode, before any publish has run.
 *   H4  TWO RECONCILERS, ONE POST: with the executor down at the claim and then back, two CONCURRENT `announce-publisher.mjs --once` runs leave exactly one post for the claim, none in the document.
 *   H6  REST DOES NOT DRAIN BY ITSELF (placement A, C2 item 2): an announcement whose inline attempt failed (executor down at the claim) stays PENDING, and stays pending with the executor back, with REST left alone for 12 s, and
 *       after a REST restart with another 12 s: no post is readable and the outbox entry is still `pending`. Then ONE run of the reconciler publishes it (exactly one post). This pins the placement decision so an in-process
 *       retry tick or boot drain cannot come back silently.
 *   H5  DISPATCH BEFORE COMPLETION (recovery by the reconciler, revised 16:30Z for placement A): the barrier `after-dispatch-before-complete` (a fifo in SCRUM_TEST_BARRIER_DIR, as `after-executor-apply` is). With the server killed AT it, after a restart there is
 *       exactly one post, the sink saw a SECOND dispatch carrying the SAME post id, and the entry reads `published`: completion is recorded only after a dispatch.
 *
 * NOT COVERED, by name: the batch-complete route and the one-write close of the 219 legacy entries (a document-write count needs an instrument; a file-watch cannot count two writes a millisecond apart,
 * so these wait for a counter the builder is asked to expose); "board key only" authorisation on those routes (the harness would need auth configured); a mutated stored payload becoming
 * `publisher-intent-collision` (needs a divergent post planted in the executor under the entry's opId); that a retire notifies; that a restart between commit and publish yields the same digest (H3 and H5
 * show the fields and the replay; the digest itself is an executor-side property pinned by the existing C3c rows).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { makeBoardFixture, startRestServer } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';
import { loadDomain } from '../core/store.mjs';
import { domainToBoard } from '../core/mapping.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const DSID = 'sys2-test';
const EPOCH_DOC = '11111111-2222-4333-8444-555555555555';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROSTER_FILE = path.join(os.tmpdir(), `sys2-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, bo: { name: 'Bo', glyph: 'b', color: '#8899aa' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
const PUBLISHER = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'scripts', 'announce-publisher.mjs');

const api = async (base, method, route, body) => {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(40000) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text };
};
const docPosts = (file) => domainToBoard(loadDomain(file)).conversations || [];
async function until(fn, ms, step = 250) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(step); } }
async function startSink() {
  const s = { events: [] };
  s.server = http.createServer(async (req, res) => { const chunks = []; for await (const c of req) chunks.push(c); try { s.events.push(JSON.parse(Buffer.concat(chunks).toString('utf8')).conversation); } catch { /* not ours */ } res.statusCode = 200; res.end('{}'); });
  await new Promise((r) => s.server.listen(0, '127.0.0.1', r)); s.url = `http://127.0.0.1:${s.server.address().port}/internal/notify`;
  s.matching = (rx) => s.events.filter((c) => rx.test(String(c?.body)));
  s.stop = () => new Promise((r) => { s.server.closeAllConnections?.(); s.server.close(() => r()); });
  return s;
}
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
const card = (shortId, title, extra = {}) => ({ id: `c${shortId}`, shortId, title, description: '', type: 'task', column: 'backlog', order: shortId, assignees: ['unassigned'], labels: [], priority: null, version: 1, createdAt: '2026-09-14T00:00:00.000Z', updatedAt: '2026-09-14T00:00:00.000Z', relationships: { relatedTo: [], blockedBy: [] }, ...extra });
const heldByBo = () => card(1, 'held by bo', { claimedBy: 'bo', claimedAt: '2026-09-14T01:00:00.000Z' });

async function stackOn(cards, body, { barrierDir = null } = {}) {
  const exec = await startExecutor({ store: tmpStore('sys2-store-'), datasetId: DSID, create: true });
  const proxy = await startProxy(exec.baseUrl);
  const sink = await startSink();
  const env = { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: DSID, SCRUM_GRAPH_EXECUTOR_URL: proxy.url, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', ...(barrierDir ? { SCRUM_TEST_BARRIER_DIR: barrierDir } : {}) };
  let rest = await startRestServer({ board: makeBoardFixture({ cards, nextShortId: 10, postSeqEpoch: EPOCH_DOC, nextPostSeq: 1 }), mcpNotifyUrl: sink.url, env });
  try {
    const ctx = { get base() { return rest.baseUrl; }, get file() { return rest.boardFile; }, proxy, sink, exec, kill: () => rest.kill(), restart: async () => { rest.kill(); rest = await startRestServer({ boardFile: rest.boardFile, mcpNotifyUrl: sink.url, env }); return rest.baseUrl; } };
    return await body(ctx);
  } finally { try { await rest.stop(); } catch { /* gone */ } try { await proxy.down(); } catch { /* down */ } await sink.stop(); await killExecutor(exec); }
}
const announcements = async (base, rx) => { const l = await api(base, 'GET', '/api/conversations'); return l.status === 200 ? l.body.filter((c) => c.author !== 'ada' && rx.test(String(c.body))) : []; };
const outbox = async (base, q = '') => { const r = await api(base, 'GET', `/api/outbox${q}`); assert.equal(r.status, 200, r.text.slice(0, 200)); return r.body; };
const makeAgent = (base) => api(base, 'POST', '/api/agents', { by: 'ada', seatKey: 'bo', prompt: 'You are Bo, a synthetic colleague.', model: { model: 'test-model', protocol: 'ollama' } });

for (const [verb, state, slot, notifies] of [['REST', 'resting', 'agent-rest', false], ['RETIRE', 'retired', 'agent-retire', false]]) {
  test(`H${verb === 'REST' ? 1 : 2} AGENT ${verb}: one held card gives one origin and one obligation (slot ${slot}, mode publisher), one post readable within 20 s, none in the document${notifies === false ? ', nobody notified (today\'s policy: neither rest nor retire pings)' : ''}; zero held cards give none`, { skip: SKIP, timeout: 240000 }, async () => {
    await stackOn([heldByBo(), card(2, 'free')], async (ctx) => {
      const made = await makeAgent(ctx.base); assert.ok([200, 201].includes(made.status), `the agent is created: ${made.status} ${made.text.slice(0, 200)}`);
      const r = await api(ctx.base, 'PATCH', '/api/agents/bo', { state, by: 'ada' });
      assert.equal(r.status, 200, `the ${state} is accepted: ${r.status} ${r.text.slice(0, 200)}`);
      const ob = await outbox(ctx.base);
      const origins = Object.values(ob.origins ? (Array.isArray(ob.origins) ? Object.fromEntries(ob.origins.map((o) => [o.mutationId, o])) : ob.origins) : {}).filter((o) => (o.slots || []).includes(slot));
      const entries = (Array.isArray(ob.entries) ? ob.entries : Object.values(ob.entries || {})).filter((e) => e.slot === slot);
      assert.equal(origins.length, 1, `exactly one origin for ${slot} (${origins.length})`);
      assert.equal(entries.length, 1, `exactly one obligation for ${slot} (${entries.length})`);
      assert.equal(entries[0].mode, 'publisher', `in publisher mode (${entries[0].mode})`);
      const rx = new RegExp(`bo is ${state}`);
      assert.ok(await until(async () => (await announcements(ctx.base, rx)).length >= 1, 20000), `the post is readable within 20 s`);
      await sleep(1500);
      assert.equal((await announcements(ctx.base, rx)).length, 1, 'exactly one post');
      if (notifies === false) assert.equal(ctx.sink.matching(rx).length, 0, `${slot} is no-notify (today's policy): nobody was pinged`);
      await ctx.restart();
      assert.equal(docPosts(ctx.file).length, 0, `the document holds no post (it holds ${docPosts(ctx.file).length})`);
    });
    // zero held cards: nothing to announce
    await stackOn([card(2, 'free')], async (ctx) => {
      assert.ok([200, 201].includes((await makeAgent(ctx.base)).status));
      assert.equal((await api(ctx.base, 'PATCH', '/api/agents/bo', { state, by: 'ada' })).status, 200);
      const ob = await outbox(ctx.base);
      const entries = (Array.isArray(ob.entries) ? ob.entries : Object.values(ob.entries || {})).filter((e) => e.slot === slot);
      assert.equal(entries.length, 0, `releasing zero cards gives no obligation (${entries.length})`);
      await sleep(1500);
      assert.equal((await announcements(ctx.base, new RegExp(`bo is ${state}`))).length, 0, 'and no post');
    });
  });
}

test('H3 THE ORIGINATING WRITE CARRIES THE ORDER: with the executor down, straight after a claim\'s 200 the pending obligation holds an integer postSeq and a string publicationAt, in publisher mode', { skip: SKIP, timeout: 180000 }, async () => {
  await stackOn([card(1, 'one')], async (ctx) => {
    await ctx.proxy.down();
    const c = await api(ctx.base, 'POST', '/api/cards/c1/claim', { by: 'ada' });
    assert.equal(c.status, 200, c.text.slice(0, 200));
    const ob = await outbox(ctx.base, '?status=pending');
    const entries = (Array.isArray(ob.entries) ? ob.entries : Object.values(ob.entries || {})).filter((e) => e.slot === 'claim');
    assert.equal(entries.length, 1, `one pending claim obligation (${entries.length})`);
    assert.equal(entries[0].mode, 'publisher', `in publisher mode (${entries[0].mode})`);
    assert.ok(Number.isSafeInteger(entries[0].postSeq), `it already holds an integer postSeq (${JSON.stringify(entries[0].postSeq)})`);
    assert.equal(typeof entries[0].publicationAt, 'string', `and a string publicationAt (${JSON.stringify(entries[0].publicationAt)})`);
  });
});

test('H4 TWO RECONCILERS, ONE POST: two concurrent `announce-publisher.mjs --once` runs leave exactly one post for the claim, none in the document', { skip: SKIP, timeout: 240000 }, async () => {
  await stackOn([card(1, 'one')], async (ctx) => {
    await ctx.proxy.down();
    assert.equal((await api(ctx.base, 'POST', '/api/cards/c1/claim', { by: 'ada' })).status, 200);
    await ctx.restart();
    await ctx.proxy.up();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sys2-pub-')); const key = path.join(dir, 'board.key'); fs.writeFileSync(key, 'sk-test-not-a-secret', { mode: 0o600 });
    const run = (n) => new Promise((resolve) => { const ch = spawn(process.execPath, [PUBLISHER, '--board', ctx.base, '--key-file', key, '--status', path.join(dir, `st${n}.json`), '--once'], { stdio: ['ignore', 'ignore', 'pipe'] }); let err = ''; ch.stderr.on('data', (d) => { err += d; }); ch.on('exit', (code) => resolve({ code, err })); });
    const [a, b] = await Promise.all([run(1), run(2)]);
    assert.ok(a.code === 0 && b.code === 0, `both runs complete (${a.code}, ${b.code}) ${a.err.slice(0, 120)}${b.err.slice(0, 120)}`);
    assert.ok(await until(async () => (await announcements(ctx.base, /ada claimed #1/)).length >= 1, 20000), 'the post is readable');
    await sleep(1500);
    assert.equal((await announcements(ctx.base, /ada claimed #1/)).length, 1, 'exactly one post after two reconcilers');
    await ctx.restart();
    assert.equal(docPosts(ctx.file).length, 0, `the document holds no post (it holds ${docPosts(ctx.file).length})`);
  });
});

test('H5 DISPATCH BEFORE COMPLETION: killed at the barrier, a restart gives one post, a second dispatch with the same post id, and a published entry', { skip: SKIP, timeout: 240000 }, async () => {
  const barrierDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sys2-barrier-'));
  await stackOn([card(1, 'one')], async (ctx) => {
    const fifo = path.join(barrierDir, 'after-dispatch-before-complete');
    assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
    const inflight = api(ctx.base, 'POST', '/api/cards/c1/claim', { by: 'ada' }).then((r) => ({ status: r.status }), (e) => ({ reset: String(e?.message || e) }));
    let fh = null;
    const reached = await Promise.race([fsp.open(fifo, 'w').then((h) => { fh = h; return true; }), sleep(15000).then(() => false)]);
    if (!reached) { try { fs.closeSync(fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)); } catch { /* none */ } }
    ctx.kill();
    await Promise.race([inflight, sleep(5000)]);
    try { await fh?.close(); } catch { /* ignore */ }
    fs.rmSync(fifo, { force: true });
    assert.equal(reached, true, 'the server reached the barrier `after-dispatch-before-complete` (publish, APPLIED, notify dispatched, completion not yet recorded)');
    const first = ctx.sink.matching(/ada claimed #1/);
    assert.ok(first.length >= 1, `the dispatch had run before the barrier (${first.length})`);
    await ctx.restart();
    // placement A: REST does not replay by itself; the supervised reconciler does (run once as its own process, as H4 does)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sys2-h5-')); const key = path.join(dir, 'board.key'); fs.writeFileSync(key, 'sk-test-not-a-secret', { mode: 0o600 });
    const rec = await new Promise((resolve) => { const ch = spawn(process.execPath, [PUBLISHER, '--board', ctx.base, '--key-file', key, '--status', path.join(dir, 'st.json'), '--once'], { stdio: ['ignore', 'ignore', 'pipe'] }); let err = ''; ch.stderr.on('data', (d) => { err += d; }); ch.on('exit', (code) => resolve({ code, err })); });
    assert.equal(rec.code, 0, `the reconciler completes its run (${rec.code}) ${rec.err.slice(0, 160)}`);
    assert.ok(await until(async () => (await announcements(ctx.base, /ada claimed #1/)).length >= 1, 20000), 'the post is readable after the reconciler ran');
    assert.ok(await until(async () => ctx.sink.matching(/ada claimed #1/).length >= 2, 20000), 'a SECOND dispatch happened when the reconciler replayed it: the crash never skips one');
    const ids = new Set(ctx.sink.matching(/ada claimed #1/).map((c) => c.id));
    assert.equal(ids.size, 1, `both dispatches carry the SAME post id (${[...ids].join(', ')})`);
    const done = await until(async () => { const ob = await outbox(ctx.base); const es = Array.isArray(ob.entries) ? ob.entries : Object.values(ob.entries || {}); return es.find((e) => e.slot === 'claim')?.status === 'published'; }, 20000);
    assert.ok(done, 'the entry reads published: completion was recorded after the dispatch');
    assert.equal((await announcements(ctx.base, /ada claimed #1/)).length, 1, 'still exactly one post');
  }, { barrierDir });
});

test('H6 REST DOES NOT DRAIN BY ITSELF: a pending announcement stays pending with the executor back and REST left alone, and after a REST restart; one reconciler run then publishes it', { skip: SKIP, timeout: 240000 }, async () => {
  await stackOn([card(1, 'one')], async (ctx) => {
    await ctx.proxy.down();
    assert.equal((await api(ctx.base, 'POST', '/api/cards/c1/claim', { by: 'ada' })).status, 200, 'the claim itself succeeds');
    await sleep(2500);   // the inline attempt starts AFTER the answer and is refused in milliseconds; bring the executor back only once it has failed, or the row races the attempt itself
    await ctx.proxy.up();
    const pending = async () => { const ob = await outbox(ctx.base); const es = Array.isArray(ob.entries) ? ob.entries : Object.values(ob.entries || {}); return es.filter((e) => e.slot === 'claim').map((e) => e.status); };
    await sleep(12000);
    assert.deepEqual(await pending(), ['pending'], 'the executor is back and REST was left alone for 12 s: the entry is still pending (no in-process retry)');
    assert.equal((await announcements(ctx.base, /ada claimed #1/)).length, 0, 'and no post is readable');
    await ctx.restart();
    await sleep(12000);
    assert.deepEqual(await pending(), ['pending'], 'after a REST restart and 12 more seconds: still pending (no boot drain)');
    assert.equal((await announcements(ctx.base, /ada claimed #1/)).length, 0, 'and still no post');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sys2-h6-')); const key = path.join(dir, 'board.key'); fs.writeFileSync(key, 'sk-test-not-a-secret', { mode: 0o600 });
    const rec = await new Promise((resolve) => { const ch = spawn(process.execPath, [PUBLISHER, '--board', ctx.base, '--key-file', key, '--status', path.join(dir, 'st.json'), '--once'], { stdio: ['ignore', 'ignore', 'pipe'] }); let err = ''; ch.stderr.on('data', (d) => { err += d; }); ch.on('exit', (code) => resolve({ code, err })); });
    assert.equal(rec.code, 0, `one reconciler run completes (${rec.code}) ${rec.err.slice(0, 160)}`);
    assert.ok(await until(async () => (await announcements(ctx.base, /ada claimed #1/)).length >= 1, 20000), 'the reconciler published it');
    await sleep(1500);
    assert.equal((await announcements(ctx.base, /ada claimed #1/)).length, 1, 'exactly one post');
    assert.ok(await until(async () => (await pending()).every((x) => x === 'published'), 20000), 'and the entry reads published');
  });
});
