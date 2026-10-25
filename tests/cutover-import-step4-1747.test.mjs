/**
 * #1747 step 4 — THE CUTOVER IMPORTER, as the test author's independent RED rows. Rework r3: r2 answered the review of the
 * first file (#1747 v30, R1–R6), bound to the terms named in post 46155. Written from contract v2
 * (docs/1629-executor-cutover-contract-v2.md §2, §6 steps 3–5, §7 U3/M1/P2/A2) and the row plan v1 accepted on #1747
 * (post 46122). The builder does not write these rows; the row author does not build the importer.
 *
 * WHAT CHANGED IN r3 (post 46179, measured against the first build, 613c8c6):
 *   COL  the fixture's Column nodes had an invented shape and the candidate held no columns, so every valid world HELD at
 *        COLUMN_DIFFERS. Columns now have the live document's shape (read 2026-10-25T03:05Z) and are written into the
 *        SOURCE by the real scripts/migrate-columns-1639.mjs before the copy, so the candidate holds them as the columns
 *        unit stores them. The harness control asserts they are there.
 *   DT   the store canonicalises xsd:dateTime ("…36.750Z" reads back "…36.75Z"), so typed dateTimes compare by INSTANT.
 *        The exact lexical form is asserted where it is kept: the source JSON of each reservation, origin and entry
 *        (sourceReservationJson is a PROPOSED term, post 46179, pending the vocabulary review).
 *   NAMES  references are by card or post number only.
 *
 * WHAT CHANGED FROM r1, by review point:
 *   R1  every world is built WHOLE (document, outbox manifest, the one fault under test) BEFORE the capture manifest is
 *       sealed and the CandidateMarker written. Only the stale-capture row changes an input after sealing (afterSeal).
 *       Negatives assert the EXACT code in CODES and pair with the valid world as control (S4-A1/S4-M COMPLETE on it).
 *   R2  real vocabulary (core/graph-vocab.mjs at 58d0a5c1: POSTSEQ_TERMS, ORIGIN_TERMS) plus the post-46155 terms; typed
 *       comparisons (value AND datatype); unique sequences across every identity; a UUID epoch; non-empty post and
 *       receipt controls before any "unchanged" claim.
 *   R3  the exact U3 records (read from a copy of the live document 2026-10-25T02:46Z, not retyped); legacy map keys that
 *       are NOT the postId (the live shape); real receipts written by real post.write / post.create intentions, proven
 *       readable before import and compared exactly after.
 *   R5  the crash row observes the batch (durable, partial) BEFORE the rerun, and checks document immutability on the
 *       crashing run too.
 *   R6  subprocesses run ASYNC; the notify stub is a SEPARATE process appending to a file; owned dirs and stores are
 *       removed after confirmed process exit, on every path; S4-N requires real importer runs and a deliberate control.
 *
 * DISPOSITIONS live in the OUTBOX MANIFEST, not the frozen document: a disposition is the room's decision about an entry
 * (#1745), so the document a writer last wrote cannot carry it. The manifest is #1745's columns plus a `note` column
 * (ASSUMED; needed for the required notifyDispositionNote). class ∈ retire-with-proof | dispatch-evidenced |
 * disposed-not-sent.
 *
 * OWED, BY NAME (not hidden by the row count): PendingAnnouncement envelope reconciliation; full/compacted/blocked entry
 * shapes; the complete origin/obligation field set and reservation mirrors beyond RES_TABLE/ORIGIN_TABLE; payload-bound
 * disposition provenance and positive dispatch evidence; omitted-record and frozen-field mutants; a marker whose digest
 * MATCHES but whose data is absent (needs the digest rule pinned); the source capture's identity/epoch/commitSeq/event-input
 * provenance fields (needs their names agreed); the not-READY / ordinary-write refusal after an interrupted run (step 5's
 * READY op must exist to observe it). The U3 map KEYS here are fixture keys, NOT the captured ones: exact original keys
 * belong to the copied-source U3 rehearsal. (S4-J now covers sourceOriginJson / sourceEntryJson under the agreed rule.)
 *
 * INTERFACE THESE ROWS TARGET: the interface v0/v1 on #1747 and the terms in post 46155, plus these ASSUMPTIONS:
 *   CLI   node scripts/cutover-import-1629.mjs --board-data F --executor URL --dataset DS --outbox-manifest CSV
 *              --capture-manifest JSON [--apply]
 *   OUT   first line `MIGRATION <64 hex>`; then exactly one of `COMPLETE`, `INCOMPLETE <id> …`, `HOLD <CODE> …`,
 *         `REFUSED <CODE> …`. Exit 0 only for a clean dry run or COMPLETE.
 *   SEAM  SCRUM_CUTOVER_CRASH_AFTER_APPLY=<batch> (#1747 v22).
 *   MARK  `node scripts/cutover-candidate-1629.mjs --capture-manifest JSON --executor URL` writes the CandidateMarker.
 *   CODES the names in CODES below (one table, so a rename is one edit).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';
import { createGraphClient } from '../core/graph-client.mjs';
import { durableUpdate } from '../core/durable-update.mjs';
import { announcePostId } from '../core/announce-outbox.mjs';
import { postWriteId } from '../core/post-write.mjs';
import { readPostSeqReservation, reserveOpId } from '../core/postseq-reserve.mjs';
import { readCommittedOrigin, readOriginOutcome, readPreparedOrigin } from '../core/origin-commit.mjs';
import { mutationIdOf, originPrepareOp, originCommitOp } from '../core/graph-compiler.mjs';
import { cardQuads, priorQuads, cardIriOf } from '../core/cards-graph.mjs';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';
import { POSTSEQ_TERMS, ORIGIN_TERMS, BOOKKEEPING_GRAPH, POSTSEQ_NS, ORIGIN_NS } from '../core/graph-vocab.mjs';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const IMPORTER = path.join(REPO, 'scripts', 'cutover-import-1629.mjs');
const CANDIDATE_TOOL = path.join(REPO, 'scripts', 'cutover-candidate-1629.mjs');
const CAPTURE_TOOL = path.join(REPO, 'scripts', 'cutover-capture-1629.mjs');
const MIGRATE_COLUMNS = path.join(REPO, 'scripts', 'migrate-columns-1639.mjs');
const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const T = { skip: SKIP, timeout: 300000 };
const DS = 'cut1747';
const BK = BOOKKEEPING_GRAPH;
const EPOCH = '7d2f3a1e-5c4b-4e8a-9f60-1b2c3d4e5f60';   // UUID-shaped, as the live postSeqEpoch is (its value is NOT copied)
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const ENTITY = 'https://scrumboard.local/entity/';
const bare = (t) => String(t).replace(/^<|>$/g, '');
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const shaFile = (f) => sha(fs.readFileSync(f));
const iso = (s) => new Date(Date.UTC(2026, 9, 6, 1, 0, s)).toISOString();

/** CODES the importer must print (ASSUMED names). */
const CODES = {
  NOT_CANDIDATE: 'NOT_CANDIDATE', MARKER_MISSING: 'MARKER_MISSING', MARKER_MISMATCH: 'MARKER_MISMATCH', SOURCE_CHANGED: 'SOURCE_CHANGED',
  UNKNOWN_KEY: 'UNKNOWN_KEY', PENDING_UNDISPOSED: 'PENDING_UNDISPOSED', MANIFEST_MISSING: 'MANIFEST_MISSING', MANIFEST_UNKNOWN: 'MANIFEST_UNKNOWN',
  PROOF_MISMATCH: 'PROOF_MISMATCH', PROOF_MISSING: 'PROOF_MISSING', DISPATCH_UNBOUND: 'DISPATCH_UNBOUND',
  HIGH_WATER: 'HIGH_WATER', DUPLICATE_SEQ: 'DUPLICATE_SEQ', DUPLICATE_ID: 'DUPLICATE_ID', BAD_ALLOCATOR: 'BAD_ALLOCATOR',
  ORPHAN_ENTRY: 'ORPHAN_ENTRY', ORIGIN_WITHOUT_ENTRY: 'ORIGIN_WITHOUT_ENTRY', MODE_DISAGREES: 'MODE_DISAGREES',
  COLUMN_DIFFERS: 'COLUMN_DIFFERS', SEATSTATES_UNPROVEN: 'SEATSTATES_UNPROVEN', CAPTURE_MALFORMED: 'CAPTURE_MALFORMED',
  MANIFEST_DUPLICATE: 'MANIFEST_DUPLICATE', BAD_ID: 'BAD_ID', BAD_ORIGIN: 'BAD_ORIGIN', BAD_ENTRY: 'BAD_ENTRY', BAD_RESERVATION: 'BAD_RESERVATION',
  ENTRY_WITHOUT_SLOT: 'ENTRY_WITHOUT_SLOT', ENTRY_DISAGREES: 'ENTRY_DISAGREES', SUBJECT_OCCUPIED: 'SUBJECT_OCCUPIED',
  ALLOCATOR_PRESENT: 'ALLOCATOR_PRESENT', ALLOCATOR_MISMATCH: 'ALLOCATOR_MISMATCH', MANIFEST_MALFORMED: 'MANIFEST_MALFORMED',
};
/** the batch progress marker: the BUILD's names at 613c8c6 (scripts/cutover-import-1629.mjs BATCH, P_BATCH_DIGEST). The interface
 *  has not pinned them yet (#1747 v32 asks it to); one table, so a rename is one edit. Batch 1 = the allocator + every reservation;
 *  batch 2 = every origin + obligation (the build's boundary, also to be pinned). */
const MARKER = { batch: (id, n) => `urn:ex:cutover/migration/${id}/batch/${n}`, digest: 'urn:ex:cutover/batchDigest' };
/** the terms for source facts (#1747, 46155), in the BK graph. */
const TERMS = {
  legacyKey: `${POSTSEQ_NS}legacyKey`, sourceApplied: `${POSTSEQ_NS}sourceApplied`,
  sourceEntryJson: `${ORIGIN_NS}sourceEntryJson`, sourceOriginJson: `${ORIGIN_NS}sourceOriginJson`,
  retirementReason: `${ORIGIN_NS}retirementReason`, retirementProofPostId: `${ORIGIN_NS}retirementProofPostId`,
  notifyDisposition: `${ORIGIN_NS}notifyDisposition`, notifyDispositionNote: `${ORIGIN_NS}notifyDispositionNote`,
  migrationId: `${ORIGIN_NS}migrationId`,
  sourceReservationJson: `${POSTSEQ_NS}sourceReservationJson`,   // PROPOSED (post 46179), pending the vocabulary review
};

// ── the U3 three: EXACT source records, read from a copy of the live document at 2026-10-25T02:46Z. Fixture copies of the
//    identities only; no live post is replayed (§7). Their map keys are fixture UUIDs, distinct from the postId, as live. ──
const U3 = [
  { key: '0b6f1e8a-3c2d-4e5f-8a9b-0c1d2e3f4a51', postId: 'ffdb288f-8445-5c24-88bc-46f13c2f017b', postSeq: 37790, createdAt: '2026-10-06T21:56:31.948Z' },
  { key: '0b6f1e8a-3c2d-4e5f-8a9b-0c1d2e3f4a52', postId: 'c0ccd5df-a21b-5272-9407-1f4342a30e60', postSeq: 40248, createdAt: '2026-10-10T13:42:40.624Z' },
  { key: '0b6f1e8a-3c2d-4e5f-8a9b-0c1d2e3f4a53', postId: 'f1b9afa8-498a-50e9-b327-0ff31f282866', postSeq: 40249, createdAt: '2026-10-10T13:44:36.750Z' },
];
// ordinary posts that ARE published, each with a real receipt: one reservation stamped applied, one unstamped (the "44 class")
const ORD = [
  { key: '0b6f1e8a-3c2d-4e5f-8a9b-0c1d2e3f4a61', author: 'ada', requestId: 'req-1747-a', postSeq: 38001, createdAt: iso(1), applied: true },
  { key: '0b6f1e8a-3c2d-4e5f-8a9b-0c1d2e3f4a62', author: 'ada', requestId: 'req-1747-b', postSeq: 38002, createdAt: iso(2), applied: undefined },   // flag ABSENT
  { key: '0b6f1e8a-3c2d-4e5f-8a9b-0c1d2e3f4a63', author: 'ada', requestId: 'req-1747-c', postSeq: 38003, createdAt: iso(3), applied: false },       // flag explicitly FALSE (post 46159: absent, false and true stay distinct)
].map((o) => ({ ...o, postId: postWriteId(o.author, o.requestId) }));
const NEXT = 40300;
/** the instant step 2 read the STOPPED source (#1747, post 46282): written by the capture step, never by the importer */
const CAPTURED_AT = '2026-10-25T03:17:00.000Z';   // above every post (≤ 39501), tombstone, and reservation (≤ 40249)

function legacy(i, slot) {
  const mutationId = `0c7a${String(i).padStart(4, '0')}-1747-4a1e-8b2c-${String(i).padStart(12, '0')}`;
  const payload = { author: 'board', body: `ada ${slot}ed #${100 + i}`, mentions: ['ada'], mutationId, notify: true, occurredAt: iso(10 + i), origin: { cardId: `card-${i}`, version: 2 }, originActor: 'ada', slot };
  // the LIVE legacy shape (read 2026-10-25T03:25Z: entry e7cd33de…:claim and its post 9ce2e489…): the post has its OWN id,
  // not announcePostId(mutationId, slot); it carries no originActor and no originOccurredAt; its dateCreated is not the
  // payload's occurredAt. 305 of the live store's 1,433 announcement posts lack both fields: the 305 legacy entries.
  const postId = `9ce0${String(i).padStart(4, '0')}-1747-4c1e-8b2c-${String(i).padStart(12, '0')}`;
  return {
    origin: { committedAt: iso(10 + i), mode: 'legacy', mutationId, occurredAt: iso(10 + i), origin: { cardId: `card-${i}`, version: 2 }, originActor: 'ada', slots: [slot] },
    entry: { legacyPostId: postId, mode: 'legacy', mutationId, obligationId: `${mutationId}:${slot}`, payload, slot, status: 'pending' },
    post: { id: postId, body: payload.body, author: payload.author, origin: { mutationId, slot }, createdAt: iso(8 + i), postSeq: 39000 + i, mentions: payload.mentions },
  };
}
function publisher(i, slot) {
  const mutationId = `0d8b${String(i).padStart(4, '0')}-1747-4b2f-9c3d-${String(i).padStart(12, '0')}`;
  const payload = { author: 'board', body: `grace ${slot}ed #${300 + i}`, mentions: [], mutationId, notify: true, occurredAt: iso(40 + i), origin: { cardId: `card-p${i}`, version: 3 }, originActor: 'grace', slot };
  const postId = announcePostId(mutationId, slot);
  return {
    origin: { committedAt: iso(40 + i), mode: 'publisher', mutationId, occurredAt: iso(40 + i), origin: { cardId: `card-p${i}`, version: 3 }, originActor: 'grace', slots: [slot] },
    entry: { mode: 'publisher', mutationId, obligationId: `${mutationId}:${slot}`, payload, postSeq: 39500 + i, publicationAt: iso(40 + i), slot, status: 'pending' },
    post: { id: postId, body: payload.body, author: payload.author, originActor: payload.originActor, origin: { mutationId, slot }, occurredAt: payload.occurredAt, publicationAt: iso(40 + i), postSeq: 39500 + i, mentions: payload.mentions },
  };
}
const LEGACY = [legacy(1, 'claim'), legacy(2, 'release'), legacy(3, 'claim')];
const PUB = publisher(1, 'claim');
const PUB_NOTE = 'superseded by the room, recorded for #1745';

/** the live document's Column shape (read from board-data.json 2026-10-25T03:05Z), not an invented one */
const COLUMNS = [
  { '@type': 'scrum:Column', '@id': 'https://scrumboard.local/column/backlog', identifier: 'backlog', name: 'Backlog', 'scrum:order': 0 },
  { '@type': 'scrum:Column', '@id': 'https://scrumboard.local/column/done', identifier: 'done', name: 'Done', 'scrum:order': 3 },
];
function validDocument() {
  const res = {};
  for (const u of U3) res[u.key] = { createdAt: u.createdAt, postId: u.postId, postSeq: u.postSeq };   // unreceipted: no applied flag, as live
  for (const o of ORD) res[o.key] = { ...(o.applied !== undefined ? { applied: o.applied } : {}), createdAt: o.createdAt, postId: o.postId, postSeq: o.postSeq };
  const origins = {}, entries = {};
  for (const x of [...LEGACY, PUB]) { origins[x.origin.mutationId] = structuredClone(x.origin); entries[x.entry.obligationId] = structuredClone(x.entry); }
  return {
    _README: 'fixture for #1747 step-4 rows', '@context': {}, _labelAliases: {},
    '@graph': COLUMNS.map((c) => ({ ...c })),
    'scrum:meta': { announcementOutbox: { origins, entries }, lastUpdated: iso(99), nextPostSeq: NEXT, nextShortId: 1631, postReservations: res, postSeqEpoch: EPOCH },
  };
}
/** the valid outbox manifest: #1745's columns + note. Legacy entries retire on their post; the publisher entry is disposed. */
function validManifestRows(doc) {
  return Object.values(doc['scrum:meta'].announcementOutbox.entries).filter((e) => e.status === 'pending').map((e) => ({
    // the live #1745 manifest's form (research/1745/entries.csv, read 03:43Z): kind `mode/slot`, a legacy entry's matchedPostId
    // is its OWN post (legacyPostId), a publisher entry's the derived one
    obligationId: e.obligationId, kind: `${e.mode}/${e.slot}`, createdAt: e.payload.occurredAt, matchedPostId: e.mode === 'legacy' ? e.legacyPostId : announcePostId(e.mutationId, e.slot),
    class: e.mode === 'legacy' ? 'retire-with-proof' : 'disposed-not-sent', note: e.mode === 'legacy' ? '' : PUB_NOTE,
  }));
}
/** RFC 4180: a field holding a comma, quote or newline is quoted, its quotes doubled (a note is free text and may hold a comma) */
const csvField = (v) => { const t = String(v ?? ''); return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
const csv = (rows) => ['obligationId,kind,createdAt,matchedPostId,class,note', ...rows.map((r) => [r.obligationId, r.kind, r.createdAt, r.matchedPostId, r.class, r.note].map(csvField).join(','))].join('\n') + '\n';

// ── R6: the notify stub is its OWN process (a blocked test event loop could never answer it), one line per call ──
const STUB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cut1747-stub-'));
const STUB_LOG = path.join(STUB_DIR, 'calls.log');
const STUB_PORT_FILE = path.join(STUB_DIR, 'port');
const stubProc = spawn(process.execPath, ['-e', `const http=require('http'),fs=require('fs');const s=http.createServer((q,r)=>{fs.appendFileSync(${JSON.stringify(STUB_LOG)},q.method+' '+q.url+'\\n');r.writeHead(204);r.end();});s.listen(0,'127.0.0.1',()=>fs.writeFileSync(${JSON.stringify(STUB_PORT_FILE)},String(s.address().port)));`], { stdio: 'ignore' });
for (let i = 0; i < 100 && !fs.existsSync(STUB_PORT_FILE); i++) await new Promise((r) => setTimeout(r, 50));
const NOTIFY_URL = `http://127.0.0.1:${fs.readFileSync(STUB_PORT_FILE, 'utf8')}/internal/notify`;
const notifyCalls = () => (fs.existsSync(STUB_LOG) ? fs.readFileSync(STUB_LOG, 'utf8').split('\n').filter(Boolean).length : 0);
let importerRuns = 0;
after(() => { stubProc.kill('SIGKILL'); fs.rmSync(STUB_DIR, { recursive: true, force: true }); });

// ── observation (R1, R2) ──
const clientFor = (x) => createGraphClient({ baseUrl: x.baseUrl, expectedDatasetId: DS, timeoutMs: 60000 });
const health = async (x) => (await fetch(`${x.baseUrl}/health`)).json();
const term = (b) => (b ? `${b.type}|${b.value}|${b.datatype ?? ''}|${b['xml:lang'] ?? ''}` : '-');
/** S(x): every quad of every graph, typed, canonical, sorted. Compared byte for byte. */
async function S(x) {
  const r = await clientFor(x).query('SELECT ?g ?s ?p ?o WHERE { { ?s ?p ?o } UNION { GRAPH ?g { ?s ?p ?o } } }');
  assert.ok(r.ok, `CONTROL: the snapshot query answered (${r.reason ?? ''})`);
  assert.ok(r.rows.length > 0, 'CONTROL: the snapshot is not empty (an empty one makes every comparison pass)');
  return r.rows.map((b) => [b.g, b.s, b.p, b.o].map(term).join(' ')).sort().join('\n');
}
/** the TYPED values of one `SELECT ?v`: [{value, datatype}], never the bare lexical form alone */
async function typed(x, sparql) {
  const r = await clientFor(x).query(sparql);
  assert.ok(r.ok, `the read-back query answered (${r.reason ?? ''})`);
  return r.rows.map((b) => { const dt = b.v?.datatype ?? null; return { type: b.v?.type ?? null, value: dt === `${XSD}dateTime` ? instant(b.v?.value) : b.v?.value, datatype: dt, lang: b.v?.['xml:lang'] ?? null }; });
}
/** an xsd:dateTime as its INSTANT: the store canonicalises the lexical form (post 46179); the exact form is checked in the source JSON */
function instant(v) { const t = Date.parse(v); return Number.isFinite(t) ? `instant ${t}` : `UNPARSEABLE ${v}`; }
const LIT = (value, datatype) => [{ type: 'literal', value, datatype, lang: null }];
const INT = (n) => LIT(String(n), `${XSD}integer`);
const DT = (s) => LIT(instant(s), `${XSD}dateTime`);
const STR = (s) => LIT(s, null);
const BOOL = (b) => LIT(String(b), `${XSD}boolean`);
/** the agreed canonical JSON (#1747 v32), written here independently of the importer: object keys sorted recursively
 *  (JS default string order), array order and every scalar exactly as given, one JSON.stringify; unsupported values throw */
function canon(v) {
  const walk = (x) => {
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object') return Object.fromEntries(Object.keys(x).sort().map((k) => [k, walk(x[k])]));
    if (x === null || typeof x === 'string' || typeof x === 'boolean' || (typeof x === 'number' && Number.isFinite(x))) return x;
    throw new TypeError(`canon: unsupported value ${String(x)}`);
  };
  return JSON.stringify(walk(v));
}
/** the complete typed state of the source's posts and their receipts, compared exactly before and after (R2, R3).
 *  A receipt's subject is the intention's opId: urn:ex:op/announce/<mutationId>/<slot> for an announcement post,
 *  urn:ex:op/post/<postId> for an ordinary one (the opIds world() seeds them under). It does not contain the postId for
 *  an announcement, so receipts are read by their exact opId, never by a substring of the post id. */
async function postsAndReceipts(x, posts) {
  const out = {};
  for (const { id, opId } of posts) {
    out[`post ${id}`] = (await clientFor(x).query(`SELECT ?p ?o WHERE { <${ENTITY}${id}> ?p ?o }`)).rows.map((b) => `${b.p.value} ${term(b.o)}`).sort();
    out[`receipt ${opId}`] = (await clientFor(x).query(`SELECT ?p ?o WHERE { GRAPH <${BK}> { <${opId}> ?p ?o } }`)).rows.map((b) => `${b.p.value} ${term(b.o)}`).sort();
  }
  return out;
}
/** the SOURCE→TARGET table (R2/R4), typed. Each row: [target field, query for one source record, the exact expected value]. */
const RES = (r) => bare(POSTSEQ_TERMS.reservation(r.postId));
const RES_TABLE = [
  ['postId', (r) => `SELECT ?v WHERE { GRAPH <${BK}> { <${RES(r)}> ${POSTSEQ_TERMS.postId} ?v } }`, (r) => STR(r.postId)],
  ['postSeq', (r) => `SELECT ?v WHERE { GRAPH <${BK}> { <${RES(r)}> ${POSTSEQ_TERMS.postSeq} ?v } }`, (r) => INT(r.postSeq)],
  ['createdAt', (r) => `SELECT ?v WHERE { GRAPH <${BK}> { <${RES(r)}> ${POSTSEQ_TERMS.createdAt} ?v } }`, (r) => DT(r.createdAt)],
  ['legacyKey', (r) => `SELECT ?v WHERE { GRAPH <${BK}> { <${RES(r)}> <${TERMS.legacyKey}> ?v } }`, (r) => STR(r.key)],
  // the applied flag is a SOURCE FACT: present as captured, absent stays absent (no stamp fabricated from an independent receipt)
  ['sourceApplied', (r) => `SELECT ?v WHERE { GRAPH <${BK}> { <${RES(r)}> <${TERMS.sourceApplied}> ?v } }`, (r) => (r.applied === undefined ? [] : BOOL(r.applied))],   // absent → no triple; false → false; true → true
];
const ORI = (x) => ORIGIN_TERMS.originSubject(x.origin.mutationId);
const OBL = (x) => ORIGIN_TERMS.obligationSubject(x.entry.mutationId, x.entry.slot);
const ORIGIN_TABLE = [
  ['origin.mode', (x) => `SELECT ?v WHERE { GRAPH <${BK}> { ${ORI(x)} ${ORIGIN_TERMS.mode} ?v } }`, (x) => STR(x.origin.mode)],
  ['origin.originActor', (x) => `SELECT ?v WHERE { GRAPH <${BK}> { ${ORI(x)} ${ORIGIN_TERMS.originActor} ?v } }`, (x) => STR(x.origin.originActor)],
  ['origin.occurredAt', (x) => `SELECT ?v WHERE { GRAPH <${BK}> { ${ORI(x)} ${ORIGIN_TERMS.occurredAt} ?v } }`, (x) => DT(x.origin.occurredAt)],
  ['origin.committedAt', (x) => `SELECT ?v WHERE { GRAPH <${BK}> { ${ORI(x)} ${ORIGIN_TERMS.committedAt} ?v } }`, (x) => DT(x.origin.committedAt)],
  ['obligation.obligationId', (x) => `SELECT ?v WHERE { GRAPH <${BK}> { ${OBL(x)} ${ORIGIN_TERMS.obligationId} ?v } }`, (x) => STR(x.entry.obligationId)],
  ['obligation.mode', (x) => `SELECT ?v WHERE { GRAPH <${BK}> { ${OBL(x)} ${ORIGIN_TERMS.mode} ?v } }`, (x) => STR(x.entry.mode)],
  ['obligation.status', (x) => `SELECT ?v WHERE { GRAPH <${BK}> { ${OBL(x)} ${ORIGIN_TERMS.status} ?v } }`, () => STR('published')],
  ['obligation.retirementReason', (x) => `SELECT ?v WHERE { GRAPH <${BK}> { ${OBL(x)} <${TERMS.retirementReason}> ?v } }`, (x) => STR(x.entry.mode === 'legacy' ? 'legacy-post-verified' : 'publisher-dispatch-disposed')],
  ['obligation.retirementProofPostId', (x) => `SELECT ?v WHERE { GRAPH <${BK}> { ${OBL(x)} <${TERMS.retirementProofPostId}> ?v } }`, (x) => STR(x.post.id)],
  ['obligation.notifyDisposition', (x) => `SELECT ?v WHERE { GRAPH <${BK}> { ${OBL(x)} <${TERMS.notifyDisposition}> ?v } }`, (x) => (x.entry.mode === 'legacy' ? [] : STR('disposed-not-sent'))],
  ['obligation.notifyDispositionNote', (x) => `SELECT ?v WHERE { GRAPH <${BK}> { ${OBL(x)} <${TERMS.notifyDispositionNote}> ?v } }`, (x) => (x.entry.mode === 'legacy' ? [] : STR(PUB_NOTE))],
];

// ── the world (R1: whole BEFORE sealing; R6: owned files removed after confirmed exits) ──
async function rawInsert(x, triples, tag) {
  const ep = (await health(x)).epoch;
  const r = await fetch(`${x.baseUrl}/update`, { method: 'POST', headers: { 'x-op-id': `urn:ex:op/test/cut1747-${tag}-${process.pid}-${Date.now()}`, 'x-epoch': String(ep) }, body: `INSERT DATA { GRAPH <${BK}> { ${triples} } }` });
  assert.ok(r.ok, `CONTROL: the fixture insert ${tag} applied (${r.status} ${(await r.text()).slice(0, 160)})`);
}
async function apply(x, intention, what) { const r = await durableUpdate(clientFor(x), intention); assert.equal(r.outcome, 'APPLIED', `CONTROL: ${what} (${JSON.stringify(r).slice(0, 200)})`); }
/** a LEGACY post, as the document path wrote it: post.write with an origin {mutationId, slot} and no originActor/occurredAt */
const legacyOp = (p) => `urn:ex:op/post/${p.id}`;
const seedLegacy = (x, p) => apply(x, { kind: 'post.write', opId: legacyOp(p), actor: `https://scrumboard.local/person/${p.author}`, post: { id: p.id, author: p.author, createdAt: p.createdAt, postSeq: p.postSeq, body: p.body, attachedTo: null, mentions: [...p.mentions], attachments: [], conversation: null, onBehalfOf: null, origin: { mutationId: p.origin.mutationId, slot: p.origin.slot } } }, `legacy post ${p.id} seeded`);
const seedAnnounce = (x, p) => apply(x, { kind: 'post.create', opId: `urn:ex:op/announce/${p.origin.mutationId}/${p.origin.slot}`, actor: 'https://scrumboard.local/person/board', post: p }, `announcement post ${p.id} seeded`);
const seedOrdinary = (x, o) => apply(x, { kind: 'post.write', opId: `urn:ex:op/post/${o.postId}`, actor: `https://scrumboard.local/person/${o.author}`, post: { id: o.postId, author: o.author, createdAt: o.createdAt, postSeq: o.postSeq, body: `ordinary ${o.requestId}`, attachedTo: null, mentions: [], attachments: [], conversation: null, onBehalfOf: null } }, `ordinary post ${o.postId} seeded`);
const run = (args, env) => new Promise((resolve) => {   // R6: async, so nothing in this process is blocked while it runs
  const p = spawn(process.execPath, args, { env: { ...process.env, SCRUM_MCP_NOTIFY_URL: NOTIFY_URL, ...env } });
  let out = '', err = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  const timer = setTimeout(() => p.kill('SIGKILL'), 240000);
  p.on('close', (status, signal) => { clearTimeout(timer); resolve({ status, signal, out, err }); });
});

/**
 * Build one world. Before sealing: `prepare(doc)` shapes the document, `manifest(rows)` shapes the outbox manifest, and
 * `plant(candidate)` adds candidate state; `extraSourcePosts` are seeded in the source. After sealing: `afterSeal(w)` (the
 * stale-capture row only). The valid world is every call with none of these.
 */
async function world(body, { prepare = () => {}, manifest = (rows) => rows, manifestText = (t) => t, plant = async () => {}, extraSourcePosts = [], mark = true, afterSeal = null, capture = (c) => c } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cut1747-'));
  const srcStore = tmpStore('cut1747-src-');
  let src = null, cand = null;
  try {
    src = await startExecutor({ store: srcStore, datasetId: DS, create: true });
    // the columns, as the columns unit stores them: written by the real migration from the VALID document (a row's prepare()
    // edits only the document under test, so a column row still sees the difference it plants)
    const seedDoc = path.join(dir, 'seed-columns.json'); fs.writeFileSync(seedDoc, JSON.stringify(validDocument(), null, 2));
    const mc = await run([MIGRATE_COLUMNS, '--board-data', seedDoc, '--executor', src.baseUrl, '--dataset', DS, '--apply'], {});
    assert.equal(mc.status, 0, `CONTROL: migrate-columns-1639 wrote the source's columns (exit ${mc.status}: ${(mc.err || mc.out).slice(-300)})`);
    fs.rmSync(seedDoc);
    for (const x of LEGACY) await seedLegacy(src, x.post);
    await seedAnnounce(src, PUB.post);
    for (const o of ORD) await seedOrdinary(src, o);
    for (const p of extraSourcePosts) await seedLegacy(src, p);
    const srcHealth = await health(src);   // r8: the stopped source's LAST /health, as step 1 saves it for the capture tool
    await killExecutor(src); src = null;
    const candStore = path.join(dir, 'candidate-store');
    fs.cpSync(srcStore, candStore, { recursive: true });
    cand = await startExecutor({ store: candStore, datasetId: DS, extraArgs: ['--promote-epoch'] });
    const hs = await health(cand);
    assert.equal(hs.datasetId, DS, 'CONTROL: the promoted candidate keeps datasetId (the supported path)');
    assert.ok(hs.incarnationFrom && hs.incarnation && hs.incarnation !== hs.incarnationFrom, 'CONTROL: a new incarnation, naming the one it came from');
    await plant(cand);
    const doc = validDocument(); prepare(doc);
    const docFile = path.join(dir, 'board-data.json'); fs.writeFileSync(docFile, JSON.stringify(doc, null, 2));
    const outboxManifest = path.join(dir, 'entries.csv'); fs.writeFileSync(outboxManifest, manifestText(csv(manifest(validManifestRows(doc)))));
    const files = fs.readdirSync(srcStore).sort().map((n) => { const b = fs.readFileSync(path.join(srcStore, n)); return { name: n, size: b.length, sha256: sha(b) }; });
    const captureManifest = path.join(dir, 'capture.json');
    fs.writeFileSync(captureManifest, JSON.stringify(capture({ sourceStore: fs.realpathSync(srcStore), files, documentSha256: shaFile(docFile), outboxManifestSha256: shaFile(outboxManifest), datasetId: DS, incarnation: hs.incarnationFrom, capturedAt: CAPTURED_AT }), null, 2));
    if (mark) {
      const m = await run([CANDIDATE_TOOL, '--capture-manifest', captureManifest, '--executor', cand.baseUrl], {});
      assert.equal(m.status, 0, `the step-3 tool wrote the CandidateMarker (exit ${m.status}: ${(m.err || m.out).slice(-300)})`);
    }
    const w = { dir, srcStore, cand, docFile, outboxManifest, captureManifest, doc, srcHealth };
    if (afterSeal) await afterSeal(w);
    return await body(w);
  } finally {
    if (src) await killExecutor(src);
    if (cand) await killExecutor(cand);
    fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(srcStore, { recursive: true, force: true });
  }
}

/** one importer run: it must have RUN (its own MIGRATION line) and left the document byte-identical (S4-W). */
async function importer(w, { applyIt = false, env = {}, capture = w.captureManifest, executor = w.cand.baseUrl } = {}) {
  const before = shaFile(w.docFile);
  const r = await run([IMPORTER, '--board-data', w.docFile, '--executor', executor, '--dataset', DS, '--outbox-manifest', w.outboxManifest, '--capture-manifest', capture, ...(applyIt ? ['--apply'] : [])], env);
  const id = r.out.match(/^MIGRATION ([0-9a-f]{64})$/m)?.[1] ?? null;
  assert.ok(id, `the importer RAN and printed its MIGRATION line (exit ${r.status} ${r.signal ?? ''}; out ${r.out.slice(0, 200)}; err ${r.err.slice(-300)})`);
  importerRuns++;
  assert.equal(shaFile(w.docFile), before, 'S4-W: the document is byte-identical after the run');
  return { ...r, id, complete: /^COMPLETE$/m.test(r.out), code: r.out.match(/^(?:REFUSED|HOLD) ([A-Z_]+)/m)?.[1] ?? null, kind: r.out.match(/^(REFUSED|HOLD) /m)?.[1] ?? null };
}
const expectCode = (r, kind, code, ctx) => { assert.equal(r.kind, kind, `${ctx}: a ${kind} (${r.out.slice(-240)})`); assert.equal(r.code, code, `${ctx}: exactly ${code}`); assert.ok(!r.complete, `${ctx}: never COMPLETE`); assert.notEqual(r.status, 0); };
const ALL_POSTS = [...LEGACY.map((x) => ({ id: x.post.id, opId: legacyOp(x.post) })), { id: PUB.post.id, opId: `urn:ex:op/announce/${PUB.post.origin.mutationId}/${PUB.post.origin.slot}` }, ...ORD.map((o) => ({ id: o.postId, opId: `urn:ex:op/post/${o.postId}` }))];
const FIELDS = async (x) => {
  const o = {};
  for (const rec of [...U3, ...ORD]) for (const [f, q] of RES_TABLE) o[`${rec.postId} ${f}`] = await typed(x, q(rec));
  for (const e of [...LEGACY, PUB]) for (const [f, q] of ORIGIN_TABLE) o[`${e.entry.obligationId} ${f}`] = await typed(x, q(e));
  return o;
};

// ── the rows ──

test('#1747 (HARNESS) the candidate holds the source posts and receipts, S is non-empty and stable, and no allocator exists yet', T, async () => {
  await world(async (w) => {
    const a = await S(w.cand); assert.equal(await S(w.cand), a, 'two snapshots of an idle candidate are byte-identical');
    for (const [k, v] of Object.entries(await postsAndReceipts(w.cand, ALL_POSTS))) assert.ok(v.length > 0, `CONTROL: ${k} is present and readable before any import`);
    assert.deepEqual(await typed(w.cand, `SELECT ?v WHERE { GRAPH <${BK}> { ${POSTSEQ_TERMS.allocator} ${POSTSEQ_TERMS.nextPostSeq} ?v } }`), [], 'no allocator before the import');
    for (const c of COLUMNS) {   // a valid world must not HOLD for a reason the fixture made (post 46179)
      assert.deepEqual(await typed(w.cand, `SELECT ?v WHERE { <${c['@id']}> <https://schema.org/identifier> ?v }`), STR(c.identifier), `CONTROL: column ${c.identifier} is in the candidate, by id`);
      assert.deepEqual(await typed(w.cand, `SELECT ?v WHERE { <${c['@id']}> <https://schema.org/name> ?v }`), STR(c.name), `CONTROL: column ${c.identifier}: name exactly`);
      assert.deepEqual(await typed(w.cand, `SELECT ?v WHERE { <${c['@id']}> <https://scrumboard.local/ns#order> ?v }`), INT(c['scrum:order']), `CONTROL: column ${c.identifier}: order, xsd:integer, exactly`);
    }
  }, { mark: false });
});

test('#1747 (HARNESS) the out-of-process notify stub counts a deliberate call (so S4-N can fail)', async () => {
  const before = notifyCalls();
  await fetch(NOTIFY_URL, { method: 'POST', body: '{}' });
  assert.equal(notifyCalls(), before + 1, 'the call is counted');
});

test('#1747 (PRE) the importer and the step-3 candidate tool exist', () => {
  assert.ok(fs.existsSync(IMPORTER), 'scripts/cutover-import-1629.mjs exists (built against these rows)');
  assert.ok(fs.existsSync(CANDIDATE_TOOL), 'scripts/cutover-candidate-1629.mjs exists (ASSUMED step-3 tool)');
});

test('#1747 (S4-0) a dry run writes nothing, and its MIGRATION id is stable for the same inputs', T, async () => {
  await world(async (w) => {
    const s0 = await S(w.cand);
    const a = await importer(w); assert.equal(a.status, 0, `a dry run exits 0 (${a.out.slice(-200)})`);
    const b = await importer(w); assert.equal(b.id, a.id, 'the same inputs give the same MIGRATION id');
    assert.equal(await S(w.cand), s0, 'a dry run left the candidate byte-identical');
  });
});

test('#1747 (S4-B) binding: the true candidate passes; the SOURCE store as target → NOT_CANDIDATE', T, async () => {
  await world(async (w) => {
    const ok = await importer(w); assert.equal(ok.status, 0, `CONTROL: the true candidate passes (${ok.out.slice(-200)})`);
    const src = await startExecutor({ store: w.srcStore, datasetId: DS });
    try { expectCode(await importer(w, { executor: src.baseUrl }), 'REFUSED', CODES.NOT_CANDIDATE, 'the source store as target'); } finally { await killExecutor(src); }
  });
});
test('#1747 (S4-B) binding: no CandidateMarker → MARKER_MISSING', T, async () => {
  await world(async (w) => expectCode(await importer(w), 'REFUSED', CODES.MARKER_MISSING, 'no marker'), { mark: false });
});
test('#1747 (S4-B) binding: the marker names another capture manifest → MARKER_MISMATCH', T, async () => {
  await world(async (w) => {
    const other = path.join(w.dir, 'other-capture.json');
    // r7: a WELL-FORMED foreign manifest (the closed schema refuses `files: []` first): only its bytes differ, so only the marker can refuse it
    const mine = JSON.parse(fs.readFileSync(w.captureManifest, 'utf8'));
    fs.writeFileSync(other, JSON.stringify({ ...mine, capturedAt: new Date(Date.parse(mine.capturedAt) - 1000).toISOString() }));
    expectCode(await importer(w, { capture: other }), 'REFUSED', CODES.MARKER_MISMATCH, 'a foreign manifest');
  });
});
test('#1747 (S4-B) binding: a source store file changed after sealing → SOURCE_CHANGED, never COMPLETE', T, async () => {
  await world(async (w) => expectCode(await importer(w, { applyIt: true }), 'REFUSED', CODES.SOURCE_CHANGED, 'a changed source'),
    { afterSeal: (w) => { const f = fs.readdirSync(w.srcStore).sort()[0]; fs.appendFileSync(path.join(w.srcStore, f), 'x'); } });
});

test('#1747 (S4-A1) the allocator is the document\'s nextPostSeq and epoch EXACTLY (typed); posts and receipts exactly preserved', T, async () => {
  await world(async (w) => {
    const pr0 = await postsAndReceipts(w.cand, ALL_POSTS);
    const r = await importer(w, { applyIt: true }); assert.ok(r.complete, `COMPLETE (${r.out.slice(-300)})`);
    assert.deepEqual(await typed(w.cand, `SELECT ?v WHERE { GRAPH <${BK}> { ${POSTSEQ_TERMS.allocator} ${POSTSEQ_TERMS.nextPostSeq} ?v } }`), INT(NEXT), 'nextPostSeq, xsd:integer, exactly');
    assert.deepEqual(await typed(w.cand, `SELECT ?v WHERE { GRAPH <${BK}> { ${POSTSEQ_TERMS.allocator} ${POSTSEQ_TERMS.postSeqEpoch} ?v } }`), STR(EPOCH), 'postSeqEpoch, exactly');
    assert.deepEqual(await postsAndReceipts(w.cand, ALL_POSTS), pr0, 'every source post and receipt exactly preserved: nothing minted, nothing restamped');
  });
});

const TOMB = legacy(41, 'claim');
for (const [pop, opts] of [
  ['a post', { extraSourcePosts: [{ ...legacy(40, 'claim').post, postSeq: NEXT }] }],
  ['a tombstone', { plant: async (c) => { await seedLegacy(c, { ...TOMB.post, postSeq: NEXT + 1 }); await apply(c, { kind: 'post.redact', opId: 'urn:ex:op/test/redact-1747', actor: 'https://scrumboard.local/person/ada', post: { id: TOMB.post.id }, authorityRef: 'urn:ex:test/1747', occurredAt: iso(91) }, 'the planted post is redacted to a tombstone'); } }],
  ['a reservation', { plant: (c) => rawInsert(c, `${POSTSEQ_TERMS.reservation('planted-1747')} a ${POSTSEQ_TERMS.Reservation} ; ${POSTSEQ_TERMS.postId} "planted-1747" ; ${POSTSEQ_TERMS.postSeq} "${NEXT + 2}"^^<${XSD}integer> .`, 'plant-res') }],
]) {
  test(`#1747 (S4-A2) ${pop} at or above nextPostSeq → HOLD ${CODES.HIGH_WATER}; nothing written`, T, async () => {
    await world(async (w) => {
      const s0 = await S(w.cand);
      expectCode(await importer(w, { applyIt: true }), 'HOLD', CODES.HIGH_WATER, pop);
      assert.equal(await S(w.cand), s0, 'nothing written: S byte-identical');
    }, opts);
  });
}

test('#1747 (S4-M) every source record reads back through the typed SOURCE→TARGET tables, the exact U3 three included', T, async () => {
  await world(async (w) => {
    const r = await importer(w, { applyIt: true }); assert.ok(r.complete, `COMPLETE (${r.out.slice(-300)})`);
    for (const rec of [...U3, ...ORD]) for (const [field, q, want] of RES_TABLE) assert.deepEqual(await typed(w.cand, q(rec)), want(rec), `reservation ${rec.postId}: ${field}, typed, exactly`);
    for (const e of [...LEGACY, PUB]) for (const [field, q, want] of ORIGIN_TABLE) assert.deepEqual(await typed(w.cand, q(e)), want(e), `${e.entry.obligationId}: ${field}, typed, exactly`);
    const mid = r.id;
    for (const rec of [...U3, ...ORD]) assert.deepEqual(await typed(w.cand, `SELECT ?v WHERE { GRAPH <${BK}> { <${RES(rec)}> <${TERMS.migrationId}> ?v } }`), STR(mid), `${rec.postId}: tagged with this MIGRATION id`);
  });
});

test('#1747 (S4-J) the exact source JSON of every reservation, origin and entry is kept, canonical, and keeps the exact U3 lexical times', T, async () => {
  await world(async (w) => {
    const r = await importer(w, { applyIt: true }); assert.ok(r.complete, `COMPLETE (${r.out.slice(-300)})`);
    const meta = w.doc['scrum:meta'];
    for (const rec of [...U3, ...ORD]) {
      // the {legacyKey: record} wrapping is the build's proposal (post 46179); the canonical rule is the agreed one
      const want = canon({ [rec.key]: meta.postReservations[rec.key] });
      assert.deepEqual(await typed(w.cand, `SELECT ?v WHERE { GRAPH <${BK}> { <${RES(rec)}> <${TERMS.sourceReservationJson}> ?v } }`), STR(want), `reservation ${rec.postId}: sourceReservationJson, exactly`);
    }
    for (const u of U3) assert.ok(canon({ [u.key]: meta.postReservations[u.key] }).includes(`"createdAt":${JSON.stringify(u.createdAt)}`), `CONTROL: U3 ${u.postId}'s expected JSON carries the exact lexical ${u.createdAt}`);
    for (const x of [...LEGACY, PUB]) {
      assert.deepEqual(await typed(w.cand, `SELECT ?v WHERE { GRAPH <${BK}> { ${ORI(x)} <${TERMS.sourceOriginJson}> ?v } }`), STR(canon(meta.announcementOutbox.origins[x.origin.mutationId])), `${x.origin.mutationId}: sourceOriginJson, exactly`);
      assert.deepEqual(await typed(w.cand, `SELECT ?v WHERE { GRAPH <${BK}> { ${OBL(x)} <${TERMS.sourceEntryJson}> ?v } }`), STR(canon(meta.announcementOutbox.entries[x.entry.obligationId])), `${x.entry.obligationId}: sourceEntryJson, exactly`);
    }
  });
});

const H = [
  ['a duplicate postSeq across two reservations', CODES.DUPLICATE_SEQ, (d) => { d['scrum:meta'].postReservations['0b6f1e8a-3c2d-4e5f-8a9b-0c1d2e3f4a99'] = { createdAt: iso(5), postId: 'e1e1e1e1-0000-5000-8000-000000000099', postSeq: U3[0].postSeq }; }],
  ['a duplicate postId under two keys', CODES.DUPLICATE_ID, (d) => { d['scrum:meta'].postReservations['0b6f1e8a-3c2d-4e5f-8a9b-0c1d2e3f4a98'] = { createdAt: iso(6), postId: U3[1].postId, postSeq: 40299 }; }],
  ['a string nextPostSeq', CODES.BAD_ALLOCATOR, (d) => { d['scrum:meta'].nextPostSeq = String(NEXT); }],
  ['an unsafe-integer nextPostSeq', CODES.BAD_ALLOCATOR, (d) => { d['scrum:meta'].nextPostSeq = 2 ** 53; }],
  ['a missing postSeqEpoch', CODES.BAD_ALLOCATOR, (d) => { delete d['scrum:meta'].postSeqEpoch; }],
  ['an orphan entry (no origin)', CODES.ORPHAN_ENTRY, (d) => { delete d['scrum:meta'].announcementOutbox.origins[LEGACY[0].origin.mutationId]; }],
  ['an origin without its entry', CODES.ORIGIN_WITHOUT_ENTRY, (d) => { delete d['scrum:meta'].announcementOutbox.entries[LEGACY[1].entry.obligationId]; }],
  ['an entry whose mode disagrees with its origin', CODES.MODE_DISAGREES, (d) => { d['scrum:meta'].announcementOutbox.entries[LEGACY[2].entry.obligationId].mode = 'publisher'; }],
];
for (const [what, code, fault] of H) {
  test(`#1747 (S4-H) ${what} → HOLD ${code}; nothing written`, T, async () => {
    await world(async (w) => {
      const s0 = await S(w.cand);
      expectCode(await importer(w, { applyIt: true }), 'HOLD', code, what);
      assert.equal(await S(w.cand), s0, 'nothing written: S byte-identical');
    }, { prepare: fault });
  });
}

// R2 remainder (#1747 v45, source findings at 97ffd43): the owner map must also see the candidate's BOOKKEEPING reservations
// (identity AND number) and the publisher assignments with no graph post. Control: the valid world (S4-M COMPLETE).
const PUB2 = publisher(2, 'claim');
for (const [what, code, opts] of [
  ['a BOOKKEEPING reservation of ANOTHER identity at a U3 number', 'DUPLICATE_SEQ', { plant: (c) => rawInsert(c, `${POSTSEQ_TERMS.reservation('bk-other-1747')} a ${POSTSEQ_TERMS.Reservation} ; ${POSTSEQ_TERMS.postId} "bk-other-1747" ; ${POSTSEQ_TERMS.postSeq} "${U3[0].postSeq}"^^<${XSD}integer> .`, 'bk-dup-seq') }],
  ['a BOOKKEEPING reservation of a U3 identity at ANOTHER number', 'ID_SEQ_MISMATCH', { plant: (c) => rawInsert(c, `${POSTSEQ_TERMS.reservation(U3[0].postId)} a ${POSTSEQ_TERMS.Reservation} ; ${POSTSEQ_TERMS.postId} "${U3[0].postId}" ; ${POSTSEQ_TERMS.postSeq} "${U3[0].postSeq + 3}"^^<${XSD}integer> .`, 'bk-id-mismatch') }],
  // a BLOCKED publisher entry (not pending, so no manifest row and no proof join) holding a number above next, with no post
  ['a BLOCKED publisher assignment above nextPostSeq with no graph post', 'HIGH_WATER', {
    prepare: (d) => { const ob = d['scrum:meta'].announcementOutbox; ob.origins[PUB2.origin.mutationId] = structuredClone(PUB2.origin); ob.entries[PUB2.entry.obligationId] = { ...structuredClone(PUB2.entry), status: 'blocked', postSeq: NEXT + 3 }; },
  }],
]) {
  test(`#1747 (S4-H2) ${what} → HOLD ${code}; nothing written`, T, async () => {
    await world(async (w) => {
      const s0 = await S(w.cand);
      expectCode(await importer(w, { applyIt: true }), 'HOLD', code, what);
      assert.equal(await S(w.cand), s0, 'nothing written: S byte-identical');
    }, opts);
  });
}

// C1: one negative per PROOF field against a legacy entry whose post exists. Control: the valid world (S4-M retires it).
// a legacy post carries no originActor/originOccurredAt (live shape, above), so those two are proof fields of the PUBLISHER
// entry only (post 46220); the valid world's legacy posts have a dateCreated unequal to the payload's occurredAt, and retire.
const PROOF = {
  body: (e) => { e.payload.body += ' (differs)'; }, author: (e) => { e.payload.author = 'gizmo'; }, mentions: (e) => { e.payload.mentions = ['grace']; },
  originMutation: (e) => { e.payload.mutationId = LEGACY[1].origin.mutationId; }, slot: (e) => { e.payload.slot = 'release'; },
  legacyPostId: (e) => { e.legacyPostId = LEGACY[1].post.id; },
};
// r7: the entry AND its origin change together, so the pre-write ENTRY_DISAGREES check passes and the POST is what disagrees
const PUB_PROOF = {
  originActor: (e, o) => { e.payload.originActor = 'gizmo'; o.originActor = 'gizmo'; },
  occurredAt: (e, o) => { e.payload.occurredAt = iso(77); o.occurredAt = iso(77); },
  body: (e) => { e.payload.body += ' (differs)'; },
};
const pubOf = (d) => [d['scrum:meta'].announcementOutbox.entries[PUB.entry.obligationId], d['scrum:meta'].announcementOutbox.origins[PUB.origin.mutationId]];
for (const [field, mutate] of Object.entries(PUB_PROOF)) {
  test(`#1747 (S4-C1) the PUBLISHER entry whose post differs ONLY in ${field} → REFUSED ${CODES.PROOF_MISMATCH}`, T, async () => {
    await world(async (w) => expectCode(await importer(w, { applyIt: true }), 'REFUSED', CODES.PROOF_MISMATCH, `publisher ${field}`),
      { prepare: (d) => mutate(...pubOf(d)) });
  });
}
// r7 (review of PR #122, finding 5): a publisher entry whose payload disagrees with its OWN origin is a HOLD before anything is written
for (const [field, mutate] of Object.entries({ originActor: (e) => { e.payload.originActor = 'gizmo'; }, occurredAt: (e) => { e.payload.occurredAt = iso(77); } })) {
  test(`#1747 (S4-H, r7) a publisher entry whose payload ${field} disagrees with its origin → HOLD ${CODES.ENTRY_DISAGREES}; nothing written`, T, async () => {
    await world(async (w) => {
      const s0 = await S(w.cand);
      expectCode(await importer(w, { applyIt: true }), 'HOLD', CODES.ENTRY_DISAGREES, `payload ${field}`);
      assert.equal(await S(w.cand), s0, 'nothing written: S byte-identical');
    }, { prepare: (d) => mutate(pubOf(d)[0]) });
  });
}
test('#1747 (HARNESS) the seeded legacy posts have the LIVE shape: their own id, no originActor, no originOccurredAt', T, async () => {
  await world(async (w) => {
    for (const x of LEGACY) {
      assert.notEqual(x.post.id, announcePostId(x.origin.mutationId, x.entry.slot), 'the legacy post id is not the derived one');
      const ps = (await clientFor(w.cand).query(`SELECT ?p WHERE { <${ENTITY}${x.post.id}> ?p ?o }`)).rows.map((b) => b.p.value);
      assert.ok(ps.length > 0, `CONTROL: legacy post ${x.post.id} is in the candidate`);
      assert.ok(!ps.some((p) => /originActor$|originOccurredAt$/.test(p)), `legacy post ${x.post.id} carries neither originActor nor originOccurredAt (${ps.join(' ')})`);
    }
  }, { mark: false });
});
for (const [field, mutate] of Object.entries(PROOF)) {
  test(`#1747 (S4-C1) a legacy entry whose post differs ONLY in ${field} → REFUSED ${CODES.PROOF_MISMATCH}`, T, async () => {
    await world(async (w) => expectCode(await importer(w, { applyIt: true }), 'REFUSED', CODES.PROOF_MISMATCH, field),
      { prepare: (d) => mutate(d['scrum:meta'].announcementOutbox.entries[LEGACY[0].entry.obligationId]) });
  });
}
test(`#1747 (S4-C1) a legacy entry whose post is MISSING → REFUSED ${CODES.PROOF_MISSING}`, T, async () => {
  const extra = legacy(7, 'claim');   // its post is never seeded
  await world(async (w) => expectCode(await importer(w, { applyIt: true }), 'REFUSED', CODES.PROOF_MISSING, 'missing proof post'),
    { prepare: (d) => { d['scrum:meta'].announcementOutbox.origins[extra.origin.mutationId] = extra.origin; d['scrum:meta'].announcementOutbox.entries[extra.entry.obligationId] = extra.entry; } });
});
test(`#1747 (S4-C2/S4-D) the publisher entry with NO disposition → REFUSED ${CODES.PENDING_UNDISPOSED} although its post exists; nothing written`, T, async () => {
  await world(async (w) => {
    const s0 = await S(w.cand);
    expectCode(await importer(w, { applyIt: true }), 'REFUSED', CODES.PENDING_UNDISPOSED, 'no disposition');
    assert.equal(await S(w.cand), s0, 'nothing written');
  }, { manifest: (rows) => rows.map((r) => (r.kind.startsWith('publisher') ? { ...r, class: '', note: '' } : r)) });
});
test(`#1747 (S4-C2) "dispatch-evidenced" with no dispatch evidence bound to THIS obligation → REFUSED ${CODES.DISPATCH_UNBOUND}`, T, async () => {
  await world(async (w) => expectCode(await importer(w, { applyIt: true }), 'REFUSED', CODES.DISPATCH_UNBOUND, 'unbound dispatch claim'),
    { manifest: (rows) => rows.map((r) => (r.kind.startsWith('publisher') ? { ...r, class: 'dispatch-evidenced', note: '' } : r)) });
});
test(`#1747 (S4-C3) a pending entry absent from the manifest → REFUSED ${CODES.MANIFEST_MISSING}`, T, async () => {
  await world(async (w) => expectCode(await importer(w, { applyIt: true }), 'REFUSED', CODES.MANIFEST_MISSING, 'entry not in manifest'),
    { manifest: (rows) => rows.filter((r) => r.obligationId !== LEGACY[2].entry.obligationId) });
});
test(`#1747 (S4-C3) a manifest row naming no pending entry → REFUSED ${CODES.MANIFEST_UNKNOWN}`, T, async () => {
  await world(async (w) => expectCode(await importer(w, { applyIt: true }), 'REFUSED', CODES.MANIFEST_UNKNOWN, 'unknown manifest row'),
    { manifest: (rows) => [...rows, { obligationId: '0e9c0000-1747-4c3a-8d4e-000000000000:claim', kind: 'legacy', createdAt: iso(3), matchedPostId: 'f0f0f0f0-0000-5000-8000-000000000000', class: 'retire-with-proof', note: '' }] });
});
test(`#1747 (S4-C3) a manifest row with MORE fields than the header (an unquoted comma) → REFUSED ${CODES.MANIFEST_MALFORMED}; nothing written`, T, async () => {
  // the valid world's note holds a comma, quoted (S4-M reads it back whole); here the same row is written UNquoted, so it has 7 fields
  assert.ok(csv(validManifestRows(validDocument())).includes(`"${PUB_NOTE}"`), 'PRECONDITION: the VALID manifest quotes the publisher note');
  await world(async (w) => {
    assert.ok(!fs.readFileSync(w.outboxManifest, 'utf8').includes(`"${PUB_NOTE}"`), 'PRECONDITION: this world\'s manifest holds the note UNquoted');
    const s0 = await S(w.cand);
    expectCode(await importer(w, { applyIt: true }), 'REFUSED', CODES.MANIFEST_MALFORMED, 'a 7-field row');
    assert.equal(await S(w.cand), s0, 'nothing written: S byte-identical');
  }, { manifestText: (text) => text.replace(`"${PUB_NOTE}"`, PUB_NOTE) });
});
test(`#1747 (S4-K) an unknown scrum:meta key → REFUSED ${CODES.UNKNOWN_KEY}`, T, async () => {
  await world(async (w) => expectCode(await importer(w, { applyIt: true }), 'REFUSED', CODES.UNKNOWN_KEY, 'unknown key'), { prepare: (d) => { d['scrum:meta'].somethingNew = 1; } });
});
for (const [field, edit] of [['name', (c) => { c.name = 'Backlog (edited)'; }], ['order', (c) => { c['scrum:order'] = 7; }]]) {
  // control: the valid world, whose columns the HARNESS row shows equal, COMPLETEs (S4-M). Only this one field differs.
  test(`#1747 (S4-F) a document Column whose ${field} differs from the candidate's → HOLD ${CODES.COLUMN_DIFFERS}; nothing written`, T, async () => {
    await world(async (w) => {
      const s0 = await S(w.cand);
      expectCode(await importer(w, { applyIt: true }), 'HOLD', CODES.COLUMN_DIFFERS, `column ${field}`);
      assert.equal(await S(w.cand), s0, 'nothing written: S byte-identical');
    }, { prepare: (d) => edit(d['@graph'][0]) });
  });
}
// ── seatStates (post 46279, reshaped 46281, field named 46282). The importer may RETIRE an item only when it is a well-formed
// SeatDeclaration whose expiresAt is strictly before the capture's capturedAt, keeping its canonical JSON in the migration's
// marker; anything else HOLDs. ⚠️ Expiry replacing post 46076's "nothing reads it" is the contract reviewer's to accept; the
// S4-G6 row is that condition's own evidence. The item copies the LIVE shape and times (read 2026-10-25T04:52Z), seat renamed.
const SEAT = (over = {}) => ({ '@id': 'https://scrumboard.local/seat-state/ada', '@type': 'scrum:SeatDeclaration', 'scrum:seat': 'ada', 'scrum:mode': 'resting', 'scrum:acceptsRoutineWork': false, 'scrum:note': 'a fixture declaration', 'scrum:declaredAt': '2026-09-02T13:13:04.715Z', 'scrum:expiresAt': '2026-09-02T15:08:47.011Z', ...over });
const withSeats = (...items) => (d) => { d['scrum:meta'].seatStates = items; };
test('#1747 (S4-G0) an EXPIRED declaration (the live shape) is RETIRED: COMPLETE, the plan says retired=1, and its canonical JSON is kept in the migration\'s records', T, async () => {
  await world(async (w) => {
    const dry = await importer(w); assert.equal(dry.status, 0, `a clean dry run (${dry.out.slice(-200)})`);
    assert.match(dry.out, /seatStates retired=1\b/, 'the plan names the retirement');
    const r = await importer(w, { applyIt: true }); assert.ok(r.complete, `COMPLETE (${r.out.slice(-300)})`);
    const kept = (await clientFor(w.cand).query(`SELECT ?s ?o WHERE { GRAPH <${BK}> { ?s ?p ?o } FILTER(STRSTARTS(STR(?s), "urn:ex:cutover/migration/${r.id}")) FILTER(STR(?o) = ${JSON.stringify(canon(SEAT()))}) }`)).rows;
    assert.ok(kept.length >= 1, 'LOSSLESS: the retired item\'s canonical JSON is stored under this migration (not a count or hash alone)');
    const s1 = await S(w.cand);
    assert.ok((await importer(w, { applyIt: true })).complete, 'a replay reports COMPLETE');
    assert.equal(await S(w.cand), s1, 'and is a no-op');
  }, { prepare: withSeats(SEAT()) });
});
for (const [what, items] of [
  ['a LIVE declaration (expiresAt after capturedAt)', [SEAT({ 'scrum:expiresAt': '2026-10-26T00:00:00.000Z' })]],
  ['expiresAt EXACTLY capturedAt (strict)', [SEAT({ 'scrum:expiresAt': CAPTURED_AT })]],
  ['a missing expiresAt', [(() => { const x = SEAT(); delete x['scrum:expiresAt']; return x; })()]],
  ['an unparseable expiresAt', [SEAT({ 'scrum:expiresAt': 'yesterday' })]],
  ['declaredAt AFTER expiresAt', [SEAT({ 'scrum:declaredAt': '2026-09-03T00:00:00.000Z' })]],
  ['one live and one expired (all or nothing)', [SEAT(), SEAT({ '@id': 'https://scrumboard.local/seat-state/grace', 'scrum:seat': 'grace', 'scrum:expiresAt': '2026-10-26T00:00:00.000Z' })]],
  ['an item of another type', [SEAT({ '@type': 'scrum:Something' })]],
]) {
  test(`#1747 (S4-G1) seatStates with ${what} → HOLD ${CODES.SEATSTATES_UNPROVEN}; nothing written`, T, async () => {
    await world(async (w) => {
      const s0 = await S(w.cand);
      expectCode(await importer(w, { applyIt: true }), 'HOLD', CODES.SEATSTATES_UNPROVEN, what);
      assert.equal(await S(w.cand), s0, 'nothing written');
    }, { prepare: withSeats(...items) });
  });
}
test(`#1747 (S4-G2) a capture manifest with NO capturedAt → REFUSED ${CODES.CAPTURE_MALFORMED}; and an unparseable one too`, T, async () => {
  for (const [what, cap] of [['absent', (c) => { const x = { ...c }; delete x.capturedAt; return x; }], ['unparseable', (c) => ({ ...c, capturedAt: 'not a time' })]]) {
    await world(async (w) => {
      // r7: one closed schema for both tools, so step 3 refuses this capture as well and never marks the candidate
      const m = await run([CANDIDATE_TOOL, '--capture-manifest', w.captureManifest, '--executor', w.cand.baseUrl], {});
      assert.ok(m.status !== 0 && /^REFUSED CAPTURE_MALFORMED/m.test(m.out), `step 3 refuses capturedAt ${what} (exit ${m.status}: ${m.out.slice(-200)})`);
      expectCode(await importer(w, { applyIt: true }), 'REFUSED', CODES.CAPTURE_MALFORMED, `capturedAt ${what}`);
    }, { prepare: withSeats(SEAT()), capture: cap, mark: false });
  }
});
test('#1747 (S4-G6) the board does not READ a document seatStates row: changing it leaves GET /api/seats/state\'s seats identical (post 46076)', T, async () => {
  const seatsWith = async (item) => {
    const rest = await startRestServer({ board: makeBoardFixture({ cards: [], conversations: [], seatStates: [item] }) });
    try {
      const r = await fetch(`${rest.baseUrl}/api/seats/state`); assert.equal(r.status, 200, 'the seat-state route answers');
      const j = await r.json();
      return { seats: j.seats, legacyRows: j.legacyRows };
    } finally { await rest.stop(); }
  };
  const a = await seatsWith(SEAT());
  const b = await seatsWith(SEAT({ 'scrum:mode': 'available', 'scrum:acceptsRoutineWork': true, 'scrum:expiresAt': '2099-01-01T00:00:00.000Z' }));
  assert.equal(a.legacyRows, 1, 'CONTROL: the document row is there (it is counted)');
  assert.ok(Array.isArray(a.seats), 'CONTROL: the route lists seats');
  assert.deepEqual(b.seats, a.seats, 'a LIVE, available row in the document changes no seat the board reports: the row is not read');
});
test('#1747 (S4-R) a replay after COMPLETE is byte-identical; a reservation tampered after COMPLETE → INCOMPLETE naming it', T, async () => {
  await world(async (w) => {
    const r = await importer(w, { applyIt: true }); assert.ok(r.complete, `CONTROL: COMPLETE (${r.out.slice(-300)})`);
    const s1 = await S(w.cand);
    const again = await importer(w, { applyIt: true }); assert.ok(again.complete, 'a replay reports COMPLETE');
    assert.equal(await S(w.cand), s1, 'the replay left S byte-identical');
    await rawInsert(w.cand, `${POSTSEQ_TERMS.reservation(U3[0].postId)} ${POSTSEQ_TERMS.createdAt} "2026-01-01T00:00:00.000Z"^^<${XSD}dateTime> .`, 'tamper');
    const t = await importer(w, { applyIt: true });
    assert.ok(!t.complete && /^INCOMPLETE /m.test(t.out) && t.out.includes(U3[0].postId), `a tampered record → INCOMPLETE naming it (${t.out.slice(-300)})`);
  });
});
test('#1747 (S4-R) a crash after batch 1: the batch is durable and partial before the rerun; the rerun matches a clean run\'s imported fields exactly', T, async () => {
  let clean = null;
  await world(async (w) => { const r = await importer(w, { applyIt: true }); assert.ok(r.complete, 'CONTROL: the clean run completes'); clean = await FIELDS(w.cand); });
  await world(async (w) => {
    const before = shaFile(w.docFile);
    const c = await run([IMPORTER, '--board-data', w.docFile, '--executor', w.cand.baseUrl, '--dataset', DS, '--outbox-manifest', w.outboxManifest, '--capture-manifest', w.captureManifest, '--apply'], { SCRUM_CUTOVER_CRASH_AFTER_APPLY: '1' });
    assert.ok(/^MIGRATION [0-9a-f]{64}$/m.test(c.out), `the crashing run RAN (${c.out.slice(0, 200)})`); importerRuns++;
    assert.equal(c.signal, 'SIGKILL', `the seam killed it after batch 1 (signal ${c.signal}, exit ${c.status})`);
    assert.equal(shaFile(w.docFile), before, 'the crashing run left the document byte-identical');
    const id = c.out.match(/^MIGRATION ([0-9a-f]{64})$/m)[1];
    const marker = async (n) => (await typed(w.cand, `SELECT ?v WHERE { GRAPH <${BK}> { <${MARKER.batch(id, n)}> <${MARKER.digest}> ?v } }`));
    const m1 = await marker(1);
    assert.equal(m1.length, 1, `batch 1's marker is DURABLE, exactly once (${JSON.stringify(m1)})`);
    assert.match(m1[0].value, /^[0-9a-f]{64}$/, 'its digest is a sha256');
    assert.deepEqual(await marker(2), [], 'batch 2 has NO marker: the crash came before it');
    // batch 1's EXACT records are all there, beside their marker
    assert.deepEqual(await typed(w.cand, `SELECT ?v WHERE { GRAPH <${BK}> { ${POSTSEQ_TERMS.allocator} ${POSTSEQ_TERMS.nextPostSeq} ?v } }`), INT(NEXT), 'batch 1: the allocator, exactly');
    for (const rec of [...U3, ...ORD]) for (const [field, q, want] of RES_TABLE) assert.deepEqual(await typed(w.cand, q(rec)), want(rec), `batch 1: reservation ${rec.postId} ${field}, exactly`);
    // and NOTHING of batch 2: no partial data without its marker
    for (const x of [...LEGACY, PUB]) {
      assert.deepEqual(await typed(w.cand, `SELECT ?v WHERE { GRAPH <${BK}> { ${ORI(x)} ?p ?v } }`), [], `batch 2 absent: origin ${x.origin.mutationId}`);
      assert.deepEqual(await typed(w.cand, `SELECT ?v WHERE { GRAPH <${BK}> { ${OBL(x)} ?p ?v } }`), [], `batch 2 absent: obligation ${x.entry.obligationId}`);
    }
    const mid = await FIELDS(w.cand);
    assert.ok(Object.entries(mid).some(([k, v]) => JSON.stringify(v) !== JSON.stringify(clean[k])), 'and the import is PARTIAL: not everything is there yet');
    const r = await importer(w, { applyIt: true }); assert.ok(r.complete, `the rerun completes (${r.out.slice(-300)})`);
    assert.deepEqual(await FIELDS(w.cand), clean, 'every imported frozen field equals the clean run\'s exactly (no duplicate, no gap)');
    assert.equal((await marker(1)).length, 1, 'still exactly one batch-1 marker after the rerun');
    assert.equal((await marker(2)).length, 1, 'and exactly one batch-2 marker');
  });
});

// ── continuation and allocator controls (the accepted plan, post 46076 point 3; dropped from r2's rows, #1747 v32) ──
const allocatorTriples = (next, mig) => `${POSTSEQ_TERMS.allocator} a ${POSTSEQ_TERMS.Allocator} ; ${POSTSEQ_TERMS.postSeqEpoch} "${EPOCH}" ; ${POSTSEQ_TERMS.nextPostSeq} "${next}"^^<${XSD}integer> ; ${POSTSEQ_TERMS.version} "1"^^<${XSD}integer>${mig ? ` ; <${TERMS.migrationId}> "${mig}"` : ''} .`;
test(`#1747 (S4-P) an allocator NO migration wrote → REFUSED ${CODES.ALLOCATOR_PRESENT}; nothing written`, T, async () => {
  await world(async (w) => {
    const s0 = await S(w.cand);
    expectCode(await importer(w, { applyIt: true }), 'REFUSED', CODES.ALLOCATOR_PRESENT, 'an unrelated allocator');
    assert.equal(await S(w.cand), s0, 'nothing written: S byte-identical');
  }, { plant: (c) => rawInsert(c, allocatorTriples(NEXT), 'unrelated-allocator') });
});
test(`#1747 (S4-P) an allocator under THIS migration's id with a DIFFERENT value → REFUSED ${CODES.ALLOCATOR_MISMATCH}; nothing written`, T, async () => {
  await world(async (w) => {
    const dry = await importer(w); assert.equal(dry.status, 0, `CONTROL: the dry run is clean (${dry.out.slice(-200)})`);
    await rawInsert(w.cand, allocatorTriples(NEXT + 5, dry.id), 'same-mig-allocator');
    const s0 = await S(w.cand);
    expectCode(await importer(w, { applyIt: true }), 'REFUSED', CODES.ALLOCATOR_MISMATCH, 'a same-migration allocator with another value');
    assert.equal(await S(w.cand), s0, 'nothing written: S byte-identical');
  });
});
test('#1747 (S4-P) a batch marker planted for THIS migration with a foreign digest, and no data → never COMPLETE, and no allocator written', T, async () => {
  await world(async (w) => {
    const dry = await importer(w); assert.equal(dry.status, 0, `CONTROL: the dry run is clean (${dry.out.slice(-200)})`);
    await rawInsert(w.cand, `<${MARKER.batch(dry.id, 1)}> <${MARKER.digest}> "${'0'.repeat(64)}" .`, 'foreign-marker');
    const r = await importer(w, { applyIt: true });
    assert.ok(!r.complete && /^(REFUSED|INCOMPLETE) /m.test(r.out), `a marker without its data is not progress (${r.out.slice(-240)})`);
    assert.deepEqual(await typed(w.cand, `SELECT ?v WHERE { GRAPH <${BK}> { ${POSTSEQ_TERMS.allocator} ${POSTSEQ_TERMS.nextPostSeq} ?v } }`), [], 'no allocator was written under a forged marker');
  });
});
test('#1747 (S4-P) after a crash, a rerun with a CHANGED input (another outbox manifest) is REFUSED and writes nothing; it never continues the other migration', T, async () => {
  await world(async (w) => {
    const c = await run([IMPORTER, '--board-data', w.docFile, '--executor', w.cand.baseUrl, '--dataset', DS, '--outbox-manifest', w.outboxManifest, '--capture-manifest', w.captureManifest, '--apply'], { SCRUM_CUTOVER_CRASH_AFTER_APPLY: '1' });
    assert.equal(c.signal, 'SIGKILL', `PRECONDITION: the seam killed the first run after batch 1 (signal ${c.signal})`); importerRuns++;
    fs.writeFileSync(w.outboxManifest, `${fs.readFileSync(w.outboxManifest, 'utf8')}\n`);   // another input: another MIGRATION id
    const s0 = await S(w.cand);
    const r = await importer(w, { applyIt: true });
    assert.equal(r.kind, 'REFUSED', `a changed input after a partial migration is refused (${r.out.slice(-240)})`);
    assert.ok(!r.complete, 'never COMPLETE');
    assert.equal(await S(w.cand), s0, 'nothing written: S byte-identical');
  });
});

// ── R1: the RUNTIME readers of imported records, against the reader interface v2 FROZEN on #1747 (v50, accepted 46271) ──
// After COMPLETE the board's own readers and public paths must recognise an imported record strictly; every path that would need
// what the source never had (an intention, a Prepared node, a draft) refuses BY NAME; nothing is fabricated; no number, post or
// notification moves. Names from v2 §3: `kind`, outcome 'imported', LEGACY_HOLD (409), IMPORTED_SETTLED.
const R1 = { KIND: 'imported', OUTCOME: 'imported', LEGACY_HOLD: 'LEGACY_HOLD', IMPORTED_SETTLED: 'IMPORTED_SETTLED' };
/** an UNPUBLISHED U3-shaped reservation whose identity the fixture KNOWS, so its retry can go through the real post route */
const U3X = { key: '0b6f1e8a-3c2d-4e5f-8a9b-0c1d2e3f4a70', author: 'ada', requestId: 'req-1747-u3x', postSeq: 38010, createdAt: '2026-10-06T21:56:31.948Z' };
U3X.postId = postWriteId(U3X.author, U3X.requestId);
const addU3X = (d) => { d['scrum:meta'].postReservations[U3X.key] = { createdAt: U3X.createdAt, postId: U3X.postId, postSeq: U3X.postSeq }; };
/** a BLOCKED publisher entry (v2 open question (i), ruled: allowed), not pending, below next, no post */
const PUB3 = publisher(3, 'claim');
const addBlocked = (d) => { const ob = d['scrum:meta'].announcementOutbox; ob.origins[PUB3.origin.mutationId] = structuredClone(PUB3.origin); ob.entries[PUB3.entry.obligationId] = { ...structuredClone(PUB3.entry), status: 'blocked', postSeq: 39503 }; };
const both = (...fs_) => (d) => { for (const f of fs_) f(d); };
async function imported(body, opts = {}) {
  await world(async (w) => {
    const r = await importer(w, { applyIt: true });
    assert.ok(r.complete, `CONTROL: COMPLETE (${r.out.slice(-300)})`);
    await body(w, r.id);
  }, opts);
}
const rawOn = async (x, sparql, tag) => {
  const ep = (await health(x)).epoch;
  const u = await fetch(`${x.baseUrl}/update`, { method: 'POST', headers: { 'x-op-id': `urn:ex:op/test/r1-${tag}-${process.pid}-${Date.now()}`, 'x-epoch': String(ep) }, body: sparql });
  assert.ok(u.ok, `CONTROL: the ${tag} mutant applied (${u.status} ${(await u.text()).slice(0, 160)})`);
};
const isInvalid = (got) => got && got.ok === false && got.status === 'INVALID';

test('#1747 (R1-a) readPostSeqReservation reads every imported reservation as kind imported, its mirrors equal to the source, nothing fabricated', T, async () => {
  await imported(async (w, mig) => {
    for (const rec of [...U3, ...ORD, U3X]) {
      const got = await readPostSeqReservation(clientFor(w.cand), rec.postId);
      assert.equal(got.ok, true, `${rec.postId}: the board's reader accepts it (${got.status ?? ''} ${got.reason ?? ''})`);
      const v = got.reservation;
      assert.deepEqual([v.kind, v.postId, v.postSeq, v.legacyKey, v.migrationId], [R1.KIND, rec.postId, rec.postSeq, rec.key, mig], `${rec.postId}: kind, identity, number, key, migration`);
      assert.equal(Date.parse(v.createdAt), Date.parse(rec.createdAt), `${rec.postId}: createdAt, the same instant`);
      assert.equal(v.sourceApplied, typeof rec.applied === 'boolean' ? rec.applied : null, `${rec.postId}: applied true / false / absent stay distinct`);
      for (const f of ['draft', 'identity', 'reserveOpId', 'reserveDigest', 'index']) assert.ok(v[f] == null, `${rec.postId}: no ${f} is fabricated`);
    }
  }, { prepare: addU3X });
});

const RS_ = (id) => POSTSEQ_TERMS.reservation(id);
const RES_MUTANTS = [
  ['its postSeq changed', (s) => `DELETE { GRAPH <${BK}> { ${s} ${POSTSEQ_TERMS.postSeq} ?v } } INSERT { GRAPH <${BK}> { ${s} ${POSTSEQ_TERMS.postSeq} "${U3[0].postSeq + 1}"^^<${XSD}integer> } } WHERE { GRAPH <${BK}> { ${s} ${POSTSEQ_TERMS.postSeq} ?v } }`],
  ['its createdAt changed', (s) => `DELETE { GRAPH <${BK}> { ${s} ${POSTSEQ_TERMS.createdAt} ?v } } INSERT { GRAPH <${BK}> { ${s} ${POSTSEQ_TERMS.createdAt} "2026-01-01T00:00:00Z"^^<${XSD}dateTime> } } WHERE { GRAPH <${BK}> { ${s} ${POSTSEQ_TERMS.createdAt} ?v } }`],
  ['its legacyKey removed', (s) => `DELETE WHERE { GRAPH <${BK}> { ${s} <${TERMS.legacyKey}> ?v } }`],
  ['its sourceReservationJson removed', (s) => `DELETE WHERE { GRAPH <${BK}> { ${s} <${TERMS.sourceReservationJson}> ?v } }`],
  ['its migrationId removed', (s) => `DELETE WHERE { GRAPH <${BK}> { ${s} <${TERMS.migrationId}> ?v } }`],
  ['a second postSeq', (s) => `INSERT DATA { GRAPH <${BK}> { ${s} ${POSTSEQ_TERMS.postSeq} "${U3[0].postSeq + 7}"^^<${XSD}integer> } }`],
  ['an EXTRA key in its source JSON', (s) => `DELETE { GRAPH <${BK}> { ${s} <${TERMS.sourceReservationJson}> ?v } } INSERT { GRAPH <${BK}> { ${s} <${TERMS.sourceReservationJson}> ${JSON.stringify(canon({ [U3[0].key]: { createdAt: U3[0].createdAt, extra: 1, postId: U3[0].postId, postSeq: U3[0].postSeq } }))} } } WHERE { GRAPH <${BK}> { ${s} <${TERMS.sourceReservationJson}> ?v } }`],
  ['a NATIVE field added (postseq:mode)', (s) => `INSERT DATA { GRAPH <${BK}> { ${s} ${POSTSEQ_TERMS.mode} "ordinary" } }`],
];
for (const [what, sparql] of RES_MUTANTS) {
  test(`#1747 (R1-b) an imported reservation with ${what} → the reader answers INVALID, never a coerced record`, T, async () => {
    await imported(async (w) => {
      const ok0 = await readPostSeqReservation(clientFor(w.cand), U3[0].postId);
      assert.equal(ok0.ok, true, `CONTROL: before the mutant it reads ok (${ok0.reason ?? ''})`);
      await rawOn(w.cand, sparql(RS_(U3[0].postId)), 'r1b');
      const got = await readPostSeqReservation(clientFor(w.cand), U3[0].postId);
      assert.ok(isInvalid(got), `${what}: INVALID (${JSON.stringify(got).slice(0, 200)})`);
    });
  });
}

test('#1747 (R1-c) readCommittedOrigin reads every imported origin as kind imported, its SOURCE mode kept, its stored statuses; readOriginOutcome answers imported', T, async () => {
  await imported(async (w) => {
    for (const x of [...LEGACY, PUB]) {
      const got = await readCommittedOrigin(clientFor(w.cand), x.origin.mutationId);
      assert.equal(got.ok, true, `${x.origin.mutationId}: accepted (${got.status ?? ''} ${got.reason ?? ''})`);
      assert.equal(got.committed?.kind, R1.KIND, `${x.origin.mutationId}: kind imported, on the existing {ok, committed} shape`);
      assert.equal(got.committed?.origin?.mode, x.origin.mode, `${x.origin.mutationId}: the SOURCE mode (${x.origin.mode}), not rewritten`);
      assert.deepEqual(got.committed?.obligations?.map((b) => b.status), ['published'], `${x.origin.mutationId}: its stored status`);
      const oc = await readOriginOutcome(clientFor(w.cand), x.origin.mutationId);
      assert.deepEqual([oc.ok, oc.outcome], [true, R1.OUTCOME], `${x.origin.mutationId}: the outcome reader answers imported, never unprepared (${JSON.stringify(oc).slice(0, 160)})`);
    }
  });
});

const ORI_MUTANTS = [
  ['its sourceOriginJson removed', (x) => `DELETE WHERE { GRAPH <${BK}> { ${ORI(x)} <${TERMS.sourceOriginJson}> ?v } }`],
  ['a Prepared node beside it', (x) => `INSERT DATA { GRAPH <${BK}> { <urn:ex:origin/prepared/${x.origin.mutationId}> a <urn:ex:origin/Prepared> ; <urn:ex:origin/mutationId> "${x.origin.mutationId}" } }`],
  ['its obligation stored as pending', (x) => `DELETE { GRAPH <${BK}> { ${OBL(x)} ${ORIGIN_TERMS.status} ?v } } INSERT { GRAPH <${BK}> { ${OBL(x)} ${ORIGIN_TERMS.status} "pending" } } WHERE { GRAPH <${BK}> { ${OBL(x)} ${ORIGIN_TERMS.status} ?v } }`],
  ['its mode rewritten', (x) => `DELETE { GRAPH <${BK}> { ${ORI(x)} ${ORIGIN_TERMS.mode} ?v } } INSERT { GRAPH <${BK}> { ${ORI(x)} ${ORIGIN_TERMS.mode} "publisher" } } WHERE { GRAPH <${BK}> { ${ORI(x)} ${ORIGIN_TERMS.mode} ?v } }`],
];
for (const [what, sparql] of ORI_MUTANTS) {
  test(`#1747 (R1-c) an imported LEGACY origin with ${what} → readCommittedOrigin answers INVALID`, T, async () => {
    await imported(async (w) => {
      const x = LEGACY[0];
      assert.equal((await readCommittedOrigin(clientFor(w.cand), x.origin.mutationId)).ok, true, 'CONTROL: before the mutant it reads ok');
      await rawOn(w.cand, sparql(x), 'r1c');
      const got = await readCommittedOrigin(clientFor(w.cand), x.origin.mutationId);
      assert.ok(isInvalid(got), `${what}: INVALID (${JSON.stringify(got).slice(0, 200)})`);
    });
  });
}

/** a NATIVE claim origin on the candidate, through the real compiler: a card, then origin.prepare and its commit */
const CX = { id: 'card-x1747', shortId: 9, title: 'card 9', description: 'body', column: 'backlog', createdAt: '2026-10-20T06:00:00.000Z', createdBy: 'ada', version: 1 };
const cpartX = (c, expectedVersion, prior = null) => ({ iri: cardIriOf(c.id), expectedVersion, version: String(c.version), quads: cardQuads(c, new Map()), ...(prior ? { prior: priorQuads(prior, new Map()) } : {}), json: JSON.stringify(c) });
function claimOriginX(requestKey) {
  const mid = mutationIdOf(JSON.stringify(['origin-v1', 'claim', CX.id, requestKey, 'ada']));
  const after = { ...CX, version: 2, claimedBy: 'ada' };
  return { mid, descriptor: { route: 'claim', subject: CX.id, requestKey, originActor: 'ada', mutationId: mid, provenance: { cardId: CX.id, version: 2 }, slots: [{ slot: 'claim', author: 'board', body: 'ada claimed #9', mentions: [], notify: true }] }, plan: { parts: [cpartX(after, '1', CX)] } };
}
const ADA = 'https://scrumboard.local/person/ada';
async function seedCardX(c) { assert.equal((await c.update({ kind: 'card.write', opId: `urn:ex:op/card/r1-seed-${process.pid}-${Date.now()}`, actor: ADA, parts: [cpartX(CX, null)] })).outcome, 'APPLIED', 'PRECONDITION: card x seeded'); }
async function prepareAndCommit(c, o) {
  const p = await c.update({ kind: 'origin.prepare', opId: originPrepareOp(o.mid), actor: ADA, origin: o.descriptor, plan: o.plan });
  if (p.outcome !== 'APPLIED') return { prep: p };
  const P = await readPreparedOrigin(c, o.mid);
  const k = await c.update({ kind: 'card.write', opId: originCommitOp(o.mid), actor: ADA, ...o.plan, origin: { ...o.descriptor, occurredAt: P.prepared.occurredAt } });
  return { prep: p, commit: k };
}
test('#1747 (R1-e) the overlap rule from the NATIVE side: a native committed origin reads kind native; given a migrationId it is INVALID', T, async () => {
  await imported(async (w) => {
    const c = clientFor(w.cand); await seedCardX(c);
    const o = claimOriginX('rk-1747-native');
    const r = await prepareAndCommit(c, o);
    assert.equal(r.commit?.outcome, 'APPLIED', `CONTROL: a native origin commits on the imported candidate (${JSON.stringify(r).slice(0, 200)})`);
    const ok0 = await readCommittedOrigin(c, o.mid);
    assert.equal(ok0.committed?.kind, 'native', `CONTROL: it reads kind native (${JSON.stringify(ok0).slice(0, 160)})`);
    await rawOn(w.cand, `INSERT DATA { GRAPH <${BK}> { ${ORIGIN_TERMS.originSubject(o.mid)} <${TERMS.migrationId}> "forged" } }`, 'r1e');
    assert.ok(isInvalid(await readCommittedOrigin(c, o.mid)), 'a native origin carrying migrationId is INVALID, never read as imported');
  });
});

test(`#1747 (R1-i) a prepare whose mutationId is an IMPORTED origin's is refused before anything is written; the same shape under another key applies`, T, async () => {
  const col = claimOriginX('rk-1747-collide');
  const addCollide = (d) => {   // an imported, settled publisher origin AT the mid a real claim key derives
    const ob = d['scrum:meta'].announcementOutbox;
    ob.origins[col.mid] = { committedAt: iso(60), mode: 'publisher', mutationId: col.mid, occurredAt: iso(60), origin: { cardId: CX.id, version: 2 }, originActor: 'ada', slots: ['claim'] };
    ob.entries[`${col.mid}:claim`] = { mode: 'publisher', mutationId: col.mid, obligationId: `${col.mid}:claim`, payload: { author: 'board', body: 'ada claimed #9', mentions: [], mutationId: col.mid, notify: true, occurredAt: iso(60), origin: { cardId: CX.id, version: 2 }, originActor: 'ada', slot: 'claim' }, postSeq: 39504, postId: announcePostId(col.mid, 'claim'), publicationAt: iso(60), slot: 'claim', status: 'published' };   // r7: every live published publisher entry names its post (1,123/1,123)
  };
  await imported(async (w) => {
    const c = clientFor(w.cand); await seedCardX(c);
    const ctl = await prepareAndCommit(c, claimOriginX('rk-1747-other'));
    assert.equal(ctl.prep.outcome, 'APPLIED', `CONTROL: the same shape under another key prepares (${JSON.stringify(ctl.prep).slice(0, 160)})`);
    const s0 = await S(w.cand);
    const r = await c.update({ kind: 'origin.prepare', opId: originPrepareOp(col.mid), actor: ADA, origin: col.descriptor, plan: claimOriginX('rk-1747-collide').plan });
    assert.ok(r.outcome === 'PRECONDITION_FAILED' || r.outcome === 'REJECTED', `refused (${JSON.stringify(r).slice(0, 200)})`);
    assert.equal((await readPreparedOrigin(c, col.mid)).prepared, null, 'no Prepared node was written at the imported mid');
    const after_ = (await S(w.cand)).split('\n').filter((l) => !l.includes('urn:ex:op/') && !l.includes('urn:ex:commitSeq'));
    assert.deepEqual(after_, s0.split('\n').filter((l) => !l.includes('urn:ex:op/') && !l.includes('urn:ex:commitSeq')), 'nothing but the refusal\'s own receipt was written');
  }, { prepare: addCollide });
});

/** REST on the candidate after COMPLETE, document mode OFF (the post-cutover runtime). `notify` routes REST's dispatches to the
 *  counting stub (R1-g); otherwise nowhere, so a native post here cannot move S4-N. */
async function restOn(w, { notify = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cut1747-rest-'));
  const boardFile = path.join(dir, 'board.json'); fs.writeFileSync(boardFile, '{}'); fs.chmodSync(boardFile, 0o000);
  const roster = path.join(dir, 'roster.json'); fs.writeFileSync(roster, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
  const rest = await startRestServer({ boardFile, mcpNotifyUrl: notify ? NOTIFY_URL : '', env: { SCRUM_GRAPH_DATASET_ID: DS, SCRUM_GRAPH_EXECUTOR_URL: w.cand.baseUrl, SCRUM_ROSTER_FILE: roster, SCRUM_BOARD_DOCUMENT: 'off', SCRUM_GRAPH_UNIT_CARDS: '1', SCRUM_GRAPH_UNIT_COLUMNS: '1', SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_UNIT_LOGBORN: '1', SCRUM_GRAPH_UNIT_SMALLKINDS: '1', SCRUM_GRAPH_UNIT_DELIVERIES: '1', SCRUM_GRAPH_QUERY_SOURCE: 'executor', SCRUM_GRAPH_READY_SOURCE: 'executor', SCRUM_GRAPH_CHECKS_SOURCE: 'executor', SCRUM_GRAPH_NEIGHBORS_SOURCE: 'executor' } });
  const call = async (method, route, payload) => { const x = await fetch(`${rest.baseUrl}${route}`, { method, ...(payload ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) } : {}) }); const t = await x.text(); let j = null; try { j = JSON.parse(t); } catch { /* not json */ } return { status: x.status, text: t, json: j }; };
  return { base: rest.baseUrl, call, stop: async () => { await rest.stop().catch(() => {}); try { fs.chmodSync(boardFile, 0o644); } catch { /* gone */ } fs.rmSync(dir, { recursive: true, force: true }); } };
}
const allocNext = async (x) => (await typed(x, `SELECT ?v WHERE { GRAPH <${BK}> { ${POSTSEQ_TERMS.allocator} ${POSTSEQ_TERMS.nextPostSeq} ?v } }`));
const outboxOf = async (s) => { const r = await s.call('GET', '/api/outbox'); assert.equal(r.status, 200, `GET /api/outbox answered (${r.status} ${r.text.slice(0, 160)})`); return r.json; };

test('#1747 (R1-f) through the PUBLIC post route: a published reservation REPLAYS its original number; an unpublished one is 409 LEGACY_HOLD; a new post takes exactly nextPostSeq', T, async () => {
  await imported(async (w) => {
    const s = await restOn(w);
    try {
      const o = ORD[0];
      const rp = await s.call('POST', '/api/conversations', { body: `ordinary ${o.requestId}`, author: o.author, requestId: o.requestId });
      assert.ok(rp.status === 200 || rp.status === 201, `native replay stays native: the post exists, so the request replays (${rp.status} ${rp.text.slice(0, 200)})`);
      assert.equal(rp.json?.postSeq, o.postSeq, 'with its ORIGINAL number, never LEGACY_HOLD');
      const a0 = await allocNext(w.cand), s0 = await S(w.cand);
      const held = await s.call('POST', '/api/conversations', { body: 'whatever the caller remembers', author: U3X.author, requestId: U3X.requestId });
      assert.equal(held.status, 409, `an unpublished imported reservation's retry is refused (${held.status} ${held.text.slice(0, 200)})`);
      assert.equal(held.json?.code, R1.LEGACY_HOLD, 'by name: its intention is unknown, so it is held, never re-reserved or guessed');
      assert.deepEqual(await allocNext(w.cand), a0, 'no number consumed');
      assert.equal(await S(w.cand), s0, 'nothing written');
      const fresh = await s.call('POST', '/api/conversations', { body: 'a native post after cutover', author: 'ada', requestId: 'req-1747-native' });
      assert.ok(fresh.status === 200 || fresh.status === 201, `CONTROL: a native post works (${fresh.status} ${fresh.text.slice(0, 200)})`);
      assert.equal(fresh.json?.postSeq, NEXT, 'and takes exactly the preserved nextPostSeq');
    } finally { await s.stop(); }
  }, { prepare: addU3X });
});

test('#1747 (R1-g) GET /api/outbox lists every imported obligation with its STORED status, none in integrity; publishing one → IMPORTED_SETTLED; nothing dispatched or written', T, async () => {
  await imported(async (w) => {
    const s = await restOn(w, { notify: true });
    try {
      const ob = await outboxOf(s);
      assert.deepEqual(ob.integrity ?? [], [], `no imported origin lands in integrity (${JSON.stringify(ob.integrity ?? []).slice(0, 200)})`);
      const byId = new Map((ob.entries || []).map((e) => [e.obligationId, e]));
      for (const x of [...LEGACY, PUB]) assert.equal(byId.get(x.entry.obligationId)?.status, 'published', `${x.entry.obligationId}: listed, published`);
      assert.equal(byId.get(PUB3.entry.obligationId)?.status, 'blocked', 'the imported BLOCKED entry stays blocked');
      const n0 = notifyCalls(), s0 = await S(w.cand);
      for (const id of [PUB.entry.obligationId, PUB3.entry.obligationId]) {
        const p = await s.call('POST', `/api/outbox/${encodeURIComponent(id)}/publish`, {});
        // the frozen interface names the CODE and "no update sent", not an HTTP status; the route answers an already-settled
        // obligation idempotently (as it does a native published one), so the evidence is the code plus no dispatch, no write
        assert.equal(p.json?.code, R1.IMPORTED_SETTLED, `${id}: answered by name (${p.status} ${p.text.slice(0, 200)})`);
      }
      await new Promise((res) => setTimeout(res, 1500));
      assert.equal(notifyCalls(), n0, 'no notify was dispatched');
      assert.equal(await S(w.cand), s0, 'nothing was written');
    } finally { await s.stop(); }
  }, { prepare: addBlocked });
});

// ── STEP 5 READY, as BUILT at 69a0370: an importer mode, `--ready` (a deviation from the v56 draft's separate script, post
// 46296: it reuses the importer's binding, owner and proof checks and recomputes the same id). It verifies a COMPLETE import
// through the runtime readers and marks the candidate READY in ONE update guarded on the verified commitSeq, the candidate
// marker and no existing READY marker. Where the build reuses an existing importer check its existing CODE stands
// (MARKER_MISMATCH, ALLOCATOR_PRESENT, PROOF_MISMATCH, DUPLICATE_SEQ). ASSUMED, not built: a TEST-ONLY pause between the
// verification and the mark (SCRUM_CUTOVER_READY_BARRIER=<fifo>, opened for reading after verifying), so S5-3 can write in
// that window; and the step-3 tool refusing a READY store (v56). Every row keeps S4-N's "no notify".
const RC = { MOVED: 'MOVED', READBACK: 'READBACK', EXTRA_RECORD: 'EXTRA_RECORD', INCOMPLETE: 'INCOMPLETE', READY_FROZEN: 'READY_FROZEN', READY_CONFLICT: 'READY_CONFLICT' };
const RM = { s: 'urn:ex:cutover/ready', migration: 'urn:ex:cutover/readyMigration', sha: 'urn:ex:cutover/captureManifestSha256', seq: 'urn:ex:cutover/verifiedCommitSeq', at: 'urn:ex:cutover/readyAt' };
async function ready(w, { env = {}, capture = w.captureManifest } = {}) {
  const r = await run([IMPORTER, '--board-data', w.docFile, '--executor', w.cand.baseUrl, '--dataset', DS, '--outbox-manifest', w.outboxManifest, '--capture-manifest', capture, '--ready'], env);
  importerRuns++;
  const line = r.out.split('\n').map((l) => l.trim()).find((l) => /^(READY|ALREADY_READY|HOLD|REFUSED|COMPLETE|INCOMPLETE) ?/.test(l)) ?? '';
  const [kind, code] = line.split(' ');
  return { ...r, line, kind, code: kind === 'HOLD' || kind === 'REFUSED' ? code : null, commitSeq: (line.match(/commitSeq=(\d+)/) || [])[1] ?? null, id: (line.match(/id=([0-9a-f]{64})/) || [])[1] ?? null };
}
const readyMarker = async (x) => (await clientFor(x).query(`SELECT ?p ?o WHERE { GRAPH <${BK}> { <${RM.s}> ?p ?o } }`)).rows.map((b) => [b.p.value, b.o.value, b.o.datatype ?? null]).sort();
const storeSeq = async (x) => Number((await clientFor(x).query(`SELECT ?s WHERE { GRAPH <${BK}> { <urn:ex:dataset> <urn:ex:commitSeq> ?s } }`)).rows[0].s.value);
const expectNoMark = async (w, r, kind, code, ctx) => {
  assert.equal(r.kind, kind, `${ctx}: a ${kind} (${r.line || r.out.slice(-200)})`);
  assert.equal(r.code, code, `${ctx}: exactly ${code}`);
  assert.deepEqual(await readyMarker(w.cand), [], `${ctx}: no READY marker`);
};
const rawUpd = async (x, sparql, tag) => { const ep = (await health(x)).epoch; const r = await fetch(`${x.baseUrl}/update`, { method: 'POST', headers: { 'x-op-id': `urn:ex:op/test/s5-${tag}-${process.pid}-${Date.now()}`, 'x-epoch': String(ep) }, body: sparql }); assert.ok(r.ok, `CONTROL: the ${tag} mutant applied (${r.status})`); };

test('#1747 (S5-1) --ready writes ONE READY marker, read back exactly: this migration, this capture, the verified position', T, async () => {
  await imported(async (w, mig) => {
    const n = await storeSeq(w.cand);
    const r = await ready(w);
    assert.equal(r.kind, 'READY', `marked (${r.line || r.out.slice(-200)})`); assert.equal(r.status, 0);
    assert.deepEqual([r.id, Number(r.commitSeq)], [mig, n], 'it names the recomputed migration id and the commitSeq it verified');
    const m = await readyMarker(w.cand);
    const get = (pr) => m.filter(([q]) => q === pr).map(([, v, d]) => [v, d]);
    assert.deepEqual(get(RM.migration), [[mig, null]], 'readyMigration: this migration, once');
    assert.deepEqual(get(RM.sha), [[sha(fs.readFileSync(w.captureManifest)), null]], 'captureManifestSha256: these capture bytes, once');
    assert.deepEqual(get(RM.seq), [[String(n), `${XSD}integer`]], 'verifiedCommitSeq: the verified position, xsd:integer, once');
    assert.equal(get(RM.at).length, 1, 'readyAt, once');
  });
});

test('#1747 (S5-2) a replayed --ready is ALREADY_READY and leaves the store byte-identical', T, async () => {
  await imported(async (w) => {
    assert.equal((await ready(w)).kind, 'READY', 'PRECONDITION: marked');
    const s1 = await S(w.cand);
    const r = await ready(w);
    assert.equal(r.kind, 'ALREADY_READY', `a replay (${r.line})`); assert.equal(r.status, 0);
    assert.equal(await S(w.cand), s1, 'byte-identical');
  });
});

test(`#1747 (S5-3) a write BETWEEN verification and the mark → HOLD ${RC.MOVED}, no marker (needs the ASSUMED test-only pause)`, T, async () => {
  await imported(async (w) => {
    const fifo = path.join(w.dir, 'ready-barrier'); assert.equal(spawnSync('mkfifo', [fifo]).status, 0, 'PRECONDITION: mkfifo');
    const p = ready(w, { env: { SCRUM_CUTOVER_READY_BARRIER: fifo } });
    const fh = await Promise.race([fs.promises.open(fifo, 'w'), new Promise((res) => setTimeout(() => res(null), 60000))]);
    if (!fh) { try { fs.closeSync(fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)); } catch { /* none */ } await p; }
    assert.ok(fh, 'PRECONDITION: the tool reached its test-only pause after verifying (SCRUM_CUTOVER_READY_BARRIER)');
    await rawInsert(w.cand, '<urn:ex:test/interloper> <urn:ex:test/p> "written after verification" .', 'interloper');
    await fh.close();
    await expectNoMark(w, await p, 'HOLD', RC.MOVED, 'a write after verification');
  });
});

// The STATED LIMIT of S5-3's fence (post 46309): commitSeq moves only for compiled writes, so the mark's guard also binds the store's
// quad count; a raw swap that keeps the count (delete one quad, insert one) between verification and the mark is NOT detected. The
// proposed fence is the #1748 write floor installed on the candidate before step 5 (post 46310), which refuses an undeclared raw write
// outright. Until that contract change is ruled, this row is a TODO: it names the limit instead of hiding it.
test(`#1747 (S5-3b) a COUNT-PRESERVING raw swap between verification and the mark → HOLD ${'MOVED'}, no marker`, { ...T, todo: 'stated limit 46309: undetected until the candidate carries the #1748 floor (46310)' }, async () => {
  await imported(async (w) => {
    const fifo = path.join(w.dir, 'ready-barrier-swap'); assert.equal(spawnSync('mkfifo', [fifo]).status, 0, 'PRECONDITION: mkfifo');
    const p = ready(w, { env: { SCRUM_CUTOVER_READY_BARRIER: fifo } });
    const fh = await Promise.race([fs.promises.open(fifo, 'w'), new Promise((res) => setTimeout(() => res(null), 60000))]);
    if (!fh) { try { fs.closeSync(fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)); } catch { /* none */ } await p; }
    assert.ok(fh, 'PRECONDITION: the tool reached its pause');
    const ep = (await health(w.cand)).epoch;
    const u = await fetch(`${w.cand.baseUrl}/update`, { method: 'POST', headers: { 'x-op-id': `urn:ex:op/test/s5-swap-${Date.now()}`, 'x-epoch': String(ep) }, body: `DELETE { <${ENTITY}${LEGACY[0].post.id}> <https://schema.org/text> ?t } INSERT { <${ENTITY}${LEGACY[0].post.id}> <https://schema.org/text> "swapped, count kept" } WHERE { <${ENTITY}${LEGACY[0].post.id}> <https://schema.org/text> ?t }` });
    assert.ok(u.ok, 'PRECONDITION: the swap applied');
    await fh.close();
    const r = await p;
    assert.equal(r.kind, 'HOLD', `a swapped candidate is not marked (${r.line})`);
    assert.deepEqual(await readyMarker(w.cand), [], 'no READY marker');
  });
});

const S5_MUTANTS = [
  // the importer's own field readback runs first and catches a CHANGED mirror (INCOMPLETE, naming the record: measured at
  // 69a0370); a NATIVE field added is invisible to that SELECT readback and only the R1 reader leg can refuse it (READBACK)
  ['a reservation mirror changed', 'INCOMPLETE', null, (w) => rawUpd(w.cand, `DELETE { GRAPH <${BK}> { ${POSTSEQ_TERMS.reservation(U3[0].postId)} <${TERMS.legacyKey}> ?v } } INSERT { GRAPH <${BK}> { ${POSTSEQ_TERMS.reservation(U3[0].postId)} <${TERMS.legacyKey}> "not-the-key" } } WHERE { GRAPH <${BK}> { ${POSTSEQ_TERMS.reservation(U3[0].postId)} <${TERMS.legacyKey}> ?v } }`, 'mirror'), U3[0].postId],
  ['a NATIVE field added to an imported reservation', 'HOLD', RC.READBACK, (w) => rawInsert(w.cand, `${POSTSEQ_TERMS.reservation(U3[0].postId)} ${POSTSEQ_TERMS.mode} "ordinary" .`, 's5-native')],
  ['an EXTRA Origin carrying THIS migration\'s id', 'HOLD', RC.EXTRA_RECORD, (w, mig) => rawInsert(w.cand, `<urn:ex:origin/origin/0e0e1747-0000-4000-8000-00000000e0e0> a ${ORIGIN_TERMS.Origin} ; <${TERMS.migrationId}> "${mig}" .`, 's5-extra')],
  ['a record of ANOTHER migration', 'HOLD', RC.EXTRA_RECORD, (w) => rawInsert(w.cand, `${POSTSEQ_TERMS.reservation('s5-other')} a ${POSTSEQ_TERMS.Reservation} ; <${TERMS.migrationId}> "${'e'.repeat(64)}" .`, 's5-other')],
  ['a missing batch marker', 'HOLD', RC.INCOMPLETE, (w, mig) => rawUpd(w.cand, `DELETE WHERE { GRAPH <${BK}> { <${MARKER.batch(mig, 2)}> ?p ?o } }`, 'nobatch')],
  ['a broken proof post (its text changed)', 'REFUSED', CODES.PROOF_MISMATCH, (w) => rawUpd(w.cand, `DELETE { <${ENTITY}${LEGACY[0].post.id}> <https://schema.org/text> ?t } INSERT { <${ENTITY}${LEGACY[0].post.id}> <https://schema.org/text> "not what the entry says" } WHERE { <${ENTITY}${LEGACY[0].post.id}> <https://schema.org/text> ?t }`, 'proof')],
  ['a number owned twice', 'HOLD', CODES.DUPLICATE_SEQ, (w) => rawInsert(w.cand, `${POSTSEQ_TERMS.reservation('s5-dup')} a ${POSTSEQ_TERMS.Reservation} ; ${POSTSEQ_TERMS.postId} "s5-dup" ; ${POSTSEQ_TERMS.postSeq} "${ORD[0].postSeq}"^^<${XSD}integer> .`, 's5-dup')],
  ['the allocator\'s migrationId replaced', 'REFUSED', CODES.ALLOCATOR_PRESENT, (w) => rawUpd(w.cand, `DELETE { GRAPH <${BK}> { ${POSTSEQ_TERMS.allocator} <${TERMS.migrationId}> ?v } } INSERT { GRAPH <${BK}> { ${POSTSEQ_TERMS.allocator} <${TERMS.migrationId}> "${'f'.repeat(64)}" } } WHERE { GRAPH <${BK}> { ${POSTSEQ_TERMS.allocator} <${TERMS.migrationId}> ?v } }`, 'mig')],
  ['nextPostSeq moved', 'HOLD', null, (w) => rawUpd(w.cand, `DELETE { GRAPH <${BK}> { ${POSTSEQ_TERMS.allocator} ${POSTSEQ_TERMS.nextPostSeq} ?v } } INSERT { GRAPH <${BK}> { ${POSTSEQ_TERMS.allocator} ${POSTSEQ_TERMS.nextPostSeq} "${NEXT + 50}"^^<${XSD}integer> } } WHERE { GRAPH <${BK}> { ${POSTSEQ_TERMS.allocator} ${POSTSEQ_TERMS.nextPostSeq} ?v } }`, 'alloc')],
];
for (const [what, kind, code, mutate, names] of S5_MUTANTS) {
  test(`#1747 (S5-4) ${what} after COMPLETE → --ready answers ${kind}${code ? ` ${code}` : names ? ' naming the record' : ' (any named code)'}; no marker`, T, async () => {
    await imported(async (w, mig) => {
      await mutate(w, mig);
      const r = await ready(w);
      if (code) await expectNoMark(w, r, kind, code, what);
      else if (names) { assert.equal(r.kind, kind, `${what}: ${kind} (${r.line})`); assert.ok(r.line.includes(names), `${what}: it names ${names}`); assert.deepEqual(await readyMarker(w.cand), [], `${what}: no READY marker`); }
      else { assert.ok(r.kind === 'HOLD' || r.kind === 'REFUSED' || r.kind === 'INCOMPLETE', `${what}: refused by name (${r.line})`); assert.deepEqual(await readyMarker(w.cand), [], `${what}: no READY marker`); }
    });
  });
}
test('#1747 (S5-4) the same mutant set\'s CONTROL: the unmutated COMPLETE import marks READY (S5-1), so each refusal above is the mutant\'s', T, async () => {
  await imported(async (w) => { assert.equal((await ready(w)).kind, 'READY', 'the control marks'); });
});
test(`#1747 (S5-4) other capture bytes → REFUSED ${CODES.MARKER_MISMATCH}; no marker`, T, async () => {
  await imported(async (w) => {
    const other = path.join(w.dir, 'capture-edited.json');
    fs.writeFileSync(other, `${fs.readFileSync(w.captureManifest, 'utf8')}\n`);
    await expectNoMark(w, await ready(w, { capture: other }), 'REFUSED', CODES.MARKER_MISMATCH, 'other capture bytes');
  });
});
test(`#1747 (S5-4) a candidate that was never imported → HOLD ${RC.INCOMPLETE}; no marker`, T, async () => {
  await world(async (w) => { await expectNoMark(w, await ready(w), 'HOLD', RC.INCOMPLETE, 'never imported'); });
});

test(`#1747 (S5-5) after READY the importer --apply is REFUSED ${RC.READY_FROZEN}; a dry run still PLANs; the step-3 tool cannot re-mark; nothing written`, T, async () => {
  await imported(async (w) => {
    assert.equal((await ready(w)).kind, 'READY', 'PRECONDITION: marked');
    const s1 = await S(w.cand);
    expectCode(await importer(w, { applyIt: true }), 'REFUSED', RC.READY_FROZEN, 'import after READY');
    assert.match((await importer(w)).out, /^PLAN /m, 'a dry run still reports its PLAN');
    const m = await run([CANDIDATE_TOOL, '--capture-manifest', w.captureManifest, '--executor', w.cand.baseUrl], {});
    assert.match(m.out + m.err, new RegExp(`REFUSED ${RC.READY_FROZEN}`), `the step-3 tool refuses a READY store (${(m.out + m.err).slice(-200)})`);
    assert.equal(await S(w.cand), s1, 'byte-identical');
  });
});

test(`#1747 (S5-6) a READY marker of ANOTHER migration → --ready is REFUSED ${RC.READY_CONFLICT}; the foreign marker is left as it was`, T, async () => {
  await imported(async (w) => {
    await rawInsert(w.cand, `<${RM.s}> <${RM.migration}> "${'a'.repeat(64)}" ; <${RM.sha}> "${'b'.repeat(64)}" ; <${RM.seq}> "1"^^<${XSD}integer> .`, 's5-foreign');
    const m0 = await readyMarker(w.cand);
    const r = await ready(w);
    assert.deepEqual([r.kind, r.code], ['REFUSED', RC.READY_CONFLICT], `refused (${r.line})`);
    assert.deepEqual(await readyMarker(w.cand), m0, 'the foreign marker is untouched, and no second one written');
  });
});

// ── r7 (the fallback review of PR #122, 46472): its untested guards, its verified probes, and the new refusal names ──
const REQUIRED_CAPTURE = ['sourceStore', 'files', 'documentSha256', 'outboxManifestSha256', 'datasetId', 'incarnation', 'capturedAt'];
test(`#1747 (S4-B, r7) the capture schema is CLOSED and REQUIRED in BOTH tools: each missing field, an unknown field and a future capturedAt → REFUSED ${CODES.CAPTURE_MALFORMED}`, T, async () => {
  await world(async (w) => {
    const ok = await importer(w); assert.equal(ok.status, 0, `CONTROL: the well-formed capture passes (${ok.out.slice(-200)})`);
    const mine = JSON.parse(fs.readFileSync(w.captureManifest, 'utf8'));
    const cases = [
      ...REQUIRED_CAPTURE.map((k) => [`no ${k}`, (() => { const x = { ...mine }; delete x[k]; return x; })()]),
      ['an unknown field', { ...mine, incarnaton: mine.incarnation }],
      ['capturedAt an hour in the future', { ...mine, capturedAt: new Date(Date.now() + 3600_000).toISOString() }],
    ];
    for (const [what, cap] of cases) {
      const f = path.join(w.dir, `cap-${what.replace(/\W+/g, '-')}.json`); fs.writeFileSync(f, JSON.stringify(cap));
      const m = await run([CANDIDATE_TOOL, '--capture-manifest', f, '--executor', w.cand.baseUrl], {});
      assert.ok(m.status !== 0 && /^REFUSED CAPTURE_MALFORMED/m.test(m.out), `step 3, ${what}: REFUSED CAPTURE_MALFORMED (exit ${m.status}: ${m.out.slice(-200)})`);
      expectCode(await importer(w, { applyIt: true, capture: f }), 'REFUSED', CODES.CAPTURE_MALFORMED, `step 4, ${what}`);
    }
  });
});
test('#1747 (S4-B, r7, finding 1) a store promoted from the CANDIDATE (not from the captured source), carrying the candidate\'s marker → NOT_CANDIDATE at step 3 and step 4', T, async () => {
  await world(async (w) => {
    await killExecutor(w.cand);
    const other = path.join(w.dir, 'other-store'); fs.cpSync(path.join(w.dir, 'candidate-store'), other, { recursive: true });
    w.cand = await startExecutor({ store: path.join(w.dir, 'candidate-store'), datasetId: DS });
    const o = await startExecutor({ store: other, datasetId: DS, extraArgs: ['--promote-epoch'] });
    try {
      const ho = await health(o);
      const cap = JSON.parse(fs.readFileSync(w.captureManifest, 'utf8'));
      assert.ok(ho.incarnationFrom && ho.incarnationFrom !== cap.incarnation, `PRECONDITION: promoted from the candidate, not the captured source (${ho.incarnationFrom} vs ${cap.incarnation})`);
      const marks = (await clientFor(o).query(`SELECT ?v WHERE { GRAPH <${BK}> { ?m ?p ?v } FILTER(CONTAINS(STR(?m), "candidate")) }`)).rows;
      assert.ok(marks.length > 0, 'PRECONDITION: it carries the candidate\'s marker, so only the descent check can refuse it');
      const m = await run([CANDIDATE_TOOL, '--capture-manifest', w.captureManifest, '--executor', o.baseUrl], {});
      assert.ok(m.status !== 0 && /^REFUSED NOT_CANDIDATE/m.test(m.out), `step 3 refuses it (exit ${m.status}: ${m.out.slice(-200)})`);
      const r = await importer(w, { applyIt: true, executor: o.baseUrl });
      expectCode(r, 'REFUSED', CODES.NOT_CANDIDATE, 'promoted from the candidate');
      assert.match(r.out, /promoted from/, 'by the descent check, by name');
    } finally { await killExecutor(o); await killExecutor(w.cand); }   // world() kills only the candidate IT started
  });
});
test('#1747 (S4-B, r7) the SOURCE store itself, promoted in place (a new incarnation FROM the captured one, at the source\'s own home) → NOT_CANDIDATE, by the home check', T, async () => {
  await world(async (w) => {
    const cap = JSON.parse(fs.readFileSync(w.captureManifest, 'utf8'));
    const src = await startExecutor({ store: w.srcStore, datasetId: DS, extraArgs: ['--promote-epoch'] });
    try {
      const hs = await health(src);
      assert.equal(hs.incarnationFrom, cap.incarnation, 'PRECONDITION: it descends from the captured incarnation, so only the home check can refuse it');
      assert.equal(fs.realpathSync(hs.storeHome), fs.realpathSync(cap.sourceStore), 'PRECONDITION: its home IS the captured source store');
      const r = await importer(w, { applyIt: true, executor: src.baseUrl });
      expectCode(r, 'REFUSED', CODES.NOT_CANDIDATE, 'the source promoted in place');
      assert.match(r.out, /IS the source store/, 'by the home check, by name');
    } finally { await killExecutor(src); }
  });
});
test(`#1747 (S4-B, r7) a source store file changed AFTER batch 1 and BEFORE batch 2 → REFUSED ${CODES.SOURCE_CHANGED}, batch 2 never written (needs the ASSUMED test-only pause SCRUM_CUTOVER_BATCH_BARRIER)`, T, async () => {
  // ASSUMED seam, like S5-3's: with SCRUM_CUTOVER_BATCH_BARRIER set to a path, the importer READS it (blocking on a FIFO) after
  // committing batch 1 and before batch 2's source re-check. Unset, it is off.
  await world(async (w) => {
    const fifo = path.join(w.dir, 'batch-barrier'); assert.equal(spawnSync('mkfifo', [fifo]).status, 0, 'PRECONDITION: mkfifo');
    const p = importer(w, { applyIt: true, env: { SCRUM_CUTOVER_BATCH_BARRIER: fifo } });
    const fh = await Promise.race([fs.promises.open(fifo, 'w'), new Promise((res) => setTimeout(() => res(null), 60000))]);
    if (!fh) { try { fs.closeSync(fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)); } catch { /* none */ } await p; }
    assert.ok(fh, 'PRECONDITION: the importer reached its test-only pause between batches (SCRUM_CUTOVER_BATCH_BARRIER)');
    const f = fs.readdirSync(w.srcStore).sort()[0]; fs.appendFileSync(path.join(w.srcStore, f), 'x');
    await fh.close();
    const r = await p;
    expectCode(r, 'REFUSED', CODES.SOURCE_CHANGED, 'a source change between batches');
    assert.match(r.out, /before batch 2/, 'by the pre-batch re-check, by name');
    assert.deepEqual(await typed(w.cand, `SELECT ?v WHERE { GRAPH <${BK}> { <${MARKER.batch(r.id, 2)}> <${MARKER.digest}> ?v } }`), [], 'batch 2 has no marker');
    for (const x of [...LEGACY, PUB]) assert.deepEqual(await typed(w.cand, `SELECT ?v WHERE { GRAPH <${BK}> { ${ORI(x)} ?p ?v } }`), [], `batch 2's origin ${x.origin.mutationId} is absent`);
  });
});
test(`#1747 (S4-C3, r7) a manifest with the SAME obligation on two rows → REFUSED ${CODES.MANIFEST_DUPLICATE}; nothing written`, T, async () => {
  await world(async (w) => {
    const s0 = await S(w.cand);
    expectCode(await importer(w, { applyIt: true }), 'REFUSED', CODES.MANIFEST_DUPLICATE, 'a duplicated manifest row');
    assert.equal(await S(w.cand), s0, 'nothing written: S byte-identical');
  }, { manifest: (rows) => [...rows, { ...rows[0] }] });
});
// the pre-write shape checks (46473 point 3): each a HOLD before any batch, nothing written; the valid world is the control (S4-M)
const P2X = publisher(2, 'claim');
const EVIL_POSTID = `inj1747> <urn:ex:test/injected> "bk" } <urn:ex:test/dflt> <urn:ex:test/p> "in-default-graph" . GRAPH <${BK}> { <urn:ex:test/inj-s`;
for (const [what, code, opts] of [
  ['a reservation postId carrying IRI syntax (the review\'s PROBE-E)', CODES.BAD_ID, { prepare: (d) => { d['scrum:meta'].postReservations['0b6f1e8a-3c2d-4e5f-8a9b-0c1d2e3f4a77'] = { createdAt: iso(7), postId: EVIL_POSTID, postSeq: 38020 }; } }],
  ['a legacy entry\'s legacyPostId carrying SPARQL syntax (PROBE-G)', CODES.BAD_ID, { prepare: (d) => { d['scrum:meta'].announcementOutbox.entries[LEGACY[0].entry.obligationId].legacyPostId = `${LEGACY[0].post.id}> ?p ?o } #`; } }],
  // with its own (non-pending) entry, so ORIGIN_WITHOUT_ENTRY cannot answer first
  ['an origin whose key is not a lowercase UUID', CODES.BAD_ID, { prepare: (d) => { const ob = d['scrum:meta'].announcementOutbox; const o = structuredClone(P2X.origin); o.mutationId = 'NOT-A-UUID'; ob.origins['NOT-A-UUID'] = o; ob.entries['NOT-A-UUID:claim'] = { ...structuredClone(P2X.entry), mutationId: 'NOT-A-UUID', obligationId: 'NOT-A-UUID:claim', status: 'blocked', payload: { ...structuredClone(P2X.entry.payload), mutationId: 'NOT-A-UUID' } }; } }],
  ['a published publisher entry whose postId is not its announcement post', CODES.BAD_ID, { prepare: (d) => { const ob = d['scrum:meta'].announcementOutbox; ob.origins[P2X.origin.mutationId] = structuredClone(P2X.origin); ob.entries[P2X.entry.obligationId] = { ...structuredClone(P2X.entry), status: 'published', postId: U3[0].postId }; } }],
  ['an entry for a slot its origin lacks (PROBE-C)', CODES.ENTRY_WITHOUT_SLOT, { prepare: (d) => { const ob = d['scrum:meta'].announcementOutbox; const e = structuredClone(PUB.entry); e.slot = 'release'; e.obligationId = `${e.mutationId}:release`; e.status = 'published'; delete e.postSeq; ob.entries[e.obligationId] = e; } }],
  ['an entry status outside pending/published/blocked (PROBE-B)', CODES.BAD_ENTRY, { prepare: (d) => { const ob = d['scrum:meta'].announcementOutbox; ob.origins[P2X.origin.mutationId] = structuredClone(P2X.origin); ob.entries[P2X.entry.obligationId] = { ...structuredClone(P2X.entry), status: 'dispatching', postSeq: 39502 }; } }],
  // the entry agrees with it, so MODE_DISAGREES cannot answer first
  ['an origin mode outside legacy/publisher', CODES.BAD_ORIGIN, { prepare: (d) => { const ob = d['scrum:meta'].announcementOutbox; ob.origins[LEGACY[0].origin.mutationId].mode = 'other'; ob.entries[LEGACY[0].entry.obligationId].mode = 'other'; } }],
  ['an origin with a missing slots field', CODES.BAD_ORIGIN, { prepare: (d) => { delete d['scrum:meta'].announcementOutbox.origins[LEGACY[0].origin.mutationId].slots; } }],
  ['a reservation with an EXTRA key', CODES.BAD_RESERVATION, { prepare: (d) => { d['scrum:meta'].postReservations[U3[0].key].extra = 1; } }],
  ['a reservation whose applied is not a boolean', CODES.BAD_RESERVATION, { prepare: (d) => { d['scrum:meta'].postReservations[U3[0].key].applied = 'yes'; } }],
  ['a reservation subject that already holds a triple in the candidate (PROBE-D)', CODES.SUBJECT_OCCUPIED, { plant: (c) => rawInsert(c, `${POSTSEQ_TERMS.reservation(U3[0].postId)} ${POSTSEQ_TERMS.mode} "ordinary" .`, 'occupied') }],
]) {
  test(`#1747 (S4-H, r7) ${what} → HOLD ${code}; nothing written`, T, async () => {
    await world(async (w) => {
      const s0 = await S(w.cand);
      expectCode(await importer(w, { applyIt: true }), 'HOLD', code, what);
      assert.equal(await S(w.cand), s0, 'nothing written: S byte-identical');
      if (code === CODES.BAD_ID) {
        for (const q of ['SELECT ?o WHERE { <urn:ex:test/dflt> ?p ?o }', `SELECT ?o WHERE { GRAPH <${BK}> { ?s <urn:ex:test/injected> ?o } }`]) assert.deepEqual((await clientFor(w.cand).query(q)).rows, [], `no injected quad (${q.slice(0, 60)})`);
      }
    }, opts);
  });
}
test('#1747 (R1-e, r7) the overlap rule from the NATIVE side for a RESERVATION: a native reservation reads kind native; given a migrationId it is INVALID', T, async () => {
  await imported(async (w) => {
    const c = clientFor(w.cand);
    const item = { mode: 'ordinary', author: 'ada', requestId: 'rk-1747-native-res', draft: { body: 'post rk-1747-native-res', attachedTo: null, mentions: [], attachments: [], conversation: null, onBehalfOf: null } };
    const r = await durableUpdate(c, { kind: 'postseq.reserve', opId: reserveOpId([item]), actor: 'urn:ex:seat/ada', reservations: [item] });
    assert.equal(r.outcome, 'APPLIED', `CONTROL: a native reservation is reserved on the imported candidate (${JSON.stringify(r).slice(0, 200)})`);
    const pid = postWriteId(item.author, item.requestId);
    const ok0 = await readPostSeqReservation(c, pid);
    assert.equal(ok0.reservation?.kind, 'native', `CONTROL: it reads kind native (${JSON.stringify(ok0).slice(0, 160)})`);
    await rawOn(w.cand, `INSERT DATA { GRAPH <${BK}> { ${POSTSEQ_TERMS.reservation(pid)} <${TERMS.migrationId}> "forged" } }`, 'r1e-res');
    assert.ok(isInvalid(await readPostSeqReservation(c, pid)), 'a native reservation carrying migrationId is INVALID, never read as imported');
  });
});
test('#1747 (S5-2, r7) a READY replay RE-VERIFIES: a reservation tampered after READY → never ALREADY_READY, a named refusal, and the marker untouched', T, async () => {
  await imported(async (w) => {
    const r1 = await ready(w); assert.equal(r1.status, 0, `CONTROL: the candidate is marked READY (${r1.out.slice(-200)})`);
    const m0 = await readyMarker(w.cand);
    await rawOn(w.cand, `DELETE { GRAPH <${BK}> { ${RS_(U3[0].postId)} ${POSTSEQ_TERMS.postSeq} ?v } } INSERT { GRAPH <${BK}> { ${RS_(U3[0].postId)} ${POSTSEQ_TERMS.postSeq} "${U3[0].postSeq + 1}"^^<${XSD}integer> } } WHERE { GRAPH <${BK}> { ${RS_(U3[0].postId)} ${POSTSEQ_TERMS.postSeq} ?v } }`, 's52');
    const r2 = await ready(w);
    assert.notEqual(r2.status, 0, `a tampered READY candidate is not answered ALREADY_READY (exit ${r2.status}: ${r2.out.slice(-200)})`);
    assert.ok(!/^ALREADY_READY/m.test(r2.out), 'never ALREADY_READY');
    assert.match(r2.out, new RegExp(`^(?:HOLD |REFUSED )?INCOMPLETE[^\n]*${U3[0].postId}[^\n]*postSeq`, 'm'), `a named INCOMPLETE for the tampered reservation's postSeq (${r2.out.slice(-200)})`);
    assert.deepEqual(await readyMarker(w.cand), m0, 'the READY marker is untouched');
  });
});

// ── r8: step 2's REAL output through steps 3, 4 and 5 on one fixture: the manifest the capture tool writes is one the others accept ──
test('#1747 (S2-chain, r8) capture → step 3 marks → step 4 COMPLETE → --ready READY, all from the manifest the CAPTURE TOOL wrote', T, async () => {
  await world(async (w) => {
    const ident = path.join(w.dir, 'identity.json'); fs.writeFileSync(ident, JSON.stringify(w.srcHealth));
    const cap = path.join(w.dir, 'captured.json');
    const c = await run([CAPTURE_TOOL, '--source-store', w.srcStore, '--board-data', w.docFile, '--outbox-manifest', w.outboxManifest, '--identity', ident, '--out', cap], {});
    assert.equal(c.status, 0, `step 2 CAPTURED (exit ${c.status}: ${c.out.slice(-200)} ${c.err.slice(-200)})`);
    assert.equal(c.out.match(/^CAPTURED ([0-9a-f]{64})$/m)?.[1], shaFile(cap), 'the printed sha is the manifest\'s');
    const m = await run([CANDIDATE_TOOL, '--capture-manifest', cap, '--executor', w.cand.baseUrl], {});
    assert.equal(m.status, 0, `step 3 marks the candidate for THIS manifest (exit ${m.status}: ${m.out.slice(-200)})`);
    const r = await importer(w, { applyIt: true, capture: cap });
    assert.ok(r.complete, `step 4 COMPLETE (${r.out.slice(-240)})`);
    const rd = await ready(w, { capture: cap });
    assert.equal(rd.status, 0, `step 5 READY (exit ${rd.status}: ${rd.out.slice(-200)})`);
    assert.match(rd.out, /^READY /m, 'READY, by name');
  }, { mark: false });
});

test('#1747 (S4-N) no importer run called the notify endpoint (and the importer really ran)', () => {
  assert.ok(importerRuns >= 10, `the importer really ran in this file (${importerRuns} runs): zero calls from zero runs proves nothing`);
  assert.equal(notifyCalls(), 1, `only the harness control's one deliberate call reached the stub (got ${notifyCalls()})`);
});
