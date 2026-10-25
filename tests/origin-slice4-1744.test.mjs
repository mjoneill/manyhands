/**
 * #1629 slice 4 (#1744) — wiki-create and sibling-shifting done-moves WORK under executor-owned mode. The test author's
 * independent RED rows, written against the contract FROZEN on #1744 (v19–v21): draft v2 plus binding amendments F1–F5,
 * plus v1's accepted route, counter, provenance and reason decisions. Source read at main 58d0a5c1. The builder does not
 * write these rows; the row author does not build slice 4.
 *
 * THE WORLD: the whole-board fixture (tests/helpers/whole-board-1645.mjs: cards #1–#3, #2 relatedTo/blockedBy #1, #3 in
 * done, counter 4) migrated into a real executor; REST under all six units and the four executor sources. Mode off: the
 * board file exists and is UNREADABLE (chmod 000), and the allocator is seeded explicitly above every postSeq (as the
 * slice-3 rows do). Every world initializes the reference index EXPLICITLY (F3) before REST starts, writers quiesced,
 * unless the row is about an uninitialized or damaged index.
 *
 * LAYERS:
 *   W    REST page create: identity (D2), the frozen request and its retry (V2-1, F4), the counter, the origin, the notice
 *   IDX  the reference index: positive invariant after backfill and after every ordinary write, in BOTH modes (V2-2, F2, F5)
 *   R    reference re-projection on create (C12), and every index-integrity negative (F2), each refusing with no effect
 *   C    the compiler, fed HAND-BUILT origin plans straight to the executor: the plan parts come from the existing
 *        createCardsUnit.plan (so prior/new quads are exactly an ordinary write's), the descriptor from the frozen contract;
 *        a valid plan is admitted (the control), and each forged plan is refused
 *   E    the sibling walk (V2-3, F1): exact shifted set, (order, shortId) tie-break, anchors, gap stop, one origin, and
 *        compiler negatives on hand-built sibling plans
 *   D8   mode on: the only store delta of an ordinary write is its receipt, its graph versions and the index subtree
 *
 * "NO EFFECT" (D9): no card, no counter advance, no committed Origin, no allocator advance, no new post. A Prepared record
 * MAY remain after a refused commit; rows never assert its absence.
 *
 * INTERFACE THESE ROWS TARGET: the contract's names, plus these ASSUMPTIONS (one table each, so a rename is one edit):
 *   ROUTE    POST /api/nodes { title, body, type, parent, attachments, createdBy, requestId }. Success is 201, or 200 for a
 *            replay. A minted requestId comes back as `requestId` on the response.
 *   CODES    REQUEST_CONFLICT and STALE_PREPARED (409, named by the contract); INDEX_INCOMPLETE (ASSUMED name) for every
 *            index-integrity refusal.
 *   INDEX    the IX table below. The namespace, the coverage subject and the marker subject are the contract's; the full
 *            predicate IRIs under the namespace are ASSUMED. The index lives in the bookkeeping graph.
 *   TOOL     node scripts/card-ref-index-1744.mjs --executor URL --dataset DS --backfill  (the closed admin op, F3;
 *            exit 0 and a COMPLETE line on success). ASSUMED name and flags.
 *   BARRIER  `after-origin-prepare`: a TEST-ONLY server barrier (the server.js testBarrier mechanism) AFTER origin.prepare
 *            answered APPLIED and was read back, and BEFORE the commit card.write is sent. None exists today.
 *   PARTS    each non-subject origin part carries `reason` ∈ reference-resolve | sibling-order (v1 D6).
 *
 * NOT COVERED, BY NAME: where a done-move's ANCHOR travels in a hand-built plan (the contract binds the walk to it but no
 * field is named; the C/E compiler rows use the no-anchor walk only); applyApexLabels' descendant effects on pre-existing
 * children that point at the derived id (needs raw imported state: the API refuses a parent naming no card); restore/copy
 * carrying the index (F3); mode-on activation with no marker (a rollout rule, not a row); the store-level byte golden of a
 * mode-on write before vs after the change (D8 is held here by a delta check, not a golden); the server-minted requestId's
 * lost-first-response limit (documented, not testable).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HAVE_PY } from './helpers/graph-executor-proc.mjs';
import { wholeBoardWorld, WB_DATASET } from './helpers/whole-board-1645.mjs';
import { startRestServer } from './helpers/harness.mjs';
import { createGraphClient } from '../core/graph-client.mjs';
import { createCardsUnit } from '../core/cards-unit.mjs';
import { durableUpdate } from '../core/durable-update.mjs';
import { cardIriOf, SHORTID_COUNTER_IRI, cardQuads, priorQuads, shortIdMap } from '../core/cards-graph.mjs';
import { parseCardRefs } from '../core/references.mjs';
import { enumerateOriginRecords, readCommittedOrigin, readPreparedOrigin } from '../core/origin-commit.mjs';
import { mutationIdOf, originPrepareOp, originCommitOp, ORIGIN_NAMESPACE } from '../core/graph-compiler.mjs';
import { BOOKKEEPING_GRAPH } from '../core/graph-vocab.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const T = { skip: SKIP, timeout: 300000 };
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const BACKFILL = path.join(REPO, 'scripts', 'card-ref-index-1744.mjs');
const BK = BOOKKEEPING_GRAPH;
const RS = 'https://scrumboard.local/ns#';
const SCHEMA = 'https://schema.org/';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const VER = 'urn:ex:ver';
const UNRESOLVED = 'https://scrumboard.local/unresolved/';
const BOARD = 'https://scrumboard.local/person/board';
const ROSTER = path.join(os.tmpdir(), `s4-1744-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
process.once('exit', () => { try { fs.rmSync(ROSTER, { force: true }); } catch { /* best effort */ } });

const UNITS = { SCRUM_GRAPH_UNIT_CARDS: '1', SCRUM_GRAPH_UNIT_COLUMNS: '1', SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_UNIT_LOGBORN: '1', SCRUM_GRAPH_UNIT_SMALLKINDS: '1', SCRUM_GRAPH_UNIT_DELIVERIES: '1' };
const SOURCES = { SCRUM_GRAPH_QUERY_SOURCE: 'executor', SCRUM_GRAPH_READY_SOURCE: 'executor', SCRUM_GRAPH_CHECKS_SOURCE: 'executor', SCRUM_GRAPH_NEIGHBORS_SOURCE: 'executor' };
const BARRIER = 'after-origin-prepare';
const CODES = { REQUEST_CONFLICT: 'REQUEST_CONFLICT', STALE_PREPARED: 'STALE_PREPARED', INDEX_INCOMPLETE: 'INDEX_INCOMPLETE' };
const IX = {
  ns: 'urn:ex:card-ref-index/',
  card: (id) => `urn:ex:card-ref-index/card/${id}`,
  indexedVersion: 'urn:ex:card-ref-index/indexedVersion',
  indexedJsonDigest: 'urn:ex:card-ref-index/indexedJsonDigest',
  namesShortId: 'urn:ex:card-ref-index/namesShortId',
  marker: 'urn:ex:card-ref-index/coverage',
  complete: 'urn:ex:card-ref-index/complete',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const ok2xx = (st) => st >= 200 && st < 300;

// ── D2/V2-1 golden vectors, computed OUTSIDE this code (Python uuid.uuid5 and hashlib, 2026-10-25T03:2xZ) ──
// key = ["origin-v1","wiki-create","wiki",requestId,originActor]; mutationId = UUIDv5(key, ORIGIN_NAMESPACE);
// cardId = UUIDv5(`${mutationId}:card`, ORIGIN_NAMESPACE); requestDigest = sha256("wikiCreateRequestV 1\n" + canonical).
const GOLDEN = {
  "ids": [
    {
      "requestId": "req-1744-a",
      "actor": "board",
      "key": "[\"origin-v1\",\"wiki-create\",\"wiki\",\"req-1744-a\",\"board\"]",
      "mutationId": "3241e683-2169-5eab-b42e-eb77b9e5b7bf",
      "cardId": "565eba22-74e4-5dc2-8993-9f7d58c77db3"
    },
    {
      "requestId": "req-1744-a",
      "actor": "ada",
      "key": "[\"origin-v1\",\"wiki-create\",\"wiki\",\"req-1744-a\",\"ada\"]",
      "mutationId": "7ade8146-1a1e-5bdf-bad9-c8c74695ff5b",
      "cardId": "565a3d79-101c-533e-85d5-9603ac2a55a8"
    },
    {
      "requestId": "req-1744-b",
      "actor": "board",
      "key": "[\"origin-v1\",\"wiki-create\",\"wiki\",\"req-1744-b\",\"board\"]",
      "mutationId": "edb36545-ae7e-5570-bb01-1687a4e0e09a",
      "cardId": "e98f596f-f2dc-5d41-95bd-34d854258c3f"
    }
  ],
  "digests": [
    {
      "req": {
        "title": "  A page  ",
        "body": " text ",
        "createdBy": "ada"
      },
      "canonical": "{\"v\":1,\"title\":\"A page\",\"description\":\"text\",\"type\":\"reference\",\"parent\":null,\"attachments\":null,\"createdBy\":\"ada\"}",
      "digest": "df0f4d3deb1c94388f21b41f1185cbaa60795f741168455e91ec563872c6f84a"
    },
    {
      "req": {
        "title": "Child page",
        "body": "under card 1",
        "parent": "uuid-1",
        "createdBy": "ada"
      },
      "canonical": "{\"v\":1,\"title\":\"Child page\",\"description\":\"under card 1\",\"type\":\"reference\",\"parent\":\"uuid-1\",\"attachments\":null,\"createdBy\":\"ada\"}",
      "digest": "b8b7011ce014eb46844b2f2976ffeb4f25e7f7e020a1f8c95759dfabfa1b5900"
    }
  ]
};

/** V2-1's canonical request, written here independently: fixed key order, values as the route reads them */
function canonicalRequest({ title, body, type, parent, attachments, createdBy }) {
  return JSON.stringify({ v: 1, title: String(title).trim(), description: String(body ?? '').trim(), type: type || 'reference', parent: typeof parent === 'string' ? parent : null, attachments: attachments === undefined ? null : attachments, createdBy: createdBy ?? null });
}
const requestDigestOf = (req) => sha256(`wikiCreateRequestV 1\n${canonicalRequest(req)}`);
const keyOf = (requestId, actor = 'board') => JSON.stringify(['origin-v1', 'wiki-create', 'wiki', requestId, actor]);

/** the distinct #N a card names, by the helpers' own rules (namesAny): text, relationships, acceptance blockers */
function namesOf(card) {
  const n = new Set(parseCardRefs(`${card.title ?? ''}\n${card.description ?? ''}`).map(Number));
  for (const arr of Object.values(card.relationships || {})) for (const v of arr || []) n.add(Number(v));
  for (const a of card.acceptance || []) for (const v of a?.blockedBy || []) n.add(Number(v));
  return [...n].filter(Number.isSafeInteger).sort((a, b) => a - b);
}

// ── one world ──
async function until(fn, ms, step = 250) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(step); } }
const runNode = (args) => new Promise((resolve) => {
  const p = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  const timer = setTimeout(() => p.kill('SIGKILL'), 180000);
  p.on('close', (status, signal) => { clearTimeout(timer); resolve({ status, signal, out, err }); });
});

async function world(mode, body, { index = 'backfilled', plant = null } = {}) {
  const w = await wholeBoardWorld({ env: { ...UNITS, ...SOURCES } });
  const kept = fs.readFileSync(w.boardFile);
  await w.rest.stop(); fs.writeFileSync(w.boardFile, kept);   // the harness unlinks the board file on stop
  const gc = createGraphClient({ baseUrl: w.exec.baseUrl, expectedDatasetId: WB_DATASET, timeoutMs: 30000, label: 's4-1744' });
  const q = async (sparql) => { const r = await gc.query(sparql); assert.ok(r.ok, `the executor answered (${r.reason})`); return r.rows; };
  const xu = async (sparql, label) => {
    const ep = (await (await fetch(`${w.exec.baseUrl}/health`)).json()).epoch;
    const r = await fetch(`${w.exec.baseUrl}/update`, { method: 'POST', headers: { 'x-op-id': `urn:ex:op/test/s4-1744-${label}-${process.pid}-${Date.now()}`, 'x-epoch': String(ep) }, body: sparql });
    assert.equal(r.status, 200, `PRECONDITION: raw ${label} (${await r.text()})`);
  };
  const barrierDir = fs.mkdtempSync(path.join(os.tmpdir(), 's4-1744-barrier-'));
  const incs = [];
  let current = null;
  try {
    if (mode === 'off') {   // the slice-3 rows' explicit allocator, above every postSeq in the store
      const seqs = (await q(`SELECT ?n WHERE { { ?s ?p ?n } UNION { GRAPH ?g { ?s ?p ?n } } FILTER(STRENDS(STR(?p), "/postSeq") || STRENDS(STR(?p), "#postSeq")) }`)).map((r) => Number(r.n.value)).filter(Number.isSafeInteger);
      const epoch = (/"postSeqEpoch"\s*:\s*"([^"]+)"/.exec(kept.toString('utf8')) || [])[1] || 'e-s4-1744';
      await xu(`INSERT DATA { GRAPH <${BK}> { <urn:ex:postseq/allocator> a <urn:ex:postseq/Allocator> ; <urn:ex:postseq/postSeqEpoch> ${JSON.stringify(epoch)} ; <urn:ex:postseq/nextPostSeq> "${Math.max(0, ...seqs) + 1}"^^<${XSD}integer> ; <urn:ex:postseq/version> "1"^^<${XSD}integer> . } }`, 'allocator');
    }
    if (index === 'backfilled') {
      const b = await runNode([BACKFILL, '--executor', w.exec.baseUrl, '--dataset', WB_DATASET, '--backfill']);
      assert.equal(b.status, 0, `the reference index was initialized explicitly before REST started (F3) (exit ${b.status}: ${(b.err || b.out).slice(-300)})`);
      assert.match(b.out, /^COMPLETE$/m, 'the backfill reports COMPLETE');
    }
    if (plant) await plant({ q, xu });
    const prepareFile = () => {
      try { fs.chmodSync(w.boardFile, 0o644); } catch { /* absent */ }
      if (!fs.existsSync(w.boardFile)) fs.writeFileSync(w.boardFile, kept);
      if (mode === 'off') fs.chmodSync(w.boardFile, 0o000);
    };
    const start = async () => {
      prepareFile();
      const r = await startRestServer({ boardFile: w.boardFile, env: { SCRUM_GRAPH_DATASET_ID: WB_DATASET, SCRUM_GRAPH_EXECUTOR_URL: w.exec.baseUrl, SCRUM_ROSTER_FILE: ROSTER, ...UNITS, ...SOURCES, ...(mode === 'off' ? { SCRUM_BOARD_DOCUMENT: 'off' } : {}), SCRUM_TEST_BARRIER_DIR: barrierDir } });
      incs.push(r); current = r; return r;
    };
    const call = async (method, route, payload) => {
      const x = await fetch(`${current.baseUrl}${route}`, { method, ...(payload ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(60000) });
      const t = await x.text(); let j = null; try { j = JSON.parse(t); } catch { /* not json */ } return { status: x.status, text: t, json: j };
    };
    /** Arm the FIFO barrier, fire `request`, wait until REST is held there. REST's event loop is blocked while held. */
    const holdAt = async (name, request) => {
      const fifo = path.join(barrierDir, name);
      assert.equal(spawnSync('mkfifo', [fifo]).status, 0, `PRECONDITION: mkfifo ${name}`);
      let returned = false;
      const inflight = request().then((r) => { returned = true; return r; }, (e) => { returned = true; return { reset: String(e?.message || e) }; });
      let fh = null;
      const reached = await Promise.race([fsp.open(fifo, 'w').then((h) => { fh = h; return true; }), sleep(20000).then(() => false)]);
      if (!reached) { try { fs.closeSync(fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)); } catch { /* none */ } }
      const release = async () => { try { await fh?.close(); } catch { /* ignore */ } fs.rmSync(fifo, { force: true }); };
      return { reached, inflight, returned: () => returned, release };
    };
    // a SECOND writer, beneath REST: the existing cards unit on its own client, through the real compiler
    const other = () => createCardsUnit({ client: createGraphClient({ baseUrl: w.exec.baseUrl, expectedDatasetId: WB_DATASET, timeoutMs: 30000, label: 's4-1744-other' }), mintId: () => crypto.randomUUID() });
    await body({ w, mode, gc, q, xu, start, call, holdAt, other });
  } finally {
    try { fs.chmodSync(w.boardFile, 0o644); } catch { /* absent */ }
    for (const r of incs) await r.stop().catch(() => {});
    try { fs.writeFileSync(w.boardFile, kept); } catch { /* going anyway */ }
    fs.rmSync(barrierDir, { recursive: true, force: true });
    await w.stop();
  }
}

// ── reads, all from the executor ──
const val = (b) => (b ? { type: b.type, value: b.value, datatype: b.datatype ?? null, lang: b['xml:lang'] ?? null } : null);
const INT = (n) => ({ type: 'literal', value: String(n), datatype: `${XSD}integer`, lang: null });
const STR = (s) => ({ type: 'literal', value: s, datatype: null, lang: null });
async function cardRow(s, id) {
  const r = await s.q(`SELECT ?v ?j WHERE { GRAPH <${BK}> { <${cardIriOf(id)}> <${VER}> ?v ; <${RS}entityJson> ?j } }`);
  return r.length === 1 ? { ver: Number(r[0].v.value), json: r[0].j.value, card: JSON.parse(r[0].j.value) } : (r.length ? { many: r.length } : null);
}
const liveCards = async (s) => (await s.q(`SELECT ?c ?v ?j WHERE { ?c <${RDF_TYPE}> <${RS}Card> . GRAPH <${BK}> { ?c <${VER}> ?v ; <${RS}entityJson> ?j } }`)).map((r) => ({ iri: r.c.value, ver: Number(r.v.value), json: r.j.value, card: JSON.parse(r.j.value) }));
const counterNow = async (s) => (await s.q(`SELECT ?n WHERE { GRAPH <${BK}> { <${SHORTID_COUNTER_IRI}> <${VER}> ?n } }`)).map((r) => Number(r.n.value));
const allocatorNow = async (s) => (await s.q(`SELECT ?n WHERE { GRAPH <${BK}> { <urn:ex:postseq/allocator> <urn:ex:postseq/nextPostSeq> ?n } }`)).map((r) => Number(r.n.value));
const postCount = async (s) => Number((await s.q(`SELECT (COUNT(DISTINCT ?s) AS ?n) WHERE { { ?s ?p ?x } UNION { GRAPH ?g { ?s ?p ?x } } FILTER(STRENDS(STR(?p), "/postSeq") || STRENDS(STR(?p), "#postSeq")) FILTER(!STRSTARTS(STR(?s), "urn:ex:postseq/")) }`))[0].n.value);
async function committedOrigins(s) {
  const e = await enumerateOriginRecords(s.gc);
  assert.equal(e.ok, true, `the origin records are readable (${JSON.stringify(e).slice(0, 200)})`);
  const mids = [...new Set(e.records.filter((r) => r.type === 'Origin' && r.mutationId).map((r) => r.mutationId))];
  const out = [];
  for (const mid of mids) { const c = await readCommittedOrigin(s.gc, mid); if (c.ok && c.committed) out.push({ mid, committed: c.committed }); }
  return out;
}
/** everything D9 says a refusal must leave unchanged (a Prepared record is allowed to remain) */
async function effects(s) {
  const cards = await liveCards(s);
  return { cards: cards.map((c) => `${c.iri} ${c.ver} ${sha256(c.json)}`).sort(), counter: await counterNow(s), allocator: await allocatorNow(s), posts: await postCount(s), origins: (await committedOrigins(s)).map((o) => o.mid).sort() };
}
/** the index state of one card: every value of every coverage predicate, typed */
async function coverageOf(s, id) {
  const rows = await s.q(`SELECT ?p ?o WHERE { GRAPH <${BK}> { <${IX.card(id)}> ?p ?o } }`);
  const by = (p) => rows.filter((r) => r.p.value === p).map((r) => val(r.o));
  return { any: rows.length, versions: by(IX.indexedVersion), digests: by(IX.indexedJsonDigest), names: by(IX.namesShortId).sort((a, b) => Number(a.value) - Number(b.value)) };
}
/** V2-2 + F2: for EVERY live card exactly one coverage node, its watermark = the card's current graph version and JSON
 *  digest, and namesShortId = EXACTLY the card's distinct names, as xsd:integer; no coverage for a card that is not live */
async function assertIndexComplete(s, label) {
  const cards = await liveCards(s);
  assert.ok(cards.length > 0, `${label}: CONTROL: there are live cards to index`);
  for (const c of cards) {
    const id = c.iri.slice('https://scrumboard.local/entity/'.length);
    const cov = await coverageOf(s, id);
    assert.ok(cov.any > 0, `${label}: card ${id} has a coverage node (absence is a VIOLATION, never "no references")`);
    assert.deepEqual(cov.versions, [INT(c.ver)], `${label}: card ${id}: exactly one indexedVersion, = its graph version ${c.ver}`);
    assert.deepEqual(cov.digests, [STR(sha256(c.json))], `${label}: card ${id}: exactly one indexedJsonDigest, = sha256 of its stored JSON`);
    assert.deepEqual(cov.names, namesOf(c.card).map(INT), `${label}: card ${id}: namesShortId is EXACTLY ${JSON.stringify(namesOf(c.card))}`);
  }
  const live = new Set(cards.map((c) => c.iri.slice('https://scrumboard.local/entity/'.length)));
  const covered = (await s.q(`SELECT DISTINCT ?c WHERE { GRAPH <${BK}> { ?c ?p ?o } FILTER(STRSTARTS(STR(?c), "${IX.ns}card/")) }`)).map((r) => r.c.value.slice(`${IX.ns}card/`.length));
  assert.deepEqual(covered.filter((id) => !live.has(id)), [], `${label}: no coverage node for a card that is not live`);
}
const markerOf = async (s) => (await s.q(`SELECT ?v WHERE { GRAPH <${BK}> { <${IX.marker}> <${IX.complete}> ?v } }`)).map((r) => val(r.v));
/** a node create, read back by its id from the executor */
const createPage = (s, req) => s.call('POST', '/api/nodes', req);
const notices = async (s, shortId) => { const l = await s.call('GET', '/api/conversations?limit=500'); const xs = Array.isArray(l.json) ? l.json : (l.json?.conversations || []); return xs.filter((c) => String(c.body).includes(`(#${shortId})`) && String(c.body).startsWith('📄 page created')); };
const mentionsEdges = async (s, fromId) => (await s.q(`SELECT ?o WHERE { <${cardIriOf(fromId)}> <${RS}mentionsCard> ?o }`)).map((r) => r.o.value).sort();
const relEdges = async (s, fromId, rel) => (await s.q(`SELECT ?o WHERE { <${cardIriOf(fromId)}> <${RS}${rel}> ?o }`)).map((r) => r.o.value).sort();
const documentOpens = async (s) => (await s.call('GET', '/api/health')).json?.document?.attemptedOpens;

// ── the rows ──

test('#1744 (PRE) the reference-index backfill tool exists (ASSUMED name; F3 makes harness initialization explicit)', () => {
  assert.ok(fs.existsSync(BACKFILL), 'scripts/card-ref-index-1744.mjs exists');
});

test('#1744 (HARNESS, runnable today) the fixture world: cards #1–#3 in the executor, counter 4, #3 in done, #2 names #1', T, async () => {
  await world('on', async (s) => {
    const cards = await liveCards(s);
    assert.deepEqual(cards.map((c) => c.card.shortId).sort(), [1, 2, 3], 'three live cards');
    assert.deepEqual(await counterNow(s), [4], 'the graph counter is 4');
    assert.equal((await cardRow(s, 'uuid-3')).card.column, 'done', '#3 is in done');
    assert.deepEqual(namesOf((await cardRow(s, 'uuid-2')).card), [1], '#2 names exactly #1');
    assert.deepEqual(namesOf((await cardRow(s, 'uuid-1')).card), [], '#1 names nothing');
  }, { index: 'none' });
});

test('#1744 (GOLDEN, runnable today) the D2 derivations: the Python vectors equal UUIDv5 under ORIGIN_NAMESPACE; actors and requests isolate', () => {
  assert.equal(ORIGIN_NAMESPACE, 'cd807138-eefc-40d2-9a80-525e666e6269', 'the namespace the vectors were computed under');
  for (const g of GOLDEN.ids) {
    assert.equal(keyOf(g.requestId, g.actor), g.key, `the key encoding for ${g.requestId}/${g.actor}`);
    assert.equal(mutationIdOf(g.key), g.mutationId, `mutationId for ${g.requestId}/${g.actor}`);
    assert.equal(mutationIdOf(`${g.mutationId}:card`), g.cardId, `cardId for ${g.requestId}/${g.actor}`);
  }
  assert.equal(new Set(GOLDEN.ids.map((g) => g.cardId)).size, GOLDEN.ids.length, 'another actor or another requestId → another card');
  for (const d of GOLDEN.digests) {
    assert.equal(canonicalRequest(d.req), d.canonical, `the canonical request of ${JSON.stringify(d.req)} (trim, body→description, default type, null absences)`);
    assert.equal(requestDigestOf(d.req), d.digest, `requestDigest of ${JSON.stringify(d.req)}`);
  }
});

// ── IDX: the positive invariant, both modes ──
for (const mode of ['on', 'off']) {
  test(`#1744 (IDX-0, mode ${mode}) after the backfill every live card has exactly one exact coverage node, and the marker says complete`, T, async () => {
    await world(mode, async (s) => {
      await assertIndexComplete(s, 'after backfill');
      assert.deepEqual(await markerOf(s), [{ type: 'literal', value: 'true', datatype: `${XSD}boolean`, lang: null }], 'the completion marker, exactly once');
    });
  });
  test(`#1744 (IDX-1, mode ${mode}) every ordinary write maintains the index: refs added, refs removed to ZERO, a card deleted`, T, async () => {
    await world(mode, async (s) => {
      await s.start();
      const c1 = (await s.call('GET', '/api/cards/uuid-1')).json;
      const u = await s.call('PATCH', '/api/cards/uuid-1', { description: 'see #2 and #3', ifVersion: c1.version, by: 'ada' });
      assert.equal(u.status, 200, `the update is applied (${u.status} ${u.text.slice(0, 200)})`);
      assert.deepEqual((await coverageOf(s, 'uuid-1')).names, [INT(2), INT(3)], 'card 1 now names exactly #2 and #3');
      await assertIndexComplete(s, 'after adding refs');
      const u2 = await s.call('PATCH', '/api/cards/uuid-1', { description: 'no references now', ifVersion: u.json.version, by: 'ada' });
      assert.equal(u2.status, 200, `the second update is applied (${u2.status})`);
      const z = await coverageOf(s, 'uuid-1');
      assert.ok(z.any > 0 && z.names.length === 0, 'ZERO references: the coverage node remains, with no namesShortId');
      await assertIndexComplete(s, 'after the transition to zero');
      const d = await s.call('DELETE', '/api/cards/uuid-3?by=ada');
      assert.ok(ok2xx(d.status), `the delete is applied (${d.status} ${d.text.slice(0, 200)})`);
      assert.equal((await coverageOf(s, 'uuid-3')).any, 0, 'a deleted card has no coverage node');
      await assertIndexComplete(s, 'after the delete');
    });
  });
}

// ── W: the page create ──
const REQ_A = { title: '  A page  ', body: ' text ', createdBy: 'ada', requestId: 'req-1744-a' };
const G = (requestId, actor = 'board') => GOLDEN.ids.find((g) => g.requestId === requestId && g.actor === actor);

test('#1744 (W0 CONTROL, mode on) a page create works as today: a RANDOM id (never the derived one), type reference, its notice, and its coverage', T, async () => {
  await world('on', async (s) => {
    await s.start();
    const p = await createPage(s, REQ_A);
    assert.ok(ok2xx(p.status), `accepted (${p.status} ${p.text.slice(0, 200)})`);
    const page = (await liveCards(s)).find((c) => c.card.title === 'A page');
    assert.ok(page, 'read-back: the page exists in the executor');
    assert.notEqual(page.card.id, G('req-1744-a').cardId, 'mode on keeps its random id (D2 is executor-owned only)');
    assert.equal(page.card.type, 'reference', 'the route default type');
    assert.ok(await until(async () => (await notices(s, page.card.shortId)).length === 1, 20000), 'exactly one page notice');
    await assertIndexComplete(s, 'mode on after a page create');
  });
});

test('#1744 (W1, mode off) a page create WORKS: the derived id, the expected counter exactly, the frozen request in the origin, one notice, no document access', T, async () => {
  await world('off', async (s) => {
    await s.start();
    const g = G('req-1744-a');
    assert.deepEqual(await counterNow(s), [4], 'PRECONDITION: the graph counter is 4');
    const o0 = (await committedOrigins(s)).length;
    const p = await createPage(s, REQ_A);
    assert.equal(p.status, 201, `created (${p.status} ${p.text.slice(0, 300)})`);
    const row = await cardRow(s, g.cardId);
    assert.ok(row && row.card, `read-back: the card has the DERIVED id ${g.cardId}`);
    assert.deepEqual([row.card.shortId, row.card.title, row.card.description, row.card.type, row.card.createdBy, row.card.version], [4, 'A page', 'text', 'reference', 'ada', 1], 'its business fields, exactly');
    assert.deepEqual(await counterNow(s), [5], 'the counter advanced ONCE, from exactly the expected 4');
    const origins = await committedOrigins(s);
    assert.equal(origins.length, o0 + 1, 'exactly one new committed Origin');
    const mine = origins.find((o) => o.mid === g.mutationId);
    assert.ok(mine, `the Origin is the derived mutation ${g.mutationId}`);
    const P = await readPreparedOrigin(s.gc, g.mutationId);
    assert.ok(P.ok && P.prepared, `the Prepared record reads back (${P.reason ?? ''})`);
    const d = JSON.parse(P.prepared.descriptorJson);
    assert.deepEqual([d.route, d.subject, d.requestKey, d.originActor], ['wiki-create', 'wiki', 'req-1744-a', 'board'], 'route, subject, requestKey, originActor (F4: board, never createdBy)');
    assert.deepEqual(d.provenance, { cardId: g.cardId, version: 1, requestDigest: GOLDEN.digests[0].digest }, 'provenance binds the derived card and the frozen request digest');
    assert.deepEqual(d.slots.map((x) => [x.slot, x.author, x.notify]), [['wiki', 'wiki', false]], 'one feed-only wiki notice slot');
    assert.ok(await until(async () => (await notices(s, 4)).length === 1, 20000), 'exactly one page notice post');
    assert.equal(await documentOpens(s), 0, 'no attempted open of the board file');
  });
});

test('#1744 (W2, mode off) the same request again (trim and type default equivalent) returns the ORIGINAL card: no second card, counter or notice', T, async () => {
  await world('off', async (s) => {
    await s.start();
    const a = await createPage(s, REQ_A);
    assert.equal(a.status, 201, `PRECONDITION: the first create (${a.status} ${a.text.slice(0, 200)})`);
    assert.ok(await until(async () => (await notices(s, 4)).length === 1, 20000), 'PRECONDITION: the first notice is published (it follows the answer)');
    const e1 = await effects(s);
    const b = await createPage(s, { ...REQ_A, title: 'A page', body: 'text', type: 'reference' });
    assert.ok(ok2xx(b.status), `the replay is a success, not a conflict (${b.status} ${b.text.slice(0, 200)})`);
    await sleep(2000);
    assert.deepEqual(await effects(s), e1, 'nothing changed: the same card, counter, allocator, posts and origins');
    assert.equal((await notices(s, 4)).length, 1, 'still exactly one notice');
    assert.equal((await cardRow(s, G('req-1744-a').cardId)).card.version, 1, 'the card was not rewritten');
  });
});

for (const [what, change] of [['a different title', { title: 'Another page' }], ['a different createdBy (semantic, declared)', { createdBy: 'grace' }], ['a different body', { body: 'other text' }], ['a parent added', { parent: 'uuid-1' }]]) {
  test(`#1744 (W3, mode off) the same requestId with ${what} → 409 ${CODES.REQUEST_CONFLICT}, no effect`, T, async () => {
    await world('off', async (s) => {
      await s.start();
      assert.equal((await createPage(s, REQ_A)).status, 201, 'PRECONDITION: the first create');
      assert.ok(await until(async () => (await notices(s, 4)).length === 1, 20000), 'PRECONDITION: the first notice is published (it follows the answer)');
      const e1 = await effects(s);
      const c = await createPage(s, { ...REQ_A, ...change });
      assert.equal(c.status, 409, `refused (${c.status} ${c.text.slice(0, 200)})`);
      assert.equal(c.json?.code, CODES.REQUEST_CONFLICT, 'with the named code');
      assert.deepEqual(await effects(s), e1, 'no effect');
    });
  });
}

test('#1744 (W4, mode off) another requestId with the same content is ANOTHER page: its own derived id, the next shortId', T, async () => {
  await world('off', async (s) => {
    await s.start();
    assert.equal((await createPage(s, REQ_A)).status, 201, 'PRECONDITION: the first create');
    const b = await createPage(s, { ...REQ_A, requestId: 'req-1744-b' });
    assert.equal(b.status, 201, `created (${b.status} ${b.text.slice(0, 200)})`);
    const row = await cardRow(s, G('req-1744-b').cardId);
    assert.ok(row?.card, 'read-back: the second derived id');
    assert.equal(row.card.shortId, 5, 'the next shortId');
    assert.deepEqual(await counterNow(s), [6], 'two creates, two advances');
  });
});

test('#1744 (W5, mode off) with NO requestId the server mints one and returns it; a retry under the returned id is the same page', T, async () => {
  await world('off', async (s) => {
    await s.start();
    const a = await createPage(s, { title: 'Minted', createdBy: 'ada' });
    assert.equal(a.status, 201, `created (${a.status} ${a.text.slice(0, 200)})`);
    const rid = a.json?.requestId;
    assert.ok(typeof rid === 'string' && rid.length > 0, `the response carries the minted requestId (${a.text.slice(0, 200)})`);
    assert.ok(await until(async () => (await notices(s, 4)).length === 1, 20000), 'PRECONDITION: the first notice is published (it follows the answer)');
    const e1 = await effects(s);
    const b = await createPage(s, { title: 'Minted', createdBy: 'ada', requestId: rid });
    assert.ok(ok2xx(b.status), `the keyed retry succeeds (${b.status})`);
    assert.deepEqual(await effects(s), e1, 'and changes nothing');
    const derived = mutationIdOf(`${mutationIdOf(keyOf(rid))}:card`);
    assert.ok((await cardRow(s, derived))?.card, 'the page has the id derived from the minted requestId');
  });
});

test('#1744 (W6, D8) the same create in mode on and mode off yields the same business JSON (parent, apex labels, defaults)', T, async () => {
  const req = { title: 'Child page', body: 'under card 1', parent: 'uuid-1', createdBy: 'ada', requestId: 'req-1744-w6' };
  const FIELDS = ['shortId', 'title', 'description', 'type', 'createdBy', 'parent', 'labels', 'column', 'order', 'priority', 'assignees', 'relationships', 'for', 'version', 'attachments'];
  const pick = (c) => Object.fromEntries(FIELDS.map((f) => [f, c[f] ?? null]));
  const got = {};
  for (const mode of ['on', 'off']) {
    await world(mode, async (s) => {
      await s.start();
      const p = await createPage(s, req);
      assert.ok(ok2xx(p.status), `${mode}: created (${p.status} ${p.text.slice(0, 200)})`);
      got[mode] = pick((await liveCards(s)).find((c) => c.card.title === 'Child page').card);
    });
  }
  assert.deepEqual(got.off, got.on, 'mode off creates the same page as mode on, field for field');
});

/** a create held between prepare and commit while `interleave` writes beneath REST; the create must refuse with NO effect
 *  beyond the interleaved write, and a keyed retry gets 409 STALE_PREPARED (never a silent replan) */
async function heldCreate(s, req, interleave, label) {
  const held = await s.holdAt(BARRIER, () => createPage(s, req));
  let first;
  try {
    assert.equal(held.reached, true, `${label}: PRECONDITION: the create reached ${BARRIER}`);
    assert.equal(held.returned(), false, `${label}: the create had not returned at the barrier`);
    const mid = mutationIdOf(keyOf(req.requestId));
    const P = await readPreparedOrigin(s.gc, mid);
    assert.ok(P.ok && P.prepared && !P.prepared.committedBy, `${label}: DISCRIMINATOR: the executor holds THIS create's Prepared record, uncommitted`);
    await interleave();
  } finally { await held.release(); first = await held.inflight; }
  const after = await effects(s);
  assert.ok(!ok2xx(first.status ?? 0), `${label}: the held create was REFUSED at commit (${first.status} ${String(first.text).slice(0, 200)})`);
  assert.equal(await cardRow(s, mutationIdOf(`${mutationIdOf(keyOf(req.requestId))}:card`)), null, `${label}: no card was created`);
  assert.ok(!(await committedOrigins(s)).some((o) => o.mid === mutationIdOf(keyOf(req.requestId))), `${label}: no Origin was committed`);
  const retry = await createPage(s, req);
  assert.equal(retry.status, 409, `${label}: a keyed retry is refused (${retry.status} ${retry.text.slice(0, 200)})`);
  assert.equal(retry.json?.code, CODES.STALE_PREPARED, `${label}: STALE_PREPARED, not a silent replan`);
  assert.deepEqual(await effects(s), after, `${label}: the retry had no effect`);
}

test('#1744 (W7, mode off) the COUNTER moves between prepare and commit → the create refuses, no effect; a keyed retry → STALE_PREPARED; a NEW key works', T, async () => {
  await world('off', async (s) => {
    await s.start();
    await heldCreate(s, { ...REQ_A, requestId: 'req-1744-w7' }, async () => {
      const o = s.other(); await o.load();
      const snap = o.snapshot();
      snap.cards.push({ ...snap.cards[0], id: 'uuid-other-1', shortId: snap.nextShortId, title: 'written beneath REST', relationships: { relatedTo: [], blockedBy: [], supersedes: [], derivedFrom: [] } });
      const r = await o.commit(snap.cards, snap.nextShortId + 1, { actor: 'ada' });
      assert.equal(r.outcome, 'APPLIED', 'PRECONDITION: the interleaved create applied');
    }, 'W7');
    const n = await createPage(s, { ...REQ_A, requestId: 'req-1744-w7-new' });
    assert.equal(n.status, 201, `a NEW key creates (${n.status} ${n.text.slice(0, 200)})`);
    assert.equal((await cardRow(s, mutationIdOf(`${mutationIdOf(keyOf('req-1744-w7-new'))}:card`))).card.shortId, 5, 'at the next free shortId');
  });
});

for (const [what, prep, interleave] of [
  ['the immediate PARENT changes', null, (c) => { const p = c.find((x) => x.id === 'uuid-1'); p.title = 'card 1 (renamed beneath REST)'; p.labels = ['l2']; }],
  ['an ANCESTOR changes while the immediate parent does not (F4)', async (s) => {
    const c2 = (await s.call('GET', '/api/cards/uuid-2')).json;
    const r = await s.call('PATCH', '/api/cards/uuid-2', { parent: 'uuid-1', ifVersion: c2.version, by: 'ada' });
    assert.equal(r.status, 200, `PRECONDITION: #2 is under #1 (${r.status} ${r.text.slice(0, 200)})`);
  }, (c) => { c.find((x) => x.id === 'uuid-1').labels = ['l2']; }],
]) {
  test(`#1744 (W8, mode off) ${what} between prepare and commit → the create refuses, no effect; a keyed retry → STALE_PREPARED`, T, async () => {
    await world('off', async (s) => {
      await s.start();
      if (prep) await prep(s);
      const parent = prep ? 'uuid-2' : 'uuid-1';
      await heldCreate(s, { title: 'A child', createdBy: 'ada', parent, requestId: `req-1744-w8-${prep ? 'anc' : 'par'}` }, async () => {
        const o = s.other(); await o.load();
        const snap = o.snapshot();
        interleave(snap.cards);
        const r = await o.commit(snap.cards, snap.nextShortId, { actor: 'ada' });
        assert.equal(r.outcome, 'APPLIED', 'PRECONDITION: the interleaved write applied');
      }, 'W8');
    });
  });
}

test('#1744 (W9, mode off) a card the NEW page names is deleted between prepare and commit → the create refuses, no dangling edge; a keyed retry → STALE_PREPARED', T, async () => {
  await world('off', async (s) => {
    await s.start();
    await heldCreate(s, { title: 'Names #3', body: 'see #3', createdBy: 'ada', requestId: 'req-1744-w9' }, async () => {
      const o = s.other(); await o.load();
      const snap = o.snapshot();
      const r = await o.commit(snap.cards.filter((c) => c.id !== 'uuid-3'), snap.nextShortId, { actor: 'ada' });
      assert.equal(r.outcome, 'APPLIED', 'PRECONDITION: #3 was deleted beneath REST');
    }, 'W9');
  });
});

test('#1744 (W10, mode off) a page create reaches the CHANGES feed, as an ordinary card create does (the control)', T, async () => {
  await world('off', async (s) => {
    await s.start();
    // a fresh world's event log begins at its first write, and a `since` before that is refused as partial: write once, then start the window
    const c0 = (await s.call('GET', '/api/cards/uuid-1')).json;
    assert.equal((await s.call('PATCH', '/api/cards/uuid-1', { title: 'card 1 (opens the log)', ifVersion: c0.version, by: 'ada' })).status, 200, 'PRECONDITION: a first write');
    await sleep(50);
    const t0 = new Date().toISOString();
    await sleep(50);
    const c = await s.call('POST', '/api/cards', { title: 'an ordinary card', createdBy: 'ada', requestId: `w10-ord-${process.pid}` });
    assert.ok(ok2xx(c.status), `PRECONDITION: an ordinary create (${c.status})`);
    const p = await createPage(s, { title: 'A fed page', createdBy: 'ada', requestId: 'req-1744-w10' });
    assert.equal(p.status, 201, `PRECONDITION: the page create (${p.status} ${p.text.slice(0, 160)})`);
    const pageId = mutationIdOf(`${mutationIdOf(keyOf('req-1744-w10'))}:card`);
    const feed = await s.call('GET', `/api/changes?since=${encodeURIComponent(t0)}`);
    assert.equal(feed.status, 200, `the feed answers (${feed.status} ${feed.text.slice(0, 240)})`);
    assert.ok(feed.text.includes(c.json.id), 'CONTROL: the ordinary create is in the feed');
    assert.ok(feed.text.includes(pageId), 'the page create is in the feed too (changes_since must see new pages)');
  });
});

test(`#1744 (R3b, mode off) a names SWAP that keeps count and sum ({2,4} → {1,5}) → a page create refuses ${CODES.INDEX_INCOMPLETE}, no effect`, T, async () => {
  await world('off', async (s) => {
    await s.start();
    const c1 = (await s.call('GET', '/api/cards/uuid-1')).json;
    assert.equal((await s.call('PATCH', '/api/cards/uuid-1', { description: 'see #2 and #4', ifVersion: c1.version, by: 'ada' })).status, 200, 'PRECONDITION: #1 names #2 and #4');
    assert.deepEqual((await coverageOf(s, 'uuid-1')).names, [INT(2), INT(4)], 'PRECONDITION: indexed as {2, 4}');
    await s.xu(`DELETE DATA { GRAPH <${BK}> { ${COV('uuid-1')} <${IX.namesShortId}> "2"^^<${XSD}integer> . ${COV('uuid-1')} <${IX.namesShortId}> "4"^^<${XSD}integer> } } ; INSERT DATA { GRAPH <${BK}> { ${COV('uuid-1')} <${IX.namesShortId}> "1"^^<${XSD}integer> . ${COV('uuid-1')} <${IX.namesShortId}> "5"^^<${XSD}integer> } }`, 'swap');
    const e0 = await effects(s);
    const p = await createPage(s, { title: 'Refused page', createdBy: 'ada', requestId: 'req-1744-r3b' });
    assert.ok(!ok2xx(p.status), `refused (${p.status} ${p.text.slice(0, 200)})`);
    assert.equal(p.json?.code, CODES.INDEX_INCOMPLETE, 'with the named code');
    assert.deepEqual(await effects(s), e0, 'no effect');
  });
});

// ── R: reference re-projection on create ──
for (const mode of ['on', 'off']) {
  test(`#1744 (R1, mode ${mode}) a PROSE-only #4 gets its edge in the SAME write that creates #4; before, no traversable edge exists; the referrer's JSON is unchanged`, T, async () => {
    await world(mode, async (s) => {
      await s.start();
      const c1 = (await s.call('GET', '/api/cards/uuid-1')).json;
      assert.equal((await s.call('PATCH', '/api/cards/uuid-1', { description: 'see #4 later', ifVersion: c1.version, by: 'ada' })).status, 200, 'PRECONDITION: #1 names #4 in prose');
      assert.deepEqual((await coverageOf(s, 'uuid-1')).names, [INT(4)], 'the index records the UNRESOLVED prose mention');
      assert.deepEqual(await mentionsEdges(s, 'uuid-1'), [], 'public: no traversable mention before #4 exists');
      assert.deepEqual((await s.q(`SELECT ?p WHERE { <${cardIriOf('uuid-1')}> ?p <${UNRESOLVED}4> }`)), [], 'public: a prose mention projects NO unresolved node');
      const json0 = (await cardRow(s, 'uuid-1')).json;
      const p = await createPage(s, { title: 'Page four', createdBy: 'ada', requestId: `req-1744-r1-${mode}` });
      assert.ok(ok2xx(p.status), `created (${p.status} ${p.text.slice(0, 200)})`);
      const four = (await liveCards(s)).find((c) => c.card.shortId === 4);
      assert.ok(four, 'PRECONDITION: the page is #4');
      assert.deepEqual(await mentionsEdges(s, 'uuid-1'), [four.iri], 'the mention edge exists IMMEDIATELY, to the new card');
      assert.equal((await cardRow(s, 'uuid-1')).json, json0, "the referrer's JSON is byte-identical (reference-resolve changes no semantic JSON)");
      await assertIndexComplete(s, 'after the create');
    });
  });
}

test('#1744 (R2, mode off) a STRUCTURED reference (blockedBy #4) moves from the unresolved node to the new card in the same write', T, async () => {
  await world('off', async (s) => {
    await s.start();
    const c3 = (await s.call('GET', '/api/cards/uuid-3')).json;
    assert.equal((await s.call('PATCH', '/api/cards/uuid-3', { relationships: { blockedBy: [4] }, ifVersion: c3.version, by: 'ada' })).status, 200, 'PRECONDITION: #3 is blocked by the unresolved #4');
    assert.deepEqual(await relEdges(s, 'uuid-3', 'blockedBy'), [`${UNRESOLVED}4`], 'before: the edge points at the unresolved node');
    const p = await createPage(s, { title: 'Page four', createdBy: 'ada', requestId: 'req-1744-r2' });
    assert.equal(p.status, 201, `created (${p.status} ${p.text.slice(0, 200)})`);
    const four = (await liveCards(s)).find((c) => c.card.shortId === 4);
    assert.deepEqual(await relEdges(s, 'uuid-3', 'blockedBy'), [four.iri], 'after: the edge points at the new card, and only there');
  });
});

/** F2: each damaged index state planted beneath the compiler after a COMPLETE backfill. Control: IDX-0 and W1 (undamaged). */
const COV = (id) => `<${IX.card(id)}>`;
/** a quad in the plan's OWN term shape (cardQuads: three {type, value[, datatype]} terms) */
const Q = (s_, p_, o_) => [{ type: 'uri', value: s_ }, { type: 'uri', value: p_ }, o_.startsWith('literal:') ? { type: 'literal', value: o_.slice(8) } : { type: 'uri', value: o_ }];
const DAMAGE = [
  ['a live card with NO coverage node', async ({ xu }) => xu(`DELETE WHERE { GRAPH <${BK}> { ${COV('uuid-2')} ?p ?o } }`, 'no-coverage')],
  ['an INTACT watermark with one name removed', async ({ xu }) => xu(`DELETE DATA { GRAPH <${BK}> { ${COV('uuid-2')} <${IX.namesShortId}> "1"^^<${XSD}integer> } }`, 'name-removed')],
  ['an EXTRA name', async ({ xu }) => xu(`INSERT DATA { GRAPH <${BK}> { ${COV('uuid-1')} <${IX.namesShortId}> "9"^^<${XSD}integer> } }`, 'name-extra')],
  ['a MISTYPED name (a plain string)', async ({ xu }) => xu(`DELETE DATA { GRAPH <${BK}> { ${COV('uuid-2')} <${IX.namesShortId}> "1"^^<${XSD}integer> } } ; INSERT DATA { GRAPH <${BK}> { ${COV('uuid-2')} <${IX.namesShortId}> "1" } }`, 'name-mistyped')],
  // a WELL-FORMED orphan (every coverage field, zero names), so only the orphan clause (S13, review 46326) can refuse it
  ['an ORPHAN coverage node (no such card)', async ({ xu }) => xu(`INSERT DATA { GRAPH <${BK}> { ${COV('uuid-ghost')} <${IX.indexedVersion}> "1"^^<${XSD}integer> ; <${IX.indexedJsonDigest}> "${'0'.repeat(64)}" ; <urn:ex:card-ref-index/namesCount> "0"^^<${XSD}integer> ; <urn:ex:card-ref-index/namesSum> "0"^^<${XSD}integer> } }`, 'orphan')],
  ['a DUPLICATE watermark', async ({ xu }) => xu(`INSERT DATA { GRAPH <${BK}> { ${COV('uuid-1')} <${IX.indexedVersion}> "99"^^<${XSD}integer> } }`, 'dup-version')],
  ['a MISMATCHED JSON digest', async ({ q, xu }) => { const ds = await q(`SELECT ?d WHERE { GRAPH <${BK}> { ${COV('uuid-1')} <${IX.indexedJsonDigest}> ?d } }`); assert.equal(ds.length, 1, 'PRECONDITION: the backfill wrote card 1\'s digest'); const d = ds[0].d.value; await xu(`DELETE DATA { GRAPH <${BK}> { ${COV('uuid-1')} <${IX.indexedJsonDigest}> "${d}" } } ; INSERT DATA { GRAPH <${BK}> { ${COV('uuid-1')} <${IX.indexedJsonDigest}> "${'f'.repeat(64)}" } }`, 'bad-digest'); }],
  ['NO completion marker (a partial backfill)', async ({ xu }) => xu(`DELETE WHERE { GRAPH <${BK}> { <${IX.marker}> ?p ?o } }`, 'no-marker')],
];
for (const [what, plant] of DAMAGE) {
  test(`#1744 (R3, mode off) ${what} → a page create refuses ${CODES.INDEX_INCOMPLETE}, no effect`, T, async () => {
    await world('off', async (s) => {
      await s.start();
      const e0 = await effects(s);
      const p = await createPage(s, { title: 'Refused page', createdBy: 'ada', requestId: 'req-1744-r3' });
      assert.ok(!ok2xx(p.status), `refused (${p.status} ${p.text.slice(0, 200)})`);
      assert.equal(p.json?.code, CODES.INDEX_INCOMPLETE, `with the named code (${p.text.slice(0, 200)})`);
      assert.deepEqual(await effects(s), e0, 'no effect');
    }, { plant });
  });
}
test(`#1744 (R3, mode off) no backfill at all → a page create refuses ${CODES.INDEX_INCOMPLETE}, no effect (an absent index never means "no references")`, T, async () => {
  await world('off', async (s) => {
    await s.start();
    const e0 = await effects(s);
    const p = await createPage(s, { title: 'Refused page', createdBy: 'ada', requestId: 'req-1744-r3n' });
    assert.ok(!ok2xx(p.status), `refused (${p.status} ${p.text.slice(0, 200)})`);
    assert.equal(p.json?.code, CODES.INDEX_INCOMPLETE, 'with the named code');
    assert.deepEqual(await effects(s), e0, 'no effect');
  }, { index: 'none' });
});
test(`#1744 (R3, mode off) a DELETE is index-dependent too: with a coverage node missing it refuses ${CODES.INDEX_INCOMPLETE}, no effect`, T, async () => {
  await world('off', async (s) => {
    await s.start();
    const e0 = await effects(s);
    const d = await s.call('DELETE', '/api/cards/uuid-3?by=ada');
    assert.ok(!ok2xx(d.status), `refused (${d.status} ${d.text.slice(0, 200)})`);
    assert.equal(d.json?.code, CODES.INDEX_INCOMPLETE, 'with the named code');
    assert.deepEqual(await effects(s), e0, 'no effect: #3 is still live');
  }, { plant: DAMAGE[0][1] });
});

for (const [what, pre, edit] of [
  ['a NEW referrer of #4 is written', null, (c) => { c.find((x) => x.id === 'uuid-3').description = 'now names #4'; }],
  ['an existing referrer of #4 drops it', 'see #4 later', (c) => { c.find((x) => x.id === 'uuid-1').description = 'no longer'; }],
]) {
  test(`#1744 (R4, mode off) between prepare and commit ${what} → the create refuses, no effect; a keyed retry → STALE_PREPARED`, T, async () => {
    await world('off', async (s) => {
      await s.start();
      if (pre) { const c1 = (await s.call('GET', '/api/cards/uuid-1')).json; assert.equal((await s.call('PATCH', '/api/cards/uuid-1', { description: pre, ifVersion: c1.version, by: 'ada' })).status, 200, 'PRECONDITION: #1 names #4'); }
      await heldCreate(s, { title: 'Page four', createdBy: 'ada', requestId: `req-1744-r4-${pre ? 'drop' : 'new'}` }, async () => {
        const o = s.other(); await o.load();
        const snap = o.snapshot();
        edit(snap.cards);
        const r = await o.commit(snap.cards, snap.nextShortId, { actor: 'ada' });
        assert.equal(r.outcome, 'APPLIED', 'PRECONDITION: the interleaved referrer write applied');
      }, 'R4');
      await assertIndexComplete(s, 'after the refused create');
    });
  });
}

// ── C: the compiler, fed hand-built wiki-create origin plans ──
/** Build a valid wiki-create origin from the EXISTING cards unit's plan: a new card #N plus every C12 re-projection part. */
async function wikiCreateOrigin(s, requestId, { title = 'Hand-built page', cardId: forcedId = null } = {}) {
  const u = createCardsUnit({ client: s.gc, mintId: () => crypto.randomUUID() });
  await u.load();
  const snap = u.snapshot();
  const key = keyOf(requestId), mid = mutationIdOf(key), cardId = forcedId ?? mutationIdOf(`${mid}:card`);
  const req = { title, body: '', createdBy: 'ada' };
  const at = '2026-10-25T03:00:00.000Z';   // F4 (b): the plan's own frozen timestamps
  const card = { version: 1, id: cardId, shortId: snap.nextShortId, title, description: '', type: 'reference', assignees: ['unassigned'], labels: [], for: '', priority: null, column: 'backlog', order: 0, createdAt: at, updatedAt: at, createdBy: 'ada', relationships: { relatedTo: [], blockedBy: [], supersedes: [], derivedFrom: [] }, claimedBy: null, claimedAt: null };
  const p = u.plan([...snap.cards, card], snap.nextShortId + 1);
  const subject = cardIriOf(cardId);
  const parts = p.parts.map((x) => (x.iri === subject ? x : { ...x, reason: 'reference-resolve' })).sort((a, b) => (a.iri < b.iri ? -1 : a.iri > b.iri ? 1 : 0));
  const descriptor = { route: 'wiki-create', subject: 'wiki', requestKey: requestId, originActor: 'board', mutationId: mid, provenance: { cardId, version: 1, requestDigest: requestDigestOf(req) }, slots: [{ slot: 'wiki', author: 'wiki', body: `📄 page created: **${title}** (#${card.shortId})`, mentions: [], notify: false }] };
  return { mid, cardId, shortId: card.shortId, descriptor, plan: { parts, counter: p.counter } };
}
/** prepare then commit, as commitOrigin does; returns both outcomes */
async function submit(s, o) {
  const actor = o.descriptor.originActor === 'board' ? BOARD : `https://scrumboard.local/person/${o.descriptor.originActor}`;
  const prep = await durableUpdate(s.gc, { kind: 'origin.prepare', opId: originPrepareOp(o.mid), actor, origin: o.descriptor, plan: o.plan });
  if (prep.outcome !== 'APPLIED') return { prep, commit: null };
  const P = await readPreparedOrigin(s.gc, o.mid);
  if (!P.ok || !P.prepared) return { prep, commit: { outcome: 'UNREADABLE' } };
  const commit = await durableUpdate(s.gc, { kind: 'card.write', opId: originCommitOp(o.mid), actor, ...o.plan, origin: { ...o.descriptor, occurredAt: P.prepared.occurredAt } });
  return { prep, commit };
}
const REFUSAL = new Set(['REJECTED', 'PRECONDITION_FAILED']);
/** A refusal counts only beside its OWN positive control: the same shape, unforged, under its own key, must be ADMITTED at
 *  prepare first (else a compiler that refuses the whole route passes every forged row; measured 03:2xZ against 58d0a5c1).
 *  The control's Prepared record is allowed to remain (D9); effects are measured after it. */
async function expectRefused(s, o, control, label) {
  const ctl = await control();
  const cp = await durableUpdate(s.gc, { kind: 'origin.prepare', opId: originPrepareOp(ctl.mid), actor: ctl.descriptor.originActor === 'board' ? BOARD : `https://scrumboard.local/person/${ctl.descriptor.originActor}`, origin: ctl.descriptor, plan: ctl.plan });
  assert.equal(cp.outcome, 'APPLIED', `${label}: CONTROL: the same shape UNFORGED is admitted at prepare (${JSON.stringify(cp).slice(0, 240)})`);
  const e0 = await effects(s);
  // the client turns a ValidationError into REJECTED itself, so anything THROWN is a crash, never a refusal (review 46326 item 7)
  let r;
  try { r = await submit(s, o); } catch (e) { assert.fail(`${label}: the compiler CRASHED instead of refusing (${e?.name}: ${String(e?.message || e).slice(0, 200)})`); }
  const outcome = r.prep.outcome !== 'APPLIED' ? r.prep.outcome : r.commit.outcome;
  assert.ok(REFUSAL.has(outcome), `${label}: refused by the compiler/executor (${outcome} ${JSON.stringify(r).slice(0, 240)})`);
  assert.deepEqual(await effects(s), e0, `${label}: no effect`);
}
async function cWorld(body) {
  await world('off', async (s) => {
    const c1 = await cardRow(s, 'uuid-1');
    // #1 names the card the plan will create (#4), so the plan carries a reference-resolve part
    const u = createCardsUnit({ client: s.gc, mintId: () => crypto.randomUUID() }); await u.load();
    const snap = u.snapshot(); snap.cards.find((c) => c.id === 'uuid-1').description = `${c1.card.description} and #${snap.nextShortId}`;
    assert.equal((await u.commit(snap.cards, snap.nextShortId, { actor: 'ada' })).outcome, 'APPLIED', 'PRECONDITION: #1 names the next shortId');
    await body(s);
  });
}

test('#1744 (C0 CONTROL) a hand-built VALID wiki-create origin is admitted: the card, the counter, the resolved edge, the index', T, async () => {
  await cWorld(async (s) => {
    const o = await wikiCreateOrigin(s, 'req-1744-c0');
    assert.ok(o.plan.parts.some((p) => p.reason === 'reference-resolve' && p.iri === cardIriOf('uuid-1')), 'PRECONDITION: the plan holds #1 as a reference-resolve part');
    assert.ok(o.plan.counter, 'PRECONDITION: the plan carries the counter part');
    const r = await submit(s, o);
    assert.equal(r.prep.outcome, 'APPLIED', `prepare admitted (${JSON.stringify(r.prep).slice(0, 240)})`);
    assert.equal(r.commit.outcome, 'APPLIED', `commit admitted (${JSON.stringify(r.commit).slice(0, 240)})`);
    assert.ok((await cardRow(s, o.cardId))?.card, 'read-back: the card');
    assert.deepEqual(await counterNow(s), [o.shortId + 1], 'the counter advanced once');
    assert.deepEqual(await mentionsEdges(s, 'uuid-1'), [cardIriOf(o.cardId)], "#1's mention resolved");
    await assertIndexComplete(s, 'after the hand-built create');
  });
});

const FORGE = [
  ['the reference-resolve part OMITTED', (o) => { o.plan.parts = o.plan.parts.filter((p) => p.reason !== 'reference-resolve'); }],
  ['a SURPLUS reference-resolve part (#3 names nothing)', null],
  ["a referrer's JSON CHANGED under reference-resolve", (o) => { const p = o.plan.parts.find((x) => x.reason === 'reference-resolve'); const j = JSON.parse(p.json); j.title = 'retitled under cover'; p.json = JSON.stringify(j); }],
  // S3: an ADDED triple that does not point at the new card
  ['an UNRELATED quad ADDED to a referrer part', (o) => { const p = o.plan.parts.find((x) => x.reason === 'reference-resolve'); p.quads = [...p.quads, Q(p.iri, `${RS}relatedTo`, cardIriOf('uuid-3'))]; }],
  // finding 2 (D6): an added edge that DOES point at the new card, but the referrer's JSON does not name it; quads must equal cardQuads(json)
  ['an edge to the new card the referrer\'s JSON does not name', (o) => { const p = o.plan.parts.find((x) => x.reason === 'reference-resolve'); p.quads = [...p.quads, Q(p.iri, `${RS}relatedTo`, cardIriOf(o.cardId))]; }],
  // S17: one of the referrer's OWN existing triples REMOVED (it never pointed at the unresolved node)
  ['one of the referrer\'s own triples REMOVED', (o) => { const p = o.plan.parts.find((x) => x.reason === 'reference-resolve'); const k = p.quads.findIndex((q) => q[0].value === p.iri && q[2].value !== cardIriOf(o.cardId) && q[1].value !== `${RS}mentionsCard`); assert.ok(k >= 0, 'PRECONDITION: the referrer has a triple to remove'); p.quads = p.quads.filter((_, i) => i !== k); }],
  ['a CALLER-SUPPLIED index quad', (o) => { const p = o.plan.parts.find((x) => x.iri === cardIriOf(o.cardId)); p.quads = [...p.quads, [{ type: 'uri', value: IX.card(o.cardId) }, { type: 'uri', value: IX.namesShortId }, { type: 'literal', value: '1', datatype: `${XSD}integer` }]]; }],
  ['a subject part that is NOT the derived card id', (o) => { const p = o.plan.parts.find((x) => x.iri === cardIriOf(o.cardId)); p.iri = cardIriOf('uuid-not-derived'); }],
  ['provenance.cardId that is NOT the derived card id', (o) => { o.descriptor.provenance.cardId = 'uuid-not-derived'; }],
  ['a DUPLICATE part', (o) => { const p = o.plan.parts.find((x) => x.reason === 'reference-resolve'); o.plan.parts = [...o.plan.parts, { ...p }].sort((a, b) => (a.iri < b.iri ? -1 : a.iri > b.iri ? 1 : 0)); }],
  ['a counter that is not the frozen one (+2)', (o) => { o.plan.counter = { ...o.plan.counter, next: String(Number(o.plan.counter.next) + 1) }; }],
];
for (const [what, forge] of FORGE) {
  test(`#1744 (C1) a hand-built wiki-create with ${what} is REFUSED, no effect`, T, async () => {
    await cWorld(async (s) => {
      const o = await wikiCreateOrigin(s, `req-1744-c1-${FORGE.findIndex(([w]) => w === what)}`);
      if (forge) forge(o);
      else {   // the surplus part: #3, its stored JSON and its exact current projection, re-sent as if it resolved something.
        // Internally consistent, so ONLY "its coverage names #N" (S16, review 46326) can refuse it.
        const c3 = await cardRow(s, 'uuid-3');
        const u = createCardsUnit({ client: s.gc, mintId: () => crypto.randomUUID() }); await u.load();
        const cards = u.snapshot().cards;
        const newCard = JSON.parse(o.plan.parts.find((x) => x.iri === cardIriOf(o.cardId)).json);
        const after = shortIdMap([...cards, newCard]), before = shortIdMap(cards);
        o.plan.parts = [...o.plan.parts, { iri: cardIriOf('uuid-3'), expectedVersion: String(c3.ver), version: String(c3.ver + 1), quads: cardQuads(c3.card, after), prior: priorQuads(c3.card, before), json: c3.json, reason: 'reference-resolve' }].sort((a, b) => (a.iri < b.iri ? -1 : a.iri > b.iri ? 1 : 0));
      }
      await expectRefused(s, o, () => wikiCreateOrigin(s, `req-1744-c1-ctl-${FORGE.findIndex(([w]) => w === what)}`), what);
    });
  });
}
test('#1744 (C2) every route OTHER than wiki-create still refuses a counter (wiki-update with a counter part)', T, async () => {
  await cWorld(async (s) => {
    const u = createCardsUnit({ client: s.gc, mintId: () => crypto.randomUUID() }); await u.load();
    const snap = u.snapshot(); snap.cards.find((c) => c.id === 'uuid-2').description = 'edited page';
    const p = u.plan(snap.cards, snap.nextShortId);
    const part = p.parts.find((x) => x.iri === cardIriOf('uuid-2'));
    const key = JSON.stringify(['origin-v1', 'wiki', 'uuid-2', 'req-1744-c2', 'board']); const mid = mutationIdOf(key);
    const wikiUpdate = (rk, counter) => { const m = mutationIdOf(JSON.stringify(['origin-v1', 'wiki', 'uuid-2', rk, 'board'])); return { mid: m, descriptor: { route: 'wiki', subject: 'uuid-2', requestKey: rk, originActor: 'board', mutationId: m, provenance: { cardId: 'uuid-2', version: Number(part.version) }, slots: [{ slot: 'wiki', author: 'wiki', body: '📄 page updated', mentions: [], notify: false }] }, plan: { parts: [part], ...(counter ? { counter } : {}) } }; };
    void key; void mid;
    await expectRefused(s, wikiUpdate('req-1744-c2', { expected: String(snap.nextShortId), next: String(snap.nextShortId + 1) }), async () => wikiUpdate('req-1744-c2-ctl', null), 'a wiki-update carrying a counter');
  });
});

// ── E: the sibling walk ──
/** done-column setup through the public API: extra cards created and moved into done at explicit orders, no makeRoom */
async function doneColumn(s, orders) {
  const ids = [];
  for (const [k, ord] of orders.entries()) {
    const c = await s.call('POST', '/api/cards', { title: `sib ${k}`, createdBy: 'ada', requestId: `sib-${k}-${process.pid}` });
    assert.ok(ok2xx(c.status), `PRECONDITION: sibling ${k} created (${c.status} ${c.text.slice(0, 200)})`);
    const m = await s.call('PATCH', `/api/cards/${c.json.id}`, { column: 'done', order: ord, ifVersion: c.json.version, by: 'ada' });
    assert.equal(m.status, 200, `PRECONDITION: sibling ${k} moved into done at ${ord} (${m.status} ${m.text.slice(0, 200)})`);
    ids.push(c.json.id);
  }
  return ids;
}
/** V2-3's walk, written here independently: (order asc, shortId asc), the anchor rules, stop at the first gap, floor + 1 */
function expectedWalk(cards, moved, at, anchor) {
  const seq = cards.filter((c) => c.id !== moved && c.column === 'done').map((c) => ({ c, o: Number(c.order) || 0 })).sort((a, b) => (a.o - b.o) || (a.c.shortId - b.c.shortId));
  let walk;
  if (anchor === undefined) walk = seq.filter(({ o }) => o >= at); else if (anchor === null) walk = seq; else walk = seq.slice(seq.findIndex(({ c }) => c.id === anchor) + 1);
  const out = []; let floor = at;
  for (const { c, o } of walk) { if (o > floor) break; floor += 1; out.push({ id: c.id, order: floor }); }
  return out;
}
async function doneMoveRow(s, { orders, at, after, label }) {
  const sibs = await doneColumn(s, orders);
  const before = new Map((await liveCards(s)).map((c) => [c.card.id, c]));
  const want = expectedWalk([...before.values()].map((c) => c.card), 'uuid-1', at, after);
  assert.ok(want.length > 0, `${label}: PRECONDITION: this move shifts at least one sibling`);
  const o0 = (await committedOrigins(s)).length;
  const c1 = (await s.call('GET', '/api/cards/uuid-1')).json;
  const m = await s.call('PATCH', '/api/cards/uuid-1', { column: 'done', order: at, makeRoom: true, ...(after !== undefined ? { after } : {}), ifVersion: c1.version, by: 'ada' });
  assert.equal(m.status, 200, `${label}: the done-move is applied (${m.status} ${m.text.slice(0, 300)})`);
  const now = new Map((await liveCards(s)).map((c) => [c.card.id, c]));
  for (const { id, order } of want) {
    const a = before.get(id).card, b = now.get(id).card;
    const { order: _o1, version: v1, ...restA } = a; const { order: _o2, version: v2, ...restB } = b;
    assert.equal(b.order, order, `${label}: sibling #${a.shortId} shifted to exactly ${order}`);
    assert.equal(v2, Number.isInteger(v1) && v1 >= 0 ? v1 + 1 : 1, `${label}: sibling #${a.shortId}: version bumped by bumpCardVersion's rule`);
    assert.deepEqual(restB, restA, `${label}: sibling #${a.shortId}: NOTHING else changed (updatedAt included)`);
  }
  const moved = new Set([...want.map((x) => x.id), 'uuid-1']);
  for (const [id, c] of before) if (!moved.has(id) && now.has(id)) assert.equal(now.get(id).json, c.json, `${label}: #${c.card.shortId} is untouched`);
  // mode on writes no executor Origin (the document path announces): the one-origin claim is executor-owned mode's
  if (s.mode === 'off') assert.equal((await committedOrigins(s)).length, o0 + 1, `${label}: ONE origin covers the whole move`);
  assert.equal((await cardRow(s, 'uuid-1')).card.column, 'done', `${label}: the subject is in done`);
  return { sibs, want };
}

test('#1744 (E0 CONTROL, mode on, CARDS unit) the done-move shifts as today, ties broken by (order, shortId) (F1)', T, async () => {
  await world('on', async (s) => { await s.start(); await doneMoveRow(s, { orders: [3, 4, 6], at: 3, label: 'E0' }); });
});
test('#1744 (E1, mode off) a done-move that shifts siblings WORKS: the exact chain, stopping at the first gap; one origin; only order and version change', T, async () => {
  await world('off', async (s) => { await s.start(); const r = await doneMoveRow(s, { orders: [4, 6], at: 3, label: 'E1' }); assert.equal(r.want.length, 2, 'PRECONDITION: #3 and the order-4 sibling shift; the order-6 sibling is past the gap'); });
});
test('#1744 (E2, mode off) a DUPLICATE-order pair shifts in shortId order (the pinned tie-break)', T, async () => {
  await world('off', async (s) => { await s.start(); await doneMoveRow(s, { orders: [4, 4], at: 4, label: 'E2' }); });
});
test('#1744 (E3, mode off) an ANCHORED move (after the first of a tied pair) shifts only the cards after the anchor', T, async () => {
  await world('off', async (s) => {
    await s.start();
    const sibs = await doneColumn(s, [4, 4]);
    const before = new Map((await liveCards(s)).map((c) => [c.card.id, c.card]));
    const want = expectedWalk([...before.values()], 'uuid-1', 5, sibs[0]);
    assert.deepEqual(want.map((x) => x.id), [sibs[1]], 'PRECONDITION: the walk after the anchor holds only the second of the pair');
    const c1 = (await s.call('GET', '/api/cards/uuid-1')).json;
    const m = await s.call('PATCH', '/api/cards/uuid-1', { column: 'done', order: 5, makeRoom: true, after: sibs[0], ifVersion: c1.version, by: 'ada' });
    assert.equal(m.status, 200, `applied (${m.status} ${m.text.slice(0, 200)})`);
    assert.equal((await cardRow(s, sibs[0])).card.order, 4, 'the anchor stays');
    assert.equal((await cardRow(s, sibs[1])).card.order, 6, 'the card after the anchor moves to 6');
  });
});
test('#1744 (E4, mode off) a move to the TOP of done (after: null) walks from the first card', T, async () => {
  await world('off', async (s) => { await s.start(); await doneMoveRow(s, { orders: [0, 1], at: 0, after: null, label: 'E4' }); });
});
test('#1744 (E5, mode off) a sibling changed between prepare and commit → the move refuses; nothing of it lands', T, async () => {
  await world('off', async (s) => {
    await s.start();
    const sibs = await doneColumn(s, [4]);
    const c1 = (await s.call('GET', '/api/cards/uuid-1')).json;
    const held = await s.holdAt(BARRIER, () => s.call('PATCH', '/api/cards/uuid-1', { column: 'done', order: 3, makeRoom: true, ifVersion: c1.version, by: 'ada' }));
    let res, mid;
    try {
      assert.equal(held.reached, true, `PRECONDITION: the move reached ${BARRIER}`);
      const o = s.other(); await o.load();
      const snap = o.snapshot(); snap.cards.find((c) => c.id === sibs[0]).title = 'edited beneath REST';
      assert.equal((await o.commit(snap.cards, snap.nextShortId, { actor: 'ada' })).outcome, 'APPLIED', 'PRECONDITION: the interleaved sibling edit applied');
      mid = (await committedOrigins(s)).length;
    } finally { await held.release(); res = await held.inflight; }
    assert.ok(!ok2xx(res.status ?? 0), `the move was refused at commit (${res.status} ${String(res.text).slice(0, 200)})`);
    assert.equal((await cardRow(s, 'uuid-1')).card.column, c1.column, 'the subject did not move');
    assert.equal((await cardRow(s, 'uuid-3')).card.order, 3, '#3 did not shift');
    assert.equal((await committedOrigins(s)).length, mid, 'no origin committed');
  });
});

/** a valid hand-built done-nudge origin for #1 moving to done at `at`, siblings from the existing plan */
async function doneNudgeOrigin(s, at, requestKey, { shift: forged = null, anchor = undefined } = {}) {
  const u = createCardsUnit({ client: s.gc, mintId: () => crypto.randomUUID() }); await u.load();
  const snap = u.snapshot();
  const shift = forged ? forged(snap.cards) : new Map(expectedWalk(snap.cards, 'uuid-1', at, anchor).map((x) => [x.id, x.order]));
  for (const c of snap.cards) {
    if (c.id === 'uuid-1') { c.column = 'done'; c.order = at; c.version = (Number.isInteger(c.version) && c.version >= 0 ? c.version : 0) + 1; }
    else if (shift.has(c.id)) { c.order = shift.get(c.id); c.version = (Number.isInteger(c.version) && c.version >= 0 ? c.version : 0) + 1; }
  }
  const p = u.plan(snap.cards, snap.nextShortId);
  const subject = cardIriOf('uuid-1');
  const parts = p.parts.map((x) => (x.iri === subject ? x : { ...x, reason: 'sibling-order' })).sort((a, b) => (a.iri < b.iri ? -1 : a.iri > b.iri ? 1 : 0));
  const key = JSON.stringify(['origin-v1', 'done-nudge', 'uuid-1', requestKey, 'ada']); const mid = mutationIdOf(key);
  const sp = parts.find((x) => x.iri === subject);
  return { mid, shifted: [...shift.keys()], ...(anchor !== undefined ? { walkAnchor: anchor } : {}), descriptor: { route: 'done-nudge', subject: 'uuid-1', requestKey, originActor: 'ada', mutationId: mid, provenance: { cardId: 'uuid-1', version: Number(sp.version) }, slots: [{ slot: 'done-nudge', author: 'board', body: "✅ #1 done — what's the next pull? (every done has a next: claim it, or name its gate)", mentions: [], notify: true }] }, plan: { parts, ...(anchor !== undefined ? { walk: { anchor: anchor === null ? null : cardIriOf(anchor) } } : {}) } };
}
test('#1744 (E6 CONTROL) a hand-built VALID done-nudge origin with its sibling parts is admitted', T, async () => {
  await world('off', async (s) => {
    await s.start(); await doneColumn(s, [4]);
    const o = await doneNudgeOrigin(s, 3, 'req-1744-e6');
    assert.equal(o.shifted.length, 2, 'PRECONDITION: two siblings shift (#3 and the order-4 card)');
    const r = await submit(s, o);
    assert.equal(r.prep.outcome, 'APPLIED', `prepare admitted (${JSON.stringify(r.prep).slice(0, 240)})`);
    assert.equal(r.commit.outcome, 'APPLIED', `commit admitted (${JSON.stringify(r.commit).slice(0, 240)})`);
  });
});
const SFORGE = [
  ['a shifted sibling OMITTED', (o) => { o.plan.parts = o.plan.parts.filter((p) => p.iri !== cardIriOf(o.shifted[1])); }],
  ['a sibling with ANOTHER field changed (title)', (o) => { const p = o.plan.parts.find((x) => x.reason === 'sibling-order'); const j = JSON.parse(p.json); j.title = 'retitled'; p.json = JSON.stringify(j); }],
  ['a FORGED order (+1 beyond the walk)', (o) => { const p = o.plan.parts.find((x) => x.reason === 'sibling-order'); const j = JSON.parse(p.json); j.order += 1; p.json = JSON.stringify(j); }],
  ['a sibling whose version was NOT bumped', (o) => { const p = o.plan.parts.find((x) => x.reason === 'sibling-order'); const j = JSON.parse(p.json); j.version -= 1; p.json = JSON.stringify(j); }],
  ['a DUPLICATE sibling part', (o) => { const p = o.plan.parts.find((x) => x.reason === 'sibling-order'); o.plan.parts = [...o.plan.parts, { ...p }].sort((a, b) => (a.iri < b.iri ? -1 : a.iri > b.iri ? 1 : 0)); }],
  // S7: a sibling whose quads change more than its order
  ['an UNRELATED quad in a sibling part', (o) => { const p = o.plan.parts.find((x) => x.reason === 'sibling-order'); p.quads = [...p.quads, Q(p.iri, `${RS}relatedTo`, cardIriOf('uuid-2'))]; }],
  // finding 7: a single-part done-nudge whose SUBJECT carries the reason must be REJECTED, never crash the compiler
  ['its SUBJECT part carrying reason sibling-order and no siblings', (o) => { o.plan.parts = o.plan.parts.filter((p) => p.iri === cardIriOf('uuid-1')).map((p) => ({ ...p, reason: 'sibling-order' })); }],
];
for (const [what, forge] of SFORGE) {
  test(`#1744 (E7) a hand-built done-nudge with ${what} is REFUSED, no effect`, T, async () => {
    await world('off', async (s) => {
      await s.start(); await doneColumn(s, [4]);
      const o = await doneNudgeOrigin(s, 3, `req-1744-e7-${SFORGE.findIndex(([w]) => w === what)}`);
      forge(o);
      await expectRefused(s, o, () => doneNudgeOrigin(s, 3, `req-1744-e7-ctl-${SFORGE.findIndex(([w]) => w === what)}`), what);
    });
  });
}
for (const [what, orders, forge] of [
  // S9: the order-9 card is past the gap; listed with a consistent JSON/version/quads as the next in the chain, only the gap check refuses it
  ['a card PAST THE GAP listed as shifted (S9)', [4, 9], (cards, sibs) => new Map([['uuid-3', 4], [sibs[0], 5], [sibs[1], 6]])],
  // finding 1: a card BELOW the slot (order 1) listed first, the chain renumbered after it: consistent, and not the walk
  ['a card BELOW the slot listed as shifted (finding 1)', [1, 4], (cards, sibs) => new Map([[sibs[0], 4], ['uuid-3', 5], [sibs[1], 6]])],
]) {
  test(`#1744 (E8) a hand-built done-nudge with ${what} is REFUSED, beside its control, no effect`, T, async () => {
    await world('off', async (s) => {
      await s.start(); const sibs = await doneColumn(s, orders);
      const o = await doneNudgeOrigin(s, 3, `req-1744-e8-${orders.join('-')}`, { shift: (cards) => forge(cards, sibs) });
      await expectRefused(s, o, () => doneNudgeOrigin(s, 3, `req-1744-e8-ctl-${orders.join('-')}`), what);
    });
  });
}
// P1b (review 46326): an ANCHORED walk (#1 to order 5, after X of the tied pair X, Y at 4) shifts only Y; a plan that also shifts X,
// the card BEFORE the anchor, with a consistent chain, must be refused. The control is the same anchored plan, unforged.
test('#1744 (E8) a hand-built ANCHORED done-nudge that also shifts the card BEFORE its anchor is REFUSED, beside its control, no effect', T, async () => {
  await world('off', async (s) => {
    await s.start(); const sibs = await doneColumn(s, [4, 4]);
    const o = await doneNudgeOrigin(s, 5, 'req-1744-e8-anchor', { anchor: sibs[0], shift: () => new Map([[sibs[0], 6], [sibs[1], 7]]) });
    await expectRefused(s, o, () => doneNudgeOrigin(s, 5, 'req-1744-e8-anchor-ctl', { anchor: sibs[0] }), 'shifting the card before the anchor');
  });
});
test('#1744 (E7) a hand-built done-nudge with a SURPLUS sibling (a done card past the gap, re-sent as shifted) is REFUSED, no effect', T, async () => {
  await world('off', async (s) => {
    await s.start(); const sibs = await doneColumn(s, [4, 9]);
    const o = await doneNudgeOrigin(s, 3, 'req-1744-e7-surplus');
    assert.ok(!o.shifted.includes(sibs[1]), 'PRECONDITION: the order-9 card is past the gap');
    const u = createCardsUnit({ client: s.gc, mintId: () => crypto.randomUUID() }); await u.load();
    const extra = u.plan(u.snapshot().cards.map((c) => (c.id === sibs[1] ? { ...c, order: 10, version: c.version + 1 } : c)), null).parts.find((x) => x.iri === cardIriOf(sibs[1]));
    o.plan.parts = [...o.plan.parts, { ...extra, reason: 'sibling-order' }].sort((a, b) => (a.iri < b.iri ? -1 : a.iri > b.iri ? 1 : 0));
    await expectRefused(s, o, () => doneNudgeOrigin(s, 3, 'req-1744-e7-surplus-ctl'), 'a surplus sibling');
  });
});

// ── r3 (review 46387, reproduced 46391): forgeries the first two row sets admitted, and guards no row reached ──
/** a world where #1 names the NEXT shortId as a STRUCTURED reference (relatedTo), so its stored projection holds an edge into the
 *  unresolved node: the shape C1's prose-mention world never has (finding 1) */
async function sWorld(body) {
  await world('off', async (s) => {
    const u = createCardsUnit({ client: s.gc, mintId: () => crypto.randomUUID() }); await u.load();
    const snap = u.snapshot(); const c1 = snap.cards.find((c) => c.id === 'uuid-1');
    c1.relationships = { ...(c1.relationships || {}), relatedTo: [...((c1.relationships || {}).relatedTo || []), snap.nextShortId] };
    assert.equal((await u.commit(snap.cards, snap.nextShortId, { actor: 'ada' })).outcome, 'APPLIED', 'PRECONDITION: #1 relatedTo the next shortId (structured)');
    assert.deepEqual(await relEdges(s, 'uuid-1', 'relatedTo'), [`${UNRESOLVED}${snap.nextShortId}`], 'PRECONDITION: the edge points at the unresolved node');
    await body(s);
  });
}
test('#1744 (C3 CONTROL, r3) a hand-built VALID wiki-create resolving a STRUCTURED reference is admitted, and the edge MOVES (none left at the unresolved node)', T, async () => {
  await sWorld(async (s) => {
    const o = await wikiCreateOrigin(s, 'req-1744-c3');
    const r = await submit(s, o);
    assert.equal(r.prep.outcome, 'APPLIED', `prepare admitted (${JSON.stringify(r.prep).slice(0, 240)})`);
    assert.equal(r.commit.outcome, 'APPLIED', `commit admitted (${JSON.stringify(r.commit).slice(0, 240)})`);
    assert.deepEqual(await relEdges(s, 'uuid-1', 'relatedTo'), [cardIriOf(o.cardId)], 'the edge points at the new card, and only there');
  });
});
test('#1744 (C3, r3, finding 1) a reference-resolve part that KEEPS the stale unresolved edge beside the resolved one is REFUSED, no effect', T, async () => {
  await sWorld(async (s) => {
    const o = await wikiCreateOrigin(s, 'req-1744-c3-stale');
    const p = o.plan.parts.find((x) => x.reason === 'reference-resolve' && x.iri === cardIriOf('uuid-1'));
    assert.ok(p, 'PRECONDITION: #1 rides as reference-resolve');
    const stale = p.prior.filter((q) => q[0].value === p.iri && q[2].value === `${UNRESOLVED}${o.shortId}`);
    assert.equal(stale.length, 1, 'PRECONDITION: the stored projection has exactly one edge into the unresolved node');
    p.quads = [...p.quads, ...stale];
    await expectRefused(s, o, () => wikiCreateOrigin(s, 'req-1744-c3-stale-ctl'), 'the stale unresolved edge kept');
  });
});
test('#1744 (C1, r3, S17) a hand-built wiki-create whose card id is NOT the derived one, CONSISTENTLY (part, provenance and JSON) is REFUSED, no effect', T, async () => {
  await cWorld(async (s) => {
    const forged = 'uuid-not-derived-r3';
    const o = await wikiCreateOrigin(s, 'req-1744-c1-s17', { cardId: forged });
    const sp = o.plan.parts.find((x) => x.iri === cardIriOf(forged));
    assert.ok(sp && JSON.parse(sp.json).id === forged && o.descriptor.provenance.cardId === forged, 'PRECONDITION: the non-derived id is used everywhere, so only the derivation check can refuse it');
    await expectRefused(s, o, () => wikiCreateOrigin(s, 'req-1744-c1-s17-ctl'), 'a consistently non-derived card id');
  });
});
test('#1744 (E7, r3, finding 2) a hand-built done-nudge whose sibling part DROPS one of its CHILD triples (a blocker node) is REFUSED, no effect', T, async () => {
  await world('off', async (s) => {
    await s.start(); const sibs = await doneColumn(s, [4]);
    const c = (await s.call('GET', `/api/cards/${sibs[0]}`)).json;
    const b = await s.call('PATCH', `/api/cards/${sibs[0]}`, { blockers: [{ anyHuman: true, status: 'open' }], ifVersion: c.version, by: 'ada' });
    assert.equal(b.status, 200, `PRECONDITION: blocker added (${b.status} ${b.text.slice(0, 200)})`);
    const o = await doneNudgeOrigin(s, 3, 'req-1744-e7-child');
    const p = o.plan.parts.find((x) => x.iri === cardIriOf(sibs[0]));
    assert.ok(p && p.reason === 'sibling-order', 'PRECONDITION: the blocked sibling shifts');
    const child = p.quads.filter((q) => q[0].value.startsWith(`${p.iri}/blocker/`));
    assert.ok(child.length > 1, `PRECONDITION: the sibling projects a blocker node with several triples (${child.length})`);
    const drop = child.find((q) => q[1].value.endsWith('blockedByAnyHuman')) || child[0];
    p.quads = p.quads.filter((q) => q !== drop);
    await expectRefused(s, o, () => doneNudgeOrigin(s, 3, 'req-1744-e7-child-ctl'), 'a sibling child triple dropped');
  });
});
/** a hand-built DELETE of #1 (which #2 names) as the cards unit plans it: the removed card plus every namer re-projected */
async function deleteOneIntent(s, tag) {
  const u = createCardsUnit({ client: s.gc, mintId: () => crypto.randomUUID() }); await u.load();
  const snap = u.snapshot();
  const p = u.plan(snap.cards.filter((c) => c.id !== 'uuid-1'), snap.nextShortId, { allNamers: true });
  return { kind: 'card.write', opId: `urn:ex:op/test/s4-1744-del-${tag}-${process.pid}`, actor: 'https://scrumboard.local/person/ada', parts: p.parts, ...(p.counter ? { counter: p.counter } : {}), indexGuard: true };
}
test('#1744 (R5, r3, S16) a hand-built index-guarded DELETE of #1 that OMITS a card naming it (#2) is REFUSED, no effect; the same delete with #2 is admitted', T, async () => {
  await world('off', async (s) => {
    const full = await deleteOneIntent(s, 'probe');
    assert.ok(full.parts.some((x) => x.remove && x.iri === cardIriOf('uuid-1')), 'PRECONDITION: the plan removes #1');
    assert.ok(full.parts.some((x) => !x.remove && x.iri === cardIriOf('uuid-2')), 'PRECONDITION: #2 (which names #1) is re-projected in the same write');
    const forged = await deleteOneIntent(s, 'forged');
    forged.parts = forged.parts.filter((x) => x.iri !== cardIriOf('uuid-2'));
    const e0 = await effects(s);
    let r; try { r = await durableUpdate(s.gc, forged); } catch (e) { assert.fail(`the compiler CRASHED instead of refusing (${e?.name}: ${String(e?.message || e).slice(0, 200)})`); }
    assert.ok(REFUSAL.has(r.outcome), `refused (${JSON.stringify(r).slice(0, 240)})`);
    assert.deepEqual(await effects(s), e0, 'no effect: #1 is still live');
    // the control AFTER the refusal (it deletes #1): the same shape, unforged, is admitted, so the refusal above can fail
    const ctl = await durableUpdate(s.gc, await deleteOneIntent(s, 'ctl'));
    assert.equal(ctl.outcome, 'APPLIED', `CONTROL: the unforged delete is admitted (${JSON.stringify(ctl).slice(0, 240)})`);
    await assertIndexComplete(s, 'after the admitted delete');
  });
});
test('#1744 (R6, r3, finding 4) a coverage node TRIMMED CONSISTENTLY (a name, its count, sum and list removed; digest intact) lets no create omit that referrer: REFUSED, no effect', T, async () => {
  await cWorld(async (s) => {
    const o = await wikiCreateOrigin(s, 'req-1744-r6');
    const N = o.shortId, cov = `<${IX.card('uuid-1')}>`;
    const get = async (p) => (await s.q(`SELECT ?o WHERE { GRAPH <${BK}> { ${cov} <${p}> ?o } }`)).map((r) => r.o.value);
    const names = (await get(IX.namesShortId)).map(Number).sort((a, b) => a - b);
    assert.ok(names.includes(N), `PRECONDITION: the index records that #1 names #${N} (${JSON.stringify(names)})`);
    const [cnt] = await get(`${IX.ns}namesCount`), [sum] = await get(`${IX.ns}namesSum`), [list] = await get(`${IX.ns}namesList`);
    assert.ok(cnt !== undefined && sum !== undefined && list !== undefined, 'PRECONDITION: the node has count, sum and list');
    const kept = names.filter((n) => n !== N);
    const I = (n) => `"${n}"^^<${XSD}integer>`;
    await s.xu(`DELETE DATA { GRAPH <${BK}> { ${cov} <${IX.namesShortId}> ${I(N)} ; <${IX.ns}namesCount> ${I(cnt)} ; <${IX.ns}namesSum> ${I(sum)} ; <${IX.ns}namesList> ${JSON.stringify(list)} } } ;
      INSERT DATA { GRAPH <${BK}> { ${cov} <${IX.ns}namesCount> ${I(kept.length)} ; <${IX.ns}namesSum> ${I(kept.reduce((a, b) => a + b, 0))} ; <${IX.ns}namesList> ${JSON.stringify(kept.join(','))} } }`, 'trim');
    const after = (await get(IX.namesShortId)).map(Number).sort((a, b) => a - b);
    assert.deepEqual(after, kept, 'PRECONDITION: the trim applied, and the node is internally consistent');
    o.plan.parts = o.plan.parts.filter((x) => x.iri !== cardIriOf('uuid-1'));   // #1 still names #N in its JSON; only the index forgot
    await expectRefused(s, o, () => wikiCreateOrigin(s, 'req-1744-r6-ctl'), 'a referrer omitted under a consistently trimmed index');
  });
});

// ── D8: mode on's only store delta is the receipt, the graph versions and the index subtree (F5: validated positively above) ──
// D8 holds today too (no index exists, so the delta is receipts and activities): it is a REGRESSION guard, not a RED row.
test('#1744 (D8, mode on, a regression guard that passes today) an ordinary update adds NO new subject outside its receipt and the index subtree, and no index term reaches the public graph', T, async () => {
  await world('on', async (s) => {
    await s.start();
    const subjects = async () => new Set((await s.q(`SELECT DISTINCT ?s WHERE { { ?s ?p ?o } UNION { GRAPH ?g { ?s ?p ?o } } }`)).map((r) => r.s.value));
    const s0 = await subjects();
    const c1 = (await s.call('GET', '/api/cards/uuid-1')).json;
    assert.equal((await s.call('PATCH', '/api/cards/uuid-1', { description: 'names #2', ifVersion: c1.version, by: 'ada' })).status, 200, 'PRECONDITION: the update applied');
    const added = [...(await subjects())].filter((x) => !s0.has(x));
    assert.deepEqual(added.filter((x) => !x.startsWith('urn:ex:op/') && !x.startsWith(IX.ns) && !x.startsWith('https://scrumboard.local/activity/')), [], `only receipts, activities and index subjects are new (${JSON.stringify(added)})`);
    const leaked = await s.q(`SELECT ?s ?p ?o WHERE { ?s ?p ?o . FILTER(STRSTARTS(STR(?s), "${IX.ns}") || STRSTARTS(STR(?p), "${IX.ns}") || STRSTARTS(STR(?o), "${IX.ns}")) }`);
    assert.deepEqual(leaked, [], 'no index term in the PUBLIC (default) graph');
    const api = (await s.call('GET', '/api/cards/uuid-1')).json;
    assert.ok(!Object.keys(api).some((k) => /index|namesShortId/i.test(k)), 'no index field on the API card');
  });
});
