#!/usr/bin/env node
/**
 * #1762 S3 — the one-time, FACTS-ONLY history backfill (contract v2 + v2.1 + v2.2 pins on #1762).
 *
 *   node scripts/history-backfill-1762.mjs --executor <url> --dataset <id> --log <dir> [--apply]
 *
 * Joins every eligible event-log event N to its projected node `activity:seq-N`, in BOTH directions, validates the
 * facts the projector already wrote, and gives each verified successful card node the facts the history read needs
 * as they stood AT THAT WRITE: scrum:columnAfter, scrum:holderAtWrite (the holder BEFORE the write), scrum:shortId
 * where missing, and scrum:logRecordedAt (the event's recorded_at, the public `at` and `since` clock).
 *
 * Without --apply it is a DRY RUN and sends no update. It never writes the log, never removes a triple, and never
 * stores a title, description, body or reason: the backfill carries facts, not content.
 *
 * stdout: ONE JSON object (the report). Exit 0 clean · 3 some pair refused on a stable store (every verified pair still
 * written) · 4 an interrupted, incomplete apply: a lost ACK, or the store's identity changed mid-run (`apply.stopped`); it
 * wins over refusals · 2 usage or preflight (nothing sent). Establishing the frontier F needs an exit-0 APPLY plus verified coverage; a clean dry run is not that.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { readLogStrict } from '../core/activity-projector.mjs';
import { isProjectableEvent, IRI } from '../core/graph-replica.mjs';
import { WRITE_PROTOCOL, WRITE_PROTOCOL_HEADER } from '../core/graph-client.mjs';

const BK = 'urn:scrum:bookkeeping:executor';
const MARKER = 'urn:ex:dataset';
const RS = IRI.scrum, PROV = 'http://www.w3.org/ns/prov#', XSD = 'http://www.w3.org/2001/XMLSchema#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const ACT = IRI.activity, ENT = IRI.entity, PERSON = IRI.person;
const P = {
  used: `${PROV}used`, op: `${RS}op`, entityKind: `${RS}entityKind`, startedAtTime: `${PROV}startedAtTime`,
  wasAssociatedWith: `${PROV}wasAssociatedWith`, shortId: `${RS}shortId`,
  columnAfter: `${RS}columnAfter`, holderAtWrite: `${RS}holderAtWrite`, logRecordedAt: `${RS}logRecordedAt`,
  performedUsing: `${RS}performedUsing`, generated: `${PROV}generated`,
};
const NONE = `${RS}none`, UNKNOWN = `${RS}unknown`;
// A field is named by its prefixed predicate (the reviewer's pin, 07:01Z), in mismatch[].fields and duplicate[].what.
const NAME = Object.fromEntries(Object.entries(P).map(([k, iri]) => [k, iri.startsWith(PROV) ? `prov:${k}` : `scrum:${k}`]));
const nameOf = (iri) => NAME[Object.keys(P).find((k) => P[k] === iri)];
const SINGLE = ['used', 'op', 'entityKind', 'startedAtTime', 'wasAssociatedWith', 'shortId', 'columnAfter', 'holderAtWrite', 'logRecordedAt'];
const SEQ_RE = /^seq-(\d+)$/;
const RUN_RE = /^run-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const fail = (code, msg) => { console.error(`history-backfill-1762: ${msg}`); process.exit(code); };

function parse(argv) {
  const out = { apply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') { out.apply = true; continue; }
    if (['--executor', '--dataset', '--log'].includes(a)) {
      const v = argv[i + 1];
      if (v == null || v.startsWith('--')) return { bad: `${a} needs a value` };
      out[a.slice(2)] = v; i++; continue;
    }
    return { bad: `unknown argument ${a}` };
  }
  const missing = ['executor', 'dataset', 'log'].filter((k) => !out[k]);
  if (missing.length) return { bad: `missing ${missing.map((k) => `--${k}`).join(', ')} (no defaults: every input is passed explicitly)` };
  return out;
}

async function query(executor, sparql) {
  const r = await fetch(`${executor}/query`, { method: 'POST', headers: { 'content-type': 'application/sparql-query', accept: 'application/sparql-results+json' }, body: sparql, signal: AbortSignal.timeout(60_000) });
  if (r.status !== 200) throw new Error(`query refused: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).results.bindings;
}

/** The marker, read from its defined location. Every field single-valued, or the store is not one we can name. */
async function readMarker(executor) {
  const rows = await query(executor, `SELECT ?p ?o WHERE { GRAPH <${BK}> { <${MARKER}> ?p ?o } }`);
  const m = {};
  for (const b of rows) (m[b.p.value] ||= []).push(b.o.value);
  const one = (k) => { const v = m[`urn:ex:${k}`] || []; if (v.length > 1) throw new Error(`the marker holds ${v.length} values for urn:ex:${k}`); return v[0] ?? null; };
  const dataset = one('datasetId');
  if (dataset == null) throw new Error('the store has no dataset marker (<urn:ex:dataset> urn:ex:datasetId): not a store this script can name');
  return { dataset, epoch: one('epoch'), incarnation: one('incarnation') };
}

/** Every default-graph subject under the activity namespace, with its terms (IRI, literal, datatype kept). */
async function readActivityNodes(executor) {
  const rows = await query(executor, `SELECT ?a ?p ?o WHERE { ?a ?p ?o . FILTER(STRSTARTS(STR(?a), "${ACT}")) }`);
  const nodes = new Map();
  for (const b of rows) {
    const a = b.a.value;
    if (!nodes.has(a)) nodes.set(a, {});
    (nodes.get(a)[b.p.value] ||= []).push(b.o);
  }
  return nodes;
}

// An xsd:dateTime is compared as an INSTANT, never as text: the store canonicalizes the lexical form.
const sameInstant = (a, b) => { const x = Date.parse(a), y = Date.parse(b); return Number.isFinite(x) && Number.isFinite(y) && x === y; };
const holderTerm = (h) => (h === undefined ? UNKNOWN : h === null ? NONE : `${PERSON}${encodeURIComponent(h)}`);
const columnTerm = (st) => (!st || !('column' in st) ? { iri: UNKNOWN } : st.column == null ? { iri: NONE } : { lit: String(st.column) });

/**
 * Which facts an eligible event's node carries (v2.1 #3 as corrected by the reviewer's timestamp-scope ruling, 07:01Z):
 *   logRecordedAt (+ shortId where the event has one and the node lacks it): EVERY legacy seq-node /api/changes serves from
 *     its history source, i.e. every kind in today's non-post bucket (changes-log-query.mjs bucketOf), refusals included.
 *   columnAfter / holderAtWrite: SUCCESSFUL card events only.
 *   conversations: nothing (posts are served by the conversations unit, not this history).
 */
const servedHistory = (ev) => ev.entity?.kind !== 'conversation';
const getsCardFacts = (ev) => ev.entity?.kind === 'card' && ev.op !== 'refused';

/** The holder BEFORE each successful card write, replaying only successful state-bearing events per entity (v2.1 #3). */
function replayHolders(events, heldSeqs) {
  const state = new Map();   // entity id -> { known: boolean, holder: string|null }
  const before = new Map();  // seq -> holder (undefined = unknown, null = none, string = seat)
  for (const ev of events) {
    if (ev.entity?.kind !== 'card' || !ev.entity.id) continue;
    if (ev.op === 'refused' || !ev.state || typeof ev.state !== 'object') continue;   // a refusal changed nothing
    const id = ev.entity.id;
    if (heldSeqs.has(ev.seq)) { state.set(id, { known: false, holder: null }); continue; }   // an ambiguous seq: what follows is unknown
    const s = state.get(id);
    before.set(ev.seq, ev.op === 'create' ? null : (s && s.known ? s.holder : undefined));
    state.set(id, 'claimedBy' in ev.state ? { known: true, holder: ev.state.claimedBy ?? null } : { known: false, holder: null });
  }
  return before;
}

const lit = (s) => JSON.stringify(String(s));
const termSparql = (t) => (t.iri ? `<${t.iri}>` : t.dt ? `${lit(t.lit)}^^<${t.dt}>` : lit(t.lit));
/** an executor binding, re-serialized as the exact RDF term it is (IRI, typed or language-tagged literal) */
const bindingSparql = (b) => (b.type === 'uri' ? `<${b.value}>` : b.datatype ? `${lit(b.value)}^^<${b.datatype}>` : b['xml:lang'] ? `${lit(b.value)}@${b['xml:lang']}` : lit(b.value));
const termEq = (have, want) => {
  if (want.iri) return have.type === 'uri' && have.value === want.iri;
  if (want.dt === `${XSD}dateTime`) return have.type !== 'uri' && sameInstant(have.value, want.lit);
  return have.type !== 'uri' && have.value === want.lit;
};

const args = parse(process.argv.slice(2));
if (args.bad) fail(2, args.bad);
const executor = args.executor.replace(/\/$/, '');

// ── PREFLIGHT: everything read and planned before anything is sent ──
let st = null; try { st = fs.statSync(args.log); } catch { /* reported below */ }
if (!st || !st.isDirectory()) fail(2, `the event log directory ${args.log} does not exist — nothing sent`);
let logRead;
try { logRead = readLogStrict(args.log, 0, Infinity); } catch (e) { fail(2, `${e.message}`); }
if (logRead.pendingTail) fail(2, `the log is still being appended (${logRead.pendingTail.segment} line ${logRead.pendingTail.line} is unterminated): a backfill needs a quiescent log — nothing sent`);
let marker, nodes;
try { marker = await readMarker(executor); nodes = await readActivityNodes(executor); } catch (e) { fail(2, `preflight read failed: ${e.message} — nothing sent`); }
if (marker.dataset !== args.dataset) fail(2, `--dataset ${JSON.stringify(args.dataset)} is not this store's dataset (${JSON.stringify(marker.dataset)}): the wrong store is never backfilled — nothing sent`);

const events = logRead.events.filter(isProjectableEvent);
const bySeq = new Map();
for (const ev of events) (bySeq.get(ev.seq) || bySeq.set(ev.seq, []).get(ev.seq)).push(ev);

const refused = { mismatch: [], missingNode: [], missingEvent: [], duplicate: [], badIri: [] };
const skippedNonSeq = [];
const heldSeqs = new Set();
for (const [seq, evs] of bySeq) if (evs.length > 1) { heldSeqs.add(seq); refused.duplicate.push({ seq, iri: `${ACT}seq-${seq}`, what: `event seq ${seq} appears ${evs.length} times in the log` }); }

const seqNodes = new Map();   // seq -> {iri, terms}
for (const [iri, terms] of nodes) {
  const local = iri.slice(ACT.length);
  const m = SEQ_RE.exec(local);
  if (m) { seqNodes.set(Number(m[1]), { iri, terms }); continue; }
  if (RUN_RE.test(local) && terms[P.performedUsing]?.length && terms[P.generated]?.length) { skippedNonSeq.push(iri); continue; }
  refused.badIri.push(iri);
}

const holderBefore = replayHolders(events, heldSeqs);
const plan = [];              // {seq, iri, insert: [[pred, term]], want: [[pred, term]]}
let alreadyCurrent = 0;
const alreadyCurrentSeqs = [];
for (const seq of [...bySeq.keys()].sort((a, b) => a - b)) if (!seqNodes.has(seq) && !heldSeqs.has(seq)) refused.missingNode.push(seq);

for (const [seq, { iri, terms }] of [...seqNodes].sort((a, b) => a[0] - b[0])) {
  if (heldSeqs.has(seq)) continue;   // already listed as duplicate
  const evs = bySeq.get(seq);
  if (!evs) { refused.missingEvent.push(seq); continue; }
  const ev = evs[0];
  const dup = SINGLE.filter((k) => (terms[P[k]]?.length ?? 0) > 1);
  if (dup.length) { refused.duplicate.push({ seq, iri, what: `${dup.map((k) => NAME[k]).join(', ')} holds more than one value` }); continue; }
  const have = (k) => terms[P[k]]?.[0];
  const fields = [];
  // what the projector wrote must equal the event it was projected from
  if (have('used')?.value !== `${ENT}${ev.entity.id}`) fields.push(NAME.used);
  if ((have('entityKind')?.value ?? null) !== (ev.entity.kind ?? null)) fields.push(NAME.entityKind);
  if (have('op')?.value !== ev.op) fields.push(NAME.op);
  const when = ev.occurred_at || ev.recorded_at;
  if (when ? !(have('startedAtTime') && sameInstant(have('startedAtTime').value, when)) : have('startedAtTime')) fields.push(NAME.startedAtTime);
  if (ev.actor ? have('wasAssociatedWith')?.value !== `${PERSON}${ev.actor}` : have('wasAssociatedWith')) fields.push(NAME.wasAssociatedWith);
  if (have('shortId') && ev.entity.shortId != null && have('shortId').value !== String(ev.entity.shortId)) fields.push(NAME.shortId);

  const want = [];
  if (getsCardFacts(ev)) {
    want.push([P.columnAfter, columnTerm(ev.state)]);
    want.push([P.holderAtWrite, { iri: holderTerm(holderBefore.get(seq)) }]);
  }
  if (servedHistory(ev)) {
    if (ev.recorded_at) want.push([P.logRecordedAt, { lit: ev.recorded_at, dt: `${XSD}dateTime` }]);
    if (!have('shortId') && ev.entity.shortId != null) want.push([P.shortId, { lit: String(ev.entity.shortId) }]);
  }
  // a fact already present must agree with the log; a contradiction is refused, never overwritten
  for (const [p, t] of want) {
    const h = terms[p]?.[0];
    if (h && !termEq(h, t)) fields.push(nameOf(p));
  }
  if (fields.length) { refused.mismatch.push({ seq, fields }); continue; }
  const insert = want.filter(([p]) => !terms[p]?.length);
  if (!want.length) continue;                       // a node with no facts to carry: verified, nothing to do
  if (!insert.length) { alreadyCurrent++; alreadyCurrentSeqs.push(seq); continue; }
  // the identity terms preflight validated, exactly as read: the apply-time fence requires each to be unchanged
  const identity = ['used', 'op', 'entityKind', 'startedAtTime', 'wasAssociatedWith', 'shortId'].filter((k) => have(k)).map((k) => [P[k], have(k)]);
  const absent = ['entityKind', 'startedAtTime', 'wasAssociatedWith', 'shortId'].filter((k) => !have(k)).map((k) => P[k])
    .filter((p) => !insert.some(([q]) => q === p));   // a term this update inserts is fenced by the insert's own absence check
  plan.push({ seq, iri, insert, want, identity, absent });
}

const report = {
  dryRun: !args.apply, dataset: marker.dataset, epoch: marker.epoch, incarnation: marker.incarnation,
  scanned: { events: events.length, nodes: seqNodes.size },
  wouldWrite: plan.length, written: 0, alreadyCurrent,
  skippedNonSeq: skippedNonSeq.sort(),
  refused: { ...refused, badIri: refused.badIri.sort() },
};
const anyRefused = Object.values(refused).some((b) => b.length);

if (!args.apply) {
  console.log(JSON.stringify(report));
  process.exit(anyRefused ? 3 : 0);
}

// ── APPLY: one guarded update per node, fenced at apply time (v2.2 pins 1 and 2) ──
const fence = [
  `GRAPH <${BK}> { <${MARKER}> <urn:ex:datasetId> ?fd . FILTER(STR(?fd) = ${lit(marker.dataset)})`,
  marker.epoch != null ? ` <${MARKER}> <urn:ex:epoch> ?fe . FILTER(STR(?fe) = ${lit(marker.epoch)})` : ` FILTER NOT EXISTS { <${MARKER}> <urn:ex:epoch> ?fe }`,
  marker.incarnation != null ? ` <${MARKER}> <urn:ex:incarnation> ?fi . FILTER(STR(?fi) = ${lit(marker.incarnation)})` : ` FILTER NOT EXISTS { <${MARKER}> <urn:ex:incarnation> ?fi }`,
  ' }',
].join('');
const confirmed = [...alreadyCurrentSeqs], uncertain = [];
let stopped = null;
for (const item of plan) {
  const sparql = [
    `INSERT { ${item.insert.map(([p, t]) => `<${item.iri}> <${p}> ${termSparql(t)} .`).join(' ')} }`,
    // the fence: the marker unchanged · every validated identity term still exactly what preflight read (and nothing added to
    // a single-valued one) · terms that were absent still absent · each fact being inserted still absent
    `WHERE { ${fence}`,
    ...item.identity.map(([p, b], i) => ` <${item.iri}> <${p}> ${bindingSparql(b)} . FILTER NOT EXISTS { <${item.iri}> <${p}> ?id${i} . FILTER(?id${i} != ${bindingSparql(b)}) }`),
    ...item.absent.map((p, i) => ` FILTER NOT EXISTS { <${item.iri}> <${p}> ?ab${i} }`),
    ` ${item.insert.map(([p], i) => `FILTER NOT EXISTS { <${item.iri}> <${p}> ?x${i} }`).join(' ')} }`,
  ].join('\n');
  let status = null;   // null = no complete answer (transport error, lost ACK): the outcome is NOT known
  try {
    const r = await fetch(`${executor}/update`, {
      method: 'POST', body: sparql, signal: AbortSignal.timeout(60_000),
      headers: { 'content-type': 'application/sparql-update', 'x-op-id': `urn:ex:op/history-backfill-1762/${crypto.randomUUID()}`, ...(marker.epoch != null ? { 'x-epoch': String(marker.epoch) } : {}), [WRITE_PROTOCOL_HEADER]: WRITE_PROTOCOL },
    });
    await r.text();
    status = r.status;
  } catch { status = null; }
  if (status === null) { uncertain.push(item.seq); break; }      // the outcome is not known: stop; the re-run reconciles
  if (status !== 200) {
    // A COMPLETE refusal (the executor's own epoch fence answers 409). Prove it did not apply rather than call it uncertain,
    // then say why it stopped: a moved store identity, or a refusal on a stable store. Either way nothing later is sent.
    let node, now;
    try { node = (await readActivityNodes(executor)).get(item.iri) ?? {}; now = await readMarker(executor); } catch { uncertain.push(item.seq); break; }
    if (item.insert.some(([p]) => node[p]?.length)) { uncertain.push(item.seq); break; }   // a refused update whose facts are present: not provable
    const moved = ['dataset', 'epoch', 'incarnation'].filter((k) => String(now[k]) !== String(marker[k]));
    stopped = moved.length ? { code: 'STORE_IDENTITY_CHANGED', fields: moved } : { code: 'UPDATE_REFUSED', status };
    break;
  }
  // an accepted write is not a stored write: read the node back
  let after;
  try { after = (await readActivityNodes(executor)).get(item.iri) ?? {}; } catch { uncertain.push(item.seq); break; }
  const bad = [
    ...item.identity.filter(([p, b]) => (after[p]?.length ?? 0) !== 1 || after[p][0].value !== b.value || after[p][0].type !== b.type).map(([p]) => nameOf(p)),
    ...item.absent.filter((p) => after[p]?.length).map(nameOf),
    ...item.want.filter(([p, t]) => (after[p]?.length ?? 0) !== 1 || !termEq(after[p][0], t)).map(([p]) => nameOf(p)),
  ];
  if (bad.length) {
    // The fence held the update back. A store whose identity moved is a restore-class event, not a contradiction on this
    // node (the reviewer's store-identity ruling): stop the WHOLE run, exit 4, nothing later sent. Re-read the marker to tell.
    let now;
    try { now = await readMarker(executor); } catch { uncertain.push(item.seq); break; }   // identity not revalidated: incomplete, never success
    const moved = ['dataset', 'epoch', 'incarnation'].filter((k) => String(now[k]) !== String(marker[k]));
    if (moved.length) { stopped = { code: 'STORE_IDENTITY_CHANGED', fields: moved }; break; }   // proven not applied: uncertain stays empty
    refused.mismatch.push({ seq: item.seq, fields: bad });   // a stable store and a changed node: refused, never retried blind
    continue;
  }
  confirmed.push(item.seq); report.written++;
}
report.refused = { ...refused, badIri: refused.badIri.sort() };
report.apply = { confirmed: confirmed.sort((a, b) => a - b), uncertain, ...(stopped ? { stopped } : {}) };
console.log(JSON.stringify(report));
process.exit(uncertain.length || stopped ? 4 : Object.values(refused).some((b) => b.length) ? 3 : 0);
