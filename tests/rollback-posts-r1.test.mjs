/**
 * ROLLBACK OF THE CONVERSATIONS UNIT: `scripts/rollback-posts-1574.mjs` (#1574, runbook #1605; rubric #1602, a one-way door). Pre-registered by the separate test
 * author BEFORE the script exists. Copy unchanged into tests/. REAL executor, REAL REST servers over one board file, the REAL forward backfill, and the script
 * under test; without a python with pyoxigraph every test is SKIPPED, and a skip is NOT a pass. Synthetic content only.
 *
 * THE INTERFACE (mirrors the forward backfill; the builder is asked to confirm or amend it before building, and the rows follow whatever is agreed):
 *     node scripts/rollback-posts-1574.mjs --board-file <board.json> --executor-url <url> --dataset-id <id> [--dry-run]
 * It operates on a STOPPED board's file (its REST server is down), reads the graph, and rewrites the document so that the unit OFF serves what the unit ON served.
 * Exit 0 on success; non-zero, with the board file untouched, on any refusal. The summary line is not pinned beyond what the rows below read.
 *
 * WHY: with the unit on, a new post is written ONLY to the graph. Turning the flag off puts the document back in charge, and measured on 607a845 (a probe, this
 * seat, 20:49Z) the flag-off server then serves: the post written under the unit is GONE, and a post that had been imported and redacted in the graph shows its
 * PLAIN TEXT again, in the list and by id, because the document never stopped holding it. A rollback that only copies graph-only posts in would therefore be a
 * redaction-undo. The contract owner's ruling (20:49Z): reconcile by IDENTITY, and a graph tombstone removes the stale document text too.
 *
 * THE WORLD (built for every row): written with the unit OFF, a visible post O1 (attached to a card) and a post R, both in the document; both imported into the
 * graph by the REAL forward backfill; R then redacted in the graph. With the unit ON over the same document: two graph-only posts G1 (attached to the card) and
 * G2, and a third graph-only post G3 that is then redacted. The unit-ON answers are recorded: visible = O1, G1, G2.
 *
 *   RB1 PARITY, AND NO RESURRECTION  after the script, a unit-OFF server over the document serves exactly the unit-ON list (same posts, order, X-Total-Count,
 *        and the same id/body/author/createdAt/attachedTo/postSeq of each), and the text of R and of G3 is nowhere: not in the list, not opening R by id, not
 *        opening G3 by id, not in the card's comments, not in a search for their words.
 *   RB2 NUMBERING  the next post written under the flag-off server has a postSeq greater than EVERY post the graph held, tombstones included (reusing a
 *        redacted post's number would collide with the graph on a re-flip), and an id nobody else has; it is the last post of the list.
 *   RB3 IDEMPOTENT AND RE-FLIP SAFE  a second run changes nothing (the board file is byte-identical to after the first), and the forward backfill run afterwards
 *        into the SAME graph reports 0 written and 0 conflicts: the exported posts kept their identity, so a re-flip duplicates nothing and conflicts with nothing.
 *   RB4 DRY RUN AND REFUSALS WRITE NOTHING  `--dry-run` exits 0 and leaves the board file byte-identical; a WRONG dataset id and an UNREACHABLE executor each exit
 *        non-zero and leave the board file byte-identical.
 *
 * NOT COVERED, by name: freezing writes through the transition, the consistent graph backup, and the MCP/receiver restart and reconnect (operational steps of
 * #1605, rehearsed on the copy, not script behaviour); seat badge cursors minted under the unit when presented to the flag-off server (a seat-visible effect of
 * a rollback, unread: named for the rehearsal); attachment bytes and talk-tagged posts in the export; resident wake behaviour after a rollback; a graph that
 * holds posts the document's counter has never seen beyond the numbering row; the event log (the exported posts are not given log rows here).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { makeBoardFixture, startRestServer, PROJECT_DIR } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';
import { createGraphClient } from '../core/graph-client.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const DSID = 'rbk-test';
const PERSON = 'https://scrumboard.local/person/';
const EPOCH_DOC = '11111111-2222-4333-8444-555555555555';
const ROLLBACK = path.join(PROJECT_DIR, 'scripts', 'rollback-posts-1574.mjs');
const BACKFILL = path.join(PROJECT_DIR, 'scripts', 'backfill-posts-r0.mjs');
const R_TXT = 'rbk-secret-document text of R';
const G3_TXT = 'rbk-secret-graph text of G3';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

const ROSTER_FILE = path.join(os.tmpdir(), `rbk-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: {
  ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, bea: { name: 'Bea', glyph: 'b', color: '#c48ab0' },
  board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));

const api = async (base, method, route, body) => {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text, total: res.headers.get('x-total-count') };
};
const client = (exec) => createGraphClient({ baseUrl: exec.baseUrl, expectedDatasetId: DSID });
const redact = async (exec, id) => { const r = await client(exec).update({ kind: 'post.redact', opId: `urn:ex:op/redact/${id}`, actor: `${PERSON}ada`, post: { id }, authorityRef: 'test-authority-ref', occurredAt: new Date().toISOString() }); assert.equal(r.outcome, 'APPLIED', JSON.stringify(r)); };
function run(script, args, { timeoutMs = 90000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: PROJECT_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); let summary = null; for (const l of out.split('\n').reverse()) { const t = l.trim(); if (t.startsWith('{')) { try { summary = JSON.parse(t); break; } catch { /* not json */ } } } resolve({ code, out, err, summary }); });
  });
}
const rollback = (w, extra = [], dataset = DSID, url = null) => run(ROLLBACK, ['--board-file', w.boardFile, '--executor-url', url ?? w.exec.baseUrl, '--dataset-id', dataset, ...extra]);
const norm = (c) => ({ id: c.id, body: c.body, author: c.author, createdAt: c.createdAt, attachedTo: c.attachedTo ?? null, postSeq: c.postSeq });

/** Builds the world and returns it with the executor still up and every server stopped (data left on disk). */
async function world() {
  const off1 = await startRestServer({ board: makeBoardFixture({ conversations: [], postSeqEpoch: EPOCH_DOC, nextPostSeq: 1 }), env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
  const c = await api(off1.baseUrl, 'POST', '/api/cards', { title: 'rollback card', description: 'x', createdBy: 'ada' }); assert.ok(c.status === 200 || c.status === 201, c.text);
  const o1 = await api(off1.baseUrl, 'POST', '/api/conversations', { author: 'bea', body: 'rbk visible old post O1', attachedTo: c.body.id }); assert.equal(o1.status, 201, o1.text); await sleep(15);
  const r = await api(off1.baseUrl, 'POST', '/api/conversations', { author: 'ada', body: R_TXT }); assert.equal(r.status, 201, r.text);
  const boardFile = off1.boardFile; off1.kill(); await sleep(400);
  const exec = await startExecutor({ store: tmpStore('rbk-store-'), datasetId: DSID, create: true });
  const fwd = await run(BACKFILL, ['--board-file', boardFile, '--executor-url', exec.baseUrl, '--dataset-id', DSID]);
  assert.equal(fwd.code, 0, `the forward backfill imports O1 and R: ${fwd.out}${fwd.err}`);
  await redact(exec, r.body.id);
  const on = await startRestServer({ boardFile, env: { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: DSID, SCRUM_GRAPH_EXECUTOR_URL: exec.baseUrl, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1' } });
  const g1 = await api(on.baseUrl, 'POST', '/api/conversations', { author: 'bea', body: 'rbk graph post G1', attachedTo: c.body.id }); assert.equal(g1.status, 201, g1.text); await sleep(15);
  const g2 = await api(on.baseUrl, 'POST', '/api/conversations', { author: 'ada', body: 'rbk graph post G2' }); assert.equal(g2.status, 201, g2.text); await sleep(15);
  const g3 = await api(on.baseUrl, 'POST', '/api/conversations', { author: 'bea', body: G3_TXT }); assert.equal(g3.status, 201, g3.text);
  await redact(exec, g3.body.id);
  const onList = await api(on.baseUrl, 'GET', '/api/conversations');
  assert.equal(onList.status, 200, onList.text);
  assert.deepEqual(onList.body.map((x) => x.id), [o1.body.id, g1.body.id, g2.body.id], 'CONTROL: the unit-ON list is O1, G1, G2 (R and G3 are tombstoned and hidden)');
  assert.ok(!onList.text.includes('rbk-secret'), 'CONTROL: and carries no word of either secret');
  on.kill(); await sleep(400);
  return { boardFile, exec, cardId: c.body.id, ids: { o1: o1.body.id, r: r.body.id, g1: g1.body.id, g2: g2.body.id, g3: g3.body.id }, seqs: [o1, r, g1, g2, g3].map((x) => x.body.postSeq), onList };
}
const offServer = (w) => startRestServer({ boardFile: w.boardFile, env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
async function withWorld(body) { const w = await world(); try { return await body(w); } finally { await killExecutor(w.exec); } }

test('RB1 PARITY, AND NO RESURRECTION: after the rollback the flag-off server serves exactly the unit-ON list, and neither redacted post\'s text appears anywhere', { skip: SKIP }, async () => {
  await withWorld(async (w) => {
    const res = await rollback(w);
    assert.equal(res.code, 0, `the rollback exits 0: ${res.out}${res.err}`);
    const off = await offServer(w);
    try {
      const list = await api(off.baseUrl, 'GET', '/api/conversations');
      assert.equal(list.status, 200, list.text);
      assert.deepEqual(list.body.map(norm), w.onList.body.map(norm), 'the same posts, in the same order, with the same fields');
      assert.equal(list.total, w.onList.total, 'and the same X-Total-Count');
      const witnesses = {
        list: list.text,
        openR: (await api(off.baseUrl, 'GET', `/api/conversations/${w.ids.r}`)).text,
        openG3: (await api(off.baseUrl, 'GET', `/api/conversations/${w.ids.g3}`)).text,
        card: (await api(off.baseUrl, 'GET', `/api/cards/${w.cardId}`)).text,
        search: (await api(off.baseUrl, 'POST', '/api/search/all', { q: 'document graph text', k: 10 })).text.replace(/"q":"[^"]*",?/, ''),
      };
      for (const [k, t] of Object.entries(witnesses)) assert.ok(!/rbk-secret/.test(t), `${k}: no word of a redacted post survives the rollback: ${t.slice(0, 200)}`);
    } finally { await off.stop(); }
  });
});

test('RB2 NUMBERING: the next post under the flag-off server has a postSeq above EVERY post the graph held (tombstones included), a fresh id, and is last in the list', { skip: SKIP }, async () => {
  await withWorld(async (w) => {
    const res = await rollback(w); assert.equal(res.code, 0, `${res.out}${res.err}`);
    const off = await offServer(w);
    try {
      const n = await api(off.baseUrl, 'POST', '/api/conversations', { author: 'ada', body: 'rbk first post after the rollback' });
      assert.equal(n.status, 201, n.text);
      assert.ok(n.body.postSeq > Math.max(...w.seqs), `postSeq ${n.body.postSeq} is above every graph post's (${JSON.stringify(w.seqs)}), the redacted ones included`);
      assert.ok(!Object.values(w.ids).includes(n.body.id), 'a fresh id');
      const list = await api(off.baseUrl, 'GET', '/api/conversations');
      assert.equal(list.body.at(-1).id, n.body.id, 'and it is the last post of the list');
    } finally { await off.stop(); }
  });
});

test('RB3 IDEMPOTENT AND RE-FLIP SAFE: a second run leaves the board file byte-identical, and the forward backfill afterwards reports 0 written and 0 conflicts into the same graph', { skip: SKIP }, async () => {
  await withWorld(async (w) => {
    const first = await rollback(w); assert.equal(first.code, 0, `${first.out}${first.err}`);
    const afterFirst = sha(w.boardFile);
    const second = await rollback(w);
    assert.equal(second.code, 0, `a second run exits 0: ${second.out}${second.err}`);
    assert.equal(sha(w.boardFile), afterFirst, 'and changes nothing');
    const fwd = await run(BACKFILL, ['--board-file', w.boardFile, '--executor-url', w.exec.baseUrl, '--dataset-id', DSID]);
    assert.equal(fwd.code, 0, `the forward backfill over the rolled-back document exits 0 (no conflicts): ${fwd.out}${fwd.err}`);
    assert.ok(fwd.summary, `it prints its summary: ${fwd.out}`);
    assert.equal(fwd.summary.written, 0, `0 written: the exported posts kept their identity (${JSON.stringify(fwd.summary)})`);
    const conflicts = Array.isArray(fwd.summary.conflicts) ? fwd.summary.conflicts.length : Number(fwd.summary.conflicts);
    assert.equal(conflicts, 0, `0 conflicts (${JSON.stringify(fwd.summary)})`);
  });
});

test('RB4 DRY RUN AND REFUSALS WRITE NOTHING: --dry-run exits 0, a wrong dataset id and an unreachable executor exit non-zero, and the board file is byte-identical after each', { skip: SKIP }, async () => {
  await withWorld(async (w) => {
    const before = sha(w.boardFile);
    const dry = await rollback(w, ['--dry-run']);
    assert.equal(dry.code, 0, `--dry-run exits 0: ${dry.out}${dry.err}`);
    assert.equal(sha(w.boardFile), before, 'and writes nothing');
    const wrong = await rollback(w, [], 'not-the-dataset');
    assert.notEqual(wrong.code, 0, 'a wrong dataset id is refused');
    assert.equal(sha(w.boardFile), before, 'and writes nothing');
    const dead = await rollback(w, [], DSID, 'http://127.0.0.1:9');
    assert.notEqual(dead.code, 0, 'an unreachable executor is refused');
    assert.equal(sha(w.boardFile), before, 'and writes nothing');
    const real = await rollback(w);
    assert.equal(real.code, 0, `CONTROL: the same invocation without the fault succeeds (so the refusals above were the faults): ${real.out}${real.err}`);
    assert.notEqual(sha(w.boardFile), before, 'CONTROL: and it does change the document');
  });
});
