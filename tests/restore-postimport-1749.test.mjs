/**
 * #1749 B12 — a backup taken AFTER the cutover import carries the imported state, and a restore of it neither loses nor
 * reuses anything. Row author: the B-row author of #1749 (not the builder). Written against contract v2 as amended by v3
 * A1–A5 (frozen, card #1749), §7 row B1 and its negative control "Backup omits allocator/outbox, or restore reuses number".
 *
 * THE HARNESS below (fixtures, world(), importer(), the typed tables) is copied UNCHANGED from the #1747 step-4 rows file
 * (tests/cutover-import-step4-1747.test.mjs at 8c6f913, its own author's), so the imported world here is exactly the one
 * the importer's acceptance runs against. Only the B12 rows at the end are new.
 *
 * Backup = a copy of the STOPPED candidate store directory (the backup job's unit is the whole store directory).
 * Restore = a copy of that backup, started with --promote-epoch (the supported path).
 *
 *   B12-a  the restore equals the backed-up store quad for quad, except the promotion's own identity triples and (once
 *          built) the RecoveryHold; reservations, origins, obligations, dispositions, posts, receipts and the allocator
 *          compare field by field
 *   B12-b  a retry of an imported post's original write on the restore changes nothing: no second post, no new number
 *   B12-c  RED until #1749 is built: a NEW reservation on the restore is PRECONDITION_FAILED with code RECOVERY_HOLD
 *   B12-d  NEGATIVE CONTROLS: a backup with its outbox (origins + obligations) stripped, and one with its allocator
 *          stripped, each make B12-a's comparison report the loss (the comparison is not blind)
 *
 * OWED, BY NAME: a publisher obligation whose receipt was lost is held, not re-dispatched (needs a world with a pending
 * publisher entry imported as pending; the importer's valid world disposes it); U3 legacy keys after restore are covered by
 * B12-a (legacyKey through RES_TABLE, and every source-JSON triple through the quad-for-quad comparison) but not by a separate row.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HAVE_PY, PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';
import { createGraphClient } from '../core/graph-client.mjs';
import { durableUpdate } from '../core/durable-update.mjs';
import { announcePostId } from '../core/announce-outbox.mjs';
import { postWriteId } from '../core/post-write.mjs';
import { readPostSeqReservation, reserveOpId } from '../core/postseq-reserve.mjs';
import { readCommittedOrigin, readOriginOutcome, readPreparedOrigin } from '../core/origin-commit.mjs';
import { mutationIdOf, originPrepareOp, originCommitOp } from '../core/graph-compiler.mjs';
import { cardQuads, priorQuads, cardIriOf } from '../core/cards-graph.mjs';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';
import { POSTSEQ_TERMS, ORIGIN_TERMS, BOOKKEEPING_GRAPH, POSTSEQ_NS, ORIGIN_NS, MARKER_SUBJECT } from '../core/graph-vocab.mjs';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const IMPORTER = path.join(REPO, 'scripts', 'cutover-import-1629.mjs');
const CANDIDATE_TOOL = path.join(REPO, 'scripts', 'cutover-candidate-1629.mjs');
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
    const w = { dir, srcStore, cand, docFile, outboxManifest, captureManifest, doc };
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
async function imported(body, opts = {}) {
  await world(async (w) => {
    const r = await importer(w, { applyIt: true });
    assert.ok(r.complete, `CONTROL: COMPLETE (${r.out.slice(-300)})`);
    await body(w, r.id);
  }, opts);
}

// ── B12 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
const CAND_STORE = (w) => path.join(w.dir, 'candidate-store');
const HOLD_SUBJECT = 'urn:ex:postseq/recovery-hold';
/** the subjects a promotion may legitimately write or change: the dataset marker (epoch, incarnation, home) and the hold */
const PROMOTION_SUBJECTS = [bare(MARKER_SUBJECT), HOLD_SUBJECT];
/** quads whose subject is one of `subjects` (exact IRI), removed from a STOPPED store, offline, with pyoxigraph */
function stripOffline(store, prefixes) {
  const prog = 'import sys, pyoxigraph as px\ns = px.Store(sys.argv[1])\nps = sys.argv[2:]\nq = [x for x in s.quads_for_pattern(None, None, None, None) if isinstance(x.subject, px.NamedNode) and any(x.subject.value.startswith(p) for p in ps)]\nfor x in q: s.remove(x)\ns.flush()\nprint(len(q))';
  const r = spawnSync(PY, ['-I', '-c', prog, store, ...prefixes], { encoding: 'utf8' });
  assert.equal(r.status, 0, `CONTROL: the offline strip ran (${r.stderr.slice(-300)})`);
  const n = Number(r.stdout.trim());
  assert.ok(n > 0, `CONTROL: the strip removed something (${prefixes.join(', ')}): a strip that removed nothing proves nothing`);
  return n;
}
/** stop the candidate, copy its store (the backup), optionally damage the backup offline, restore a copy of it with
 *  --promote-epoch, and bring the original back at its home for comparison. The caller kills the restore. */
async function backupAndRestore(w, { strip = null } = {}) {
  await killExecutor(w.cand);
  const bak = path.join(w.dir, 'backup'); fs.cpSync(CAND_STORE(w), bak, { recursive: true });
  const stripped = strip ? stripOffline(bak, strip) : 0;
  const restored = path.join(w.dir, 'restored'); fs.cpSync(bak, restored, { recursive: true });
  const rest = await startExecutor({ store: restored, datasetId: DS, extraArgs: ['--promote-epoch'] });
  w.cand = await startExecutor({ store: CAND_STORE(w), datasetId: DS });
  const hb = await health(w.cand), hr = await health(rest);
  assert.equal(hr.datasetId, hb.datasetId, 'CONTROL: the restore keeps the datasetId');
  assert.ok(hr.incarnation !== hb.incarnation && hr.incarnationFrom === hb.incarnation, 'CONTROL: the restore is a NEW incarnation promoted from the backed-up one');
  return { rest, stripped };
}
/** the quad-for-quad difference, with promotion subjects set aside: [only in the backup, only in the restore] */
async function quadDiff(a, b) {
  const keep = (line) => !PROMOTION_SUBJECTS.some((s) => line.includes(`|${s}|`));
  const A = new Set((await S(a)).split('\n').filter(keep)), B = new Set((await S(b)).split('\n').filter(keep));
  return [[...A].filter((l) => !B.has(l)), [...B].filter((l) => !A.has(l))];
}
const allocatorOf = (x) => typed(x, `SELECT ?v WHERE { GRAPH <${BK}> { ${POSTSEQ_TERMS.allocator} ${POSTSEQ_TERMS.nextPostSeq} ?v } }`);
const epochOf = (x) => typed(x, `SELECT ?v WHERE { GRAPH <${BK}> { ${POSTSEQ_TERMS.allocator} ${POSTSEQ_TERMS.postSeqEpoch} ?v } }`);

test('#1749 (B12-a) a backup taken AFTER the import restores quad for quad (promotion identity aside); every imported field, post, receipt and the allocator compare exactly', T, async () => {
  await imported(async (w) => {
    const { rest } = await backupAndRestore(w);
    try {
      const fieldsB = await FIELDS(w.cand);
      assert.ok(Object.values(fieldsB).some((v) => v.length), 'CONTROL: the imported fields are present before the backup (an empty table makes every comparison pass)');
      assert.deepEqual(await FIELDS(rest), fieldsB, 'every reservation, origin and obligation field, typed');
      assert.deepEqual(await postsAndReceipts(rest, ALL_POSTS), await postsAndReceipts(w.cand, ALL_POSTS), 'every post and its receipt');
      const alloc = await allocatorOf(w.cand);
      assert.deepEqual(alloc, INT(NEXT), 'CONTROL: the imported allocator holds the document\'s nextPostSeq');
      assert.deepEqual(await allocatorOf(rest), alloc, 'the allocator\'s next, exactly');
      assert.deepEqual(await epochOf(rest), await epochOf(w.cand), 'the allocator\'s postSeqEpoch, exactly (never bumped)');
      const [lost, added] = await quadDiff(w.cand, rest);
      assert.deepEqual(lost, [], 'nothing the backup held is missing from the restore');
      assert.deepEqual(added, [], 'the restore holds nothing the backup did not, beyond the promotion\'s own identity and hold');
    } finally { await killExecutor(rest); await killExecutor(w.cand); }   // w.cand was RESTARTED here: world() kills only the one it started
  });
});

test('#1749 (B12-b) a retry of an imported post\'s ORIGINAL write on the restore changes nothing: no second post, no new number', T, async () => {
  await imported(async (w) => {
    const { rest } = await backupAndRestore(w);
    try {
      const o = ORD[0];
      const before = await S(rest);
      const r = await durableUpdate(clientFor(rest), { kind: 'post.write', opId: `urn:ex:op/post/${o.postId}`, actor: `https://scrumboard.local/person/${o.author}`, post: { id: o.postId, author: o.author, createdAt: o.createdAt, postSeq: o.postSeq, body: `ordinary ${o.requestId}`, attachedTo: null, mentions: [], attachments: [], conversation: null, onBehalfOf: null } });
      assert.ok(['APPLIED', 'RECONCILE_REQUIRED'].includes(r.outcome), `the retry answers from its recorded receipt or holds; it is never refused as new (${JSON.stringify(r).slice(0, 200)})`);
      assert.equal(await S(rest), before, 'the store is byte-identical after the retry: no second post, no new number');
    } finally { await killExecutor(rest); await killExecutor(w.cand); }   // w.cand was RESTARTED here: world() kills only the one it started
  });
});

test('#1749 (B12-c) RED until built: a NEW reservation on a post-import restore is PRECONDITION_FAILED with code RECOVERY_HOLD, and nothing is reserved', T, async () => {
  await imported(async (w) => {
    const { rest } = await backupAndRestore(w);
    try {
      const reservations = [{ mode: 'ordinary', author: 'ada', requestId: `b12c-${process.pid}`, draft: { body: 'b12c', attachedTo: null, mentions: [], attachments: [], conversation: null, onBehalfOf: null } }];
      const alloc = await allocatorOf(rest);
      const r = await durableUpdate(clientFor(rest), { kind: 'postseq.reserve', opId: reserveOpId(reservations), actor: 'urn:ex:seat/ada', reservations });
      assert.equal(r.outcome, 'PRECONDITION_FAILED', `held, never allocated (${JSON.stringify(r).slice(0, 200)})`);
      assert.equal(r.code ?? r.reason, 'RECOVERY_HOLD', 'by the hold, by name (contract v2 V2-2)');
      assert.deepEqual(await allocatorOf(rest), alloc, 'the allocator did not move');
    } finally { await killExecutor(rest); await killExecutor(w.cand); }   // w.cand was RESTARTED here: world() kills only the one it started
  });
});

for (const [what, prefixes] of [
  ['its OUTBOX (every origin and obligation)', () => [bare(ORIGIN_TERMS.originSubject('x')).replace(/x$/, ''), bare(ORIGIN_TERMS.obligationSubject('x', 'y')).replace(/x\/y$/, '')]],
  ['its ALLOCATOR', () => [bare(POSTSEQ_TERMS.allocator)]],
]) {
  test(`#1749 (B12-d) NEGATIVE CONTROL: a backup with ${what} stripped makes B12-a's comparison report the loss`, T, async () => {
    await imported(async (w) => {
      const { rest, stripped } = await backupAndRestore(w, { strip: prefixes() });
      try {
        const [lost] = await quadDiff(w.cand, rest);
        assert.ok(lost.length >= stripped, `the comparison reports every stripped quad as missing (${lost.length} reported, ${stripped} stripped)`);
      } finally { await killExecutor(rest); await killExecutor(w.cand); }   // w.cand was RESTARTED here: world() kills only the one it started
    });
  });
}
