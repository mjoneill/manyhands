/**
 * #1629 / sprint #1733 — ROW L: the bounded announcement lifecycle with the board document UNREADABLE. TEST AUTHOR's, written
 * before the slice-3 build, against the design frozen on #1733 (v3 + discriminator addendum, non-builder freeze v15/v16).
 *
 * THE WORLD: the whole-board fixture (tests/helpers/whole-board-1645.mjs) migrated into a real executor; REST started under all six
 * authoritative units and production's four executor sources. Every REST incarnation runs with #1563's fs recorder
 * (SCRUM_FS_RECORD_ALL=1, a module hook the server cannot see or skip) and with SCRUM_TEST_BARRIER_DIR set, so a FIFO named for an
 * existing TEST-ONLY barrier can hold the process at a known point (server.js testBarrier). The publisher is the real
 * scripts/announce-publisher.mjs --once, run as its own process. Nothing here substitutes a harness for the reservation, the
 * publisher or the recovery code.
 *
 * THE CUT POINTS (all existing barriers, named in source at 4c0a1f1; the builder keeps their names and positions in slice 3, 45004):
 *   after-document                   last line of writeDocument; runs only after the staged CARDS.commit (origin + entries) answered
 *                                    APPLIED, and before the claim returns and calls the inline publish. Fires on EVERY writeDocument, so
 *                                    the FIFO is armed only immediately before the claim, and the discriminator below must pass.
 *   after-executor-apply             the explicit publish route (the one --once drives): the executor answered, nothing recorded yet
 *   after-dispatch-before-complete   the inline publish: APPLIED and dispatched, completion not yet recorded
 *
 * THE DISCRIMINATOR AT after-document: the claim's HTTP request has NOT returned, AND the executor (queried directly, REST is frozen)
 * holds a pending announcement whose entry is this claim's (slot `claim`, card #1), with its mutationId, opId, reserved postId and
 * postSeq. If either fails the row fails with "blocked a different write"; it never retries and is never skipped.
 *
 *   L0  CONTROL, mode ON, file present (runnable today): L3's whole sequence. Proves the cut point, the discriminator, the restart
 *       without inline drain, the real --once, and that the recorder DOES see board-file opens in this mode (so it can see what L1–L5
 *       assert is absent).
 *   L1  RESERVATION: mode off, file chmod 000: two new posts take postSeq 3 then 4 (the fixture's graph holds 1 and 2; #1710).
 *   L2  PUBLICATION: a claim's announcement post appears exactly once, and GET /api/outbox?mutationId= reads it published.
 *   L3  RESTART RECOVERY: killed at after-document, a fresh REST lists the same entry pending and does NOT publish it (the post is
 *       absent after a stated wait); one --once publishes the post itself, with the snapshotted postId and postSeq.
 *   L4a APPLIED, completion unrecorded, explicit route: killed at after-executor-apply during --once, restart, --once again: same
 *       mutation/slot/postId/postSeq, exactly one post, no extra postSeq consumed.
 *   L4b the same gap on the inline path (after-dispatch-before-complete; #1574 H5's pattern).
 *   L5  READ PURITY: three GET /api/outbox reads while an entry is pending change nothing; the next post takes the expected number.
 *   Every L1–L5 row: zero board-file attempts in EVERY REST incarnation on the recorder (whose log must be non-empty), and the runtime's
 *   /api/health document counter is 0.
 *
 * L1–L5 are TODO, BLOCKED BY THE MEASURED BOOT REFUSAL (row B, #1733 v2: mode off refuses "outbox … owner #1629, not built"). They are
 * reported on every run and never fail CI until the build lands; then delete BLOCKED and each must pass as a plain test. Every row,
 * L0 included, is UNMEASURED until it has been run; mutant outcomes are measured, never inferred from a mutant's name.
 *
 * NOT covered, by name: production's data shape and size; a crash between the executor commit and writeDocument (no barrier there
 * today); the batch-complete route; notification policy beyond "a replay may dispatch twice, never post twice"; REST integration of any
 * seam below REST (if the build forces one, this design returns for review before freeze).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HAVE_PY } from './helpers/graph-executor-proc.mjs';
import { wholeBoardWorld, WB_DATASET } from './helpers/whole-board-1645.mjs';
import { startRestServer } from './helpers/harness.mjs';
import { createGraphClient } from '../core/graph-client.mjs';
import { createCardsUnit } from '../core/cards-unit.mjs';
import { announcePostId } from '../core/announce-outbox.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const T = { skip: SKIP, timeout: 300000 };
const BLOCKED = { todo: 'blocked by the measured boot refusal (row B, #1733 v2): mode off cannot boot until the outbox (#1629) has its owner; delete BLOCKED when it lands' };
const TB = { ...T, ...BLOCKED };
const HERE = path.dirname(fileURLToPath(import.meta.url));
const RECORDER = path.join(HERE, 'helpers', 'fs-store-recorder.mjs');
const PUBLISHER = path.join(HERE, '..', 'scripts', 'announce-publisher.mjs');
const ROSTER = path.join(os.tmpdir(), `l1629-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
process.once('exit', () => { try { fs.rmSync(ROSTER, { force: true }); } catch { /* best effort */ } });

const UNITS = { SCRUM_GRAPH_UNIT_CARDS: '1', SCRUM_GRAPH_UNIT_COLUMNS: '1', SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_UNIT_LOGBORN: '1', SCRUM_GRAPH_UNIT_SMALLKINDS: '1', SCRUM_GRAPH_UNIT_DELIVERIES: '1' };
const SOURCES = { SCRUM_GRAPH_QUERY_SOURCE: 'executor', SCRUM_GRAPH_READY_SOURCE: 'executor', SCRUM_GRAPH_CHECKS_SOURCE: 'executor', SCRUM_GRAPH_NEIGHBORS_SOURCE: 'executor' };
const OPENS = (health) => health?.document?.attemptedOpens;   // #1563's runtime counter (the builder's name)
const CLAIM_RX = /ada claimed #1\b/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, step = 250) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(step); } }
const entriesOf = (ob) => (Array.isArray(ob?.entries) ? ob.entries : Object.values(ob?.entries || {}));

/** One fixture world. `rest(n)` starts REST incarnation n with its own recorder file; every incarnation is recorded. */
async function world(mode, body) {
  const w = await wholeBoardWorld({ env: { ...UNITS, ...SOURCES } });
  const kept = fs.readFileSync(w.boardFile);
  await w.rest.stop(); fs.writeFileSync(w.boardFile, kept);   // the harness unlinks the board file on stop
  const barrierDir = fs.mkdtempSync(path.join(os.tmpdir(), 'l1629-barrier-'));
  const exec = createCardsUnit({ client: createGraphClient({ baseUrl: w.exec.baseUrl, expectedDatasetId: WB_DATASET, timeoutMs: 30000, label: 'l1629-test' }), mintId: () => 'unused' });
  const incarnations = [];
  let current = null;
  const prepareFile = () => {
    try { fs.chmodSync(w.boardFile, 0o644); } catch { /* absent */ }
    if (mode === 'on') { if (!fs.existsSync(w.boardFile)) fs.writeFileSync(w.boardFile, kept); return; }
    if (!fs.existsSync(w.boardFile)) fs.writeFileSync(w.boardFile, kept);
    fs.chmodSync(w.boardFile, 0o000);   // off: the document exists and is UNREADABLE for every incarnation
  };
  const start = async () => {
    prepareFile();
    const priv = fs.mkdtempSync(path.join(os.tmpdir(), 'l1629-r-'));
    const rec = path.join(priv, 'fs.txt');
    const savedTmp = process.env.TMPDIR; process.env.TMPDIR = priv;
    let r;
    try {
      r = await startRestServer({ boardFile: w.boardFile, env: { SCRUM_GRAPH_DATASET_ID: WB_DATASET, SCRUM_GRAPH_EXECUTOR_URL: w.exec.baseUrl, SCRUM_ROSTER_FILE: ROSTER, ...UNITS, ...SOURCES, ...(mode === 'off' ? { SCRUM_BOARD_DOCUMENT: 'off' } : {}), SCRUM_TEST_BARRIER_DIR: barrierDir, SCRUM_FS_RECORD: rec, SCRUM_FS_RECORD_ALL: '1', NODE_OPTIONS: `--import ${RECORDER}` } });
    } catch (e) { fs.rmSync(priv, { recursive: true, force: true }); throw e; } finally {
      if (savedTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmp;
    }
    const lines = () => (fs.existsSync(rec) ? fs.readFileSync(rec, 'utf8').split('\n').filter(Boolean) : []);
    const real = () => { try { return fs.realpathSync.native(path.dirname(w.boardFile)) + '/' + path.basename(w.boardFile); } catch { return w.boardFile; } };
    const inc = { r, priv, rec, n: incarnations.length + 1, recorded: () => lines().length, boardOpens: () => lines().filter((l) => l === w.boardFile || l === real()).length };
    incarnations.push(inc); current = inc;
    return inc;
  };
  const call = async (method, route, payload) => {
    const x = await fetch(`${current.r.baseUrl}${route}`, { method, ...(payload ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(60000) });
    const t = await x.text(); let j = null; try { j = JSON.parse(t); } catch { /* not json */ } return { status: x.status, text: t, json: j };
  };
  const kill = () => { current.r.kill('SIGKILL'); };
  const stopCurrent = async () => { try { fs.chmodSync(w.boardFile, 0o644); } catch { /* absent */ } const had = fs.existsSync(w.boardFile) ? fs.readFileSync(w.boardFile) : null; await current.r.stop().catch(() => {}); if (had) fs.writeFileSync(w.boardFile, had); };
  const restart = async () => { kill(); await sleep(300); return start(); };
  const publishOnce = () => new Promise((resolve) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l1629-pub-')); const key = path.join(dir, 'board.key'); fs.writeFileSync(key, 'sk-test-not-a-secret', { mode: 0o600 });
    const rec = path.join(dir, 'fs.txt');
    const ch = spawn(process.execPath, [PUBLISHER, '--board', current.r.baseUrl, '--key-file', key, '--status', path.join(dir, 'st.json'), '--once'], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, SCRUM_FS_RECORD: rec, SCRUM_FS_RECORD_ALL: '1', NODE_OPTIONS: `--import ${RECORDER}` } });
    let err = ''; ch.stderr.on('data', (d) => { err += d; });
    ch.on('exit', (code) => { const lines = fs.existsSync(rec) ? fs.readFileSync(rec, 'utf8').split('\n').filter(Boolean) : []; resolve({ code, err, boardOpens: lines.filter((l) => l.endsWith(path.basename(w.boardFile)) && l.includes(path.basename(path.dirname(w.boardFile)))).length, recorded: lines.length }); fs.rmSync(dir, { recursive: true, force: true }); });
  });
  /** The claim's posts, read from REST (author `board` or any non-ada system author). */
  const claimPosts = async () => { const l = await call('GET', '/api/conversations?limit=200'); const xs = Array.isArray(l.json) ? l.json : (l.json?.conversations || []); return xs.filter((c) => CLAIM_RX.test(String(c.body)) && c.author !== 'ada'); };
  /** Directly from the executor (REST may be frozen): this claim's pending announcement records. */
  const claimRecords = async () => {
    const recs = await exec.pendingAnnouncements();
    const out = [];
    for (const r of recs) {
      let rec; try { rec = JSON.parse(r.json); } catch { continue; }
      for (const e of Object.values(rec.entries || {})) {
        if (e?.slot !== 'claim') continue;
        out.push({ mutationId: e.mutationId ?? r.mutationId, slot: e.slot, opId: e.opId ?? null, obligationId: e.obligationId, postId: announcePostId(e.mutationId ?? r.mutationId, e.slot), postSeq: e.postSeq, status: e.status, mode: e.mode });
      }
    }
    return out;
  };
  /** Arm a FIFO barrier, fire `request`, and wait until REST is held at it. Returns { reached, inflight, done, release }. */
  const holdAt = async (name, request) => {
    const fifo = path.join(barrierDir, name);
    assert.equal(spawnSync('mkfifo', [fifo]).status, 0, `PRECONDITION: mkfifo ${name}`);
    let returned = false;
    const inflight = request().then((r) => { returned = true; return r; }, (e) => { returned = true; return { reset: String(e?.message || e) }; });
    let fh = null;
    const reached = await Promise.race([fsp.open(fifo, 'w').then((h) => { fh = h; return true; }), sleep(20000).then(() => false)]);
    if (!reached) { try { fs.closeSync(fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)); } catch { /* none */ } }
    const release = async () => { try { await fh?.close(); } catch { /* ignore */ } fs.rmSync(fifo, { force: true }); };
    return { reached, inflight, returned: () => returned, release };
  };
  try {
    await body({ w, start, call, kill, restart, stopCurrent, publishOnce, claimPosts, claimRecords, holdAt, incarnations, barrierDir });
  } finally {
    try { fs.chmodSync(w.boardFile, 0o644); } catch { /* absent */ }
    for (const inc of incarnations) { await inc.r.stop().catch(() => {}); fs.rmSync(inc.priv, { recursive: true, force: true }); }
    try { fs.writeFileSync(w.boardFile, kept); } catch { /* going anyway */ }
    fs.rmSync(barrierDir, { recursive: true, force: true });
    await w.stop();
  }
}

/** Every incarnation's recorder is live; and in mode off none of them attempted the board file, nor did the runtime count one. */
async function documentUntouched(s, mode, label) {
  for (const inc of s.incarnations) assert.ok(inc.recorded() > 0, `${label}: REST incarnation ${inc.n}'s recorder is live (it recorded ${inc.recorded()} paths)`);
  if (mode === 'on') {
    for (const inc of s.incarnations) assert.ok(inc.boardOpens() > 0, `${label} CONTROL: in mode on the recorder SEES incarnation ${inc.n} reach for the board file, so it can see what the off rows assert is absent`);
    return;
  }
  for (const inc of s.incarnations) assert.equal(inc.boardOpens(), 0, `${label}: REST incarnation ${inc.n} attempted the board file ${inc.boardOpens()} time(s)`);
  const h = (await s.call('GET', '/api/health')).json;
  assert.equal(typeof OPENS(h), 'number', `${label}: the runtime exposes its attempted-open counter (got ${JSON.stringify(h?.document)})`);
  assert.equal(OPENS(h), 0, `${label}: the runtime counted no attempted open of the board file`);
}

/** L3's sequence (and L0's, in mode on): crash after the durable origin, restart, no inline drain, one --once publishes the post. */
async function crashAfterOriginThenRecover(mode, label) {
  await world(mode, async (s) => {
    await s.start();
    const before = new Set((await s.claimRecords()).map((x) => x.obligationId));
    const held = await s.holdAt('after-document', () => s.call('POST', '/api/cards/uuid-1/claim', { by: 'ada' }));
    let snap = null;
    try {
      assert.equal(held.reached, true, `${label}: REST reached the after-document barrier during the claim`);
      // THE DISCRIMINATOR: the claim has not returned, and the executor already holds THIS claim's durable origin
      assert.equal(held.returned(), false, `${label}: blocked a different write — the claim had already returned when the barrier held`);
      const fresh = (await s.claimRecords()).filter((x) => !before.has(x.obligationId));
      assert.equal(fresh.length, 1, `${label}: blocked a different write — the executor holds ${fresh.length} new claim record(s) at the barrier (${JSON.stringify(fresh)})`);
      snap = fresh[0];
      assert.equal(typeof snap.mutationId, 'string', `${label}: the durable record carries its mutationId`);
      assert.ok(Number.isSafeInteger(snap.postSeq), `${label}: the durable record carries a reserved integer postSeq (${JSON.stringify(snap.postSeq)})`);
    } finally {
      s.kill();
      await held.release();
      await Promise.race([held.inflight, sleep(5000)]);
    }
    await sleep(300);
    await s.start();   // a FRESH REST; the barrier dir is now empty, so nothing is armed for the recovery half
    const pend = await s.call('GET', `/api/outbox?status=pending`);
    assert.equal(pend.status, 200, `${label}: GET /api/outbox answers (${pend.text.slice(0, 200)})`);
    const mine = entriesOf(pend.json).filter((e) => e.slot === 'claim' && (e.mutationId === snap.mutationId || String(e.obligationId || '').startsWith(snap.mutationId)));
    assert.equal(mine.length, 1, `${label}: the fresh REST lists the same entry pending (${JSON.stringify(entriesOf(pend.json).map((e) => [e.obligationId, e.status]))})`);
    await sleep(8000);
    assert.equal((await s.claimPosts()).length, 0, `${label}: 8 s after a fresh boot the post does NOT exist — startup did not publish it inline`);
    const run = await s.publishOnce();
    assert.equal(run.code, 0, `${label}: --once completed (${run.code}) ${run.err.slice(0, 200)}`);
    assert.ok(await until(async () => (await s.claimPosts()).length >= 1, 20000), `${label}: the post is readable after --once`);
    await sleep(1500);
    const posts = await s.claimPosts();
    assert.equal(posts.length, 1, `${label}: exactly one post (${posts.length})`);
    assert.equal(posts[0].id, snap.postId, `${label}: it is the reserved post (${posts[0].id} vs ${snap.postId})`);
    assert.equal(posts[0].postSeq, snap.postSeq, `${label}: with the reserved postSeq (${posts[0].postSeq} vs ${snap.postSeq})`);
    const after = await s.call('GET', `/api/outbox?mutationId=${encodeURIComponent(snap.mutationId)}`);
    assert.ok(entriesOf(after.json).some((e) => e.slot === 'claim' && e.status === 'published'), `${label}: and the entry reads published (${after.text.slice(0, 300)})`);
    if (mode === 'off') assert.equal(run.boardOpens, 0, `${label}: the publisher process attempted no board file`);
    await documentUntouched(s, mode, label);
  });
}

test('#1629 L0 CONTROL (mode on, file present): killed at after-document with the claim\'s durable origin in the executor, a fresh REST leaves it pending, one --once publishes the reserved post; the recorder sees board opens', T, async () => {
  await crashAfterOriginThenRecover('on', 'L0');
});

test('#1629 L1 RESERVATION (mode off, file unreadable): two new posts take postSeq 3 then 4, no board-file attempt in any incarnation', TB, async () => {
  await world('off', async (s) => {
    await s.start();
    const a = await s.call('POST', '/api/conversations', { body: 'an L1 post', author: 'ada' });
    const b = await s.call('POST', '/api/conversations', { body: 'a second L1 post', author: 'ada' });
    assert.equal(a.status, 201, a.text.slice(0, 200)); assert.equal(b.status, 201, b.text.slice(0, 200));
    assert.equal(a.json?.postSeq, 3, `continues from the graph's 1 and 2 (#1710) (${a.json?.postSeq})`);
    assert.equal(b.json?.postSeq, 4, `and then 4 (${b.json?.postSeq})`);
    await documentUntouched(s, 'off', 'L1');
  });
});

test('#1629 L2 PUBLICATION (mode off, file unreadable): a claim\'s announcement post appears exactly once and GET /api/outbox?mutationId= reads it published', TB, async () => {
  await world('off', async (s) => {
    await s.start();
    const c = await s.call('POST', '/api/cards/uuid-1/claim', { by: 'ada' });
    assert.equal(c.status, 200, c.text.slice(0, 200));
    assert.ok(await until(async () => (await s.claimPosts()).length >= 1, 20000), 'the announcement post is readable');
    await sleep(1500);
    const posts = await s.claimPosts();
    assert.equal(posts.length, 1, `exactly one post (${posts.length})`);
    const all = await s.call('GET', '/api/outbox');
    const e = entriesOf(all.json).find((x) => x.slot === 'claim');
    assert.ok(e?.mutationId || e?.obligationId, `the outbox lists the claim's entry (${all.text.slice(0, 300)})`);
    const mid = e.mutationId ?? String(e.obligationId).split(':')[0];
    const one = await s.call('GET', `/api/outbox?mutationId=${encodeURIComponent(mid)}`);
    assert.ok(entriesOf(one.json).some((x) => x.slot === 'claim' && x.status === 'published'), `GET /api/outbox?mutationId= reads it published (${one.text.slice(0, 300)})`);
    await documentUntouched(s, 'off', 'L2');
  });
});

test('#1629 L3 RESTART RECOVERY (mode off, file unreadable): killed at after-document, a fresh REST does not drain it inline, one --once publishes the reserved post', TB, async () => {
  await crashAfterOriginThenRecover('off', 'L3');
});

test('#1629 L4a APPLIED, COMPLETION UNRECORDED, explicit route (mode off): killed at after-executor-apply during --once, a replay gives the same post, postSeq and exactly one post', TB, async () => {
  await world('off', async (s) => {
    await s.start();
    // make the claim's entry pending with the executor reachable: kill at after-document, as L3 does
    const before = new Set((await s.claimRecords()).map((x) => x.obligationId));
    const held = await s.holdAt('after-document', () => s.call('POST', '/api/cards/uuid-1/claim', { by: 'ada' }));
    let snap;
    try {
      assert.equal(held.reached, true, 'PRECONDITION: the claim reached after-document');
      assert.equal(held.returned(), false, 'blocked a different write: the claim had returned');
      const fresh = (await s.claimRecords()).filter((x) => !before.has(x.obligationId));
      assert.equal(fresh.length, 1, `blocked a different write: ${fresh.length} new claim record(s)`);
      snap = fresh[0];
    } finally { s.kill(); await held.release(); await Promise.race([held.inflight, sleep(5000)]); }
    await sleep(300);
    await s.start();
    const seqBefore = (await s.call('POST', '/api/conversations', { body: 'L4a sequence probe before', author: 'ada' })).json?.postSeq;
    // now hold --once's publish at after-executor-apply: APPLIED in the executor, nothing recorded
    const fifo = path.join(s.barrierDir, 'after-executor-apply');
    assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
    const runP = s.publishOnce();
    let fh = null;
    const reached = await Promise.race([fsp.open(fifo, 'w').then((h) => { fh = h; return true; }), sleep(20000).then(() => false)]);
    s.kill();
    try { await fh?.close(); } catch { /* ignore */ }
    if (!reached) { try { fs.closeSync(fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)); } catch { /* none */ } }
    fs.rmSync(fifo, { force: true });
    await runP;
    assert.equal(reached, true, 'REST reached after-executor-apply during --once (APPLIED, completion unrecorded)');
    await sleep(300);
    await s.start();
    const run = await s.publishOnce();
    assert.equal(run.code, 0, `the replaying --once completed (${run.code}) ${run.err.slice(0, 200)}`);
    assert.ok(await until(async () => (await s.claimPosts()).length >= 1, 20000), 'the post is readable');
    await sleep(1500);
    const posts = await s.claimPosts();
    assert.equal(posts.length, 1, `exactly one post after the crash and the replay (${posts.length})`);
    assert.equal(posts[0].id, snap.postId, 'the same reserved post id');
    assert.equal(posts[0].postSeq, snap.postSeq, 'the same reserved postSeq');
    const seqAfter = (await s.call('POST', '/api/conversations', { body: 'L4a sequence probe after', author: 'ada' })).json?.postSeq;
    assert.equal(seqAfter, seqBefore + 1, `no postSeq was consumed by the crash or the replay (${seqBefore} then ${seqAfter})`);
    await documentUntouched(s, 'off', 'L4a');
  });
});

test('#1629 L4b APPLIED, COMPLETION UNRECORDED, inline path (mode off): killed at after-dispatch-before-complete, --once gives one post with the same id and postSeq, and the entry reads published', TB, async () => {
  await world('off', async (s) => {
    await s.start();
    const held = await s.holdAt('after-dispatch-before-complete', () => s.call('POST', '/api/cards/uuid-1/claim', { by: 'ada' }));
    try { assert.equal(held.reached, true, 'REST reached after-dispatch-before-complete (inline publish APPLIED, completion unrecorded)'); }
    finally { s.kill(); await held.release(); await Promise.race([held.inflight, sleep(5000)]); }
    await sleep(300);
    await s.start();
    const pend = entriesOf((await s.call('GET', '/api/outbox')).json).filter((e) => e.slot === 'claim');
    assert.equal(pend.length, 1, `one claim entry after the restart (${pend.length})`);
    const run = await s.publishOnce();
    assert.equal(run.code, 0, `--once completed (${run.code}) ${run.err.slice(0, 200)}`);
    assert.ok(await until(async () => entriesOf((await s.call('GET', '/api/outbox')).json).some((e) => e.slot === 'claim' && e.status === 'published'), 20000), 'the entry reads published');
    await sleep(1500);
    const posts = await s.claimPosts();
    assert.equal(posts.length, 1, `exactly one post (${posts.length}): a repeated dispatch is not a second post`);
    assert.equal(posts[0].postSeq, pend[0].postSeq, 'with the reserved postSeq');
    await documentUntouched(s, 'off', 'L4b');
  });
});

test('#1629 L5 READ PURITY (mode off): three GET /api/outbox reads while an entry is pending change nothing, and the next post takes the expected number', TB, async () => {
  await world('off', async (s) => {
    await s.start();
    const before = new Set((await s.claimRecords()).map((x) => x.obligationId));
    const held = await s.holdAt('after-document', () => s.call('POST', '/api/cards/uuid-1/claim', { by: 'ada' }));
    try {
      assert.equal(held.reached, true, 'PRECONDITION: the claim reached after-document');
      assert.equal((await s.claimRecords()).filter((x) => !before.has(x.obligationId)).length, 1, 'blocked a different write');
    } finally { s.kill(); await held.release(); await Promise.race([held.inflight, sleep(5000)]); }
    await sleep(300);
    await s.start();
    const snapshot = async () => JSON.stringify(entriesOf((await s.call('GET', '/api/outbox?status=pending')).json).map((e) => [e.obligationId, e.status, e.postSeq]).sort());
    const p0 = await snapshot(); const posts0 = (await s.claimPosts()).length;
    for (let i = 0; i < 3; i++) assert.equal((await s.call('GET', '/api/outbox')).status, 200);
    assert.equal(await snapshot(), p0, 'the pending set is unchanged by three reads');
    assert.equal((await s.claimPosts()).length, posts0, 'no post appeared');
    const reserved = entriesOf((await s.call('GET', '/api/outbox?status=pending')).json).find((e) => e.slot === 'claim')?.postSeq;
    const next = await s.call('POST', '/api/conversations', { body: 'an L5 post', author: 'ada' });
    assert.equal(next.json?.postSeq, reserved + 1, `the next post takes the number after the reserved one (${next.json?.postSeq} vs reserved ${reserved})`);
    await documentUntouched(s, 'off', 'L5');
  });
});
