#!/usr/bin/env node
/**
 * #1574 R0 — copy the board document's posts into the graph, as they are stored.
 *
 *   node scripts/backfill-posts-r0.mjs --board-file <board.json> --executor-url <url> --dataset-id <id> [--limit N]
 *
 * Reads the board file (a STOPPED board, or a copy) and never writes it. Each post becomes one `post.import`
 * intention under the deterministic opId urn:ex:op/backfill/<post id>, so a re-run, a resume or a re-sent in-flight
 * write is the same operation, never a second one.
 *
 * Before any write it reads every Comment node the graph already holds, once:
 *   absent                → written (one /update)
 *   present, identical    → alreadyPresent, nothing sent
 *   present, different    → a NAMED conflict {id, reason: 'content-differs'}: never overwritten, never counted present
 *   redacted (a RedactedPost tombstone holds the id)
 *                         → a NAMED conflict {id, reason: 'redacted-post'}: an older snapshot never brings removed text back
 *   absent, but its operation already has a receipt (the node was deleted, or a restore lost it)
 *                         → a NAMED conflict {id, reason: 'receipt-without-node'}: never silently recreated
 * `--limit N` stops after N posts written (a deterministic interruption; a later run resumes).
 *
 * LOSSLESS OR REFUSED. The settled fields (#1574 U1–U4) are copied: id, body, author, createdAt, attachedTo, mentions,
 * the stored postSeq, the talk tag, the DECLARED onBehalfOf (a literal, never proof), _recovered, opId, origin
 * {mutationId, slot[, occurredAt]} and attachments (one node each, by index; the bytes stay on disk). A post carrying
 * anything else (the author-correction trail, `reach`, an origin with another key, an attachment with another field,
 * any unknown key) refuses the WHOLE run before any write, naming the posts and keys, never their values.
 *
 * R0 never numbers a post. An un-migrated board (no epoch) or a corrupt one is refused.
 *
 * Summary: the LAST stdout line, one JSON object {posts, written, alreadyPresent, conflicts, failed}.
 * Exit: 0 complete · 3 refused (POST_SEQ_MIGRATION_REQUIRED, POST_SEQ_STATE_CORRUPT, UNSUPPORTED_POST_FIELDS) ·
 *       4 complete with conflicts · 2 an operational failure (bad arguments, wrong dataset, unreachable executor, a
 *       write that did not apply).
 */
import { boardFileProblem } from '../core/board-file-guard.mjs';
import { loadDomain } from '../core/store.mjs';
import { domainToBoard } from '../core/mapping.mjs';
import { postSeqState } from '../core/post-seq.mjs';
import { createGraphClient } from '../core/graph-client.mjs';

const ENTITY = 'https://scrumboard.local/entity/';
const PERSON = 'https://scrumboard.local/person/';
const SCHEMA = 'https://schema.org/';
const NS = 'https://scrumboard.local/ns#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD_INT = 'http://www.w3.org/2001/XMLSchema#integer';

// The settled fields (#1574 U1–U4, the owner's "go with your proposal"). A key not here refuses the run; so does a settled
// key whose VALUE has a shape the vocabulary does not cover (an origin with an extra key, an attachment with an extra field).
const SETTLED = new Set(['id', 'body', 'author', 'createdAt', 'attachedTo', 'mentions', 'postSeq', 'conversation', 'onBehalfOf', '_recovered', 'opId', 'origin', 'attachments',
  // #1574 U5 (decision f4940204) — the August author-repair trail: provenance strings, stored as literals, never an actor
  '_originalAuthorToken', '_authorCorrectedAt', '_authorCorrectedBy']);
const isStr = (v) => typeof v === 'string';
const SHAPE_OK = {
  origin: (v) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every((k) => ['mutationId', 'slot', 'occurredAt'].includes(k)) && isStr(v.mutationId) && isStr(v.slot) && (v.occurredAt === undefined || isStr(v.occurredAt)),
  attachments: (v) => Array.isArray(v) && v.every((a) => a && typeof a === 'object' && Object.keys(a).sort().join() === 'id,mime,name,size' && isStr(a.id) && isStr(a.mime) && isStr(a.name) && Number.isSafeInteger(a.size) && a.size >= 0),
  onBehalfOf: (v) => v === null || isStr(v),
  conversation: (v) => isStr(v) && v.length > 0,
  _recovered: isStr, opId: isStr,
  _originalAuthorToken: isStr, _authorCorrectedAt: isStr, _authorCorrectedBy: isStr,
};

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const FILE = opt('--board-file');
const URL_ = opt('--executor-url');
const DATASET = opt('--dataset-id');
const LIMIT = opt('--limit') == null ? Infinity : Number(opt('--limit'));

const summary = { posts: 0, written: 0, alreadyPresent: 0, conflicts: [], failed: 0 };
const finish = (code, message) => {
  if (message) console.error(message);
  console.log(JSON.stringify(summary));
  process.exit(code);
};

if (!FILE || !URL_ || !DATASET || !(LIMIT === Infinity || (Number.isSafeInteger(LIMIT) && LIMIT >= 0))) {
  finish(2, 'usage: node scripts/backfill-posts-r0.mjs --board-file <board.json> --executor-url <url> --dataset-id <id> [--limit N]');
}

// #1574 G1–G3 — a missing, empty or non-board file is REFUSED, never read as an empty board
const fileProblem = boardFileProblem(FILE);
if (fileProblem) finish(2, fileProblem);

let board;
try { board = domainToBoard(loadDomain(FILE)); } catch (e) { finish(2, `cannot read ${FILE}: ${e.message}`); }
const posts = Array.isArray(board.conversations) ? board.conversations : [];
summary.posts = posts.length;

// ── refusals, before anything is sent ──
const st = postSeqState(board);
if (st.state === 'corrupt') finish(3, `POST_SEQ_STATE_CORRUPT: ${st.reason}; nothing was written`);
if (st.state === 'clean') finish(3, 'POST_SEQ_MIGRATION_REQUIRED: the board has posts but no post sequence; run scripts/migrate-post-seq-1592.mjs on the stopped board first. Nothing was written.');

const unsupported = [];
for (const p of posts) {
  const extra = Object.keys(p).filter((k) => !SETTLED.has(k) || (SHAPE_OK[k] && !SHAPE_OK[k](p[k])));
  if (extra.length) unsupported.push(`${p.id}: ${extra.join(', ')}`);
}
if (unsupported.length) {
  finish(3, `UNSUPPORTED_POST_FIELDS: ${unsupported.length} post(s) carry fields whose graph shape is not settled; nothing was written, because copying them would drop data.\n  ${unsupported.join('\n  ')}`);   // every id: the refusal is the inventory
}

// ── the executor ──
const client = createGraphClient({ baseUrl: URL_, expectedDatasetId: DATASET, timeoutMs: 60000 });
const ident = await client.datasetIdentity();
if (!ident.ok) finish(2, `executor not usable (${ident.reason}); nothing was written`);

// #1574 U5 — document key → graph predicate (under NS) for the author-repair trail
const TRAIL = [['_originalAuthorToken', 'originalAuthorToken'], ['_authorCorrectedAt', 'authorCorrectedAt'], ['_authorCorrectedBy', 'authorCorrectedBy']];

/** The triples a post must carry, as sorted "predicate\ttype|value|datatype" lines (the provenance link is bookkeeping, in its own graph: #1638). */
function expected(p) {
  const rows = [
    `${RDF_TYPE}\turi|${SCHEMA}Comment|`,
    `${SCHEMA}text\tliteral|${p.body}|`,
    `${SCHEMA}author\turi|${PERSON}${p.author}|`,
    `${SCHEMA}dateCreated\tliteral|${p.createdAt}|`,
    `${NS}postSeq\tliteral|${p.postSeq}|${XSD_INT}`,
  ];
  if (p.attachedTo) rows.push(`${SCHEMA}about\turi|${ENTITY}${p.attachedTo}|`);
  if (p.conversation !== undefined) rows.push(`${NS}conversation\turi|https://scrumboard.local/talk/${p.conversation}|`);
  if (p.onBehalfOf != null) rows.push(`${NS}onBehalfOf\tliteral|${p.onBehalfOf}|`);
  if (p._recovered !== undefined) rows.push(`${NS}recovered\tliteral|${p._recovered}|`);
  if (p.opId !== undefined) rows.push(`${NS}opId\tliteral|${p.opId}|`);
  for (const [k, pred] of TRAIL) if (p[k] !== undefined) rows.push(`${NS}${pred}\tliteral|${p[k]}|`);
  if (p.origin !== undefined) {
    rows.push(`${NS}originMutation\tliteral|${p.origin.mutationId}|`, `${NS}originSlot\tliteral|${p.origin.slot}|`);
    if (p.origin.occurredAt !== undefined) rows.push(`${NS}originOccurredAt\tliteral|${p.origin.occurredAt}|`);
  }
  // the graph holds mentions as a SET: a repeated name is one triple, so compare against the set, or a resume would
  // call an identical post a conflict
  for (const m of new Set(p.mentions || [])) rows.push(`${NS}mentionsName\tliteral|${m}|`);
  return rows.sort();
}

/** The attachment nodes a post must have, as sorted "index\tpredicate\tterm" lines. */
function expectedAttachments(p) {
  const rows = [];
  (p.attachments || []).forEach((a, k) => rows.push(
    `${k}\t${NS}attachmentOf\turi|${ENTITY}${p.id}|`, `${k}\t${NS}attachmentIndex\tliteral|${k}|${XSD_INT}`,
    `${k}\t${SCHEMA}identifier\tliteral|${a.id}|`, `${k}\t${SCHEMA}name\tliteral|${a.name}|`,
    `${k}\t${SCHEMA}encodingFormat\tliteral|${a.mime}|`, `${k}\t${SCHEMA}contentSize\tliteral|${a.size}|${XSD_INT}`));
  return rows.sort();
}

const existing = new Map();   // subject IRI → sorted triple lines (the provenance link lives in the bookkeeping graph, not read here)
const q = await client.query(`SELECT ?s ?p ?o WHERE { ?s <${RDF_TYPE}> <${SCHEMA}Comment> . ?s ?p ?o }`);
if (!q.ok) finish(2, `cannot read the graph's existing posts (${q.reason}); nothing was written`);
for (const b of q.rows) {
  const line = `${b.p.value}\t${b.o.type}|${b.o.value}|${b.o.datatype || ''}`;
  (existing.get(b.s.value) || existing.set(b.s.value, []).get(b.s.value)).push(line);
}
for (const v of existing.values()) v.sort();
// #1574 U1 — attachment nodes, grouped by the post they belong to; an attachment that changes, appears or disappears is a divergence
const existingAtt = new Map();   // post IRI → sorted "index\tpredicate\tterm" lines
const aq = await client.query(`SELECT ?a ?post ?p ?o WHERE { ?a <${NS}attachmentOf> ?post . ?a ?p ?o }`);
if (!aq.ok) finish(2, `cannot read the graph's existing attachments (${aq.reason}); nothing was written`);
for (const b of aq.rows) {
  const k = b.a.value.slice(b.a.value.lastIndexOf('/') + 1);
  (existingAtt.get(b.post.value) || existingAtt.set(b.post.value, []).get(b.post.value)).push(`${k}\t${b.p.value}\t${b.o.type}|${b.o.value}|${b.o.datatype || ''}`);
}
for (const v of existingAtt.values()) v.sort();
// #1574 R4a — a REDACTED post is a tombstone, never a Comment: an older snapshot that still holds its text must not bring it back
const redacted = new Set();
const rq = await client.query(`SELECT ?s WHERE { ?s <${RDF_TYPE}> <${NS}RedactedPost> }`);
if (!rq.ok) finish(2, `cannot read the graph's redacted posts (${rq.reason}); nothing was written`);
for (const b of rq.rows) redacted.add(b.s.value);

for (const p of posts) {
  const iri = `${ENTITY}${p.id}`;
  const want = expected(p);
  if (redacted.has(iri)) { summary.conflicts.push({ id: p.id, reason: 'redacted-post' }); continue; }
  const have = existing.get(iri);
  if (have) {
    const wantA = expectedAttachments(p), haveA = existingAtt.get(iri) || [];
    const same = (x, y) => x.length === y.length && x.every((v, k) => v === y[k]);
    if (same(have, want) && same(haveA, wantA)) summary.alreadyPresent++;
    else summary.conflicts.push({ id: p.id, reason: 'content-differs' });
    continue;
  }
  if (summary.written >= LIMIT) break;
  const intention = {
    kind: 'post.import',
    opId: `urn:ex:op/backfill/${p.id}`,
    actor: `${PERSON}board`,
    post: { id: p.id, body: p.body, author: p.author, createdAt: p.createdAt, attachedTo: p.attachedTo ?? null, mentions: p.mentions || [], postSeq: p.postSeq,
      ...(p.conversation !== undefined ? { conversation: p.conversation } : {}), ...(p.onBehalfOf != null ? { onBehalfOf: p.onBehalfOf } : {}),
      ...(p._recovered !== undefined ? { recovered: p._recovered } : {}), ...(p.opId !== undefined ? { opId: p.opId } : {}),
      ...(p.origin !== undefined ? { origin: p.origin } : {}), ...((p.attachments || []).length ? { attachments: p.attachments } : {}),
      ...Object.fromEntries(TRAIL.filter(([k]) => p[k] !== undefined).map(([k, pred]) => [pred, p[k]])) },
  };
  // An absent node is not, by itself, permission to write: if this operation already has a receipt (the node was
  // deleted, or a restore lost it), a replay would not bring it back and a write would be refused anyway. Name it.
  const rec = await client.reconcile(intention);
  if (rec.outcome !== 'ABSENT') {
    if (rec.outcome === 'UNKNOWN') finish(2, `post ${p.id}: cannot read its receipt (${rec.reason}); stopped. Re-run to resume.`);
    summary.conflicts.push({ id: p.id, reason: 'receipt-without-node' });
    continue;
  }
  const r = await client.update(intention);
  if (r.outcome !== 'APPLIED') {
    summary.failed++;
    finish(2, `post ${p.id}: the write did not apply (${r.outcome}${r.reason ? `: ${r.reason}` : ''}); stopped. Re-run to resume: what is already in the graph is skipped.`);
  }
  summary.written++;
}

finish(summary.conflicts.length ? 4 : 0);
