/**
 * #1787 — card attachment metadata in the graph: one node per attachment, the SAME shape a post's attachment has, written in
 * the card's own guarded update. The test author's independent RED rows, written black-box against the "#1787 CONTRACT"
 * (commons, 2026-10-26 20:41Z) before the build. Cards carry attachments through the page routes (/api/nodes).
 *
 * THE CONTRACT (one table, so a rename is one edit): node `<card IRI>/attachment/<index>` with scrum:attachmentOf <card>,
 * scrum:attachmentIndex (xsd:integer, the array index), schema:identifier (the attachment id), schema:name,
 * schema:encodingFormat (the mime), schema:contentSize (xsd:integer).
 *
 * THE WORLD: the whole-board fixture in a real executor, REST under all six units and the four executor sources, the board
 * document off, the allocator seeded, the reference index backfilled (production's mode), a seat token on every call.
 *
 * ROWS:
 *   T1  a page created with two attachments: a query by scrum:attachmentOf lists exactly two nodes, each with every field
 *   T2  an attachment removed by a page edit: its node is gone, the other stays (and is re-indexed if the index moved)
 *   T3  the card deleted: no node attachmentOf it remains
 *   T4  SHAPE PARITY: a post's attachment node and a card's carry the same predicate set, with the same datatypes
 *
 *   B1  the BACKFILL (scripts/backfill-card-attachments-1787.mjs --executor --dataset [--apply]) on a card whose attachment
 *       nodes are absent (written as before the change: the nodes are removed with a raw update): the dry run reports it as
 *       needing nodes and changes NOTHING; --apply gives it exactly its nodes, leaves its REST version unmoved and exits 0;
 *       a second --apply reports reprojected 0 and moves no graph version stamp
 *
 * NOT COVERED, BY NAME: the backfill's exit 1 on a write that is not APPLIED (needs an injected refusal).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HAVE_PY } from './helpers/graph-executor-proc.mjs';
import { wholeBoardWorld, WB_DATASET } from './helpers/whole-board-1645.mjs';
import { startRestServer } from './helpers/harness.mjs';
import { createGraphClient } from '../core/graph-client.mjs';
import { mintToken, hashToken } from '../core/credentials.mjs';
import { BOOKKEEPING_GRAPH } from '../core/graph-vocab.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const T = { skip: SKIP, timeout: 300000 };
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKFILL = path.join(HERE, '..', 'scripts', 'card-ref-index-1744.mjs');
const BK = BOOKKEEPING_GRAPH;
const RS = 'https://scrumboard.local/ns#';
const SCHEMA = 'https://schema.org/';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const ENTITY = 'https://scrumboard.local/entity/';
const A = { of: `${RS}attachmentOf`, index: `${RS}attachmentIndex`, id: `${SCHEMA}identifier`, name: `${SCHEMA}name`, mime: `${SCHEMA}encodingFormat`, size: `${SCHEMA}contentSize` };

const UNITS = { SCRUM_GRAPH_UNIT_CARDS: '1', SCRUM_GRAPH_UNIT_COLUMNS: '1', SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_UNIT_LOGBORN: '1', SCRUM_GRAPH_UNIT_SMALLKINDS: '1', SCRUM_GRAPH_UNIT_DELIVERIES: '1' };
const SOURCES = { SCRUM_GRAPH_QUERY_SOURCE: 'executor', SCRUM_GRAPH_READY_SOURCE: 'executor', SCRUM_GRAPH_CHECKS_SOURCE: 'executor', SCRUM_GRAPH_NEIGHBORS_SOURCE: 'executor' };
const ROSTER = path.join(os.tmpdir(), `att-1787-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
const TOK = mintToken();
const TOKENS = path.join(os.tmpdir(), `att-1787-tokens-${process.pid}.json`);
{ const at = (h) => new Date(Date.now() + h * 3600_000).toISOString(); fs.writeFileSync(TOKENS, JSON.stringify({ seats: { ada: { credentials: [{ tokenHash: hashToken(TOK), scope: 'admin', issuedAt: at(-1), expiresAt: at(24), issuedBy: 'test', revokedAt: null, note: null }] } } })); }
process.once('exit', () => { for (const f of [ROSTER, TOKENS]) { try { fs.rmSync(f, { force: true }); } catch { /* best effort */ } } });

const runNode = (args) => new Promise((resolve) => {
  const p = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  const timer = setTimeout(() => p.kill('SIGKILL'), 180000);
  p.on('close', (status) => { clearTimeout(timer); resolve({ status, out, err }); });
});

async function world(body) {
  const w = await wholeBoardWorld({ env: { ...UNITS, ...SOURCES } });
  const kept = fs.readFileSync(w.boardFile);
  await w.rest.stop(); fs.writeFileSync(w.boardFile, kept);   // the harness unlinks the board file on stop
  const gc = createGraphClient({ baseUrl: w.exec.baseUrl, expectedDatasetId: WB_DATASET, timeoutMs: 30000, label: 'att-1787' });
  const q = async (sparql) => { const r = await gc.query(sparql); assert.ok(r.ok, `the executor answered (${r.reason})`); return r.rows; };
  let rest = null;
  try {
    const seqs = (await q(`SELECT ?n WHERE { { ?s ?p ?n } UNION { GRAPH ?g { ?s ?p ?n } } FILTER(STRENDS(STR(?p), "/postSeq") || STRENDS(STR(?p), "#postSeq")) }`)).map((r) => Number(r.n.value)).filter(Number.isSafeInteger);
    const epoch = (/"postSeqEpoch"\s*:\s*"([^"]+)"/.exec(kept.toString('utf8')) || [])[1] || 'e-att-1787';
    const ep = (await (await fetch(`${w.exec.baseUrl}/health`)).json()).epoch;
    const seed = await fetch(`${w.exec.baseUrl}/update`, { method: 'POST', headers: { 'x-op-id': `urn:ex:op/test/att-1787-allocator-${process.pid}-${Date.now()}`, 'x-epoch': String(ep) }, body: `INSERT DATA { GRAPH <${BK}> { <urn:ex:postseq/allocator> a <urn:ex:postseq/Allocator> ; <urn:ex:postseq/postSeqEpoch> ${JSON.stringify(epoch)} ; <urn:ex:postseq/nextPostSeq> "${Math.max(0, ...seqs) + 1}"^^<${XSD}integer> ; <urn:ex:postseq/version> "1"^^<${XSD}integer> . } }` });
    assert.equal(seed.status, 200, `PRECONDITION: the allocator is seeded (${await seed.text()})`);
    const b = await runNode([BACKFILL, '--executor', w.exec.baseUrl, '--dataset', WB_DATASET, '--backfill']);
    assert.equal(b.status, 0, `PRECONDITION: the reference index is backfilled (exit ${b.status}: ${(b.err || b.out).slice(-300)})`);
    fs.chmodSync(w.boardFile, 0o000);
    rest = await startRestServer({ boardFile: w.boardFile, env: { SCRUM_GRAPH_DATASET_ID: WB_DATASET, SCRUM_GRAPH_EXECUTOR_URL: w.exec.baseUrl, SCRUM_ROSTER_FILE: ROSTER, ...UNITS, ...SOURCES, SCRUM_BOARD_DOCUMENT: 'off', SCRUM_SEAT_TOKENS: TOKENS, SCRUM_AUTH: 'required', } });
    const call = async (method, route, payload) => {
      const headers = { authorization: `Bearer ${TOK}`, ...(payload ? { 'content-type': 'application/json' } : {}) };
      const x = await fetch(`${rest.baseUrl}${route}`, { method, headers, ...(payload ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(60000) });
      const t = await x.text(); let j = null; try { j = JSON.parse(t); } catch { /* not json */ } return { status: x.status, text: t, json: j };
    };
    await body({ q, call, gc, exec: w.exec.baseUrl });
  } finally {
    try { fs.chmodSync(w.boardFile, 0o644); } catch { /* absent */ }
    if (rest) await rest.stop().catch(() => {});
    try { fs.writeFileSync(w.boardFile, kept); } catch { /* going anyway */ }
    await w.stop();
  }
}


/** every node attachmentOf `owner`: iri → { predicate: [{value, datatype}] } */
async function attachmentsOf(q, owner) {
  const m = new Map();
  for (const r of await q(`SELECT ?a ?p ?o WHERE { ?a <${A.of}> <${owner}> . ?a ?p ?o }`)) {
    if (!m.has(r.a.value)) m.set(r.a.value, {});
    (m.get(r.a.value)[r.p.value] ||= []).push({ value: r.o.value, datatype: r.o.datatype ?? null });
  }
  return m;
}
const only = (node, p, label) => { const v = node[p] || []; assert.equal(v.length, 1, `${label}: exactly one ${p} (got ${JSON.stringify(v)})`); return v[0]; };
function assertNode(node, iri, owner, att, index, label) {
  assert.equal(iri, `${owner}/attachment/${index}`, `${label}: the node IRI is <card>/attachment/<index>`);
  assert.equal(only(node, A.of, label).value, owner, `${label}: attachmentOf the card`);
  const ix = only(node, A.index, label); assert.equal(ix.datatype, `${XSD}integer`, `${label}: attachmentIndex is xsd:integer`); assert.equal(ix.value, String(index), `${label}: attachmentIndex`);
  assert.equal(only(node, A.id, label).value, att.id, `${label}: schema:identifier`);
  assert.equal(only(node, A.name, label).value, att.name, `${label}: schema:name`);
  assert.equal(only(node, A.mime, label).value, att.mime, `${label}: schema:encodingFormat`);
  const sz = only(node, A.size, label); assert.equal(sz.datatype, `${XSD}integer`, `${label}: contentSize is xsd:integer`); assert.equal(Number(sz.value), att.size, `${label}: schema:contentSize`);
}
async function upload(call, name, mime, text) {
  const r = await call('POST', '/api/attachments', { name, mime, data: Buffer.from(text).toString('base64') });
  assert.equal(r.status, 201, `PRECONDITION: upload ${name} (${r.status} ${r.text.slice(0, 160)})`);
  return r.json;   // { id, name, mime, size }
}

test('#1787 T1–T4 — a card\'s attachments are graph nodes of the post shape, written and removed with the card', T, async () => {
  await world(async ({ q, call }) => {
    const a1 = await upload(call, 'notes.txt', 'text/plain', 'first attachment');
    const a2 = await upload(call, 'chart.png', 'image/png', 'second attachment, longer');

    // T1 create a page with two attachments
    const c = await call('POST', '/api/nodes', { title: 'att page', body: 'with files', attachments: [a1, a2], createdBy: 'ada' });
    assert.ok(c.status === 201 || c.status === 200, `PRECONDITION: the page is created (${c.status} ${c.text.slice(0, 200)})`);
    const id = c.json?.id ?? c.json?.['@id'];   // the page routes answer JSON-LD
    assert.ok(id, `PRECONDITION: the create returned the card id (${c.text.slice(0, 200)})`);
    const owner = `${ENTITY}${id}`;
    let nodes = await attachmentsOf(q, owner);
    assert.equal(nodes.size, 2, `T1: a query by scrum:attachmentOf lists exactly two nodes (got ${nodes.size})`);
    for (const [k, att] of [[0, a1], [1, a2]]) {
      const iri = `${owner}/attachment/${k}`;
      assert.ok(nodes.has(iri), `T1: node ${k} exists`);
      assertNode(nodes.get(iri), iri, owner, att, k, `T1 attachment ${k}`);
    }

    // T2 remove the first attachment
    const e = await call('PATCH', `/api/nodes/${id}`, { attachments: [a2], by: 'ada' });
    assert.equal(e.status, 200, `PRECONDITION: the edit (${e.status} ${e.text.slice(0, 200)})`);
    nodes = await attachmentsOf(q, owner);
    assert.equal(nodes.size, 1, `T2: one attachment node remains (got ${[...nodes.keys()]})`);
    assertNode(nodes.get(`${owner}/attachment/0`), `${owner}/attachment/0`, owner, a2, 0, 'T2 the remaining attachment, now index 0');
    assert.equal((await q(`SELECT ?p WHERE { <${owner}/attachment/1> ?p ?o }`)).length, 0, 'T2: no triple of the old index-1 node remains');

    // T4 shape parity with a post's attachment
    const a3 = await upload(call, 'post.txt', 'text/plain', 'a post attachment');
    const p = await call('POST', '/api/conversations', { body: 'a post with a file', author: 'ada', attachments: [a3] });
    assert.equal(p.status, 201, `PRECONDITION: the post (${p.status} ${p.text.slice(0, 160)})`);
    const pnodes = await attachmentsOf(q, `${ENTITY}${p.json.id}`);
    assert.equal(pnodes.size, 1, 'PRECONDITION: the post has one attachment node');
    const shape = (n) => Object.entries(n).filter(([pr]) => pr !== A.of).map(([pr, vs]) => `${pr} ${vs.map((v) => v.datatype ?? 'plain').join(',')}`).sort();
    assert.deepEqual(shape(nodes.get(`${owner}/attachment/0`)), shape([...pnodes.values()][0]), 'T4: the card\'s attachment node and the post\'s carry the same predicates and datatypes');

    // T3 delete the card
    const d = await call('DELETE', `/api/cards/${id}?by=ada`);
    assert.ok(d.status === 200 || d.status === 204, `PRECONDITION: the delete (${d.status} ${d.text.slice(0, 160)})`);
    assert.equal((await attachmentsOf(q, owner)).size, 0, 'T3: no node attachmentOf the deleted card remains');
    assert.equal((await q(`SELECT ?s WHERE { ?s ?p ?o . FILTER(STRSTARTS(STR(?s), "${owner}/attachment/")) }`)).length, 0, 'T3: and nothing under its attachment prefix');
  });
});

const BACKFILL_1787 = path.join(HERE, '..', 'scripts', 'backfill-card-attachments-1787.mjs');
const allVersions = async (q) => (await q(`SELECT ?s ?v WHERE { GRAPH <${BK}> { ?s <urn:ex:ver> ?v } }`)).map((r) => `${r.s.value}=${r.v.value}`).sort();

test('#1787 B1 — the backfill gives a pre-change card its attachment nodes without moving its REST version, and a re-run writes nothing', T, async () => {
  await world(async ({ q, call, exec }) => {
    const a1 = await upload(call, 'old.txt', 'text/plain', 'written before the change');
    const c = await call('POST', '/api/nodes', { title: 'old page', body: 'pre-change', attachments: [a1], createdBy: 'ada' });
    assert.ok(c.status === 201 || c.status === 200, `PRECONDITION: the page (${c.status})`);
    const id = c.json?.id ?? c.json?.['@id'];
    const owner = `${ENTITY}${id}`;
    // make it a PRE-CHANGE card: its attachment nodes removed, as a card written before #1787 has none
    const ep = (await (await fetch(`${exec}/health`)).json()).epoch;
    const raw = await fetch(`${exec}/update`, { method: 'POST', headers: { 'x-op-id': `urn:ex:op/test/att-1787-strip-${process.pid}-${Date.now()}`, 'x-epoch': String(ep) }, body: `DELETE WHERE { ?a <${A.of}> <${owner}> . ?a ?p ?o }` });
    assert.equal(raw.status, 200, `PRECONDITION: the nodes are stripped (${await raw.text()})`);
    assert.equal((await attachmentsOf(q, owner)).size, 0, 'PRECONDITION: the card has no attachment nodes');
    const restV = (await call('GET', `/api/cards/${id}`)).json.version;
    const v0 = await allVersions(q);

    const dry = await runNode([BACKFILL_1787, '--executor', exec, '--dataset', WB_DATASET]);
    assert.equal(dry.status, 0, `B1 dry run exits 0 (${(dry.err || dry.out).slice(-300)})`);
    const dm = /#1787 backfill \(dry run\): scanned (\d+) cards, (\d+) need attachment nodes, (\d+) already current/.exec(dry.out);
    assert.ok(dm, `B1: the dry run reports in the contract's words (${dry.out.slice(-300)})`);
    assert.ok(Number(dm[2]) >= 1, `B1: the stripped card is counted as needing nodes (${dm[0]})`);
    assert.equal((await attachmentsOf(q, owner)).size, 0, 'B1: the dry run wrote no node');
    assert.deepEqual(await allVersions(q), v0, 'B1: the dry run moved no version stamp');

    const app = await runNode([BACKFILL_1787, '--executor', exec, '--dataset', WB_DATASET, '--apply']);
    assert.equal(app.status, 0, `B1 --apply exits 0 (${(app.err || app.out).slice(-300)})`);
    const am = /#1787 backfill: scanned (\d+), reprojected (\d+), already current (\d+)/.exec(app.out);
    assert.ok(am && Number(am[2]) === Number(dm[2]), `B1: --apply reprojected what the dry run said needed it (${am?.[0]} vs ${dm[0]})`);
    const nodes = await attachmentsOf(q, owner);
    assert.equal(nodes.size, 1, 'B1: the card now has exactly its one attachment node');
    assertNode(nodes.get(`${owner}/attachment/0`), `${owner}/attachment/0`, owner, a1, 0, 'B1 backfilled node');
    assert.equal((await call('GET', `/api/cards/${id}`)).json.version, restV, 'B1: the REST version did not move (a reproject, the JSON unchanged)');

    const v1 = await allVersions(q);
    const again = await runNode([BACKFILL_1787, '--executor', exec, '--dataset', WB_DATASET, '--apply']);
    assert.equal(again.status, 0, 'B1: a re-run exits 0');
    assert.match(again.out, /#1787 backfill: scanned \d+, reprojected 0, already current \d+/, `B1: a re-run reprojects nothing (${again.out.slice(-200)})`);
    assert.deepEqual(await allVersions(q), v1, 'B1: a re-run moves no graph version stamp');
  });
});
