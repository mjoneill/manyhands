/**
 * THE BOARD-FILE GUARD (#1574, runbook #1605; rubric #1602, a one-way door): `scripts/backfill-posts-r0.mjs` AND `scripts/rollback-posts-1574.mjs` MUST REFUSE A BOARD FILE
 * THEY CANNOT READ, and must not invent one. Pre-registered by the separate test author BEFORE the guard exists, from the builder's finding at 21:19Z: both scripts read
 * the board through `loadDomain`, whose default for a MISSING file is an EMPTY board. Seen in the builder's first rehearsal attempt (void, a driver fault that deleted the
 * copy): the backfill "completed" with 0 posts and exit 0, and the rollback, run on the same missing file, exited 1 having read an empty board. The consequence that
 * nothing catches is the rollback's: given a missing path it would reconcile an EMPTY document against the graph and WRITE A FRESH BOARD holding only the graph's posts,
 * at the path it was handed, with exit 0. (A backfill "completing" with 0 is caught later by the runbook's count check; a rollback is caught by nothing.) The same holds for
 * a file that exists but is not a board: a truncated write, a zero-byte file, a half-copied one.
 *
 * REAL executor (a python with pyoxigraph), the REAL scripts; without a python every test is SKIPPED, and a skip is NOT a pass. Synthetic content only.
 *
 *   G1 A MISSING FILE: each script exits NON-ZERO, names the path it was given, and CREATES NO FILE there. The backfill leaves the graph without a post; the rollback is
 *      run against a graph that HOLDS posts (so "it wrote a fresh board of the graph's posts" is exactly what would have happened).
 *   G2 A FILE THAT IS NOT A BOARD (not JSON, or truncated JSON): each script exits non-zero, names the path, and leaves the file's bytes untouched; the backfill writes
 *      nothing to the graph.
 *   G3 A ZERO-BYTE FILE: the same, and it stays zero bytes.
 *   G4 CONTROL: the same two invocations on a VALID board file exit 0, so the refusals above were about the file and not about the executor, the dataset or the flags.
 *   G5 VALID JSON IS NOT A BOARD (the contract owner's pin, 21:22Z): a file that parses but is not a board (`{}`, `[]`, `null`, a number, a string, an object of unrelated keys, an object with board-ish keys but neither `@graph` nor `cards`, the roots the builder's guard recognises) is refused
 *      by both scripts exactly like G2: non-zero, the path named, the bytes untouched, the graph untouched. Otherwise `{}` would walk into the very empty-board default
 *      this file exists to close.
 *   G6 A GENUINELY EMPTY BOARD IS NOT REFUSED: the guard must not reject a real board that happens to hold nothing. Two shapes: the legacy fixture with its migration epoch and counter
 *      and no posts, and the JSON-LD file a real server writes for a board with no posts. Both scripts exit 0 on each (the backfill reports 0 posts; the rollback against an
 *      EMPTY graph leaves the file byte-identical).
 *
 * NOT COVERED, by name: a path that is a directory or a file the process cannot read for permission (ordinary read-error handling, agreed: no filesystem-error matrix); the
 * builder's exact definition of the recognised board root (the rows pin the examples above, accepted and refused, not the rule); a board with posts but a corrupt interior.
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
const DSID = 'g1-test';
const PERSON = 'https://scrumboard.local/person/';
const SCHEMA = 'https://schema.org/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const EPOCH_DOC = '11111111-2222-4333-8444-555555555555';
const ROLLBACK = path.join(PROJECT_DIR, 'scripts', 'rollback-posts-1574.mjs');
const BACKFILL = path.join(PROJECT_DIR, 'scripts', 'backfill-posts-r0.mjs');

const POSTS = [1, 2].map((i) => ({ id: `g1-post-${i}`, body: `guard post ${i}`, author: 'ada', attachedTo: null, attachments: [], mentions: [], postSeq: i, createdAt: new Date(Date.UTC(2026, 9, 1, 12, 0, i)).toISOString() }));
const client = (exec) => createGraphClient({ baseUrl: exec.baseUrl, expectedDatasetId: DSID });
const commentIds = async (exec) => { const r = await client(exec).query(`SELECT ?s WHERE { ?s <${RDF_TYPE}> <${SCHEMA}Comment> }`); assert.equal(r.ok, true, JSON.stringify(r)); return r.rows.map((b) => b.s.value).sort(); };
const importPosts = async (exec) => { for (const p of POSTS) { const r = await client(exec).update({ kind: 'post.import', opId: `urn:ex:op/backfill/${p.id}`, actor: `${PERSON}board`, post: { id: p.id, body: p.body, author: p.author, createdAt: p.createdAt, attachedTo: null, mentions: [], postSeq: p.postSeq } }); assert.equal(r.outcome, 'APPLIED', JSON.stringify(r)); } };
const validBoard = () => makeBoardFixture({ conversations: POSTS, postSeqEpoch: EPOCH_DOC, nextPostSeq: 3 });
function run(script, file, exec) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, '--board-file', file, '--executor-url', exec.baseUrl, '--dataset-id', DSID], { cwd: PROJECT_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 60000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, said: `${out}\n${err}` }); });
  });
}
async function withExec(body) {
  const exec = await startExecutor({ store: tmpStore('g1-store-'), datasetId: DSID, create: true });
  try { return await body(exec); } finally { await killExecutor(exec); }
}
const tmpFile = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'g1-')), name);

test('G1 A MISSING BOARD FILE IS REFUSED, NOT READ AS AN EMPTY BOARD: both scripts exit non-zero, name the path, and create no file there; the backfill adds no post to the graph', { skip: SKIP }, async () => {
  await withExec(async (exec) => {
    await importPosts(exec);   // the graph HOLDS posts: a rollback that read an empty board would write them into a fresh document
    const before = await commentIds(exec);
    const missing = tmpFile('does-not-exist.json');
    for (const [name, script] of [['rollback', ROLLBACK], ['backfill', BACKFILL]]) {
      const r = await run(script, missing, exec);
      assert.notEqual(r.code, 0, `${name}: a missing board file must not exit 0: ${r.said}`);
      assert.ok(r.said.includes(missing), `${name}: the message names the path it was given: ${r.said}`);
      assert.equal(fs.existsSync(missing), false, `${name}: no file was created at the missing path`);
    }
    assert.deepEqual(await commentIds(exec), before, 'the graph is exactly as it was');
  });
});

test('G2 A FILE THAT IS NOT A BOARD (not JSON, truncated JSON) IS REFUSED: both scripts exit non-zero, name the path, and leave the bytes untouched; the graph gains nothing', { skip: SKIP }, async () => {
  await withExec(async (exec) => {
    const before = await commentIds(exec);
    for (const [label, text] of [['not json', 'this is not a board file {'], ['truncated json', JSON.stringify(validBoard()).slice(0, 120)]]) {
      for (const [name, script] of [['rollback', ROLLBACK], ['backfill', BACKFILL]]) {
        const f = tmpFile('board.json'); fs.writeFileSync(f, text);
        const r = await run(script, f, exec);
        assert.notEqual(r.code, 0, `${name} (${label}): refused, not exit 0: ${r.said}`);
        assert.ok(r.said.includes(f), `${name} (${label}): names the path: ${r.said}`);
        assert.equal(fs.readFileSync(f, 'utf8'), text, `${name} (${label}): the file's bytes are untouched`);
      }
    }
    assert.deepEqual(await commentIds(exec), before, 'the graph gained nothing');
  });
});

test('G3 A ZERO-BYTE BOARD FILE IS REFUSED: both scripts exit non-zero, name the path, and the file stays zero bytes; the graph gains nothing', { skip: SKIP }, async () => {
  await withExec(async (exec) => {
    const before = await commentIds(exec);
    for (const [name, script] of [['rollback', ROLLBACK], ['backfill', BACKFILL]]) {
      const f = tmpFile('board.json'); fs.writeFileSync(f, '');
      const r = await run(script, f, exec);
      assert.notEqual(r.code, 0, `${name}: refused, not exit 0: ${r.said}`);
      assert.ok(r.said.includes(f), `${name}: names the path: ${r.said}`);
      assert.equal(fs.statSync(f).size, 0, `${name}: the file is still zero bytes`);
    }
    assert.deepEqual(await commentIds(exec), before, 'the graph gained nothing');
  });
});

test('G4 CONTROL: the same invocations on a VALID board file exit 0 (so G1-G3 refused the FILE, not the executor, the dataset or the flags)', { skip: SKIP }, async () => {
  await withExec(async (exec) => {
    const f = tmpFile('board.json'); fs.writeFileSync(f, JSON.stringify(validBoard(), null, 2));
    const fwd = await run(BACKFILL, f, exec);
    assert.equal(fwd.code, 0, `the backfill on a valid board: ${fwd.said}`);
    assert.deepEqual((await commentIds(exec)).length, POSTS.length, 'and it imported the posts');
    const back = await run(ROLLBACK, f, exec);
    assert.equal(back.code, 0, `the rollback on a valid board: ${back.said}`);
  });
});

test('G5 VALID JSON THAT IS NOT A BOARD IS REFUSED: `{}`, `[]`, `null`, a string and an object of unrelated keys are each refused by both scripts (non-zero, path named, bytes untouched, graph untouched)', { skip: SKIP }, async () => {
  await withExec(async (exec) => {
    await importPosts(exec);
    const before = await commentIds(exec);
    for (const text of ['{}', '[]', 'null', '42', '"a string"', '{"unrelated": true, "items": [1, 2, 3]}', '{"hello":"world"}', '{"columns": [], "conversations": []}']) {   // the last one has board-ish keys but neither `@graph` nor `cards`: the builder's stated recognised roots
      for (const [name, script] of [['rollback', ROLLBACK], ['backfill', BACKFILL]]) {
        const f = tmpFile('board.json'); fs.writeFileSync(f, text);
        const r = await run(script, f, exec);
        assert.notEqual(r.code, 0, `${name} (${text}): refused, not exit 0: ${r.said}`);
        assert.ok(r.said.includes(f), `${name} (${text}): names the path: ${r.said}`);
        assert.equal(fs.readFileSync(f, 'utf8'), text, `${name} (${text}): the bytes are untouched`);
      }
    }
    assert.deepEqual(await commentIds(exec), before, 'the graph is exactly as it was');
  });
});

test('G6 A GENUINELY EMPTY BOARD IS NOT REFUSED: the legacy fixture with its epoch and counter and no posts, and the JSON-LD file a real server writes for a board with no posts, are each accepted by both scripts (backfill: 0 posts; rollback against an empty graph: the file is byte-identical)', { skip: SKIP }, async () => {
  const realEmpty = await startRestServer({ board: makeBoardFixture({ conversations: [], postSeqEpoch: EPOCH_DOC, nextPostSeq: 1 }) });
  // a real server rewrites its board file as JSON-LD on its first write: make one, so the file is the real shape and not the fixture's
  const w = await fetch(`${realEmpty.baseUrl}/api/cards`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'a card, so the file is rewritten', description: 'x', createdBy: 'ada' }) });
  assert.ok(w.status === 200 || w.status === 201, 'CONTROL: the real server wrote its board');
  const jsonld = realEmpty.boardFile; realEmpty.kill(); await new Promise((r) => setTimeout(r, 400));
  assert.ok(Array.isArray(JSON.parse(fs.readFileSync(jsonld, 'utf8'))['@graph']), 'CONTROL: that file is the JSON-LD shape');
  await withExec(async (exec) => {
    const legacy = tmpFile('board.json'); fs.writeFileSync(legacy, JSON.stringify(makeBoardFixture({ conversations: [], postSeqEpoch: EPOCH_DOC, nextPostSeq: 1 }), null, 2));
    for (const [label, f] of [['legacy empty board', legacy], ['JSON-LD empty board', jsonld]]) {
      const fwd = await run(BACKFILL, f, exec);
      assert.equal(fwd.code, 0, `backfill on a ${label}: ${fwd.said}`);
      const bytes = fs.readFileSync(f);
      const back = await run(ROLLBACK, f, exec);
      assert.equal(back.code, 0, `rollback on a ${label}: ${back.said}`);
      assert.deepEqual(fs.readFileSync(f), bytes, `rollback on a ${label} against an empty graph leaves the file byte-identical`);
    }
    assert.deepEqual(await commentIds(exec), [], 'and no post was invented');
  });
});
