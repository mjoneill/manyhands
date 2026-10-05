/**
 * R0 ADDENDUM — four rows the frozen R0 file (sha256 08445b8c…fd7b) does not contain, found by reading the build 82563e2 and then by mutating it.
 * Copy beside the frozen file in tests/; the frozen file is untouched.
 *
 *   A1 the STORED postSeq is copied, never regenerated: every frozen fixture numbers its posts 1..n in array order, so a build that renumbered by
 *      array index (or by sorting) passed every frozen row. Here the numbers have gaps and the array order is NOT the numeric order.
 *   A2 a write the executor REFUSES is an operational failure, not something to skip: exit 2, `failed` counts it, the run STOPS (it does not go on
 *      writing the rest), nothing is claimed written, and the same command succeeds once writes work.
 *   A3 an operation's RECEIPT that cannot be READ is an operational failure (exit 2, zero writes), NOT the named `receipt-without-node` conflict:
 *      an unreadable receipt is not a receipt (a room ruling; the frozen R13 fails every read at once, so the first read fails before any receipt is asked).
 *   A5 a post whose `mentions` list a name TWICE is stored once (the graph holds a SET of mention triples), so a re-run must still see it as
 *      PRESENT: not a `content-differs` conflict against itself (found as a review gap: the comparison counted the duplicate).
 *   A6 the refusal for unsupported fields names EVERY offending id, however many (60 here): no cap, no "and N more"; a separate inventory file is not a
 *      substitute for the tool's own report.
 *   A4 `--limit N` counts posts WRITTEN: a resume with `--limit 3` over a graph that already holds five of the posts writes three more and reports
 *      five alreadyPresent (what is present is skipped, not counted against the limit).
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
  const r = await client(exec).query(`SELECT ?p ?o WHERE { <${ENTITY}${id}> ?p ?o }`);
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
  const p = { updates: 0, arrivedHeld: null, failReads: false, failUpdates: false, failReceipts: false };
  let arrive; p.held = new Promise((r) => { arrive = r; });
  p.server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const isUpdate = req.method === 'POST' && req.url === '/update';
    if (p.failReads && !isUpdate) { try { res.statusCode = 503; res.setHeader('Content-Type', 'application/json'); res.end('{"error":"proxy-injected read failure"}'); } catch { /* gone */ } return; }
    if (p.failReceipts && req.method === 'GET' && req.url.startsWith('/receipt/')) { try { res.statusCode = 503; res.setHeader('Content-Type', 'application/json'); res.end('{"error":"proxy-injected receipt failure"}'); } catch { /* gone */ } return; }
    if (p.failUpdates && isUpdate) { p.updates++; try { res.statusCode = 500; res.setHeader('Content-Type', 'application/json'); res.end('{"error":"proxy-injected write failure"}'); } catch { /* gone */ } return; }
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


test('A1 the stored postSeq is copied exactly: gaps and an array order that is not the numeric order survive (never renumbered by index, never sorted)', { skip: SKIP }, async () => {
  const seqs = [7, 3, 12, 40, 41, 9];
  const posts = makePosts(6).map((p, i) => ({ ...p, postSeq: seqs[i] }));
  const file = writeBoard(boardFor(posts));
  await withExec(async ({ exec, url }) => {
    const r = await runTool(file, url);
    assert.equal(r.code, 0, r.said);
    for (const p of posts) assert.deepEqual((await nodeTriples(exec, p.id))[`${NS}postSeq`], [`literal|${p.postSeq}|${XSD_INT}`], `${p.id} keeps its stored number ${p.postSeq}`);
  });
});
test('A2 a write the executor refuses: exit 2, failed >= 1, the run STOPS at it (it does not keep writing), nothing is reported written, and the same command succeeds once writes work', { skip: SKIP }, async () => {
  const file = writeBoard(boardFor(makePosts(8)));
  await withExec(async ({ exec, proxy, url }) => {
    proxy.failUpdates = true;
    const r = await runTool(file, url);
    assert.equal(r.code, 2, r.said);
    assert.ok(r.summary && r.summary.failed >= 1, `failed is counted: ${r.out}`);
    assert.equal(r.summary.written, 0);
    assert.equal(proxy.updates, 1, `it stopped at the first refused write instead of going on: ${proxy.updates} updates`);
    assert.deepEqual(await commentIds(exec), []);
    proxy.failUpdates = false;
    const ok = await runTool(file, url);
    assert.equal(ok.code, 0, ok.said); assert.equal(ok.summary.written, 8);
  });
});
test('A3 an operation\'s receipt that cannot be READ is exit 2 with zero writes, not the receipt-without-node conflict', { skip: SKIP }, async () => {
  const file = writeBoard(boardFor(makePosts(5)));
  await withExec(async ({ exec, proxy, url }) => {
    proxy.failReceipts = true;
    const r = await runTool(file, url);
    assert.equal(r.code, 2, `an unreadable receipt is an operational failure: ${r.said}`);
    assert.ok(!r.summary || (r.summary.conflicts || []).length === 0, 'and never reported as a conflict');
    assert.equal(proxy.updates, 0, 'no write on the strength of a receipt it could not read');
    assert.deepEqual(await commentIds(exec), []);
    proxy.failReceipts = false;
    assert.equal((await runTool(file, url)).code, 0, 'the same command succeeds once receipts can be read');
  });
});
test('A4 --limit counts posts WRITTEN: a resume with --limit 3 over five already-present posts writes three more and reports five alreadyPresent', { skip: SKIP }, async () => {
  const file = writeBoard(boardFor(makePosts(N)));
  await withExec(async ({ exec, url }) => {
    assert.equal((await runTool(file, url, { extra: ['--limit', '5'] })).summary.written, 5);
    const r = await runTool(file, url, { extra: ['--limit', '3'] });
    assert.equal(r.code, 0, r.said);
    assert.deepEqual([r.summary.written, r.summary.alreadyPresent], [3, 5], 'present posts are skipped, not counted against the limit');
    assert.equal((await commentIds(exec)).length, 8);
  });
});

test('A5 a post that lists the same mention twice is PRESENT on a re-run, not a conflict with itself', { skip: SKIP }, async () => {
  const posts = makePosts(6).map((p, i) => (i === 2 ? { ...p, mentions: ['bea', 'bea', 'cy'] } : p));
  const file = writeBoard(boardFor(posts));
  await withExec(async ({ exec, proxy, url }) => {
    const a = await runTool(file, url);
    assert.equal(a.code, 0, a.said); assert.equal(a.summary.written, 6);
    const sent = proxy.updates;
    const b = await runTool(file, url);
    assert.equal(b.code, 0, `a re-run must not report a conflict against a post it wrote itself: ${b.said}`);
    assert.deepEqual([b.summary.written, b.summary.alreadyPresent, b.summary.conflicts], [0, 6, []]);
    assert.equal(proxy.updates, sent, 'and sends nothing');
    assert.deepEqual((await nodeTriples(exec, posts[2].id))[`${NS}mentionsName`], ['literal|bea|', 'literal|cy|'], 'the graph holds the mentions as a set');
  });
});
test('A6 the unsupported-fields refusal names EVERY offending post (60 of them), with no cap and no "and N more"', { skip: SKIP }, async () => {
  const odd = Array.from({ length: 60 }, (_, k) => ({ ...makePosts(1, { from: 100 + k })[0], mystery: k }));
  const file = writeBoard(boardFor([...makePosts(3), ...odd]));
  await withExec(async ({ proxy, url }) => {
    const r = await runTool(file, url);
    assert.equal(r.code, 3, r.said); assert.match(r.said, /UNSUPPORTED_POST_FIELDS/);
    const missing = odd.filter((o) => !r.said.includes(o.id)).map((o) => o.id);
    assert.deepEqual(missing, [], `every offending id must be listed; missing ${missing.length}`);
    assert.doesNotMatch(r.said, /and \d+ more/i, 'no truncation marker');
    assert.equal(proxy.updates, 0);
  });
});
