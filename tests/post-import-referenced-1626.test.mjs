/**
 * #1626 step 0 — A POST THAT SOMETHING ALREADY POINTS AT CAN BE IMPORTED. Written by the separate test author BEFORE the compiler change. The backfill cannot bring the 89 file-only board announcements (12:21–18:31Z on 2026-10-06) into
 * the graph, because `post.import` is compiled with `fresh(post.iri)` and `fresh` refuses an IRI that has a triple as its SUBJECT *or* as its OBJECT; tonight's deliveries point at those posts (`ofConversation`), so the guard reads "something
 * already uses this id" and refuses the write. The proposed change: for `post.import` only, fresh means no triples with the post as SUBJECT. These rows pin what must change and what must NOT, through the real scripts and the real executor,
 * with synthetic content. Without a python with pyoxigraph every row is SKIPPED, and a skip is NOT a pass.
 *
 * THE WORLD (built per row): a unit-off server writes K document-born posts into a board file; a unit-on server (conversations + deliveries units) over that file and an EMPTY executor creates deliveries for two of them, so two posts
 * are file-only and pointed at by a graph delivery, exactly the live shape; then the backfill (`scripts/backfill-posts-r0.mjs`) is run on that file.
 *
 *   B0  CONTROL (green today): the world is what the rows assume (the two posts are pointed at and absent, no post is in the graph), and an UNREFERENCED absent post imports (`post.import` APPLIED), so a failure below is the guard and
 *       not the plumbing.
 *   B1  A REFERENCED-BUT-ABSENT POST IMPORTS: the backfill completes, exit 0, every post written, no conflict, none failed; each post is in the graph with its STORED text and postSeq; the two deliveries' posts are readable by id.
 *   B2  A PRESENT POST IS STILL REFUSED, referenced or not: with the same id and a NEW opId and different text, `post.import` is not APPLIED and the graph text is unchanged; running the backfill again writes nothing (all present).
 *   B3  A REDACTED POST IS STILL A NAMED CONFLICT: after one imported post is redacted, the backfill reports it as `redacted-post` (exit 4), writes nothing, and its text is not back in the graph.
 *   B4  THE LOOSENING IS FOR `post.import` ONLY: `post.write` (a graph-born post) of an id that a delivery points at is STILL refused; `post.write` of an id nothing points at is APPLIED (the control that the refusal is the guard, not the intention).
 *   B5  NUMBERING IS UNDISTURBED: the imported posts keep their STORED postSeq (B1 reads them) and a post created afterwards through REST on a unit-on server is numbered one past the highest stored number: no reuse, no gap.
 *
 * NOT COVERED, by name: the other `fresh` users (grants, rules, `delivery.import`, `memory.create` and the rest keep their both-sides guard; B4 pins `post.write` only, as the one that shares the compiler branch); a post's ATTACHMENT nodes
 * (their freshness is a separate `fresh.push` and is untouched here); the live 89 (the dry run to N of N is the measurement); a race between an import and a post written under the same id by another writer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { makeBoardFixture, startRestServer, PROJECT_DIR } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';
import { createGraphClient } from '../core/graph-client.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const ROSTER_FILE = path.join(os.tmpdir(), `pi1626-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, gizmo: { name: 'Gizmo', glyph: 'g', color: '#c4a07c' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
const DSID = 'pi1626-test'; const ENTITY = 'https://scrumboard.local/entity/'; const PERSON = 'https://scrumboard.local/person/';
const api = async (base, method, route, body) => {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text };
};
const ALNUM = () => `${process.pid}x${Date.now().toString(36)}`.replace(/[^a-z0-9]/gi, '').toLowerCase();
const run = (script, args) => { const r = spawnSync(process.execPath, [path.join(PROJECT_DIR, 'scripts', script), ...args], { encoding: 'utf8', timeout: 180000 }); return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout }; };
const summaryOf = (r) => { const line = r.stdout.trim().split('\n').reverse().find((l) => { try { return JSON.parse(l) && typeof JSON.parse(l) === 'object'; } catch { return false; } }); return line ? JSON.parse(line) : null; };
const query = async (exec, sparql) => { const res = await fetch(`${exec.baseUrl}/query`, { method: 'POST', headers: { 'content-type': 'application/sparql-query' }, body: sparql, signal: AbortSignal.timeout(30000) }); assert.equal(res.status, 200, `the store answers a query (${res.status})`); return (await res.json()).results.bindings; };
const pointedAt = async (exec, id) => Number((await query(exec, `SELECT (COUNT(*) AS ?n) WHERE { ?s ?p <${ENTITY}${id}> }`))[0].n.value);
const heldAsSubject = async (exec, id) => Number((await query(exec, `SELECT (COUNT(*) AS ?n) WHERE { <${ENTITY}${id}> ?p ?o }`))[0].n.value);
const textOf = async (exec, id) => (await query(exec, `SELECT ?t WHERE { <${ENTITY}${id}> <https://schema.org/text> ?t }`)).map((b) => b.t.value);
const seqOf = async (exec, id) => (await query(exec, `SELECT ?n WHERE { <${ENTITY}${id}> <https://scrumboard.local/ns#postSeq> ?n }`)).map((b) => Number(b.n.value));
const commentCount = async (exec) => Number((await query(exec, `SELECT (COUNT(DISTINCT ?s) AS ?n) WHERE { ?s a <https://schema.org/Comment> }`))[0].n.value);
const importIntention = (kind, post, op) => ({ kind, opId: op, actor: `${PERSON}board`, post: { attachedTo: null, mentions: [], ...post } });

async function world(tag) {
  const s0 = await startRestServer({ board: makeBoardFixture({ cards: [], conversations: [] }), env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi1626-')); const file = path.join(dir, 'board.json'); const posts = [];
  try {
    for (let i = 0; i < 5; i++) { const r = await api(s0.baseUrl, 'POST', '/api/conversations', { author: 'board', body: `${tag}-announcement-${i}` }); assert.equal(r.status, 201, `world: post ${i} (${r.status} ${r.text.slice(0, 100)})`); posts.push({ id: r.body.id, body: `${tag}-announcement-${i}`, seq: r.body.postSeq }); }
    fs.copyFileSync(s0.boardFile, file);
  } finally { await s0.stop(); }
  const exec = await startExecutor({ store: tmpStore('pi1626-store-'), datasetId: DSID, create: true });
  const env = { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: DSID, SCRUM_GRAPH_EXECUTOR_URL: exec.baseUrl, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_UNIT_DELIVERIES: '1' };
  // a server's stop() removes the board file it ran on, so every server runs on its OWN COPY and `file` (what the backfill reads) is never one of them
  const copyOf = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pi1626-run-')); const f = path.join(d, 'board.json'); fs.copyFileSync(file, f); return f; };
  const u = await startRestServer({ boardFile: copyOf(), env });
  try { for (const k of [0, 2]) { const d = await api(u.baseUrl, 'POST', '/api/deliveries', { to: 'gizmo', conversation: posts[k].id, source: 'fanout', by: 'board' }); assert.equal(d.status, 201, `world: a delivery for post ${k} (${d.status} ${d.text.slice(0, 140)})`); } } finally { await u.stop(); }
  // the deliveries were written through `u`'s copy: its document changed too (a delivery step is graph-only, but the copy is what a later server must see); the posts are unchanged, so `file` stays the pre-delivery document
  const W = { dir, file, exec, posts, tag, env, serve: () => startRestServer({ boardFile: copyOf(), env }), referenced: [posts[0].id, posts[2].id], free: [posts[1].id, posts[3].id, posts[4].id] };
  W.client = createGraphClient({ baseUrl: exec.baseUrl, expectedDatasetId: DSID });
  W.backfill = () => { const r = run('backfill-posts-r0.mjs', ['--board-file', file, '--executor-url', exec.baseUrl, '--dataset-id', DSID]); return { ...r, summary: summaryOf(r) }; };
  W.stop = async () => { await killExecutor(exec); };
  return W;
}
const imp = (W, p, extra = {}) => W.client.update(importIntention('post.import', { id: p.id, body: p.body, author: 'board', createdAt: '2026-10-06T13:00:00.000Z', postSeq: p.seq, ...extra.post }, extra.op ?? `urn:ex:op/test/${crypto.randomUUID()}`));

test('B0 CONTROL: the world is two file-only posts pointed at by deliveries and nothing in the graph; an unreferenced absent post imports', { skip: SKIP, timeout: 300000 }, async () => {
  const W = await world(ALNUM());
  try {
    for (const id of W.referenced) { assert.ok(await pointedAt(W.exec, id) >= 1, `post ${id} is pointed at by a graph triple`); assert.equal(await heldAsSubject(W.exec, id), 0, 'and absent as a node'); }
    for (const id of W.free) assert.equal(await pointedAt(W.exec, id), 0, 'the other posts are pointed at by nothing');
    assert.equal(await commentCount(W.exec), 0, 'no post is in the graph');
    const r = await imp(W, W.posts[1]); assert.equal(r.outcome, 'APPLIED', `an unreferenced absent post imports (${JSON.stringify(r)})`);
    assert.deepEqual(await textOf(W.exec, W.posts[1].id), [W.posts[1].body], 'with its text');
  } finally { await W.stop(); }
});

test('B1 A REFERENCED-BUT-ABSENT POST IMPORTS: the backfill completes with every post written, none in conflict, stored text and postSeq kept', { skip: SKIP, timeout: 300000 }, async () => {
  const W = await world(ALNUM());
  try {
    const bf = W.backfill();
    assert.equal(bf.code, 0, `the backfill completes (exit ${bf.code}): ${bf.out.slice(-400)}`);
    assert.deepEqual([bf.summary.written, bf.summary.alreadyPresent, bf.summary.conflicts, bf.summary.failed], [W.posts.length, 0, [], 0], `every post written, no conflict, none failed: ${JSON.stringify(bf.summary)}`);
    for (const p of W.posts) { assert.deepEqual(await textOf(W.exec, p.id), [p.body], `post ${p.id}: the stored text`); assert.deepEqual(await seqOf(W.exec, p.id), [p.seq], `post ${p.id}: the stored postSeq`); }
    const u = await W.serve();
    try { for (const id of W.referenced) { const r = await api(u.baseUrl, 'GET', `/api/conversations/${id}`); assert.equal(r.status, 200, `the post a delivery points at is readable by id (${r.status})`); assert.ok(JSON.stringify(r.body).includes(W.tag), 'with its text'); } } finally { await u.stop(); }
  } finally { await W.stop(); }
});

test('B2 A PRESENT POST IS STILL REFUSED, referenced or not; running the backfill again writes nothing', { skip: SKIP, timeout: 300000 }, async () => {
  const W = await world(ALNUM());
  try {
    const bf = W.backfill(); assert.equal(bf.code, 0, `PRECONDITION: the backfill completes first (exit ${bf.code}): ${bf.out.slice(-300)}`);
    for (const p of [W.posts[0], W.posts[1]]) {
      const before = await textOf(W.exec, p.id);
      const r = await imp(W, p, { post: { body: `${p.body} (a different text)` } });
      assert.notEqual(r.outcome, 'APPLIED', `a present post (${p === W.posts[0] ? 'referenced' : 'unreferenced'}) imported again under a NEW opId must not be applied (${JSON.stringify(r)})`);
      assert.deepEqual(await textOf(W.exec, p.id), before, 'and the graph text is unchanged');
    }
    const again = W.backfill(); assert.equal(again.code, 0, 're-running completes'); assert.deepEqual([again.summary.written, again.summary.alreadyPresent], [0, W.posts.length], `nothing written, all present: ${JSON.stringify(again.summary)}`);
  } finally { await W.stop(); }
});

test('B3 A REDACTED POST IS STILL A NAMED CONFLICT: reported as redacted-post (exit 4), nothing written, its text not back', { skip: SKIP, timeout: 300000 }, async () => {
  const W = await world(ALNUM());
  try {
    const bf = W.backfill(); assert.equal(bf.code, 0, `PRECONDITION: the backfill completes first (exit ${bf.code}): ${bf.out.slice(-300)}`);
    const target = W.posts[0];   // a post that was pointed at: its redaction must hold against a re-import
    const red = await W.client.update({ kind: 'post.redact', opId: `urn:ex:op/redact/${target.id}`, actor: `${PERSON}ada`, post: { id: target.id }, authorityRef: 'test-authority-ref', occurredAt: new Date().toISOString() });
    assert.equal(red.outcome, 'APPLIED', `PRECONDITION: the post is redacted (${JSON.stringify(red)})`);
    assert.deepEqual(await textOf(W.exec, target.id), [], 'the redacted post holds no text');
    const again = W.backfill();
    assert.equal(again.code, 4, `a redacted post is a conflict: exit 4 (got ${again.code}): ${again.out.slice(-300)}`);
    assert.deepEqual(again.summary.conflicts, [{ id: target.id, reason: 'redacted-post' }], 'named, as redacted-post'); assert.equal(again.summary.written, 0, 'nothing written');
    assert.deepEqual(await textOf(W.exec, target.id), [], 'and its text did not come back');
  } finally { await W.stop(); }
});

test('B4 THE LOOSENING IS FOR post.import ONLY: post.write of an id a delivery points at is still refused; of an id nothing points at it is applied', { skip: SKIP, timeout: 300000 }, async () => {
  const W = await world(ALNUM());
  try {
    const mk = (p, op) => W.client.update(importIntention('post.write', { id: p.id, body: p.body, author: 'board', createdAt: '2026-10-06T13:00:00.000Z', postSeq: p.seq }, op));
    const free = await mk(W.posts[1], `urn:ex:op/test/${crypto.randomUUID()}`); assert.equal(free.outcome, 'APPLIED', `CONTROL: post.write of an id nothing points at is applied (${JSON.stringify(free)})`);
    const ref = await mk(W.posts[0], `urn:ex:op/test/${crypto.randomUUID()}`);
    assert.notEqual(ref.outcome, 'APPLIED', `post.write of an id a delivery points at must still be refused (${JSON.stringify(ref)})`);
    assert.equal(await heldAsSubject(W.exec, W.posts[0].id), 0, 'and nothing was written for it');
  } finally { await W.stop(); }
});

test('B5 NUMBERING IS UNDISTURBED: a post created after the import is one past the highest stored postSeq', { skip: SKIP, timeout: 300000 }, async () => {
  const W = await world(ALNUM());
  try {
    const bf = W.backfill(); assert.equal(bf.code, 0, `PRECONDITION: the backfill completes first (exit ${bf.code}): ${bf.out.slice(-300)}`);
    const u = await W.serve();
    try {
      const made = await api(u.baseUrl, 'POST', '/api/conversations', { author: 'ada', body: `${W.tag}-after-import` }); assert.equal(made.status, 201, `a new post is accepted (${made.status} ${made.text.slice(0, 100)})`);
      assert.equal(made.body.postSeq, Math.max(...W.posts.map((p) => p.seq)) + 1, `numbered one past the highest stored (${Math.max(...W.posts.map((p) => p.seq))}): got ${made.body.postSeq}`);
    } finally { await u.stop(); }
  } finally { await W.stop(); }
});
