#!/usr/bin/env node
/**
 * #1574 — ROLLBACK of the conversations unit: make the board document serve, with the unit OFF, what the unit ON served.
 *
 *   node scripts/rollback-posts-1574.mjs --board-file <board.json> --executor-url <url> --dataset-id <id> [--dry-run]
 *
 * Operates on a STOPPED board's file (its REST server is down). With the unit on, new posts live ONLY in the graph and a
 * redaction leaves the document's copy of an imported post untouched, so simply turning the flag off would hide every post
 * written since the flip and serve redacted text again. This script reconciles by IDENTITY, with the graph as the authority:
 *
 *   a live graph post (a Comment)        → the document holds it exactly as the graph does (written, or rewritten if it differs);
 *                                          a document copy that already matches is left byte-for-byte as it is
 *   a graph TOMBSTONE (a RedactedPost)   → the document's copy is REMOVED: no text survives anywhere the flag-off server reads,
 *                                          and the forward backfill cannot recreate it (it reads the document)
 *   a document post the graph never had  → kept as it is
 *   the post counter                     → raised above every postSeq the graph holds, tombstones included, so a later post
 *                                          never reuses a number (a re-flip would collide with the graph)
 *
 * Every graph read happens before anything is written; any failed read (wrong dataset, unreachable executor) exits 2 with
 * the file untouched. Nothing to change → nothing is written, so a second run leaves the file byte-identical. --dry-run
 * reports what would change and writes nothing.
 *
 * Summary: the LAST stdout line, one JSON object {graphPosts, tombstones, written, rewritten, unchanged, removedRedacted,
 * documentOnly, nextPostSeq, changed, dryRun}. Exit: 0 done · 2 refused (nothing written).
 */
import { boardFileProblem } from '../core/board-file-guard.mjs';
import { loadDomain, saveDomain } from '../core/store.mjs';
import { boardToDomain, domainToBoard } from '../core/mapping.mjs';
import { createGraphClient } from '../core/graph-client.mjs';
import { NEXT_POST_SEQ } from '../core/post-seq.mjs';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const SCHEMA = 'https://schema.org/';
const NS = 'https://scrumboard.local/ns#';
const ENTITY = 'https://scrumboard.local/entity/';
const PERSON = 'https://scrumboard.local/person/';
const TALK = 'https://scrumboard.local/talk/';
const RECORDED_BY = 'urn:ex:recordedBy';
// #1574 U5 — graph predicate (under NS) → document key, the author-repair trail
const TRAIL = [['originalAuthorToken', '_originalAuthorToken'], ['authorCorrectedAt', '_authorCorrectedAt'], ['authorCorrectedBy', '_authorCorrectedBy']];

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const FILE = opt('--board-file');
const URL_ = opt('--executor-url');
const DATASET = opt('--dataset-id');
const DRY = args.includes('--dry-run');

const summary = { graphPosts: 0, tombstones: 0, written: 0, rewritten: 0, unchanged: 0, removedRedacted: 0, documentOnly: 0, nextPostSeq: null, changed: false, dryRun: DRY };
const finish = (code, message) => {
  if (message) console.error(message);
  console.log(JSON.stringify(summary));
  process.exit(code);
};
if (!FILE || !URL_ || !DATASET) finish(2, 'usage: node scripts/rollback-posts-1574.mjs --board-file <board.json> --executor-url <url> --dataset-id <id> [--dry-run]');

// #1574 G1–G3 — a missing, empty or non-board file is REFUSED, never read as an empty board
const fileProblem = boardFileProblem(FILE);
if (fileProblem) finish(2, fileProblem);

let board;
try { board = domainToBoard(loadDomain(FILE)); } catch (e) { finish(2, `cannot read ${FILE}: ${e.message}`); }
const docPosts = Array.isArray(board.conversations) ? board.conversations : [];

// ── every graph read, before anything is decided ──
const client = createGraphClient({ baseUrl: URL_, expectedDatasetId: DATASET, timeoutMs: 60000 });
const ident = await client.datasetIdentity();   // a query alone does not check WHICH dataset answered
if (!ident.ok) finish(2, `executor not usable (${ident.reason}); nothing was written`);
const read = async (what, sparql) => {
  const r = await client.query(sparql);
  if (!r.ok) finish(2, `cannot read the graph's ${what} (${r.reason || 'unreadable'}); nothing was written`);
  return r.rows;
};
const commentRows = await read('posts', `SELECT ?s ?p ?o WHERE { ?s <${RDF_TYPE}> <${SCHEMA}Comment> . ?s ?p ?o }`);
const attachmentRows = await read('attachments', `SELECT ?a ?post ?p ?o WHERE { ?a <${NS}attachmentOf> ?post . ?a ?p ?o }`);
const tombstoneRows = await read('redacted posts', `SELECT ?s ?seq WHERE { ?s <${RDF_TYPE}> <${NS}RedactedPost> . OPTIONAL { ?s <${NS}postSeq> ?seq } }`);

const idOf = (iri) => (iri.startsWith(ENTITY) ? iri.slice(ENTITY.length) : null);
const triples = new Map();   // post IRI → { predicate: [term] }
for (const b of commentRows) {
  if (b.p.value === RECORDED_BY) continue;
  const t = triples.get(b.s.value) || triples.set(b.s.value, {}).get(b.s.value);
  (t[b.p.value] ||= []).push(b.o);
}
const attachments = new Map();   // post IRI → index → { predicate: value }
for (const b of attachmentRows) {
  if (b.p.value === RECORDED_BY) continue;
  const byIndex = attachments.get(b.post.value) || attachments.set(b.post.value, new Map()).get(b.post.value);
  const k = b.a.value;
  (byIndex.get(k) || byIndex.set(k, {}).get(k))[b.p.value] = b.o.value;
}

/** The document post a graph Comment stands for: the inverse of the forward backfill's mapping. */
function docPostFrom(iri, t) {
  const one = (pred) => (t[pred] ? t[pred][0].value : undefined);
  const after = (v, prefix) => (v !== undefined && v.startsWith(prefix) ? v.slice(prefix.length) : undefined);
  const p = {
    id: idOf(iri),
    body: one(`${SCHEMA}text`) ?? '',
    author: after(one(`${SCHEMA}author`), PERSON),
    createdAt: one(`${SCHEMA}dateCreated`),
    attachedTo: after(one(`${SCHEMA}about`), ENTITY) ?? null,
    mentions: [...new Set((t[`${NS}mentionsName`] || []).map((o) => o.value))].sort(),
    attachments: [...(attachments.get(iri) || new Map()).values()]
      .sort((x, y) => Number(x[`${NS}attachmentIndex`]) - Number(y[`${NS}attachmentIndex`]))
      .map((a) => ({ id: a[`${SCHEMA}identifier`], mime: a[`${SCHEMA}encodingFormat`], name: a[`${SCHEMA}name`], size: Number(a[`${SCHEMA}contentSize`]) })),
    postSeq: Number(one(`${NS}postSeq`)),
  };
  const conversation = after(one(`${NS}conversation`), TALK);
  if (conversation !== undefined) p.conversation = conversation;
  if (one(`${NS}onBehalfOf`) !== undefined) p.onBehalfOf = one(`${NS}onBehalfOf`);
  if (one(`${NS}recovered`) !== undefined) p._recovered = one(`${NS}recovered`);
  if (one(`${NS}opId`) !== undefined) p.opId = one(`${NS}opId`);
  if (one(`${NS}originMutation`) !== undefined) {
    p.origin = { mutationId: one(`${NS}originMutation`), slot: one(`${NS}originSlot`) };
    if (one(`${NS}originOccurredAt`) !== undefined) p.origin.occurredAt = one(`${NS}originOccurredAt`);
  }
  for (const [pred, key] of TRAIL) if (one(`${NS}${pred}`) !== undefined) p[key] = one(`${NS}${pred}`);
  return p;
}

/** What the graph can say about a post, in one comparable form (mentions as a set, absent = absent). */
function canonical(p) {
  return JSON.stringify([
    p.id, p.body, p.author, p.createdAt, p.attachedTo ?? null, [...new Set(p.mentions || [])].sort(), p.postSeq,
    p.conversation ?? null, p.onBehalfOf ?? null, p._recovered ?? null, p.opId ?? null,
    p.origin ? [p.origin.mutationId, p.origin.slot, p.origin.occurredAt ?? null] : null,
    (p.attachments || []).map((a) => [a.id, a.mime, a.name, a.size]),
    TRAIL.map(([, key]) => p[key] ?? null),
  ]);
}

const graphPosts = new Map();   // id → document post
for (const [iri, t] of triples) {
  const id = idOf(iri);
  if (id === null) continue;
  const p = docPostFrom(iri, t);
  if (!p.author || !p.createdAt || !Number.isSafeInteger(p.postSeq) || p.postSeq <= 0) finish(2, `graph post ${id} is incomplete (author, createdAt or postSeq missing); nothing was written`);
  graphPosts.set(id, p);
}
const redactedIds = new Set();
let maxSeq = 0;
for (const b of tombstoneRows) {
  const id = idOf(b.s.value);
  if (id !== null) redactedIds.add(id);
  if (b.seq) maxSeq = Math.max(maxSeq, Number(b.seq.value) || 0);
}
for (const p of graphPosts.values()) maxSeq = Math.max(maxSeq, p.postSeq);
summary.graphPosts = graphPosts.size;
summary.tombstones = redactedIds.size;

// ── reconcile by identity ──
const seen = new Set();
const next = [];
for (const d of docPosts) {
  if (redactedIds.has(d.id)) { summary.removedRedacted++; continue; }
  const g = graphPosts.get(d.id);
  if (!g) { summary.documentOnly++; next.push(d); continue; }
  seen.add(d.id);
  if (canonical(d) === canonical(g)) { summary.unchanged++; next.push(d); } else { summary.rewritten++; next.push(g); }
}
for (const [id, g] of graphPosts) if (!seen.has(id)) { summary.written++; next.push(g); }
next.sort((a, b) => (a.postSeq ?? 0) - (b.postSeq ?? 0));   // stable: equal or missing numbers keep their order

const currentNext = board[NEXT_POST_SEQ];
const nextSeq = Math.max(Number.isSafeInteger(currentNext) ? currentNext : 1, maxSeq + 1);
summary.nextPostSeq = nextSeq;
summary.changed = nextSeq !== currentNext || next.length !== docPosts.length || next.some((p, k) => p !== docPosts[k]);

if (!summary.changed || DRY) finish(0);

board.conversations = next;
board[NEXT_POST_SEQ] = nextSeq;
board.lastUpdated = new Date().toISOString();
saveDomain(FILE, boardToDomain(board), { now: board.lastUpdated });   // roster-less: the people nodes are preserved
finish(0);
