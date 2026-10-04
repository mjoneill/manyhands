/**
 * #1561 — ROLLBACK of the log-born unit: turning SCRUM_GRAPH_UNIT_LOGBORN OFF after a
 * cutover without losing anything written while it was ON.
 *
 *   ROUND TRIP  a flag-OFF board is migrated; a flag-ON server takes real writes
 *               (memory create / append / retitle / retag, revise of a migrated memory,
 *               decisions with a create-time relation and a later relate, seat declare /
 *               re-declare / clear); rollback --run reverse-exports them into the event
 *               log; a flag-OFF server then serves the same memories (versions, identity
 *               history), decisions (relations), seat states and change rows.
 *   ATTRIBUTION every reverse-exported event carries the receipt's actor and time and a
 *               `reverseExport` marker; the change rows' `by` equal the flag-ON rows'.
 *   IDEMPOTENT  a second run writes nothing.
 *   CURSORS     a flag-ON forward cursor is TRANSLATED (no row served twice); a flag-ON
 *               backward page token is REFUSED visibly (CURSOR_RESET, resync).
 *   UNKNOWN     an outstanding UNKNOWN is reconciled by receipt: APPLIED → exported,
 *               ABSENT → reported not applied; an unreadable executor refuses.
 *   REFUSAL     a receipt whose recorded nodes do not reproduce its digest is refused
 *               BEFORE any write.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { startRestServer, freePort, makeBoardFixture, PROJECT_DIR } from './helpers/harness.mjs';
import { mintToken, hashToken } from '../core/credentials.mjs';
import { createGraphClient } from '../core/graph-client.mjs';
import { readEvents } from '../core/event-log.mjs';
import { migrate } from '../scripts/migrate-logborn-1561.mjs';
import { rollback } from '../scripts/rollback-logborn-1561.mjs';

const PY = process.env.GRAPH_EXECUTOR_PYTHON || path.join(PROJECT_DIR, 'graph-executor', '.venv', 'bin', 'python');
const HAVE_PY = fs.existsSync(PY) && spawnSync(PY, ['-c', 'import pyoxigraph'], { stdio: 'ignore' }).status === 0;
const SKIP = HAVE_PY ? false : `UNAVAILABLE: no python with pyoxigraph at ${PY}`;
const ACTOR = 'urn:ex:seat/builder';
const TOK = { bob: mintToken(), ada: mintToken() };
const later = new Date(Date.now() + 7 * 86400_000).toISOString();
const LOGBORN = new Set(['memory', 'decision', 'seat-state']);

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
  return { proc, store, url, client: createGraphClient({ baseUrl: url, expectedDatasetId: dsid, timeoutMs: 60000 }), stop: () => new Promise((r) => { proc.once('exit', r); proc.kill('SIGKILL'); }) };
}
const rawUpdate = (url, sparql) => fetch(`${url}/update`, { method: 'POST', headers: { 'x-op-id': `urn:ex:op/tamper/${Math.random()}` }, body: sparql }).then((r) => r.status);
const seqOf = async (url) => Number((await (await fetch(`${url}/health`)).json()).commitSeq);

const api = async (base, method, p, body, who = 'bob') => {
  const r = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOK[who]}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
function tokensFile(dir) {
  const at = (h) => new Date(Date.now() + h * 3600_000).toISOString();
  const cred = (p) => ({ tokenHash: hashToken(p), scope: 'admin', issuedAt: at(-1), expiresAt: at(24), issuedBy: 'test', revokedAt: null, note: null });
  const f = path.join(dir, 'tokens.json');
  fs.writeFileSync(f, JSON.stringify({ seats: Object.fromEntries(Object.entries(TOK).map(([k, v]) => [k, { credentials: [cred(v)] }])) }));
  return f;
}
/** What a caller reads, in a comparable form. */
async function reads(base, ids) {
  const out = {};
  const list = await api(base, 'GET', '/api/memories');
  out.list = { ...list.body, memories: [...list.body.memories].sort((a, b) => (a.id < b.id ? -1 : 1)) };
  for (const id of ids) {
    out[`get ${id}`] = (await api(base, 'GET', `/api/memories/${id}`)).body;
    out[`identities ${id}`] = (await api(base, 'GET', `/api/memories/${id}/versions?identities=1`)).body;
  }
  out.decisions = (await api(base, 'GET', '/api/decisions')).body;
  const seats = (await api(base, 'GET', '/api/seats/state')).body;
  out.seats = { ...seats, now: '<now>', graph: '<graph>', // a seat's constraints are a SET in both stores and are served in store order on both
  // paths (unlike tags / constrains, which the folds sort): compared as a set
  seats: seats.seats.map((s) => ({ ...s, expired: '<depends on now>', ...(Array.isArray(s.constraints) ? { constraints: [...s.constraints].sort() } : {}) })) };
  return out;
}
/** The unit's change rows, normalised to what must survive a rollback (seq/at/source legitimately differ). */
const unitRows = (changes) => changes.filter((c) => LOGBORN.has(c.kind)).map((c) => ({ kind: c.kind, op: c.op, id: c.id, by: c.by }));

let srcDir;
before(async () => {
  if (SKIP) return;
  const off = await startRestServer({ board: makeBoardFixture({}) });
  try {
    const b = off.baseUrl;
    const m1 = (await api(b, 'POST', '/api/memories', { owner: 'bob', title: 'one', body: 'first', tags: ['z', 'a'], priority: 'p1' })).body.id;
    assert.equal((await api(b, 'PATCH', `/api/memories/${m1}`, { title: 'one, retitled', tags: ['q'] })).status, 200);
    const dA = (await api(b, 'POST', '/api/decisions', { statement: 'A', decidedBy: 'bob', constrains: ['t0'], reopensIf: 'R' })).body.id;
    assert.equal((await api(b, 'PUT', '/api/seats/bob/state', { mode: 'available', acceptsRoutineWork: true, expiresAt: later, note: 'before' })).status, 200);
    srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lbr-src-'));
    fs.copyFileSync(off.boardFile, path.join(srcDir, 'board.json'));
    fs.cpSync(off.boardFile.replace(/\.json$/, '-events'), path.join(srcDir, 'board-events'), { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'ids.json'), JSON.stringify({ m1, dA }));
  } finally { await off.stop(); }
});

/** A fresh copy of the source board, migrated into a fresh store. */
async function cutover(dsid) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lbr-'));
  const board = path.join(dir, 'board.json');
  const events = path.join(dir, 'board-events');
  fs.copyFileSync(path.join(srcDir, 'board.json'), board);
  fs.cpSync(path.join(srcDir, 'board-events'), events, { recursive: true });
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'lbr-store-'));
  const ex = await startExecutor(dsid, store, true);
  try {
    const run = await migrate({ board, events, client: ex.client, actor: ACTOR, mode: 'run' });
    assert.equal(run.refused, null, JSON.stringify(run));
  } finally { await ex.stop(); }
  return { dir, board, events, store, tokens: tokensFile(dir), ids: JSON.parse(fs.readFileSync(path.join(srcDir, 'ids.json'), 'utf8')) };
}
async function serve(c, dsid, unit) {
  const env = { SCRUM_SEAT_TOKENS: c.tokens, SCRUM_AUTH: 'required' };
  if (unit) Object.assign(env, { SCRUM_GRAPH_EXECUTOR_URL: `http://127.0.0.1:${await freePort()}`, SCRUM_GRAPH_DATASET_ID: dsid, SCRUM_TRIAL_EXECUTOR_STORE: c.store, GRAPH_EXECUTOR_PYTHON: PY, SCRUM_GRAPH_UNIT_LOGBORN: '1' });
  const srv = await startRestServer({ boardFile: c.board, env });
  if (unit) for (let i = 0; i < 200; i++) { if ((await api(srv.baseUrl, 'GET', '/api/trial/counters')).body.executor) break; await new Promise((r) => setTimeout(r, 50)); }
  return srv;
}
/** stop() removes the board file; keep it (the board outlives the server). */
async function stopKeeping(srv, c) {
  const keep = `${c.board}.keep`;
  fs.copyFileSync(c.board, keep);
  await srv.stop();
  fs.renameSync(keep, c.board);
}
/** A realistic burst of unit writes through REST, as two seats. Returns the ids it made. */
async function burst(b, { m1, dA }) {
  const m3 = (await api(b, 'POST', '/api/memories', { owner: 'ada', title: 'born ON', body: 'v1 text', tags: ['x'], by: 'bob' })).body.id;
  assert.ok(m3);
  assert.equal((await api(b, 'PATCH', `/api/memories/${m3}`, { bodyAppend: ' + appended' }, 'ada')).status, 200);
  assert.equal((await api(b, 'PATCH', `/api/memories/${m3}`, { title: 'born ON, retitled', tags: ['y', 'x'], priority: 'p2' })).status, 200);
  assert.equal((await api(b, 'PATCH', `/api/memories/${m3}`, { priority: null }, 'ada')).status, 200);
  assert.equal((await api(b, 'PATCH', `/api/memories/${m1}`, { bodyAppend: ' (revised while ON)', title: 'one, third' }, 'ada')).status, 200);
  const dB = (await api(b, 'POST', '/api/decisions', { statement: 'B', decidedBy: 'bob', constrains: ['t1', 't0'], reopensIf: 'R', supersedes: [dA] })).body.id;
  assert.ok(dB);
  const dC = (await api(b, 'POST', '/api/decisions', { statement: 'C', decidedBy: 'ada', constrains: ['t2'], reopensIf: 'R', force: true }, 'ada')).body.id;
  assert.equal((await api(b, 'POST', `/api/decisions/${dC}/relations`, { by: 'ada', duplicateOf: dB, supersedes: [dA] }, 'ada')).status, 201);
  assert.equal((await api(b, 'PUT', '/api/seats/bob/state', { mode: 'resting', acceptsRoutineWork: false, expiresAt: later })).status, 200);
  assert.equal((await api(b, 'PUT', '/api/seats/ada/state', { mode: 'degraded', acceptsRoutineWork: true, constraints: ['slow', 'low-context'], expiresAt: later, note: 'ON' }, 'ada')).status, 200);
  assert.equal((await api(b, 'DELETE', '/api/seats/bob/state')).status, 200);
  return { m3, dB, dC };
}

test('#1561 ROLLBACK round trip: ON writes are reverse-exported; a flag-OFF server serves what the flag-ON one did; a rerun writes nothing', { skip: SKIP }, async () => {
  const dsid = 'lbr-e2e';
  const c = await cutover(dsid);
  const since = new Date().toISOString();   // after the cutover: only the burst's rows
  let onReads, onRows, onCursor, onBack, ids;
  const on = await serve(c, dsid, true);
  try {
    ids = { ...c.ids, ...(await burst(on.baseUrl, c.ids)) };
    onReads = await reads(on.baseUrl, [ids.m1, ids.m3]);
    // the history the flag-ON server serves (the executor's revision nodes)
    assert.deepEqual(onReads[`identities ${ids.m3}`].identities, [
      { title: 'born ON', tags: ['x'], priority: null },
      { title: 'born ON, retitled', tags: ['x', 'y'], priority: 'p2' },
      { title: 'born ON, retitled', tags: ['x', 'y'], priority: null },
    ]);
    const feed = (await api(on.baseUrl, 'GET', `/api/changes?since=${encodeURIComponent(since)}&history=true&limit=500`)).body;
    onRows = unitRows(feed.changes);
    onCursor = feed.cursor;
    assert.equal(onRows.length, 11, JSON.stringify(onRows));
    const page = (await api(on.baseUrl, 'GET', `/api/changes?since=${encodeURIComponent(since)}&history=true&limit=2`)).body;
    onBack = page.nextBefore;
    assert.ok(onBack, 'a page token from the flag-ON server');
  } finally { await stopKeeping(on, c); }
  const logBefore = readEvents(c.events).length;

  const ex = await startExecutor(dsid, c.store);
  try {
    const dry = await rollback({ board: c.board, events: c.events, client: ex.client, mode: 'dry-run' });
    assert.equal(dry.refused, null, JSON.stringify(dry, null, 1));
    assert.equal(dry.planned, 11);
    assert.equal(readEvents(c.events).length, logBefore, 'the dry run wrote nothing');

    const run = await rollback({ board: c.board, events: c.events, client: ex.client, mode: 'run', pending: [] });
    assert.equal(run.refused, null, JSON.stringify(run, null, 1));
    assert.equal(run.written, 11);
    assert.deepEqual(run.diffs, []);
    const exported = readEvents(c.events).filter((e) => e.reverseExport);
    assert.equal(exported.length, 11);
    // attribution: the receipt's actor and time, and the marker
    for (const e of exported) {
      assert.match(e.reverseExport.opId, /^urn:ex:op\/logborn\//);
      assert.match(e.reverseExport.actor, /^urn:ex:seat\/(bob|ada)$/);
      assert.equal(e.occurred_at, new Date(Date.parse(e.reverseExport.at)).toISOString());
      assert.ok(e.recorded_at >= e.occurred_at, 'recorded at the rollback, after it occurred');
    }
    const relate = exported.find((e) => e.entity.kind === 'decision' && e.op === 'update');
    assert.equal(relate.actor, 'ada', 'the relate is credited to the seat that made it');
    assert.equal(relate.reverseExport.actor, 'urn:ex:seat/ada');

    const ver = await rollback({ board: c.board, events: c.events, client: ex.client, mode: 'verify' });
    assert.equal(ver.refused, null, JSON.stringify(ver.diffs));

    const n = readEvents(c.events).length;
    const again = await rollback({ board: c.board, events: c.events, client: ex.client, mode: 'run', pending: [] });
    assert.equal(again.refused, null, JSON.stringify(again));
    assert.equal(again.written, 0);
    assert.equal(again.alreadyExported, 11);
    assert.equal(readEvents(c.events).length, n, 'a rerun writes nothing');
  } finally { await ex.stop(); }

  const off = await serve(c, dsid, false);
  try {
    const offReads = await reads(off.baseUrl, [ids.m1, ids.m3]);
    for (const k of Object.keys(onReads)) assert.deepEqual(offReads[k], onReads[k], k);
    const feed = (await api(off.baseUrl, 'GET', `/api/changes?since=${encodeURIComponent(since)}&history=true&limit=500`)).body;
    assert.deepEqual(unitRows(feed.changes), onRows, 'the same change rows, in the same order, credited to the same seats');
    assert.ok(feed.changes.filter((r) => LOGBORN.has(r.kind)).every((r) => r.reverseExport), 'each row says it was reverse-exported');
    // a flag-ON forward cursor is TRANSLATED: the rows it already delivered are not served again
    const fwd = (await api(off.baseUrl, 'GET', `/api/changes?since=${onCursor}&history=true`)).body;
    assert.deepEqual(unitRows(fwd.changes), [], JSON.stringify(fwd.changes));
    // a flag-ON backward page token is REFUSED visibly
    const back = await api(off.baseUrl, 'GET', `/api/changes?since=${encodeURIComponent(since)}&history=true&before=${onBack}`);
    assert.equal(back.status, 400);
    assert.equal(back.body.code, 'CURSOR_RESET');
    assert.equal(back.body.resync, true);
  } finally { await off.stop(); }
});

test('#1561 ROLLBACK reconciles outstanding UNKNOWN writes by receipt, and refuses when it cannot', { skip: SKIP }, async () => {
  const dsid = 'lbr-unknown';
  const c = await cutover(dsid);
  const on = await serve(c, dsid, true);
  try { await burst(on.baseUrl, c.ids); } finally { await stopKeeping(on, c); }
  const ex = await startExecutor(dsid, c.store);
  let applied;
  try {
    const rows = (await ex.client.query('SELECT ?op WHERE { ?op <urn:ex:outcome> <urn:ex:APPLIED> FILTER(STRSTARTS(STR(?op), "urn:ex:op/logborn/memory/")) }')).rows;
    applied = rows[0].op.value;
    const absent = 'urn:ex:op/logborn/memory/00000000-0000-4000-8000-00000000dead';
    const r = await rollback({ board: c.board, events: c.events, client: ex.client, mode: 'run', pending: [{ opId: applied, kind: 'memory.revise' }, { opId: absent, kind: 'memory.create' }] });
    assert.equal(r.refused, null, JSON.stringify(r));
    assert.deepEqual(r.pending.applied, [applied], 'APPLIED → exported');
    assert.deepEqual(r.pending.absent, [absent], 'ABSENT → reported as not applied');
    assert.ok(readEvents(c.events).some((e) => e.reverseExport?.opId === applied));
    // a pending record that is not a unit write is refused (it cannot be reconciled here)
    const odd = await rollback({ board: c.board, events: c.events, client: ex.client, mode: 'run', pending: [{ opId: 'urn:ex:op/something-else/1' }] });
    assert.match(odd.refused ?? '', /cannot be reconciled/);
    // --run without the outstanding-UNKNOWN record is refused
    const none = await rollback({ board: c.board, events: c.events, client: ex.client, mode: 'run' });
    assert.match(none.refused ?? '', /pending/);
  } finally { await ex.stop(); }
  // an unreachable executor: nothing can be reconciled → refused, nothing written
  const n = readEvents(c.events).length;
  const dead = createGraphClient({ baseUrl: `http://127.0.0.1:${await freePort()}`, expectedDatasetId: dsid, timeoutMs: 2000 });
  const r = await rollback({ board: c.board, events: c.events, client: dead, mode: 'run', pending: [{ opId: applied }] });
  assert.ok(r.refused, JSON.stringify(r));
  assert.equal(readEvents(c.events).length, n);
});

test('#1561 ROLLBACK refuses BEFORE writing when a receipt cannot be carried faithfully (its nodes do not reproduce its digest)', { skip: SKIP }, async () => {
  const dsid = 'lbr-refuse';
  const c = await cutover(dsid);
  const on = await serve(c, dsid, true);
  let m3;
  try { ({ m3 } = await burst(on.baseUrl, c.ids)); } finally { await stopKeeping(on, c); }
  const ex = await startExecutor(dsid, c.store);
  try {
    // tamper: the first revision of m3 loses its prior title (the history the export carries)
    const M = `https://scrumboard.local/memory/${m3}`;
    assert.equal(await rawUpdate(ex.url, `DELETE DATA { <${M}/revision/1> <https://scrumboard.local/ns#priorName> "born ON" }`), 200);
    const n = readEvents(c.events).length;
    const s0 = await seqOf(ex.url);
    const r = await rollback({ board: c.board, events: c.events, client: ex.client, mode: 'run', pending: [] });
    assert.equal(r.refused, 'the executor holds writes this rollback cannot carry faithfully');
    assert.ok(r.diffs.some((d) => d.includes('digest')), r.diffs.join('\n'));
    assert.equal(r.written, 0);
    assert.equal(readEvents(c.events).length, n, 'nothing written to the log');
    assert.equal(await seqOf(ex.url), s0, 'nothing written to the executor');
  } finally { await ex.stop(); }
});

test('#1561 ROLLBACK downstream: fanout reads a reverse-exported row\'s last write at its ORIGINAL time, not the rollback\'s', async () => {
  const { lastWriteBySeatFrom } = await import('../scripts/fanout-decide.mjs');
  const rows = [
    { kind: 'card', by: 'ada', at: '2026-10-04T10:00:00.000Z' },
    { kind: 'memory', by: 'bob', at: '2026-10-04T12:00:00.000Z', reverseExport: { opId: 'urn:ex:op/logborn/memory/x', commitSeq: 3, at: '2026-10-04T09:30:00.123456+00:00' } },
  ];
  assert.deepEqual(lastWriteBySeatFrom(rows), { ada: '2026-10-04T10:00:00.000Z', bob: '2026-10-04T09:30:00.123Z' });
});
