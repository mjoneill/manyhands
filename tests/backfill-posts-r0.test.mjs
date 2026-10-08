/**
 * ⚠ SUBSTRATE, NOT R0 COMPLETION. This file pins the parts of the backfill that are settled. THE TOOL IT DESCRIBES REFUSES TODAY'S BOARD: the live board's
 * posts carry `origin`, `attachments`, `onBehalfOf` and other fields whose graph shape is undefined (U1/U2/U4), so a green run of this file authorises NO
 * real-board backfill, and "36k imported" is not what passing it means. Six rows at the end are `todo` on purpose.
 *
 * R0 (SETTLED HALF) — back-fill the document's posts into the graph. Pre-registered by the separate test author BEFORE the tool exists.
 * Copy unchanged into tests/ and build to it; if the contract needs a change the test changes first and the change is announced on #1574.
 * Uses the REAL executor (a python with pyoxigraph); without one every test is SKIPPED and a skip is NOT a pass.
 *
 * THIS FILE IS HALF A CONTRACT, AND SAYS WHICH HALF. The rows marked `todo` at the end are the parts that are NOT frozen: the graph shape of
 * attachments, of `onBehalfOf`, of a post's `origin`/`reach`/other extras, the null-versus-empty distinctions, the `conversation` tag, and the
 * treatment of a post REMOVED or REDACTED after the snapshot. Nothing here invents a predicate for them. A fixture in this file never carries them.
 *
 * THE TOOL     node scripts/backfill-posts-r0.mjs --board-file F --executor-url U --dataset-id D [--limit N]
 *              Reads F (a stopped board or a COPY), NEVER writes it. Writes each document post into the graph through the executor.
 *              The LAST line of stdout that parses as a JSON object is the summary:
 *                {posts, written, alreadyPresent, conflicts: [{id, reason}], failed}   with posts == written + alreadyPresent + conflicts.length + failed.
 *              --limit N stops after N posts WRITTEN (the deterministic interruption); the summary then has written == N.
 *              EXIT: 0 complete; 3 REFUSED BEFORE ANY WRITE (named below); 4 completed but with one or more CONFLICTS; 2 an operational failure (a wrong
 *              dataset, an unreachable executor, a bad argument).
 *              ORDER OF REFUSALS: the board's migration/corruption state first (POST_SEQ_*), then unsupported fields, then the executor and its dataset
 *              identity (so an unsupported board is refused without the executor being contacted at all).
 *
 * THE POST, IN THE GRAPH (the EXISTING mapping, core/mapping.mjs + core/graph-replica.mjs, plus the agreed postSeq stamp)
 *   node <https://scrumboard.local/entity/<post.id>>  with
 *     rdf:type            schema:Comment
 *     schema:text         plain literal, the body BYTE FOR BYTE
 *     schema:author       IRI <https://scrumboard.local/person/<author>>
 *     schema:dateCreated  plain literal, the stored createdAt (NEVER "now")
 *     schema:about        IRI <https://scrumboard.local/entity/<attachedTo>>   (absent when attachedTo is null)
 *     <ns#mentionsName>   one plain literal per mention
 *     <ns#postSeq>        the STORED postSeq, an xsd:integer (never renumbered)
 *     <urn:ex:recordedBy> exactly ONE link to the operation that wrote it (the compiler's own provenance link; its value is not pinned)
 *   and nothing else.
 *
 * COVERAGE     on a FRESH SCRATCH dataset, after a full run the graph holds exactly one Comment node per document post and no other Comment
 *              node (this is NOT asserted for a production graph that already holds executor-born posts), keyed by the post's own id.
 * UNSUPPORTED  the run is all-or-nothing about this: if ANY post carries a field whose graph shape is not defined (an unknown key, an `origin` with a key
 *              beyond mutationId/slot/occurredAt, `reach`...), the tool REFUSES before ANY write: exit 3,
 *              UNSUPPORTED_POST_FIELDS, listing every offending id and its field names. It neither strips the field nor writes the rest. The fields the U1-U4
 *              vocabulary DEFINES (attachments, onBehalfOf, conversation, _recovered, origin, opId) are covered by the lossless round-trip file
 *              backfill-posts-r0-shape.test.mjs. The author-correction trail is NOT unsupported since decision f4940204 (2026-10-05): it is stored as provenance literals and pinned by backfill-posts-r0-u5.test.mjs.
 * UNREADABLE   if the executor's READS fail (an existing node or an operation's receipt cannot be read), the tool cannot know what is present: an
 *              operational failure, exit 2, ZERO writes (R13); it never writes on the strength of a read it could not make.
 * RECEIPT      an operation that already has an APPLIED receipt whose node is ABSENT (after a restore or a deletion) is NOT authority to write: the tool
 *              reports a named RECONCILIATION conflict ({id, reason: 'receipt-without-node'}, exit 4), does not recreate the node, does not count it as
 *              written or alreadyPresent, and sends nothing for it (R12).
 * ADDITIVE     a re-run writes nothing for what is already present AND MATCHES. An existing id whose content DIFFERS from the board's post is a
 *              NAMED CONFLICT ({id, reason: 'content-differs'}, exit 4): never a silent success, never an overwrite; the other posts still proceed.
 * RESUME       an interruption (--limit, or a SIGKILL during a write) followed by a re-run ends in a graph identical to an uninterrupted run, with
 *              every Comment node recorded by exactly ONE operation (no post written twice under two ops), and a re-run against a COMPLETE graph
 *              sends ZERO writes to the executor (counted at a proxy: RDF set equality cannot prove it).
 * REFUSALS     a board that is not migrated (no epoch, un-numbered posts): exit 3, POST_SEQ_MIGRATION_REQUIRED on stderr or stdout, ZERO writes.
 *              a corrupt board (the v6 states): exit 3, POST_SEQ_STATE_CORRUPT, zero writes. R0 never numbers anything: it copies the stored postSeq.
 *              a wrong dataset id, or an executor that cannot be reached: a nonzero exit that is not 3 or 4, zero posts reported written.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeBoardFixture, PROJECT_DIR } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';
import { createGraphClient } from '../core/graph-client.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = process.env.BACKFILL_SCRIPT || path.join(HERE, '..', 'scripts', 'backfill-posts-r0.mjs');
const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const DSID = 'r0-test';
const ENTITY = 'https://scrumboard.local/entity/', PERSON = 'https://scrumboard.local/person/', NS = 'https://scrumboard.local/ns#', SCHEMA = 'https://schema.org/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', XSD_INT = 'http://www.w3.org/2001/XMLSchema#integer';
const EPOCH = '11111111-2222-4333-8444-555555555555';

// ---- fixtures: only the SETTLED fields
const uuid = (n) => { const h = crypto.createHash('sha1').update(`r0:${n}`).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; };
function makePosts(n, { from = 1 } = {}) {
  const authors = ['ada', 'bea', 'board', 'cy', 'ada'];
  return Array.from({ length: n }, (_, k) => {
    const i = from + k;
    const base = { id: uuid(i), body: `post ${i}`, author: authors[i % authors.length], attachedTo: null, attachments: [], mentions: [], createdAt: new Date(Date.UTC(2026, 9, 1, 12, 0, i)).toISOString(), postSeq: i };
    if (i % 3 === 0) base.mentions = ['bea', 'cy'];
    if (i % 4 === 0) base.attachedTo = uuid(1000 + i);                      // a card id
    if (i === 5) base.body = 'multi-byte é中文 🚀 line one\nline two\t(tab)  trailing spaces  ';
    if (i === 6) base.id = 'legacy-non-uuid-id-6';
    return base;
  });
}
const boardFor = (posts, extra = {}) => makeBoardFixture({ conversations: posts, postSeqEpoch: EPOCH, nextPostSeq: Math.max(0, ...posts.map((p) => p.postSeq)) + 1, ...extra });
const writeBoard = (board) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'r0-')); const f = path.join(d, 'board.json'); fs.writeFileSync(f, JSON.stringify(board, null, 2)); return f; };

/** The triples a post MUST have, as {predicate: sorted [type|value|datatype]} (everything except urn:ex:recordedBy). */
function expectedTriples(p) {
  const e = {
    [RDF_TYPE]: [`uri|${SCHEMA}Comment|`],
    [`${SCHEMA}text`]: [`literal|${p.body}|`],
    [`${SCHEMA}author`]: [`uri|${PERSON}${p.author}|`],
    [`${SCHEMA}dateCreated`]: [`literal|${p.createdAt}|`],
    [`${NS}postSeq`]: [`literal|${p.postSeq}|${XSD_INT}`],
  };
  if (p.attachedTo) e[`${SCHEMA}about`] = [`uri|${ENTITY}${p.attachedTo}|`];
  if (p.mentions.length) e[`${NS}mentionsName`] = p.mentions.map((m) => `literal|${m}|`).sort();
  return e;
}
const client = (exec) => createGraphClient({ baseUrl: exec.baseUrl, expectedDatasetId: DSID });
async function nodeTriples(exec, id) {
  // #1638: a node is its domain triples (default graph) PLUS its bookkeeping (`recordedBy`, the bookkeeping graph). Every assertion below still speaks of the WHOLE node, exactly as before; where the layout itself is pinned, see R2.
  const r = await client(exec).query(`SELECT ?p ?o WHERE { { <${ENTITY}${id}> ?p ?o } UNION { GRAPH <urn:scrum:bookkeeping:executor> { <${ENTITY}${id}> ?p ?o } } }`);
  assert.equal(r.ok, true, JSON.stringify(r));
  const out = {};
  for (const b of r.rows) (out[b.p.value] ||= []).push(`${b.o.type}|${b.o.value}|${b.o.datatype || ''}`);
  for (const k of Object.keys(out)) out[k].sort();
  return out;
}
async function commentIds(exec) {
  const r = await client(exec).query(`SELECT ?s WHERE { ?s <${RDF_TYPE}> <${SCHEMA}Comment> }`);
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.rows.map((b) => b.s.value.replace(ENTITY, '')).sort();
}
/** A whole dataset's Comment triples, minus the provenance link, as one sorted list: two datasets are "identical" when these are equal. */
async function snapshot(exec) {
  const ids = await commentIds(exec); const rows = [];
  for (const id of ids) { const t = await nodeTriples(exec, id); delete t['urn:ex:recordedBy']; for (const [p, os_] of Object.entries(t)) for (const o of os_) rows.push(`${id}\t${p}\t${o}`); }
  return rows.sort();
}
const recordedBy = async (exec, id) => (await nodeTriples(exec, id))['urn:ex:recordedBy'] || [];

/** A counting pass-through proxy in front of the executor: every POST /update is logged; `holdAt` makes the k-th /update apply but answer only after `holdMs`. */
async function startProxy(execUrl, { holdAt = 0, holdMs = 0 } = {}) {
  const p = { updates: 0, arrivedHeld: null, failReads: false };
  let arrive; p.held = new Promise((r) => { arrive = r; });
  p.server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const isUpdate = req.method === 'POST' && req.url === '/update';
    if (p.failReads && !isUpdate) { try { res.statusCode = 503; res.setHeader('Content-Type', 'application/json'); res.end('{"error":"proxy-injected read failure"}'); } catch { /* gone */ } return; }
    let hold = false;

    if (isUpdate) { p.updates++; if (holdAt && p.updates === holdAt) hold = true; }
    const fwd = { ...req.headers }; delete fwd.host; delete fwd['content-length']; delete fwd.connection;   // the executor requires x-op-id on a write: forward every header
    const f = await fetch(`${execUrl}${req.url}`, { method: req.method, headers: fwd, ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) });
    const text = await f.text();
    if (hold) { arrive(); await new Promise((r) => setTimeout(r, holdMs)); }
    try { res.statusCode = f.status; res.end(text); } catch { /* the tool was killed */ }
  });
  await new Promise((r) => p.server.listen(0, '127.0.0.1', r));
  p.url = `http://127.0.0.1:${p.server.address().port}`;
  p.stop = () => new Promise((r) => { p.server.closeAllConnections?.(); p.server.close(() => r()); });
  return p;
}

function runTool(boardFile, executorUrl, { dataset = DSID, extra = [], timeoutMs = 60000, onSpawn } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TOOL, '--board-file', boardFile, '--executor-url', executorUrl, '--dataset-id', dataset, ...extra], { cwd: PROJECT_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    onSpawn?.(child);
    let out = '', err = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      let summary = null; for (const l of out.split('\n').reverse()) { const t = l.trim(); if (t.startsWith('{')) { try { summary = JSON.parse(t); break; } catch { /* not json */ } } }
      resolve({ code, signal, out, err, summary, said: `${out}\n${err}` });
    });
  });
}
async function withExec(body, { proxyOpts } = {}) {
  const exec = await startExecutor({ store: tmpStore('r0-store-'), datasetId: DSID, create: true });
  const proxy = await startProxy(exec.baseUrl, proxyOpts);
  try { return await body({ exec, proxy, url: proxy.url }); } finally { await proxy.stop(); await killExecutor(exec); }
}
const N = 12;

// ------------------------------------------------------------------ coverage, fidelity, board untouched
test('R1 a full run on a fresh scratch dataset: exactly one Comment node per post, keyed by the post id, no other Comment node; the summary adds up; the board file is byte-identical', { skip: SKIP }, async () => {
  const posts = makePosts(N); const file = writeBoard(boardFor(posts)); const before = fs.readFileSync(file);
  await withExec(async ({ exec, url }) => {
    const r = await runTool(file, url);
    assert.equal(r.code, 0, r.said);
    assert.ok(r.summary, `a JSON summary line is required:\n${r.out}`);
    assert.equal(r.summary.posts, N); assert.equal(r.summary.written, N); assert.equal(r.summary.alreadyPresent, 0); assert.equal(r.summary.failed, 0); assert.deepEqual(r.summary.conflicts, []);
    assert.deepEqual(await commentIds(exec), posts.map((p) => p.id).sort(), 'exactly the board\'s posts, by id, and no other Comment node');
    assert.deepEqual(fs.readFileSync(file), before, 'the board file was not written');
  });
});

test('R2 every post is preserved, not regenerated: the node carries EXACTLY the pinned triples (id, body byte-for-byte, author, stored createdAt, about, mentions, stored postSeq as xsd:integer) and one recordedBy', { skip: SKIP }, async () => {
  const posts = makePosts(N); const file = writeBoard(boardFor(posts));
  await withExec(async ({ exec, url }) => {
    assert.equal((await runTool(file, url)).code, 0);
    for (const p of posts) {
      const got = await nodeTriples(exec, p.id);
      const by = got['urn:ex:recordedBy'] || []; delete got['urn:ex:recordedBy'];
      assert.equal(by.length, 1, `${p.id}: exactly one recordedBy`);
      const inDefault = await client(exec).ask(`ASK { <${ENTITY}${p.id}> <urn:ex:recordedBy> ?x }`); assert.deepEqual([inDefault.ok, inDefault.boolean], [true, false], `#1638: ${p.id}: recordedBy is bookkeeping and is NOT a default-graph triple of the node`);
      const want = expectedTriples(p);
      for (const k of Object.keys(want)) want[k].sort();
      assert.deepEqual(got, want, `post ${p.id} (seq ${p.postSeq}) must carry exactly the pinned triples`);
    }
    const f5 = await nodeTriples(exec, posts[4].id);
    assert.equal(f5[`${SCHEMA}text`][0].split('|')[1], posts[4].body, 'the multi-byte, newline, tab and trailing-space body is preserved byte for byte');
    assert.ok(!posts.some((p) => (p.createdAt === undefined)), 'fixture sanity');
    const dc = (await nodeTriples(exec, posts[0].id))[`${SCHEMA}dateCreated`][0];
    assert.equal(dc, `literal|${posts[0].createdAt}|`, 'the STORED createdAt, not the time of the backfill');
  });
});

// ------------------------------------------------------------------ additive and idempotent
test('R3 a second run on a COMPLETE graph writes nothing: written 0, alreadyPresent N, ZERO /update calls at the executor, the graph unchanged', { skip: SKIP }, async () => {
  const posts = makePosts(N); const file = writeBoard(boardFor(posts));
  await withExec(async ({ exec, proxy, url }) => {
    assert.equal((await runTool(file, url)).code, 0);
    const before = await snapshot(exec); const sent = proxy.updates;
    assert.equal(sent >= 1, true, 'the first run really wrote through the proxy');
    const r = await runTool(file, url);
    assert.equal(r.code, 0, r.said);
    assert.deepEqual([r.summary.written, r.summary.alreadyPresent, r.summary.failed], [0, N, 0]);
    assert.equal(proxy.updates, sent, 'ZERO writes reached the executor on the second run');
    assert.deepEqual(await snapshot(exec), before);
  });
});

// ------------------------------------------------------------------ resume after an interruption
test('R4 --limit: the first run writes exactly N0 posts, the second completes, and the final graph is IDENTICAL to an uninterrupted run, every post recorded by exactly ONE operation', { skip: SKIP }, async () => {
  const posts = makePosts(N); const file = writeBoard(boardFor(posts));
  const reference = await withExec(async ({ exec, url }) => { assert.equal((await runTool(file, url)).code, 0); return snapshot(exec); });
  await withExec(async ({ exec, proxy, url }) => {
    const a = await runTool(file, url, { extra: ['--limit', '5'] });
    assert.equal(a.code, 0, a.said); assert.equal(a.summary.written, 5);
    assert.equal((await commentIds(exec)).length, 5, 'exactly five nodes after the interruption');
    const b = await runTool(file, url);
    assert.equal(b.code, 0, b.said);
    assert.deepEqual([b.summary.written, b.summary.alreadyPresent], [N - 5, 5], 'the resume reports the first five as already present');
    assert.deepEqual(await snapshot(exec), reference, 'identical to a run that was never interrupted');
    for (const p of posts) assert.equal((await recordedBy(exec, p.id)).length, 1, `${p.id} was written under exactly one operation`);
    assert.equal(proxy.updates, N, 'the executor received exactly one write per post across both runs');
  });
});

test('R5 a SIGKILL DURING a write: the write was applied but never acknowledged; the re-run ends identical to an uninterrupted run, no post under two operations, and at most ONE extra /update (the re-sent in-flight write)', { skip: SKIP }, async () => {
  const posts = makePosts(N); const file = writeBoard(boardFor(posts));
  const reference = await withExec(async ({ exec, url }) => { assert.equal((await runTool(file, url)).code, 0); return snapshot(exec); });
  await withExec(async ({ exec, proxy, url }) => {
    let child; const killed = runTool(file, url, { onSpawn: (c) => { child = c; }, timeoutMs: 40000 });
    const reached = await Promise.race([proxy.held.then(() => true), new Promise((r) => setTimeout(() => r(false), 30000))]);
    assert.equal(reached, true, 'the tool never reached the held write');
    child.kill('SIGKILL'); const k = await killed;
    assert.equal(k.signal, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 1500));                      // let the held, already-applied write settle
    const partial = (await commentIds(exec)).length;
    assert.ok(partial >= 1 && partial < N, `an interruption in the middle: ${partial} of ${N} written`);
    const b = await runTool(file, url);
    assert.equal(b.code, 0, b.said);
    assert.equal(b.summary.written + b.summary.alreadyPresent, N); assert.equal(b.summary.failed, 0);
    assert.deepEqual(await snapshot(exec), reference, 'identical to a run that was never interrupted');
    for (const p of posts) assert.equal((await recordedBy(exec, p.id)).length, 1, `${p.id}: one operation`);
    assert.ok(proxy.updates <= N + 1, `no more than one re-sent write: ${proxy.updates} updates for ${N} posts`);
  }, { proxyOpts: { holdAt: 6, holdMs: 20000 } });
});

// ------------------------------------------------------------------ reconciliation of writes after the snapshot (additive)
test('R6 posts added to the live board AFTER the snapshot: a re-run against a fresh copy writes exactly those and touches nothing else', { skip: SKIP }, async () => {
  const first = makePosts(8); const later = makePosts(4, { from: 9 });
  const snap1 = writeBoard(boardFor(first)); const snap2 = writeBoard(boardFor([...first, ...later]));
  await withExec(async ({ exec, proxy, url }) => {
    assert.equal((await runTool(snap1, url)).code, 0);
    const before = {}; for (const p of first) before[p.id] = await nodeTriples(exec, p.id);
    const sent = proxy.updates;
    const r = await runTool(snap2, url);
    assert.equal(r.code, 0, r.said);
    assert.deepEqual([r.summary.written, r.summary.alreadyPresent, r.summary.posts], [4, 8, 12]);
    assert.equal(proxy.updates - sent, 4, 'exactly four new writes');
    for (const p of first) assert.deepEqual(await nodeTriples(exec, p.id), before[p.id], `${p.id} untouched`);
    assert.deepEqual(await commentIds(exec), [...first, ...later].map((p) => p.id).sort());
    assert.deepEqual((await nodeTriples(exec, later[3].id))[`${NS}postSeq`], [`literal|12|${XSD_INT}`], 'the late posts carry their own higher numbers');
  });
});

// ------------------------------------------------------------------ divergence is a named conflict
test('R7 an existing id whose content DIFFERS (a changed body, then a changed postSeq) is a NAMED CONFLICT: exit 4, {id, reason: "content-differs"}, never overwritten, never reported as present; the unchanged posts still proceed', { skip: SKIP }, async () => {
  const posts = makePosts(N); const file = writeBoard(boardFor(posts));
  await withExec(async ({ exec, proxy, url }) => {
    assert.equal((await runTool(file, url)).code, 0);
    const original = await nodeTriples(exec, posts[2].id);
    const edited = posts.map((p, i) => (i === 2 ? { ...p, body: 'the body was EDITED after the snapshot' } : p));
    const sent = proxy.updates;
    const r = await runTool(writeBoard(boardFor(edited)), url);
    assert.equal(r.code, 4, `a conflict exits 4: ${r.said}`);
    assert.deepEqual(r.summary.conflicts, [{ id: posts[2].id, reason: 'content-differs' }]);
    assert.deepEqual([r.summary.alreadyPresent, r.summary.written], [N - 1, 0], 'the other eleven are present, the conflicting one is neither present nor written');
    assert.equal(proxy.updates, sent, 'nothing was sent: no overwrite attempt');
    assert.deepEqual(await nodeTriples(exec, posts[2].id), original, 'the graph node is exactly as it was');
    const renumbered = posts.map((p, i) => (i === 7 ? { ...p, postSeq: 700 } : p));
    const r2 = await runTool(writeBoard(boardFor(renumbered)), url);
    assert.equal(r2.code, 4, r2.said); assert.deepEqual(r2.summary.conflicts, [{ id: posts[7].id, reason: 'content-differs' }], 'a different postSeq is a conflict too: the number is part of the preserved content');
  });
});

// ------------------------------------------------------------------ a receipt is not authority to write
import { spawnSync } from 'node:child_process';
import { PY } from './helpers/graph-executor-proc.mjs';
test('R12 an APPLIED receipt whose node is ABSENT (a restore, a deletion) is a NAMED RECONCILIATION CONFLICT, not a successful import: exit 4, {id, reason: "receipt-without-node"}, the node is NOT recreated, nothing is sent for it, and the other posts are alreadyPresent', { skip: SKIP }, async () => {
  const posts = makePosts(N); const file = writeBoard(boardFor(posts));
  const store = tmpStore('r0-store-');
  let exec = await startExecutor({ store, datasetId: DSID, create: true });
  const port = exec.port;
  const proxy = await startProxy(exec.baseUrl);
  try {
    assert.equal((await runTool(file, proxy.url)).code, 0);
    const victim = posts[3];
    await proxy.stop(); await killExecutor(exec);
    const del = spawnSync(PY, ['-c', `import pyoxigraph as ox; s = ox.Store(${JSON.stringify(store)}); s.update('DELETE WHERE { GRAPH ?g { <${ENTITY}${victim.id}> ?p ?o } }'); s.update('DELETE WHERE { <${ENTITY}${victim.id}> ?p ?o }')`], { encoding: 'utf8' });
    assert.equal(del.status, 0, `fixture: deleting the node from the store: ${del.stdout}${del.stderr}`);
    exec = await startExecutor({ store, datasetId: DSID, create: false, port });
    const p2 = await startProxy(exec.baseUrl);
    try {
      assert.ok(!(await commentIds(exec)).includes(victim.id), 'fixture: the node is really gone, while the other eleven remain');
      assert.equal((await commentIds(exec)).length, N - 1);
      const r = await runTool(file, p2.url);
      assert.equal(r.code, 4, `a receipt without its node exits 4: ${r.said}`);
      assert.deepEqual(r.summary.conflicts, [{ id: victim.id, reason: 'receipt-without-node' }]);
      assert.deepEqual([r.summary.written, r.summary.alreadyPresent], [0, N - 1]);
      assert.equal(p2.updates, 0, 'nothing was sent: a replay may not recreate the node');
      assert.ok(!(await commentIds(exec)).includes(victim.id), 'and the node was not recreated');
    } finally { await p2.stop(); }
  } finally { try { await proxy.stop(); } catch { /* stopped */ } await killExecutor(exec); }
});

test('R13 if the executor\'s READS fail, the tool cannot know what is present or already applied: exit 2, ZERO writes, nothing reported written', { skip: SKIP }, async () => {
  const file = writeBoard(boardFor(makePosts(6)));
  await withExec(async ({ exec, proxy, url }) => {
    proxy.failReads = true;
    const r = await runTool(file, url);
    assert.equal(r.code, 2, `unreadable state is an operational failure: ${r.said}`);
    assert.ok(!r.summary || r.summary.written === 0, 'nothing reported written');
    assert.equal(proxy.updates, 0, 'no write on the strength of a read it could not make');
    proxy.failReads = false;
    assert.deepEqual(await commentIds(exec), [], 'the graph is empty');
    const ok = await runTool(file, url);
    assert.equal(ok.code, 0, `the same command succeeds once reads work: ${ok.said}`); assert.equal(ok.summary.written, 6);
  });
});

// ------------------------------------------------------------------ nothing is silently dropped
test('R11 a board with ANY post carrying a field that has no defined graph shape (an unknown key, an origin with an extra key, `reach`) is REFUSED before any write: exit 3, UNSUPPORTED_POST_FIELDS, every offending id and key named, nothing written (not even the supported posts), and the refusal comes BEFORE the executor is contacted', { skip: SKIP }, async () => {
  const plain = makePosts(2);
  const odd = [
    { ...makePosts(1, { from: 21 })[0], origin: { mutationId: 'm-x', slot: 'claim', actor: 'ada' } },            // an origin with a key beyond mutationId, slot and occurredAt
    { ...makePosts(1, { from: 22 })[0], mystery: 1 },
    { ...makePosts(1, { from: 24 })[0], reach: { yourStreamOpen: true } },
    { ...makePosts(1, { from: 25 })[0], mystery: 2, _x: 3 },
  ];
  const keys = [['origin'], ['mystery'], ['reach'], ['mystery', '_x']];   // U5 (decision f4940204): the author-correction trail is no longer refused; it is stored as provenance literals (backfill-posts-r0-u5.test.mjs)
  const file = writeBoard(boardFor([...plain, ...odd])); const before = fs.readFileSync(file);
  await withExec(async ({ exec, proxy, url }) => {
    const r = await runTool(file, url);
    assert.equal(r.code, 3, `unsupported posts are refused with exit 3: ${r.said}`);
    assert.match(r.said, /UNSUPPORTED_POST_FIELDS/);
    odd.forEach((o, i) => { assert.ok(r.said.includes(o.id), `the offending id ${o.id} must be listed:\n${r.said}`); for (const k of keys[i]) assert.ok(r.said.includes(k), `the offending key ${k} must be named for ${o.id}`); });
    for (const p of plain) assert.ok(!r.said.includes(p.id), `a supported post (${p.id}) is not listed as offending`);
    assert.equal(proxy.updates, 0, 'nothing was written, not even the supported posts');
    assert.deepEqual(await commentIds(exec), []);
    assert.deepEqual(fs.readFileSync(file), before);
    const dead = await runTool(file, 'http://127.0.0.1:9');
    assert.equal(dead.code, 3, `refused on the board alone, before the executor is contacted (a dead executor must not turn it into an operational failure): ${dead.said}`);
    assert.match(dead.said, /UNSUPPORTED_POST_FIELDS/);
  });
});
test('R11b the ORDER of refusals: an unmigrated board that ALSO carries unsupported fields is refused for its migration state first (POST_SEQ_MIGRATION_REQUIRED), and empty `attachments: []` / null `onBehalfOf` / null `attachedTo` import (the settled fixtures run)', { skip: SKIP }, async () => {
  const unnumberedOdd = makePosts(4).map(({ postSeq, ...p }, i) => (i === 1 ? { ...p, mystery: 1 } : p));
  await withExec(async ({ proxy, url }) => {
    const r = await runTool(writeBoard(makeBoardFixture({ conversations: unnumberedOdd })), url);
    assert.equal(r.code, 3, r.said); assert.match(r.said, /POST_SEQ_MIGRATION_REQUIRED/); assert.doesNotMatch(r.said, /UNSUPPORTED_POST_FIELDS/);
    assert.equal(proxy.updates, 0);
    const ok = makePosts(3).map((p) => ({ ...p, attachments: [], onBehalfOf: null }));
    assert.equal((await runTool(writeBoard(boardFor(ok)), url)).code, 0, 'empty attachments and a null onBehalfOf are nothing to carry');
  });
});

// ------------------------------------------------------------------ refusals
test('R8 an UNMIGRATED board is refused: exit 3, POST_SEQ_MIGRATION_REQUIRED, zero writes, an empty graph (R0 never numbers anything)', { skip: SKIP }, async () => {
  const unnumbered = makePosts(N).map(({ postSeq, ...p }) => p);
  const file = writeBoard(makeBoardFixture({ conversations: unnumbered })); const before = fs.readFileSync(file);
  await withExec(async ({ exec, proxy, url }) => {
    const r = await runTool(file, url);
    assert.equal(r.code, 3, r.said); assert.match(r.said, /POST_SEQ_MIGRATION_REQUIRED/);
    assert.equal(proxy.updates, 0); assert.deepEqual(await commentIds(exec), []);
    assert.deepEqual(fs.readFileSync(file), before);
  });
});
test('R9 a CORRUPT board is refused: exit 3, POST_SEQ_STATE_CORRUPT, zero writes (mixed numbering with no epoch; an epoch with a post un-numbered; a duplicate)', { skip: SKIP }, async () => {
  const p = makePosts(6);
  const boards = [
    makeBoardFixture({ conversations: [p[0], ...p.slice(1).map(({ postSeq, ...x }) => x)] }),
    boardFor([p[0], { ...p[1], postSeq: undefined }, p[2]]),
    boardFor([p[0], { ...p[1], postSeq: 1 }]),
  ];
  await withExec(async ({ exec, proxy, url }) => {
    for (const b of boards) {
      const r = await runTool(writeBoard(JSON.parse(JSON.stringify(b))), url);
      assert.equal(r.code, 3, r.said); assert.match(r.said, /POST_SEQ_STATE_CORRUPT/);
    }
    assert.equal(proxy.updates, 0); assert.deepEqual(await commentIds(exec), []);
  });
});
test('R10 a WRONG dataset id, and an executor that cannot be reached: exit 2 (an operational failure), and no post is reported written', { skip: SKIP }, async () => {
  const file = writeBoard(boardFor(makePosts(4)));
  await withExec(async ({ exec, url }) => {
    const wrong = await runTool(file, url, { dataset: 'some-other-dataset' });
    assert.equal(wrong.code, 2, `wrong dataset: an operational failure exits 2: ${wrong.said}`);
    assert.ok(!wrong.summary || wrong.summary.written === 0, 'nothing reported written');
    assert.deepEqual(await commentIds(exec), []);
    const dead = await runTool(file, 'http://127.0.0.1:9');
    assert.equal(dead.code, 2, `unreachable executor: exit 2: ${dead.said}`);
    assert.ok(!dead.summary || dead.summary.written === 0);
    // the SAME command line with the right dataset and a live executor works: so the failures above were about the dataset and the executor,
    // not about a tool that fails on everything (without this, a missing tool passes the two rows above vacuously)
    const ok = await runTool(file, url);
    assert.equal(ok.code, 0, ok.said); assert.equal(ok.summary.written, 4);
  });
});

// ------------------------------------------------------------------ NOT FROZEN (visible as todo, never as a pass)
const UNFROZEN = 'UNFROZEN: decided with the shape of ordinary writes (R2) and the cutover reconciliation; nothing in this file invents it';
test('U5 a post REMOVED or REDACTED after the snapshot: the backfill must never resurrect redacted content, and the final cutover reconciliation must DETECT removals (R4 owns redaction; the interface is not defined)', { todo: UNFROZEN }, () => assert.fail(UNFROZEN));
test('U6 a PRODUCTION graph that already holds executor-born posts: "no other Comment node" does not hold there; what R0 must leave alone is not defined', { todo: UNFROZEN }, () => assert.fail(UNFROZEN));
