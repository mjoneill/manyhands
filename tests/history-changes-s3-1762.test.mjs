/**
 * #1762 S3 — `/api/changes` reads card history from the GRAPH once a valid frontier F exists. Black-box, rows first, part 1.
 *
 * ROW AUTHOR's rows for the builder's change (server.js handleChanges / core/changes-log-query.mjs), written to the "S3 CONTRACT v2" and its
 * v2.1 corrections on #1762 (sections 1 to 3). Every row is a REAL REST server over a REAL executor (the whole-board world), a hand-built event
 * log projected by the REAL projector, and the backfill's facts and F PLANTED with raw /update (so these rows do not depend on the backfill
 * script). Nothing here imports the builder's code.
 *
 * ONE world is built once and shared: F is read per request, so each row plants its own F (after deleting any other) and nothing is restarted.
 *
 *   CH0  CONTROL, no F: today's envelope exactly — the keys, the values (titles come from the log), totals, covers, the chg3 cursor
 *        (green on main by design: this is "byte-for-byte today")
 *   CH1  a VALID F: the card rows come from the GRAPH: exact keys {kind,op,seq,id,shortId,title,column,by,at,holder,graph}, seq = N, graph = null,
 *        title = null on every row, column from columnAfter, `at` from logRecordedAt, the envelope's other keys unchanged
 *   CH2  holder is the holder BEFORE the write: scrum:none -> null, a person -> the seat, scrum:unknown -> null with "holder" listed in `unknown`
 *   CH3  a pre-F refusal keeps its reason and status, is served as op "refused", and names what the graph never held (route, request, response,
 *        rule) in `unknown`
 *   CH4  a BACKDATED event (occurred before the cutoff, recorded after it) is in a `since` window by its RECORDED time, from the graph
 *   CH10 (v2.3) five non-card kinds are served from the graph with the same {kind,op,id,shortId,by,at} as the log path, as instants
 *   CH5  no row twice and none missing across the log/graph boundary
 *   CH6  F is VALID or the request is refused, with no log fallback and no cursor: every missing field, a duplicated value, a wrong datatype, an
 *        out-of-range logSeq, an invalid recordedAt, a commitSeq beyond the marker's, a non-hex incarnation, F also in the default graph
 *        -> 503 HISTORY_FRONTIER_INVALID; another epoch or incarnation than the marker's -> 503 HISTORY_FRONTIER_STORE_MISMATCH
 *   CH7  an invalid F is refused even when the window holds no rows (a store with literally no activity rows is not built here)
 *   CH8  tokens: a chg3 minted BEFORE F is answered across F; a forward log half beyond F.logSeq is 409 CURSOR_BEYOND_FRONTIER; the backward
 *        sentinel cardsLog = F.logSeq + 1 is LEGAL (the forward rule must not reject it)
 *   CH9  the executor unreachable is a 503 (CARDS_UNAVAILABLE today, GRAPH_EXECUTOR_UNAVAILABLE in the contract), never a log-only answer
 *
 * ── NOT IN THIS FILE (part 2, and why) ─────────────────────────────────────────────────────────────────────────────────────────
 *   native post-F rows and the (opId,part) dedupe; whole-commit paging and oversizedCommit; latest-per-entity with reproject; column and
 *   collection rows; F + conversations OFF -> HISTORY_CONFIG_UNSUPPORTED; the no-log-access recorder with its positive control. They need
 *   REST writes under SCRUM_HISTORY_NATIVE or a second world shape, and the v2.2 pin on which nodes carry logRecordedAt is still open.
 *
 * ── Assumptions, each one line to correct ─────────────────────────────────────────────────────────────────────────────────────
 *   A1  facts planted on the seq-nodes are exactly what the backfill writes (columnAfter, holderAtWrite, logRecordedAt); the refused node gets only
 *       logRecordedAt, and the 503 body carries `code`. The rows do not assert WHICH field a HISTORY_FRONTIER_INVALID names.
 *   A2  a refused pre-F row's `shortId` is null when the event had none, with "shortId" in `unknown`.
 *   A3  the executor-unreachable case is already a 503 today when the graph units are on, so CH9 is a control, not a RED row. Its CODE is the open point: today the
 *       route-level cards guard answers CARDS_UNAVAILABLE first; contract v2 says GRAPH_EXECUTOR_UNAVAILABLE. CH9 accepts both and asserts the rest.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HAVE_PY, PY, killExecutor } from './helpers/graph-executor-proc.mjs';
import { wholeBoardWorld, WB_DATASET } from './helpers/whole-board-1645.mjs';
import { startRestServer } from './helpers/harness.mjs';
import { mintToken, hashToken } from '../core/credentials.mjs';
import { WRITE_PROTOCOL, WRITE_PROTOCOL_HEADER } from '../core/graph-client.mjs';

const T = { skip: HAVE_PY ? false : `UNAVAILABLE: no python with pyoxigraph at ${PY} (a skip is not a pass)`, timeout: 240000 };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RS = 'https://scrumboard.local/ns#', PROV = 'http://www.w3.org/ns/prov#', XSD = 'http://www.w3.org/2001/XMLSchema#';
const ACT = 'https://scrumboard.local/activity/', PERSON = 'https://scrumboard.local/person/';
const BK = 'urn:scrum:bookkeeping:executor', FR = 'urn:ex:history/frontier';
const COLUMN_AFTER = `${RS}columnAfter`, HOLDER = `${RS}holderAtWrite`, LOGAT = `${RS}logRecordedAt`;
const NONE = `${RS}none`, UNKNOWN = `${RS}unknown`;
const node = (seq) => `${ACT}seq-${seq}`;
const FP = { logSeq: 'urn:ex:frontierLogSeq', commitSeq: 'urn:ex:frontierCommitSeq', recordedAt: 'urn:ex:frontierRecordedAt', epoch: 'urn:ex:frontierEpoch', incarnation: 'urn:ex:frontierIncarnation' };

const UNITS = { SCRUM_GRAPH_UNIT_CARDS: '1', SCRUM_GRAPH_UNIT_COLUMNS: '1', SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_UNIT_LOGBORN: '1', SCRUM_GRAPH_UNIT_SMALLKINDS: '1', SCRUM_GRAPH_UNIT_DELIVERIES: '1' };
const SOURCES = { SCRUM_GRAPH_QUERY_SOURCE: 'executor', SCRUM_GRAPH_READY_SOURCE: 'executor', SCRUM_GRAPH_CHECKS_SOURCE: 'executor', SCRUM_GRAPH_NEIGHBORS_SOURCE: 'executor' };

// ── the hand-built log ──
const cardEv = (seq, op, id, shortId, state, at, extra = {}) => ({ seq, op, actor: 'ada', recorded_at: at, ...extra, entity: { kind: 'card', id, shortId }, state: { id, shortId, ...state } });
const T0 = (n) => `2026-10-20T10:${String(n).padStart(2, '0')}:00.000Z`;
const EVENTS = [
  cardEv(1, 'create', 'uuid-a', 101, { column: 'backlog', claimedBy: null, title: 'Title one' }, T0(1)),
  cardEv(2, 'update', 'uuid-a', 101, { column: 'in-progress', claimedBy: 'ada', title: 'Title one' }, T0(2)),
  cardEv(3, 'create', 'uuid-b', 102, { column: 'planned', claimedBy: null, title: 'Title two' }, T0(3)),
  cardEv(4, 'update', 'uuid-a', 101, { column: 'done', claimedBy: 'ada', title: 'Title one' }, T0(4)),
  cardEv(5, 'delete', 'uuid-b', 102, { column: 'planned', claimedBy: null, title: 'Title two' }, T0(5)),
  { seq: 6, op: 'refused', actor: 'ada', recorded_at: T0(6), entity: { kind: 'card', id: 'uuid-c' }, state: null, reason: 'REFUSED-REASON-FIXTURE', status: 409 },
  cardEv(7, 'update', 'uuid-e', 105, { column: 'backlog', claimedBy: 'ada', title: 'Title five' }, T0(7)),          // no earlier event: the holder before is UNKNOWN
  cardEv(8, 'update', 'uuid-d', 104, { column: 'review', claimedBy: null, title: 'Title four' }, '2026-10-26T12:00:00.000Z', { occurred_at: '2026-10-20T08:00:00.000Z' }),   // BACKDATED
  // five NON-CARD kinds (contract v2.3: today's log path puts every non-conversation kind in the cards bucket, so S3 must serve them from the graph too)
  ...['delivery', 'board-meta', 'model-call', 'memory', 'seat-state'].map((kind, i) => ({
    seq: 9 + i, op: 'create', actor: i === 3 ? 'bob' : 'ada', recorded_at: T0(9 + i), ...(i === 2 ? { occurred_at: '2026-10-20T07:00:00.000Z' } : {}),
    entity: { kind, id: `${kind}-1` }, state: { id: `${kind}-1`, title: `Event-time title of ${kind}` },   // the log path serves this title; a graph row must not
  })),
];
const NONCARD_SEQS = [9, 10, 11, 12, 13];
const K = EVENTS.length;
/** what the backfill's facts say per card seq-node (the holder is BEFORE the write) */
const FACTS = { 1: ['backlog', NONE], 2: ['in-progress', NONE], 3: ['planned', NONE], 4: ['done', `${PERSON}ada`], 5: ['planned', NONE], 7: ['backlog', UNKNOWN], 8: ['review', NONE] };
const SINCE_ALL = encodeURIComponent('2026-10-20T10:01:00.000Z');
const ROW_KEYS = ['at', 'by', 'column', 'graph', 'holder', 'id', 'kind', 'op', 'seq', 'shortId', 'title'];
const instant = (s) => Date.parse(s);

// ── the world, built once ──
let W = null;
const owned = { dirs: [], files: [] };
const runNode = (args) => new Promise((resolve) => {
  const p = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  p.on('close', (status) => resolve({ status, out, err }));
});

async function build() {
  const w = await wholeBoardWorld({ env: { ...UNITS, ...SOURCES } });
  const kept = fs.readFileSync(w.boardFile); await w.rest.stop(); fs.writeFileSync(w.boardFile, kept);
  const evdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch1762-events-')); owned.dirs.push(evdir);
  fs.writeFileSync(path.join(evdir, 'events-2026-10-20.jsonl'), `${EVENTS.map((e) => JSON.stringify(e)).join('\n')}\n`);
  const p = await runNode(['scripts/activity-projector.mjs', '--log', evdir, '--executor', w.exec.baseUrl, '--once']);
  assert.equal(p.status, 0, `PRECONDITION: the real projector projected the hand-built log (exit ${p.status}: ${(p.err || p.out).slice(-300)})`);
  const health0 = await (await fetch(`${w.exec.baseUrl}/health`)).json();
  const update = async (sparql) => {
    const r = await fetch(`${w.exec.baseUrl}/update`, { method: 'POST', headers: { 'content-type': 'application/sparql-update', 'x-op-id': `urn:ex:op/test/ch1762/${crypto.randomUUID()}`, 'x-epoch': String(health0.epoch), [WRITE_PROTOCOL_HEADER]: WRITE_PROTOCOL }, body: sparql });
    assert.equal(r.status, 200, `a planted update applied (${r.status} ${(await r.text()).slice(0, 200)})`);
  };
  const q = async (sparql) => {
    const r = await fetch(`${w.exec.baseUrl}/query`, { method: 'POST', headers: { 'content-type': 'application/sparql-query', accept: 'application/sparql-results+json' }, body: sparql });
    assert.equal(r.status, 200, `the executor answered the query (${r.status})`);
    return (await r.json()).results.bindings;
  };
  // the facts the backfill writes, planted: columnAfter + holderAtWrite + logRecordedAt on card nodes; the refused node gets logRecordedAt only
  const lines = [];
  for (const [seq, [col, holder]] of Object.entries(FACTS)) {
    lines.push(`<${node(seq)}> <${COLUMN_AFTER}> ${JSON.stringify(col)} .`, `<${node(seq)}> <${HOLDER}> <${holder}> .`);
  }
  for (const e of EVENTS) lines.push(`<${node(e.seq)}> <${LOGAT}> "${e.recorded_at}"^^<${XSD}dateTime> .`);
  await update(`INSERT DATA { ${lines.join('\n')} }`);
  // the REST preconditions the whole-board world needs when the document is unreadable (the S2 world's steps)
  const ep = health0.epoch;
  const alloc = await fetch(`${w.exec.baseUrl}/update`, { method: 'POST', headers: { 'x-op-id': `urn:ex:op/test/ch1762-allocator-${process.pid}`, 'x-epoch': String(ep) }, body: `INSERT DATA { GRAPH <${BK}> { <urn:ex:postseq/allocator> a <urn:ex:postseq/Allocator> ; <urn:ex:postseq/postSeqEpoch> "e-ch1762" ; <urn:ex:postseq/nextPostSeq> "3"^^<${XSD}integer> ; <urn:ex:postseq/version> "1"^^<${XSD}integer> . } }` });
  assert.equal(alloc.status, 200, `PRECONDITION: the allocator is seeded (${await alloc.text()})`);
  const idx = await runNode(['scripts/card-ref-index-1744.mjs', '--executor', w.exec.baseUrl, '--dataset', WB_DATASET, '--backfill']);
  assert.equal(idx.status, 0, `PRECONDITION: the reference index is backfilled (exit ${idx.status}: ${(idx.err || idx.out).slice(-300)})`);
  fs.chmodSync(w.boardFile, 0o000);
  const TOK = mintToken();
  const tokens = path.join(os.tmpdir(), `ch1762-tokens-${process.pid}.json`); owned.files.push(tokens);
  const at = (h) => new Date(Date.now() + h * 3600_000).toISOString();
  fs.writeFileSync(tokens, JSON.stringify({ seats: { ada: { credentials: [{ tokenHash: hashToken(TOK), scope: 'admin', issuedAt: at(-1), expiresAt: at(24) }] } } }));
  const roster = path.join(os.tmpdir(), `ch1762-roster-${process.pid}.json`); owned.files.push(roster);
  fs.writeFileSync(roster, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, bob: { name: 'Bob', glyph: 'b', color: '#a07cc4' } } }));
  const rest = await startRestServer({ boardFile: w.boardFile, env: { SCRUM_GRAPH_DATASET_ID: WB_DATASET, SCRUM_GRAPH_EXECUTOR_URL: w.exec.baseUrl, SCRUM_ROSTER_FILE: roster, ...UNITS, ...SOURCES, SCRUM_BOARD_DOCUMENT: 'off', SCRUM_SEAT_TOKENS: tokens, SCRUM_AUTH: 'required', SCRUM_EVENT_LOG_DIR: evdir, SCRUM_HISTORY_NATIVE: '1' } });
  // REST appended its own events at boot (a board-meta roster event, stamped now): the log is what it is, so read it back, project what the
  // projector has not seen, and give those nodes their logRecordedAt. Every assertion below is made against THIS log, not against a hand count.
  const logEvents = fs.readdirSync(evdir).filter((f) => /^events-.*\.jsonl$/.test(f)).sort().flatMap((f) => fs.readFileSync(path.join(evdir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))).sort((a, b) => a.seq - b.seq);
  const p2 = await runNode(['scripts/activity-projector.mjs', '--log', evdir, '--executor', w.exec.baseUrl, '--once']);
  assert.equal(p2.status, 0, `PRECONDITION: the projector caught up with REST's own boot events (exit ${p2.status}: ${(p2.err || p2.out).slice(-300)})`);
  const extra = logEvents.filter((e) => e.seq > K);
  if (extra.length) await update(`INSERT DATA { ${extra.map((e) => `<${node(e.seq)}> <${LOGAT}> "${e.recorded_at}"^^<${XSD}dateTime> .`).join('\n')} }`);
  const get = async (u) => {
    const r = await fetch(`${rest.baseUrl}${u}`, { headers: { authorization: `Bearer ${TOK}` }, signal: AbortSignal.timeout(60000) });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, text, json };
  };
  const health = async () => (await fetch(`${w.exec.baseUrl}/health`)).json();
  const hex = (incarnation) => String(incarnation).replace(/-/g, '').toLowerCase();
  const clearFrontier = async () => update(`DELETE WHERE { GRAPH <${BK}> { <${FR}> ?p ?o } } ; DELETE WHERE { <${FR}> ?p ?o }`);
  /** plant F: `over` replaces a field's literal text (null = omit it, an array = several values); `extra` adds raw triples (e.g. into the default graph) */
  const plantFrontier = async (over = {}, { extra = '' } = {}) => {
    await clearFrontier();
    const h = await health();
    const d = { logSeq: `"${W.K}"^^<${XSD}integer>`, commitSeq: `"${h.commitSeq}"^^<${XSD}integer>`, recordedAt: `"2026-10-27T06:00:00Z"^^<${XSD}dateTime>`, epoch: `"${h.epoch}"^^<${XSD}integer>`, incarnation: `"${hex(h.incarnation)}"`, ...over };
    const triples = [];
    for (const [k, p] of Object.entries(FP)) {
      const v = d[k]; if (v === null) continue;
      for (const lit of Array.isArray(v) ? v : [v]) triples.push(`<${FR}> <${p}> ${lit} .`);
    }
    await update(`INSERT DATA { GRAPH <${BK}> { ${triples.join('\n')} } ${extra} }`);
    return { h };
  };
  W = { w, rest, get, q, update, health, hex, plantFrontier, clearFrontier, evdir, TOK, exec: w.exec, events: logEvents, K: logEvents.at(-1).seq };
}

before(async () => { if (HAVE_PY) await build(); }, { timeout: 240000 });
after(async () => {
  if (W) { try { fs.chmodSync(W.w.boardFile, 0o644); } catch { /* absent */ } await W.rest.stop().catch(() => {}); await W.w.stop().catch(() => {}); }
  for (const d of owned.dirs) fs.rmSync(d, { recursive: true, force: true });
  for (const f of owned.files) fs.rmSync(f, { force: true });
});

const changesOf = async (query = `since=${SINCE_ALL}&history=true`) => { const r = await W.get(`/api/changes?${query}`); assert.equal(r.status, 200, `/api/changes answered 200 (got ${r.status}: ${r.text.slice(0, 300)})`); return r.json; };
const bySeq = (rows, n) => rows.find((r) => r.seq === n);
const sorted = (a) => [...a].sort();

// ── CH0 ──
test('#1762 S3 CH0 CONTROL — with NO frontier, /api/changes is today\'s envelope exactly: log rows with their event-time titles (green on main by design)', T, async () => {
  await W.clearFrontier();
  const j = await changesOf();
  const expected = W.events.map((e) => ({
    kind: e.entity?.kind ?? null, op: e.op, seq: e.seq, id: e.entity?.id ?? null, shortId: e.entity?.shortId ?? e.state?.shortId ?? null,
    title: e.state?.title ?? (typeof e.state?.body === 'string' ? e.state.body.slice(0, 120) : null),
    column: e.entity?.kind === 'card' ? (e.state?.column ?? null) : null, by: e.actor ?? null, at: e.recorded_at,
    ...(e.op === 'refused' ? { reason: e.reason ?? null, status: e.status ?? null, route: e.route ?? null, request: e.request ?? null, response: e.response ?? null, rule: e.rule ?? null } : {}),
  }));
  assert.deepEqual(j.changes, expected, 'every key and value is what the log path has always served');
  assert.deepEqual([j.totals, j.returned, j.truncated, j.covers, j.history], [{ cards: W.events.length, posts: 0 }, W.events.length, { cards: false, posts: false }, { posts: 'exact', cards: 'creates+updates+deletes' }, true], 'and the envelope around them');
  assert.match(j.cursor, /^chg3\.\d+\.[0-9a-f]{32}\.\d+\.\d+$/, 'the forward cursor is the chg3 form');
  assert.equal(j.nextBefore, null);
});

// ── CH1 ──
test('#1762 S3 CH1 — with a VALID frontier the card rows come from the GRAPH: exact keys, seq = N, graph null, title null, column and `at` from the facts', T, async () => {
  await W.plantFrontier();
  const j = await changesOf();
  const rows = j.changes.filter((r) => r.kind === 'card' && r.op !== 'refused');
  assert.equal(rows.length, Object.keys(FACTS).length, 'one row per successful card event');
  for (const r of rows) {
    assert.deepEqual(sorted(Object.keys(r).filter((k) => k !== 'unknown')), ROW_KEYS, `seq ${r.seq}: today's keys plus holder, exactly`);
    assert.equal(r.title, null, `seq ${r.seq}: title is null on a graph row — never filled from the card's current state`);
    assert.equal(r.graph, null, `seq ${r.seq}: a pre-F row has no graph provenance`);
    const e = EVENTS[r.seq - 1];
    assert.equal(r.kind, 'card'); assert.equal(r.id, e.entity.id); assert.equal(r.shortId, e.entity.shortId, `seq ${r.seq}: shortId is a NUMBER`);
    assert.equal(r.op, e.op, `seq ${r.seq}: op`); assert.equal(r.by, 'ada');
    assert.equal(r.column, FACTS[r.seq][0], `seq ${r.seq}: column comes from columnAfter`);
    assert.equal(instant(r.at), instant(e.recorded_at), `seq ${r.seq}: at is the log's recorded time (logRecordedAt)`);
  }
  assert.equal(j.returned, j.changes.length, 'the envelope counts what it returns');
  assert.deepEqual([j.totals.cards, j.totals.posts, j.truncated], [j.changes.length, 0, { cards: false, posts: false }], 'totals and truncated keep today\'s meaning');
  assert.ok(j.returned >= K && j.returned <= W.events.length, `all ${K} hand-built events are served (the refusal included); REST's own boot event (a board-meta row, seq ${K + 1}) may or may not be — that is the open scope question of contract v2.3, so it is not pinned here`);
  assert.deepEqual(j.covers, { posts: 'exact', cards: 'creates+updates+deletes' });
  assert.match(j.cursor, /^chg3\.\d+\.[0-9a-f]{32}\.\d+\.\d+$/, 'and the cursor keeps the chg3 form');
});

// ── CH2 ──
test('#1762 S3 CH2 — holder is the holder BEFORE the write: none is null, a person is the seat, unknown is null and says so in `unknown`', T, async () => {
  await W.plantFrontier();
  const rows = (await changesOf()).changes;
  assert.equal(bySeq(rows, 2).holder, null, 'a claim by ada: nobody held it before');
  assert.equal(bySeq(rows, 2).unknown, undefined, 'and "none" is a known fact: no `unknown` key at all');
  assert.equal(bySeq(rows, 4).holder, 'ada', 'a move after her claim: ada held it before (decoded from the person IRI)');
  assert.equal(bySeq(rows, 7).holder, null, 'no retained history: scrum:unknown reads as null ...');
  assert.deepEqual(bySeq(rows, 7).unknown, ['holder'], '... AND is named in `unknown`, so null never means "unknown" by accident');
});

// ── CH3 ──
test('#1762 S3 CH3 — a pre-F refusal is served as op "refused" with its reason and status, and names in `unknown` what the graph never held', T, async () => {
  await W.plantFrontier();
  const r = bySeq((await changesOf()).changes, 6);
  assert.ok(r, 'the refusal is a row');
  assert.equal(r.op, 'refused'); assert.equal(r.reason, 'REFUSED-REASON-FIXTURE'); assert.equal(Number(r.status), 409, 'status (the graph stores it as text; the type is not pinned)');
  assert.equal(r.title, null);
  for (const k of ['route', 'request', 'response', 'rule']) {
    assert.equal(r[k], null, `${k}: the graph never held it`);
    assert.ok(Array.isArray(r.unknown) && r.unknown.includes(k), `and says so in \`unknown\` (${k})`);
  }
  assert.ok(r.unknown.includes('shortId'), 'a refusal whose event had no shortId reads null and says so (A2)');
});

// ── CH4 ──
test('#1762 S3 CH4 — a BACKDATED event (occurred before the cutoff, recorded after it) is in the `since` window by its RECORDED time, and comes from the graph', T, async () => {
  await W.plantFrontier();
  const rows = (await changesOf(`since=${encodeURIComponent('2026-10-26T00:00:00.000Z')}&history=true`)).changes;
  const cards = rows.filter((r) => r.kind === 'card');
  assert.deepEqual(cards.map((r) => r.seq), [8], 'exactly the backdated card event: a window keyed on occurrence time would drop it, one keyed on nothing would return all of them');
  assert.equal(cards[0].title, null, 'and it was served from the graph, not the log (the log row would carry its title)');
  assert.equal(instant(cards[0].at), instant('2026-10-26T12:00:00.000Z'), 'its `at` is the recorded time, not 2026-10-20T08:00');
});

// ── CH10 (contract v2.3, approved) ──
test('#1762 S3 CH10 — the NON-CARD kinds (delivery, board-meta, model-call, memory, seat-state) are served from the graph with the same {kind, op, id, shortId, by, at} the log path gives, compared as instants', T, async () => {
  await W.clearFrontier();
  const today = (await changesOf()).changes.filter((r) => NONCARD_SEQS.includes(r.seq));
  await W.plantFrontier();
  const graph = (await changesOf()).changes.filter((r) => NONCARD_SEQS.includes(r.seq));
  assert.deepEqual(today.map((r) => r.seq), NONCARD_SEQS, 'PRECONDITION: the log path serves all five (today\'s behaviour, the thing that must be preserved)');
  assert.deepEqual(graph.map((r) => r.seq), NONCARD_SEQS, 'with F present all five are STILL served: the whole non-post bucket, not only card, column and collection');
  const proj = (r) => ({ kind: r.kind, op: r.op, id: r.id, shortId: r.shortId ?? null, by: r.by, at: new Date(r.at).toISOString() });
  assert.deepEqual(graph.map(proj), today.map(proj), 'and they are the same facts, with `at` compared as an instant (the memory event occurred at 07:00 and was recorded at its own time: `at` is the recorded time)');
  for (const r of graph) {
    assert.equal(r.title, null, `${r.kind}: served from the graph, so title is null (disclosed); the log path gave '${today.find((t) => t.seq === r.seq).title}'`);
    assert.equal(r.column, null, `${r.kind}: a non-card row has no column`);
    assert.ok(!('holder' in r), `${r.kind}: and no holder key`);
    for (const k of ['kind', 'op', 'seq', 'id', 'shortId', 'title', 'column', 'by', 'at']) assert.ok(k in r, `${r.kind}: today's key \`${k}\` is still there`);
  }
});

// ── CH5 ──
test('#1762 S3 CH5 — no row twice and none missing: every log seq appears exactly once', T, async () => {
  await W.plantFrontier();
  const rows = (await changesOf()).changes;
  const seqs = rows.map((r) => r.seq).sort((a, b) => a - b);
  assert.equal(new Set(seqs).size, seqs.length, 'no seq appears twice');
  assert.deepEqual(seqs.filter((n) => n <= K), EVENTS.map((e) => e.seq), 'and none of the hand-built events is missing');
});

// ── CH6 the frontier states ──
const BAD = [
  ['frontierLogSeq missing', () => ({ logSeq: null })],
  ['frontierCommitSeq missing', () => ({ commitSeq: null })],
  ['frontierRecordedAt missing', () => ({ recordedAt: null })],
  ['frontierEpoch missing', () => ({ epoch: null })],
  ['frontierIncarnation missing', () => ({ incarnation: null })],
  ['frontierLogSeq duplicated (two values)', () => ({ logSeq: [`"${W.K}"^^<${XSD}integer>`, `"${W.K + 1}"^^<${XSD}integer>`] })],
  ['frontierLogSeq of the wrong datatype (a string)', () => ({ logSeq: `"${W.K}"` })],
  ['frontierLogSeq out of range (0; it must be at least 1)', () => ({ logSeq: `"0"^^<${XSD}integer>` })],
  ['frontierRecordedAt not a valid dateTime', () => ({ recordedAt: '"yesterday"' })],
  ['frontierIncarnation not 32 lowercase hex', () => ({ incarnation: '"NOT-A-HEX-INCARNATION"' })],
];
for (const [label, overFn] of BAD) {
  test(`#1762 S3 CH6 — ${label}: 503 HISTORY_FRONTIER_INVALID, no rows, no cursor, no log fallback`, T, async () => {
    await W.plantFrontier(overFn());
    const r = await W.get(`/api/changes?since=${SINCE_ALL}&history=true`);
    assert.equal(r.status, 503, `a malformed frontier is refused (got ${r.status}: ${r.text.slice(0, 200)})`);
    assert.equal(r.json?.code, 'HISTORY_FRONTIER_INVALID');
    assert.equal(r.json?.changes, undefined, 'and never answers rows from the log instead');
    assert.equal(r.json?.cursor, undefined, 'or mints a cursor');
  });
}
test('#1762 S3 CH6 — frontierCommitSeq beyond the marker\'s commitSeq: 503 HISTORY_FRONTIER_INVALID', T, async () => {
  const { h } = await W.plantFrontier({ commitSeq: `"${Number(0) + 1000000}"^^<${XSD}integer>` });
  const r = await W.get(`/api/changes?since=${SINCE_ALL}&history=true`);
  assert.equal(r.status, 503, `(marker commitSeq ${h.commitSeq}; got ${r.status}: ${r.text.slice(0, 200)})`);
  assert.equal(r.json?.code, 'HISTORY_FRONTIER_INVALID');
  assert.equal(r.json?.changes, undefined);
});
test('#1762 S3 CH6 — the frontier ALSO in the default graph: 503 HISTORY_FRONTIER_INVALID (two frontiers)', T, async () => {
  const h = await W.health();
  await W.plantFrontier({}, { extra: `<${FR}> <${FP.logSeq}> "${W.K}"^^<${XSD}integer> . <${FR}> <${FP.commitSeq}> "${h.commitSeq}"^^<${XSD}integer> .` });
  const r = await W.get(`/api/changes?since=${SINCE_ALL}&history=true`);
  assert.equal(r.status, 503, `(got ${r.status}: ${r.text.slice(0, 200)})`);
  assert.equal(r.json?.code, 'HISTORY_FRONTIER_INVALID');
});
test('#1762 S3 CH6 — a frontier from ANOTHER EPOCH than the marker\'s: 503 HISTORY_FRONTIER_STORE_MISMATCH', T, async () => {
  const h = await W.health();
  await W.plantFrontier({ epoch: `"${Number(h.epoch) + 7}"^^<${XSD}integer>` });
  const r = await W.get(`/api/changes?since=${SINCE_ALL}&history=true`);
  assert.equal(r.status, 503, `(got ${r.status}: ${r.text.slice(0, 200)})`);
  assert.equal(r.json?.code, 'HISTORY_FRONTIER_STORE_MISMATCH');
  assert.equal(r.json?.changes, undefined);
});
test('#1762 S3 CH6 — a frontier from ANOTHER INCARNATION than the marker\'s: 503 HISTORY_FRONTIER_STORE_MISMATCH', T, async () => {
  await W.plantFrontier({ incarnation: `"${'0123456789abcdef'.repeat(2)}"` });
  const r = await W.get(`/api/changes?since=${SINCE_ALL}&history=true`);
  assert.equal(r.status, 503, `(got ${r.status}: ${r.text.slice(0, 200)})`);
  assert.equal(r.json?.code, 'HISTORY_FRONTIER_STORE_MISMATCH');
  assert.equal(r.json?.changes, undefined);
});

// ── CH7 ──
test('#1762 S3 CH7 — an invalid frontier is refused even when the window holds NO rows: detecting it does not depend on rows being served', T, async () => {
  await W.plantFrontier({ logSeq: null });
  const bare = await W.get(`/api/changes?since=${encodeURIComponent('2099-01-01T00:00:00.000Z')}&history=true`);
  assert.equal(bare.status, 503, `an invalid frontier is refused even when the window holds nothing (got ${bare.status}: ${bare.text.slice(0, 200)})`);
  assert.equal(bare.json?.code, 'HISTORY_FRONTIER_INVALID');
});

// ── CH8 tokens ──
test('#1762 S3 CH8 — a chg3 minted BEFORE F is answered across F; a forward log half BEYOND F.logSeq is 409 CURSOR_BEYOND_FRONTIER; the backward sentinel F.logSeq+1 is LEGAL', T, async () => {
  await W.clearFrontier();
  const first = await changesOf(`since=${SINCE_ALL}&history=true&limitCards=3`);
  assert.ok(first.truncated.cards && first.nextBefore, 'PRECONDITION: a truncated first page mints a backward token (this is a no-F request: today\'s path)');
  const minted = first.cursor;                                      // chg3.<log>.<inc>.<epoch>.<commitSeq>, minted before any F
  await W.plantFrontier();
  const across = await W.get(`/api/changes?since=${encodeURIComponent(minted)}&history=true`);
  assert.equal(across.status, 200, `a token minted before F is answered across it (got ${across.status}: ${across.text.slice(0, 200)})`);
  const [, , inc, epoch, graph] = minted.split('.');
  const beyond = `chg3.${W.K + 5}.${inc}.${epoch}.${graph}`;
  const r409 = await W.get(`/api/changes?since=${encodeURIComponent(beyond)}&history=true`);
  assert.equal(r409.status, 409, `a log half past the frontier cannot have been minted by this board (got ${r409.status}: ${r409.text.slice(0, 200)})`);
  assert.equal(r409.json?.code, 'CURSOR_BEYOND_FRONTIER', 'and is refused by name, never silently clamped');
  // backward: take the token the board minted and set its cards-log bound to the legal sentinel F.logSeq + 1
  const parts = first.nextBefore.split('.');                         // chgb4.<cardsLog>.<postsLog>.<inc>.<epoch>.<graph>.<graphPosts>  (or chgb3 without graphPosts)
  assert.match(parts[0], /^chgb[34]$/, `PRECONDITION: a backward token (got ${first.nextBefore})`);
  parts[1] = String(W.K + 1);
  const sentinel = await W.get(`/api/changes?before=${encodeURIComponent(parts.join('.'))}&history=true`);
  assert.notEqual(sentinel.status, 409, 'the FORWARD rule must not reject the backward sentinel F.logSeq + 1');
  assert.equal(sentinel.status, 200, `it is a legal exclusive bound meaning "every pre-F row" (got ${sentinel.status}: ${sentinel.text.slice(0, 200)})`);
});

// ── CH9 ──
test('#1762 S3 CH9 CONTROL — the executor unreachable is a 503, never a log-only answer (A3: already true today with the graph units on; the code is measured below)', T, async () => {
  await W.plantFrontier();
  await killExecutor(W.exec);
  const r = await W.get(`/api/changes?since=${SINCE_ALL}&history=true`);
  assert.equal(r.status, 503, `(got ${r.status}: ${r.text.slice(0, 200)})`);
  // MEASURED at main 909de8a, in this world: the route-level cards guard answers first, with CARDS_UNAVAILABLE. Contract v2 names GRAPH_EXECUTOR_UNAVAILABLE for
  // "executor unreachable, or the F read fails". Both are accepted until the contract says which one a request in this world gets (asked on #1762).
  assert.ok(['GRAPH_EXECUTOR_UNAVAILABLE', 'CARDS_UNAVAILABLE'].includes(r.json?.code), `the refusal names why (got ${r.json?.code})`);
  assert.equal(r.json?.changes, undefined, 'and not a log-only answer');
});
