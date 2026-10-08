/**
 * #1575 — executor cursors carry the executor EPOCH.
 *
 * A restore promotion (#1559, executor.py --promote-epoch) bumps the epoch but leaves
 * commitSeq where the RESTORE had it. New writes then reuse commitSeqs the lost store
 * had already handed out, so a cursor holding only a commitSeq resumes PAST them and
 * silently skips them. Every executor cursor — the /api/changes tokens and a
 * replay_pull lane's stored executor cursor — now carries the epoch it was read in:
 *
 *   SAME epoch       unchanged behaviour (twin)
 *   OTHER epoch      REFUSED visibly (CURSOR_EPOCH_CHANGED, resync: true, the current
 *                    epoch, the baseline the resync will use); the old cursor is
 *                    PRESERVED, never overwritten, never reset to head, never to 0
 *   RESYNC           baseline = min(the cursor's commitSeq, the restored store's own
 *                    commitSeq at promotion — `ex:epochBase`) when the cursor is from
 *                    the epoch the store was promoted FROM; else 0 (full replay of the
 *                    new store, dedup by graph.opId). Every row written on the new epoch
 *                    — including rows written BEFORE the resync — is served exactly once.
 *   LEGACY           a token / lane with no epoch is epoch 1 (the only epoch that existed
 *                    before promotion support).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { startRestServer, freePort, PROJECT_DIR } from './helpers/harness.mjs';
import { mintToken, hashToken } from '../core/credentials.mjs';
import { loadCursors, saveCursors } from '../core/cursors.mjs';
import { epochResyncBaseline, queryChangesFromLog } from '../core/changes-log-query.mjs';

const PY = process.env.GRAPH_EXECUTOR_PYTHON || path.join(PROJECT_DIR, 'graph-executor', '.venv', 'bin', 'python');
const EXEC = path.join(PROJECT_DIR, 'graph-executor', 'executor.py');
const HAVE_PY = fs.existsSync(PY) && spawnSync(PY, ['-c', 'import pyoxigraph'], { stdio: 'ignore' }).status === 0;
const SKIP = HAVE_PY ? false : `UNAVAILABLE: no python with pyoxigraph at ${PY}`;

const TOK = { bob: mintToken() };
const tmpdir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `ep1575-${p}-`));
function tokensFile() {
  const f = path.join(tmpdir('tok'), 'seat-tokens.json');
  const at = (h) => new Date(Date.now() + h * 3600_000).toISOString();
  fs.writeFileSync(f, JSON.stringify({ seats: { bob: { credentials: [{ tokenHash: hashToken(TOK.bob), scope: 'admin', issuedAt: at(-1), expiresAt: at(24), issuedBy: 'test', revokedAt: null, note: null }] } } }));
  return f;
}
function initStore(dsid) {
  const store = tmpdir('store');
  const init = spawnSync(PY, ['-c', `import pyoxigraph as px\ns = px.Store(${JSON.stringify(store)})\ns.update('INSERT DATA { GRAPH <urn:scrum:bookkeeping:executor> { <urn:ex:dataset> <urn:ex:datasetId> "${dsid}" ; <urn:ex:epoch> 1 ; <urn:ex:commitSeq> 0 } }')\ns.flush()`]);
  assert.equal(init.status, 0, String(init.stderr));
  return store;
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
/** No process holds the store (the executor exits on its server's death; wait for it). */
async function released(store) {
  for (let i = 0; i < 200; i++) {
    if (spawnSync('pgrep', ['-f', '--', `--store ${store}`]).status === 1) return;
    await pause(50);
  }
  throw new Error(`executor on ${store} never exited`);
}
const LIVE = new Set();   // every server still up — stopped in after(), so a failed assertion never leaves one running
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
  throw new Error('executor never came up');
}
async function down(srv) { LIVE.delete(srv); await srv.stop(); await released(srv.store); }
/** The restore is PROMOTED the way an operator does it (#1559): one executor start with --promote-epoch. */
function promote(store, dsid) {
  return new Promise((resolve, reject) => {
    const p = spawn(PY, [EXEC, '--store', store, '--port', '0', '--dataset-id', dsid, '--promote-epoch'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; if (out.includes('\n')) { p.kill('SIGKILL'); } });
    p.stderr.on('data', (d) => { err += d; });
    p.on('exit', () => (out.includes('\n') ? resolve() : reject(new Error(err))));
  }).then(() => released(store));
}

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

test('#1575 a restore promotion: the forward cursor and a replay lane REFUSE (old cursor preserved); after the stated resync every new-epoch row is served exactly once', { skip: SKIP }, async () => {
  const dsid = 'ep1575-a';
  const tokens = tokensFile();
  const live = initStore(dsid);
  const eventDir = tmpdir('events');
  const LANE = 'registry:lane1575.t';

  // ── epoch 1, before the backup ──
  let srv = await boot({ dsid, store: live, eventDir, tokens });
  assert.equal((await call(srv, 'POST', '/api/cursors/register', { registrySeatId: 'lane1575.t' })).status, 200);
  const since = new Date().toISOString();
  const kept = [await memory(srv, 'kept-1'), await memory(srv, 'kept-2')];
  let r = await pull(srv, LANE);
  assert.equal(r.status, 200, JSON.stringify(r.body) + srv.stderr().slice(-1500));
  assert.deepEqual(memIds(r.body.events), kept);
  await ack(srv, LANE);
  let c = await changes(srv, since);
  assert.deepEqual(memIds(c.body.changes), kept);
  await down(srv);
  const restore = tmpdir('restore');
  fs.cpSync(live, restore, { recursive: true });   // the backup: after kept-*, before lost-*

  // ── epoch 1, after the backup: these are LOST with the live store ──
  srv = await boot({ dsid, store: live, eventDir, tokens });
  const lost = [await memory(srv, 'lost-1'), await memory(srv, 'lost-2'), await memory(srv, 'lost-3')];
  r = await pull(srv, LANE);
  assert.deepEqual(memIds(r.body.events), lost, 'the lane reaches past the lost writes');
  const lostTop = Math.max(...r.body.events.filter((e) => e.graph).map((e) => e.graph.commitSeq));
  await ack(srv, LANE);
  const c1 = (await changes(srv, c.body.cursor)).body;
  assert.deepEqual(memIds(c1.changes), lost, 'the forward cursor reaches past the lost writes');
  const oldCursor = c1.cursor;
  await down(srv);

  // ── the live store is lost; the restore is promoted to epoch 2 ──
  await promote(restore, dsid);
  srv = await boot({ dsid, store: restore, eventDir, tokens });
  try {
    // NEW writes on epoch 2, BEFORE anyone resyncs: their commitSeqs collide with the lost ones
    const fresh = [await memory(srv, 'new-1'), await memory(srv, 'new-2')];
    const laneBefore = loadCursors(eventDir).seats[LANE];

    r = await pull(srv, LANE);
    assert.notEqual(r.status, 200, `the lane must not be answered from a cursor of another epoch — served: ${JSON.stringify(memIds(r.body.events ?? []))} (expected ${JSON.stringify(fresh)} to be owed)`);
    assert.equal(r.body.code, 'CURSOR_EPOCH_CHANGED', JSON.stringify(r.body));
    assert.equal(r.body.resync, true);
    assert.equal(r.body.epoch, 2);
    assert.equal(r.body.cursor_epoch, 1);
    assert.equal(r.body.baseline.commit_seq, 2, 'baseline = the restored store\'s own commitSeq at promotion');
    await ack(srv, LANE);   // an ack after a refusal moves nothing
    assert.deepEqual(loadCursors(eventDir).seats[LANE].graph_acked, laneBefore.graph_acked, 'the old cursor is PRESERVED');
    assert.equal(loadCursors(eventDir).seats[LANE].graph_acked, lostTop);

    const cr = await changes(srv, oldCursor);
    assert.notEqual(cr.status, 200, `the forward cursor must not be answered across epochs — served: ${JSON.stringify(memIds(cr.body.changes ?? []))}`);
    assert.equal(cr.body.code, 'CURSOR_EPOCH_CHANGED', JSON.stringify(cr.body));
    assert.equal(cr.body.resync, true);
    assert.equal(cr.body.epoch, 2);

    // a plain re-register does NOT overwrite the old cursor: it reports the mismatch
    const plain = await call(srv, 'POST', '/api/cursors/register', { registrySeatId: 'lane1575.t' });
    assert.equal(plain.body.epoch_mismatch?.code, 'CURSOR_EPOCH_CHANGED', JSON.stringify(plain.body));
    assert.equal(loadCursors(eventDir).seats[LANE].graph_acked, lostTop);

    // ── RESYNC (lane): an explicit re-register with resync: 'epoch' ──
    const rs = await call(srv, 'POST', '/api/cursors/register', { registrySeatId: 'lane1575.t', resync: 'epoch' });
    assert.equal(rs.status, 200, JSON.stringify(rs.body));
    assert.deepEqual(rs.body.resynced, { from_epoch: 1, from_commit_seq: lostTop, to_epoch: 2, baseline_commit_seq: 2, baseline: 'promotion' });
    const served = [];
    for (let i = 0; i < 5; i++) {
      r = await pull(srv, LANE);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      served.push(...memIds(r.body.events));
      await ack(srv, LANE);
    }
    assert.deepEqual(served, fresh, 'every new-epoch row, including those written before the resync, exactly once; nothing restored is replayed');

    // ── RESYNC (changes): the refusal's resync_cursor ──
    const rc = await changes(srv, cr.body.resync_cursor);
    assert.equal(rc.status, 200, JSON.stringify(rc.body));
    assert.deepEqual(memIds(rc.body.changes), fresh);
    const quiet = await changes(srv, rc.body.cursor);
    assert.deepEqual(memIds(quiet.body.changes), [], 'and nothing twice');
    const after = await memory(srv, 'new-3');
    assert.deepEqual(memIds((await changes(srv, rc.body.cursor)).body.changes), [after]);
  } finally { await down(srv); }
});

test('#1575 twin: same epoch across a restart (no promotion) — the cursor, the lane, a legacy token and a legacy lane are answered as before', { skip: SKIP }, async () => {
  const dsid = 'ep1575-b';
  const tokens = tokensFile();
  const store = initStore(dsid);
  const eventDir = tmpdir('events');
  const LANE = 'registry:twin1575.t';
  let srv = await boot({ dsid, store, eventDir, tokens });
  assert.equal((await call(srv, 'POST', '/api/cursors/register', { registrySeatId: 'twin1575.t' })).status, 200);
  const since = new Date().toISOString();
  const a = await memory(srv, 'a');
  assert.deepEqual(memIds((await pull(srv, LANE)).body.events), [a]);
  await ack(srv, LANE);
  const c = (await changes(srv, since)).body;
  await down(srv);
  srv = await boot({ dsid, store, eventDir, tokens });
  try {
    const b = await memory(srv, 'b');
    const r = await pull(srv, LANE);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(memIds(r.body.events), [b]);
    const cr = await changes(srv, c.cursor);
    assert.equal(cr.status, 200, JSON.stringify(cr.body));
    assert.deepEqual(memIds(cr.body.changes), [b]);
    // LEGACY: a pre-#1575 token (no epoch) is epoch 1
    // #1577: tokens are now chg3.<log>.<incarnation>.<epoch>.<commitSeq> — the regex only learns that spelling
    const m = /^chg\d\.(\d+)\.(?:[0-9a-f]{32}\.)?(?:\d+\.)?(\d+)$/.exec(c.cursor);
    const legacy = `chg1.${m[1]}.${m[2]}`;
    const lr = await changes(srv, legacy);
    assert.equal(lr.status, 200, JSON.stringify(lr.body));
    assert.deepEqual(memIds(lr.body.changes), [b]);
    // LEGACY: a lane stored with no executor epoch is epoch 1
    await ack(srv, LANE);
    const st = loadCursors(eventDir); delete st.seats[LANE].graph_epoch; delete st.seats[LANE].graph_incarnation; saveCursors(eventDir, st);   // #1577: a pre-#1577 lane has neither
    const d = await memory(srv, 'd');
    const lp = await pull(srv, LANE);
    assert.equal(lp.status, 200, JSON.stringify(lp.body));
    assert.deepEqual(memIds(lp.body.events), [d]);
  } finally { await down(srv); }
});

// ── PURE: the baseline rule and the page token ──────────────────────────────
test('#1575 PURE baseline: min(cursor, epochBase) from the promoted-from epoch; 0 (replay-all) for any other epoch or an unrecorded base', () => {
  assert.deepEqual(epochResyncBaseline({ cursorEpoch: 1, cursorCommitSeq: 215, epoch: 2, epochBase: 209 }), { commit_seq: 209, baseline: 'promotion' });
  assert.deepEqual(epochResyncBaseline({ cursorEpoch: 1, cursorCommitSeq: 200, epoch: 2, epochBase: 209 }), { commit_seq: 200, baseline: 'cursor' },
    'a cursor BEHIND the restore point keeps its place: 201–209 are in the restore and still owed');
  assert.deepEqual(epochResyncBaseline({ cursorEpoch: 1, cursorCommitSeq: 215, epoch: 3, epochBase: 212 }), { commit_seq: 0, baseline: 'replay-all' });
  assert.deepEqual(epochResyncBaseline({ cursorEpoch: 1, cursorCommitSeq: 215, epoch: 2, epochBase: null }), { commit_seq: 0, baseline: 'replay-all' });
  assert.deepEqual(epochResyncBaseline({ cursorEpoch: 3, cursorCommitSeq: 5, epoch: 2, epochBase: 4 }), { commit_seq: 0, baseline: 'replay-all' });
});

test('#1575 PURE: a page token (`before`) from another epoch is refused; from the same epoch, or a v1 token at epoch 1, it pages', () => {
  const row = (cs) => ({ kind: 'memory', op: 'create', seq: null, id: `m${cs}`, shortId: null, title: null, column: null, by: 'bob',
    at: `2026-10-04T12:00:${String(cs).padStart(2, '0')}.000Z`, graph: { opId: `urn:ex:op/logborn/memory/${cs}`, commitSeq: cs, version: 1 } });
  const graphRows = [row(1), row(2), row(3)];
  const base = { since: '2026-10-04T00:00:00.000Z', history: true, graphRows, graphThrough: 3, logThrough: 0 };
  assert.throws(() => queryChangesFromLog([], { ...base, graphEpoch: 2, graphEpochBase: 2, before: 'chgb2.1.1.1.3' }), (e) => e.code === 'CURSOR_EPOCH_CHANGED' && e.epoch === 2 && e.cursor_epoch === 1);
  assert.throws(() => queryChangesFromLog([], { ...base, graphEpoch: 2, before: 'chgb1.1.1.3' }), (e) => e.code === 'CURSOR_EPOCH_CHANGED', 'a v1 token is epoch 1');
  assert.deepEqual(queryChangesFromLog([], { ...base, graphEpoch: 2, before: 'chgb2.1.1.2.3' }).changes.map((r) => r.id), ['m1', 'm2']);
  assert.deepEqual(queryChangesFromLog([], { ...base, graphEpoch: 1, before: 'chgb1.1.1.3' }).changes.map((r) => r.id), ['m1', 'm2']);
});

// ── a reviewer 15:38Z: a RESTORE OF A RESTORE. The second promotion OVERWRITES epochBase (it names
// where the CURRENT epoch began), and a lane TWO epochs behind is refused and resynced as
// replay-all (from 0): it may see rows it already had again (dedup by graph.opId), but it
// never misses a row of the store it now reads. Named here so the semantics are pinned.
test('#1575 restore of a restore: epochBase is overwritten by the second promotion; a lane two epochs behind is refused, then replay-all serves every row of the current store exactly once', { skip: SKIP }, async () => {
  const dsid = 'ep1575-c';
  const tokens = tokensFile();
  const live = initStore(dsid);
  const eventDir = tmpdir('events');
  const LANE = 'registry:twice1575.t';
  const epochBaseOf = async (srv) => {
    const r = await fetch(`${srv.executorUrl}/query`, { method: 'POST', body: 'SELECT ?e ?b ?s WHERE { GRAPH <urn:scrum:bookkeeping:executor> { <urn:ex:dataset> <urn:ex:epoch> ?e ; <urn:ex:commitSeq> ?s . OPTIONAL { <urn:ex:dataset> <urn:ex:epochBase> ?b } } }' });
    const b = (await r.json()).results.bindings;
    assert.equal(b.length, 1, 'exactly one marker row (an overwrite, not a second epochBase)');
    return { epoch: Number(b[0].e.value), epochBase: b[0].b ? Number(b[0].b.value) : null, commitSeq: Number(b[0].s.value) };
  };

  // epoch 1: the lane reads k1, then the first backup is taken
  let srv = await boot({ dsid, store: live, eventDir, tokens });
  assert.equal((await call(srv, 'POST', '/api/cursors/register', { registrySeatId: 'twice1575.t' })).status, 200);
  const k1 = await memory(srv, 'k1');
  let r = await pull(srv, LANE);
  assert.deepEqual(memIds(r.body.events), [k1]);
  await ack(srv, LANE);
  await down(srv);
  const backupA = tmpdir('restoreA');
  fs.cpSync(live, backupA, { recursive: true });

  // first promotion → epoch 2; a write lands, then a second backup is taken of THAT store
  await promote(backupA, dsid);
  srv = await boot({ dsid, store: backupA, eventDir, tokens });
  const m1 = await epochBaseOf(srv);
  assert.equal(m1.epoch, 2);
  const e2a = await memory(srv, 'e2-a');
  await down(srv);
  const backupB = tmpdir('restoreB');
  fs.cpSync(backupA, backupB, { recursive: true });
  srv = await boot({ dsid, store: backupA, eventDir, tokens });
  await memory(srv, 'e2-lost');   // lost with store A
  await down(srv);

  // second promotion (the restore of the restore) → epoch 3
  await promote(backupB, dsid);
  srv = await boot({ dsid, store: backupB, eventDir, tokens });
  try {
    const m2 = await epochBaseOf(srv);
    assert.equal(m2.epoch, 3);
    assert.notEqual(m2.epochBase, m1.epochBase, 'the second promotion OVERWROTE epochBase');
    assert.equal(m2.epochBase, m2.commitSeq, 'epochBase = store B\'s own commitSeq at its promotion');
    const e3a = await memory(srv, 'e3-a');

    // the lane is still on epoch 1: TWO epochs behind
    r = await pull(srv, LANE);
    assert.notEqual(r.status, 200, `a lane two epochs behind must not be answered — served: ${JSON.stringify(memIds(r.body.events ?? []))}`);
    assert.equal(r.body.code, 'CURSOR_EPOCH_CHANGED', JSON.stringify(r.body));
    assert.equal(r.body.epoch, 3);
    assert.equal(r.body.cursor_epoch, 1);
    assert.equal(r.body.baseline.baseline, 'replay-all', 'two epochs behind: epochBase describes epoch 2→3 only, so no exact baseline exists');
    assert.equal(r.body.baseline.commit_seq, 0);

    const rs = await call(srv, 'POST', '/api/cursors/register', { registrySeatId: 'twice1575.t', resync: 'epoch' });
    assert.equal(rs.status, 200, JSON.stringify(rs.body));
    assert.equal(rs.body.resynced.baseline, 'replay-all');
    const served = [];
    for (let i = 0; i < 5; i++) {
      r = await pull(srv, LANE);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      served.push(...memIds(r.body.events));
      await ack(srv, LANE);
    }
    assert.deepEqual(served, [k1, e2a, e3a], 'every row of the CURRENT store exactly once (k1 again: replay-all re-serves what the lane had; dedup by graph.opId); the lost e2 write is not there');
  } finally { await down(srv); }
});
