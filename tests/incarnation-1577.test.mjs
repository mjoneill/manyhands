/**
 * #1577 — executor cursors carry the store's INCARNATION, and an unpromoted copy cannot serve.
 *
 * #1575 made every executor cursor name its epoch. But `--promote-epoch` sets epoch =
 * restored epoch + 1, so two DIFFERENT restores of backups from the same epoch both become
 * epoch 2 with different histories, and a cursor from one was answered by the other (a
 * silent skip of reused commitSeqs). So:
 *
 *   INCARNATION   the marker holds `ex:incarnation`, a random UUID minted at --create and
 *                 RE-minted at every --promote-epoch (same update as the epoch bump), with
 *                 `ex:incarnationFrom` = the incarnation promoted from. An ordinary restart
 *                 PRESERVES it. Every executor cursor carries the full UUID (32 hex) (chg3 /
 *                 chgb3 tokens; lanes store `graph_incarnation`). Another incarnation — even
 *                 at the same epoch — is refused visibly (CURSOR_EPOCH_CHANGED), old cursor
 *                 preserved; the exact baseline min(cursor, epochBase) only for a cursor of
 *                 the incarnation this store was promoted FROM, else replay-all from 0.
 *   LEGACY        a cursor with no incarnation (chg1 / chg2 / a lane without
 *                 graph_incarnation) is accepted only by a store that was never promoted
 *                 (epoch 1, no epochBase); otherwise refused, baseline replay-all.
 *   HOME          the marker holds `ex:storeHome` (realpath, recorded at --create and at
 *                 --promote-epoch). An ordinary start somewhere else — a COPY, which carries
 *                 the original's incarnation and so is indistinguishable to cursors — is
 *                 REFUSED before any write. A real move of the live store: --adopt-home
 *                 (refused while a store still exists at the recorded home).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { startRestServer, freePort, PROJECT_DIR } from './helpers/harness.mjs';
import { mintToken, hashToken } from '../core/credentials.mjs';
import { loadCursors } from '../core/cursors.mjs';
import { queryChangesFromLog, epochResyncBaseline, incarnationTag } from '../core/changes-log-query.mjs';
import { registerFor, serveFor } from '../core/cursor-service.mjs';

const PY = process.env.GRAPH_EXECUTOR_PYTHON || path.join(PROJECT_DIR, 'graph-executor', '.venv', 'bin', 'python');
const EXEC = path.join(PROJECT_DIR, 'graph-executor', 'executor.py');
const HAVE_PY = fs.existsSync(PY) && spawnSync(PY, ['-c', 'import pyoxigraph'], { stdio: 'ignore' }).status === 0;
const SKIP = HAVE_PY ? false : `UNAVAILABLE: no python with pyoxigraph at ${PY}`;

const TOK = { bob: mintToken() };
const tmpdir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `inc1577-${p}-`));
function tokensFile() {
  const f = path.join(tmpdir('tok'), 'seat-tokens.json');
  const at = (h) => new Date(Date.now() + h * 3600_000).toISOString();
  fs.writeFileSync(f, JSON.stringify({ seats: { bob: { credentials: [{ tokenHash: hashToken(TOK.bob), scope: 'admin', issuedAt: at(-1), expiresAt: at(24), issuedBy: 'test', revokedAt: null, note: null }] } } }));
  return f;
}
/** A store made the way pre-#1577 stores were: a marker with no incarnation and no home. */
function initLegacyStore(dsid) {
  const store = tmpdir('store');
  const init = spawnSync(PY, ['-c', `import pyoxigraph as px\ns = px.Store(${JSON.stringify(store)})\ns.update('INSERT DATA { <urn:ex:dataset> <urn:ex:datasetId> "${dsid}" ; <urn:ex:epoch> 1 ; <urn:ex:commitSeq> 0 }')\ns.flush()`]);
  assert.equal(init.status, 0, String(init.stderr));
  return store;
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function released(store) {
  for (let i = 0; i < 200; i++) {
    if (spawnSync('pgrep', ['-f', '--', `--store ${store}`]).status === 1) return;
    await pause(50);
  }
  throw new Error(`executor on ${store} never exited`);
}
const LIVE = new Set();
after(async () => { for (const s of LIVE) await s.stop(); });
async function boot({ dsid, store, eventDir, tokens }) {
  const executorUrl = `http://127.0.0.1:${await freePort()}`;
  const srv = await startRestServer({ env: {
    SCRUM_GRAPH_EXECUTOR_URL: executorUrl, SCRUM_GRAPH_DATASET_ID: dsid, SCRUM_EVENT_LOG_DIR: eventDir,
    SCRUM_TRIAL_EXECUTOR_STORE: store, GRAPH_EXECUTOR_PYTHON: PY, SCRUM_SEAT_TOKENS: tokens,
    SCRUM_AUTH: 'required', SCRUM_GRAPH_UNIT_LOGBORN: '1',
  } });
  for (let i = 0; i < 200; i++) {
    const c = await (await fetch(`${srv.baseUrl}/api/trial/counters`, { headers: { authorization: `Bearer ${TOK.bob}` } })).json();
    if (c.executor) { LIVE.add(srv); return Object.assign(srv, { executorUrl, store, eventDir }); }
    await pause(50);
  }
  throw new Error(`executor never came up: ${srv.stderr().slice(-800)}`);
}
async function down(srv) { LIVE.delete(srv); await srv.stop(); await released(srv.store); }

/** One executor start; resolves with its ready line (and kills it), or rejects with its stderr. */
function startOnce(store, dsid, extra = []) {
  return new Promise((resolve, reject) => {
    const p = spawn(PY, [EXEC, '--store', store, '--port', '0', '--dataset-id', dsid, ...extra], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; if (out.includes('\n')) p.kill('SIGKILL'); });
    p.stderr.on('data', (d) => { err += d; });
    p.on('exit', () => (out.includes('\n') ? resolve(JSON.parse(out.split('\n')[0])) : reject(new Error(err.trim().split('\n').pop()))));
  }).then(async (ready) => { await released(store); return ready; });
}
const promote = (store, dsid) => startOnce(store, dsid, ['--promote-epoch']);

const H = { 'content-type': 'application/json', authorization: `Bearer ${TOK.bob}` };
const call = async (srv, method, p, body) => {
  const r = await fetch(`${srv.baseUrl}${p}`, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
};
const memory = async (srv, title) => {
  const r = await call(srv, 'POST', '/api/memories', { owner: 'bob', title, body: 'x' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return `https://scrumboard.local/memory/${r.body.id}`;
};
// #1576 — the ack is EXPLICIT: `ack()` acks the lane's last pull with its `ack_token`; with no
// token held (the last pull was refused, or none since) it is an inbound call — which acks nothing.
const ackTokens = new Map();
const pull = async (srv, identity) => {
  const r = await call(srv, 'GET', `/api/cursors/pull?${new URLSearchParams({ identity, via: 'v1' })}`);
  ackTokens.set(`${srv.baseUrl}|${identity}`, r.body?.ack_token ?? null);
  await pause(30);
  return r;
};
const ack = async (srv, identity) => {
  const k = `${srv.baseUrl}|${identity}`;
  const token = ackTokens.get(k);
  ackTokens.delete(k);
  if (!token) return call(srv, 'POST', '/api/cursors/inbound', { identity, via: 'v1' });
  const r = await call(srv, 'POST', '/api/cursors/ack', { identity, token });
  assert.equal(r.status, 200, `ack: ${JSON.stringify(r.body)}`);
  return r;
};
const changes = (srv, since) => call(srv, 'GET', `/api/changes?since=${encodeURIComponent(since)}&history=true&limit=500`);
const memIds = (rows) => rows.filter((r) => r.graph).map((r) => (r.entity ? r.entity.id : r.id));
const health = async (srv) => (await fetch(`${srv.executorUrl}/health`)).json();
async function drain(srv, lane) {
  const served = [];
  for (let i = 0; i < 5; i++) {
    const r = await pull(srv, lane);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    served.push(...memIds(r.body.events));
    await ack(srv, lane);
  }
  return served;
}

// ── 1. THE COLLISION ────────────────────────────────────────────────────────────────────
test('#1577 two restores of one backup, both promoted to epoch 2: a cursor and a lane advanced on X are REFUSED by Y (same epoch, other incarnation); after resync Y serves its own rows exactly once', { skip: SKIP }, async () => {
  const dsid = 'inc1577-a';
  const tokens = tokensFile();
  const live = initLegacyStore(dsid);
  const eventDir = tmpdir('events');
  const LANE = 'registry:lane1577.t';

  let srv = await boot({ dsid, store: live, eventDir, tokens });
  const liveInc = (await health(srv)).incarnation;
  assert.match(String(liveInc), /^[0-9a-f-]{36}$/, 'a legacy store mints its incarnation at first start');
  assert.equal((await call(srv, 'POST', '/api/cursors/register', { registrySeatId: 'lane1577.t' })).status, 200);
  const since = new Date().toISOString();
  const kept = [await memory(srv, 'kept-1'), await memory(srv, 'kept-2')];
  assert.deepEqual(await drain(srv, LANE), kept);
  const c0 = (await changes(srv, since)).body;
  assert.deepEqual(memIds(c0.changes), kept);
  await down(srv);

  const backup = tmpdir('backup');
  fs.cpSync(live, backup, { recursive: true });
  const X = tmpdir('restoreX'); fs.cpSync(backup, X, { recursive: true });
  const Y = tmpdir('restoreY'); fs.cpSync(backup, Y, { recursive: true });
  await promote(X, dsid);
  await promote(Y, dsid);

  // ── on X: resync from the original (exact baseline: X was promoted FROM it), then advance ──
  srv = await boot({ dsid, store: X, eventDir, tokens });
  const hx = await health(srv);
  assert.equal(String(hx.epoch), '2');
  assert.equal(hx.incarnationFrom, liveInc, 'X records the incarnation it was promoted from');
  let r = await pull(srv, LANE);
  assert.equal(r.body.code, 'CURSOR_EPOCH_CHANGED', JSON.stringify(r.body));
  assert.equal(r.body.baseline.baseline, 'promotion', 'the original\'s lane resyncs to X exactly');
  assert.equal((await call(srv, 'POST', '/api/cursors/register', { registrySeatId: 'lane1577.t', resync: 'epoch' })).status, 200);
  const cr0 = await changes(srv, c0.cursor);
  assert.equal(cr0.body.code, 'CURSOR_EPOCH_CHANGED');
  const xs = [await memory(srv, 'x-1'), await memory(srv, 'x-2'), await memory(srv, 'x-3')];
  assert.deepEqual(await drain(srv, LANE), xs);
  const cx = (await changes(srv, cr0.body.resync_cursor)).body;
  assert.deepEqual(memIds(cx.changes), xs);
  const xCursor = cx.cursor;
  const laneOnX = loadCursors(eventDir).seats[LANE];
  await down(srv);

  // ── X is abandoned; Y (same backup, same epoch 2, other history) is brought up ──
  srv = await boot({ dsid, store: Y, eventDir, tokens });
  try {
    const hy = await health(srv);
    assert.equal(String(hy.epoch), '2', 'the collision: X and Y are both epoch 2');
    assert.notEqual(hy.incarnation, hx.incarnation, 'but two incarnations');
    const ys = [await memory(srv, 'y-1'), await memory(srv, 'y-2')];   // reuse X's commitSeqs

    r = await pull(srv, LANE);
    assert.notEqual(r.status, 200, `a lane advanced on X must not be answered by Y — served: ${JSON.stringify(memIds(r.body.events ?? []))} (owed ${JSON.stringify(ys)})`);
    assert.equal(r.body.code, 'CURSOR_EPOCH_CHANGED', JSON.stringify(r.body));
    assert.equal(r.body.resync, true);
    assert.equal(r.body.epoch, 2);
    assert.equal(r.body.cursor_epoch, 2, 'same epoch: the incarnation is what differs');
    assert.equal(r.body.incarnation, incarnationTag(hy.incarnation));
    assert.equal(r.body.cursor_incarnation, incarnationTag(hx.incarnation));
    assert.deepEqual(r.body.baseline, { commit_seq: 0, baseline: 'replay-all' }, 'a sibling restore is not the store Y was promoted from: no exact baseline');
    await ack(srv, LANE);
    assert.deepEqual(loadCursors(eventDir).seats[LANE].graph_acked, laneOnX.graph_acked, 'the old cursor is PRESERVED');

    const cr = await changes(srv, xCursor);
    assert.notEqual(cr.status, 200, `a forward cursor from X must not be answered by Y — served: ${JSON.stringify(memIds(cr.body.changes ?? []))}`);
    assert.equal(cr.body.code, 'CURSOR_EPOCH_CHANGED', JSON.stringify(cr.body));
    assert.equal(cr.body.baseline.baseline, 'replay-all');

    const plain = await call(srv, 'POST', '/api/cursors/register', { registrySeatId: 'lane1577.t' });
    assert.equal(plain.body.epoch_mismatch?.code, 'CURSOR_EPOCH_CHANGED', JSON.stringify(plain.body));

    // ── resync: every row of Y exactly once; nothing of X ──
    const rs = await call(srv, 'POST', '/api/cursors/register', { registrySeatId: 'lane1577.t', resync: 'epoch' });
    assert.equal(rs.status, 200, JSON.stringify(rs.body));
    assert.equal(rs.body.resynced.baseline, 'replay-all');
    assert.deepEqual(await drain(srv, LANE), [...kept, ...ys], 'every row of Y once (kept again: replay-all; dedup by opId), never X\'s');
    const rc = await changes(srv, cr.body.resync_cursor);
    assert.equal(rc.status, 200, JSON.stringify(rc.body));
    assert.deepEqual(memIds(rc.body.changes), [...kept, ...ys]);
    assert.deepEqual(memIds((await changes(srv, rc.body.cursor)).body.changes), [], 'and nothing twice');
  } finally { await down(srv); }
});

// ── 2. LIFECYCLE: restart preserves; only --create / --promote-epoch mint ─────────────
test('#1577 lifecycle: --create mints the incarnation, a restart PRESERVES it, each promotion RE-MINTS it (incarnationFrom = the one before); a legacy store mints once and keeps it', { skip: SKIP }, async () => {
  const store = tmpdir('life');
  const c = await startOnce(store, 'life', ['--create']);
  assert.match(String(c.incarnation), /^[0-9a-f-]{36}$/);
  assert.equal(c.incarnationFrom ?? null, null);
  assert.equal(c.storeHome, fs.realpathSync(store));
  const r1 = await startOnce(store, 'life');
  const r2 = await startOnce(store, 'life');
  assert.deepEqual([r1.incarnation, r2.incarnation], [c.incarnation, c.incarnation], 'an ordinary restart keeps the incarnation');
  const p1 = await startOnce(store, 'life', ['--promote-epoch']);
  assert.notEqual(p1.incarnation, c.incarnation);
  assert.equal(p1.incarnationFrom, c.incarnation);
  const r3 = await startOnce(store, 'life');
  assert.equal(r3.incarnation, p1.incarnation, 'and keeps the promoted one');
  const p2 = await startOnce(store, 'life', ['--promote-epoch']);
  assert.notEqual(p2.incarnation, p1.incarnation);
  assert.equal(p2.incarnationFrom, p1.incarnation, 'incarnationFrom is overwritten (one marker row)');

  const legacy = initLegacyStore('leg');
  const l1 = await startOnce(legacy, 'leg');
  assert.match(String(l1.incarnation), /^[0-9a-f-]{36}$/, 'minted at first start');
  assert.equal(l1.storeHome, fs.realpathSync(legacy), 'home recorded at first start');
  const l2 = await startOnce(legacy, 'leg');
  assert.equal(l2.incarnation, l1.incarnation, 'and persisted');
});

// ── 3. HOME: an unpromoted copy cannot serve ───────────────────────────────────────────
test('#1577 an UNPROMOTED copy is refused at start; the same copy promoted serves; the original at its home serves; a real move needs --adopt-home, refused while the original exists', { skip: SKIP }, async () => {
  const A = tmpdir('home');
  const a = await startOnce(A, 'home', ['--create']);
  const B = tmpdir('copy'); fs.cpSync(A, B, { recursive: true });
  await assert.rejects(startOnce(B, 'home'), /copied from .*promote it \(--promote-epoch\)/);
  await assert.rejects(startOnce(B, 'home', ['--adopt-home']), /still exists/, 'a copy cannot adopt a home while its original exists');
  const bp = await promote(B, 'home');
  assert.equal(bp.storeHome, fs.realpathSync(B));
  assert.equal((await startOnce(B, 'home')).incarnation, bp.incarnation, 'the promoted copy now serves from its own home');
  assert.equal((await startOnce(A, 'home')).incarnation, a.incarnation, 'the original still serves at its home');

  // a MOVE of the live store (the original is gone from its home)
  const moved = path.join(tmpdir('moved'), 'store');
  fs.renameSync(A, moved);
  await assert.rejects(startOnce(moved, 'home'), /copied from/);
  const adopt = await startOnce(moved, 'home', ['--adopt-home']);
  assert.equal(adopt.storeHome, fs.realpathSync(moved));
  assert.equal(adopt.incarnation, a.incarnation, 'a move keeps the identity');
  assert.equal(String(adopt.epoch), '1');
  assert.equal((await startOnce(moved, 'home')).incarnation, a.incarnation);

  // a restore copied INTO the home path (the live store moved aside, the backup copied to the
  // same path): right path, another directory — refused; promotion serves it
  const backup = tmpdir('inplace-backup'); fs.cpSync(moved, backup, { recursive: true });
  fs.renameSync(moved, `${moved}.aside`);
  fs.cpSync(backup, moved, { recursive: true });
  await assert.rejects(startOnce(moved, 'home'), /copied from .* into the same path/);
  const ip = await promote(moved, 'home');
  assert.notEqual(ip.incarnation, a.incarnation, 'the in-place restore is a new incarnation');
  assert.equal((await startOnce(moved, 'home')).incarnation, ip.incarnation);
});

// ── 4. PURE: the legacy rule and the identity compare ──────────────────────────────────
const row = (cs) => ({ kind: 'memory', op: 'create', seq: null, id: `m${cs}`, shortId: null, title: null, column: null, by: 'bob',
  at: `2026-10-04T12:00:${String(cs).padStart(2, '0')}.000Z`, graph: { opId: `urn:ex:op/logborn/memory/${cs}`, commitSeq: cs, version: 1 } });
const INC_A = 'a'.repeat(32), INC_B = 'b'.repeat(32);
const base = { since: '2026-10-04T00:00:00.000Z', history: true, graphRows: [row(1), row(2), row(3)], graphThrough: 3, logThrough: 0 };

test('#1577 PURE legacy rule: a cursor with no incarnation is answered only by a never-promoted store (epoch 1, no epochBase)', () => {
  const unpromoted = { ...base, graphEpoch: 1, graphEpochBase: null, graphIncarnation: INC_A };
  assert.equal(queryChangesFromLog([], { ...unpromoted, since: 'chg1.0.1' }).changes.length, 2, 'chg1 at an unpromoted store');
  assert.equal(queryChangesFromLog([], { ...unpromoted, since: 'chg2.0.1.1' }).changes.length, 2, 'chg2 epoch 1 at an unpromoted store');
  const promoted = { ...base, graphEpoch: 2, graphEpochBase: 1, graphIncarnation: INC_B, graphIncarnationFrom: INC_A };
  assert.throws(() => queryChangesFromLog([], { ...promoted, since: 'chg2.0.2.1' }),
    (e) => e.code === 'CURSOR_EPOCH_CHANGED' && e.baseline.baseline === 'replay-all' && e.cursor_incarnation === null,
    'a chg2 token naming the CURRENT epoch, on a promoted store: refused (it may be from a sibling restore)');
  assert.throws(() => queryChangesFromLog([], { ...promoted, since: 'chg1.0.1' }), (e) => e.code === 'CURSOR_EPOCH_CHANGED' && e.baseline.baseline === 'replay-all');
  assert.throws(() => queryChangesFromLog([], { ...promoted, before: 'chgb2.1.1.2.3' }), (e) => e.code === 'CURSOR_EPOCH_CHANGED');
  // with an incarnation
  assert.equal(queryChangesFromLog([], { ...promoted, since: `chg3.0.${INC_B}.2.1` }).changes.length, 2, 'same incarnation: answered');
  assert.throws(() => queryChangesFromLog([], { ...promoted, since: `chg3.0.${'c'.repeat(32)}.2.1` }), (e) => e.code === 'CURSOR_EPOCH_CHANGED' && e.cursor_epoch === 2);
  const exact = (() => { try { queryChangesFromLog([], { ...promoted, since: `chg3.0.${INC_A}.1.3` }); } catch (e) { return e; } })();
  assert.deepEqual(exact.baseline, { commit_seq: 1, baseline: 'promotion' }, 'promoted FROM that incarnation: exact');
  assert.equal(exact.resync_cursor, `chg3.0.${INC_B}.2.1`);
  const page = queryChangesFromLog([], { ...promoted, since: `chg3.0.${INC_B}.2.0`, limit: { cards: 1, posts: 1 } });
  assert.match(page.cursor, new RegExp(`^chg3\\.0\\.${INC_B}\\.2\\.3$`));
  assert.match(page.nextBefore, new RegExp(`^chgb3\\.\\d+\\.\\d+\\.${INC_B}\\.2\\.\\d+$`));
});

test('#1577 PURE baseline: exact only from the incarnation promoted FROM, never from a sibling at the same epoch', () => {
  assert.deepEqual(epochResyncBaseline({ cursorEpoch: 1, cursorIncarnation: INC_A, cursorCommitSeq: 9, epoch: 2, epochBase: 5, incarnation: INC_B, incarnationFrom: INC_A }), { commit_seq: 5, baseline: 'promotion' });
  assert.deepEqual(epochResyncBaseline({ cursorEpoch: 1, cursorIncarnation: 'c'.repeat(32), cursorCommitSeq: 9, epoch: 2, epochBase: 5, incarnation: INC_B, incarnationFrom: INC_A }), { commit_seq: 0, baseline: 'replay-all' });
  assert.deepEqual(epochResyncBaseline({ cursorEpoch: 1, cursorIncarnation: null, cursorCommitSeq: 9, epoch: 2, epochBase: 5, incarnation: INC_B, incarnationFrom: INC_A }), { commit_seq: 0, baseline: 'replay-all' }, 'a legacy cursor cannot prove its lineage');
  assert.deepEqual(epochResyncBaseline({ cursorEpoch: 2, cursorIncarnation: 'c'.repeat(32), cursorCommitSeq: 9, epoch: 2, epochBase: 5, incarnation: INC_B, incarnationFrom: INC_A }), { commit_seq: 0, baseline: 'replay-all' });
  // a reviewer 15:59Z: the FULL uuid (122 random bits), never a prefix
  assert.equal(incarnationTag('0123abcd-ef01-4567-89ab-cdef01234567'), '0123abcdef014567' + '89abcdef01234567');
});

test('#1577 PURE lanes: a lane with no graph_incarnation is served by a never-promoted store, refused by a promoted one; another incarnation at the same epoch is refused', () => {
  const dir = tmpdir('lanes');
  fs.mkdirSync(dir, { recursive: true });
  const graph = (o) => ({ rows: [], through: 3, ...o });
  registerFor(dir, 'registry:a', { graphHead: 0 });   // legacy-shaped lane: no epoch, no incarnation
  assert.equal(serveFor(dir, 'registry:a', { graph: graph({ epoch: 1, epochBase: null, incarnation: INC_A }) }).refused, undefined);
  const p = serveFor(dir, 'registry:a', { graph: graph({ epoch: 2, epochBase: 3, incarnation: INC_B, incarnationFrom: INC_A }) });
  assert.equal(p.refused, 'CURSOR_EPOCH_CHANGED');
  assert.equal(p.epochError.baseline.baseline, 'replay-all');
  registerFor(dir, 'registry:b', { graphHead: 0, graphEpoch: 2, graphIncarnation: INC_B });
  assert.equal(loadCursors(dir).seats['registry:b'].graph_incarnation, INC_B);
  assert.equal(serveFor(dir, 'registry:b', { graph: graph({ epoch: 2, incarnation: INC_B }) }).refused, undefined);
  assert.equal(serveFor(dir, 'registry:b', { graph: graph({ epoch: 2, incarnation: 'c'.repeat(32) }) }).refused, 'CURSOR_EPOCH_CHANGED');
});

// A token-SHAPED `since`/`before` that does not parse (a truncated incarnation, a typo, an unknown
// version) must be REFUSED, never read as an ISO time window: that fall-through would answer silently.
test('#1577 PURE: a malformed cursor token is refused (UNKNOWN_CURSOR, the existing 400), never treated as a date; a real ISO since and well-formed tokens still answer (twin)', () => {
  const store = { history: true, graphRows: [], graphThrough: 0, logThrough: 0, graphEpoch: 2, graphIncarnation: INC_B, graphEpochBase: 1 };
  for (const bad of ['chg3.0.cccccccccccc.2.1', 'chg9.1.2', 'chg3.0.' + INC_B + '.2', 'chgb3.0.0.cccccccccccc.2.1']) {
    const key = bad.startsWith('chgb') ? 'before' : 'since';
    assert.throws(() => queryChangesFromLog([], { ...store, since: '2026-10-04T00:00:00Z', [key]: bad }), (e) => e.code === 'UNKNOWN_CURSOR', `${bad} is refused`);
  }
  assert.equal(queryChangesFromLog([], { ...store, since: '2026-10-04T00:00:00Z' }).changes.length, 0, 'twin: an ISO since answers');
  assert.equal(queryChangesFromLog([], { ...store, since: `chg3.0.${INC_B}.2.0` }).changes.length, 0, 'twin: a well-formed token answers');
});
