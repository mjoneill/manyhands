#!/usr/bin/env node
/**
 * #1747 step 4 — import the frozen document's post-sequence and announcement state into ONE isolated, marked candidate.
 * Contract v2 §6 step 4: "Import all original reservations (including U3), origin/entries and frozen fields without minting
 * numbers, posts or publication receipts. nextPostSeq and postSeqEpoch are preserved; verify nextPostSeq exceeds posts,
 * tombstones AND reservations. Duplicate numbers/identities, invalid high-water, orphan/missing/mode/digest disagreement
 * cause a named HOLD; do not raise or rewrite values silently to produce a clean report."
 *
 *   node scripts/cutover-import-1629.mjs --board-data <frozen document> --executor <candidate url> --dataset <id>
 *        --outbox-manifest <entries.csv> --capture-manifest <capture.json> [--apply]
 *
 * OUTPUT (the rows read it): first `MIGRATION <64 hex>`, then exactly one of
 *   COMPLETE                      every imported record read back, typed, exactly          exit 0
 *   PLAN <counts>                 a dry run that would import (nothing written)             exit 0
 *   INCOMPLETE <id> <field> …     a read-back differs from what the import wrote            exit 1
 *   HOLD <CODE> <why>             the source state itself is unsound; nothing written       exit 2
 *   REFUSED <CODE> <why>          the run's inputs or target are wrong; nothing written     exit 3
 *
 * NEVER: writes the document, mints a postSeq or a post, writes a publication receipt, calls a notify endpoint, or touches
 * a store that is not the marked candidate. A refusal or a hold happens before the first write.
 *
 * WRITES: ordered batches, each ONE guarded /update carrying its data AND its batch marker
 * <urn:ex:cutover/migration/<id>/batch/<n>> (digest of the batch's triples), inserted only while that marker is absent.
 * A rerun skips a batch whose marker exists with the same digest and refuses one with another digest. Batch 1 is the
 * allocator plus every reservation; batch 2 is every origin and obligation.
 * TEST SEAM: SCRUM_CUTOVER_CRASH_AFTER_APPLY=<n>, read once at startup, SIGKILLs this process right after batch n applies.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { BOOKKEEPING_GRAPH, POSTSEQ_TERMS, ORIGIN_TERMS, POSTSEQ_NS, ORIGIN_NS } from '../core/graph-vocab.mjs';
import { announcePostId } from '../core/announce-outbox.mjs';
import { columnIdOf } from '../core/jsonld.mjs';

const SCHEMA_VERSION = 'cutover-import-1629/v1';
const CRASH_AFTER = Number(process.env.SCRUM_CUTOVER_CRASH_AFTER_APPLY || 0);   // test seam; 0 = off
const BK = BOOKKEEPING_GRAPH;
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const NS = 'https://scrumboard.local/ns#';
const SCHEMA = 'https://schema.org/';
const ENTITY = 'https://scrumboard.local/entity/';
const PERSON = 'https://scrumboard.local/person/';
const CANDIDATE_MARKER = 'urn:ex:cutover/candidate';
const P_MANIFEST_SHA = 'urn:ex:cutover/captureManifestSha256';
const BATCH = (id, n) => `urn:ex:cutover/migration/${id}/batch/${n}`;
const P_BATCH_DIGEST = 'urn:ex:cutover/batchDigest';
const T = {   // #1747 terms (46155), all in the bookkeeping graph
  legacyKey: `${POSTSEQ_NS}legacyKey`, sourceApplied: `${POSTSEQ_NS}sourceApplied`,
  // the EXACT captured reservation, because the store canonicalises xsd:dateTime ("…10.000Z" reads back "…10Z", measured on
  // pyoxigraph): the typed mirror keeps the instant, this keeps the frozen lexical form (proposed term, for review)
  sourceReservationJson: `${POSTSEQ_NS}sourceReservationJson`,
  sourceEntryJson: `${ORIGIN_NS}sourceEntryJson`, sourceOriginJson: `${ORIGIN_NS}sourceOriginJson`,
  retirementReason: `${ORIGIN_NS}retirementReason`, retirementProofPostId: `${ORIGIN_NS}retirementProofPostId`,
  notifyDisposition: `${ORIGIN_NS}notifyDisposition`, notifyDispositionNote: `${ORIGIN_NS}notifyDispositionNote`,
  migrationId: `${ORIGIN_NS}migrationId`,
};
const DOC_KEYS = new Set(['@context', '@graph', '_README', '_labelAliases', 'scrum:meta']);
const META_KEYS = new Set(['announcementOutbox', 'lastUpdated', 'nextPostSeq', 'nextShortId', 'postReservations', 'postSeqEpoch', 'seatStates']);
const CLASSES = new Set(['retire-with-proof', 'dispatch-evidenced', 'disposed-not-sent']);

// output is written SYNCHRONOUSLY: the crash seam SIGKILLs the process, and an async pipe write could be lost with it
const say = (line) => fs.writeSync(1, `${line}\n`);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const APPLY = process.argv.includes('--apply');
class Stop extends Error { constructor(kind, code, why) { super(`${kind} ${code} ${why}`); this.kind = kind; this.code = code; } }
const hold = (code, why) => { throw new Stop('HOLD', code, why); };
const refuse = (code, why) => { throw new Stop('REFUSED', code, why); };
const lit = (s) => JSON.stringify(String(s));
const typedLit = (v, dt) => `${lit(v)}^^<${XSD}${dt}>`;
const iri = (s) => (s.startsWith('<') ? s : `<${s}>`);

async function main() {
  const docFile = arg('--board-data'), base = String(arg('--executor') || '').replace(/\/+$/, ''), dataset = arg('--dataset');
  const outboxFile = arg('--outbox-manifest'), captureFile = arg('--capture-manifest');
  if (!docFile || !base || !dataset || !outboxFile || !captureFile) {
    say('REFUSED USAGE --board-data --executor --dataset --outbox-manifest --capture-manifest [--apply]'); return 3;
  }
  const docBytes = fs.readFileSync(docFile), outboxBytes = fs.readFileSync(outboxFile), captureBytes = fs.readFileSync(captureFile);
  const captureSha = sha(captureBytes);
  // deterministic: the same inputs give the same id (S4-0); any changed input gives another
  const id = sha([SCHEMA_VERSION, captureSha, sha(docBytes), sha(outboxBytes)].join('\n'));
  say(`MIGRATION ${id}`);
  try {
    const out = await run({ id, base, dataset, docBytes, outboxBytes, captureBytes, captureSha, docFile, outboxFile });
    say(out); return out === 'COMPLETE' || out.startsWith('PLAN') ? 0 : 1;
  } catch (e) {
    if (e instanceof Stop) { say(e.message); return e.kind === 'HOLD' ? 2 : 3; }
    say(`REFUSED ERROR ${String(e?.message || e).slice(0, 300)}`); return 3;
  }
}

function executor(base, label) {
  let epoch = null;
  const health = async () => (await fetch(`${base}/health`)).json();
  const query = async (sparql) => {
    const r = await fetch(`${base}/query`, { method: 'POST', headers: { 'x-op-id': `urn:ex:op/cutover/read/${label}` }, body: sparql });
    if (!r.ok) refuse('UNAVAILABLE', `query ${r.status}: ${(await r.text()).slice(0, 160)}`);
    return (await r.json()).results.bindings;
  };
  const update = async (sparql, op) => {
    if (epoch == null) epoch = String((await health()).epoch);
    const r = await fetch(`${base}/update`, { method: 'POST', body: sparql, headers: { 'x-op-id': op, 'x-epoch': epoch, 'content-type': 'application/sparql-update' } });
    if (!r.ok) refuse('WRITE_FAILED', `${op}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  };
  return { health, query, update };
}

async function run({ id, base, dataset, docBytes, outboxBytes, captureBytes, captureSha }) {
  const capture = JSON.parse(captureBytes.toString('utf8'));
  const X = executor(base, id);
  const h = await X.health();
  const realOr = (p) => { try { return fs.realpathSync(p); } catch { return p; } };

  // ── 1. binding (#1747 v1 + v26): the target is THE marked, promoted copy of THIS capture, and the source is unchanged ──
  if (h.datasetId !== dataset || h.datasetId !== capture.datasetId) refuse('NOT_CANDIDATE', `dataset ${h.datasetId}, expected ${dataset}`);
  if (!h.incarnationFrom || !h.incarnation || h.incarnation === h.incarnationFrom) refuse('NOT_CANDIDATE', 'the target is not a promoted copy (no new incarnation)');
  if (capture.incarnation && h.incarnationFrom !== capture.incarnation) refuse('NOT_CANDIDATE', `promoted from ${h.incarnationFrom}, not the captured ${capture.incarnation}`);
  if (!h.storeHome || realOr(h.storeHome) === realOr(capture.sourceStore)) refuse('NOT_CANDIDATE', 'the target store IS the source store');
  const marks = (await X.query(`SELECT ?v WHERE { GRAPH <${BK}> { <${CANDIDATE_MARKER}> <${P_MANIFEST_SHA}> ?v } }`)).map((b) => b.v.value);
  if (!marks.length) refuse('MARKER_MISSING', 'the candidate carries no CandidateMarker (step 3 not run)');
  if (marks.length !== 1 || marks[0] !== captureSha) refuse('MARKER_MISMATCH', `the candidate is marked for ${marks.join(', ')}, not this capture ${captureSha}`);
  if (capture.documentSha256 !== sha(docBytes)) refuse('SOURCE_CHANGED', 'the document is not the one captured');
  if (capture.outboxManifestSha256 && capture.outboxManifestSha256 !== sha(outboxBytes)) refuse('SOURCE_CHANGED', 'the outbox manifest is not the one captured');
  const sourceChanged = () => {
    const now = fs.readdirSync(capture.sourceStore).sort().map((n) => { const b = fs.readFileSync(`${capture.sourceStore}/${n}`); return `${n} ${b.length} ${sha(b)}`; });
    const then = (capture.files || []).map((f) => `${f.name} ${f.size} ${f.sha256}`).sort();
    return JSON.stringify(now) !== JSON.stringify(then);
  };
  if (sourceChanged()) refuse('SOURCE_CHANGED', 'a source store file differs from the capture (a writer ran)');

  // ── 2. the document: every key accounted for, the allocator sound ──
  const doc = JSON.parse(docBytes.toString('utf8'));
  for (const k of Object.keys(doc)) if (!DOC_KEYS.has(k)) refuse('UNKNOWN_KEY', `document key ${k}`);
  const meta = doc['scrum:meta'] || {};
  for (const k of Object.keys(meta)) if (!META_KEYS.has(k)) refuse('UNKNOWN_KEY', `scrum:meta.${k}`);
  if (Array.isArray(meta.seatStates) && meta.seatStates.length) hold('SEATSTATES_UNPROVEN', `${meta.seatStates.length} legacy seatStates item(s); obsolescence not proven (#1743)`);
  const next = meta.nextPostSeq, epoch = meta.postSeqEpoch;
  if (typeof next !== 'number' || !Number.isSafeInteger(next) || next < 1) hold('BAD_ALLOCATOR', `nextPostSeq ${JSON.stringify(next)} is not a positive safe integer`);
  if (typeof epoch !== 'string' || !epoch) hold('BAD_ALLOCATOR', 'postSeqEpoch missing');

  // R4: the ORIGINAL record is kept apart from its map key, so a record carrying its own `key` field can't overwrite it
  const reservations = Object.entries(meta.postReservations || {}).map(([key, rec]) => ({ key, rec, postId: rec?.postId, postSeq: rec?.postSeq, createdAt: rec?.createdAt, applied: rec?.applied }));
  const bySeq = new Map(), byId = new Map();
  for (const r of reservations) {
    if (!r.rec || typeof r.rec !== 'object' || !Number.isSafeInteger(r.postSeq) || r.postSeq < 1 || typeof r.postId !== 'string' || !r.postId
      || typeof r.createdAt !== 'string' || Number.isNaN(Date.parse(r.createdAt))) hold('BAD_RESERVATION', `reservation ${r.key} is malformed (postSeq must be a positive safe integer, createdAt a valid time)`);
    if (bySeq.has(r.postSeq)) hold('DUPLICATE_SEQ', `postSeq ${r.postSeq} is held by ${bySeq.get(r.postSeq)} and ${r.key}`);
    if (byId.has(r.postId)) hold('DUPLICATE_ID', `postId ${r.postId} is reserved under ${byId.get(r.postId)} and ${r.key}`);
    bySeq.set(r.postSeq, r.key); byId.set(r.postId, r.key);
  }

  const ob = meta.announcementOutbox || { origins: {}, entries: {} };
  const origins = ob.origins || {}, entries = ob.entries || {};
  for (const e of Object.values(entries)) {
    const o = origins[e.mutationId];
    if (!o) hold('ORPHAN_ENTRY', `${e.obligationId} has no origin`);
    if (o.mode !== e.mode) hold('MODE_DISAGREES', `${e.obligationId} is ${e.mode}, its origin is ${o.mode}`);
  }
  for (const [mid, o] of Object.entries(origins)) for (const slot of o.slots || []) {
    if (!entries[`${mid}:${slot}`]) hold('ORIGIN_WITHOUT_ENTRY', `origin ${mid} slot ${slot} has no entry`);
  }

  // ── 3. columns: the executor owns them (#1639); any unexplained difference is two sources of truth ──
  const docCols = (doc['@graph'] || []).filter((n) => n['@type'] === 'scrum:Column');
  for (const c of docCols) {
    const cid = columnIdOf(c['@id']);
    const rows = await X.query(`SELECT ?p ?o WHERE { ?s <${SCHEMA}identifier> ${lit(cid)} ; a ?t ; ?p ?o . FILTER(STRENDS(STR(?t), "Column")) }`);
    const got = Object.fromEntries(rows.map((b) => [b.p.value.replace(/^.*[#/]/, ''), b.o.value]));
    if (!rows.length) hold('COLUMN_DIFFERS', `column ${cid} is in the document but not in the candidate`);
    if (got.name !== c.name || String(got.order) !== String(c['scrum:order'] ?? c.order)) hold('COLUMN_DIFFERS', `column ${cid}: document ${c.name}/${c['scrum:order'] ?? c.order}, candidate ${got.name}/${got.order}`);
  }

  // ── 4. the high-water: nextPostSeq must exceed every post, tombstone and reservation the candidate or document holds ──
  const graphSeqs = (await X.query(`SELECT ?n WHERE { { ?s <${NS}postSeq> ?n } UNION { GRAPH ?g { ?s ?p ?n . FILTER(?p = <${NS}postSeq> || ?p = ${POSTSEQ_TERMS.postSeq}) } } }`)).map((b) => Number(b.n.value));
  const high = Math.max(0, ...graphSeqs, ...reservations.map((r) => r.postSeq));
  // R2: a number has at most ONE owner across graph posts and tombstones, the document's reservations and the publisher
  // entries' assignments. The same identity may appear in several (its post and its reservation); two identities may not.
  const owners = new Map();   // postSeq -> Set(postId)
  const own = (n, id, where) => {
    if (!Number.isSafeInteger(n) || n < 1) hold('BAD_POSTSEQ', `${where}: postSeq ${n} is not a positive safe integer`);
    if (!owners.has(n)) owners.set(n, new Set());
    owners.get(n).add(id);
    if (owners.get(n).size > 1) hold('DUPLICATE_SEQ', `postSeq ${n} has two owners: ${[...owners.get(n)].join(', ')} (${where})`);
  };
  const seqOf = new Map();    // postId -> postSeq: one identity has ONE number
  const pin = (id, n, where) => { if (seqOf.has(id) && seqOf.get(id) !== n) hold('ID_SEQ_MISMATCH', `${id} is ${seqOf.get(id)} in one place and ${n} in ${where}`); seqOf.set(id, n); };
  for (const b of await X.query(`SELECT ?s ?n WHERE { ?s <${NS}postSeq> ?n }`)) {
    const id = b.s.value.startsWith(ENTITY) ? b.s.value.slice(ENTITY.length) : b.s.value;
    const n = Number(b.n.value);
    own(n, id, 'graph'); pin(id, n, 'the graph');
  }
  for (const r of reservations) { own(r.postSeq, r.postId, `reservation ${r.key}`); pin(r.postId, r.postSeq, `reservation ${r.key}`); }
  for (const e of Object.values(entries)) if (e.mode === 'publisher' && e.postSeq !== undefined) {
    const id = announcePostId(e.mutationId, e.slot);
    own(e.postSeq, id, `entry ${e.obligationId}`); pin(id, e.postSeq, `entry ${e.obligationId}`);
  }
  if (high >= next) hold('HIGH_WATER', `nextPostSeq ${next} is not above the high-water ${high}`);

  // ── 5. the outbox manifest: every pending entry has exactly one disposition; every proof joins ──
  const rows = parseCsv(outboxBytes.toString('utf8'));
  const pending = Object.values(entries).filter((e) => e.status === 'pending');
  const byOb = new Map();
  for (const r of rows) {
    if (!r.obligationId) refuse('MANIFEST_MALFORMED', 'a row with no obligationId');
    if (byOb.has(r.obligationId)) refuse('MANIFEST_DUPLICATE', `${r.obligationId} has more than one row: one obligation, one disposition`);
    byOb.set(r.obligationId, r);
  }
  for (const r of rows) if (!pending.some((e) => e.obligationId === r.obligationId)) refuse('MANIFEST_UNKNOWN', `${r.obligationId} names no pending entry`);
  const plan = [];
  for (const e of pending) {
    const r = byOb.get(e.obligationId);
    if (!r) refuse('MANIFEST_MISSING', `${e.obligationId} is pending and not in the manifest`);
    if (!r.class) refuse('PENDING_UNDISPOSED', `${e.obligationId} has no disposition`);
    if (!CLASSES.has(r.class)) refuse('PENDING_UNDISPOSED', `${e.obligationId}: unknown class ${r.class}`);
    // The proof post: a LEGACY entry names its own post (legacyPostId). Measured on a copy of prod: legacy posts were written by
    // the document path under their own ids, NOT announcePostId(mutationId, slot). A publisher entry's post is the derived id.
    // Either way the field join below must hold, so a pointer to another announcement fails on originMutation/slot.
    if (e.mode === 'legacy' && (typeof e.legacyPostId !== 'string' || !e.legacyPostId)) refuse('PROOF_MISSING', `${e.obligationId}: a legacy entry with no legacyPostId`);
    const postId = e.mode === 'legacy' ? e.legacyPostId : announcePostId(e.mutationId, e.slot);
    if (r.kind !== undefined && r.kind !== e.mode && r.kind !== `${e.mode}/${e.slot}`) refuse('PROOF_MISMATCH', `${e.obligationId}: the manifest says kind ${r.kind}, the entry is ${e.mode}/${e.slot}`);
    if (r.createdAt !== undefined && r.createdAt !== (e.payload || {}).occurredAt) refuse('PROOF_MISMATCH', `${e.obligationId}: the manifest's createdAt ${r.createdAt} is not the entry's occurredAt`);
    if (r.matchedPostId && r.matchedPostId !== postId) refuse('PROOF_MISMATCH', `${e.obligationId}: the manifest's matchedPostId ${r.matchedPostId} is not the entry's post ${postId}`);
    const post = await readPost(X, postId);
    if (!post) refuse('PROOF_MISSING', `${e.obligationId}: post ${postId} is not in the candidate`);
    const p = e.payload || {};
    // The join is the board's OWN settlement rule (core/announce-outbox.mjs postMatchesEntry: author, body, origin mutation and
    // slot against the ENTRY), plus mentions, plus the payload agreeing with its entry. A legacy post was written by the
    // document path and carries no originActor or originOccurredAt (measured on a copy of prod: its dateCreated is not the
    // payload's occurredAt), so those two are joined only for PUBLISHER posts, which the executor path writes with both.
    if (p.mutationId !== e.mutationId || p.slot !== e.slot) refuse('PROOF_MISMATCH', `${e.obligationId}: the payload names ${p.mutationId}/${p.slot}, the entry ${e.mutationId}/${e.slot}`);
    const want = { body: p.body, author: `${PERSON}${p.author}`, mentions: JSON.stringify([...(p.mentions || [])].sort()), originMutation: e.mutationId, originSlot: e.slot,
      ...(e.mode === 'publisher' ? { originActor: `${PERSON}${p.originActor}`, occurredAt: p.occurredAt } : {}) };
    for (const [f, v] of Object.entries(want)) if (post[f] !== v) refuse('PROOF_MISMATCH', `${e.obligationId}: the post's ${f} is ${JSON.stringify(post[f])}, the entry says ${JSON.stringify(v)}`);
    if (e.mode === 'legacy') {
      if (r.class !== 'retire-with-proof') refuse('PENDING_UNDISPOSED', `${e.obligationId}: a legacy entry retires with proof, not ${r.class}`);
      plan.push({ e, postId, reason: 'legacy-post-verified' });
    } else {
      // a matching post proves PUBLICATION, not DISPATCH (#1745 v4): the notify obligation needs its own disposition
      if (r.class === 'dispatch-evidenced') refuse('DISPATCH_UNBOUND', `${e.obligationId}: no dispatch evidence format is bound to an obligation yet`);
      if (r.class !== 'disposed-not-sent' || !r.note) refuse('PENDING_UNDISPOSED', `${e.obligationId}: a publisher entry needs disposed-not-sent with a note`);
      plan.push({ e, postId, reason: 'publisher-dispatch-disposed', disposition: 'disposed-not-sent', note: r.note });
    }
  }

  // ── 6. the batches (data + marker in ONE guarded update each) ──
  const mig = lit(id);
  const b1 = [
    `${POSTSEQ_TERMS.allocator} a ${POSTSEQ_TERMS.Allocator} ; ${POSTSEQ_TERMS.postSeqEpoch} ${lit(epoch)} ; ${POSTSEQ_TERMS.nextPostSeq} ${typedLit(next, 'integer')} ; ${POSTSEQ_TERMS.version} ${typedLit(1, 'integer')} ; <${T.migrationId}> ${mig} .`,
    ...reservations.map((r) => {
      const s = POSTSEQ_TERMS.reservation(r.postId);
      return `${s} a ${POSTSEQ_TERMS.Reservation} ; ${POSTSEQ_TERMS.postId} ${lit(r.postId)} ; ${POSTSEQ_TERMS.postSeq} ${typedLit(r.postSeq, 'integer')} ; ${POSTSEQ_TERMS.createdAt} ${typedLit(r.createdAt, 'dateTime')} ; <${T.legacyKey}> ${lit(r.key)} ; <${T.sourceReservationJson}> ${lit(canonicalJson({ [r.key]: r.rec }))}${typeof r.applied === 'boolean' ? ` ; <${T.sourceApplied}> ${typedLit(r.applied, 'boolean')}` : ''} ; <${T.migrationId}> ${mig} .`;
    }),
  ];
  const b2 = [];
  for (const [mid, o] of Object.entries(origins)) {
    b2.push(`${ORIGIN_TERMS.originSubject(mid)} a ${ORIGIN_TERMS.Origin} ; ${ORIGIN_TERMS.mutationId} ${lit(mid)} ; ${ORIGIN_TERMS.mode} ${lit(o.mode)} ; ${ORIGIN_TERMS.originActor} ${lit(o.originActor)} ; ${ORIGIN_TERMS.occurredAt} ${typedLit(o.occurredAt, 'dateTime')} ; ${ORIGIN_TERMS.committedAt} ${typedLit(o.committedAt, 'dateTime')} ; ${ORIGIN_TERMS.slotCount} ${typedLit((o.slots || []).length, 'integer')} ; <${T.sourceOriginJson}> ${lit(canonicalJson(o))} ; <${T.migrationId}> ${mig} .`);
  }
  for (const e of Object.values(entries)) {
    const p = plan.find((x) => x.e.obligationId === e.obligationId);
    const status = p ? 'published' : e.status;
    const extra = p ? ` ; <${T.retirementReason}> ${lit(p.reason)} ; <${T.retirementProofPostId}> ${lit(p.postId)}${p.disposition ? ` ; <${T.notifyDisposition}> ${lit(p.disposition)} ; <${T.notifyDispositionNote}> ${lit(p.note)}` : ''}` : '';
    b2.push(`${ORIGIN_TERMS.obligationSubject(e.mutationId, e.slot)} a ${ORIGIN_TERMS.Obligation} ; ${ORIGIN_TERMS.obligationId} ${lit(e.obligationId)} ; ${ORIGIN_TERMS.slot} ${lit(e.slot)} ; ${ORIGIN_TERMS.mode} ${lit(e.mode)} ; ${ORIGIN_TERMS.status} ${lit(status)}${extra} ; <${T.sourceEntryJson}> ${lit(canonicalJson(e))} ; <${T.migrationId}> ${mig} .`);
  }
  const batches = [b1, b2];

  // an allocator that THIS migration did not write is refused, never overwritten (#1747, interface v1)
  const alloc = await X.query(`SELECT ?m WHERE { GRAPH <${BK}> { ${POSTSEQ_TERMS.allocator} ?p ?o . OPTIONAL { ${POSTSEQ_TERMS.allocator} <${T.migrationId}> ?m } } }`);
  if (alloc.length && !alloc.some((b) => b.m?.value === id)) refuse('ALLOCATOR_PRESENT', 'the candidate already has an allocator this migration did not write');
  if (alloc.length) {
    // this migration's own allocator must still carry EXACTLY the document's values: a matching id is not a matching state
    const vals = await X.query(`SELECT ?p ?o WHERE { GRAPH <${BK}> { ${POSTSEQ_TERMS.allocator} ?p ?o } }`);
    const of = (p) => vals.filter((b) => `<${b.p.value}>` === p).map((b) => `${b.o.value}|${b.o.datatype || ''}`).sort();
    const want = { [POSTSEQ_TERMS.nextPostSeq]: [`${next}|${XSD}integer`], [POSTSEQ_TERMS.postSeqEpoch]: [`${epoch}|`], [POSTSEQ_TERMS.version]: [`1|${XSD}integer`] };
    for (const [p, w] of Object.entries(want)) if (JSON.stringify(of(p)) !== JSON.stringify(w)) refuse('ALLOCATOR_MISMATCH', `this migration's allocator holds ${p} ${JSON.stringify(of(p))}, the document says ${JSON.stringify(w)}`);
  }

  if (!APPLY) return `PLAN reservations=${reservations.length} origins=${Object.keys(origins).length} entries=${Object.keys(entries).length} retire=${plan.length} next=${next}`;

  for (let n = 1; n <= batches.length; n++) {
    const triples = batches[n - 1].join('\n');
    const digest = sha(triples);
    const have = (await X.query(`SELECT ?d WHERE { GRAPH <${BK}> { <${BATCH(id, n)}> <${P_BATCH_DIGEST}> ?d } }`)).map((b) => b.d.value);
    if (have.length && (have.length !== 1 || have[0] !== digest)) refuse('BATCH_MISMATCH', `batch ${n} was written with another digest`);
    if (!have.length) {
      if (sourceChanged()) refuse('SOURCE_CHANGED', `a source store file changed before batch ${n}`);
      await X.update(`INSERT { GRAPH <${BK}> { ${triples}\n<${BATCH(id, n)}> <${P_BATCH_DIGEST}> ${lit(digest)} . } } WHERE { FILTER NOT EXISTS { GRAPH <${BK}> { <${BATCH(id, n)}> <${P_BATCH_DIGEST}> ?any } } }`,
        `urn:ex:op/cutover/${id}/batch/${n}`);
      if (CRASH_AFTER === n) process.kill(process.pid, 'SIGKILL');
    }
  }

  // ── 7. read-back: every imported value, typed, exactly; anything else is INCOMPLETE, named ──
  const bad = [];
  const expect = async (subject, pred, value, datatype, label) => {
    // an xsd:dateTime compares by INSTANT: the store canonicalises its lexical form, and the exact form is kept in the source JSON
    const norm = (v, dt) => (dt === `${XSD}dateTime` ? `${Date.parse(v)}|${dt}` : `${v}|${dt}`);
    const got = (await X.query(`SELECT ?v WHERE { GRAPH <${BK}> { ${iri(subject)} ${iri(pred)} ?v } }`)).map((b) => norm(b.v.value, b.v.datatype || ''));
    const want = value === undefined ? [] : [norm(value, datatype ? `${XSD}${datatype}` : '')];
    if (JSON.stringify(got) !== JSON.stringify(want)) bad.push(`${label} ${pred.replace(/^.*[#/]/, '').replace(/>$/, '')}`);
  };
  await expect(POSTSEQ_TERMS.allocator, POSTSEQ_TERMS.nextPostSeq, String(next), 'integer', 'allocator');
  await expect(POSTSEQ_TERMS.allocator, POSTSEQ_TERMS.postSeqEpoch, epoch, null, 'allocator');
  for (const r of reservations) {
    const s = POSTSEQ_TERMS.reservation(r.postId);
    await expect(s, POSTSEQ_TERMS.postId, r.postId, null, r.postId);
    await expect(s, POSTSEQ_TERMS.postSeq, String(r.postSeq), 'integer', r.postId);
    await expect(s, POSTSEQ_TERMS.createdAt, r.createdAt, 'dateTime', r.postId);
    await expect(s, T.legacyKey, r.key, null, r.postId);
    await expect(s, T.sourceReservationJson, canonicalJson({ [r.key]: r.rec }), null, r.postId);
    await expect(s, T.sourceApplied, typeof r.applied === 'boolean' ? String(r.applied) : undefined, 'boolean', r.postId);
  }
  for (const [mid, o] of Object.entries(origins)) {
    const s = ORIGIN_TERMS.originSubject(mid);
    await expect(s, ORIGIN_TERMS.mode, o.mode, null, mid);
    await expect(s, ORIGIN_TERMS.occurredAt, o.occurredAt, 'dateTime', mid);
    await expect(s, ORIGIN_TERMS.committedAt, o.committedAt, 'dateTime', mid);
    await expect(s, T.sourceOriginJson, canonicalJson(o), null, mid);
  }
  for (const e of Object.values(entries)) {
    const s = ORIGIN_TERMS.obligationSubject(e.mutationId, e.slot);
    const p = plan.find((x) => x.e.obligationId === e.obligationId);
    await expect(s, ORIGIN_TERMS.status, p ? 'published' : e.status, null, e.obligationId);
    await expect(s, T.retirementProofPostId, p?.postId, null, e.obligationId);
    await expect(s, T.notifyDisposition, p?.disposition, null, e.obligationId);
    await expect(s, T.sourceEntryJson, canonicalJson(e), null, e.obligationId);
  }
  return bad.length ? `INCOMPLETE ${bad.join(' ')}` : 'COMPLETE';
}

/** The announcement post's fields as the proof join compares them; null if the post is absent or is a tombstone. */
async function readPost(X, postId) {
  const rows = await X.query(`SELECT ?p ?o WHERE { <${ENTITY}${postId}> ?p ?o }`);
  if (!rows.length) return null;
  const one = (p) => rows.find((b) => b.p.value === p)?.o.value;
  if (rows.some((b) => b.p.value === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' && b.o.value.endsWith('RedactedPost'))) return null;
  return {
    body: one(`${SCHEMA}text`), author: one(`${SCHEMA}author`), originActor: one(`${NS}originActor`), occurredAt: one(`${NS}originOccurredAt`),
    mentions: JSON.stringify(rows.filter((b) => b.p.value === `${NS}mentionsName`).map((b) => b.o.value).sort()),
    originMutation: one(`${NS}originMutation`), originSlot: one(`${NS}originSlot`),
  };
}

/**
 * The canonical form of a captured source record (#1747's settled rule): object keys sorted recursively in JS string order,
 * array order and every scalar kept exactly (no trimming or normalisation), serialised once. An unsupported value (undefined,
 * a function, a non-finite number, a bigint) is REFUSED, never coerced. Canonical JSON makes no claim of byte identity with
 * the source file's whitespace; the file's own digest is in the capture manifest.
 */
function canonicalJson(v) {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
  if (typeof v === 'number') { if (!Number.isFinite(v)) refuse('UNSUPPORTED_VALUE', 'a non-finite number in a source record'); return JSON.stringify(v); }
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  refuse('UNSUPPORTED_VALUE', `a ${typeof v} in a source record`);
}

/**
 * #1745's manifest, read as RFC 4180 RECORDS (not physical lines): CRLF or LF ends a record; a quoted field may hold commas,
 * quotes ("" escapes) and line breaks. Every record must have exactly the header's field count. The header must name each
 * column once, from a known set, with obligationId and class present. Anything else is REFUSED MANIFEST_MALFORMED: guessing
 * where a field ends would silently store a truncated or merged disposition.
 */
const MANIFEST_COLUMNS = new Set(['obligationId', 'kind', 'createdAt', 'matchedPostId', 'class', 'note']);
function parseCsv(text) {
  const records = csvRecords(text);
  if (!records.length) refuse('MANIFEST_MALFORMED', 'the manifest is empty');
  const cols = records[0];
  const seen = new Set();
  for (const c of cols) {
    if (!MANIFEST_COLUMNS.has(c)) refuse('MANIFEST_MALFORMED', `unknown header column ${JSON.stringify(c)}`);
    if (seen.has(c)) refuse('MANIFEST_MALFORMED', `header column ${c} appears twice`);
    seen.add(c);
  }
  for (const c of ['obligationId', 'class']) if (!seen.has(c)) refuse('MANIFEST_MALFORMED', `the header has no ${c} column`);
  return records.slice(1).map((v, n) => {
    if (v.length !== cols.length) refuse('MANIFEST_MALFORMED', `record ${n + 2} has ${v.length} fields, the header has ${cols.length} (quote any field with a comma)`);
    return Object.fromEntries(cols.map((c, k) => [c, v[k]]));
  });
}
function csvRecords(text) {
  const out = []; let rec = [], field = '', i = 0, quoted = false, startedQuoted = false;
  const endField = () => { rec.push(field); field = ''; startedQuoted = false; };
  const endRecord = () => { endField(); if (!(rec.length === 1 && rec[0] === '' && !startedQuoted)) out.push(rec); rec = []; };
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } quoted = false; i++;
        const nx = text[i]; if (nx !== undefined && nx !== ',' && nx !== '\n' && !(nx === '\r' && text[i + 1] === '\n')) refuse('MANIFEST_MALFORMED', 'text after a closing quote');
        continue; }
      field += ch; i++; continue;
    }
    if (ch === '"') { if (field.length) refuse('MANIFEST_MALFORMED', 'a quote inside an unquoted field'); quoted = true; startedQuoted = true; i++; continue; }
    if (ch === ',') { endField(); i++; continue; }
    if (ch === '\r' && text[i + 1] === '\n') { endRecord(); i += 2; continue; }
    if (ch === '\n') { endRecord(); i++; continue; }
    if (ch === '\r') refuse('MANIFEST_MALFORMED', 'a bare carriage return');
    field += ch; i++;
  }
  if (quoted) refuse('MANIFEST_MALFORMED', 'an unterminated quoted field');
  if (field.length || rec.length || startedQuoted) endRecord();
  return out;
}

process.exit(await main());
