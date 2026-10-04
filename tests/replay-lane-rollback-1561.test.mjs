/**
 * #1561 ROLLBACK × replay lanes — a lane's GRAPH HALF across a unit-1 rollback.
 *
 * After rollback (flag OFF) every executor-born unit write is a reverse-exported LOG
 * event, at a seq above every lane's `acked`. A lane that already received AND acked
 * some of those writes through its graph half would be served them again (duplicates),
 * and its graph half would never be reconciled.
 *
 * THE RULE (translate when proven; visible refusal and explicit resync otherwise):
 *   PROVEN    the export's INCARNATION and EPOCH equal the lane's graph_incarnation /
 *             graph_epoch → an export with commitSeq ≤ graph_ACKED is skipped (counted:
 *             envelope.translated_skipped); one above graph_acked — served-but-unacked
 *             or never served — is served. Never translated from graph_served.
 *   UNPROVEN  any owed export from another epoch / incarnation, or with NO recorded
 *             incarnation (a rollback made before this change), or a lane with no
 *             incarnation → CURSOR_ROLLED_BACK, resync: true, lane unchanged.
 *   RESYNC    POST /api/cursors/register { resync: 'rollback' } sets the graph half
 *             aside (graph_rolled_back) and resumes the log half from its acked: every
 *             export is delivered, duplicates possible, none skipped.
 *   CLEARED   once acked passes every export the translation covered, the graph half
 *             is cleared (graph_reconciled kept for audit): later pulls are plain.
 *   TWIN      a lane with no graph half is unaffected.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { startRestServer, freePort, makeBoardFixture, PROJECT_DIR } from './helpers/harness.mjs';
import { mintToken, hashToken } from '../core/credentials.mjs';
import { createGraphClient } from '../core/graph-client.mjs';
import { appendEvent, readEvents } from '../core/event-log.mjs';
import { loadCursors, saveCursors } from '../core/cursors.mjs';
import { registerFor, serveFor, ackFor } from '../core/cursor-service.mjs';
import { queryChangesFromLog, forwardCursor } from '../core/changes-log-query.mjs';
import { migrate } from '../scripts/migrate-logborn-1561.mjs';
import { rollback } from '../scripts/rollback-logborn-1561.mjs';

// ── PURE: cursor-service over a real event log ──────────────────────────────
let n = 0;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), `lrb-${process.pid}-${n++}-`));
const INC = 'a'.repeat(32), INC2 = 'b'.repeat(32);
const KEY = 'registry:lane.rb';
const card = (dir, i) => appendEvent(dir, { op: 'update', entity: { kind: 'card', id: `card-${i}`, shortId: i }, state: { title: `c${i}` }, actor: 'ada' });
const exp = (dir, commitSeq, { epoch = '1', incarnation = INC } = {}) => appendEvent(dir, {
  op: 'create', actor: 'bob', entity: { kind: 'memory', id: `m${commitSeq}` }, state: { identity: {}, versions: [] },
  reverseExport: { opId: `urn:ex:op/logborn/memory/${commitSeq}`, commitSeq, at: '2026-10-04T10:00:00Z', actor: 'urn:ex:seat/bob', digest: 'd', epoch,
    ...(incarnation ? { incarnation } : {}), tool: 'test' },
});
/** A lane that, while ON, acked through commitSeq 2 and was served (not acked) commitSeq 3. */
function laneWithGraphHalf(dir, { acked = 2, served = 3, epoch = 1, incarnation = INC } = {}) {
  registerFor(dir, KEY);
  const st = loadCursors(dir);
  Object.assign(st.seats[KEY], { graph_acked: acked, graph_served: served, graph_epoch: epoch, ...(incarnation ? { graph_incarnation: incarnation } : {}) });
  saveCursors(dir, st);
}
const ops = (events) => events.filter((e) => e.reverseExport).map((e) => e.reverseExport.commitSeq);
const seat = (dir) => loadCursors(dir).seats[KEY];
function pullAck(dir, opts = {}) {
  const p = serveFor(dir, KEY, opts);
  p.commit();
  const a = p.ack_token ? ackFor(dir, KEY, p.ack_token) : null;
  return { p, a };
}
const rollbackOf = (dir, opts) => { for (const c of [1, 2, 3, 4]) exp(dir, c, opts); };

test('#1561 lanes PURE TRANSLATE: acked exports skipped (counted), served-unacked and unserved served once; then the graph half is cleared', () => {
  const dir = tmp();
  card(dir, 1);
  laneWithGraphHalf(dir);
  rollbackOf(dir);
  card(dir, 2);
  const { p, a } = pullAck(dir);
  assert.deepEqual(ops(p.events), [3, 4], 'not 1,2 (acked through the graph half); 3 (served, unacked) and 4 (unserved) once');
  assert.equal(p.events.filter((e) => !e.reverseExport).length, 1, 'native events unaffected');
  assert.equal(p.envelope.translated_skipped, 2);
  assert.equal(a.advanced, true);
  assert.equal(seat(dir).graph_acked, undefined, 'graph half cleared once every covered export is acked past');
  assert.equal(seat(dir).graph_reconciled.graph_acked, 2, 'kept for audit');
  const again = serveFor(dir, KEY);
  assert.deepEqual(again.events, []);
  assert.equal(again.envelope.translated_skipped, undefined, 'a plain log pull now');
});

test('#1561 lanes PURE: translate from ACKED, never served — a stale graph_served does not widen the skip', () => {
  const dir = tmp();
  laneWithGraphHalf(dir, { acked: 1, served: 3 });
  rollbackOf(dir);
  const { p } = pullAck(dir);
  assert.deepEqual(ops(p.events), [2, 3, 4]);
  assert.equal(p.envelope.translated_skipped, 1);
});

test('#1561 lanes PURE PAGES (#1580): a page is REFILLED past skipped exports — an empty page means the log is exhausted, never "more is owed"', () => {
  const dir = tmp();
  laneWithGraphHalf(dir, { acked: 4, served: null });
  rollbackOf(dir);
  card(dir, 9);
  // before #1580 this page was EMPTY (limit applied before the skip) while card 9 was owed
  const first = pullAck(dir, { limit: 2 });
  assert.deepEqual(first.p.events.map((e) => e.entity.shortId), [9], 'the native event behind 4 skipped exports arrives on the FIRST page');
  assert.equal(first.p.envelope.translated_skipped, 4);
  assert.equal(first.a.advanced, true);
  const second = pullAck(dir, { limit: 2 });
  assert.deepEqual(second.p.events, [], 'now genuinely caught up');
  assert.equal(second.p.ack_token, null, 'and nothing to ack');
});

test('#1580 a reviewer P3b: graph_acked 2, exports 1..4, limit 1 — the first page holds the first OWED export, not []', () => {
  const dir = tmp();
  laneWithGraphHalf(dir, { acked: 2, served: null });
  rollbackOf(dir);
  const pages = [];
  for (let i = 0; i < 6; i++) { const { p } = pullAck(dir, { limit: 1 }); pages.push(ops(p.events)); }
  assert.deepEqual(pages[0], [3], 'not [] while 3 and 4 are owed');
  assert.deepEqual(pages.flat(), [3, 4], 'every owed export exactly once');
  assert.ok(pages.slice(0, 2).every((pg) => pg.length === 1), 'no empty page while rows remain');
});

test('#1580 a page of ONLY skipped exports at the END of the log still yields an ack token, so the lane cannot stall', () => {
  const dir = tmp();
  laneWithGraphHalf(dir, { acked: 4, served: null });
  rollbackOf(dir);
  const { p, a } = pullAck(dir, { limit: 2 });
  assert.deepEqual(p.events, []);
  assert.equal(p.envelope.translated_skipped, 4, 'read to the end of the log');
  assert.ok(p.ack_token);
  assert.equal(a.advanced, true);
  assert.equal(serveFor(dir, KEY).ack_token, null, 'afterwards nothing is owed');
});

for (const [name, lane, exportOpts, reason] of [
  ['another EPOCH', { epoch: 2 }, {}, 'epoch'],
  ['another INCARNATION', {}, { incarnation: INC2 }, 'incarnation'],
  ['an export with NO recorded incarnation (a pre-change rollback)', {}, { incarnation: null }, 'unrecorded-incarnation'],
  ['a lane with no incarnation (pre-#1577)', { incarnation: null }, {}, 'lane-without-incarnation'],
]) {
  test(`#1561 lanes PURE REFUSE: ${name} → CURSOR_ROLLED_BACK, lane unchanged; resync delivers every export`, () => {
    const dir = tmp();
    laneWithGraphHalf(dir, lane);
    rollbackOf(dir, exportOpts);
    const before = JSON.stringify(seat(dir));
    const p = serveFor(dir, KEY);
    assert.equal(p.refused, 'CURSOR_ROLLED_BACK');
    assert.equal(p.rollbackError.reason, reason);
    assert.equal(p.rollbackError.resume_from_seq, seat(dir).acked);
    assert.deepEqual(p.events, []);
    assert.equal(p.commit(), null);
    assert.equal(JSON.stringify(seat(dir)), before, 'lane unchanged');
    const r = registerFor(dir, KEY, { resync: 'rollback' });
    assert.equal(r.resynced.kind, 'rollback');
    assert.equal(seat(dir).graph_acked, undefined);
    assert.equal(seat(dir).graph_rolled_back.graph_acked, lane.acked ?? 2);
    const { p: q } = pullAck(dir);
    assert.deepEqual(ops(q.events), [1, 2, 3, 4], 'every export, none skipped');
  });
}

test('#1561 lanes PURE TWIN: a lane with no graph half is unaffected', () => {
  const dir = tmp();
  registerFor(dir, KEY);
  rollbackOf(dir, { incarnation: null });
  const { p } = pullAck(dir);
  assert.deepEqual(ops(p.events), [1, 2, 3, 4]);
  assert.equal(p.envelope.translated_skipped, undefined);
  assert.equal(p.refused, undefined);
});

test('#1561 lanes PURE: resync rollback is refused while the graph source is ON', () => {
  const dir = tmp();
  laneWithGraphHalf(dir);
  const r = registerFor(dir, KEY, { resync: 'rollback', graphHead: 5, graphEpoch: 1, graphIncarnation: INC });
  assert.ok(r.resync_refused);
  assert.equal(seat(dir).graph_acked, 2);
});

test('#1561 change feed: a forward cursor carrying an incarnation translates ONLY exports of that incarnation; a legacy cursor translates NOTHING', () => {
  const dir = tmp();
  rollbackOf(dir);                       // INC
  exp(dir, 2, { incarnation: INC2 });    // same commitSeq, another store
  exp(dir, 3, { incarnation: null });    // pre-change export: unprovable
  const events = readEvents(dir);
  const cur = forwardCursor(0, 1, 3, INC);
  const r = queryChangesFromLog(events, { since: cur, history: true, limit: 500 });
  const got = r.changes.map((c) => `${c.reverseExport.commitSeq}${c.reverseExport.incarnation === INC2 ? 'b' : c.reverseExport.incarnation ? '' : '?'}`);
  assert.deepEqual(got, ['4', '2b', '3?']);
  // a reviewer 16:38Z: a LEGACY cursor (chg1/chg2, no incarnation) cannot prove which store it read:
  // epoch alone does not identify a store across restores, so it skips NOTHING — every export
  // comes back, marked `reverseExport` (duplicates possible, never a silent skip)
  const allExports = events.filter((e) => e.reverseExport).map((e) => e.reverseExport.commitSeq);
  for (const tok of ['chg2.0.1.3', 'chg1.0.3']) {
    const legacy = queryChangesFromLog(events, { since: tok, history: true, limit: 500 });
    assert.deepEqual(legacy.changes.map((c) => c.reverseExport.commitSeq).sort(), [...allExports].sort(), `${tok}: no export skipped`);
    assert.ok(legacy.changes.every((c) => c.reverseExport), `${tok}: each one marked`);
  }
});

// ── E2E: a real executor, a flag-ON server, rollback --run, a flag-OFF server ──
const PY = process.env.GRAPH_EXECUTOR_PYTHON || path.join(PROJECT_DIR, 'graph-executor', '.venv', 'bin', 'python');
const HAVE_PY = fs.existsSync(PY) && spawnSync(PY, ['-c', 'import pyoxigraph'], { stdio: 'ignore' }).status === 0;
const SKIP = HAVE_PY ? false : `UNAVAILABLE: no python with pyoxigraph at ${PY}`;
const TOK = { bob: mintToken() };

async function startExecutor(dsid, store, create = false) {
  const port = await freePort();
  const proc = spawn(PY, [path.join(PROJECT_DIR, 'graph-executor', 'executor.py'), '--store', store, '--port', String(port), '--dataset-id', dsid, ...(create ? ['--create'] : []), '--exit-on-stdin-eof'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let err = '';
  proc.stderr.on('data', (d) => { err += d; });
  await new Promise((resolve, reject) => {
    let out = ''; proc.stdout.on('data', (d) => { out += d; if (out.includes('\n')) resolve(); });
    proc.on('exit', (c) => reject(new Error(`executor exited ${c}: ${err}`)));
  });
  const url = `http://127.0.0.1:${port}`;
  return { client: createGraphClient({ baseUrl: url, expectedDatasetId: dsid, timeoutMs: 60000 }), stop: () => new Promise((r) => { proc.once('exit', r); proc.kill('SIGKILL'); }) };
}
const api = async (base, method, p, body) => {
  const r = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOK.bob}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
async function setup(dsid) {
  const off = await startRestServer({ board: makeBoardFixture({}) });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lrb-e2e-'));
  const board = path.join(dir, 'board.json'), events = path.join(dir, 'board-events');
  try {
    await api(off.baseUrl, 'POST', '/api/memories', { owner: 'bob', title: 'pre', body: 'x' });
    fs.copyFileSync(off.boardFile, board);
    fs.cpSync(off.boardFile.replace(/\.json$/, '-events'), events, { recursive: true });
  } finally { await off.stop(); }
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'lrb-store-'));
  const ex = await startExecutor(dsid, store, true);
  try { assert.equal((await migrate({ board, events, client: ex.client, actor: 'urn:ex:seat/builder', mode: 'run' })).refused, null); } finally { await ex.stop(); }
  const cred = { tokenHash: hashToken(TOK.bob), scope: 'admin', issuedAt: new Date(Date.now() - 3600e3).toISOString(), expiresAt: new Date(Date.now() + 86400e3).toISOString(), issuedBy: 'test', revokedAt: null, note: null };
  const tokens = path.join(dir, 'tokens.json');
  fs.writeFileSync(tokens, JSON.stringify({ seats: { bob: { credentials: [cred] } } }));
  return { board, events, store, tokens };
}
async function serve(c, dsid, unit) {
  const env = { SCRUM_SEAT_TOKENS: c.tokens, SCRUM_AUTH: 'required' };
  if (unit) Object.assign(env, { SCRUM_GRAPH_EXECUTOR_URL: `http://127.0.0.1:${await freePort()}`, SCRUM_GRAPH_DATASET_ID: dsid, SCRUM_TRIAL_EXECUTOR_STORE: c.store, GRAPH_EXECUTOR_PYTHON: PY, SCRUM_GRAPH_UNIT_LOGBORN: '1' });
  const srv = await startRestServer({ boardFile: c.board, env });
  if (unit) for (let i = 0; i < 200; i++) { if ((await api(srv.baseUrl, 'GET', '/api/trial/counters')).body.executor) break; await new Promise((r) => setTimeout(r, 50)); }
  return srv;
}
async function stopKeeping(srv, c) {
  const keep = `${c.board}.keep`;
  fs.copyFileSync(c.board, keep);
  await srv.stop();
  fs.renameSync(keep, c.board);
}
const write = async (b, title) => {
  const r = await api(b, 'POST', '/api/memories', { owner: 'bob', title, body: title });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.id;
};
const pullW = (b, identity) => api(b, 'GET', `/api/cursors/pull?${new URLSearchParams({ identity, via: 'v1' })}`);
const ackW = (b, identity, token) => api(b, 'POST', '/api/cursors/ack', { identity, token });
const exportedIds = (events) => events.filter((e) => e.reverseExport).map((e) => String(e.entity.id).replace(/^.*\//, ''));

test('#1561 lanes E2E: after rollback a lane receives exactly the exports it had not ACKED; tamper → refusal; resync → all; twin unaffected', { skip: SKIP }, async () => {
  const dsid = 'lrb-e2e';
  const c = await setup(dsid);
  const L = 'registry:lane.e2e', T = 'registry:twin.e2e', X = 'registry:tamper.e2e';
  const M = {};
  const on = await serve(c, dsid, true);
  try {
    for (const id of ['lane.e2e', 'twin.e2e', 'tamper.e2e']) assert.equal((await api(on.baseUrl, 'POST', '/api/cursors/register', { registrySeatId: id })).status, 200);
    M.a = await write(on.baseUrl, 'acked-1');
    M.b = await write(on.baseUrl, 'acked-2');
    for (const lane of [L, X]) {
      const p = await pullW(on.baseUrl, lane);
      assert.equal(p.status, 200, JSON.stringify(p.body));
      assert.ok(p.body.events.some((e) => e.graph), 'served through the graph half');
      assert.equal((await ackW(on.baseUrl, lane, p.body.ack_token)).body.advanced, true);
    }
    M.c = await write(on.baseUrl, 'served-unacked');
    for (const lane of [L, X]) assert.equal((await pullW(on.baseUrl, lane)).body.events.filter((e) => e.graph).length, 1);   // never acked
    M.d = await write(on.baseUrl, 'unserved');
  } finally { await stopKeeping(on, c); }
  const cur = loadCursors(c.events);
  assert.ok(cur.seats[L].graph_acked > 0 && cur.seats[L].graph_incarnation, JSON.stringify(cur.seats[L]));
  // the twin: a lane that never had a graph half
  for (const k of ['graph_acked', 'graph_served', 'graph_epoch', 'graph_incarnation']) delete cur.seats[T][k];
  saveCursors(c.events, cur);

  const ex = await startExecutor(dsid, c.store);
  try {
    const run = await rollback({ board: c.board, events: c.events, client: ex.client, mode: 'run', pending: [] });
    assert.equal(run.refused, null, JSON.stringify(run));
    assert.equal(run.written, 4);
  } finally { await ex.stop(); }
  const exports = readEvents(c.events).filter((e) => e.reverseExport);
  assert.ok(exports.every((e) => /^[0-9a-f]{32}$/.test(e.reverseExport.incarnation ?? '')), 'the marker records the store incarnation');
  assert.equal(exports[0].reverseExport.incarnation, cur.seats[L].graph_incarnation);

  const off = await serve(c, dsid, false);
  try {
    // the lane: exactly the served-unacked and the unserved write, each once
    const seen = [];
    let skipped = 0;
    for (let i = 0; i < 5; i++) {
      const p = await pullW(off.baseUrl, L);
      assert.equal(p.status, 200, JSON.stringify(p.body));
      seen.push(...exportedIds(p.body.events));
      skipped += p.body.envelope.translated_skipped ?? 0;
      if (!p.body.ack_token) break;
      assert.equal((await ackW(off.baseUrl, L, p.body.ack_token)).status, 200);
    }
    assert.deepEqual(seen, [M.c, M.d], `got ${JSON.stringify(seen)}; acked ${JSON.stringify([M.a, M.b])} must not return`);
    assert.equal(skipped, 2);
    assert.equal(loadCursors(c.events).seats[L].graph_acked, undefined, 'graph half reconciled and cleared');

    // the twin: every export, no translation
    const t = await pullW(off.baseUrl, T);
    assert.deepEqual(exportedIds(t.body.events), [M.a, M.b, M.c, M.d]);
    assert.equal(t.body.envelope.translated_skipped, undefined);

    // tamper the lane's epoch (same incarnation): not provable → visible refusal, lane unchanged
    const st = loadCursors(c.events);
    st.seats[X].graph_epoch = 7;
    saveCursors(c.events, st);
    const before = JSON.stringify(loadCursors(c.events).seats[X]);
    const r = await pullW(off.baseUrl, X);
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.code, 'CURSOR_ROLLED_BACK');
    assert.equal(r.body.resync, true);
    assert.equal(r.body.reason, 'epoch');
    assert.equal(r.body.resume_from_seq, loadCursors(c.events).seats[X].acked);
    assert.equal(JSON.stringify(loadCursors(c.events).seats[X]), before, 'lane unchanged');
    // explicit resync → every export at least once, none skipped
    const rs = await api(off.baseUrl, 'POST', '/api/cursors/register', { registrySeatId: 'tamper.e2e', resync: 'rollback' });
    assert.equal(rs.status, 200, JSON.stringify(rs.body));
    assert.equal(rs.body.resynced.kind, 'rollback');
    const got = await pullW(off.baseUrl, X);
    assert.deepEqual(exportedIds(got.body.events), [M.a, M.b, M.c, M.d]);
  } finally { await off.stop(); }
});

// #1580 the refill must STOP right after the page's last row: reading on through the chunk would
// put rows that were never served under the page's high-water, and the ack would skip them.
test('#1580 refill never reads past the page: 1 covered then 3 owed at limit 2 → pages [2,3] then [4], none skipped', () => {
  const dir = tmp();
  laneWithGraphHalf(dir, { acked: 1, served: null });
  rollbackOf(dir);
  const first = pullAck(dir, { limit: 2 });
  assert.deepEqual(ops(first.p.events), [2, 3]);
  const second = pullAck(dir, { limit: 2 });
  assert.deepEqual(ops(second.p.events), [4], 'export 4 was not swallowed by the first page\'s high-water');
});
