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
  // process facts, one node per branch (§4 + v0.2 #1)
  head: lgi('head'), headId: lgi('headId'), status: lgi('status'), waitingAt: lgi('waitingAt'), waitingOn: lgi('waitingOn'),
  incarnation: lgi('incarnation'), asOfStep: lgi('asOfStep'), resumedBy: lgi('resumedBy'), lastErrorAt: lgi('lastErrorAt'),
  // status values
  running: lgi('status/running'), waiting: lgi('status/waiting'), resumed: lgi('status/resumed'),
  done: lgi('status/done'), failed: lgi('status/failed'),
});
/** The projected-metadata predicate for one top-level metadata key (list filters). */
export const lgMetaPredicate = (key) => `<${LG_NS}meta/${encodeURIComponent(key)}>`;
