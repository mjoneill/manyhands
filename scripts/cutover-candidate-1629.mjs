#!/usr/bin/env node
/**
 * #1747 step 3 — mark a promoted copy of the stopped source store as THE candidate for one capture.
 *
 *   node scripts/cutover-candidate-1629.mjs --capture-manifest <capture.json> --executor <candidate url>
 *
 * The capture manifest (written at step 2 from the STOPPED source) names the source store's realpath, a sha256 of each of
 * its files, the document's and the outbox manifest's sha256, the dataset id and the source incarnation. This tool writes
 * ONE CandidateMarker into the candidate's bookkeeping graph carrying the manifest's own sha256, and only when the target
 * really is a promoted copy of that source:
 *   · same datasetId (promotion keeps it; a fresh id has no supported path, #1747 v26),
 *   · a NEW incarnation whose incarnationFrom is the manifest's incarnation,
 *   · a storeHome whose realpath is not the source store's.
 * A marker already present for the same manifest is a no-op; one for another manifest is refused, never overwritten.
 *
 *   · and its CONTENT equals the capture's contentSha256 (every quad of every graph, apart from the six dataset-marker
 *     predicates promotion rewrites), so it is a copy of the captured bytes, not merely of the same source.
 *
 * Output: `MARKED <sha256>` or `ALREADY <sha256>` and exit 0; `REFUSED <CODE> <why>` and exit 1.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { BOOKKEEPING_GRAPH } from '../core/graph-vocab.mjs';
import { captureProblem } from './cutover-capture-schema-1629.mjs';
import { contentDigest } from './cutover-content-digest-1629.mjs';

export const CANDIDATE_MARKER = 'urn:ex:cutover/candidate';
export const P_MANIFEST_SHA = 'urn:ex:cutover/captureManifestSha256';
export const P_MARKED_AT = 'urn:ex:cutover/markedAt';

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const refuse = (code, why) => { console.log(`REFUSED ${code} ${why}`); process.exit(1); };

const manifestFile = arg('--capture-manifest');
const base = String(arg('--executor') || '').replace(/\/+$/, '');
if (!manifestFile || !base) refuse('USAGE', 'node scripts/cutover-candidate-1629.mjs --capture-manifest <file> --executor <url>');

const raw = fs.readFileSync(manifestFile);
const manifestSha = crypto.createHash('sha256').update(raw).digest('hex');
let m;
try { m = JSON.parse(raw.toString('utf8')); } catch { refuse('CAPTURE_MALFORMED', 'the capture manifest is not JSON'); }
// the same CLOSED schema the importer reads (#1747 review of PR #122): every binding field required
const problem = captureProblem(m);
if (problem) refuse('CAPTURE_MALFORMED', problem);

let h;
try { h = await (await fetch(`${base}/health`)).json(); } catch (e) { refuse('UNAVAILABLE', `the candidate's /health could not be read: ${e.message}`); }   // #122 re-review, finding 8
const realOr = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
if (h.datasetId !== m.datasetId) refuse('NOT_CANDIDATE', `dataset ${h.datasetId} is not the capture's ${m.datasetId}`);
if (!h.incarnationFrom || !h.incarnation || h.incarnation === h.incarnationFrom) refuse('NOT_CANDIDATE', 'the target is not a promoted copy (no new incarnation)');
if (h.incarnationFrom !== m.incarnation) refuse('NOT_CANDIDATE', `it was promoted from ${h.incarnationFrom}, not the captured ${m.incarnation}`);
if (!h.storeHome || realOr(h.storeHome) === realOr(m.sourceStore)) refuse('NOT_CANDIDATE', 'its store home is the source store');
// a copy of the CAPTURED bytes (#122 review, finding 1): promotion records the commitSeq it was promoted at as epochBase and
// bumps the epoch by one, so an older or newer copy of the same source is refused here
if (String(h.epochBase) !== m.commitSeq) refuse('NOT_CANDIDATE', `it was promoted at commitSeq ${h.epochBase}, not the captured ${m.commitSeq}`);
if (String(h.epoch) !== String(BigInt(m.epoch) + 1n)) refuse('NOT_CANDIDATE', `its epoch is ${h.epoch}, not the captured ${m.epoch} + 1`);

const query = async (sparql) => {
  const r = await fetch(`${base}/query`, { method: 'POST', headers: { 'x-op-id': `urn:ex:op/cutover/candidate-read/${manifestSha}` }, body: sparql });
  if (!r.ok) refuse('UNAVAILABLE', `query ${r.status}`);
  return (await r.json()).results.bindings;
};
// a READY candidate is FROZEN (#1747 §6 step 5): not even an identical re-mark answers, because READY means nothing moves
if ((await query(`SELECT ?p WHERE { GRAPH <${BOOKKEEPING_GRAPH}> { <urn:ex:cutover/ready> ?p ?o } } LIMIT 1`)).length) refuse('READY_FROZEN', 'the candidate is READY; it may not be marked again');
const have = (await query(`SELECT ?v WHERE { GRAPH <${BOOKKEEPING_GRAPH}> { <${CANDIDATE_MARKER}> <${P_MANIFEST_SHA}> ?v } }`)).map((b) => b.v.value);
if (have.length === 1 && have[0] === manifestSha) { console.log(`ALREADY ${manifestSha}`); process.exit(0); }
if (have.length) refuse('MARKER_MISMATCH', `the candidate is already marked for ${have.join(', ')}`);

// the CONTENT PIN (#1747, approved 46611): before any marker exists, the candidate's content must equal the capture's, quad
// for quad, apart from the six dataset-marker predicates a promotion rewrites. Anything else (a write the source took after
// the copy, a rollback, a floor installed early, a recovery hold) refuses. After marking, the import adds content, so an
// ALREADY above never re-digests.
// the WRITE REVISION (#122 re-review finding 3, ruling 46815): read before the digest, read again after it, and the mark
// below applies only at that same revision (x-if-write-revision, checked by the executor under its write lock). So NO write
// of any kind, a raw one that leaves every count the same included, can land between the digest and the mark unseen.
const revision = async () => {
  let r;
  try { r = await (await fetch(`${base}/health`)).json(); } catch (e) { refuse('UNAVAILABLE', `the candidate's /health could not be read: ${e.message}`); }
  if (typeof r.writeRevision !== 'string' || !/^[0-9a-f-]{36}:\d+$/.test(r.writeRevision)) refuse('UNAVAILABLE', 'the candidate executor reports no write revision (an executor without #1747\'s writeRevision)');
  return r.writeRevision;
};
const rev = await revision();
let got;
try { got = await contentDigest(base, { opId: `urn:ex:op/cutover/candidate-digest/${manifestSha}` }); } catch (e) { refuse(e.code === 'DIGEST_TOO_LARGE' ? 'DIGEST_TOO_LARGE' : 'UNAVAILABLE', `the candidate's content could not be digested: ${e.message}`); }
// the six promotion fields the pin excludes (#122 re-review finding 4, 46820): each must hold EXACTLY the value a promotion
// of THIS capture leaves, once, at its location; an extra, missing or contradictory value is refused, never skipped by the pin
{
  const P = got.promotion, why = [];
  const one = (k, ok, want) => { if (P[k].length !== 1 || !ok(P[k][0])) why.push(`${k} ${JSON.stringify(P[k])}, expected ${want}`); };
  one('epoch', (v) => v === String(BigInt(m.epoch) + 1n), `[${BigInt(m.epoch) + 1n}]`);
  one('epochBase', (v) => v === m.commitSeq, `[${m.commitSeq}]`);
  one('incarnation', (v) => v && v !== m.incarnation, 'one new incarnation');
  one('incarnationFrom', (v) => v === m.incarnation, `[${m.incarnation}] (added by the promotion)`);
  one('storeHome', (v) => v && realOr(v) !== realOr(m.sourceStore), 'one home that is not the source store');
  one('storeHomeInode', (v) => /^\d+$/.test(v), 'one inode number');
  if (why.length) refuse('NOT_CANDIDATE', `the promotion fields are not one promotion of this capture: ${why.join('; ')}`);
}
if (got.sha256 !== m.contentSha256) {
  refuse('NOT_COPY', `the candidate's content (${got.quads} quads${got.recoveryQuads ? `, ${got.recoveryQuads} in the recovery graph: a held promotion's exact delta is validated once restore safety lands` : ''}) is not the captured content`);
}

if ((await revision()) !== rev) refuse('MOVED', `the candidate took a write while its content was being digested (revision ${rev}); nothing was marked`);
// guarded: it inserts only while no marker exists, so two racing runs cannot leave two markers; the CONTENT is bound by the
// write revision (x-if-write-revision below), not by these: the captured commitSeq and the digest's total quad count are
// sanity checks on the same store, never a content proof
const body = `INSERT { GRAPH <${BOOKKEEPING_GRAPH}> { <${CANDIDATE_MARKER}> <${P_MANIFEST_SHA}> "${manifestSha}" ; <${P_MARKED_AT}> "${new Date().toISOString()}"^^<http://www.w3.org/2001/XMLSchema#dateTime> } }
WHERE { GRAPH <${BOOKKEEPING_GRAPH}> { <urn:ex:dataset> <urn:ex:commitSeq> ?cs . FILTER(STR(?cs) = "${m.commitSeq}") }
  FILTER NOT EXISTS { GRAPH <${BOOKKEEPING_GRAPH}> { <${CANDIDATE_MARKER}> <${P_MANIFEST_SHA}> ?any } }
  { SELECT (COUNT(*) AS ?qn) WHERE { { ?qs ?qp ?qo } UNION { GRAPH ?qg { ?qs ?qp ?qo } } } } FILTER(?qn = ${got.total}) }`;
const u = await fetch(`${base}/update`, { method: 'POST', body, headers: { 'x-op-id': `urn:ex:op/cutover/candidate/${manifestSha}`, 'x-epoch': String(h.epoch), 'x-manyhands-write-protocol': 'postseq-v1', 'x-if-write-revision': rev } });   // §6 F1 floor
if (u.status === 409) {
  const t = await u.text();
  if (t.includes('WRITE_REVISION_MOVED')) refuse('MOVED', `the candidate took a write after its content was digested (revision ${rev}); nothing was marked`);
  refuse('WRITE_FAILED', `409 ${t.slice(0, 200)}`);
}
if (!u.ok) refuse('WRITE_FAILED', `${u.status} ${(await u.text()).slice(0, 200)}`);
const after = (await query(`SELECT ?v WHERE { GRAPH <${BOOKKEEPING_GRAPH}> { <${CANDIDATE_MARKER}> <${P_MANIFEST_SHA}> ?v } }`)).map((b) => b.v.value);
if (!after.length) refuse('MOVED', `the candidate changed after its content was digested (commitSeq ${m.commitSeq}, ${got.total} quads); nothing was marked`);
if (after.length !== 1 || after[0] !== manifestSha) refuse('MARKER_MISMATCH', `read-back found ${JSON.stringify(after)}`);
console.log(`MARKED ${manifestSha}`);
