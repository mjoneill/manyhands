/**
 * ROLLBACK, ADDENDUM RB5: EVERYTHING BUT POSTS IS UNTOUCHED (#1574, runbook #1605; rubric #1602, a one-way door). Written by the separate test author AFTER reading
 * the built script at 059e1c6, which the four frozen rows (rollback-posts-r1.test.mjs, sha256 923bd54a…) do not cover: `scripts/rollback-posts-1574.mjs` does not edit
 * the posts in place, it LOADS THE WHOLE BOARD DOCUMENT, converts it to the board shape and back (`loadDomain` → `domainToBoard` → `boardToDomain` → `saveDomain`)
 * and WRITES THE FILE. The frozen rows read only posts, so a conversion that drops or alters anything else (a card field, an agent, a role, a seat declaration,
 * the counters and reservations) would pass all four and silently damage the live document, on the one operation that edits it irreversibly. The backup is the floor;
 * this row is the check that the floor is not needed for anything but posts.
 *
 * REAL executor, REAL REST servers over one board file, the REAL forward backfill, and the script; without a python with pyoxigraph the row is SKIPPED, and a skip is
 * NOT a pass. Synthetic content only.
 *
 * THE WORLD: the frozen file's world (O1 and R imported by the real backfill, R redacted in the graph; with the unit on, G1, G2 and G3, G3 redacted), plus
 * non-post content written through the API: two cards (one with a description, labels and a relationship), an agent, a role and a seat declaration holding it.
 *
 *   RB5a THE DOCUMENT, FILE LEVEL  after the script, every entry of the board file that is not a post is deep-equal to what it was before, and so is the `scrum:meta` block
 *        except the one value the script is meant to change (`nextPostSeq`, which only rises). Posts are compared by the frozen rows, not here.
 *   RB5b THE SERVER, ROUTE LEVEL  a flag-off server over the board file answers, before the script and after it, the SAME cards list, agents list, roles list and seat
 *        states. (The posts routes differ by design: that is what the script is for.) The `before` copy is the WHOLE board directory, not the lone file: seat
 *        declarations and other derived state are served from siblings of the board file.
 *   RB5c A DOCUMENT-ONLY POST IS KEPT  a post that only the document ever held (written after the backfill, before the flag: the script's promise is "kept as it is")
 *        is still there after the script, byte-identical in the list's fields, and still last in order of number.
 *   RB5e A LAGGING COUNTER IS RAISED: the unit-ON server already keeps the document's counter above every graph post, so in the ordinary flow the script's raise has nothing to
 *        do (found by mutation: two mutants of the raise survived RB2). It matters when the document is OLDER than the graph, as after a restore of the pre-flip backup: the counter is
 *        lowered below the graph's posts, the script runs, and the next post under the flag-off server has a postSeq above EVERY graph post, a tombstoned one included.
 *   RB5d THE AUTHOR-REPAIR TRAIL SURVIVES  an imported post that carries the three U5 fields (decision f4940204) still carries them in the document after the script, and
 *        the forward backfill afterwards reports it alreadyPresent (so a re-flip does not see a conflict). This discharges the U5e todo of backfill-posts-r0-u5.test.mjs.
 *
 * NOT COVERED, by name: decisions, memories, procedures, runs and obligations (not created here; a document written by the live board holds them, and the file-level
 * row compares every non-post entry it finds, so it covers them if present, but the world does not create them); the byte order of the file (compared as parsed
 * structure, not text); attachments on disk.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { makeBoardFixture, startRestServer, PROJECT_DIR } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';
import { createGraphClient } from '../core/graph-client.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const DSID = 'rb5-test';
const PERSON = 'https://scrumboard.local/person/';
const EPOCH_DOC = '11111111-2222-4333-8444-555555555555';
const ROLLBACK = path.join(PROJECT_DIR, 'scripts', 'rollback-posts-1574.mjs');
const BACKFILL = path.join(PROJECT_DIR, 'scripts', 'backfill-posts-r0.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ROSTER_FILE = path.join(os.tmpdir(), `rb5-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: {
  ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, bea: { name: 'Bea', glyph: 'b', color: '#c48ab0' },
  board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));

const api = async (base, method, route, body) => {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text };
};
const client = (exec) => createGraphClient({ baseUrl: exec.baseUrl, expectedDatasetId: DSID });
const redact = async (exec, id) => { const r = await client(exec).update({ kind: 'post.redact', opId: `urn:ex:op/redact/${id}`, actor: `${PERSON}ada`, post: { id }, authorityRef: 'test-authority-ref', occurredAt: new Date().toISOString() }); assert.equal(r.outcome, 'APPLIED', JSON.stringify(r)); };
function run(script, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: PROJECT_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 90000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

/** The frozen world plus non-post content. Executor left up; every server stopped (data on disk). */
async function world({ docOnly = false, trail = false } = {}) {
  const off1 = await startRestServer({ board: makeBoardFixture({ conversations: [], postSeqEpoch: EPOCH_DOC, nextPostSeq: 1 }), env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
  const b = off1.baseUrl;
  const c1 = await api(b, 'POST', '/api/cards', { title: 'fidelity card one', description: 'A description with detail.\n\nSecond paragraph.', labels: ['alpha', 'beta'], priority: 'p2', createdBy: 'ada' }); assert.ok(c1.status === 200 || c1.status === 201, c1.text);
  const c2 = await api(b, 'POST', '/api/cards', { title: 'fidelity card two', description: 'x', createdBy: 'bea' }); assert.ok(c2.status === 200 || c2.status === 201, c2.text);
  const rel = await api(b, 'PATCH', `/api/cards/${c1.body.id}`, { relationshipsAdd: { relatedTo: [c2.body.shortId] }, by: 'ada' }); assert.ok(rel.status === 200, rel.text);
  const role = await api(b, 'POST', '/api/roles', { by: 'ada', key: 'scrum-master', name: 'Scrum Master', definition: 'Establishes Scrum here and holds the cadence; asks, never asserts.', definedBy: c1.body.shortId }); assert.ok(role.status === 200 || role.status === 201, role.text);
  const decl = await api(b, 'PUT', '/api/seats/ada/state', { mode: 'available', acceptsRoutineWork: true, role: 'scrum-master', expiresAt: new Date(Date.now() + 5 * 3600e3).toISOString() }); assert.equal(decl.status, 200, decl.text);
  const agent = await api(b, 'POST', '/api/agents', { seatKey: 'gizmo', prompt: 'Be brief.', model: { model: 'fake', protocol: 'ollama-native', baseUrl: 'http://127.0.0.1:9' }, residency: 'guest', contextPolicy: 'artifact-only', by: 'ada' }); assert.equal(agent.status, 201, agent.text);
  const o1 = await api(b, 'POST', '/api/conversations', { author: 'bea', body: 'rb5 visible old post', attachedTo: c1.body.id }); assert.equal(o1.status, 201, o1.text); await sleep(15);
  const r = await api(b, 'POST', '/api/conversations', { author: 'ada', body: 'rb5-secret-document text' }); assert.equal(r.status, 201, r.text);
  const boardFile = off1.boardFile; off1.kill(); await sleep(400);
  let trailId = null;
  if (trail) {
    // the repair trail is not writable through the API (it is old data): put it on the document's post the way the live document holds it, as the post node's `_extra`
    const doc = readDoc(boardFile); const node = doc['@graph'].find((e) => e && /Comment/.test(JSON.stringify(e['@type'])) && JSON.stringify(e).includes(o1.body.id));
    assert.ok(node, 'CONTROL: found the post node to carry the trail');
    node._extra = { ...(node._extra || {}), _originalAuthorToken: 'rb5tok">rb5tok', _authorCorrectedAt: '2026-07-31T21:10:00Z', _authorCorrectedBy: 'bea' };
    fs.writeFileSync(boardFile, JSON.stringify(doc, null, 2)); trailId = o1.body.id;
  }
  const exec = await startExecutor({ store: tmpStore('rb5-store-'), datasetId: DSID, create: true });
  const fwd = await run(BACKFILL, ['--board-file', boardFile, '--executor-url', exec.baseUrl, '--dataset-id', DSID]);
  assert.equal(fwd.code, 0, `the forward backfill: ${fwd.out}${fwd.err}`);
  await redact(exec, r.body.id);
  let docOnlyId = null;
  if (docOnly) {
    // a post only the DOCUMENT holds: written by a unit-OFF server after the backfill
    const offAgain = await startRestServer({ boardFile, env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
    const d = await api(offAgain.baseUrl, 'POST', '/api/conversations', { author: 'ada', body: 'rb5 document-only post D1' }); assert.equal(d.status, 201, d.text);
    docOnlyId = d.body.id; offAgain.kill(); await sleep(400);
  }
  const on = await startRestServer({ boardFile, env: { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: DSID, SCRUM_GRAPH_EXECUTOR_URL: exec.baseUrl, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1' } });
  const g1 = await api(on.baseUrl, 'POST', '/api/conversations', { author: 'bea', body: 'rb5 graph post G1', attachedTo: c1.body.id }); assert.equal(g1.status, 201, g1.text); await sleep(15);
  const g3 = await api(on.baseUrl, 'POST', '/api/conversations', { author: 'bea', body: 'rb5-secret-graph text' }); assert.equal(g3.status, 201, g3.text);
  await redact(exec, g3.body.id);
  on.kill(); await sleep(400);
  return { boardFile, exec, docOnlyId, trailId, seqs: [o1, r, g1, g3].map((x) => x.body.postSeq) };
}
const readDoc = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
/** every non-post entry of the board file, keyed, and the meta block minus the one value the script changes */
function nonPost(doc) {
  const graph = Array.isArray(doc['@graph']) ? doc['@graph'] : null;
  assert.ok(graph, `the board file is the JSON-LD shape (an @graph): ${Object.keys(doc).join(',')}`);
  const isPost = (e) => e && (e['@type'] === 'Comment' || (Array.isArray(e['@type']) && e['@type'].includes('Comment')));
  const entries = {}; for (const e of graph) if (!isPost(e)) entries[e['@id'] ?? JSON.stringify(e)] = e;
  const { ['scrum:meta']: meta = {}, ...top } = doc; delete top['@graph'];
  const m = { ...meta }; delete m.nextPostSeq; delete m.lastUpdated;   // the script stamps the document's own modification time: expected, not loss
  return { entries, meta: m, top: Object.fromEntries(Object.entries(top).filter(([k]) => !/lastUpdated|dateModified/i.test(k))) };
}
const diffKeys = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
async function routes(base) {
  // a freshly started server answers `unknown` for a seat until its graph replica has synced: wait (bounded) for the declaration to appear, so the comparison is of
  // settled states, and a declaration the rollback had really dropped would never appear and would still fail
  const t0 = Date.now();
  for (;;) { const s0 = await api(base, 'GET', '/api/seats/state'); const ada = (s0.body?.seats || []).find((x) => x.seat === 'ada'); if ((ada && ada.mode && ada.mode !== 'unknown') || Date.now() - t0 > 12000) break; await sleep(300); }
  const out = {};
  for (const [k, r] of [['cards', '/api/cards'], ['agents', '/api/agents'], ['roles', '/api/roles'], ['seats', '/api/seats/state'], ['columns', '/api/columns']]) {
    const x = await api(base, 'GET', r); out[k] = { status: x.status, body: x.body };
  }
  // seat states carry a clock-derived field in some builds: only the declarations are compared
  if (Array.isArray(out.seats.body?.seats)) out.seats.body = out.seats.body.seats.map((s) => ({ seat: s.seat, role: s.role ?? null, mode: s.mode ?? null, expiresAt: s.expiresAt ?? null }));
  return out;
}

test('RB5a THE DOCUMENT, FILE LEVEL: after the script every non-post entry of the board file and the meta block (except nextPostSeq) are deep-equal to before', { skip: SKIP }, async () => {
  const w = await world();
  try {
    const before = nonPost(readDoc(w.boardFile));
    assert.ok(Object.keys(before.entries).length >= 6, `CONTROL: the document holds non-post entries to lose (${Object.keys(before.entries).length})`);
    const res = await run(ROLLBACK, ['--board-file', w.boardFile, '--executor-url', w.exec.baseUrl, '--dataset-id', DSID]);
    assert.equal(res.code, 0, `${res.out}${res.err}`);
    const after = nonPost(readDoc(w.boardFile));
    assert.deepEqual(diffKeys(before.entries, after.entries), [], 'no non-post entry was added, dropped or altered');
    assert.deepEqual(diffKeys(before.meta, after.meta), [], 'the meta block is unchanged except nextPostSeq');
    assert.deepEqual(diffKeys(before.top, after.top), [], 'and so is every other top-level key');
  } finally { await killExecutor(w.exec); }
});

test('RB5b THE SERVER, ROUTE LEVEL: a flag-off server over the board file answers the same cards, agents, roles, seat declarations and columns before the script and after it', { skip: SKIP }, async () => {
  const w = await world();
  try {
    // the WHOLE board directory is copied, not just the file: seat declarations and other derived state are served from siblings of the board file (the event log), which a lone copy would not carry
    const copyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb5-copy-')); fs.cpSync(path.dirname(w.boardFile), copyDir, { recursive: true });
    const copy = path.join(copyDir, path.basename(w.boardFile));
    const s1 = await startRestServer({ boardFile: copy, env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
    let before; try { before = await routes(s1.baseUrl); } finally { await s1.stop(); }
    assert.equal(before.cards.status, 200, 'CONTROL: the routes answer');
    assert.ok((before.cards.body?.cards ?? before.cards.body ?? []).length >= 2, 'CONTROL: the two cards are there');
    const res = await run(ROLLBACK, ['--board-file', w.boardFile, '--executor-url', w.exec.baseUrl, '--dataset-id', DSID]);
    assert.equal(res.code, 0, `${res.out}${res.err}`);
    const s2 = await startRestServer({ boardFile: w.boardFile, env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
    let after; try { after = await routes(s2.baseUrl); } finally { await s2.stop(); }
    for (const k of Object.keys(before)) assert.deepEqual(after[k], before[k], `${k} is the same after the rollback`);
  } finally { await killExecutor(w.exec); }
});

const norm = (c) => ({ id: c.id, body: c.body, author: c.author, createdAt: c.createdAt, attachedTo: c.attachedTo ?? null, postSeq: c.postSeq });

test('RB5c A DOCUMENT-ONLY POST IS KEPT: a post only the document held is still in the flag-off list after the script, with the same fields, and the list equals the unit-ON list', { skip: SKIP }, async () => {
  const w = await world({ docOnly: true });
  try {
    // the unit-ON list, from a server over a COPY of the whole directory (the document-only post is in it: R1 merges the document's posts with the graph's)
    const copyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb5c-copy-')); fs.cpSync(path.dirname(w.boardFile), copyDir, { recursive: true });
    const on = await startRestServer({ boardFile: path.join(copyDir, path.basename(w.boardFile)), env: { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: DSID, SCRUM_GRAPH_EXECUTOR_URL: w.exec.baseUrl, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1' } });
    let onList; try { onList = await api(on.baseUrl, 'GET', '/api/conversations'); } finally { await on.stop(); }
    assert.ok(onList.body.some((c) => c.id === w.docOnlyId), 'CONTROL: the unit-ON list holds the document-only post');
    const res = await run(ROLLBACK, ['--board-file', w.boardFile, '--executor-url', w.exec.baseUrl, '--dataset-id', DSID]);
    assert.equal(res.code, 0, `${res.out}${res.err}`);
    const off = await startRestServer({ boardFile: w.boardFile, env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
    try {
      const list = await api(off.baseUrl, 'GET', '/api/conversations');
      assert.ok(list.body.some((c) => c.id === w.docOnlyId), `the document-only post is still there: ${list.body.map((c) => c.id)}`);
      assert.deepEqual(list.body.map(norm), onList.body.map(norm), 'and the flag-off list equals the unit-ON list');
    } finally { await off.stop(); }
  } finally { await killExecutor(w.exec); }
});

test('RB5d THE AUTHOR-REPAIR TRAIL SURVIVES: an imported post carrying the three U5 fields still carries them in the document after the script, and the forward backfill then reports it alreadyPresent', { skip: SKIP }, async () => {
  const w = await world({ trail: true });
  try {
    const trailOf = (doc) => { const n = doc['@graph'].find((e) => e && /Comment/.test(JSON.stringify(e['@type'])) && JSON.stringify(e).includes(w.trailId)); return n ? JSON.stringify(n._extra ?? null) : 'NO NODE'; };
    const before = trailOf(readDoc(w.boardFile));
    assert.match(before, /rb5tok/, 'CONTROL: the document post carries the trail before the script');
    const res = await run(ROLLBACK, ['--board-file', w.boardFile, '--executor-url', w.exec.baseUrl, '--dataset-id', DSID]);
    assert.equal(res.code, 0, `${res.out}${res.err}`);
    assert.equal(trailOf(readDoc(w.boardFile)), before, 'the three fields are exactly as they were');
    const fwd = await run(BACKFILL, ['--board-file', w.boardFile, '--executor-url', w.exec.baseUrl, '--dataset-id', DSID]);
    assert.equal(fwd.code, 0, `the forward backfill afterwards: ${fwd.out}${fwd.err}`);
    const sum = JSON.parse(fwd.out.trim().split('\n').filter((l) => l.trim().startsWith('{')).at(-1));
    assert.equal(sum.written, 0, `0 written: ${JSON.stringify(sum)}`);
    assert.equal(Array.isArray(sum.conflicts) ? sum.conflicts.length : sum.conflicts, 0, `0 conflicts: ${JSON.stringify(sum)}`);
  } finally { await killExecutor(w.exec); }
});

test('RB5e A LAGGING COUNTER IS RAISED: with the document\'s counter lowered below the graph (an older document), the next post after the script has a postSeq above every graph post, a tombstoned one included', { skip: SKIP }, async () => {
  const w = await world();
  try {
    const doc = readDoc(w.boardFile);
    const lowered = 2;
    assert.ok(Math.max(...w.seqs) > lowered, 'CONTROL: the graph holds posts numbered above the lowered counter');
    if (Array.isArray(doc['@graph'])) (doc['scrum:meta'] ||= {}).nextPostSeq = lowered; else doc.nextPostSeq = lowered;
    fs.writeFileSync(w.boardFile, JSON.stringify(doc, null, 2));
    const res = await run(ROLLBACK, ['--board-file', w.boardFile, '--executor-url', w.exec.baseUrl, '--dataset-id', DSID]);
    assert.equal(res.code, 0, `${res.out}${res.err}`);
    const off = await startRestServer({ boardFile: w.boardFile, env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
    try {
      const n = await api(off.baseUrl, 'POST', '/api/conversations', { author: 'ada', body: 'rb5 first post after a lagging-counter rollback' });
      assert.equal(n.status, 201, n.text);
      assert.ok(n.body.postSeq > Math.max(...w.seqs), `postSeq ${n.body.postSeq} is above every graph post's (${JSON.stringify(w.seqs)}), the redacted last one included`);
    } finally { await off.stop(); }
  } finally { await killExecutor(w.exec); }
});
