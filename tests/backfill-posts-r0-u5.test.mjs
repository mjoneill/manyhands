/**
 * R0, U5: THE AUTHOR-CORRECTION TRAIL IS STORED (#1574; the owner's decision f4940204, 2026-10-05). Pre-registered by the separate test author BEFORE the build.
 * Copy beside the R0 files in tests/. REAL executor, the REAL forward backfill (`scripts/backfill-posts-r0.mjs`); without a python with pyoxigraph every test is
 * SKIPPED, and a skip is NOT a pass. Synthetic content only.
 *
 * WHAT IS DECIDED: one post in the live document carries three fields from a data repair (an author name that unescaped markup had wrapped in stray HTML
 * characters was corrected): `_originalAuthorToken` (the broken original, a STRING, not a credential: established from the repair's own commit history),
 * `_authorCorrectedAt` (when) and `_authorCorrectedBy` (a seat name). Until now the backfill refused the whole run because of them. The owner's call: keep them in
 * the graph as plain RECORD, the post's `author` staying the corrected name, never reinterpreted as an actor or as authority.
 *
 * This file REPLACES the refusal of the trail that R11 (backfill-posts-r0.test.mjs) and S5 (backfill-posts-r0-shape.test.mjs) pinned: those two files are
 * re-issued without it (hashes in the message that carries this file). Everything else those rows pin stays: an unknown key and an `origin` with an extra key
 * still refuse the whole run.
 *
 *   U5a THE TRAIL IS STORED: a board whose posts include one carrying the three fields (strings) imports completely: exit 0, every post written, none refused,
 *       none conflicting. The post's node has its CURRENT author as the `author` triple (an IRI of the corrected name), every ordinary predicate exactly as for any
 *       post, and EXACTLY the three values as extra literals (nothing else added besides the provenance link). The original token and the corrector appear on the
 *       node only as LITERALS: no triple of that node has an IRI object naming either of them (a provenance string is not an actor), and the token's value is
 *       never printed by the tool.
 *   U5b IDEMPOTENT: a second run of the same command is `alreadyPresent` for every post, writes nothing (the executor sees no update) and names no conflict. (A
 *       comparison that does not know about the three literals reads the stored post as "different" and calls it a `content-differs` conflict against itself.)
 *   U5c A MALFORMED TRAIL STILL REFUSES: a trail field that is not a string (an object, a number) refuses the whole run before any write: exit 3,
 *       UNSUPPORTED_POST_FIELDS, the offending id and the key named, the value never printed, nothing written.
 *   U5d THE TRAIL IS NO LONGER AN OFFENDER: a board with a valid trail post AND a post with an unknown key refuses (exit 3) naming ONLY the unknown-key post; the
 *       trail post's id is not listed.
 *
 * NOT COVERED, by name: a post carrying only SOME of the three fields (not decided: a partial trail is neither pinned as stored nor as refused); how the post
 * READ shows the trail (the unit-on read need not expose it); the round trip through the ROLLBACK export (the rollback keeps a document post untouched; once that
 * script exists, a row confirming the three fields survive it is owed, and is a todo below, visible and not a pass); and the executor's own handling of the
 * extra predicates beyond what the compiler writes.
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
const DSID = 'u5-test';
const ENTITY = 'https://scrumboard.local/entity/', PERSON = 'https://scrumboard.local/person/', NS = 'https://scrumboard.local/ns#', SCHEMA = 'https://schema.org/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', XSD_INT = 'http://www.w3.org/2001/XMLSchema#integer';
const EPOCH = '11111111-2222-4333-8444-555555555555';
const TOKEN = 'u5tok">u5tok';                       // a synthetic malformed original author string
const STAMP = '2026-07-31T21:10:00Z';
const CORRECTOR = 'cy';

const uuid = (n) => { const h = crypto.createHash('sha1').update(`u5:${n}`).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; };
function makePosts(n, { from = 1 } = {}) {
  const authors = ['ada', 'bea', 'board', 'cy', 'ada'];
  return Array.from({ length: n }, (_, k) => { const i = from + k; return { id: uuid(i), body: `post ${i}`, author: authors[i % authors.length], attachedTo: null, attachments: [], mentions: [], createdAt: new Date(Date.UTC(2026, 9, 1, 12, 0, i)).toISOString(), postSeq: i }; });
}
const withTrail = (p, over = {}) => ({ ...p, _originalAuthorToken: TOKEN, _authorCorrectedAt: STAMP, _authorCorrectedBy: CORRECTOR, ...over });
const boardFor = (posts) => makeBoardFixture({ conversations: posts, postSeqEpoch: EPOCH, nextPostSeq: Math.max(0, ...posts.map((p) => p.postSeq)) + 1 });
const writeBoard = (board) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'u5-')); const f = path.join(d, 'board.json'); fs.writeFileSync(f, JSON.stringify(board, null, 2)); return f; };
const client = (exec) => createGraphClient({ baseUrl: exec.baseUrl, expectedDatasetId: DSID });
async function nodeTriples(exec, id) {
  const r = await client(exec).query(`SELECT ?p ?o WHERE { <${ENTITY}${id}> ?p ?o }`);
  assert.equal(r.ok, true, JSON.stringify(r));
  const out = {}; for (const b of r.rows) (out[b.p.value] ||= []).push(`${b.o.type}|${b.o.value}|${b.o.datatype || ''}`);
  for (const k of Object.keys(out)) out[k].sort();
  return out;
}
function expectedTriples(p) {
  const e = { [RDF_TYPE]: [`uri|${SCHEMA}Comment|`], [`${SCHEMA}text`]: [`literal|${p.body}|`], [`${SCHEMA}author`]: [`uri|${PERSON}${p.author}|`], [`${SCHEMA}dateCreated`]: [`literal|${p.createdAt}|`], [`${NS}postSeq`]: [`literal|${p.postSeq}|${XSD_INT}`] };
  if (p.mentions.length) e[`${NS}mentionsName`] = p.mentions.map((m) => `literal|${m}|`).sort();
  return e;
}
/** A counting pass-through proxy in front of the executor: every POST /update is counted. */
async function startProxy(execUrl) {
  const p = { updates: 0 };
  p.server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    if (req.method === 'POST' && req.url === '/update') p.updates++;
    const fwd = { ...req.headers }; delete fwd.host; delete fwd['content-length']; delete fwd.connection;
    try { const f = await fetch(`${execUrl}${req.url}`, { method: req.method, headers: fwd, ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) }); const t = await f.text(); res.statusCode = f.status; res.end(t); }
    catch { try { req.socket.destroy(); } catch { /* gone */ } }
  });
  await new Promise((r) => p.server.listen(0, '127.0.0.1', r)); p.url = `http://127.0.0.1:${p.server.address().port}`;
  p.stop = () => new Promise((r) => { p.server.closeAllConnections?.(); p.server.close(() => r()); });
  return p;
}
function runTool(boardFile, executorUrl) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TOOL, '--board-file', boardFile, '--executor-url', executorUrl, '--dataset-id', DSID], { cwd: PROJECT_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 60000);
    child.on('close', (code) => { clearTimeout(timer); let summary = null; for (const l of out.split('\n').reverse()) { const t = l.trim(); if (t.startsWith('{')) { try { summary = JSON.parse(t); break; } catch { /* not json */ } } } resolve({ code, out, err, summary, said: `${out}\n${err}` }); });
  });
}
async function withExec(body) {
  const exec = await startExecutor({ store: tmpStore('u5-store-'), datasetId: DSID, create: true });
  const proxy = await startProxy(exec.baseUrl);
  try { return await body({ exec, proxy, url: proxy.url }); } finally { await proxy.stop(); await killExecutor(exec); }
}

test('U5a THE TRAIL IS STORED: the run is complete, the post keeps its current author as the author triple, every ordinary predicate, and exactly the three values as extra literals, never as IRIs', { skip: SKIP }, async () => {
  const plain = makePosts(6); const trail = withTrail(makePosts(1, { from: 7 })[0]);
  const file = writeBoard(boardFor([...plain, trail]));
  await withExec(async ({ exec, url }) => {
    const r = await runTool(file, url);
    assert.equal(r.code, 0, `the run completes: ${r.said}`);
    assert.deepEqual([r.summary.posts, r.summary.written, r.summary.alreadyPresent, r.summary.failed, r.summary.conflicts], [7, 7, 0, 0, []], JSON.stringify(r.summary));
    assert.ok(!r.said.includes('u5tok'), 'the token\'s value is never printed');
    const got = await nodeTriples(exec, trail.id);
    const want = expectedTriples(trail);
    for (const [pred, vals] of Object.entries(want)) assert.deepEqual(got[pred], vals, `${pred}: exactly as for any post`);
    assert.deepEqual(got[`${SCHEMA}author`], [`uri|${PERSON}${trail.author}|`], 'the author is the CURRENT name, an IRI');
    const extraPreds = Object.keys(got).filter((p) => !(p in want) && p !== 'urn:ex:recordedBy');
    const extraObjects = extraPreds.flatMap((p) => got[p]).sort();
    assert.deepEqual(extraObjects, [`literal|${TOKEN}|`, `literal|${STAMP}|`, `literal|${CORRECTOR}|`].sort(), `exactly the three values as literals and nothing else (extra predicates: ${JSON.stringify(extraPreds)})`);
    assert.ok(extraPreds.length >= 1 && extraPreds.length <= 3, 'under one to three predicates');
    const allObjects = Object.values(got).flat();
    assert.ok(!allObjects.some((o) => o.startsWith('uri|') && (o.includes(`/person/${CORRECTOR}`) || o.includes('u5tok'))), `no IRI names the corrector or the token: a provenance string is not an actor (${JSON.stringify(allObjects.filter((o) => o.startsWith('uri|')))})`);
    for (const p of plain) assert.deepEqual(Object.keys(await nodeTriples(exec, p.id)).filter((k) => !(k in expectedTriples(p)) && k !== 'urn:ex:recordedBy'), [], `${p.id}: an ordinary post gains nothing`);
  });
});

test('U5b IDEMPOTENT: a second run is alreadyPresent for every post, writes nothing and names no conflict', { skip: SKIP }, async () => {
  const posts = [...makePosts(6), withTrail(makePosts(1, { from: 7 })[0])];
  const file = writeBoard(boardFor(posts));
  await withExec(async ({ proxy, url }) => {
    assert.equal((await runTool(file, url)).code, 0);
    const before = proxy.updates;
    const r = await runTool(file, url);
    assert.equal(r.code, 0, r.said);
    assert.deepEqual([r.summary.posts, r.summary.written, r.summary.alreadyPresent, r.summary.failed, r.summary.conflicts], [7, 0, 7, 0, []], JSON.stringify(r.summary));
    assert.equal(proxy.updates, before, 'the executor saw no update');
  });
});

test('U5c A MALFORMED TRAIL STILL REFUSES: a trail field that is not a string (an object, a number) refuses the whole run before any write, the offending id and key named, the value never printed', { skip: SKIP }, async () => {
  const plain = makePosts(3);
  const bad = [withTrail(makePosts(1, { from: 4 })[0], { _authorCorrectedBy: { by: 'u5obj-value' } }), withTrail(makePosts(1, { from: 5 })[0], { _originalAuthorToken: 424242 })];
  const keys = [['_authorCorrectedBy'], ['_originalAuthorToken']];
  const file = writeBoard(boardFor([...plain, ...bad])); const before = fs.readFileSync(file);
  await withExec(async ({ exec, proxy, url }) => {
    const r = await runTool(file, url);
    assert.equal(r.code, 3, r.said); assert.match(r.said, /UNSUPPORTED_POST_FIELDS/);
    bad.forEach((b, i) => { assert.ok(r.said.includes(b.id), `${b.id} is named`); for (const k of keys[i]) assert.ok(r.said.includes(k), `${k} is named for ${b.id}`); });
    assert.ok(!r.said.includes('u5obj-value') && !r.said.includes('424242') && !r.said.includes('u5tok'), 'no value is printed');
    assert.equal(proxy.updates, 0, 'nothing was written'); assert.deepEqual(fs.readFileSync(file), before);
    for (const p of plain) assert.ok(!r.said.includes(p.id), 'a supported post is not listed');
  });
});

test('U5d THE TRAIL IS NO LONGER AN OFFENDER: a valid trail post and a post with an unknown key refuse the run naming only the unknown-key post', { skip: SKIP }, async () => {
  const plain = makePosts(3); const ok = withTrail(makePosts(1, { from: 4 })[0]); const odd = { ...makePosts(1, { from: 5 })[0], mystery: 1 };
  const file = writeBoard(boardFor([...plain, ok, odd]));
  await withExec(async ({ proxy, url }) => {
    const r = await runTool(file, url);
    assert.equal(r.code, 3, r.said); assert.match(r.said, /UNSUPPORTED_POST_FIELDS/);
    assert.ok(r.said.includes(odd.id) && r.said.includes('mystery'), 'the unknown-key post and its key are named');
    assert.ok(!r.said.includes(ok.id), `the trail post is not listed as an offender: ${r.said}`);
    assert.ok(!r.said.includes('_originalAuthorToken') && !r.said.includes('_authorCorrected'), 'and none of its keys is named');
    assert.equal(proxy.updates, 0, 'nothing written');
  });
});

test('U5e the three fields survive the ROLLBACK export (the document post stays as it is)', { todo: 'OWED once scripts/rollback-posts-1574.mjs exists: a row, not a pass' }, () => assert.fail('OWED'));
