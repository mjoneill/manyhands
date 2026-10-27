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
 *   LP4b HELD: a COVERED TAIL (no node left in (acked, F.logSeq] while acked < F.logSeq) is an empty page whose token has log = F.logSeq, the lane moving only when it is acked. SKIPPED until the
 *        proof that makes an empty tail safe is ruled (a count is not enough; the reviewer asked for a verifiable range proof): this oracle's fixture deletes a node, which is absence, not proof
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
  const fresh = evs.filter((e) => e.seq > projectedThrough);
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
async function plantAtHead() { const n = await settle(); const h = await W.plantFrontier({ logSeq: `"${n}"^^<${XSD}integer>` }); return { n, h: h.h }; }

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

test('#1762 S4 LP4b — HELD (the empty-tail proof is being ruled: F may carry a node count) — a COVERED TAIL (no node left in (acked, F.logSeq] while acked < F.logSeq) is an EMPTY page whose ack_token has log = F.logSeq; the lane moves only when it is acked, and then the log half is drained (A2)', { ...T, skip: 'HELD: S4 v1.3 (F carries a coverage proof) is awaiting the reviewer\'s ruling; this oracle deletes data, which is absence and not proof' }, async () => {
  const { n } = await plantAtHead();
  await W.update(`DELETE WHERE { <${node(n)}> ?p ?o }`);                                              // the last node is gone: nothing remains above n-1
  await seedLane('lp4b', n - 1);
  const first = await pull('lp4b', 50);
  assert.equal(first.status, 200, `(${first.status}: ${first.text.slice(0, 200)})`);
  assert.deepEqual(seqsOf(first).filter((s) => s <= n), [], 'no node remains in (acked, F.logSeq]: the page is empty');
  assert.ok(first.json.ack_token, 'but it still returns an ack_token, or the lane is served the same empty page forever');
  assert.equal(tokenOf(first).log, n, 'whose log half is F.logSeq');
  assert.equal(laneState('lp4b').acked, n - 1, 'and nothing advanced: not on the serve');
  assert.equal(tokenOf(await pull('lp4b', 50)).log, n, 'the same pull again returns a token at F.logSeq');
  assert.equal(laneState('lp4b').acked, n - 1, 'and still nothing advanced: not on a read, not on a repeat');
  assert.equal(first.json.envelope.history?.logDrained, false, 'the log half is not drained before the ack');
  assert.equal((await ack('lp4b', first.json.ack_token)).status, 200, 'acking the empty page is accepted');
  assert.equal(laneState('lp4b').acked, n, 'and now the lane has moved to F.logSeq');
  assert.equal((await pull('lp4b', 50)).json.envelope.history?.logDrained, true, 'and the log half is drained');
});

test('#1762 S4 LP5 — a lane registered AFTER F starts with its log half at F.logSeq, not at the log\'s head', T, async () => {
  const n = await settle();
  const extra = await W.send('POST', '/api/cards', { title: 'after the settle', description: 'x', createdBy: 'ada' });
  assert.equal(extra.status, 201);
  const head = readLog().at(-1).seq;
  assert.ok(head > n, `PRECONDITION: the log head (${head}) is past what F will name (${n})`);
  await W.plantFrontier({ logSeq: `"${n}"^^<${XSD}integer>` });
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
  await W.plantFrontier({ logSeq: `"${n}"^^<${XSD}integer>`, epoch: `"${Number(h.epoch) + 7}"^^<${XSD}integer>` });
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
