/**
 * #1561 — the migration of the log-born records into an executor store.
 *
 *   END TO END  a board written by a flag-OFF server (log-born AND document-born
 *               memories and decisions, relations, relatedTo, seat history) is
 *               migrated; a flag-ON server on the migrated store answers the same
 *               reads as the flag-OFF server did, and can revise what was migrated.
 *   BOTH WAYS   verification catches a record missing from the target AND a
 *               target holding what the source does not (each by tampering).
 *   REFUSALS    a target that is not a prefix of the source; a source the kinds
 *               cannot carry faithfully. Both refused before any write.
 *   IDEMPOTENT  a rerun writes nothing.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { startRestServer, freePort, makeBoardFixture, PROJECT_DIR } from './helpers/harness.mjs';
import { mintToken, hashToken } from '../core/credentials.mjs';
import { createGraphClient } from '../core/graph-client.mjs';
import { migrate } from '../scripts/migrate-logborn-1561.mjs';

const PY = process.env.GRAPH_EXECUTOR_PYTHON || path.join(PROJECT_DIR, 'graph-executor', '.venv', 'bin', 'python');
const HAVE_PY = fs.existsSync(PY) && spawnSync(PY, ['-c', 'import pyoxigraph'], { stdio: 'ignore' }).status === 0;
const SKIP = HAVE_PY ? false : `UNAVAILABLE: no python with pyoxigraph at ${PY}`;
const ACTOR = 'urn:ex:seat/builder';
const TOK = { bob: mintToken() };
const later = new Date(Date.now() + 7 * 86400_000).toISOString();

const LEGACY_M = 'https://scrumboard.local/memory/00000000-0000-4000-8000-000000001561';
const LEGACY_FIXTURE = () => makeBoardFixture({
  memories: [
    { '@id': LEGACY_M, '@type': 'scrum:Memory', identifier: '00000000-0000-4000-8000-000000001561', name: 'from the document', 'scrum:owner': 'bob', 'scrum:tag': ['legacy', 'old'], 'scrum:currentVersion': `${LEGACY_M}/v1` },
    { '@id': `${LEGACY_M}/v1`, '@type': 'scrum:MemoryVersion', 'scrum:ofMemory': LEGACY_M, 'scrum:version': 1, 'scrum:body': 'document text', author: 'bob', dateCreated: '2026-09-01T00:00:00.000Z' },
  ],
  decisions: [{ '@id': 'https://scrumboard.local/decision/legacy-0001', '@type': 'scrum:Decision', identifier: 'legacy-0001', 'scrum:statement': 'an old ruling', 'scrum:decidedBy': 'ada', 'scrum:constrains': ['old'], 'scrum:reopensIf': 'never', dateCreated: '2026-08-01T00:00:00.000Z' }],
});

async function startExecutor(dsid, store = fs.mkdtempSync(path.join(os.tmpdir(), 'lbm-store-')), create = true) {
  const port = await freePort();
  const proc = spawn(PY, [path.join(PROJECT_DIR, 'graph-executor', 'executor.py'), '--store', store, '--port', String(port), '--dataset-id', dsid, ...(create ? ['--create'] : []), '--exit-on-stdin-eof'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let err = '';
  proc.stderr.on('data', (d) => { err += d; });
  await new Promise((resolve, reject) => {
    let out = ''; proc.stdout.on('data', (d) => { out += d; if (out.includes('\n')) resolve(); });
    proc.on('exit', (c) => reject(new Error(`executor exited ${c}: ${err}`)));
  });
  const url = `http://127.0.0.1:${port}`;
  return { proc, store, url, client: createGraphClient({ baseUrl: url, expectedDatasetId: dsid }), stop: () => new Promise((r) => { proc.once('exit', r); proc.kill('SIGKILL'); }) };
}
const rawUpdate = (url, sparql) => fetch(`${url}/update`, { method: 'POST', headers: { 'x-op-id': `urn:ex:op/tamper/${Math.random()}` }, body: sparql }).then((r) => r.status);
const seqOf = async (url) => Number((await (await fetch(`${url}/health`)).json()).commitSeq);

const api = async (base, method, p, body) => {
  const r = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOK.bob}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
/** The reads a caller makes, in a comparable form. */
async function reads(base, ids) {
  const out = {};
  const list = await api(base, 'GET', '/api/memories');
  out.list = { ...list.body, memories: [...list.body.memories].sort((a, b) => (a.id < b.id ? -1 : 1)) };
  for (const id of ids) {
    out[`get ${id}`] = (await api(base, 'GET', `/api/memories/${id}`)).body;
    out[`versions ${id}`] = (await api(base, 'GET', `/api/memories/${id}/versions`)).body;
    out[`identities ${id}`] = (await api(base, 'GET', `/api/memories/${id}/versions?identities=1`)).body;
  }
  out.assemble = (await api(base, 'GET', '/api/memories/assemble?owner=bob&budget=8192')).body;
  out.decisions = (await api(base, 'GET', '/api/decisions')).body;
  const seats = (await api(base, 'GET', '/api/seats/state')).body;
  out.seats = { ...seats, now: '<now>', graph: '<graph>', seats: seats.seats.map((s) => ({ ...s, expired: '<depends on now>' })) };
  return out;
}

let sourceBoard, sourceEvents, offReads, memIds;
before(async () => {
  if (SKIP) return;
  // a REAL board, written through the flag-OFF API
  const off = await startRestServer({ board: LEGACY_FIXTURE() });
  try {
    const b = off.baseUrl;
    for (const [name, definition] of [['scrum:relatedTo', 'see also; symmetric']]) assert.ok([200, 201, 409].includes((await api(b, 'POST', '/api/predicates', { name, definition, by: 'bob' })).status));
    const m1 = (await api(b, 'POST', '/api/memories', { owner: 'bob', title: 'one', body: 'first "quoted" ; text', tags: ['z', 'a'], priority: 'p1' })).body.id;
    const m2 = (await api(b, 'POST', '/api/memories', { owner: 'ada', title: 'two', body: 'second', by: 'bob' })).body.id;
    assert.equal((await api(b, 'PATCH', `/api/memories/${m1}`, { bodyAppend: ' + more' })).status, 200);
    assert.equal((await api(b, 'PATCH', `/api/memories/${m1}`, { title: 'one, retitled', tags: ['q'], priority: null })).status, 200);
    assert.equal((await api(b, 'PATCH', `/api/memories/${m1}`, { title: 'one, third', tags: ['q', 'r'] })).status, 200);
    assert.equal((await api(b, 'POST', '/api/assert', { by: 'bob', assertions: [{ subject: m1, predicate: 'scrum:relatedTo', object: m2 }] })).status, 200);
    const dA = (await api(b, 'POST', '/api/decisions', { statement: 'A', decidedBy: 'bob', constrains: ['t1', 't0'], reopensIf: 'R' })).body.id;
    await new Promise((r) => setTimeout(r, 15));
    assert.equal((await api(b, 'POST', '/api/decisions', { statement: 'B', decidedBy: 'bob', constrains: ['t1'], reopensIf: 'R', supersedes: [dA] })).status, 201);
    await new Promise((r) => setTimeout(r, 15));
    const dC = (await api(b, 'POST', '/api/decisions', { statement: 'C', decidedBy: 'bob', constrains: ['t2'], reopensIf: 'R', force: true })).body.id;
    assert.equal((await api(b, 'POST', `/api/decisions/${dC}/relations`, { by: 'bob', duplicateOf: 'legacy-0001' })).status, 201);
    for (const body of [{ mode: 'available', acceptsRoutineWork: true, expiresAt: later, note: 'here' }, { mode: 'resting', acceptsRoutineWork: false, expiresAt: later }]) {
      assert.equal((await api(b, 'PUT', '/api/seats/bob/state', body)).status, 200);
    }
    assert.equal((await api(b, 'DELETE', '/api/seats/bob/state')).status, 200);
    assert.equal((await api(b, 'PUT', '/api/seats/ada/state', { mode: 'available', acceptsRoutineWork: true, expiresAt: later })).status, 200);
    memIds = [m1, m2, '00000000-0000-4000-8000-000000001561'];
    offReads = await reads(b, memIds);
    // the flag-OFF history this migration must carry (from the event log)
    assert.deepEqual(offReads[`identities ${m1}`].identities, [
      { title: 'one', tags: ['a', 'z'], priority: 'p1' }, { title: 'one, retitled', tags: ['q'], priority: null }, { title: 'one, third', tags: ['q', 'r'], priority: null },
    ]);
    // keep a copy of the board and its event log: the server's stop() removes the board file
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lbm-src-'));
    sourceBoard = path.join(dir, 'board.json');
    sourceEvents = path.join(dir, 'board-events');
    fs.copyFileSync(off.boardFile, sourceBoard);
    fs.cpSync(off.boardFile.replace(/\.json$/, '-events'), sourceEvents, { recursive: true });
  } finally { await off.stop(); }
});

test('#1561 MIGRATION end to end: dry run writes nothing; run copies and verifies both ways; a rerun writes nothing; a flag-ON server answers as the flag-OFF one did', { skip: SKIP }, async () => {
  const ex = await startExecutor('lbm-e2e');
  try {
    const dry = await migrate({ board: sourceBoard, events: sourceEvents, client: ex.client, actor: ACTOR, mode: 'dry-run' });
    assert.equal(dry.refused, null, JSON.stringify(dry));
    assert.ok(dry.planned >= 10, `planned ${dry.planned}`);
    assert.equal(await seqOf(ex.url), 0, 'the dry run wrote nothing');

    const run = await migrate({ board: sourceBoard, events: sourceEvents, client: ex.client, actor: ACTOR, mode: 'run' });
    assert.equal(run.refused, null, JSON.stringify(run, null, 1));
    assert.deepEqual(run.diffs, []);
    assert.deepEqual(run.counts.source, run.counts.target);
    assert.deepEqual(run.counts.source, { memory: 3, version: 4, decision: 4, seat: 3 }, 'what the board holds: 3 memories (one document-born), 4 versions (a retitle mints none), 4 decisions (one document-born), 3 declaration intervals');
    assert.equal(run.written, dry.planned);

    const s0 = await seqOf(ex.url);
    const again = await migrate({ board: sourceBoard, events: sourceEvents, client: ex.client, actor: ACTOR, mode: 'run' });
    assert.equal(again.refused, null, JSON.stringify(again));
    assert.equal(again.written, 0); assert.equal(await seqOf(ex.url), s0, 'a rerun writes nothing');
  } finally { await ex.stop(); }

  // serve the migrated store with the unit ON, on a copy of the same board
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lbm-on-'));
  const boardFile = path.join(dir, 'board.json');
  fs.copyFileSync(sourceBoard, boardFile);
  fs.cpSync(sourceEvents, path.join(dir, 'board-events'), { recursive: true });
  const tok = path.join(dir, 'tokens.json');
  const at = (h) => new Date(Date.now() + h * 3600_000).toISOString();
  fs.writeFileSync(tok, JSON.stringify({ seats: { bob: { credentials: [{ tokenHash: hashToken(TOK.bob), scope: 'admin', issuedAt: at(-1), expiresAt: at(24), issuedBy: 'test', revokedAt: null, note: null }] } } }));
  const on = await startRestServer({ boardFile, env: { SCRUM_GRAPH_EXECUTOR_URL: `http://127.0.0.1:${await freePort()}`, SCRUM_GRAPH_DATASET_ID: 'lbm-e2e', SCRUM_TRIAL_EXECUTOR_STORE: ex.store, GRAPH_EXECUTOR_PYTHON: PY, SCRUM_SEAT_TOKENS: tok, SCRUM_AUTH: 'required', SCRUM_GRAPH_UNIT_LOGBORN: '1' } });
  try {
    for (let i = 0; i < 200; i++) { if ((await api(on.baseUrl, 'GET', '/api/trial/counters')).body.executor) break; await new Promise((r) => setTimeout(r, 50)); }
    const onReads = await reads(on.baseUrl, memIds);
    for (const k of Object.keys(offReads)) assert.deepEqual(onReads[k], offReads[k], k);
    // and the migrated records are writable through the unit (they carry a write revision)
    for (const id of memIds) {
      const r = await api(on.baseUrl, 'PATCH', `/api/memories/${id}`, { bodyAppend: ' (after migration)' });
      assert.equal(r.status, 200, `${id}: ${JSON.stringify(r.body)}`);
    }
    const legacy = (await api(on.baseUrl, 'GET', '/api/memories/00000000-0000-4000-8000-000000001561/versions')).body.versions;
    assert.deepEqual(legacy.map((v) => v.body), ['document text', 'document text (after migration)']);
  } finally { await on.stop(); }
});

test('#1561 MIGRATION verifies BOTH ways: a triple missing from the target, and a triple only the target holds, each fail verification', { skip: SKIP }, async () => {
  const ex = await startExecutor('lbm-tamper');
  try {
    const run = await migrate({ board: sourceBoard, events: sourceEvents, client: ex.client, actor: ACTOR, mode: 'run' });
    assert.equal(run.refused, null, JSON.stringify(run));
    assert.equal((await migrate({ board: sourceBoard, events: sourceEvents, client: ex.client, actor: ACTOR, mode: 'verify' })).refused, null, 'clean before tampering');

    // source → target: the target LOSES a tag
    assert.equal(await rawUpdate(ex.url, `DELETE DATA { <${LEGACY_M}> <https://scrumboard.local/ns#tag> "old" }`), 200);
    const lost = await migrate({ board: sourceBoard, events: sourceEvents, client: ex.client, actor: ACTOR, mode: 'verify' });
    assert.equal(lost.refused, 'verification failed');
    assert.ok(lost.diffs.some((d) => d.startsWith('source→target') && d.includes(LEGACY_M)), lost.diffs.join('\n'));
    assert.ok(lost.diffs.some((d) => d.startsWith('folded memories')), 'and a reader would see it');
    assert.equal(await rawUpdate(ex.url, `INSERT DATA { <${LEGACY_M}> <https://scrumboard.local/ns#tag> "old" }`), 200);
    assert.equal((await migrate({ board: sourceBoard, events: sourceEvents, client: ex.client, actor: ACTOR, mode: 'verify' })).refused, null, 'restored');

    // the identity history, source → target: a revision node LOSES its prior title
    const hist = `${'https://scrumboard.local/memory/'}${memIds[0]}`;
    assert.equal(await rawUpdate(ex.url, `DELETE DATA { <${hist}/revision/1> <https://scrumboard.local/ns#priorName> "one" }`), 200);
    const lostTitle = await migrate({ board: sourceBoard, events: sourceEvents, client: ex.client, actor: ACTOR, mode: 'verify' });
    assert.equal(lostTitle.refused, 'verification failed');
    assert.ok(lostTitle.diffs.some((d) => d.startsWith(`${hist}: identity history differs`)), lostTitle.diffs.join('\n'));
    assert.equal(await rawUpdate(ex.url, `INSERT DATA { <${hist}/revision/1> <https://scrumboard.local/ns#priorName> "one" }`), 200);
    assert.equal((await migrate({ board: sourceBoard, events: sourceEvents, client: ex.client, actor: ACTOR, mode: 'verify' })).refused, null, 'restored');
    // target → source: a revision node of a memory the source does not hold
    assert.equal(await rawUpdate(ex.url, 'INSERT DATA { <urn:x:rev> a <https://scrumboard.local/ns#MemoryRevision> ; <https://scrumboard.local/ns#ofMemory> <https://scrumboard.local/memory/nobody> }'), 200);
    const orphan = await migrate({ board: sourceBoard, events: sourceEvents, client: ex.client, actor: ACTOR, mode: 'verify' });
    assert.ok(orphan.diffs.includes('target→source: revision node urn:x:rev of no memory'), orphan.diffs.join('\n'));
    assert.equal(await rawUpdate(ex.url, 'DELETE DATA { <urn:x:rev> a <https://scrumboard.local/ns#MemoryRevision> ; <https://scrumboard.local/ns#ofMemory> <https://scrumboard.local/memory/nobody> }'), 200);


    // target → source: the target GAINS a constraint on a decision
    assert.equal(await rawUpdate(ex.url, 'INSERT DATA { <https://scrumboard.local/decision/legacy-0001> <https://scrumboard.local/ns#constrains> "smuggled" }'), 200);
    const gained = await migrate({ board: sourceBoard, events: sourceEvents, client: ex.client, actor: ACTOR, mode: 'verify' });
    assert.equal(gained.refused, 'verification failed');
    assert.ok(gained.diffs.some((d) => d.startsWith('target→source') && d.includes('legacy-0001')), gained.diffs.join('\n'));
    assert.ok(!gained.diffs.some((d) => d.startsWith('source→target')), 'only the reverse direction differs');

    // and a whole extra record in the target is a count difference too
    assert.equal(await rawUpdate(ex.url, 'INSERT DATA { <https://scrumboard.local/decision/ghost> a <https://scrumboard.local/ns#Decision> }'), 200);
    const ghost = await migrate({ board: sourceBoard, events: sourceEvents, client: ex.client, actor: ACTOR, mode: 'verify' });
    assert.ok(ghost.diffs.includes('count decision: source 4, target 5'), ghost.diffs.join('\n'));
  } finally { await ex.stop(); }
});

test('#1561 MIGRATION refuses BEFORE writing when the target holds a record the source does not', { skip: SKIP }, async () => {
  const ex = await startExecutor('lbm-prefix');
  try {
    const stray = await ex.client.update({ kind: 'memory.create', opId: 'urn:ex:op/stray', actor: ACTOR,
      memory: { iri: 'https://scrumboard.local/memory/stray', identifier: 'stray', name: 'not in the board', owner: 'https://scrumboard.local/person/bob' }, versions: [] });
    assert.equal(stray.outcome, 'APPLIED');
    const s0 = await seqOf(ex.url);
    const r = await migrate({ board: sourceBoard, events: sourceEvents, client: ex.client, actor: ACTOR, mode: 'run' });
    assert.equal(r.refused, 'the target is not a prefix of the source');
    assert.ok(r.diffs.some((d) => d.includes('memory/stray')), r.diffs.join('\n'));
    assert.equal(r.written, 0); assert.equal(await seqOf(ex.url), s0, 'nothing written');
  } finally { await ex.stop(); }
});

test('#1561 MIGRATION refuses a source the kinds cannot carry faithfully (a version of no memory), before writing', { skip: SKIP }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lbm-bad-'));
  const board = path.join(dir, 'board.json');
  fs.writeFileSync(board, JSON.stringify(makeBoardFixture({ memories: [
    { '@id': 'https://scrumboard.local/memory/orphan/v1', '@type': 'scrum:MemoryVersion', 'scrum:ofMemory': 'https://scrumboard.local/memory/orphan', 'scrum:version': 1, 'scrum:body': 'lost', author: 'bob', dateCreated: '2026-09-01T00:00:00.000Z' },
  ] })));
  const ex = await startExecutor('lbm-bad');
  try {
    const r = await migrate({ board, events: null, client: ex.client, actor: ACTOR, mode: 'run' });
    assert.equal(r.refused, 'the source holds records the kinds cannot carry faithfully');
    assert.ok(r.diffs.some((d) => d.includes('a memory version of no memory')), r.diffs.join('\n'));
    assert.equal(await seqOf(ex.url), 0, 'nothing written');
  } finally { await ex.stop(); }
});

after(() => {});
