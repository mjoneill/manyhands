/**
 * #1558 slice — the ONE vocabulary shared by the write compiler (the builder) and the
 * authority resolver (a reviewer). Neither side picks its own names: a read-side
 * term and a write-side term that drift apart fail silently (a query that
 * matches nothing returns zero rows, not an error).
 *
 * Namespace `urn:ex:` is the prototype's, pinned here (a reviewer, #1558 03:12Z).
 * Agreed boundary: #1558 comments 03:10Z–03:14Z.
 */

export const NS = 'urn:ex:';
export const iri = (local) => `<${NS}${local}>`;

/** Terms, as full IRIs in SPARQL angle-bracket form. */
export const EX = Object.freeze({
  // classes
  Assertion: iri('Assertion'),
  Grant: iri('Grant'),

  // assertion shape
  subject: iri('subject'),
  predicate: iri('predicate'),
  value: iri('value'),
  scope: iri('scope'),
  binding: iri('binding'),
  author: iri('author'),
  status: iri('status'),
  ver: iri('ver'),
  supersedes: iri('supersedes'),

  // status values
  current: iri('current'),
  retired: iri('retired'),

  // provenance (one hop from either assertion to the explanation)
  evidence: iri('evidence'),       // assertion -> evidence IRI (0..n)
  recordedBy: iri('recordedBy'),   // new assertion -> receipt
  retiredBy: iri('retiredBy'),     // retired assertion -> receipt

  // grants
  grantee: iri('grantee'),
  mayRetire: iri('mayRetire'),
  active: iri('active'),
  rev: iri('rev'),

  // receipts (the op IRI is the receipt)
  outcome: iri('outcome'),
  digest: iri('digest'),
  actor: iri('actor'),
  target: iri('target'),
  expected: iri('expected'),
  observed: iri('observed'),
  commitSeq: iri('commitSeq'),
  at: iri('at'),
  grant: iri('grant'),
  grantRev: iri('grantRev'),
  rule: iri('rule'),
  ruleRev: iri('ruleRev'),

  // outcome values
  APPLIED: iri('APPLIED'),
  PRECONDITION_FAILED: iri('PRECONDITION_FAILED'),

  // the graph-owned commit marker
  dataset: iri('dataset'),
  datasetId: iri('datasetId'),
  epoch: iri('epoch'),
});

/**
 * Receipt and marker predicates — FIXED (D2 proofs A2 §7). A diff that excludes
 * these and finds a change has found a DOMAIN change. Everything not listed is
 * DOMAIN. `ex:commitSeq` appears in both: on a receipt and on ex:dataset.
 */
export const RECEIPT_PREDICATES = Object.freeze([
  EX.outcome, EX.digest, EX.actor, EX.target, EX.expected, EX.observed,
  EX.commitSeq, EX.at, EX.grant, EX.grantRev, EX.rule, EX.ruleRev,
]);
export const MARKER_SUBJECT = EX.dataset;
export const MARKER_PREDICATES = Object.freeze([EX.commitSeq]);

/**
 * #1562 — the LangGraph checkpoint saver's vocabulary (core/langgraph-saver.mjs
 * writes through the `lg.*` intention kinds in core/graph-compiler.mjs). One
 * list, shared by the compiler and the saver's reads, for the same reason as EX.
 * Every lg term is DOMAIN under the static checker: none is a receipt or marker
 * predicate.
 */
export const LG_NS = `${NS}lg/`;
const lgi = (local) => `<${LG_NS}${local}>`;
export const LG = Object.freeze({
  // classes
  Checkpoint: lgi('Checkpoint'), Write: lgi('Write'), Blob: lgi('Blob'), Branch: lgi('Branch'),
  // partitioning (deleteThread removes every node that is lg:inThread the thread)
  inScope: lgi('inScope'), inThread: lgi('inThread'), thread: lgi('thread'), ns: lgi('ns'),
  // checkpoint
  checkpointId: lgi('checkpointId'), parentId: lgi('parentId'), parent: lgi('parent'), step: lgi('step'),
  payloadType: lgi('payloadType'), payload: lgi('payload'), metaType: lgi('metaType'), metadata: lgi('metadata'),
  usesBlob: lgi('usesBlob'), branch: lgi('branch'),
  // channel blobs (one per channel+version)
  channel: lgi('channel'), version: lgi('version'), blobType: lgi('blobType'), blobValue: lgi('blobValue'),
  // pending writes
  checkpoint: lgi('checkpoint'), taskId: lgi('taskId'), idx: lgi('idx'), valueType: lgi('valueType'), value: lgi('value'),
  assignee: lgi('assignee'), resumer: lgi('resumer'),
  // thread generation (bumped by deleteThread; never deleted)
  gen: lgi('gen'),
  // tombstone: deleteThread leaves <checkpoint> lg:deletedInGen g on every checkpoint it removes, so a
  // config naming that checkpoint is known to belong to an ended generation (never deleted itself)
  deletedInGen: lgi('deletedInGen'),
  // process facts, one node per branch (§4 + v0.2 #1)
  head: lgi('head'), headId: lgi('headId'), status: lgi('status'), waitingAt: lgi('waitingAt'), waitingOn: lgi('waitingOn'),
  incarnation: lgi('incarnation'), asOfStep: lgi('asOfStep'), resumedBy: lgi('resumedBy'), lastErrorAt: lgi('lastErrorAt'),
  // status values
  running: lgi('status/running'), waiting: lgi('status/waiting'), resumed: lgi('status/resumed'),
  done: lgi('status/done'), failed: lgi('status/failed'),
});
/** The projected-metadata predicate for one top-level metadata key (list filters). */
export const lgMetaPredicate = (key) => `<${LG_NS}meta/${encodeURIComponent(key)}>`;

/**
 * #1638 — WHERE BOOKKEEPING LIVES, and the ONE definition of what it is.
 *
 * Every write records bookkeeping beside its domain triples: the receipt (the op IRI and its outcome,
 * digest, actor…), the graph-owned commit marker, the per-entity version stamp (`ver`), provenance
 * (`recordedBy`, `retiredBy`) and the whole-entity JSON copy (`scrum:entityJson`). Before #1638 all of
 * it shared the DEFAULT graph with the domain, so any public read of the default graph returned it.
 * It now lives in the named graph BOOKKEEPING_GRAPH, which the public query dataset (the executor's
 * `?dataset=public`) cannot reach. Domain triples stay in the default graph.
 *
 * A triple is bookkeeping when its PREDICATE is in BOOKKEEPING_PREDICATES, OR its SUBJECT starts with
 * one of BOOKKEEPING_SUBJECT_PREFIXES or is one of BOOKKEEPING_SUBJECTS (routing is by subject as well
 * as predicate: every predicate on a receipt is bookkeeping, even one that looks like domain).
 * Everything else is DOMAIN. These lists are the only definition: the compiler's static check, the
 * executor, the offline migration and the rows all read them.
 */
export const BOOKKEEPING_GRAPH = 'urn:scrum:bookkeeping:executor';
export const BK = `<${BOOKKEEPING_GRAPH}>`;
export const MARKER_PREDICATES_ALL = Object.freeze([
  iri('datasetId'), iri('epoch'), iri('commitSeq'), iri('epochBase'),
  iri('incarnation'), iri('incarnationFrom'), iri('storeHome'), iri('storeHomeInode'),
]);
export const ENTITY_JSON = '<https://scrumboard.local/ns#entityJson>';
export const BOOKKEEPING_PREDICATES = Object.freeze([...new Set([
  ...RECEIPT_PREDICATES,
  ...MARKER_PREDICATES_ALL,
  EX.ver, EX.recordedBy, EX.retiredBy, ENTITY_JSON, iri('selfCheck'),
])]);
export const BOOKKEEPING_SUBJECT_PREFIXES = Object.freeze([`${NS}op/`, `${NS}selfcheck/`]);
export const BOOKKEEPING_SUBJECTS = Object.freeze([`${NS}dataset`]);
const BK_PRED_SET = new Set(BOOKKEEPING_PREDICATES.map((p) => p.replace(/^<|>$/g, '')));
/** Is this (subject IRI, predicate IRI) bookkeeping? Bare IRIs or <angle> form both accepted. */
export function isBookkeeping(subject, predicate) {
  const s = String(subject).replace(/^<|>$/g, ''); const p = String(predicate).replace(/^<|>$/g, '');
  return BK_PRED_SET.has(p) || BOOKKEEPING_SUBJECTS.includes(s) || BOOKKEEPING_SUBJECT_PREFIXES.some((x) => s.startsWith(x));
}
