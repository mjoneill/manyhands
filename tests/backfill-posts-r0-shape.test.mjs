/**
 * R0 SHAPE — the LOSSLESS round trip of every field a live post carries, against the FINAL U1–U4 vocabulary (owner: "go with your proposal"; builder's
 * final list; the reviewers' pins). Pre-registered by the separate test author BEFORE the build. Copy beside the frozen R0 file in tests/, together with
 * NO real board data: the file generates its own synthetic corpus with the MEASURED key-set distribution (the counts below), fake ids and fake times.
 * Real executor; without a python with pyoxigraph every test is SKIPPED and a skip is NOT a pass.
 *
 * ⚠ STILL NOT R0 COMPLETION: the tool refuses an `origin` with any key beyond mutationId, slot and occurredAt, or any other unknown key, and this file pins
 * those refusals. The author-correction trail (`_originalAuthorToken`, `_authorCorrectedAt`, `_authorCorrectedBy`) was refused in the previous version of this
 * file; the owner decided on 2026-10-05 (decision f4940204) to STORE it as provenance literals, and its rows moved to backfill-posts-r0-u5.test.mjs. Supporting
 * the fields does NOT authorise a live backfill.
 *
 * THE FIXTURE mirrors the MEASURED INVENTORY of 2026-10-05 (the live board's refused posts), not "today's board": one synthetic post per measured row with exactly
 * that row's key-set (conversation x163, attachments x80, _recovered x40, onBehalfOf x13, attachments+conversation x1, plus the one author-correction post, which
 * this file leaves out of its fixture: the U5 file pins it), with SYNTHETIC ids, times and content (nothing here is real board data; the repo is public). Attachments mirror the measured distribution (115 over
 * the 81 posts that have any, 14 posts with more than one).
 *
 * WRITE RULE, per post node <E/<id>> (E = https://scrumboard.local/entity/, NS = https://scrumboard.local/ns#):
 *   always: rdf:type schema:Comment · schema:text (an EMPTY body is "" and present) · schema:author <person/<a>> · schema:dateCreated · NS postSeq xsd:integer
 *   attachedTo -> schema:about <E/<id>> · mentions -> one NS mentionsName literal per DISTINCT name · conversation -> NS conversation <https://scrumboard.local/talk/<id>>
 *   onBehalfOf -> NS onBehalfOf "<name>" a LITERAL (never an IRI) · _recovered -> NS recovered "<string>" · attachments -> one node <E/<postId>/attachment/<k>>, k the
 *   0-based array index, carrying EXACTLY NS attachmentOf <post>, NS attachmentIndex k (xsd:integer), schema:identifier, schema:name, schema:encodingFormat,
 *   schema:contentSize (xsd:integer). The post->card reference is DERIVED and never stored. urn:ex:recordedBy (provenance) is outside the comparison.
 *   origin {mutationId, slot[, occurredAt]} -> NS originMutation, NS originSlot (literals) and NS originOccurredAt (a literal, ONLY when present; NO actor and
 *   no claim of an identical shape with the announcement node). Any OTHER key inside origin refuses the run (an originActor is never silently dropped).
 *   opId -> NS opId "<urn...>" a literal, verbatim (the idempotency key of a publisher-written post; distinct from recordedBy, the import operation).
 * READ-BACK RULE (implemented HERE as a pure function and asserted against the normalised original; R1's read must implement the same function):
 *   attachedTo absent -> null · mentions absent -> [] · attachments absent -> [] (else {id, mime, name, size} in index order) · onBehalfOf absent -> null
 *   conversation absent -> the key is ABSENT · _recovered present only when its triple is · origin absent -> the key is ABSENT, else {mutationId, slot} plus
 *   occurredAt only when present · opId present only when its triple is.
 * NORMALISATION, declared (this is NOT byte-lossless): onBehalfOf missing and null are not distinguished; a mention list becomes its DISTINCT names ordered by the
 *   index of the first case-sensitive occurrence of "@<name>" in the body, names with no occurrence last, ties and the unmatched sorted by code point.
 * NOT PINNED, BY NAME: the correction trail (refused); R1's reader itself; attachment BYTES (they stay on disk).
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

const NSV = NS, SC = SCHEMA;
const TALK = 'https://scrumboard.local/talk/';
// the MEASURED key-set distribution, with synthetic ids and times (sha1 of a fixed label, so the corpus is the same on every run)
const fakeId = (n) => { const h = crypto.createHash('sha1').update(`r0-shape:${n}`).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; };
const DISTRIBUTION = [['conversation', 163], ['attachments', 80], ['_recovered', 40], ['onBehalfOf', 13], ['attachments+conversation', 1], ['_authorCorrectedAt+_authorCorrectedBy+_originalAuthorToken', 1]];
const inventory = { rows: DISTRIBUTION.flatMap(([combo, n], c) => Array.from({ length: n }, (_, i) => ({ id: fakeId(`${c}:${i}`), createdAt: new Date(Date.UTC(2026, 4, 1) + (c * 1000 + i) * 3600000).toISOString(), keys: combo.split('+') }))) };
const CORRECTION = ['_authorCorrectedAt', '_authorCorrectedBy', '_originalAuthorToken'];
const supportedRows = inventory.rows.filter((r) => !r.keys.some((k) => CORRECTION.includes(k)));
const correctionRows = inventory.rows.filter((r) => r.keys.some((k) => CORRECTION.includes(k)));
const attachmentCount = (i, n) => (i < 8 ? 3 : i < 14 ? 4 : 1);              // 8x3 + 6x4 + (n-14)x1 = 115 over the 81 posts that have attachments
function synth(row, i, seq, attIdx) {
  const keys = new Set(row.keys);
  const p = { id: row.id, body: `synthetic body ${i} @bea and @cy ${i % 7 === 0 ? '' : 'plain text'}`, author: ['ada', 'bea', 'board', 'cy'][i % 4], attachedTo: null, attachments: [], mentions: i % 3 === 0 ? ['cy', 'bea'] : [], createdAt: row.createdAt, postSeq: seq };
  if (keys.has('conversation')) p.conversation = `talk-${(i % 9) + 1}`;
  if (keys.has('onBehalfOf')) p.onBehalfOf = ['ada', 'bea', 'cy'][i % 3];
  if (keys.has('_recovered')) p._recovered = `recovered-from-snapshot-${i}`;
  if (keys.has('attachments')) {
    const n = attachmentCount(attIdx.n++, 0);
    p.attachments = Array.from({ length: n }, (_, k) => ({ id: `att-${i}-${k}`, mime: k % 2 ? 'image/png' : 'application/pdf', name: `file ${i}-${k}.dat`, size: 1000 + i * 10 + k }));
  }
  return p;
}
const fixturePosts = () => { const idx = { n: 0 }; return supportedRows.map((r, i) => synth(r, i + 1, i + 1, idx)); };

// ---- the write rule, as the exact expected triple set (provenance excluded), and the read-back rule as a pure function
const lit = (v, dt = '') => `literal|${v}|${dt}`; const uri = (v) => `uri|${v}|`;
function normaliseMentions(body, mentions) {
  const names = [...new Set(mentions || [])];
  const at = (n) => { const i = body.indexOf(`@${n}`); return i < 0 ? Infinity : i; };
  const cp = (a, b) => { const x = [...a], y = [...b]; for (let i = 0; i < Math.min(x.length, y.length); i++) { const d = x[i].codePointAt(0) - y[i].codePointAt(0); if (d) return d; } return x.length - y.length; };
  return names.sort((a, b) => (at(a) === at(b) ? cp(a, b) : at(a) - at(b)));
}
function expectedPost(p) {
  const e = { [`${RDF_TYPE}`]: [uri(`${SC}Comment`)], [`${SC}text`]: [lit(p.body)], [`${SC}author`]: [uri(`${PERSON}${p.author}`)], [`${SC}dateCreated`]: [lit(p.createdAt)], [`${NSV}postSeq`]: [lit(p.postSeq, XSD_INT)] };
  if (p.attachedTo) e[`${SC}about`] = [uri(`${ENTITY}${p.attachedTo}`)];
  const ms = [...new Set(p.mentions || [])]; if (ms.length) e[`${NSV}mentionsName`] = ms.map((m) => lit(m)).sort();
  if (p.conversation !== undefined) e[`${NSV}conversation`] = [uri(`${TALK}${p.conversation}`)];
  if (p.onBehalfOf != null) e[`${NSV}onBehalfOf`] = [lit(p.onBehalfOf)];
  if (p._recovered !== undefined) e[`${NSV}recovered`] = [lit(p._recovered)];
  if (p.opId !== undefined) e[`${NSV}opId`] = [lit(p.opId)];
  if (p.origin !== undefined) { e[`${NSV}originMutation`] = [lit(p.origin.mutationId)]; e[`${NSV}originSlot`] = [lit(p.origin.slot)]; if (p.origin.occurredAt !== undefined) e[`${NSV}originOccurredAt`] = [lit(p.origin.occurredAt)]; }
  return e;
}
const expectedAttachment = (p, a, k) => ({ [`${NSV}attachmentOf`]: [uri(`${ENTITY}${p.id}`)], [`${NSV}attachmentIndex`]: [lit(k, XSD_INT)], [`${SC}identifier`]: [lit(a.id)], [`${SC}name`]: [lit(a.name)], [`${SC}encodingFormat`]: [lit(a.mime)], [`${SC}contentSize`]: [lit(a.size, XSD_INT)] });
const attIri = (id, k) => `${ENTITY}${id}/attachment/${k}`;
async function triplesOf(exec, iri) { const t = await nodeTriples(exec, iri.slice(ENTITY.length)); delete t['urn:ex:recordedBy']; return t; }
async function attachmentNodes(exec, id) {
  const r = await client(exec).query(`SELECT ?s ?p ?o WHERE { ?s ?p ?o FILTER(STRSTARTS(STR(?s), ${JSON.stringify(`${ENTITY}${id}/attachment/`)})) }`);
  assert.equal(r.ok, true, JSON.stringify(r));
  const by = {}; for (const b of r.rows) { if (b.p.value === 'urn:ex:recordedBy') continue; ((by[b.s.value] ||= {})[b.p.value] ||= []).push(`${b.o.type}|${b.o.value}|${b.o.datatype || ''}`); }
  for (const s of Object.values(by)) for (const k of Object.keys(s)) s[k].sort(); return by;
}
/** THE READ-BACK RULE as a pure function over the triples the executor holds for a post and its attachment nodes. */
function reconstruct(id, node, atts) {
  const one = (p) => (node[p] ? node[p][0].split('|') : null);
  const v = (p) => (one(p) ? one(p)[1] : undefined);
  const out = { id, body: v(`${SC}text`), author: v(`${SC}author`).slice(PERSON.length), createdAt: v(`${SC}dateCreated`), postSeq: Number(v(`${NSV}postSeq`)),
    attachedTo: node[`${SC}about`] ? v(`${SC}about`).slice(ENTITY.length) : null,
    mentions: normaliseMentions(v(`${SC}text`), (node[`${NSV}mentionsName`] || []).map((x) => x.split('|')[1])),
    onBehalfOf: node[`${NSV}onBehalfOf`] ? v(`${NSV}onBehalfOf`) : null,
    attachments: Object.entries(atts).map(([iri, a]) => ({ k: Number(a[`${NSV}attachmentIndex`][0].split('|')[1]), id: a[`${SC}identifier`][0].split('|')[1], mime: a[`${SC}encodingFormat`][0].split('|')[1], name: a[`${SC}name`][0].split('|')[1], size: Number(a[`${SC}contentSize`][0].split('|')[1]) })).sort((x, y) => x.k - y.k).map(({ k, ...r }) => r) };
  if (node[`${NSV}conversation`]) out.conversation = v(`${NSV}conversation`).slice(TALK.length);
  if (node[`${NSV}recovered`]) out._recovered = v(`${NSV}recovered`);
  if (node[`${NSV}opId`]) out.opId = v(`${NSV}opId`);
  if (node[`${NSV}originMutation`]) out.origin = { mutationId: v(`${NSV}originMutation`), slot: v(`${NSV}originSlot`), ...(node[`${NSV}originOccurredAt`] ? { occurredAt: v(`${NSV}originOccurredAt`) } : {}) };
  return out;
}
const normalised = (p) => { const o = { id: p.id, body: p.body, author: p.author, createdAt: p.createdAt, postSeq: p.postSeq, attachedTo: p.attachedTo ?? null, mentions: normaliseMentions(p.body, p.mentions), onBehalfOf: p.onBehalfOf ?? null, attachments: (p.attachments || []).map(({ id, mime, name, size }) => ({ id, mime, name, size })) }; if (p.conversation !== undefined) o.conversation = p.conversation; if (p._recovered !== undefined) o._recovered = p._recovered; if (p.opId !== undefined) o.opId = p.opId; if (p.origin !== undefined) o.origin = { ...p.origin }; return o; };

// ---- an edge corpus: every normalisation and ordering rule, in a few posts
function edgePosts() {
  const base = (i, extra) => ({ id: `edge-${String(i).padStart(2, '0')}`, body: 'b', author: 'ada', attachedTo: null, attachments: [], mentions: [], createdAt: `2026-09-01T00:00:${String(i).padStart(2, '0')}.000Z`, postSeq: i, ...extra });
  const att = (n) => Array.from({ length: n }, (_, k) => ({ id: `a${k}`, mime: 'image/png', name: `n${k}`, size: k + 1 }));
  return [
    base(1, { body: '' }),                                                                   // an empty body is "" and PRESENT
    base(2, { body: 'hello @zed then @amy then @bob', mentions: ['bob', 'zed', 'amy', 'amy'] }),   // duplicates collapse; order = first occurrence in the body
    base(3, { body: 'no mentions in sight', mentions: ['zeta', 'alpha', 'éclair'] }),          // unmatched names last, by code point
    base(4, { body: '@ab and later @abc', mentions: ['abc', 'ab'] }),                           // a shared first-occurrence index is a tie, broken by code point
    base(5, { body: 'x', attachments: att(12) }),                                              // index >= 10 stays in NUMERIC order
    base(6, { body: 'x', onBehalfOf: null }),                                                    // null and a missing key are the same declared normalisation
    base(7, { body: 'x', attachedTo: 'card-9' }),
    base(8, { body: '@Bea and @bea', mentions: ['bea', 'Bea'] }),                                 // the match is case-SENSITIVE
    base(9, { body: 'x', conversation: 'talk-9', _recovered: 'r', onBehalfOf: 'cy', attachments: att(2) }),
    base(10, { body: 'claimed', origin: { mutationId: 'm-1', slot: 'claim' } }),                       // a legacy-mode notice: NO occurredAt, so no originOccurredAt triple
    base(11, { body: 'claimed', origin: { mutationId: 'm-2', slot: 'release', occurredAt: '2026-09-01T00:00:11.000Z' }, opId: 'urn:ex:op/announce/m-2/release' }),   // a document-path notice
  ];
}
const stripMissing = (posts) => posts.map((p, i) => (i === 5 ? (({ onBehalfOf, ...r }) => r)(p) : p));

// ---------------------------------------------------------------------------------- the rows
test('S1 THE MEASURED INVENTORY IMPORTS: every inventory row (minus the one author-correction post, pinned by the U5 file) becomes a node; the run is complete, exit 0, none refused, none conflicting', { skip: SKIP }, async () => {
  const posts = fixturePosts(); const file = writeBoard(boardFor(posts, {}));
  await withExec(async ({ exec, url }) => {
    const r = await runTool(file, url, { timeoutMs: 180000 });
    assert.equal(r.code, 0, r.said);
    assert.deepEqual([r.summary.posts, r.summary.written, r.summary.alreadyPresent, r.summary.failed, r.summary.conflicts], [posts.length, posts.length, 0, 0, []]);
    assert.equal((await commentIds(exec)).length, posts.length, 'one Comment node per post; attachments are NOT Comments');
    assert.ok(posts.length >= 290, `the fixture really is the measured inventory (${posts.length} posts)`);
    assert.equal(posts.reduce((n, p) => n + p.attachments.length, 0), 115 - 0, 'the attachment distribution matches the measurement: 115');
  });
});

test('S2 THE WRITE RULE, exactly: every post node and every attachment node carries EXACTLY the pinned predicates and values, for the whole inventory', { skip: SKIP }, async () => {
  const posts = fixturePosts(); const file = writeBoard(boardFor(posts, {}));
  await withExec(async ({ exec, url }) => {
    assert.equal((await runTool(file, url, { timeoutMs: 180000 })).code, 0);
    for (const p of posts) {
      const want = expectedPost(p); for (const k of Object.keys(want)) want[k].sort();
      assert.deepEqual(await triplesOf(exec, `${ENTITY}${p.id}`), want, `post ${p.id}`);
      const got = await attachmentNodes(exec, p.id);
      assert.deepEqual(Object.keys(got).sort(), p.attachments.map((_, k) => attIri(p.id, k)).sort(), `${p.id}: one node per attachment, IRI by array index`);
      p.attachments.forEach((a, k) => { const w = expectedAttachment(p, a, k); for (const x of Object.keys(w)) w[x].sort(); assert.deepEqual(got[attIri(p.id, k)], w, `${p.id} attachment ${k}`); });
    }
  });
});

test('S3 THE ROUND TRIP: reading the triples back with the pinned read-back rule gives exactly the NORMALISED original, for the whole inventory AND the edge corpus (empty body, duplicate and unmatched mentions, a shared first-occurrence tie, a case-sensitive match, 12 attachments in numeric index order, a missing onBehalfOf key)', { skip: SKIP }, async () => {
  const posts = [...fixturePosts(), ...stripMissing(edgePosts()).map((p, i) => ({ ...p, postSeq: 100000 + i }))];
  const file = writeBoard(boardFor(posts, {}));
  await withExec(async ({ exec, url }) => {
    const r = await runTool(file, url, { timeoutMs: 180000 }); assert.equal(r.code, 0, r.said);
    for (const p of posts) {
      const back = reconstruct(p.id, await triplesOf(exec, `${ENTITY}${p.id}`), await attachmentNodes(exec, p.id));
      assert.deepEqual(back, normalised(p), `${p.id}`);
    }
    const e2 = reconstruct('edge-02', await triplesOf(exec, `${ENTITY}edge-02`), {}); assert.deepEqual(e2.mentions, ['zed', 'amy', 'bob'], 'first-occurrence order, duplicates collapsed');
    const e3 = reconstruct('edge-03', await triplesOf(exec, `${ENTITY}edge-03`), {}); assert.deepEqual(e3.mentions, ['alpha', 'zeta', 'éclair'], 'unmatched names last, by code point');
    assert.equal((await triplesOf(exec, `${ENTITY}edge-01`))[`${SC}text`][0], lit(''), 'an empty body is "" and present');
    const e5 = reconstruct('edge-05', await triplesOf(exec, `${ENTITY}edge-05`), await attachmentNodes(exec, 'edge-05')); assert.deepEqual(e5.attachments.map((a) => a.id), Array.from({ length: 12 }, (_, k) => `a${k}`), 'index 10 and 11 follow 9, not 1');
  });
});

test('S4 IDEMPOTENT AND DIVERGENCE-AWARE ON THE NEW FIELDS: a re-run is all alreadyPresent with ZERO writes, and a change to ONE new-field value (an attachment size or name, a conversation tag, an onBehalfOf name, a _recovered string, an attachment ADDED) after the snapshot is a NAMED content-differs conflict, never overwritten', { skip: SKIP }, async () => {
  const posts = fixturePosts(); const file = writeBoard(boardFor(posts, {}));
  await withExec(async ({ exec, proxy, url }) => {
    assert.equal((await runTool(file, url, { timeoutMs: 180000 })).code, 0);
    const sent = proxy.updates;
    const again = await runTool(file, url, { timeoutMs: 180000 });
    assert.equal(again.code, 0, again.said); assert.deepEqual([again.summary.written, again.summary.alreadyPresent], [0, posts.length]); assert.equal(proxy.updates, sent, 'zero writes');
    const withAtt = posts.findIndex((p) => p.attachments.length), withConv = posts.findIndex((p) => p.conversation !== undefined), withOb = posts.findIndex((p) => p.onBehalfOf != null), withRec = posts.findIndex((p) => p._recovered !== undefined);
    const edits = [
      ['an attachment size', withAtt, (p) => ({ ...p, attachments: p.attachments.map((a, k) => (k === 0 ? { ...a, size: a.size + 1 } : a)) })],
      ['an attachment name', withAtt, (p) => ({ ...p, attachments: p.attachments.map((a, k) => (k === 0 ? { ...a, name: `${a.name}!` } : a)) })],
      ['an attachment added', withAtt, (p) => ({ ...p, attachments: [...p.attachments, { id: 'extra', mime: 'x/y', name: 'e', size: 1 }] })],
      ['a conversation tag', withConv, (p) => ({ ...p, conversation: `${p.conversation}-x` })],
      ['an onBehalfOf name', withOb, (p) => ({ ...p, onBehalfOf: `${p.onBehalfOf}x` })],
      ['a _recovered string', withRec, (p) => ({ ...p, _recovered: `${p._recovered}!` })],
    ];
    for (const [label, idx, edit] of edits) {
      assert.ok(idx >= 0, `fixture has a post for: ${label}`);
      const changed = posts.map((p, i) => (i === idx ? edit(p) : p));
      const before = proxy.updates;
      const r = await runTool(writeBoard(boardFor(changed, {})), url, { timeoutMs: 180000 });
      assert.equal(r.code, 4, `${label}: ${r.said}`);
      assert.deepEqual(r.summary.conflicts, [{ id: posts[idx].id, reason: 'content-differs' }], label);
      assert.equal(proxy.updates, before, `${label}: nothing was sent`);
    }
  });
});

test('S5 STILL REFUSED, by name and before any write: a post carrying an `origin` with any key beyond mutationId/slot/occurredAt (an originActor, say), an unknown key, or an `origin` with an extra key or an unknown key refuses the whole run (exit 3, UNSUPPORTED_POST_FIELDS, id and key named), and the token VALUE never appears in the output', { skip: SKIP }, async () => {
  const plain = fixturePosts().slice(0, 3);
  const bad = [
    { ...plain[0], id: 'bad-origin-actor', postSeq: 900001, origin: { mutationId: 'm', slot: 'claim', actor: 'ada' } },
    { ...plain[0], id: 'bad-mystery', postSeq: 900003, mystery: 1 },
  ];
  const keys = { 'bad-origin-actor': 'origin', 'bad-mystery': 'mystery' };   // U5 (decision f4940204): the author-correction trail is stored, not refused: backfill-posts-r0-u5.test.mjs
  const file = writeBoard(boardFor([...plain, ...bad], {}));
  await withExec(async ({ exec, proxy, url }) => {
    const r = await runTool(file, url);
    assert.equal(r.code, 3, r.said); assert.match(r.said, /UNSUPPORTED_POST_FIELDS/);
    for (const b of bad) { assert.ok(r.said.includes(b.id), `${b.id} is named`); assert.ok(r.said.includes(keys[b.id]), `${keys[b.id]} is named for ${b.id}`); }
    assert.equal(proxy.updates, 0); assert.deepEqual(await commentIds(exec), []);
  });
});

test('S6 A MALFORMED ATTACHMENT IS REFUSED BY THE TOOL, BY NAME, BEFORE ANY WRITE (not left for the compiler to fail on at write time): an attachment with an extra field, a negative / fractional / string / missing `size`, a non-object element, or an `attachments` that is not an array: exit 3, UNSUPPORTED_POST_FIELDS naming the post and `attachments`, zero updates, an empty graph, no value echoed, and the same refusal with a DEAD executor', { skip: SKIP }, async () => {
  const SECRET = 'ATTACHMENT-VALUE-MUST-NEVER-BE-PRINTED';
  const withAtt = fixturePosts().filter((p) => p.attachments.length > 0).slice(0, 8);
  assert.ok(withAtt.length >= 8, 'control: the corpus has attachment-bearing posts to corrupt');
  const att = (p) => p.attachments[0];
  const bad = [
    { ...withAtt[0], id: 'bad-att-extra', attachments: [{ ...att(withAtt[0]), extraField: SECRET }] },
    { ...withAtt[1], id: 'bad-att-negative', attachments: [{ ...att(withAtt[1]), size: -1 }] },
    { ...withAtt[2], id: 'bad-att-fraction', attachments: [{ ...att(withAtt[2]), size: 1.5 }] },
    { ...withAtt[3], id: 'bad-att-string-size', attachments: [{ ...att(withAtt[3]), size: '10' }] },
    { ...withAtt[4], id: 'bad-att-no-size', attachments: [(({ size, ...rest }) => rest)(att(withAtt[4]))] },
    { ...withAtt[5], id: 'bad-att-not-object', attachments: [SECRET] },
    { ...withAtt[6], id: 'bad-att-not-array', attachments: SECRET },
  ];
  // control: the SAME posts with well-formed attachments import (so the refusals below are about the malformation and nothing else)
  const good = bad.map((b, i) => ({ ...b, id: b.id.replace('bad-', 'good-'), attachments: withAtt[i].attachments }));
  await withExec(async ({ exec, proxy, url }) => {
    const c = await runTool(writeBoard(boardFor(good, {})), url);
    assert.equal(c.code, 0, `control: well-formed attachments import: ${c.said}`);
  });
  const file = writeBoard(boardFor([...withAtt.slice(7, 8), ...bad], {})); const before = fs.readFileSync(file);
  await withExec(async ({ exec, proxy, url }) => {
    const r = await runTool(file, url);
    assert.equal(r.code, 3, r.said); assert.match(r.said, /UNSUPPORTED_POST_FIELDS/);
    for (const b of bad) assert.ok(r.said.includes(b.id), `${b.id} is named`);
    assert.ok(r.said.includes('attachments'), 'the key `attachments` is named');
    assert.ok(!r.said.includes(SECRET), 'no attachment value is printed');
    assert.ok(!r.said.includes(withAtt[7].id), 'the well-formed post is not listed as offending');
    assert.equal(proxy.updates, 0, 'nothing was written, not even the well-formed post'); assert.deepEqual(await commentIds(exec), []);
    assert.deepEqual(fs.readFileSync(file), before);
    const dead = await runTool(file, 'http://127.0.0.1:9');
    assert.equal(dead.code, 3, `refused on the board alone, before the executor is contacted: ${dead.said}`); assert.match(dead.said, /UNSUPPORTED_POST_FIELDS/);
  });
});

// ------------------------------------------------------------------ NOT FROZEN (visible as todo, never a pass)
test('T3 R1\'s READER implements the read-back rule above (this file pins the function, not R1)', { todo: 'NOT IN THIS FILE: R1' }, () => assert.fail('NOT IN THIS FILE'));
