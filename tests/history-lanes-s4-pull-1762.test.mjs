/**
 * #1762 S4 — a LANE's pull once a valid history frontier F exists (S4 CONTRACT v1 + v1.1 A1/A2), black-box over HTTP, rows first.
 *
 * ROW AUTHOR's rows for `GET /api/cursors/pull` and `POST /api/cursors/ack` against the same whole-board world as the S3 reader rows (real executor, real
 * projector, real REST), with lanes SEEDED at known acked positions. They are written before the lane code changes, from the contract on #1762 (v1, then the
 * reviewer's S4 ruling and the three amendments), so most are RED on main for their own reasons. They key on `seq`, the ack token's fields, the error codes and
 * `envelope.history` ONLY: the exact shape of a served event is not pinned (A-LP1), so nothing here depends on it.
 *
 *   LP0  CONTROL, no F: a lane acked at 2 is served log events 3.. from the log, and `envelope.history` is absent (green on main by design)
 *   LP1  F valid: the log source is the seq-nodes (acked, F.logSeq], every kind, ascending, each once; nothing is acked by the pull; `envelope.history` is
 *        {frontierLogSeq, frontierCommitSeq, logDrained:false}
 *   LP2  the ack token's `log` is the highest N served (<= F.logSeq); acking it moves the lane there; the next pull reports logDrained TRUE and serves nothing from the log half
 *   LP3  A1: a legacy CONVERSATION owed to a lane is served by its seq, from the conversations unit (its text present); a REDACTED one is still served (never dropped, or the
 *        lane could ack past it) with its text absent
 *   LP4a a genuine hole INSIDE the range (the log has no line at 3 or 4; nothing was deleted) is skipped by existing-node paging: a page is the next `limit` EXISTING nodes after
 *        `acked` (A-LP2, settled by the contract author), nothing is re-served or lost across a whole walk, and the token's `log` is the highest N served. It PASSES on main, whose log
 *        path already pages by existing events: it is there to bind the F path to the same rule
 *   LP4b (placed with the proof rows below, after the proof design was ruled): a COVERED TAIL, F.logSeq beyond the last committed node and the lane acked at it, is an empty page whose token has log = F.logSeq; the lane
 *        moves only when it is acked, then the log half is drained
 *   PR00/PR0/PA1-PA17/LP4b  the PROOF rows (S4 v1.6, v1.6.1, v1.6.2): a lane's log-half advance is verified against F's committed Merkle root; the rows build the certified world themselves (helpers/history-merkle-1762.mjs)
 *   LR1/LR1b/LR2/LR3a-c  the review of 60a02f8: a graph-born post receipt owed before F stays owed (and survives a restart, gone only after its ack); a redacted one is still an event; non-post legacy history keeps its
 *        bounded facts (lenient wire); REGISTER, PULL, ACK and the lane LISTING make no access to the retired event-log directory; implicit adoption past F is F.logSeq, from a log with a junk tail and from none
 *   LG1  GRAPH half, whole-commit pages: a multi-part native commit larger than `limit` is served WHOLE in one page (every part of it, nothing of any other commit), and the token's graph half is
 *        that commit's commitSeq (a page never ends inside a commit)
 *   LG2  repeat-before-ACK: the same pull again returns the same parts and the same token, and the lane's graph half has not moved
 *   LG3  ACK and RESTART: a restart before the ack serves the same page; an ack across a restart is accepted and moves the lane to that commit; after a further restart none of the
 *        commit's parts is served again
 *   LG4  no sibling part is lost: two multi-part commits walked with `limit` 1 and an ack per page give each commit's every part exactly once, in commit order, and then nothing
 *   LP5  a lane registered AFTER F starts with its log half at F.logSeq (not the log's head)
 *   LP6  an INVALID F refuses the pull (503 HISTORY_FRONTIER_INVALID / HISTORY_FRONTIER_STORE_MISMATCH) and the lane is exactly as it was
 *   LP7  a token whose log half is beyond F.logSeq cannot have been served: 409 ACK_BEYOND_SERVED, the lane unchanged (a CONTROL: green on main by design)
 *   LP8  A1: a conversation node whose post node is ABSENT refuses the pull 503 HISTORY_LEGACY_POST_MISSING {seq, entity}; nothing served, the lane unchanged (LAST: it deletes a node)
 *
 * ── Assumptions, each one line to correct ─────────────────────────────────────────────────────────────────────────────────────
 *   A-LP1  a served event carries `seq` (the node's N). Its other fields are today's lane event shape and are NOT asserted, except that a conversation event's text is
 *          present for a visible post and absent for a redacted one (searched in the whole serialized event).
 *   A-LP2  SETTLED (the contract author, 2026-10-27; the reviewer may overrule): a page is the next `limit` EXISTING seq-nodes after `acked`, up to F.logSeq (today's serveFor counts events, not N).
 *   A-LP3  `envelope.history` exists only with a valid F; `logDrained` is `acked >= frontierLogSeq` as the lane's state stands when the page is built.
 *   NOT PINNED, so not written: the graph half's interleaving with the log half in one page; the whole-commit page rule for the graph half (rows for it wait on a lane pull to
 *   observe); the push stream; the order of events within a page beyond ascending seq.
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
import * as M from './helpers/history-merkle-1762.mjs';
import { certifier, NS, HIST_F, lit } from './helpers/history-certify-1762.mjs';
import { mintToken, hashToken } from '../core/credentials.mjs';
import { WRITE_PROTOCOL, WRITE_PROTOCOL_HEADER, createGraphClient } from '../core/graph-client.mjs';

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
const EVENTS_RAW = [
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
  // three LEGACY conversations (written while the conversations unit was off: log rows with their text); S4 A1 owes them to a lane past F
  ...[['LP-P1', 'ada', 'LEGACY VISIBLE POST TEXT'], ['LP-P2', 'bob', 'LEGACY REDACTED POST SECRET'], ['LP-P3', 'ada', 'LEGACY MISSING POST TEXT']].map(([id, who, body], i) => ({
    seq: 14 + i, op: 'post', actor: who, recorded_at: T0(14 + i), entity: { kind: 'conversation', id }, state: { id, author: who, body, createdAt: T0(14 + i) },
  })),
];
// a GENUINE hole in the log: no event, and so no node, at seq 3 or 4 (the log was never written there). Everything from the third event on shifts up by two.
const SKIP = (n) => (n <= 2 ? n : n + 2);
const EVENTS = EVENTS_RAW.map((e) => ({ ...e, seq: SKIP(e.seq) }));
const NONCARD_SEQS = [9, 10, 11, 12, 13];
const K = EVENTS.at(-1).seq;
/** what the backfill's facts say per card seq-node (the holder is BEFORE the write) */
const FACTS_RAW = { 1: ['backlog', NONE], 2: ['in-progress', NONE], 3: ['planned', NONE], 4: ['done', `${PERSON}ada`], 5: ['planned', NONE], 7: ['backlog', UNKNOWN], 8: ['review', NONE] };
const FACTS = Object.fromEntries(Object.entries(FACTS_RAW).map(([k, v]) => [SKIP(Number(k)), v]));
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
  // the accepted backfill writes NOTHING for conversation nodes (scripts/history-backfill-1762.mjs): the world must not hand the lane a timestamp the real migration does not add
  for (const e of EVENTS.filter((x) => x.entity?.kind !== 'conversation')) lines.push(`<${node(e.seq)}> <${LOGAT}> "${e.recorded_at}"^^<${XSD}dateTime> .`);
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
  const baseEnv = { SCRUM_GRAPH_DATASET_ID: WB_DATASET, SCRUM_GRAPH_EXECUTOR_URL: w.exec.baseUrl, SCRUM_ROSTER_FILE: roster, ...UNITS, ...SOURCES, SCRUM_BOARD_DOCUMENT: 'off', SCRUM_SEAT_TOKENS: tokens, SCRUM_AUTH: 'required', SCRUM_EVENT_LOG_DIR: evdir, SCRUM_HISTORY_NATIVE: '1' };
  const rest = await startRestServer({ boardFile: w.boardFile, env: baseEnv });
  /** a SECOND REST over the same executor (own log-dir copy, a recorder, a unit switched off...): `over` replaces env entries */
  // the harness's stop() UNLINKS the board file it was given (found by #1710's probe), so a second REST must put it back, in the mode the main one needs
  const boardAs = (mode) => { try { fs.chmodSync(w.boardFile, 0o644); } catch { /* gone */ } fs.writeFileSync(w.boardFile, kept); fs.chmodSync(w.boardFile, mode); };
  const startRest = async (over = {}, { readableDocument = false } = {}) => {
    if (readableDocument) boardAs(0o644);
    const r2 = await startRestServer({ boardFile: w.boardFile, env: { ...baseEnv, ...over } }).catch((e) => { boardAs(0o000); throw e; });
    const g = async (u) => { const r = await fetch(`${r2.baseUrl}${u}`, { headers: { authorization: `Bearer ${TOK}` }, signal: AbortSignal.timeout(60000) }); const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ } return { status: r.status, text, json }; };
    return { rest: r2, get: g, stop: async () => { await r2.stop(); boardAs(0o000); } };
  };
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
  const send = async (method, route, payload) => {
    const r = await fetch(`${rest.baseUrl}${route}`, { method, headers: { authorization: `Bearer ${TOK}`, ...(payload ? { 'content-type': 'application/json' } : {}) }, ...(payload ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(60000) });
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
  W = { w, rest, get, send, startRest, q, update, health, hex, plantFrontier, clearFrontier, evdir, TOK, exec: w.exec, events: logEvents, K: logEvents.at(-1).seq };
}

after(async () => {
  if (W) { try { fs.chmodSync(W.w.boardFile, 0o644); } catch { /* absent */ } await W.rest.stop().catch(() => {}); await W.w.stop().catch(() => {}); }
  for (const d of owned.dirs) fs.rmSync(d, { recursive: true, force: true });
  for (const f of owned.files) fs.rmSync(f, { force: true });
});

const changesOf = async (query = `since=${SINCE_ALL}&history=true`) => { const r = await W.get(`/api/changes?${query}`); assert.equal(r.status, 200, `/api/changes answered 200 (got ${r.status}: ${r.text.slice(0, 300)})`); return r.json; };
const bySeq = (rows, n) => rows.find((r) => r.seq === n);
const sorted = (a) => [...a].sort();


// ══ lanes ══
const seqOfFixture = (id) => EVENTS.find((e) => e.entity?.id === id).seq;
const LEGACY_POSTS = { visible: { id: 'LP-P1', seq: seqOfFixture('LP-P1'), body: 'LEGACY VISIBLE POST TEXT' }, redacted: { id: 'LP-P2', seq: seqOfFixture('LP-P2'), body: 'LEGACY REDACTED POST SECRET' }, missing: { id: 'LP-P3', seq: seqOfFixture('LP-P3'), body: 'LEGACY MISSING POST TEXT' } };
/** the unit's post nodes for the legacy conversations (imported, as the backfill of posts does), and one redacted afterwards */
async function importLegacyPosts() {
  const client = createGraphClient({ baseUrl: W.exec.baseUrl, expectedDatasetId: WB_DATASET });
  let postSeq = 1;
  for (const [i, p] of [LEGACY_POSTS.visible, LEGACY_POSTS.redacted, LEGACY_POSTS.missing].entries()) {
    const r = await client.update({ kind: 'post.import', opId: `urn:ex:op/backfill/${p.id}`, actor: `${PERSON}board`, post: { id: p.id, body: p.body, author: i === 1 ? 'bob' : 'ada', createdAt: T0(14 + i), attachedTo: null, mentions: [], postSeq: postSeq++ } });
    assert.equal(r.outcome, 'APPLIED', `PRECONDITION: the legacy post ${p.id} is in the graph (${JSON.stringify(r)})`);
  }
  const red = await client.update({ kind: 'post.redact', history: true, opId: `urn:ex:op/redact/${LEGACY_POSTS.redacted.id}`, actor: `${PERSON}ada`, post: { id: LEGACY_POSTS.redacted.id }, authorityRef: 'test-authority-ref', occurredAt: new Date().toISOString() });
  assert.equal(red.outcome, 'APPLIED', `PRECONDITION: the redacted legacy post is a tombstone (${JSON.stringify(red)})`);
}
// ONE hook: node:test runs root-level hooks concurrently, so the second step cannot be its own `before`
before(async () => { if (HAVE_PY) { await build(); await importLegacyPosts(); } }, { timeout: 240000 });
const ENT = 'https://scrumboard.local/entity/';
const readLog = () => fs.readdirSync(W.evdir).filter((f) => /^events-.*\.jsonl$/.test(f)).sort().flatMap((f) => fs.readFileSync(path.join(W.evdir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))).sort((a, b) => a.seq - b.seq);
let projectedThrough = null;
/** project everything the log holds that the graph has not seen, give the new nodes their logRecordedAt (the backfill's fact), and return the highest seq */
async function settle() {
  const p = await runNode(['scripts/activity-projector.mjs', '--log', W.evdir, '--executor', W.exec.baseUrl, '--once']);
  assert.equal(p.status, 0, `PRECONDITION: the projector caught up (exit ${p.status}: ${(p.err || p.out).slice(-300)})`);
  const evs = readLog();
  if (projectedThrough == null) projectedThrough = W.K;
  const fresh = evs.filter((e) => e.seq > projectedThrough && e.entity?.kind !== 'conversation');
  if (fresh.length) await W.update(`INSERT DATA { ${fresh.map((e) => `<${node(e.seq)}> <${LOGAT}> "${e.recorded_at}"^^<${XSD}dateTime> .`).join('\n')} }`);
  projectedThrough = evs.at(-1).seq;
  return projectedThrough;
}
const lanePath = () => path.join(W.evdir, 'cursors.json');
const laneState = (name) => JSON.parse(fs.readFileSync(lanePath(), 'utf8')).seats[`registry:${name}`];
/** register a lane through REST (it gets its graph half), then set its log half to `acked` exactly */
async function seedLane(name, acked) {
  const r = await W.send('POST', '/api/cursors/register', { registrySeatId: name });
  assert.equal(r.status, 200, `PRECONDITION: the lane registers (${r.status} ${r.text.slice(0, 200)})`);
  const st = JSON.parse(fs.readFileSync(lanePath(), 'utf8'));
  st.seats[`registry:${name}`].acked = acked; st.seats[`registry:${name}`].served = null;
  fs.writeFileSync(lanePath(), `${JSON.stringify(st, null, 2)}\n`);
}
const pull = (name, limit = 200) => W.get(`/api/cursors/pull?identity=${encodeURIComponent(`registry:${name}`)}&limit=${limit}`);
const ack = (name, token) => W.send('POST', '/api/cursors/ack', { identity: `registry:${name}`, token });
const tokenOf = (r) => JSON.parse(Buffer.from(r.json.ack_token, 'base64url').toString('utf8'));
const seqsOf = (r) => r.json.events.map((e) => e.seq).filter((n) => Number.isInteger(n));
/** the seqs that have a node at or below `n`: every log line that names an entity (a hole in the log has none) */
const nodeSeqs = (n) => readLog().filter((e) => e.seq <= n && e.entity?.id).map((e) => e.seq);
const range = (a, b) => Array.from({ length: Math.max(0, b - a + 1) }, (_, i) => a + i);
/** F planted at the settled log head, with that logSeq */
/** F planted at the settled log head, CERTIFIED (S4 v1.6.2): the tree graph and the five history predicates are written too */
async function plantAtHead() { const n = await settle(); const c = await certify({ logSeq: n }); return { n, h: c.h, cert: c }; }

test('#1762 S4 LP0 CONTROL — with NO frontier a lane acked at 2 is served log events 3.. from the log, and the envelope carries no history block (green on main by design)', T, async () => {
  await W.clearFrontier();
  await seedLane('lp0', 2);
  const r = await pull('lp0', 50);
  assert.equal(r.status, 200, `(${r.status}: ${r.text.slice(0, 200)})`);
  const owed = readLog().map((e) => e.seq).filter((x) => x > 2);
  assert.deepEqual(seqsOf(r), owed.slice(0, seqsOf(r).length), 'the events are the log\'s lines after 2, in order (the hole at 3 and 4 has none)');
  assert.ok(seqsOf(r).length >= 10, `and there are many (${seqsOf(r).length})`);
  assert.equal(r.json.envelope.history, undefined, 'no F, no history block');
});

test('#1762 S4 LP1 — F valid: a lane acked at 2 is served exactly the seq-nodes (2, F.logSeq], every kind, ascending, each once; the pull acks nothing; envelope.history says so', T, async () => {
  const { n, h } = await plantAtHead();
  await seedLane('lp1', 2);
  const r = await pull('lp1', 500);
  assert.equal(r.status, 200, `(${r.status}: ${r.text.slice(0, 200)})`);
  const logHalf = seqsOf(r).filter((s) => s <= n);
  assert.deepEqual(logHalf, nodeSeqs(n).filter((x) => x > 2), `the log half is every node in (2, ${n}], ascending and once each`);
  assert.equal(laneState('lp1').acked, 2, 'and a pull moved nothing: acked is still 2');
  assert.deepEqual({ ...r.json.envelope.history }, { frontierLogSeq: n, frontierCommitSeq: Number(h.commitSeq), logDrained: false }, 'envelope.history names F and says the log half is not drained');
});

test('#1762 S4 LP2 — the ack token\'s `log` is the highest N served (<= F.logSeq); acking it moves the lane there, and the next pull reports logDrained and serves nothing from the log half', T, async () => {
  const { n } = await plantAtHead();
  await seedLane('lp2', 2);
  const r = await pull('lp2', 500);
  const tok = tokenOf(r);
  assert.equal(tok.log, Math.max(...seqsOf(r).filter((s) => s <= n)), `the token's log half is the highest N served (got ${tok.log})`);
  assert.ok(tok.log <= n, 'and never beyond F.logSeq');
  assert.equal((await ack('lp2', r.json.ack_token)).status, 200, 'the ack is accepted');
  assert.equal(laneState('lp2').acked, tok.log, 'the lane moved to it, and only now');
  const again = await pull('lp2', 500);
  assert.deepEqual(seqsOf(again).filter((s) => s <= n), [], 'nothing from the log half is served again');
  assert.equal(again.json.envelope.history?.logDrained, true, 'and the log half is drained: acked reached F.logSeq');
});

test('#1762 S4 LP3 — a legacy CONVERSATION owed to a lane is served by its seq with its text (A1); a REDACTED one is still served, with its text absent', T, async () => {
  const { n } = await plantAtHead();
  const { visible, redacted } = LEGACY_POSTS;
  await seedLane('lp3', visible.seq - 1);
  const r = await pull('lp3', 500);
  assert.equal(r.status, 200, `(${r.status}: ${r.text.slice(0, 300)})`);
  const bySeq = (s) => r.json.events.filter((e) => e.seq === s);
  assert.equal(bySeq(visible.seq).length, 1, 'the visible legacy post is one event');
  assert.ok(JSON.stringify(bySeq(visible.seq)).includes(visible.body), 'carrying its text, from the conversations unit');
  assert.ok(JSON.stringify(bySeq(visible.seq)).includes(T0(14)), 'and its own time, from the conversations unit (the backfill adds no logRecordedAt to a conversation node, so the time cannot come from there)');
  assert.equal(bySeq(redacted.seq).length, 1, 'the redacted post is STILL an event: dropping it would let the lane ack past it');
  assert.ok(!r.text.includes(redacted.body), 'and none of its text is in the answer');
  assert.ok(redacted.seq <= n, 'PRECONDITION: it is legacy (at or below F.logSeq)');
});

test('#1762 S4 LP4a — a genuine hole INSIDE the range (the log has no line at 3 or 4) is skipped by existing-node paging: the page is the next `limit` existing nodes, nothing is re-served or lost across the walk, and the token\'s log half is the highest N served', T, async () => {
  const { n } = await plantAtHead();
  await seedLane('lp4a', 2);                                                                       // the log has a genuine hole at 3 and 4: nothing was deleted
  const first = await pull('lp4a', 2);
  assert.equal(first.status, 200, `(${first.status}: ${first.text.slice(0, 200)})`);
  assert.deepEqual(seqsOf(first), [5, 6], 'the page is the next TWO existing nodes: the gap is skipped (A-LP2)');
  assert.equal(tokenOf(first).log, 6, 'and its token\'s log half is the highest N served');
  assert.equal(laneState('lp4a').acked, 2, 'nothing advanced: not on the serve');
  assert.deepEqual(seqsOf(await pull('lp4a', 2)), [5, 6], 'the same page is served again until it is acked');
  const seen = [];
  let r = first;
  for (let i = 0; i < 40; i++) {                                                                     // walk the whole range, acking each page
    seen.push(...seqsOf(r).filter((s) => s <= n));
    assert.equal((await ack('lp4a', r.json.ack_token)).status, 200, `page ${i} acks`);
    r = await pull('lp4a', 2);
    if (!seqsOf(r).some((s) => s <= n)) break;
  }
  assert.deepEqual(seen, nodeSeqs(n).filter((x) => x > 2), `every existing node in (2, ${n}] exactly once: none lost across the gap, none served twice`);
});

test('#1762 S4 LP5 — a lane registered AFTER F starts with its log half at F.logSeq, not at the log\'s head', T, async () => {
  const n = await settle();
  const extra = await W.send('POST', '/api/cards', { title: 'after the settle', description: 'x', createdBy: 'ada' });
  assert.equal(extra.status, 201);
  const head = readLog().at(-1).seq;
  assert.ok(head > n, `PRECONDITION: the log head (${head}) is past what F will name (${n})`);
  await certify({ logSeq: n });
  const r = await W.send('POST', '/api/cursors/register', { registrySeatId: 'lp5' });
  assert.equal(r.status, 200, `(${r.status}: ${r.text.slice(0, 200)})`);
  assert.equal(r.json.fresh, true);
  assert.equal(r.json.envelope.last_acked_seq, n, 'the log half starts at F.logSeq');
});

test('#1762 S4 LP6 — an INVALID F refuses the pull 503 HISTORY_FRONTIER_INVALID, a store mismatch 503 HISTORY_FRONTIER_STORE_MISMATCH, and the lane is exactly as it was', T, async () => {
  const n = await settle();
  await seedLane('lp6', 2);
  const before = JSON.stringify(laneState('lp6'));
  await W.plantFrontier({ logSeq: null });
  const bad = await pull('lp6');
  assert.equal(bad.status, 503, `(${bad.status}: ${bad.text.slice(0, 200)})`);
  assert.equal(bad.json?.code, 'HISTORY_FRONTIER_INVALID');
  assert.equal(bad.json?.events, undefined, 'nothing is served');
  const h = await W.health();
  await certify({ logSeq: n, over: { epoch: `"${Number(h.epoch) + 7}"^^<${XSD}integer>` } });
  const mism = await pull('lp6');
  assert.equal(mism.status, 503); assert.equal(mism.json?.code, 'HISTORY_FRONTIER_STORE_MISMATCH');
  assert.equal(JSON.stringify(laneState('lp6')), before, 'the lane is byte-identical');
});

test('#1762 S4 LP7 — a token whose log half is beyond F.logSeq cannot have been served: 409 ACK_BEYOND_SERVED, the lane unchanged', T, async () => {
  const { n } = await plantAtHead();
  await seedLane('lp7', 2);
  const r = await pull('lp7', 500);
  const forged = { ...tokenOf(r), log: n + 5 };
  const token = Buffer.from(JSON.stringify(forged), 'utf8').toString('base64url');
  const before = JSON.stringify(laneState('lp7'));
  const a = await ack('lp7', token);
  assert.equal(a.status, 409, `(${a.status}: ${a.text.slice(0, 200)})`);
  assert.equal(a.json?.code, 'ACK_BEYOND_SERVED');
  assert.equal(JSON.stringify(laneState('lp7')), before, 'the lane did not move');
});

// ══ the graph half: whole-commit pages (the reviewer asked for these before the lane build) ══
/** a native write of ONE commit with several parts (a card create that names two cards re-writes them too), after F. Returns its opId, part count and commitSeq. */
async function nativeCommit(title) {
  const r = await W.send('POST', '/api/cards', { title, description: 'names two cards', createdBy: 'ada', relationships: { relatedTo: [1, 3] } });
  assert.equal(r.status, 201, `PRECONDITION: the multi-card create applied (${r.status} ${r.text.slice(0, 200)})`);
  const ops = await W.q(`SELECT ?op WHERE { ?a <${PROV}used> <${ENT}${r.json.id}> ; <${RS}recordedBy> ?op }`);
  assert.equal(ops.length, 1, 'PRECONDITION: the new card has one recorded op');
  const opId = ops[0].op.value;
  const parts = Number((await W.q(`SELECT (COUNT(?b) AS ?n) WHERE { ?b <${RS}recordedBy> <${opId}> }`))[0].n.value);
  assert.ok(parts >= 2, `PRECONDITION: the write is ONE commit of several parts (got ${parts})`);
  return { card: r.json, opId, parts, commitSeq: Number((await W.health()).commitSeq) };
}
/** a lane whose log half is drained (acked at F.logSeq) and whose graph half is at the head when F is planted: it is owed only the commits written after */
async function graphLane(name) {
  const { n } = await plantAtHead();
  await seedLane(name, n);
  return n;
}
const graphEvents = (r) => r.json.events.filter((e) => e.graph?.opId);
const byOp = (events) => { const m = {}; for (const e of events) (m[e.graph.opId] ||= []).push(e); return m; };
/** the same lane read through ANOTHER REST over the same data: a restart as far as the lane's state is concerned */
async function viaRestart(fn) {
  const srv = await W.startRest();
  try {
    return await fn({
      pull: (name, limit = 200) => srv.get(`/api/cursors/pull?identity=${encodeURIComponent(`registry:${name}`)}&limit=${limit}`),
      ack: async (name, token) => {
        const r = await fetch(`${srv.rest.baseUrl}/api/cursors/ack`, { method: 'POST', headers: { authorization: `Bearer ${W.TOK}`, 'content-type': 'application/json' }, body: JSON.stringify({ identity: `registry:${name}`, token }), signal: AbortSignal.timeout(60000) });
        const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
        return { status: r.status, text, json };
      },
    });
  } finally { await srv.stop(); }
}

test('#1762 S4 LG1 — a multi-part native commit larger than `limit` is served WHOLE in one page: every part of it, nothing of another commit, and the token\'s graph half is that commit\'s commitSeq', T, async () => {
  await graphLane('lg1');
  const c = await nativeCommit('whole commit one');
  const r = await pull('lg1', 1);
  assert.equal(r.status, 200, `(${r.status}: ${r.text.slice(0, 200)})`);
  const groups = byOp(graphEvents(r));
  assert.deepEqual(Object.keys(groups), [c.opId], `the page holds exactly that commit (got ${JSON.stringify(Object.keys(groups))})`);
  assert.equal(groups[c.opId].length, c.parts, `with ALL ${c.parts} of its parts although limit is 1 (an oversized commit is served whole)`);
  assert.ok(groups[c.opId].every((e) => e.graph.commitSeq === c.commitSeq), 'all at its commitSeq');
  assert.equal(tokenOf(r).graph.commitSeq, c.commitSeq, 'and the token\'s graph half is that commit: a page never ends inside one');
});

test('#1762 S4 LG2 — repeat-before-ACK: the same pull again returns the same parts and the same token, and the lane\'s graph half has not moved', T, async () => {
  await graphLane('lg2');
  const c = await nativeCommit('whole commit two');
  const before = laneState('lg2').graph_acked;
  const first = await pull('lg2', 1);
  const again = await pull('lg2', 1);
  const key = (r) => graphEvents(r).map((e) => `${e.graph.opId}/${e.graph.commitSeq}/${e.entity?.id}`).sort();
  assert.equal(graphEvents(first).length, c.parts, `PRECONDITION: the first page holds the whole commit (${graphEvents(first).length} of ${c.parts})`);
  assert.deepEqual(key(again), key(first), 'the same parts again');
  assert.equal(tokenOf(again).graph.commitSeq, tokenOf(first).graph.commitSeq, 'under the same token');
  assert.equal(laneState('lg2').graph_acked, before, 'and neither pull moved the lane\'s graph half');
});

test('#1762 S4 LG3 — ACK and RESTART: a restart before the ack serves the same page; an ack across a restart is accepted and moves the lane to that commit; after another restart none of its parts is served again', T, async () => {
  await graphLane('lg3');
  const c = await nativeCommit('whole commit three');
  const first = await pull('lg3', 1);
  assert.equal(graphEvents(first).length, c.parts, `PRECONDITION: the page holds the whole commit (${graphEvents(first).length} of ${c.parts})`);
  const token = first.json.ack_token;
  const before = laneState('lg3').graph_acked;
  await viaRestart(async (s) => {
    const again = await s.pull('lg3', 1);
    assert.equal(graphEvents(again).length, c.parts, 'a restart before the ack: the same whole commit is served again');
    assert.equal(laneState('lg3').graph_acked, before, 'and the lane has not moved');
    const a = await s.ack('lg3', token);
    assert.equal(a.status, 200, `the ack minted before the restart is accepted across it (${a.status}: ${a.text.slice(0, 200)})`);
  });
  assert.equal(laneState('lg3').graph_acked, c.commitSeq, 'the lane moved to that commit, and only now');
  await viaRestart(async (s) => {
    const next = await s.pull('lg3', 1);
    assert.equal(graphEvents(next).filter((e) => e.graph.opId === c.opId).length, 0, 'after another restart none of the acked commit\'s parts is served again');
  });
});

test('#1762 S4 LG4 — no sibling part is lost: two multi-part commits walked with limit 1 and an ack per page give each commit\'s every part exactly once, in commit order, and then nothing', T, async () => {
  await graphLane('lg4');
  const c1 = await nativeCommit('sibling commit one'), c2 = await nativeCommit('sibling commit two');
  assert.ok(c2.commitSeq > c1.commitSeq, 'PRECONDITION: two commits, in order');
  const p1 = await pull('lg4', 1);
  assert.deepEqual(Object.keys(byOp(graphEvents(p1))), [c1.opId], 'page 1 is the first commit and nothing of the second');
  assert.equal(graphEvents(p1).length, c1.parts, `with all ${c1.parts} of its parts`);
  assert.equal((await ack('lg4', p1.json.ack_token)).status, 200);
  const p2 = await pull('lg4', 1);
  assert.deepEqual(Object.keys(byOp(graphEvents(p2))), [c2.opId], 'page 2 is the second commit and nothing of the first (no part of an acked commit comes back)');
  assert.equal(graphEvents(p2).length, c2.parts, `with all ${c2.parts} of its parts: no sibling was lost to the first ack`);
  assert.equal((await ack('lg4', p2.json.ack_token)).status, 200);
  assert.equal(laneState('lg4').graph_acked, c2.commitSeq, 'the lane is at the second commit');
  assert.deepEqual(graphEvents(await pull('lg4', 1)).filter((e) => [c1.opId, c2.opId].includes(e.graph.opId)), [], 'and nothing of either is served again');
});

// ══ the lane proof (S4 v1.6, v1.6.1, v1.6.2): a lane's log-half advance is verified against F's committed Merkle root ══
// The rows build the certified tree and F THEMSELVES with the independent reference (helpers/history-merkle-1762.mjs) over v1.6.2's vocabulary, so they depend on no construction code.
const C = certifier({ q: (x) => W.q(x), update: (x) => W.update(x), BK, FR, XSD, PROV, RS, ACT });
const { X, liveEntries, leafIri, nodeIri, leafTriples, internalRanges, writeTree } = C;
const HEX = (b) => M.hex(b);
/** F (the five S3 fields) plus the five history fields, over a freshly built tree of the live nodes at or below `logSeq` */
async function certify({ logSeq, entries = null, over = {} } = {}) {
  const live = entries ?? await liveEntries(logSeq);
  const t = await writeTree(live);
  const { h } = await W.plantFrontier({ logSeq: X(logSeq), ...over });
  const epoch = over.epoch ? Number(/"(-?\d+)"/.exec(over.epoch)[1]) : h.epoch;            // the commitment is over what was PLANTED, so a store mismatch is a consistent, certified F of another store
  const info = await C.writeFrontierHistory({ epoch, incarnationHex: W.hex(h.incarnation), logSeq, commitSeq: h.commitSeq, t });
  return { ...t, h, logSeq, f: { root: info.root, L: info.L, tree: info.tree, format: 'hist-v1' }, commitment: info.commitment };
}
const setObj = (g, s0, p, newTermSparql) => W.update(`DELETE { GRAPH <${g}> { <${s0}> <${p}> ?o } } INSERT { GRAPH <${g}> { <${s0}> <${p}> ${newTermSparql} } } WHERE { GRAPH <${g}> { <${s0}> <${p}> ?o } }`);
const flip = (hexStr) => `${hexStr[0] === '0' ? '1' : '0'}${hexStr.slice(1)}`;
const liveNodeTriples = async (N) => (await W.q(`SELECT ?p ?o WHERE { <${node(N)}> ?p ?o }`));
const termSparql = (b) => (b.type === 'uri' ? `<${b.value}>` : b.datatype ? `${lit(b.value)}^^<${b.datatype}>` : lit(b.value));
async function restoreNode(N, triples) { if (triples.length) await W.update(`INSERT DATA { ${triples.map((t) => `<${node(N)}> <${t.p.value}> ${termSparql(t.o)} .`).join('\n')} }`); }
/** a lane that has acked nothing, owed the whole certified range */
const proofLane = async (name, acked = 0) => seedLane(name, acked);
async function expectCoverageRefused(name, label, limit = 500) {
  const before = JSON.stringify(laneState(name));
  const r = await pull(name, limit);
  assert.equal(r.status, 503, `${label}: refused, not served (got ${r.status}: ${r.text.slice(0, 200)})`);
  assert.equal(r.json?.code, 'HISTORY_COVERAGE_CHANGED', `${label}: named (got ${r.json?.code})`);
  assert.equal(r.json?.events, undefined, `${label}: no events`);
  assert.equal(r.json?.ack_token, undefined, `${label}: no ack_token`);
  assert.equal(JSON.stringify(laneState(name)), before, `${label}: the lane is byte-identical`);
}
const redactLegacy = async (id) => {
  const r = await createGraphClient({ baseUrl: W.exec.baseUrl, expectedDatasetId: WB_DATASET }).update({ kind: 'post.redact', history: true, opId: `urn:ex:op/redact/${id}`, actor: `${PERSON}ada`, post: { id }, authorityRef: 'test-authority-ref', occurredAt: new Date().toISOString() });
  assert.equal(r.outcome, 'APPLIED', `PRECONDITION: the post is redacted (${JSON.stringify(r)})`);
};
const ownSeqs = (r, n) => seqsOf(r).filter((x) => x <= n);

test('#1762 S4 PR00 CONTROL — the certified world is what v1.6.2 says (read back from the executor, checked with the reference only): F carries each history field once, the stored entries and subtrees recompute to F\'s root, every audit path verifies, and the commitment recomputes (no product code is involved: this holds on main by design)', T, async () => {
  const { n, cert } = await plantAtHead();
  const fRows = await W.q(`SELECT ?p ?o WHERE { GRAPH <${BK}> { <${FR}> ?p ?o } }`);
  const one = (name) => { const v = fRows.filter((r) => r.p.value === `${NS}frontierHistory${name}`); assert.equal(v.length, 1, `F carries frontierHistory${name} exactly once (${v.length})`); return v[0].o; };
  const root = one('Root').value, L = Number(one('LeafCount').value), tree = one('Tree').value, format = one('Format').value, commitment = one('Commitment').value;
  assert.equal(one('Tree').type, 'uri', 'the tree is an IRI'); assert.equal(one('LeafCount').datatype, `${XSD}integer`); assert.equal(format, 'hist-v1');
  assert.match(root, /^[0-9a-f]{64}$/); assert.match(commitment, /^[0-9a-f]{64}$/);
  const entries = {}; const g = await W.q(`SELECT ?s ?p ?o WHERE { GRAPH <${tree}> { ?s ?p ?o } }`);
  for (const r of g) (entries[r.s.value] ||= {})[r.p.value.replace(NS, '')] = r.o.value;
  const leaves = [];
  for (let i = 0; i < L; i++) { const e = entries[leafIri(tree, i)]; assert.ok(e, `entry ${i} exists`); assert.equal(Number(e.htRank), i); leaves.push(e); }
  const recomputed = leaves.map((e) => M.leafHash({ N: Number(e.htN), used: e.htUsed, op: e.htOp, entityKind: e.htKind }));
  leaves.forEach((e, i) => assert.equal(e.htLeaf, HEX(recomputed[i]), `entry ${i}: the stored hash is the hash of its tuple`));
  assert.equal(HEX(M.mth(recomputed)), root, 'the entries recompute to F\'s root');
  for (const [a, b] of internalRanges(L)) assert.equal(entries[nodeIri(tree, a, b)]?.htHash, HEX(M.mth(recomputed.slice(a, b))), `subtree [${a},${b}) is the hash of its range`);
  for (let i = 0; i < L; i++) assert.equal(HEX(M.rootFromPath(recomputed[i], i, L, M.auditPath(recomputed, i))), root, `rank ${i}: its audit path verifies`);
  const h = await W.health();
  assert.equal(commitment, M.commitment({ epoch: h.epoch, incarnation: W.hex(h.incarnation), logSeq: n, commitSeq: cert.h.commitSeq, L, tree, root }), 'and the commitment recomputes from F\'s own fields');
  assert.deepEqual(leaves.map((e) => Number(e.htN)), cert.entries.map((e) => e.N), 'the committed N are exactly the live canonical nodes at or below F.logSeq');
  assert.equal(entries[tree]?.htRoot, root, 'the header agrees (untrusted, but honest here)');
});

test('#1762 S4 PR0 CONTROL — a CERTIFIED F with an untouched tree serves a lane acked at 0 every committed node, once each, ascending: the proof does not refuse a healthy lane', T, async () => {
  const { n, cert } = await plantAtHead();
  await proofLane('pr0');
  const r = await pull('pr0', 500);
  assert.equal(r.status, 200, `(${r.status}: ${r.text.slice(0, 300)})`);
  assert.deepEqual(ownSeqs(r, n), cert.entries.map((e) => e.N), 'every committed node, ascending, once each');
  assert.ok(r.json.ack_token, 'and a token');
});

/** the sibling subtrees RFC 6962's recursion names for leaf `i` of `n`, as [start, end) ranges, deepest first (a size-1 range is a leaf entry) */
function pathRanges(n, i, lo = 0) {
  if (n === 1) return [];
  let k = 1; while (k * 2 < n) k *= 2;
  return i < k ? [...pathRanges(k, i, lo), [lo + k, lo + n]] : [...pathRanges(n - k, i - k, lo + k), [lo, lo + k]];
}
/** a lane position and page for which a stored internal hash is PROVABLY CONSUMED: the page serves ranks p+1..p+3, and the leaf entries behind the OUTERMOST path sibling wholly before the predecessor are
 *  DELETED, so the only way to authenticate across it is its stored subtree hash. (A full-range pull could recompute the root from every live leaf and never use a stored internal hash; the reviewer's
 *  correction: an unused cache must not refuse a sound proof, so a corrupted one must be shown to be consumed.) Only the LEFT side is built this way: the position search probes entries on
 *  the page's side of the lane, so deleting entries to its right would break the search itself, not the proof's use of a stored hash. The left subtree is never probed by a search for a rank
 *  in the right half. */
async function consumedSiblingWorld(name) {
  const { n, cert } = await plantAtHead();
  const L = cert.built.L; const p = Math.floor(L * 0.6);
  const served = [p + 1, p + 2, p + 3];
  const multi = (r) => r[1] - r[0] >= 2;
  const left = pathRanges(L, p).filter(multi).filter(([, b]) => b <= p).at(-1);
  assert.ok(left && left[0] === 0, `PRECONDITION: the predecessor's path has a multi-leaf subtree from rank 0 wholly before it (L=${L}, p=${p}: ${JSON.stringify(left)})`);
  for (let rank = left[0]; rank < left[1]; rank++) await W.update(`DELETE WHERE { GRAPH <${cert.tree}> { <${leafIri(cert.tree, rank)}> ?p ?o } }`);
  await seedLane(name, cert.entries[p].N);
  return { n, cert, L, p, served, left };
}
const nodeHashOf = (cert, [a, b]) => HEX(M.mth(cert.built.leaves.slice(a, b)));
const childOf = ([a, b]) => { let k = 1; while (k * 2 < b - a) k *= 2; return [a, a + k]; };

test('#1762 S4 PA1 — a REWRITTEN SIBLING that the proof CONSUMES refuses: with the leaf entries behind the predecessor\'s outermost left path sibling deleted (so its stored hash is the only way across), corrupting that subtree\'s hash is refused 503 HISTORY_COVERAGE_CHANGED; the same page with the hash intact is served', T, async () => {
  const w = await consumedSiblingWorld('pa1');
  const ok = await pull('pa1', 3);
  assert.equal(ok.status, 200, `CONTROL: with every stored hash intact the page is served though the entries behind two siblings are gone (got ${ok.status}: ${ok.text.slice(0, 200)})`);
  assert.deepEqual(ownSeqs(ok, w.n), w.served.map((r) => w.cert.entries[r].N), 'the three ranks after the predecessor');
  for (const [label, range] of [['left of the predecessor', w.left]]) {
    const orig = nodeHashOf(w.cert, range);
    await setObj(w.cert.tree, nodeIri(w.cert.tree, ...range), `${NS}htHash`, lit(flip(orig)));
    await expectCoverageRefused('pa1', `the consumed subtree [${range}) ${label} rewritten`, 3);
    await setObj(w.cert.tree, nodeIri(w.cert.tree, ...range), `${NS}htHash`, lit(orig));
  }
  assert.equal((await pull('pa1', 3)).status, 200, 'CONTROL: restored, the page is served again');
});

test('#1762 S4 PA1b — a corrupted stored hash the proof does NOT use is no reason to refuse (the reviewer\'s correction): a child of a consumed subtree, and a subtree wholly outside the page\'s paths, rewritten, still serve the same page', T, async () => {
  const w = await consumedSiblingWorld('pa1b');
  const usedPaths = new Set([...pathRanges(w.L, w.p), ...w.served.flatMap((r) => pathRanges(w.L, r)), ...pathRanges(w.L, w.p + 1)].map((r) => `${r[0]}-${r[1]}`));
  const unusedChild = childOf(w.left);
  assert.ok(!usedPaths.has(`${unusedChild[0]}-${unusedChild[1]}`), `PRECONDITION: the child [${unusedChild}) of the consumed subtree is on no path of this page`);
  const orig = nodeHashOf(w.cert, unusedChild);
  await setObj(w.cert.tree, nodeIri(w.cert.tree, ...unusedChild), `${NS}htHash`, lit(flip(orig)));
  const r = await pull('pa1b', 3);
  assert.equal(r.status, 200, `an unused cache entry corrupted does not invalidate a sound proof (got ${r.status}: ${r.text.slice(0, 200)})`);
  assert.deepEqual(ownSeqs(r, w.n), w.served.map((x) => w.cert.entries[x].N), 'and the same three ranks are served');
});

test('#1762 S4 PA2 — a REWRITTEN LEAF HASH (the tuple intact): a certificate entry whose htLeaf is not the hash of its own tuple is refused, at the first, a middle and the last rank', T, async () => {
  const { cert } = await plantAtHead();
  await proofLane('pa2');
  const L = cert.built.L;
  for (const rank of [0, Math.floor(L / 2), L - 1]) {
    const orig = HEX(cert.built.leaves[rank]);
    await setObj(cert.tree, leafIri(cert.tree, rank), `${NS}htLeaf`, lit(flip(orig)));
    await expectCoverageRefused('pa2', `leaf ${rank} htLeaf rewritten`);
    await setObj(cert.tree, leafIri(cert.tree, rank), `${NS}htLeaf`, lit(orig));
  }
});

test('#1762 S4 PA3 — a RELABELLED N beside a valid hash: an entry whose htN is changed while its other fields and htLeaf are intact is refused (P1: N is authenticated from the full tuple, never metadata beside a hash)', T, async () => {
  const { cert } = await plantAtHead();
  await proofLane('pa3');
  const rank = 3; const e = cert.entries[rank];
  await setObj(cert.tree, leafIri(cert.tree, rank), `${NS}htN`, X(e.N + 1));
  await expectCoverageRefused('pa3', `entry ${rank} relabelled N ${e.N} -> ${e.N + 1}`);
});

test('#1762 S4 PA4 — a SELF-CONSISTENT rewritten entry (a new N and the hash recomputed from the new tuple) is refused: it no longer authenticates to F\'s root', T, async () => {
  const { cert } = await plantAtHead();
  await proofLane('pa4');
  const rank = 4; const e = { ...cert.entries[rank], N: cert.entries[rank].N + 1 };
  await W.update(`DELETE WHERE { GRAPH <${cert.tree}> { <${leafIri(cert.tree, rank)}> ?p ?o } } ; INSERT DATA { GRAPH <${cert.tree}> { ${leafTriples(cert.tree, rank, e, HEX(M.leafHash(e)))} } }`);
  await expectCoverageRefused('pa4', `entry ${rank} rewritten consistently`);
});

test('#1762 S4 PA5 — REORDERED certificate entries (two adjacent ranks swap their whole tuples and hashes) are refused: the audit path no longer authenticates them', T, async () => {
  const { cert } = await plantAtHead();
  await proofLane('pa5');
  const i = 2; const [a, b] = [cert.entries[i], cert.entries[i + 1]];
  await W.update(`DELETE WHERE { GRAPH <${cert.tree}> { <${leafIri(cert.tree, i)}> ?p ?o } } ; DELETE WHERE { GRAPH <${cert.tree}> { <${leafIri(cert.tree, i + 1)}> ?p ?o } } ; INSERT DATA { GRAPH <${cert.tree}> { ${leafTriples(cert.tree, i, b, HEX(M.leafHash(b)))}\n${leafTriples(cert.tree, i + 1, a, HEX(M.leafHash(a)))} } }`);
  await expectCoverageRefused('pa5', 'adjacent entries swapped');
});

test('#1762 S4 PA6 — a certified node DELETED from the live graph inside the owed range is refused (a missing expected node), never skipped', T, async () => {
  const { cert } = await plantAtHead();
  await proofLane('pa6');
  const victim = cert.entries[5].N; const saved = await liveNodeTriples(victim);
  try {
    await W.update(`DELETE WHERE { <${node(victim)}> ?p ?o }`);
    await expectCoverageRefused('pa6', `live node ${victim} deleted`);
  } finally { await restoreNode(victim, saved); }
});

test('#1762 S4 PA7 — a certified node whose live FACTS were replaced (its op changed) is refused: the leaf recomputed from the live node is not the committed one', T, async () => {
  const { cert } = await plantAtHead();
  await proofLane('pa7');
  const victim = cert.entries[4];
  await W.update(`DELETE { <${node(victim.N)}> <${RS}op> ?o } INSERT { <${node(victim.N)}> <${RS}op> "forged-op" } WHERE { <${node(victim.N)}> <${RS}op> ?o }`);
  try { await expectCoverageRefused('pa7', `live node ${victim.N} op replaced`); }
  finally { await W.update(`DELETE { <${node(victim.N)}> <${RS}op> ?o } INSERT { <${node(victim.N)}> <${RS}op> ${lit(victim.op)} } WHERE { <${node(victim.N)}> <${RS}op> ?o }`); }
});

test('#1762 S4 PA8 — the reviewer\'s counterexample: an owed node is REPLACED by another inserted into a permitted gap (N = 5 deleted, a node of the same facts inserted at N = 3): a lane acked at 2 is refused, never served past the loss', T, async () => {
  const { cert } = await plantAtHead();
  const target = cert.entries.find((e) => e.N === 5); assert.ok(target, 'PRECONDITION: node 5 is committed');
  await proofLane('pa8', 2);
  const saved = await liveNodeTriples(5);
  try {
    await W.update(`DELETE WHERE { <${node(5)}> ?p ?o }`);
    await W.update(`INSERT DATA { ${saved.map((t) => `<${node(3)}> <${t.p.value}> ${termSparql(t.o)} .`).join('\n')} }`);
    await expectCoverageRefused('pa8', 'node 5 replaced by a node at 3');
  } finally { await W.update(`DELETE WHERE { <${node(3)}> ?p ?o }`); await restoreNode(5, saved); }
});

test('#1762 S4 PA9 — a node INSERTED into a gap with the certificate unchanged is never served: the page is the committed ranks (v1.6 section 2)', T, async () => {
  const { n, cert } = await plantAtHead();
  await proofLane('pa9', 2);
  const saved = await liveNodeTriples(5);
  try {
    await W.update(`INSERT DATA { ${saved.map((t) => `<${node(4)}> <${t.p.value}> ${termSparql(t.o)} .`).join('\n')} }`);
    const r = await pull('pa9', 500);
    assert.equal(r.status, 200, `(${r.status}: ${r.text.slice(0, 200)})`);
    assert.deepEqual(ownSeqs(r, n), cert.entries.map((e) => e.N).filter((x) => x > 2), 'exactly the committed ranks after 2: the inserted node 4 is not among them');
  } finally { await W.update(`DELETE WHERE { <${node(4)}> ?p ?o }`); }
});

test('#1762 S4 PA10 — a certificate entry with a DUPLICATE rank value, a MISSING entry, or a rank that disagrees with its subject is refused (malformed paths and impossible indices fail closed)', T, async () => {
  const { cert } = await plantAtHead();
  await proofLane('pa10');
  const rank = 3; const e = cert.entries[rank]; const entryIri = leafIri(cert.tree, rank);
  await W.update(`INSERT DATA { GRAPH <${cert.tree}> { <${entryIri}> <${NS}htRank> ${X(rank + 1)} } }`);
  await expectCoverageRefused('pa10', 'two htRank values on one entry');
  await W.update(`DELETE WHERE { GRAPH <${cert.tree}> { <${entryIri}> <${NS}htRank> ?o } } ; INSERT DATA { GRAPH <${cert.tree}> { <${entryIri}> <${NS}htRank> ${X(rank)} } }`);
  await setObj(cert.tree, entryIri, `${NS}htRank`, X(rank + 5));
  await expectCoverageRefused('pa10', 'an entry whose rank disagrees with its subject');
  await setObj(cert.tree, entryIri, `${NS}htRank`, X(rank));
  await W.update(`DELETE WHERE { GRAPH <${cert.tree}> { <${entryIri}> ?p ?o } }`);
  await expectCoverageRefused('pa10', 'an entry missing');
  await W.update(`INSERT DATA { GRAPH <${cert.tree}> { ${leafTriples(cert.tree, rank, e, HEX(cert.built.leaves[rank]))} } }`);
  assert.equal((await pull('pa10', 500)).status, 200, 'CONTROL: with the entry restored the lane is served');
});

test('#1762 S4 PA11 — a MISSING audit node the proof consumes (its triples removed, the entries behind it gone) is refused, never recomputed around; an unused one removed still serves', T, async () => {
  const w = await consumedSiblingWorld('pa11');
  const intact = await pull('pa11', 3);
  assert.equal(intact.status, 200, `CONTROL (essential: it attributes the refusal below to the removed hash): with every consumed hash intact the page is served though the entries behind two siblings are gone (got ${intact.status}: ${intact.text.slice(0, 200)})`);
  const unused = childOf(w.left);
  await W.update(`DELETE WHERE { GRAPH <${w.cert.tree}> { <${nodeIri(w.cert.tree, ...unused)}> ?p ?o } }`);
  assert.equal((await pull('pa11', 3)).status, 200, 'an unused subtree removed does not refuse');
  await W.update(`DELETE WHERE { GRAPH <${w.cert.tree}> { <${nodeIri(w.cert.tree, ...w.left)}> ?p ?o } }`);
  await expectCoverageRefused('pa11', `the consumed subtree [${w.left}) removed`, 3);
});

test('#1762 S4 PA12 — the PREDECESSOR comes from the certificate: a lane acked at 2 is served from the next committed node even when the live node at 2 is gone', T, async () => {
  const { n, cert } = await plantAtHead();
  await proofLane('pa12', 2);
  const saved = await liveNodeTriples(2);
  try {
    await W.update(`DELETE WHERE { <${node(2)}> ?p ?o }`);
    const r = await pull('pa12', 500);
    assert.equal(r.status, 200, `a deleted ACKED node is outside what the proof covers (v1.6 section 3), so it does not refuse (got ${r.status}: ${r.text.slice(0, 200)})`);
    assert.deepEqual(ownSeqs(r, n), cert.entries.map((e) => e.N).filter((x) => x > 2), 'and the committed ranks after 2 are served');
  } finally { await restoreNode(2, saved); }
});

test('#1762 S4 PA13 — an INTERIOR boundary at a hole: a lane acked at 3 (the log has no line at 3 or 4) is served from the committed node at 5, not refused as a missing start', T, async () => {
  const { n, cert } = await plantAtHead();
  await proofLane('pa13', 3);
  const r = await pull('pa13', 500);
  assert.equal(r.status, 200, `(${r.status}: ${r.text.slice(0, 200)})`);
  assert.deepEqual(ownSeqs(r, n), cert.entries.map((e) => e.N).filter((x) => x > 3), 'from the next committed rank');
});

test('#1762 S4 PA14 — the TREE F names: a missing graph, a header with no entries, and a different self-consistent tree whose root is not F\'s are all refused; an unreferenced complete tree beside it changes nothing', T, async () => {
  const { n, cert } = await plantAtHead();
  await proofLane('pa14');
  const named = (r) => r.status === 503 && ['HISTORY_COVERAGE_CHANGED', 'HISTORY_FRONTIER_INVALID'].includes(r.json?.code) && r.json.events === undefined && r.json.ack_token === undefined;
  const other = await writeTree(cert.entries.slice(0, -1));                                          // a complete, self-consistent tree over FEWER nodes: not unreferenced noise, a rival
  assert.equal((await pull('pa14', 500)).status, 200, 'CONTROL: a complete tree F does not name changes nothing');
  await setObj(BK, FR, `${NS}frontierHistoryTree`, `<${other.tree}>`);
  const rival = await pull('pa14', 500);
  assert.ok(named(rival), `F naming a self-consistent tree with another root (and a commitment over the old tree) is refused (got ${rival.status} ${rival.json?.code})`);
  const empty = await writeTree(cert.entries, { header: true }); await W.update(`DELETE { GRAPH <${empty.tree}> { ?s ?p ?o } } WHERE { GRAPH <${empty.tree}> { ?s ?p ?o . FILTER(STRSTARTS(STR(?s), "${empty.tree}/")) } }`);
  const hdr = await W.plantFrontier({ logSeq: X(n) });
  await C.writeFrontierHistory({ epoch: hdr.h.epoch, incarnationHex: W.hex(hdr.h.incarnation), logSeq: n, commitSeq: hdr.h.commitSeq, t: empty });
  const partial = await pull('pa14', 500);
  assert.ok(named(partial), `F naming a tree with a header and no entries is refused (got ${partial.status} ${partial.json?.code})`);
  await W.update(`DELETE WHERE { GRAPH <${empty.tree}> { ?s ?p ?o } }`);
  const gone = await pull('pa14', 500);
  assert.ok(named(gone), `F naming a tree graph that does not exist is refused (got ${gone.status} ${gone.json?.code})`);
});

test('#1762 S4 PA15 — F\'s COMMITMENT is checked: changing ANY committed field after the digest was computed (root, leaf count, tree IRI, format) makes F invalid, refused 503 HISTORY_FRONTIER_INVALID on a lane pull and on /api/changes', T, async () => {
  const { n } = await plantAtHead();
  await proofLane('pa15');
  const variants = [
    ['root', `${NS}frontierHistoryRoot`, (c) => lit(flip(c.f.root))],
    ['leaf count', `${NS}frontierHistoryLeafCount`, (c) => X(c.f.L + 1)],
    ['tree IRI', `${NS}frontierHistoryTree`, () => `<urn:scrum:history-tree:forged-${crypto.randomUUID().slice(0, 6)}>`],
    ['format', `${NS}frontierHistoryFormat`, () => lit('hist-v2')],
  ];
  for (const [label, pred, make] of variants) {
    const c = await certify({ logSeq: n });
    await setObj(BK, FR, pred, make(c));
    const r = await pull('pa15', 500);
    assert.equal(r.status, 503, `${label}: refused (got ${r.status}: ${r.text.slice(0, 200)})`);
    assert.equal(r.json?.code, 'HISTORY_FRONTIER_INVALID', `${label}: F is invalid, named (got ${r.json?.code})`);
    const c2 = await W.get(`/api/changes?since=${SINCE_ALL}&history=true`);
    assert.equal(c2.status, 503, `${label}: /api/changes refuses too (S3's validator recomputes the commitment) (got ${c2.status}: ${c2.text.slice(0, 160)})`);
    assert.equal(c2.json?.code, 'HISTORY_FRONTIER_INVALID');
  }
});

test('#1762 S4 PA16 — a SECOND F carrying a forged root, and an F with two values for a history field, are invalid (HISTORY_FRONTIER_INVALID), not "the first one wins"', T, async () => {
  const { n } = await plantAtHead();
  await proofLane('pa16');
  const c = await certify({ logSeq: n });
  await W.update(`INSERT DATA { <${FR}> <${NS}frontierHistoryRoot> ${lit(flip(c.f.root))} . }`);          // the same F, in the default graph too: a second frontier
  const second = await pull('pa16', 500);
  assert.equal(second.status, 503, `(${second.status}: ${second.text.slice(0, 200)})`);
  assert.equal(second.json?.code, 'HISTORY_FRONTIER_INVALID');
  await W.update(`DELETE WHERE { <${FR}> <${NS}frontierHistoryRoot> ?o }`);
  const c3 = await certify({ logSeq: n });
  await W.update(`INSERT DATA { GRAPH <${BK}> { <${FR}> <${NS}frontierHistoryRoot> ${lit(flip(c3.f.root))} } }`);
  const dup = await pull('pa16', 500);
  assert.equal(dup.status, 503, `(${dup.status}: ${dup.text.slice(0, 200)})`);
  assert.equal(dup.json?.code, 'HISTORY_FRONTIER_INVALID', 'two roots on one F');
});

test('#1762 S4 LP4b — a COVERED TAIL: F.logSeq lies beyond the last committed node, the lane is acked at that node, and the proof (the last leaf, authenticated) makes the empty page safe: an EMPTY page whose token has log = F.logSeq, the lane moving only on its ack (A2)', T, async () => {
  const head = await settle();
  const logSeq = head + 3;                                                                   // the log has no line above `head`: a genuine tail with no nodes
  const cert = await certify({ logSeq });
  const lastN = cert.entries.at(-1).N;
  assert.equal(lastN, head, `PRECONDITION: the last committed node is the log head (${lastN} vs ${head})`);
  await seedLane('lp4b', lastN);
  const first = await pull('lp4b', 50);
  assert.equal(first.status, 200, `(${first.status}: ${first.text.slice(0, 200)})`);
  assert.deepEqual(first.json.events.filter((e) => Number.isInteger(e.seq) && e.seq <= logSeq), [], 'nothing is owed in (acked, F.logSeq]: the page is empty');
  assert.ok(first.json.ack_token, 'but it returns an ack_token, or the lane is served the same empty page forever');
  assert.equal(tokenOf(first).log, logSeq, 'whose log half is F.logSeq');
  assert.equal(laneState('lp4b').acked, lastN, 'and nothing advanced: not on the serve');
  assert.equal(tokenOf(await pull('lp4b', 50)).log, logSeq, 'the same pull again returns a token at F.logSeq');
  assert.equal(laneState('lp4b').acked, lastN, 'and still nothing advanced: not on a read, not on a repeat');
  assert.equal(first.json.envelope.history?.logDrained, false, 'the log half is not drained before the ack');
  assert.equal((await ack('lp4b', first.json.ack_token)).status, 200, 'the empty-tail ack is accepted');
  assert.equal(laneState('lp4b').acked, logSeq, 'and now the lane is at F.logSeq');
  const after = await pull('lp4b', 50);
  assert.deepEqual(after.json.events.filter((e) => Number.isInteger(e.seq) && e.seq <= logSeq), [], 'a repeat after the empty-tail ack serves nothing from the log half');
  assert.equal(after.json.envelope.history?.logDrained, true, 'and the log half is drained');
});

test('#1762 S4 PA17 — the empty tail is NOT issued over a rewritten last leaf: with F.logSeq beyond the last node and the last entry\'s hash rewritten, the lane is refused and gets no token', T, async () => {
  const head = await settle();
  const cert = await certify({ logSeq: head + 3 });
  const rank = cert.built.L - 1;
  await seedLane('pa17', cert.entries.at(-1).N);
  await setObj(cert.tree, leafIri(cert.tree, rank), `${NS}htLeaf`, lit(flip(HEX(cert.built.leaves[rank]))));
  await expectCoverageRefused('pa17', 'tail with the last leaf rewritten');
});


// ══ the review of 60a02f8: what a lane owed before F must still be owed, the legacy facts, and a retired log ══
test('#1762 S4 LR1 — a graph-born POST RECEIPT committed before F and not yet acked stays owed to a known lane: F does not erase graph-domain events (it has no legacy seq-node to be rescued by); it survives a repeat, a restart before the ack, and is gone only after the ack', T, async () => {
  await W.clearFrontier();
  await seedLane('lr1', 0);
  const before = laneState('lr1').graph_acked;
  const created = await W.send('POST', '/api/conversations', { author: 'ada', body: `OWED PRE FRONTIER ${crypto.randomUUID().slice(0, 8)}` });
  assert.equal(created.status, 201, `PRECONDITION: the post is written (${created.status} ${created.text.slice(0, 200)})`);
  const opId = `urn:ex:op/post/${created.json.id}`;
  const receipt = await W.q(`SELECT ?seq WHERE { GRAPH <${BK}> { <${opId}> <urn:ex:commitSeq> ?seq } }`);
  assert.equal(receipt.length, 1, 'PRECONDITION: the post has one applied receipt');
  assert.ok(Number(receipt[0].seq.value) > before, `PRECONDITION: the receipt (commit ${receipt[0].seq.value}) is above the lane\'s graph half (${before})`);
  const { n } = await plantAtHead();                                                          // F is certified AFTER the post: the receipt is at or below F.commitSeq
  const st = JSON.parse(fs.readFileSync(lanePath(), 'utf8')); st.seats['registry:lr1'].acked = n; fs.writeFileSync(lanePath(), `${JSON.stringify(st, null, 2)}\n`);     // the log half is drained; the graph half keeps where it was
  const mine = (r) => r.json.events.filter((e) => e.graph?.opId === opId);
  const first = await pull('lr1', 500);
  assert.equal(first.status, 200, `(${first.status}: ${first.text.slice(0, 200)})`);
  assert.equal(mine(first).length, 1, 'the owed pre-F post receipt is served, once');
  assert.equal(mine(await pull('lr1', 500)).length, 1, 'and again on a repeat before the ack');
  await viaRestart(async (srv) => assert.equal(mine(await srv.pull('lr1', 500)).length, 1, 'and across a restart before the ack'));
  assert.equal((await ack('lr1', first.json.ack_token)).status, 200, 'the ack is accepted');
  assert.equal(mine(await pull('lr1', 500)).length, 0, 'and after the ack it is not served again');
});

test('#1762 S4 LR1b — a pre-F graph-born post REDACTED before the pull is still an owed event (never dropped, or the lane could ack past it) and carries none of its text', T, async () => {
  await W.clearFrontier();
  await seedLane('lr1b', 0);
  const secret = `OWED REDACTED ${crypto.randomUUID().slice(0, 8)}`;
  const created = await W.send('POST', '/api/conversations', { author: 'ada', body: secret });
  assert.equal(created.status, 201);
  await redactLegacy(created.json.id);
  const { n } = await plantAtHead();
  const st = JSON.parse(fs.readFileSync(lanePath(), 'utf8')); st.seats['registry:lr1b'].acked = n; fs.writeFileSync(lanePath(), `${JSON.stringify(st, null, 2)}\n`);
  const r = await pull('lr1b', 500);
  assert.equal(r.status, 200, `(${r.status}: ${r.text.slice(0, 200)})`);
  assert.ok(r.json.events.some((e) => JSON.stringify(e).includes(created.json.id)), 'the redacted post is still an event for the lane');
  assert.ok(!r.text.includes(secret), 'and none of its text is in the answer');
});

test('#1762 S4 LR2 — non-post legacy history keeps its bounded S3 facts: a card update\'s column after the write and a refusal\'s reason and status are SERVED, not reduced to an identity-only event (the wire shape is lenient here until it is pinned: the value may sit in `state` or beside it)', T, async () => {
  await plantAtHead();
  await seedLane('lr2', 0);
  const r = await pull('lr2', 500);
  assert.equal(r.status, 200, `(${r.status}: ${r.text.slice(0, 200)})`);
  const card = r.json.events.find((x) => x.seq === 2), refusal = r.json.events.find((x) => x.seq === SKIP(6));
  assert.ok(card && refusal, 'PRECONDITION: both events are served');
  assert.equal(card.state?.column ?? card.column, 'in-progress', `seq 2\'s column after the write is retained, not recovered from the current card (got ${JSON.stringify(card)})`);
  assert.equal(refusal.reason ?? refusal.state?.reason, 'REFUSED-REASON-FIXTURE', `a refusal\'s reason is retained (got ${JSON.stringify(refusal)})`);
  assert.equal(Number(refusal.status ?? refusal.state?.status), 409, 'and its status');
});

// ── retired log: every F-present cursor entrypoint must be independent of the event-log directory ──
/** a REST over a COPY of the event-log directory with a junk tail past F appended to its latest file, the lane state in an owner file OUTSIDE it, and the fs recorder on every access */
async function retiredLogWorld({ junkTail = true, absentLog = false } = {}) {
  const { n } = await plantAtHead();
  const evdir = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-retired-log-')); owned.dirs.push(evdir);
  if (!absentLog) {
    for (const f of fs.readdirSync(W.evdir)) fs.copyFileSync(path.join(W.evdir, f), path.join(evdir, f));
    if (junkTail) fs.appendFileSync(path.join(evdir, fs.readdirSync(evdir).filter((x) => /^events-.*\.jsonl$/.test(x)).sort().at(-1)), `${JSON.stringify({ seq: n + 10, op: 'update', actor: 'ada', recorded_at: T0(20), entity: { kind: 'card', id: 'junk-after-F' }, state: null })}\n`);
  }
  const owner = path.join(os.tmpdir(), `lr-owner-${process.pid}-${crypto.randomUUID().slice(0, 6)}.json`); owned.files.push(owner);
  fs.copyFileSync(lanePath(), owner);
  const record = path.join(os.tmpdir(), `lr-log-access-${process.pid}-${crypto.randomUUID().slice(0, 6)}.log`); owned.files.push(record);
  const recorder = path.join(ROOT, 'tests/helpers/fs-store-recorder.mjs');
  const server = await W.startRest({ SCRUM_EVENT_LOG_DIR: evdir, SCRUM_CURSORS_FILE: owner, SCRUM_FS_RECORD: record, SCRUM_FS_RECORD_ALL: '1', NODE_OPTIONS: `--import ${recorder}` });
  const post = async (route, body) => { const r = await fetch(server.rest.baseUrl + route, { method: 'POST', headers: { authorization: `Bearer ${W.TOK}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => null) }; };
  const logReads = () => (fs.existsSync(record) ? fs.readFileSync(record, 'utf8').split('\n').filter((l) => l.startsWith(evdir)) : []);
  const reset = () => fs.writeFileSync(record, '');
  return { n, evdir, owner, server, post, logReads, reset, record };
}

test('#1762 S4 LR3a — with a valid certified F, REGISTER, PULL, ACK and the lane LISTING make no access to the event-log directory (the state owner is outside it): the recorder sees them with no F, and sees none with F', T, async () => {
  await seedLane('lr3a', 0);
  const w = await retiredLogWorld();
  try {
    w.reset();
    const reg = await w.post('/api/cursors/register', { registrySeatId: 'lr3a' }); const regReads = w.logReads(); w.reset();
    assert.equal(reg.status, 200, `register (${reg.status})`);
    const pullR = await w.server.get(`/api/cursors/pull?identity=${encodeURIComponent('registry:lr3a')}&limit=500`); const pullReads = w.logReads(); w.reset();
    assert.equal(pullR.status, 200, `pull (${pullR.status}: ${pullR.text.slice(0, 160)})`);
    const ackR = await w.post('/api/cursors/ack', { identity: 'registry:lr3a', token: pullR.json.ack_token }); const ackReads = w.logReads(); w.reset();
    assert.equal(ackR.status, 200, `ack (${ackR.status})`);
    const list = await w.server.get('/api/cursors'); const listReads = w.logReads(); w.reset();
    assert.equal(list.status, 200, `listing (${list.status}: ${list.text.slice(0, 160)})`);
    assert.deepEqual({ register: regReads.length, pull: pullReads.length, ack: ackReads.length, listing: listReads.length }, { register: 0, pull: 0, ack: 0, listing: 0 }, `none of them consults the retired log (reads: ${JSON.stringify({ regReads, pullReads, ackReads, listReads })})`);
    await W.clearFrontier(); w.reset();
    const control = await w.post('/api/cursors/register', { registrySeatId: 'lr3a' });
    assert.equal(control.status, 200); assert.ok(w.logReads().length > 0, 'CONTROL (essential): with NO F the same registration does read the log, so the recorder can see these accesses');
  } finally { await w.server.stop(); }
});

test('#1762 S4 LR3b — IMPLICIT adoption of a fresh lane past F takes its baseline from F.logSeq, never from the log\'s head: with F.logSeq = n and a junk tail at n+10 in the (retired) log, a fresh bearer adopts acked = n and reads no log', T, async () => {
  const w = await retiredLogWorld();
  try {
    w.reset();
    const inbound = await w.post('/api/cursors/inbound', { bearerSeat: 'lr3b-fresh' });
    assert.equal(inbound.status, 200, `(${inbound.status})`);
    assert.deepEqual({ acked: inbound.json.envelope?.last_acked_seq, logReads: w.logReads().length }, { acked: w.n, logReads: 0 }, `adopted at F.logSeq (${w.n}), not the log head (${w.n + 10}), without reading the log`);
  } finally { await w.server.stop(); }
});

test('#1762 S4 LR3c — with the event-log directory ABSENT or emptied (retired and replaced), implicit adoption past F is still F.logSeq, not zero: no replay of pre-registration history', T, async () => {
  const w = await retiredLogWorld({ absentLog: true });
  try {
    const inbound = await w.post('/api/cursors/inbound', { bearerSeat: 'lr3c-fresh' });
    assert.equal(inbound.status, 200, `(${inbound.status})`);
    assert.equal(inbound.json.envelope?.last_acked_seq, w.n, `adopted at F.logSeq (${w.n}), not 0 (the log is gone)`);
  } finally { await w.server.stop(); }
});

test('#1762 S4 LP8 — a conversation node whose post node is ABSENT refuses the pull 503 HISTORY_LEGACY_POST_MISSING {seq, entity}: nothing served, the lane unchanged', T, async () => {
  const { missing } = LEGACY_POSTS;
  const { n } = await plantAtHead();
  await W.update(`DELETE WHERE { <${ENT}${missing.id}> ?p ?o }`);                      // the conversation seq-node stays; its post node is gone
  await seedLane('lp8', missing.seq - 1);
  const before = JSON.stringify(laneState('lp8'));
  const r = await pull('lp8', 500);
  assert.equal(r.status, 503, `(${r.status}: ${r.text.slice(0, 200)})`);
  assert.equal(r.json?.code, 'HISTORY_LEGACY_POST_MISSING');
  assert.equal(r.json?.seq, missing.seq, 'naming the seq');
  assert.ok(String(JSON.stringify(r.json?.entity)).includes(missing.id), 'and the entity');
  assert.equal(r.json?.events, undefined, 'nothing is served');
  assert.equal(JSON.stringify(laneState('lp8')), before, 'and the lane is exactly as it was');
  assert.ok(missing.seq <= n, 'PRECONDITION: the node is legacy');
});

