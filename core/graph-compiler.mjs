/**
 * #1558 slice — the D2 write compiler (#1565 D2 v1; proofs pre-registered in
 * scrum-board diagnostics/slice-1558-measurement/PREREG-D2-COMPILER-PROOFS.md,
 * amendments A0–A5).
 *
 * An INTENTION becomes ONE guarded `DELETE/INSERT … WHERE` (multi-operation
 * requests are forbidden). Three guard categories, enforced statically:
 *
 *   DOMAIN   every domain triple carries a ?d_ variable, and every ?d_ variable
 *            is `IF(BOUND(?ok), x, ?u)`: bound only when the duplicate guard AND
 *            every precondition pass (?ok is bound only inside the OPTIONAL that
 *            holds them all).
 *   NEW-OP   the receipt and the commit-marker bump carry an ?n_ / ?s variable,
 *            bound whenever the duplicate guard passes, so a PRECONDITION_FAILED
 *            receipt still enters the commit sequence.
 *   REPLAY   the duplicate guard is a top-level FILTER: an existing receipt for
 *            the opId leaves NO solution, so nothing at all is written.
 *
 * Template triples use only IRIs and variables (no literals), one per line, so
 * the static checker can read the categories back from the TEXT by its own
 * rules (subject + predicate), never from labels the compiler chose (A2 #2).
 *
 * Kinds: correction, assertion (binding or a non-binding observation), and the
 * trial-seeding kinds grant and rule.
 *
 * Literal domain (A5): IRIs, plain and language-tagged strings, xsd:boolean,
 * xsd:integer and xsd:dateTime with Z. The compiler OWNS their canonical forms;
 * anything else is a pre-dispatch REJECTED.
 */
import { createHash } from 'node:crypto';
import * as RF from './refusal-record.mjs';   // #1762 S2 — the refusal registries, shared with the builder
import { EX, NS, RECEIPT_PREDICATES, MARKER_SUBJECT, MARKER_PREDICATES, LG, LG_NS, lgMetaPredicate, BK, BOOKKEEPING_PREDICATES, isBookkeeping, POSTSEQ_TERMS, ORIGIN_TERMS } from './graph-vocab.mjs';
import { reserveOpId as _reserveOpId, canonReservationBatch as _canonReservationBatch, reserveDigestBody as _reserveDigestBody, canonAnnouncementDraft } from './postseq-reserve.mjs';
import { announcePostId, opIdFor as announceOpIdFor, postCreateIntention as announcePostCreateIntention } from './announce-outbox.mjs';
import { CRI, cardNames, jsonDigest, namesListOf } from './card-ref-index.mjs';   // #1744 — the derived card reference index

export const DIGEST_V = 1;
/** The literal canonicalization policy (A5). Bound into every digest; bump it if a canonical form changes. */
export const CANON_V = 'slice-a5-1';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
export const SUPPORTED_DATATYPES = Object.freeze([`${XSD}boolean`, `${XSD}integer`, `${XSD}dateTime`]);

export class ValidationError extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}
const fail = (r) => { throw new ValidationError(r); };

// ---------- terms ----------

const IRI_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:[^\s<>"{}|^`\\]+$/;
export function checkIri(v, what) {
  if (typeof v !== 'string' || !IRI_RE.test(v)) fail(`${what}: not an absolute IRI: ${JSON.stringify(v)}`);
  if (v.startsWith('_:')) fail(`${what}: blank nodes are forbidden in intentions`);
  return v;
}
const ref = (v) => `<${v}>`;

function canonInteger(lex) {
  const m = /^\s*([+-]?)0*(\d+)\s*$/.exec(lex);
  if (!m) fail(`not an xsd:integer: ${JSON.stringify(lex)}`);
  const digits = m[2];
  return (m[1] === '-' && digits !== '0') ? `-${digits}` : digits;
}
function canonBoolean(lex) {
  const t = String(lex).trim();
  if (t === 'true' || t === '1') return 'true';
  if (t === 'false' || t === '0') return 'false';
  fail(`not an xsd:boolean: ${JSON.stringify(lex)}`);
}
function canonDateTime(lex) {
  const m = /^(\d{4,}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?Z$/.exec(String(lex).trim());
  if (!m) fail(`xsd:dateTime must carry an explicit Z (no offset, no missing timezone): ${JSON.stringify(lex)}`);
  const frac = (m[2] || '').replace(/0+$/, '');
  return `${m[1]}${frac === '.' ? '' : frac}Z`;
}

/** A term {type:'uri'|'literal', value, datatype?, lang?} → canonical N-Triples term text. */
export function canonTerm(t, what = 'term') {
  if (!t || typeof t !== 'object') fail(`${what}: missing term`);
  if (t.type === 'bnode') fail(`${what}: blank nodes are forbidden in intentions`);
  if (t.type === 'uri') return ref(checkIri(t.value, what));
  if (t.type !== 'literal') fail(`${what}: unknown term type ${JSON.stringify(t.type)}`);
  if (typeof t.value !== 'string') fail(`${what}: literal value must be a string (no JS numbers)`);
  if (t.lang != null && t.datatype != null) fail(`${what}: a literal cannot carry both a language tag and a datatype`);
  if (t.lang != null) {
    if (!/^[a-zA-Z]+(-[a-zA-Z0-9]+)*$/.test(t.lang)) fail(`${what}: bad language tag`);
    return `${JSON.stringify(t.value)}@${t.lang.toLowerCase()}`;
  }
  if (t.datatype == null || t.datatype === `${XSD}string`) return JSON.stringify(t.value);
  if (t.datatype === `${XSD}integer`) return `"${canonInteger(t.value)}"^^<${XSD}integer>`;
  if (t.datatype === `${XSD}boolean`) return `"${canonBoolean(t.value)}"^^<${XSD}boolean>`;
  if (t.datatype === `${XSD}dateTime`) return `"${canonDateTime(t.value)}"^^<${XSD}dateTime>`;
  fail(`${what}: unsupported datatype ${t.datatype} (slice literal domain, A5)`);
}

const intLit = (n, what) => {
  const s = typeof n === 'number' ? (Number.isSafeInteger(n) ? String(n) : fail(`${what}: unsafe integer`)) : n;
  if (typeof s !== 'string') fail(`${what}: integer required`);
  const c = canonInteger(s);
  if (c.startsWith('-')) fail(`${what}: must be >= 0`);
  return c;
};

// ---------- validation + digest ----------

const KINDS = ['correction', 'assertion', 'grant', 'rule'];
const FIELDS = {
  correction: ['kind', 'opId', 'actor', 'targets', 'newAssertion', 'authority', 'evidence'],
  assertion: ['kind', 'opId', 'actor', 'targets', 'newAssertion', 'authority', 'evidence'],
  grant: ['kind', 'opId', 'actor', 'grant', 'evidence'],
  rule: ['kind', 'opId', 'actor', 'rule', 'evidence'],
};
const bool = (v, what, dflt) => (v === undefined ? dflt : (typeof v === 'boolean' ? v : fail(`${what} must be a boolean`)));

function canonAuthority(a) {
  return {
    grant: checkIri(a.grant, 'authority.grant'),
    grantRev: intLit(a.grantRev, 'authority.grantRev'),
    rule: checkIri(a.rule, 'authority.rule'),
    ruleRev: intLit(a.ruleRev, 'authority.ruleRev'),
  };
}

/**
 * Validate an intention and return its canonical form. Throws ValidationError
 * (→ REJECTED, return-only, no receipt, no opId reserved).
 *
 * Kinds: correction (retires ≥1 binding target; authority with mayRetire),
 * assertion (binding needs an authority; a NON-binding observation needs none —
 * if one is given it is checked and bound), grant and rule (trial seeding; the
 * only precondition is a fresh IRI — WHO may create them is unchecked, #1559).
 */
export function canonicalize(intention) {
  const i = intention || {};
  if (typeof i.kind === 'string' && LG_KINDS.includes(i.kind)) return canonicalizeLg(i); // #1562
  if (POSTSEQ_KINDS.includes(i.kind)) return canonicalizePostseqReserve(i);   // #1629 slice 1
  if (i.kind === SETTLE_KIND) return canonicalizeSettle(i);   // #1629 slice 3
  if (RECORD_KINDS.includes(i.kind)) return canonicalizeRecord(i);   // #1561 — the log-born unit's kinds
  if (!KINDS.includes(i.kind)) fail(`kind must be one of ${[...KINDS, ...RECORD_KINDS, ...LG_KINDS, ...POSTSEQ_KINDS, SETTLE_KIND].join(', ')}`);
  for (const k of Object.keys(i)) if (!FIELDS[i.kind].includes(k)) fail(`unknown field ${k} for kind ${i.kind}`);
  const opId = checkIri(i.opId, 'opId');
  if (!opId.startsWith(`${NS}op/`)) fail(`opId must be under ${NS}op/`);
  const actor = checkIri(i.actor, 'actor');
  const evidence = [...new Set((i.evidence || []).map((e, k) => checkIri(e, `evidence[${k}]`)))].sort();
  const base = { kind: i.kind, opId, actor, evidence, targets: [], newAssertion: null, authority: null, grant: null, rule: null };

  if (i.kind === 'grant') {
    const g = i.grant || {};
    const grant = {
      iri: checkIri(g.iri, 'grant.iri'),
      grantee: checkIri(g.grantee, 'grant.grantee'),
      scope: checkIri(g.scope, 'grant.scope'),
      mayRetire: bool(g.mayRetire, 'grant.mayRetire', false),
      rev: intLit(g.rev ?? '1', 'grant.rev'),
    };
    for (const k of Object.keys(g)) if (!['iri', 'grantee', 'scope', 'mayRetire', 'rev'].includes(k)) fail(`unknown field grant.${k}`);
    if (grant.iri === opId) fail('the grant IRI equals the opId');
    return { ...base, grant };
  }
  if (i.kind === 'rule') {
    const r = i.rule || {};
    for (const k of Object.keys(r)) if (k !== 'iri') fail(`unknown field rule.${k}`);
    const rule = { iri: checkIri(r.iri, 'rule.iri') };
    if (rule.iri === opId) fail('the rule IRI equals the opId');
    return { ...base, rule };
  }

  const targets = (i.targets || []).map((t, k) => ({
    iri: checkIri(t?.iri, `targets[${k}].iri`),
    expectedVersion: intLit(t?.expectedVersion, `targets[${k}].expectedVersion`),
  }));
  if (i.kind === 'correction' && targets.length === 0) fail('a correction retires at least one target');
  if (i.kind === 'assertion' && targets.length !== 0) fail('a plain assertion retires nothing');
  if (new Set(targets.map((t) => t.iri)).size !== targets.length) fail('duplicate target');
  targets.sort((a, b) => (a.iri < b.iri ? -1 : a.iri > b.iri ? 1 : 0));

  const n = i.newAssertion || {};
  for (const k of Object.keys(n)) if (!['iri', 'subject', 'predicate', 'value', 'scope', 'binding'].includes(k)) fail(`unknown field newAssertion.${k}`);
  const newA = {
    iri: checkIri(n.iri, 'newAssertion.iri'),
    subject: checkIri(n.subject, 'newAssertion.subject'),
    predicate: checkIri(n.predicate, 'newAssertion.predicate'),
    value: canonTerm(n.value, 'newAssertion.value'),
    scope: checkIri(n.scope, 'newAssertion.scope'),
    binding: bool(n.binding, 'newAssertion.binding', true),
  };
  if (i.kind === 'correction' && !newA.binding) fail('a correction must be binding');
  if (targets.some((t) => t.iri === newA.iri)) fail('self-retirement: the new assertion is also a target');
  if (newA.iri === opId) fail('the new assertion IRI equals the opId');

  let authority = null;
  if (i.authority != null) authority = canonAuthority(i.authority);
  else if (newA.binding) fail('a binding assertion needs an authority (grant + rule revisions)');
  return { ...base, targets, newAssertion: newA, authority };
}

/** The digest binds EVERY caller-controlled semantic input; nothing system-generated. */
export function digestOf(c) {
  if (c.lg) return digestLg(c); // #1562
  if (c.postseq) return digestPostseq(c);   // #1629 slice 1
  if (c.settle) return digestSettle(c);   // #1629 slice 3
  if (c.record) return recordDigest(c);   // #1561
  const lines = [`digestV ${DIGEST_V}`, `canonV ${CANON_V}`, `kind ${c.kind}`, `opId ${ref(c.opId)}`, `actor ${ref(c.actor)}`];
  if (c.grant) {
    lines.push(`grant.iri ${ref(c.grant.iri)}`, `grant.grantee ${ref(c.grant.grantee)}`, `grant.scope ${ref(c.grant.scope)}`,
      `grant.mayRetire ${c.grant.mayRetire}`, `grant.rev ${c.grant.rev}`);
  } else if (c.rule) {
    lines.push(`rule.iri ${ref(c.rule.iri)}`);
  } else {
    const N = c.newAssertion;
    lines.push(...c.targets.map((t) => `target ${ref(t.iri)} ${t.expectedVersion}`),
      `new ${ref(N.iri)}`, `new.subject ${ref(N.subject)}`, `new.predicate ${ref(N.predicate)}`,
      `new.value ${N.value}`, `new.scope ${ref(N.scope)}`, `new.binding ${N.binding}`,
      c.authority ? `grant ${ref(c.authority.grant)} ${c.authority.grantRev}` : 'grant none',
      c.authority ? `rule ${ref(c.authority.rule)} ${c.authority.ruleRev}` : 'rule none');
  }
  lines.push(...c.evidence.map((e) => `evidence ${ref(e)}`));
  return createHash('sha256').update(lines.join('\n') + '\n').digest('hex');
}

// ---------- compile ----------

const ok = (expr, v) => `  BIND(IF(BOUND(?ok), ${expr}, ?u) AS ?d_${v})`;
const nb = (expr, v) => `  BIND(${expr} AS ?n_${v})`;
// #1638 — a node is fresh only when it holds NO triples in EITHER graph: its domain triples live in the default graph,
// its bookkeeping (ver, recordedBy, entityJson, a receipt that named it as target) in the bookkeeping graph.
const inEither = (pattern) => `{ ${pattern} } UNION { GRAPH ${BK} { ${pattern} } }`;
const fresh = (iri) => [`    FILTER NOT EXISTS { ${inEither(`${iri} ?fp ?fo`)} }`, `    FILTER NOT EXISTS { ${inEither(`?fs ?fp2 ${iri}`)} }`];
// #1626 — fresh as a SUBJECT only: the node holds no triples, though other nodes may already point at it (an imported
// post that deliveries or model calls referenced before it reached the graph). Used by post.import only.
const freshSubject = (iri) => [`    FILTER NOT EXISTS { ${inEither(`${iri} ?fp ?fo`)} }`];

// #1638 — WHERE BOOKKEEPING LIVES. Every bookkeeping triple (isBookkeeping, core/graph-vocab.mjs) sits inside
// `GRAPH <BOOKKEEPING_GRAPH> { … }`, in the DELETE and INSERT templates and in every WHERE read of it; domain triples stay
// outside. Each update is still ONE request. staticCheck reads the graph of every template triple back from the TEXT.
/** The top of every guarded update's WHERE: the duplicate guard (a receipt for this opId) and the commit-marker read. */
const dupGuard = (OP) => [
  `  OPTIONAL { GRAPH ${BK} { ${OP} ${EX.digest} ?dup } }`,
  `  FILTER(!BOUND(?dup))`,
  `  GRAPH ${BK} { ${EX.dataset} ${EX.commitSeq} ?s . }`,
  `  BIND(?s + 1 AS ?s1)`,
];
/** Template lines (domain, then bookkeeping inside its GRAPH block) for one DELETE or INSERT. */
const template = (domain, bk) => [...domain, ...(bk.length ? [`  GRAPH ${BK} {`, ...bk.map((l) => `  ${l}`), `  }`] : [])].join('\n');
const assemble = (del, bDel, ins, bIns, where) => `DELETE {\n${template(del, bDel)}\n}\nINSERT {\n${template(ins, bIns)}\n}\nWHERE {\n${where.join('\n')}\n}\n`;

/**
 * Compile a validated intention to ONE SPARQL update. Returns
 * { sparql, digest, canonical }. Throws ValidationError.
 */
export function compile(intention) {
  const c = canonicalize(intention);
  if (c.lg) return compileLg(c, digestOf(c)); // #1562: same template, same staticCheck
  if (c.postseq) return compilePostseqReserve(c, digestOf(c));   // #1629 slice 1: same template, same staticCheck
  if (c.settle) return compileSettle(c, digestOf(c));   // #1629 slice 3: same template, same staticCheck
  if (c.record) return compileRecord(c);   // #1561
  const digest = digestOf(c);
  const OP = ref(c.opId);

  const del = [];
  const ins = [];
  const where = [];
  const pre = [];
  const dBinds = [];
  const nBinds = [];
  const dIns = [];
  const bDel = [];   // #1638 — bookkeeping templates (inside GRAPH <bk>)
  const bIns = [];

  // --- duplicate guard (top level) + marker ---
  where.push(...dupGuard(OP));

  dBinds.push(ok(OP, 'op'));
  c.evidence.forEach((e, k) => dBinds.push(ok(ref(e), `ev${k}`)));

  if (c.grant) {
    const G = c.grant;
    pre.push(...fresh(ref(G.iri)));
    dBinds.push(ok(ref(G.iri), 'g'), ok(EX.Grant, 'Grant'), ok(ref(G.grantee), 'grantee'), ok(ref(G.scope), 'scope'),
      ok(String(G.mayRetire), 'mayRetire'), ok('true', 'active'), ok(G.rev, 'rev'));
    dIns.push(`  ?d_g a ?d_Grant .`, `  ?d_g ${EX.grantee} ?d_grantee .`, `  ?d_g ${EX.scope} ?d_scope .`,
      `  ?d_g ${EX.mayRetire} ?d_mayRetire .`, `  ?d_g ${EX.active} ?d_active .`, `  ?d_g ${EX.rev} ?d_rev .`);
    bIns.push(`  ?d_g ${EX.recordedBy} ?d_op .`);
    c.evidence.forEach((_, k) => dIns.push(`  ?d_g ${EX.evidence} ?d_ev${k} .`));
  } else if (c.rule) {
    pre.push(...fresh(ref(c.rule.iri)));
    dBinds.push(ok(ref(c.rule.iri), 'r'), ok('1', 'one'));
    dIns.push(`  ?d_r ${EX.rev} ?d_one .`);
    bIns.push(`  ?d_r ${EX.recordedBy} ?d_op .`);
    c.evidence.forEach((_, k) => dIns.push(`  ?d_r ${EX.evidence} ?d_ev${k} .`));
  } else {
    const N = c.newAssertion;
    const T = c.targets;
    T.forEach((t, k) => {
      pre.push(`    GRAPH ${BK} { ${ref(t.iri)} ${EX.ver} ?v${k} . }`);   // #1638 — the version stamp is bookkeeping
      pre.push(`    ${ref(t.iri)} ${EX.status} ${EX.current} ; ${EX.scope} ${ref(N.scope)} ;`);
      pre.push(`      ${EX.subject} ${ref(N.subject)} ; ${EX.predicate} ${ref(N.predicate)} ; ${EX.binding} true .`);
      pre.push(`    FILTER(?v${k} = ${t.expectedVersion})`);
    });
    if (c.authority) {
      const A = c.authority;
      pre.push(`    ${ref(A.grant)} ${EX.grantee} ${ref(c.actor)} ; ${EX.scope} ${ref(N.scope)} ; ${EX.active} true ; ${EX.rev} ?gr .`);
      if (T.length) pre.push(`    ${ref(A.grant)} ${EX.mayRetire} true .`);
      pre.push(`    FILTER(?gr = ${A.grantRev})`);
      pre.push(`    ${ref(A.rule)} ${EX.rev} ?rr .`);
      pre.push(`    FILTER(?rr = ${A.ruleRev})`);
    }
    pre.push(...fresh(ref(N.iri))); // fresh replacement identity (also rules out cycles)

    T.forEach((t, k) => nBinds.push(nb(ref(t.iri), `target${k}`)));

    dBinds.push(ok(ref(N.iri), 'new'), ok(EX.Assertion, 'Assertion'), ok(ref(N.subject), 'subject'),
      ok(ref(N.predicate), 'predicate'), ok(N.value, 'value'), ok(ref(N.scope), 'scope'),
      ok(String(N.binding), 'binding'), ok(EX.current, 'current'), ok('1', 'one'), ok(ref(c.actor), 'author'));
    if (T.length) dBinds.push(ok(EX.retired, 'retired'));
    T.forEach((t, k) => dBinds.push(ok(ref(t.iri), `t${k}`), ok(`?v${k}`, `oldv${k}`), ok(`?v${k} + 1`, `nv${k}`)));

    dIns.push(`  ?d_new a ?d_Assertion .`, `  ?d_new ${EX.subject} ?d_subject .`, `  ?d_new ${EX.predicate} ?d_predicate .`,
      `  ?d_new ${EX.value} ?d_value .`, `  ?d_new ${EX.scope} ?d_scope .`, `  ?d_new ${EX.binding} ?d_binding .`,
      `  ?d_new ${EX.status} ?d_current .`, `  ?d_new ${EX.author} ?d_author .`);
    bIns.push(`  ?d_new ${EX.ver} ?d_one .`, `  ?d_new ${EX.recordedBy} ?d_op .`);
    c.evidence.forEach((_, k) => dIns.push(`  ?d_new ${EX.evidence} ?d_ev${k} .`));
    T.forEach((_, k) => {
      dIns.push(`  ?d_new ${EX.supersedes} ?d_t${k} .`);
      del.push(`  ?d_t${k} ${EX.status} ?d_current .`);
      bDel.push(`  ?d_t${k} ${EX.ver} ?d_oldv${k} .`);
      dIns.push(`  ?d_t${k} ${EX.status} ?d_retired .`);
      bIns.push(`  ?d_t${k} ${EX.ver} ?d_nv${k} .`, `  ?d_t${k} ${EX.retiredBy} ?d_op .`);
    });
  }

  // --- preconditions: ?ok is bound only if ALL hold ---
  pre.push(`    BIND(true AS ?ok)`);
  where.push(`  OPTIONAL {`, ...pre, `  }`);

  // --- NEW-OP bindings (dup guard only) ---
  where.push(`  BIND(IF(BOUND(?ok), ${EX.APPLIED}, ${EX.PRECONDITION_FAILED}) AS ?n_outcome)`);
  where.push(nb(JSON.stringify(digest), 'digest'), nb(ref(c.actor), 'actor'), nb('NOW()', 'at'));
  if (c.authority) {
    where.push(nb(ref(c.authority.grant), 'grant'), nb(c.authority.grantRev, 'grantRev'),
      nb(ref(c.authority.rule), 'rule'), nb(c.authority.ruleRev, 'ruleRev'));
  }
  where.push(...nBinds);
  // --- DOMAIN bindings (dup guard + ALL preconditions) ---
  where.push(...dBinds);

  // --- templates: one triple per line, IRIs and variables only ---
  // the marker and the receipt are bookkeeping: they go in the bookkeeping graph block
  bDel.unshift(`  ${MARKER_SUBJECT} ${EX.commitSeq} ?s .`);
  bIns.unshift(`  ${MARKER_SUBJECT} ${EX.commitSeq} ?s1 .`);
  bIns.push(`  ${OP} ${EX.outcome} ?n_outcome .`, `  ${OP} ${EX.digest} ?n_digest .`, `  ${OP} ${EX.actor} ?n_actor .`,
    `  ${OP} ${EX.at} ?n_at .`, `  ${OP} ${EX.commitSeq} ?s1 .`);
  if (c.authority) {
    bIns.push(`  ${OP} ${EX.grant} ?n_grant .`, `  ${OP} ${EX.grantRev} ?n_grantRev .`,
      `  ${OP} ${EX.rule} ?n_rule .`, `  ${OP} ${EX.ruleRev} ?n_ruleRev .`);
  }
  c.targets.forEach((_, k) => bIns.push(`  ${OP} ${EX.target} ?n_target${k} .`));
  ins.push(...dIns);

  const sparql = assemble(del, bDel, ins, bIns, where);
  const check = staticCheck(sparql, c.opId);
  if (!check.ok) fail(`compiler rejected its own output: ${check.errors.join('; ')}`);
  return { sparql, digest, canonical: c };
}

// ---------- the static checker: categories from the TEXT, by its own rules ----------

const TRIPLE_RE = /^\s*(\S+) (\S+) (\S+) \.$/;
const GRAPH_OPEN_RE = /^\s*GRAPH (\S+) \{$/;
const escRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const angle = (t) => (/^<[^<>\s]+>$/.test(t) ? t : null);
/**
 * #1638 — which graph a template triple belongs in, from its CONSTANT terms (the same isBookkeeping the executor and the
 * migration use): 'BK' (bookkeeping graph), 'DOMAIN' (default graph), or 'WILD' (subject AND predicate are variables: a
 * wildcard that deletes or reads whatever the variables bind to, allowed in either graph).
 */
function graphOf(s, p) {
  const sc = angle(s), pc = angle(p);
  if (!sc && !pc) return 'WILD';
  return isBookkeeping(sc || '', pc || '') ? 'BK' : 'DOMAIN';
}
/** The term that made graphOf say 'BK': the predicate when it is a bookkeeping predicate, else the subject. */
const bkReason = (s, p) => (angle(p) && isBookkeeping('', p) ? `predicate ${p}` : `subject ${s}`);

/**
 * Read a compiled update back and check every template triple carries its
 * category's guard AND sits in its graph. The category is derived from (subject, predicate) alone:
 *   RECEIPT  subject is the op IRI and predicate is a receipt predicate
 *   MARKER   subject is ex:dataset and predicate is a marker predicate
 *   DOMAIN   everything else
 * #1638 — and the graph is derived from the same pair (isBookkeeping, core/graph-vocab.mjs): a bookkeeping triple
 * (receipt, marker, ver, recordedBy, retiredBy, entityJson, anything on an op/selfcheck/dataset subject) must be inside
 * `GRAPH <urn:scrum:bookkeeping:executor> { … }`; a domain triple must NOT be; no other named graph is accepted anywhere.
 * (A triple whose subject and predicate are both variables is a wildcard and may sit in either graph.)
 */
export function staticCheck(sparql, opId) {
  const errors = [];
  const op = ref(opId);
  const block = (name) => {
    const m = new RegExp(`(?:^|\\n)${name} \\{\\n([\\s\\S]*?)\\n\\}`).exec(sparql);
    return m ? m[1].split('\n').filter((l) => l.trim()) : [];
  };
  const where = block('WHERE').join('\n');
  // #1791 / #1781 — the three TEXTUAL scans below (a second operation, a named graph, a bookkeeping predicate in the WHERE)
  // read the request with its string literals BLANKED: a literal is data, never syntax, and a post or record quoting
  // "…; delete the card", "GRAPH ?g {" or "?op <urn:ex:commitSeq> ?c" was refused as if it were the request's own. The
  // compiler's literals are double-quoted with \-escapes on one line (recLit, psqLit, JSON.stringify), so the bounds are exact.
  const unquote = (t) => t.replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
  const bareSparql = unquote(sparql), bareWhere = unquote(where);
  // every ?d_ variable must be defined only as IF(BOUND(?ok), x, ?u)
  const dDefs = {};
  // [^\n], never `.`: a JS `.` stops at U+2028/U+2029, which a JSON literal carries raw, so `.*` silently missed such a BIND
  // (the ok-guard check then never saw it, and the unbound-use check below refused a valid write: #1749 A8's payload)
  for (const m of where.matchAll(/BIND\(([^\n]*) AS \?(d_\w+)\)/g)) dDefs[m[2]] = m[1];
  for (const [v, expr] of Object.entries(dDefs)) {
    if (!/^IF\(BOUND\(\?ok\), [^\n]+, \?u\)$/.test(expr)) errors.push(`?${v} is not ok-guarded`);   // [^\n]: see dDefs above
  }
  // #1762 S1 (review 131) — every ?d_ variable a template USES must be DEFINED: a template variable with no binding is not an
  // error in SPARQL, it is a triple silently skipped, so a missing definition would commit the rest of the write without it
  // (the removed-binding sabotage: APPLIED, the card written, zero activities). Refused here, for every write kind.
  for (const name of ['DELETE', 'INSERT']) {
    for (const m of block(name).join('\n').matchAll(/\?(d_\w+)/g)) if (!(m[1] in dDefs)) errors.push(`?${m[1]} is used in the ${name} template but never bound (a triple would be silently skipped)`);
  }
  if ((where.match(/BIND\(true AS \?ok\)/g) || []).length !== 1) errors.push('?ok must be bound exactly once');
  if (!new RegExp(`^\\s*OPTIONAL \\{ GRAPH ${escRe(BK)} \\{ <[^>]+> <urn:ex:digest> \\?dup \\} \\}\\n\\s*FILTER\\(!BOUND\\(\\?dup\\)\\)`).test(where)) errors.push(`duplicate guard missing, not first, or not read from GRAPH ${BK}`);
  if (/;\s*(INSERT|DELETE)/i.test(bareSparql)) errors.push('multi-operation request');
  // one plain DELETE { } INSERT { } WHERE { } request: no WITH / USING / FROM redirecting the default graph
  if (!/^DELETE \{\n[\s\S]*?\n\}\nINSERT \{\n[\s\S]*?\n\}\nWHERE \{\n/.test(sparql)) errors.push('not a plain DELETE/INSERT/WHERE request (WITH, USING and FROM are not accepted)');
  // the only named graph anywhere in the request is the bookkeeping graph; #1749 (A7 v2) the recovery graph may be READ in WHERE
  // (the allocator guard asks whether a hold exists) and is never a template's target
  for (const m of bareSparql.matchAll(/\bGRAPH\s+(\S+)\s*\{/g)) {
    if (m[1] === BK) continue;
    if (m[1] === POSTSEQ_TERMS.RECOVERY_GRAPH && bareWhere.includes(m[0]) && !unquote(block('DELETE').join('\n')).includes(m[0]) && !unquote(block('INSERT').join('\n')).includes(m[0])) continue;
    errors.push(`named graph ${m[1]} is not accepted: the only named graph is ${BK}`);
  }
  // WHERE: a bookkeeping predicate is read only inside GRAPH <bk> { … } (strip those blocks, then look for it in triple position)
  {
    const open = `GRAPH ${BK} {`;
    let rest = '';
    for (let i = 0; i < bareWhere.length;) {
      const j = bareWhere.indexOf(open, i);
      if (j < 0) { rest += bareWhere.slice(i); break; }
      rest += bareWhere.slice(i, j);
      let d = 1; let k = j + open.length;
      while (k < bareWhere.length && d > 0) { if (bareWhere[k] === '{') d++; else if (bareWhere[k] === '}') d--; k++; }
      i = k;
    }
    for (const p of BOOKKEEPING_PREDICATES) {
      if (new RegExp(`(?:\\?\\w+|<[^<>\\s]+>|;) ${escRe(p)} `).test(rest)) errors.push(`WHERE reads bookkeeping predicate ${p} outside GRAPH ${BK}`);
    }
  }

  const triples = [];
  for (const [name, lines] of [['DELETE', block('DELETE')], ['INSERT', block('INSERT')]]) {
    let graph = null;   // null = default graph; else the GRAPH term currently open
    for (const l of lines) {
      const g = GRAPH_OPEN_RE.exec(l);
      if (g) {
        if (graph !== null) errors.push(`${name}: nested GRAPH block: ${l.trim()}`);
        graph = g[1];
        continue;
      }
      if (l.trim() === '}') {
        if (graph === null) errors.push(`${name}: unbalanced '}' in template`);
        graph = null;
        continue;
      }
      const m = TRIPLE_RE.exec(l);
      if (!m) { errors.push(`${name}: unparseable template line: ${l.trim()}`); continue; }
      const [, s, p, o] = m;
      let cat = 'DOMAIN';
      if (s === op && RECEIPT_PREDICATES.includes(p)) cat = 'RECEIPT';
      else if (s === MARKER_SUBJECT && MARKER_PREDICATES.includes(p)) cat = 'MARKER';
      const vars = [s, p, o].filter((x) => x.startsWith('?'));
      const has = cat === 'DOMAIN'
        ? vars.some((v) => v.startsWith('?d_') && dDefs[v.slice(1)])
        : vars.some((v) => v.startsWith('?n_') || v === '?s' || v === '?s1');
      if (!has) errors.push(`${name} ${cat} triple lacks its guard variable: ${l.trim()}`);
      for (const term of [s, p, o]) {
        if (!(term.startsWith('?') || /^<[^>]+>$/.test(term) || term === 'a')) errors.push(`${name}: literal in template: ${l.trim()}`);
      }
      // #1638 — the receipt/marker subjects take only receipt/marker predicates, and sit in the bookkeeping graph with the rest
      const sc = angle(s);
      if (sc && cat === 'DOMAIN' && isBookkeeping(sc, '') ) {
        errors.push(`${name}: bookkeeping subject ${s} carries a non-receipt predicate ${p}: ${l.trim()}`);
      }
      const want = graphOf(s, p);
      const inBk = graph === BK;
      if (graph !== null && graph !== BK) { /* the named-graph error above already names it */ }
      else if (want === 'BK' && !inBk) errors.push(`${name}: bookkeeping triple (${bkReason(s, p)}) is in the default graph; it belongs in GRAPH ${BK}: ${l.trim()}`);
      else if (want === 'DOMAIN' && inBk) errors.push(`${name}: domain triple (${angle(p) ? `predicate ${p}` : `subject ${s}`}) is inside GRAPH ${BK}; bookkeeping only: ${l.trim()}`);
      triples.push({ block: name, s, p, o, cat, graph: graph === null ? 'default' : graph });
    }
    if (graph !== null) errors.push(`${name}: GRAPH block is not closed`);
  }
  return { ok: errors.length === 0, errors, triples };
}

// =====================================================================================
// #1561 — THE LOG-BORN UNIT'S RECORD KINDS: memory, decision, seat-state.
//
// The first real cutover unit (#1560 inventory, §2.10). Each write is ONE guarded
// DELETE/INSERT … WHERE through the same three-category discipline as the slice's
// kinds and the UNCHANGED staticCheck: domain triples carry ?d_ (ok-guarded), the
// receipt and marker carry ?n_ / ?s, the duplicate guard is the top-level FILTER.
//
// The CALLER sends a domain payload; the COMPILER owns the mapping to triples (the
// vocabulary below is the one the replica projects, so a fold written for the replica
// reads the executor's rows unchanged). An intention cannot name arbitrary triples.
//
// Optimistic versioning: a memory node carries `urn:ex:ver`, bumped by every revise.
// `memory.revise` is guarded by `target.expectedVersion` against it — the same
// expected-version precondition shape as a correction's target — so a writer whose
// read is stale gets PRECONDITION_FAILED and nothing of the domain changes.
//
// Identity history (RECORD_V 2): a revise REPLACES name/tags/priority/currentVersion/
// relatedTo, so it first records the values it replaces on a revision node,
// `<memory>/revision/<expectedVersion>` (a MemoryRevision: ofMemory, revision, the
// prior* values, recordedBy the op) — read from the STORE inside the same guarded
// update, never sent by the caller. Every revise appends one; none is ever rewritten.
// The flag-OFF event log kept each prior full state; this keeps the same history.
//
// Literals (record kinds only): plain strings, canonicalized by recLit — every ASCII
// character outside a small safe set, and U+0085/U+2028/U+2029, is written as a \uXXXX
// escape. So no literal can contain text the static checker reads as structure
// (`;`, `(`, `?`, `{`, a line terminator). Measured round-trip exact in Oxigraph for
// quotes, backslashes, a literal "A", control characters and astral characters.
// =====================================================================================

export const RECORD_V = 2;   // 2: memory.revise records the identity it replaces (a MemoryRevision node)
export const RECORD_KINDS = Object.freeze(['memory.create', 'memory.revise', 'decision.create', 'decision.relate', 'seat.declare', 'seat.clear', 'person.import', 'post.create', 'post.import', 'post.write', 'post.redact', 'delivery.create', 'delivery.step', 'delivery.import', 'modelcall.create', 'card.write', 'entity.put', 'origin.prepare', 'refusal.record']);

const RS = 'https://scrumboard.local/ns#';
const RSC = 'https://schema.org/';
/** The domain vocabulary the record kinds write — the replica's own terms (core/graph-replica.mjs). */
export const LOGBORN_TERMS = Object.freeze({
  type: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
  Memory: `${RS}Memory`, MemoryVersion: `${RS}MemoryVersion`, MemoryRevision: `${RS}MemoryRevision`, Decision: `${RS}Decision`, SeatDeclaration: `${RS}SeatDeclaration`,
  identifier: `${RSC}identifier`, name: `${RSC}name`, author: `${RSC}author`, dateCreated: `${RSC}dateCreated`,
  owner: `${RS}owner`, tag: `${RS}tag`, priority: `${RS}priority`, currentVersion: `${RS}currentVersion`, relatedTo: `${RS}relatedTo`,
  ofMemory: `${RS}ofMemory`, version: `${RS}version`, body: `${RS}body`,
  revision: `${RS}revision`, priorName: `${RS}priorName`, priorTag: `${RS}priorTag`, priorPriority: `${RS}priorPriority`,
  priorCurrentVersion: `${RS}priorCurrentVersion`, priorRelatedTo: `${RS}priorRelatedTo`,
  statement: `${RS}statement`, decidedBy: `${RS}decidedBy`, constrains: `${RS}constrains`, reopensIf: `${RS}reopensIf`,
  supersedes: `${RS}supersedes`, duplicateOf: `${RS}duplicateOf`,
  declaredSeat: `${RS}declaredSeat`, mode: `${RS}mode`, acceptsRoutineWork: `${RS}acceptsRoutineWork`, constraint: `${RS}constraint`,
  note: `${RS}note`, declaredAt: `${RS}declaredAt`, expiresAt: `${RS}expiresAt`, role: `${RS}role`, endedAt: `${RS}endedAt`,
  ver: `${NS}ver`, recordedBy: `${NS}recordedBy`,
  // #1561 Person identity nodes (the replica's Person projection, plus the planner's whitelist)
  Person: `${RSC}Person`, glyph: `${RS}glyph`, resolved: `${RS}resolved`, aliases: `${RS}aliases`,
  // #1574 C3c — an announcement post (schema:Comment), written by the outbox publisher
  Comment: `${RSC}Comment`, text: `${RSC}text`, postSeq: `${RS}postSeq`, originOccurredAt: `${RS}originOccurredAt`,
  originMutation: `${RS}originMutation`, originSlot: `${RS}originSlot`, originActor: `${RS}originActor`, mentionsName: `${RS}mentionsName`,
  about: `${RSC}about`,   // #1574 R0 — a post's attachedTo, the existing document mapping
  // #1574 R4a — a redacted post's tombstone, and the other content predicates a post node can carry
  RedactedPost: `${RS}RedactedPost`, redactedBy: `${RS}redactedBy`, conversation: `${RS}conversation`, postMentionsCard: `${RS}postMentionsCard`,
  // #1574 U1–U4 — the rest of a document post, as copied by the backfill
  onBehalfOf: `${RS}onBehalfOf`, recovered: `${RS}recovered`, opId: `${RS}opId`,
  // #1574 U5 (decision f4940204) — an author-repair trail, kept as provenance literals: never an actor, never authority
  originalAuthorToken: `${RS}originalAuthorToken`, authorCorrectedAt: `${RS}authorCorrectedAt`, authorCorrectedBy: `${RS}authorCorrectedBy`,
  attachmentOf: `${RS}attachmentOf`, attachmentIndex: `${RS}attachmentIndex`, encodingFormat: `${RSC}encodingFormat`, contentSize: `${RSC}contentSize`,
  // #1582 unit 3 — deliveries and model calls, in the replica's own `scrum:` terms (core/graph-replica.mjs projectDelivery /
  // projectModelCall), so a reader of the graph form and a reader of the old projection name the same things.
  Delivery: `${RS}Delivery`, DeliveryStep: `${RS}DeliveryStep`, deliveredTo: `${RS}deliveredTo`, ofConversation: `${RS}ofConversation`,
  source: `${RS}source`, offeredAt: `${RS}offeredAt`, stepOf: `${RS}stepOf`, stepIndex: `${RS}stepIndex`, state: `${RS}state`,
  at: `${RS}at`, attempt: `${RS}attempt`, reason: `${RS}reason`, traceId: `${RS}traceId`, ofModelCall: `${RS}ofModelCall`, creator: `${RS}creator`,
  ModelCall: `${RS}ModelCall`, agent: `${RS}agent`, model: `${RS}model`, calledAt: `${RS}calledAt`, cost: `${RS}cost`,
  producedPost: `${RS}producedPost`, postedText: `${RS}postedText`, requestId: `${RS}requestId`, entityJson: `${RS}entityJson`,
  // #1624 — the small-kinds entity.put primitive. Wake is the first projection; later kinds
  // add a row here AND a canonicalizeRecord/planRecord block. Wakes mint a node + edges that
  // mirror the replica's existing projectWake (graph-replica.mjs), so a reader of either store
  // sees the same triples.
  Wake: `${RS}Wake`, wokeSeat: `${RS}wokeSeat`, wokeAt: `${RS}wokeAt`,
  // #1762 S2 — a refusal, content-free (core/refusal-record.mjs): identifiers and outcomes, never what was said
  RefusalRecord: `${RS}RefusalRecord`, refusedAction: `${RS}refusedAction`, route: `${RS}route`, status: `${RS}status`, code: `${RS}code`, rule: `${RS}rule`,
  entityKind: `${RS}entityKind`, entityId: `${RS}entityId`,
  wasAssociatedWith: 'http://www.w3.org/ns/prov#wasAssociatedWith', startedAtTime: 'http://www.w3.org/ns/prov#startedAtTime',
});
const TM = LOGBORN_TERMS;

const RECORD_FIELDS = {
  'memory.create': ['memory', 'versions'],
  'memory.revise': ['target', 'set', 'versions'],
  'decision.create': ['decision'],
  'decision.relate': ['target', 'supersedes', 'duplicateOf'],
  'seat.declare': ['seat', 'declaration', 'ends', 'at'],
  'seat.clear': ['seat', 'ends', 'at'],
  'person.import': [],
  'post.create': ['post'],   // #1574 C3c
  'post.import': ['post'],   // #1574 R0 — a document post copied into the graph
  'post.write': ['post'],    // #1574 R2 — an ordinary post written straight to the graph (the same node shape as post.import)
  'post.redact': ['post', 'authorityRef', 'occurredAt'],   // #1574 R4a — logical deletion of a post's content
  'delivery.create': ['delivery'],          // #1582 — a delivery and its `offered` step, both fresh
  'delivery.step': ['target', 'step'],      // #1582 — one step, guarded by the delivery's expected version (as memory.revise)
  'delivery.import': ['delivery'],          // #1582 migration — a document delivery and ALL its steps, fresh, in one update
  'modelcall.create': ['call'],             // #1582 — one ledger row, fresh at its derived IRI
  'card.write': ['parts', 'counter', 'pending', 'collections', 'origin', 'indexGuard', 'reads', 'walk'],       // #1598 — one or more cards, each guarded on its version, in ONE update; #1629 s2 — `origin` makes it an origin commit
  'entity.put': ['entity'],                 // #1624 — one generic storage primitive; the `kind` field selects the projection
  'origin.prepare': ['origin', 'plan'],     // #1629 s2 — the Prepared record of one origin: its descriptor and its frozen business plan
  'refusal.record': ['refusal'],            // #1762 S2 — one content-free refusal, fresh at the IRI its opId derives; never history
};

// #1762 S1b — the record kinds whose write records ONE ChangeActivity (part 0) when the intention carries `history`. The
// compiler DERIVES op, entityKind and prov:used from the record itself, so a caller cannot misname what it wrote; a caller
// supplies only `versionAfter`, and only where REST shows a version the record does not carry (a memory revise that adds
// no version). Imports are migrations, never history; a collection entity.put carries its history per part (S1).
const maxVersion = (versions) => {
  const ns = (versions || []).map((x) => x.version).filter((x) => x != null).map(BigInt);
  return ns.length ? String(ns.reduce((a, b) => (b > a ? b : a))) : 'unknown';
};
const RECORD_HISTORY = Object.freeze({
  'memory.create': (R) => ({ op: 'create', entityKind: 'memory', used: R.memory.iri, versionAfter: maxVersion(R.versions) }),
  'memory.revise': (R) => ({ op: 'update', entityKind: 'memory', used: R.target.iri, versionAfter: maxVersion(R.versions) }),
  'decision.create': (R) => ({ op: 'create', entityKind: 'decision', used: R.decision.iri }),
  'decision.relate': (R) => ({ op: 'update', entityKind: 'decision', used: R.target }),
  'seat.declare': (R) => ({ op: 'update', entityKind: 'seat-state', used: R.declaration.iri }),
  'seat.clear': (R) => ({ op: 'delete', entityKind: 'seat-state', used: R.ends }),
  'post.create': (R) => ({ op: 'post', entityKind: 'conversation', used: R.post.iri }),
  'post.write': (R) => ({ op: 'post', entityKind: 'conversation', used: R.post.iri }),
  'post.redact': (R) => ({ op: 'redact', entityKind: 'conversation', used: R.post.iri }),
  'delivery.create': (R) => ({ op: 'create', entityKind: 'delivery', used: R.delivery.iri }),
  'delivery.step': (R) => ({ op: 'update', entityKind: 'delivery', used: R.target.iri }),
  'modelcall.create': (R) => ({ op: 'create', entityKind: 'model-call', used: R.call.iri }),
  'entity.put': (R) => (R.entity.kind === 'wake' ? { op: 'create', entityKind: 'wake', used: R.entity.iri } : null),
});
export const RECORD_HISTORY_KINDS = Object.freeze(Object.keys(RECORD_HISTORY));
/** `history: true`, or `{ versionAfter }`, in canonical form: the derived facts, or null when the intention carries none. */
function canonRecordHistory(i, record) {
  if (i.history === undefined) return null;
  const h = RECORD_HISTORY[i.kind]?.(record);
  if (!h) fail(`history is not recorded for ${i.kind}${i.kind === 'entity.put' ? ` (${record.entity?.kind})` : ''}`);
  let versionAfter = h.versionAfter ?? 'unknown';
  if (i.history !== true) {
    obj(i.history, ['versionAfter'], 'history');
    const given = i.history.versionAfter === 'unknown' ? 'unknown' : intLit(i.history.versionAfter, 'history.versionAfter');
    if (versionAfter !== 'unknown' && given !== versionAfter) fail(`history.versionAfter ${given} contradicts the record's own version ${versionAfter}`);
    versionAfter = given;
  }
  return { op: h.op, entityKind: h.entityKind, used: checkIri(h.used, 'history.used'), versionAfter };
}

const SAFE_CH = /^[A-Za-z0-9 _.,:/@#+=*!~%&$-]$/;
/** A plain string literal in the record kinds' canonical form (see the header). */
export function recLit(s) {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if ((cp < 0x80 && !SAFE_CH.test(ch)) || cp === 0x85 || cp === 0x2028 || cp === 0x2029) out += `\\u${cp.toString(16).toUpperCase().padStart(4, '0')}`;
    else out += ch;
  }
  return `"${out}"`;
}

const obj = (o, allowed, what) => {
  if (!o || typeof o !== 'object' || Array.isArray(o)) fail(`${what} must be an object`);
  for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(`unknown field ${what}.${k}`);
  return o;
};
const rStr = (v, what) => {
  if (typeof v !== 'string') fail(`${what}: must be a string (no JS numbers or booleans)`);
  if (!v.isWellFormed()) fail(`${what}: not well-formed text (a lone surrogate)`);
  return v;
};
const rOpt = (v, what) => (v === undefined || v === null ? null : rStr(v, what));
const rOptIri = (v, what) => (v === undefined || v === null ? null : checkIri(v, what));
const rList = (v, what, each) => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) fail(`${what} must be an array`);
  return [...new Set(v.map((x, k) => each(x, `${what}[${k}]`)))].sort();
};
const rCount = (v, what) => (v === undefined || v === null ? null : intLit(v, what));

function canonVersions(list, what) {
  if (!Array.isArray(list)) fail(`${what} must be an array`);
  const out = list.map((x, k) => {
    obj(x, ['iri', 'version', 'body', 'author', 'dateCreated'], `${what}[${k}]`);
    return {
      iri: checkIri(x.iri, `${what}[${k}].iri`), version: rCount(x.version, `${what}[${k}].version`),
      body: rOpt(x.body, `${what}[${k}].body`), author: rOptIri(x.author, `${what}[${k}].author`),
      dateCreated: rOpt(x.dateCreated, `${what}[${k}].dateCreated`),
    };
  }).sort((a, b) => (a.iri < b.iri ? -1 : a.iri > b.iri ? 1 : 0));
  if (new Set(out.map((x) => x.iri)).size !== out.length) fail(`${what}: duplicate version IRI`);
  return out;
}
function canonMemoryState(s, what, withIdentity) {
  const keys = ['name', 'tags', 'priority', 'currentVersion', 'relatedTo'];
  obj(s, withIdentity ? ['iri', 'identifier', 'owner', ...keys] : keys, what);
  return {
    ...(withIdentity ? { iri: checkIri(s.iri, `${what}.iri`), identifier: rOpt(s.identifier, `${what}.identifier`), owner: rOptIri(s.owner, `${what}.owner`) } : {}),
    name: rOpt(s.name, `${what}.name`), tags: rList(s.tags, `${what}.tags`, rStr), priority: rOpt(s.priority, `${what}.priority`),
    currentVersion: rOptIri(s.currentVersion, `${what}.currentVersion`), relatedTo: rList(s.relatedTo, `${what}.relatedTo`, checkIri),
  };
}

/** #1582 — one delivery step node. `index` is the delivery's version this step makes (1 for the `offered` step of a create). */
function canonStep(s, what) {
  obj(s, ['iri', 'index', 'state', 'at', 'source', 'creator', 'attempt', 'reason', 'text', 'traceId', 'ofModelCall'], what);
  return {
    iri: checkIri(s.iri, `${what}.iri`), index: intLit(s.index, `${what}.index`), state: rStr(s.state, `${what}.state`),
    at: rStr(s.at, `${what}.at`), source: rStr(s.source, `${what}.source`), creator: rOpt(s.creator, `${what}.creator`),
    attempt: rCount(s.attempt, `${what}.attempt`), reason: rOpt(s.reason, `${what}.reason`), text: rOpt(s.text, `${what}.text`),
    traceId: rOpt(s.traceId, `${what}.traceId`), ofModelCall: rOptIri(s.ofModelCall, `${what}.ofModelCall`),
  };
}

// #1762 S2 (contract v2.2) — every field of a refusal is checked against the SAME closed registries the builder uses
// (core/refusal-record.mjs), so a direct `refusal.record` that skips the builder still cannot store an unregistered code,
// rule, route or action. The identity is re-derived here: a requestId-scoped opId must be the hash of (seat, route,
// requestId), and a node IRI must be its opId's, so a retried refusal cannot land a second record and two scopes never share.
function canonRefusal(r, opId) {
  obj(r, ['iri', 'route', 'refusedAction', 'status', 'code', 'rule', 'entityKind', 'entityId', 'requestId', 'associatedWith'], 'refusal');
  const iri = checkIri(r.iri, 'refusal.iri');
  if (iri !== RF.refusalIriOf(opId)) fail('refusal.iri must be the IRI its opId derives (refusalIriOf)');
  const listed = (v, k, ok, optional) => {
    if (optional && v === null) return null;
    if (v !== RF.UNLISTED && !(typeof v === 'string' && ok(v))) fail(`refusal.${k}: not in its registry (a refusal stores only registered values, else unlisted)`);
    return v;
  };
  const route = listed(r.route, 'route', (v) => RF.ROUTE_TEMPLATES.has(v) || Object.hasOwn(RF.ADAPTER_ROUTES, v));
  const refusedAction = r.refusedAction;
  if (refusedAction !== RF.refusedActionOf(route)) fail('refusal.refusedAction must be the action its route names');
  const code = listed(r.code ?? null, 'code', (v) => RF.REFUSAL_CODES.has(v), true);
  const rule = listed(r.rule ?? null, 'rule', (v) => RF.REFUSAL_RULES.has(v), true);
  const shaped = (v, k, re) => { if (v == null) return null; if (typeof v !== 'string' || !re.test(v)) fail(`refusal.${k}: not its id shape`); return v; };
  const entityKind = shaped(r.entityKind, 'entityKind', RF.ENTITY_KIND_RE);
  if (entityKind == null) fail('refusal.entityKind is required');
  const status = intLit(r.status, 'refusal.status');
  if (BigInt(status) < 400n || BigInt(status) > 599n) fail('refusal.status must be 400-599');
  const associatedWith = checkIri(r.associatedWith, 'refusal.associatedWith');
  if (!/^https:\/\/scrumboard\.local\/person\/[a-z0-9][a-z0-9_-]{0,63}$/.test(associatedWith) && associatedWith !== RF.REFUSAL_UNKNOWN) fail('refusal.associatedWith must be a seat Person IRI or scrum:unknown');
  const requestId = shaped(r.requestId, 'requestId', RF.REQUEST_ID_RE);
  if (requestId != null ? opId !== RF.refusalOpId(associatedWith, route, requestId) : !/^urn:ex:op\/refused\/fresh-[0-9a-f-]{36}$/.test(opId)) {
    fail('a refusal\'s opId is urn:ex:op/refused/<sha256(seat, route, requestId)> with a requestId, else refused/fresh-<uuid>');
  }
  return { iri, route, refusedAction, status, code, rule, entityKind, entityId: shaped(r.entityId, 'entityId', RF.ENTITY_ID_RE), requestId, associatedWith };
}

function canonicalizeRecord(i) {
  const allowed = ['kind', 'opId', 'actor', 'evidence', 'people', ...RECORD_FIELDS[i.kind], ...(RECORD_HISTORY[i.kind] ? ['history'] : [])];   // #1762 S1b
  for (const k of Object.keys(i)) if (!allowed.includes(k)) fail(`unknown field ${k} for kind ${i.kind}`);
  const opId = checkIri(i.opId, 'opId');
  if (!opId.startsWith(`${NS}op/`)) fail(`opId must be under ${NS}op/`);
  const actor = checkIri(i.actor, 'actor');
  const evidence = [...new Set((i.evidence || []).map((e, k) => checkIri(e, `evidence[${k}]`)))].sort();
  const people = canonPeople(i.people ?? [], 'people');
  let record;
  if (i.kind === 'person.import') {
    if (!people.length) fail('a person.import carries at least one Person');
    record = {};
  } else if (i.kind === 'memory.create') {
    const memory = canonMemoryState(i.memory, 'memory', true);
    const versions = canonVersions(i.versions ?? [], 'versions');
    if (versions.some((v) => v.iri === memory.iri)) fail('a version IRI equals the memory IRI');
    record = { memory, versions };
  } else if (i.kind === 'memory.revise') {
    const t = obj(i.target, ['iri', 'expectedVersion'], 'target');
    const target = { iri: checkIri(t.iri, 'target.iri'), expectedVersion: intLit(t.expectedVersion, 'target.expectedVersion') };
    const set = canonMemoryState(i.set, 'set', false);
    const versions = canonVersions(i.versions ?? [], 'versions');
    if (versions.some((v) => v.iri === target.iri)) fail('a version IRI equals the memory IRI');
    record = { target, set, versions };
  } else if (i.kind === 'decision.create') {
    const d = obj(i.decision, ['iri', 'identifier', 'statement', 'decidedBy', 'constrains', 'reopensIf', 'dateCreated', 'supersedes', 'duplicateOf'], 'decision');
    record = { decision: {
      iri: checkIri(d.iri, 'decision.iri'), identifier: rOpt(d.identifier, 'decision.identifier'),
      statement: rOpt(d.statement, 'decision.statement'), decidedBy: rOptIri(d.decidedBy, 'decision.decidedBy'),
      constrains: rList(d.constrains, 'decision.constrains', rStr), reopensIf: rOpt(d.reopensIf, 'decision.reopensIf'),
      dateCreated: rOpt(d.dateCreated, 'decision.dateCreated'),
      supersedes: rList(d.supersedes, 'decision.supersedes', checkIri), duplicateOf: rList(d.duplicateOf, 'decision.duplicateOf', checkIri),
    } };
    const D = record.decision;
    if ([...D.supersedes, ...D.duplicateOf].includes(D.iri)) fail('a decision cannot relate to itself');
  } else if (i.kind === 'post.create') {
    // #1574 C3c — every field comes from the outbox entry's frozen payload plus the two values the server fixed once
    // at the first publish attempt (publicationAt, postSeq). All of it is in `record`, so all of it is digest-covered.
    const p = obj(i.post, ['id', 'body', 'author', 'originActor', 'origin', 'occurredAt', 'publicationAt', 'postSeq', 'mentions'], 'post');
    const o = obj(p.origin, ['mutationId', 'slot'], 'post.origin');
    if (!Number.isSafeInteger(p.postSeq) || p.postSeq <= 0) fail('post.postSeq must be a positive safe integer');
    const seat = (v, what) => { const x = rStr(v, what); if (!x) fail(`${what} is empty`); return checkIri(`${PERSON_IRI}${x}`, what); };
    record = { post: {
      iri: checkIri(`${ENTITY_IRI}${rStr(p.id, 'post.id')}`, 'post.id'), body: rStr(p.body, 'post.body'),
      author: seat(p.author, 'post.author'), originActor: seat(p.originActor, 'post.originActor'),
      mutationId: rStr(o.mutationId, 'post.origin.mutationId'), slot: rStr(o.slot, 'post.origin.slot'),
      occurredAt: rStr(p.occurredAt, 'post.occurredAt'), publicationAt: rStr(p.publicationAt, 'post.publicationAt'),
      postSeq: p.postSeq, mentions: rList(p.mentions, 'post.mentions', rStr),
    } };
  } else if (i.kind === 'post.import' || i.kind === 'post.write') {
    // #1574 R0 (and R2's post.write, which writes the same shape) — a document post copied as it is stored: only the SETTLED fields exist here, so nothing unsettled can be
    // dropped on the way in (the backfill refuses a post that carries one). createdAt is the stored time, never now.
    const p = obj(i.post, ['id', 'body', 'author', 'createdAt', 'attachedTo', 'mentions', 'postSeq', 'conversation', 'onBehalfOf', 'recovered', 'opId', 'origin', 'attachments', 'originalAuthorToken', 'authorCorrectedAt', 'authorCorrectedBy'], 'post');
    if (!Number.isSafeInteger(p.postSeq) || p.postSeq <= 0) fail('post.postSeq must be a positive safe integer');
    const author = rStr(p.author, 'post.author'); if (!author) fail('post.author is empty');
    const about = rOpt(p.attachedTo, 'post.attachedTo');
    const iri = checkIri(`${ENTITY_IRI}${rStr(p.id, 'post.id')}`, 'post.id');
    const conv = rOpt(p.conversation, 'post.conversation');
    let origin = null;
    if (p.origin != null) {
      const o = obj(p.origin, ['mutationId', 'slot', 'occurredAt'], 'post.origin');
      origin = { mutationId: rStr(o.mutationId, 'post.origin.mutationId'), slot: rStr(o.slot, 'post.origin.slot'), occurredAt: rOpt(o.occurredAt, 'post.origin.occurredAt') };
    }
    if (p.attachments != null && !Array.isArray(p.attachments)) fail('post.attachments must be an array');
    const attachments = (p.attachments || []).map((a, k) => {
      const w = `post.attachments[${k}]`; obj(a, ['id', 'mime', 'name', 'size'], w);
      if (!Number.isSafeInteger(a.size) || a.size < 0) fail(`${w}.size must be a non-negative safe integer`);
      return { iri: checkIri(`${iri}/attachment/${k}`, `${w}`), index: k, id: rStr(a.id, `${w}.id`), mime: rStr(a.mime, `${w}.mime`), name: rStr(a.name, `${w}.name`), size: a.size };
    });
    record = { post: {
      iri, body: rStr(p.body, 'post.body'),
      author: checkIri(`${PERSON_IRI}${author}`, 'post.author'), createdAt: rStr(p.createdAt, 'post.createdAt'),
      about: about ? checkIri(`${ENTITY_IRI}${about}`, 'post.attachedTo') : null,
      mentions: rList(p.mentions, 'post.mentions', rStr), postSeq: p.postSeq,
      conversation: conv ? checkIri(`https://scrumboard.local/talk/${conv}`, 'post.conversation') : null,
      onBehalfOf: rOpt(p.onBehalfOf, 'post.onBehalfOf'), recovered: rOpt(p.recovered, 'post.recovered'), opId: rOpt(p.opId, 'post.opId'),
      origin, attachments,
      originalAuthorToken: rOpt(p.originalAuthorToken, 'post.originalAuthorToken'), authorCorrectedAt: rOpt(p.authorCorrectedAt, 'post.authorCorrectedAt'),
      authorCorrectedBy: rOpt(p.authorCorrectedBy, 'post.authorCorrectedBy'),
    } };
  } else if (i.kind === 'post.redact') {
    // #1574 R4a — content-free by construction: the intention names the post and nothing it said.
    const p = obj(i.post, ['id'], 'post');
    record = { post: { iri: checkIri(`${ENTITY_IRI}${rStr(p.id, 'post.id')}`, 'post.id') },
      authorityRef: rStr(i.authorityRef, 'authorityRef'), occurredAt: rStr(i.occurredAt, 'occurredAt') };
  } else if (i.kind === 'delivery.create') {
    // #1582 — the delivery's IRI is DERIVED by the caller from (deliveredTo, ofConversation); fresh, so a second create of
    // the same pair is PRECONDITION_FAILED here and the route answers the existing node instead.
    const d = obj(i.delivery, ['iri', 'deliveredTo', 'ofConversation', 'source', 'offeredAt', 'step'], 'delivery');
    record = { delivery: {
      iri: checkIri(d.iri, 'delivery.iri'), deliveredTo: rStr(d.deliveredTo, 'delivery.deliveredTo'),
      ofConversation: checkIri(d.ofConversation, 'delivery.ofConversation'), source: rStr(d.source, 'delivery.source'),
      offeredAt: rStr(d.offeredAt, 'delivery.offeredAt'), step: canonStep(d.step, 'delivery.step'),
    } };
    if (record.delivery.step.index !== '1') fail('delivery.step.index of a create is 1');
  } else if (i.kind === 'delivery.import') {
    // #1582 migration — a delivery moved from the document with its whole history: steps 1..n in order, version n.
    const d = obj(i.delivery, ['iri', 'deliveredTo', 'ofConversation', 'source', 'offeredAt', 'steps'], 'delivery');
    if (!Array.isArray(d.steps) || !d.steps.length) fail('delivery.steps is a non-empty array');
    const steps = d.steps.map((x, k) => canonStep(x, `delivery.steps[${k}]`));
    steps.forEach((x, k) => { if (x.index !== String(k + 1)) fail(`delivery.steps[${k}].index must be ${k + 1}`); });
    record = { delivery: {
      iri: checkIri(d.iri, 'delivery.iri'), deliveredTo: rStr(d.deliveredTo, 'delivery.deliveredTo'),
      ofConversation: checkIri(d.ofConversation, 'delivery.ofConversation'), source: rStr(d.source, 'delivery.source'),
      offeredAt: rStr(d.offeredAt, 'delivery.offeredAt'), steps,
    } };
  } else if (i.kind === 'delivery.step') {
    // #1582 — the same expected-version guard as memory.revise: a step written against a stale read is PRECONDITION_FAILED.
    const t = obj(i.target, ['iri', 'expectedVersion'], 'target');
    const target = { iri: checkIri(t.iri, 'target.iri'), expectedVersion: intLit(t.expectedVersion, 'target.expectedVersion') };
    const step = canonStep(i.step, 'step');
    if (BigInt(step.index) !== BigInt(target.expectedVersion) + 1n) fail('step.index must be target.expectedVersion + 1');
    record = { target, step };
  } else if (i.kind === 'modelcall.create') {
    const m = obj(i.call, ['iri', 'agent', 'model', 'calledAt', 'cost', 'producedPost', 'postedText', 'requestId', 'entityJson'], 'call');
    record = { call: {
      iri: checkIri(m.iri, 'call.iri'), agent: rStr(m.agent, 'call.agent'), model: rOpt(m.model, 'call.model'),
      calledAt: rStr(m.calledAt, 'call.calledAt'), cost: rStr(m.cost, 'call.cost'),
      producedPost: rOptIri(m.producedPost, 'call.producedPost'), postedText: rOpt(m.postedText, 'call.postedText'),
      requestId: rStr(m.requestId, 'call.requestId'), entityJson: rStr(m.entityJson, 'call.entityJson'),
    } };
  } else if (i.kind === 'refusal.record') {
    record = { refusal: canonRefusal(i.refusal, opId) };
  } else if (i.kind === 'card.write') {
    record = canonCardWrite(i);
    if (i.origin != null) record = canonOriginCommit(i, record, { opId, actor, evidence, people });   // #1629 s2
  } else if (i.kind === 'origin.prepare') {
    record = canonOriginPrepare(i, { opId, actor, evidence, people });   // #1629 s2
  } else if (i.kind === 'entity.put') {
    // #1624 — ONE generic storage primitive. The `kind` field on the entity selects which
    // allowlisted projection runs; only kinds explicitly listed here can be written through
    // it. Adding a new family = one row in the canonicalizeRecord/planRecord blocks. No new
    // authority is granted: the same actor + people + digest + fresh-IRI guards apply.
    // `entityJson` is the canonical wire JSON the writer chooses to persist; the wake
    // projection stores it on the node so a reader on either store reads the same wire.
    if (i.entity && i.entity.kind === 'collection') {
      // #1624 — the MUTABLE families (review 08:37Z): one or more collection entities in ONE guarded update, through the
      // same allowlisted entity.put (no second generic write API). See canonCollectionWrite.
      if (i.history !== undefined) fail('a collection entity.put carries its history on each part, not on the intention');   // #1762 S1b
      record = { entity: canonCollectionWrite(i.entity) };
      if (people.length) record.people = people;
      return { kind: i.kind, opId, actor, evidence, record, targets: [], newAssertion: null, authority: null, grant: null, rule: null };
    }
    const e = obj(i.entity, ['kind', 'iri', 'seat', 'at', 'note', 'entityJson'], 'entity');
    if (e.kind === 'wake') {
      record = { entity: {
        kind: 'wake', iri: checkIri(e.iri, 'entity.iri'),
        seat: rStr(e.seat, 'entity.seat'),
        at: rStr(e.at, 'entity.at'),
        note: rOpt(e.note, 'entity.note'),
        entityJson: rStr(e.entityJson, 'entity.entityJson'),
      } };
    } else {
      fail(`entity.kind must be one of wake (got ${JSON.stringify(e.kind)})`);
    }
  } else if (i.kind === 'decision.relate') {
    const target = checkIri(i.target, 'target');
    const supersedes = rList(i.supersedes, 'supersedes', checkIri);
    const duplicateOf = rList(i.duplicateOf, 'duplicateOf', checkIri);
    if (!supersedes.length && !duplicateOf.length) fail('a relate names at least one relation');
    if ([...supersedes, ...duplicateOf].includes(target)) fail('a decision cannot relate to itself');
    record = { target, supersedes, duplicateOf };
  } else {
    const seat = checkIri(i.seat, 'seat');
    const ends = rOptIri(i.ends, 'ends');
    const at = rOpt(i.at, 'at');
    if (ends && !at) fail('ending an open declaration needs `at`');
    if (i.kind === 'seat.clear') {
      if (!ends) fail('a clear ends an open declaration: `ends` is required');
      record = { seat, ends, at };
    } else {
      const d = obj(i.declaration, ['iri', 'mode', 'acceptsRoutineWork', 'constraints', 'note', 'declaredAt', 'expiresAt', 'role', 'endedAt'], 'declaration');
      const arw = d.acceptsRoutineWork;
      if (arw !== undefined && arw !== null && arw !== 'true' && arw !== 'false') fail('declaration.acceptsRoutineWork must be "true", "false" or absent');
      const declaration = {
        iri: checkIri(d.iri, 'declaration.iri'), mode: rStr(d.mode, 'declaration.mode'),
        acceptsRoutineWork: arw ?? null, constraints: rList(d.constraints, 'declaration.constraints', rStr),
        note: rOpt(d.note, 'declaration.note'), declaredAt: rOpt(d.declaredAt, 'declaration.declaredAt'),
        expiresAt: rOpt(d.expiresAt, 'declaration.expiresAt'), role: rOptIri(d.role, 'declaration.role'),
        endedAt: rOpt(d.endedAt, 'declaration.endedAt'),
      };
      if (declaration.iri === ends) fail('the new declaration cannot end itself');
      record = { seat, declaration, ends, at };
    }
  }
  // Person identity effects ride the record, so the digest (which binds `record`) binds
  // them: a replay under the same opId with different Person effects is an
  // intent-collision. Absent when empty, so a Person-less intention's digest is unchanged.
  if (people.length) record.people = people;
  // #1762 S1b — the activity facts ride the record, so the digest binds them; absent when the intention carries none, so a
  // history-less intention's digest is unchanged.
  const history = canonRecordHistory(i, record);
  if (history) record.history = history;
  return { kind: i.kind, opId, actor, evidence, record, targets: [], newAssertion: null, authority: null, grant: null, rule: null };
}

/** The revision node a `memory.revise` at `expectedVersion` writes (derived from digested fields only). */
export const memoryRevisionIri = (memoryIri, expectedVersion) => `${memoryIri}/revision/${expectedVersion}`;
/**
 * #1561 — the Person identity payload of a record intention: the planner's `plan.create`
 * (core/graph-people.mjs), in its whitelist shape. Fields outside PERSON_PAYLOAD_FIELDS are
 * REFUSED (not dropped: the planner already projected them, so an extra field here is a
 * caller bug). Canonical: sorted by identifier, aliases a sorted set, glyph/name null when absent.
 */
export const PERSON_PAYLOAD_FIELDS = Object.freeze(['@type', '@id', 'identifier', 'name', 'scrum:glyph', 'scrum:resolved', 'scrum:aliases']);
export const PERSON_IRI = 'https://scrumboard.local/person/';
export const ENTITY_IRI = 'https://scrumboard.local/entity/';   // #1574 C3c — a post node
function canonPeople(list, what) {
  if (!Array.isArray(list)) fail(`${what} must be an array`);
  const out = list.map((x, k) => {
    const w = `${what}[${k}]`;
    obj(x, PERSON_PAYLOAD_FIELDS, w);
    if (x['@type'] !== 'Person') fail(`${w}.@type must be "Person"`);
    const identifier = rStr(x.identifier, `${w}.identifier`);
    if (!identifier) fail(`${w}.identifier is empty`);
    const iri = checkIri(x['@id'], `${w}.@id`);
    if (iri !== `${PERSON_IRI}${identifier}`) fail(`${w}: @id ${iri} is not ${PERSON_IRI}${identifier}`);
    const glyph = x['scrum:glyph'];
    const resolved = x['scrum:resolved'];
    if (resolved !== undefined && resolved !== null && typeof resolved !== 'boolean') fail(`${w}.scrum:resolved must be a boolean`);
    return {
      iri, identifier, name: rOpt(x.name, `${w}.name`), glyph: rOpt(glyph, `${w}.scrum:glyph`),
      resolved: typeof resolved === 'boolean' ? resolved : null,
      aliases: rList(x['scrum:aliases'], `${w}.scrum:aliases`, rStr),
    };
  }).sort((a, b) => (a.identifier < b.identifier ? -1 : a.identifier > b.identifier ? 1 : 0));
  if (new Set(out.map((p) => p.identifier)).size !== out.length) fail(`${what}: duplicate Person identifier`);
  return out;
}

function recordDigest(c) {
  const lines = [`digestV ${DIGEST_V}`, `canonV ${CANON_V}`, `recordV ${RECORD_V}`, `kind ${c.kind}`,
    `opId ${ref(c.opId)}`, `actor ${ref(c.actor)}`, `record ${JSON.stringify(c.record)}`,
    ...c.evidence.map((e) => `evidence ${ref(e)}`)];
  return createHash('sha256').update(lines.join('\n') + '\n').digest('hex');
}

// ── Person DOMAIN effects (#1561) ──
// There is no hook: Person identity effects are the intention's own `people` payload (the
// planner's `plan.create`), canonicalized into `record.people` and therefore bound by the
// digest. Each is created only where NO typed node holds that IRI yet (a precondition, so
// an existing canonical identity is never overwritten), and its triples are ordinary
// ok-guarded DOMAIN inserts: a PRECONDITION_FAILED or replayed intention writes none of them.
// Nothing here ever DELETES a Person triple.

/** The domain plan of one record intention: what must hold, what is removed, what is added. */
function planRecord(c) {
  const R = c.record;
  const I = (iri) => ref(iri);
  const L = (s) => recLit(s);
  const pre = [];
  const fresh = [];
  const freshSubject = [];   // #1626
  const ins = [];          // [subject IRI, predicate IRI, object TEXT]
  const delAll = [];       // [{s, p, keep?:[subject, predicate]}]: every current value is removed (and, with keep, recorded there)
  const delAny = [];       // #1574 R4a [{s, keep:[predicate…]}]: every triple of s is removed except those predicates
  const delOwned = [];     // #1574 R4a [{owner, prefix}]: every triple of every node that is attachmentOf owner AND under prefix is removed
  const delLinked = [];    // #1582 [{link, owner, type, pred}]: every `pred` value on every node of `type` that `link`s to owner is removed
  const condIns = [];      // #1582 [{s, p, o, unless:[node, type]}]: inserted only where `node` is NOT of `type` when the update runs
  const insAt = [];        // #1762 S2 [[s, p]]: s p ?n_at, the receipt's own NOW(), ok-guarded through its subject
  let verGuard = null;
  let target;
  let dispatchHold = null;   // #1749 A8: the obligationId a dispatch intention settles or publishes
  const add = (s, p, o) => { if (o != null) ins.push([s, p, o]); };
  const versionNodes = (M, versions) => {
    for (const v of versions) {
      fresh.push(v.iri);
      add(v.iri, TM.type, I(TM.MemoryVersion)); add(v.iri, TM.ofMemory, I(M));
      add(v.iri, TM.version, v.version == null ? null : L(v.version)); add(v.iri, TM.body, v.body == null ? null : L(v.body));
      add(v.iri, TM.author, v.author && I(v.author)); add(v.iri, TM.dateCreated, v.dateCreated == null ? null : L(v.dateCreated));
      add(v.iri, TM.recordedBy, ref(c.opId));
    }
  };
  const mutable = (M, s) => {
    add(M, TM.name, s.name == null ? null : L(s.name));
    for (const t of s.tags) add(M, TM.tag, L(t));
    add(M, TM.priority, s.priority == null ? null : L(s.priority));
    add(M, TM.currentVersion, s.currentVersion && I(s.currentVersion));
    for (const r of s.relatedTo) add(M, TM.relatedTo, I(r));
  };
  if (c.kind === 'memory.create') {
    const M = R.memory.iri; target = null;   // a create names no receipt target: the receipt would make the new IRI non-fresh
    fresh.push(M);
    add(M, TM.type, I(TM.Memory));
    add(M, TM.identifier, R.memory.identifier == null ? null : L(R.memory.identifier));
    add(M, TM.owner, R.memory.owner && I(R.memory.owner));
    mutable(M, R.memory);
    add(M, TM.ver, '1');
    versionNodes(M, R.versions);
  } else if (c.kind === 'memory.revise') {
    const M = R.target.iri; target = M;
    pre.push(`    ${I(M)} ${I(TM.type)} ${I(TM.Memory)} .`, `    GRAPH ${BK} { ${I(M)} ${I(TM.ver)} ?xv . }`, `    FILTER(?xv = ${R.target.expectedVersion})`);   // #1638 — the version stamp is bookkeeping
    verGuard = M;
    // the identity this revise replaces, kept on a revision node (see the header: RECORD_V 2)
    const REV = memoryRevisionIri(M, R.target.expectedVersion);
    fresh.push(REV);
    add(REV, TM.type, I(TM.MemoryRevision)); add(REV, TM.ofMemory, I(M));
    add(REV, TM.revision, L(R.target.expectedVersion)); add(REV, TM.recordedBy, ref(c.opId));
    for (const [p, prior] of [[TM.name, TM.priorName], [TM.tag, TM.priorTag], [TM.priority, TM.priorPriority],
      [TM.currentVersion, TM.priorCurrentVersion], [TM.relatedTo, TM.priorRelatedTo]]) delAll.push({ s: M, p, keep: [REV, prior] });
    mutable(M, R.set);
    versionNodes(M, R.versions);
  } else if (c.kind === 'decision.create') {
    const D = R.decision; target = null;
    fresh.push(D.iri);
    for (const t of [...D.supersedes, ...D.duplicateOf]) pre.push(`    ${I(t)} ${I(TM.type)} ${I(TM.Decision)} .`);
    add(D.iri, TM.type, I(TM.Decision));
    add(D.iri, TM.identifier, D.identifier == null ? null : L(D.identifier));
    add(D.iri, TM.statement, D.statement == null ? null : L(D.statement));
    add(D.iri, TM.decidedBy, D.decidedBy && I(D.decidedBy));
    for (const t of D.constrains) add(D.iri, TM.constrains, L(t));
    add(D.iri, TM.reopensIf, D.reopensIf == null ? null : L(D.reopensIf));
    add(D.iri, TM.dateCreated, D.dateCreated == null ? null : L(D.dateCreated));
    for (const t of D.supersedes) add(D.iri, TM.supersedes, I(t));
    for (const t of D.duplicateOf) add(D.iri, TM.duplicateOf, I(t));
    add(D.iri, TM.recordedBy, ref(c.opId));
  } else if (c.kind === 'decision.relate') {
    target = R.target;
    for (const t of [R.target, ...R.supersedes, ...R.duplicateOf]) pre.push(`    ${I(t)} ${I(TM.type)} ${I(TM.Decision)} .`);
    for (const t of R.supersedes) add(R.target, TM.supersedes, I(t));
    for (const t of R.duplicateOf) add(R.target, TM.duplicateOf, I(t));
  } else if (c.kind === 'post.create') {
    const P = R.post; target = null;   // a create: the post IRI must be fresh
    dispatchHold = `${P.mutationId}:${P.slot}`;   // #1749 A8: the announcement is a dispatch of this obligation
    fresh.push(P.iri);
    add(P.iri, TM.type, I(TM.Comment));
    add(P.iri, TM.text, L(P.body));
    add(P.iri, TM.author, I(P.author));
    add(P.iri, TM.dateCreated, L(P.publicationAt));
    add(P.iri, TM.postSeq, String(P.postSeq));   // a bare integer token: an xsd:integer literal (logical order, not discovery)
    add(P.iri, TM.originOccurredAt, L(P.occurredAt));
    add(P.iri, TM.originMutation, L(P.mutationId));
    add(P.iri, TM.originSlot, L(P.slot));
    add(P.iri, TM.originActor, I(P.originActor));
    for (const m of P.mentions) add(P.iri, TM.mentionsName, L(m));
    add(P.iri, TM.recordedBy, ref(c.opId));
    pre.push(...reservedPostGuard(P));   // #1629 s3 G-R — a reservation behind this postId binds the post, in this update
  } else if (c.kind === 'post.import' || c.kind === 'post.write') {
    const P = R.post; target = null;   // a create: the post IRI must be fresh
    // #1626 — an IMPORT copies a post that already existed in the document, so other graph nodes may reference it already
    // (a delivery's ofConversation, a model call's producedPost): it needs only to hold no triples itself. A WRITE (a
    // brand-new post) keeps the full guard: nothing may point at an id that has never existed.
    if (c.kind === 'post.import') freshSubject.push(P.iri); else fresh.push(P.iri);
    add(P.iri, TM.type, I(TM.Comment));
    add(P.iri, TM.text, L(P.body));
    add(P.iri, TM.author, I(P.author));
    add(P.iri, TM.dateCreated, L(P.createdAt));
    add(P.iri, TM.about, P.about && I(P.about));
    for (const m of P.mentions) add(P.iri, TM.mentionsName, L(m));
    add(P.iri, TM.postSeq, String(P.postSeq));   // the STORED number, an xsd:integer: never renumbered
    // #1574 U1–U4 — the talk tag (a grouping, not access control), the DECLARED onBehalfOf (a literal, never proof), provenance strings
    add(P.iri, TM.conversation, P.conversation && I(P.conversation));
    add(P.iri, TM.onBehalfOf, P.onBehalfOf == null ? null : L(P.onBehalfOf));
    add(P.iri, TM.recovered, P.recovered == null ? null : L(P.recovered));
    add(P.iri, TM.opId, P.opId == null ? null : L(P.opId));
    for (const k of ['originalAuthorToken', 'authorCorrectedAt', 'authorCorrectedBy']) add(P.iri, TM[k], P[k] == null ? null : L(P[k]));
    if (P.origin) {
      add(P.iri, TM.originMutation, L(P.origin.mutationId)); add(P.iri, TM.originSlot, L(P.origin.slot));
      add(P.iri, TM.originOccurredAt, P.origin.occurredAt == null ? null : L(P.origin.occurredAt));
    }
    for (const A of P.attachments) {   // one fresh node per attachment, by array index; the bytes stay on disk
      fresh.push(A.iri);
      add(A.iri, TM.attachmentOf, I(P.iri)); add(A.iri, TM.attachmentIndex, String(A.index));
      add(A.iri, TM.identifier, L(A.id)); add(A.iri, TM.name, L(A.name)); add(A.iri, TM.encodingFormat, L(A.mime)); add(A.iri, TM.contentSize, String(A.size));
      add(A.iri, TM.recordedBy, ref(c.opId));
    }
    add(P.iri, TM.recordedBy, ref(c.opId));
  } else if (c.kind === 'delivery.import') {
    // #1582 migration — the delivery node at version n and its n steps, all fresh: a re-run replays the receipt, and a
    // node already in the graph (a delivery created live since) is PRECONDITION_FAILED, never overwritten.
    const X = R.delivery; const D = X.iri; target = null;
    fresh.push(D);
    add(D, TM.type, I(TM.Delivery)); add(D, TM.deliveredTo, L(X.deliveredTo)); add(D, TM.ofConversation, I(X.ofConversation));
    add(D, TM.source, L(X.source)); add(D, TM.offeredAt, L(X.offeredAt)); add(D, TM.ver, String(X.steps.length)); add(D, TM.recordedBy, ref(c.opId));
    for (const S of X.steps) {
      fresh.push(S.iri);
      add(S.iri, TM.type, I(TM.DeliveryStep)); add(S.iri, TM.stepOf, I(D)); add(S.iri, TM.stepIndex, S.index);
      add(S.iri, TM.state, L(S.state)); add(S.iri, TM.at, L(S.at)); add(S.iri, TM.source, L(S.source));
      add(S.iri, TM.creator, S.creator == null ? null : L(S.creator)); add(S.iri, TM.attempt, S.attempt == null ? null : S.attempt);
      add(S.iri, TM.reason, S.reason == null ? null : L(S.reason)); add(S.iri, TM.text, S.text == null ? null : L(S.text));
      add(S.iri, TM.traceId, S.traceId == null ? null : L(S.traceId)); add(S.iri, TM.ofModelCall, S.ofModelCall && I(S.ofModelCall));
      if (S.ofModelCall) pre.push(`    ${I(S.ofModelCall)} ${I(TM.type)} ${I(TM.ModelCall)} .`);
      add(S.iri, TM.recordedBy, ref(c.opId));
    }
  } else if (c.kind === 'delivery.create' || c.kind === 'delivery.step') {
    // #1582 — a delivery node carries `urn:ex:ver` (its version = the index of its latest step). A create makes the node
    // at ver 1 with its `offered` step; a step is guarded on the expected version (the memory.revise shape), bumps it, and
    // adds ONE fresh step node whose stepIndex is the new version, so a delivery's steps are ordered by construction.
    let D, S;
    if (c.kind === 'delivery.create') {
      const X = R.delivery; D = X.iri; S = X.step; target = null;
      fresh.push(D);
      add(D, TM.type, I(TM.Delivery)); add(D, TM.deliveredTo, L(X.deliveredTo)); add(D, TM.ofConversation, I(X.ofConversation));
      add(D, TM.source, L(X.source)); add(D, TM.offeredAt, L(X.offeredAt)); add(D, TM.ver, '1'); add(D, TM.recordedBy, ref(c.opId));
    } else {
      D = R.target.iri; S = R.step; target = D;
      pre.push(`    ${I(D)} ${I(TM.type)} ${I(TM.Delivery)} .`, `    GRAPH ${BK} { ${I(D)} ${I(TM.ver)} ?xv . }`, `    FILTER(?xv = ${R.target.expectedVersion})`);   // #1638
      verGuard = D;
      if (S.ofModelCall) pre.push(`    ${I(S.ofModelCall)} ${I(TM.type)} ${I(TM.ModelCall)} .`);   // a step names a ledger row that exists
    }
    fresh.push(S.iri);
    add(S.iri, TM.type, I(TM.DeliveryStep)); add(S.iri, TM.stepOf, I(D)); add(S.iri, TM.stepIndex, S.index);
    add(S.iri, TM.state, L(S.state)); add(S.iri, TM.at, L(S.at)); add(S.iri, TM.source, L(S.source));
    add(S.iri, TM.creator, S.creator == null ? null : L(S.creator)); add(S.iri, TM.attempt, S.attempt == null ? null : S.attempt);
    add(S.iri, TM.reason, S.reason == null ? null : L(S.reason)); add(S.iri, TM.text, S.text == null ? null : L(S.text));
    add(S.iri, TM.traceId, S.traceId == null ? null : L(S.traceId)); add(S.iri, TM.ofModelCall, S.ofModelCall && I(S.ofModelCall));
    add(S.iri, TM.recordedBy, ref(c.opId));
  } else if (c.kind === 'refusal.record') {
    // #1762 S2 — one fresh node; `unlisted` is the IRI scrum:unlisted; its time is the receipt's own NOW() (insAt)
    const F = R.refusal; target = null;
    const tok = (v) => (v === RF.UNLISTED ? I(`${RS}unlisted`) : L(v));
    fresh.push(F.iri);
    add(F.iri, TM.type, I(TM.RefusalRecord)); add(F.iri, TM.route, tok(F.route)); add(F.iri, TM.refusedAction, tok(F.refusedAction));
    add(F.iri, TM.status, F.status); add(F.iri, TM.code, F.code == null ? null : tok(F.code)); add(F.iri, TM.rule, F.rule == null ? null : tok(F.rule));
    add(F.iri, TM.entityKind, L(F.entityKind)); add(F.iri, TM.entityId, F.entityId == null ? null : L(F.entityId));
    add(F.iri, TM.requestId, F.requestId == null ? null : L(F.requestId)); add(F.iri, TM.wasAssociatedWith, I(F.associatedWith));
    add(F.iri, TM.recordedBy, ref(c.opId));
    insAt.push([F.iri, TM.startedAtTime]);
  } else if (c.kind === 'modelcall.create') {
    const M = R.call; target = null;
    fresh.push(M.iri);
    add(M.iri, TM.type, I(TM.ModelCall)); add(M.iri, TM.agent, L(M.agent)); add(M.iri, TM.model, M.model == null ? null : L(M.model));
    add(M.iri, TM.calledAt, L(M.calledAt)); add(M.iri, TM.cost, L(M.cost)); add(M.iri, TM.requestId, L(M.requestId));
    add(M.iri, TM.producedPost, M.producedPost && I(M.producedPost));
    // #1582 point 6 — THE REDACTION GUARD IS IN THIS UPDATE, not the route's: postedText is inserted only if, when this
    // update executes, the produced post is NOT a RedactedPost. So a redaction landing between a route's read and this
    // write cannot leave a copy (the executor serialises updates). The call itself is recorded either way, without the text.
    if (M.postedText != null) {
      if (M.producedPost) condIns.push({ s: M.iri, p: TM.postedText, o: L(M.postedText), unless: [M.producedPost, TM.RedactedPost] });
      else add(M.iri, TM.postedText, L(M.postedText));
    }
    add(M.iri, TM.entityJson, L(M.entityJson)); add(M.iri, TM.recordedBy, ref(c.opId));
  } else if (c.kind === 'entity.put') {
    // #1624 — the wake projection: ONE fresh node + FOUR domain triples + entityJson,
    // mirroring the replica's projectWake (graph-replica.mjs) so a reader of either store
    // reads the same triples. wokeSeat is a person IRI (the actor's `by`, declared at the
    // route); wokeAt is an ISO timestamp; entityJson is the canonical wire JSON the writer
    // chose to persist (the wake reader reads it as the document-shaped entity, so its wire
    // is the wire the document path would have answered).
    const W = R.entity;
    target = null;
    fresh.push(W.iri);
    add(W.iri, TM.type, I(TM.Wake));
    add(W.iri, TM.wokeSeat, I(`${PERSON_IRI}${encodeURIComponent(W.seat)}`));
    add(W.iri, TM.wokeAt, L(W.at));
    add(W.iri, TM.text, W.note == null ? null : L(W.note));
    add(W.iri, TM.entityJson, L(W.entityJson));
    add(W.iri, TM.recordedBy, ref(c.opId));
  } else if (c.kind === 'post.redact') {
    // #1574 R4a — LOGICAL deletion only: every content triple of the post is deleted and the node is left as a tombstone
    // (RedactedPost, its original postSeq and recordedBy, and redactedBy = this operation). The precondition is a LIVE
    // post: an unknown target, or one already redacted, is PRECONDITION_FAILED and changes nothing. This does NOT make
    // the text physically unrecoverable from the store's files; that is the physical slice, not this kind.
    const P = R.post.iri; target = P;
    pre.push(`    ${I(P)} ${I(TM.type)} ${I(TM.Comment)} ; ${I(TM.postSeq)} ?xps .`);
    // An ALLOW-list, not a deny-list: every default-graph triple of the post goes except the one the tombstone keeps, so a field added
    // later (or one this list never knew) cannot survive a redaction; and every node under the post's attachment prefix
    // goes with it (attachments go with a redacted post).
    // #1638 — the tombstone's recordedBy lives in the bookkeeping graph, where this default-graph wipe never reaches; it stays.
    delAny.push({ s: P, keep: [TM.postSeq] });
    // Attachment nodes go only when ownership is PROVEN twice (attachmentOf the post AND under the post's attachment prefix).
    // Anything ambiguous refuses the whole redaction rather than widening what is deleted: a node under the prefix that
    // does not say it belongs to this post, or a node that says it belongs to this post but lives elsewhere.
    const AP = `${P}/attachment/`;
    pre.push(`    FILTER NOT EXISTS { ?xa1 ${I(TM.attachmentOf)} ${I(P)} FILTER(!STRSTARTS(STR(?xa1), ${JSON.stringify(AP)})) }`);
    pre.push(`    FILTER NOT EXISTS { ${inEither('?xa2 ?xa2p ?xa2o')} FILTER(STRSTARTS(STR(?xa2), ${JSON.stringify(AP)})) FILTER NOT EXISTS { ?xa2 ${I(TM.attachmentOf)} ${I(P)} } }`);   // #1638 — a node under the prefix in EITHER graph
    delOwned.push({ owner: P, prefix: AP });
    // #1582 point 6 — a model call that quoted this post keeps no copy of its text: in the SAME update, every
    // `postedText` on a ModelCall whose producedPost is this post is deleted.
    delLinked.push({ link: TM.producedPost, owner: P, type: TM.ModelCall, pred: TM.postedText });
    add(P, TM.type, I(TM.RedactedPost));
    add(P, TM.redactedBy, ref(c.opId));
  } else if (c.kind === 'person.import') {
    target = null;   // only the Person nodes below; like a create, it names no receipt target
  } else {
    // seat.declare / seat.clear: at most ONE open declaration per seat, held by the graph
    const closedImport = c.kind === 'seat.declare' && R.declaration.endedAt != null;
    target = R.ends;   // the open declaration this write ends, if any (never the new one: see memory.create)
    if (R.ends) {
      pre.push(`    ${I(R.ends)} ${I(TM.type)} ${I(TM.SeatDeclaration)} ; ${I(TM.declaredSeat)} ${I(R.seat)} .`);
      pre.push(`    FILTER NOT EXISTS { ${I(R.ends)} ${I(TM.endedAt)} ?xe }`);
      add(R.ends, TM.endedAt, L(R.at));
    }
    if (!closedImport) {
      pre.push(`    FILTER NOT EXISTS { ?xo ${I(TM.type)} ${I(TM.SeatDeclaration)} ; ${I(TM.declaredSeat)} ${I(R.seat)} . FILTER NOT EXISTS { ?xo ${I(TM.endedAt)} ?xoe }${R.ends ? ` FILTER(?xo != ${I(R.ends)})` : ''} }`);
    }
    if (c.kind === 'seat.declare') {
      const d = R.declaration;
      fresh.push(d.iri);
      add(d.iri, TM.type, I(TM.SeatDeclaration)); add(d.iri, TM.declaredSeat, I(R.seat)); add(d.iri, TM.mode, L(d.mode));
      add(d.iri, TM.acceptsRoutineWork, d.acceptsRoutineWork == null ? null : L(d.acceptsRoutineWork));
      for (const x of d.constraints) add(d.iri, TM.constraint, L(x));
      add(d.iri, TM.note, d.note == null ? null : L(d.note));
      add(d.iri, TM.declaredAt, d.declaredAt == null ? null : L(d.declaredAt));
      add(d.iri, TM.expiresAt, d.expiresAt == null ? null : L(d.expiresAt));
      add(d.iri, TM.role, d.role && I(d.role));
      add(d.iri, TM.endedAt, d.endedAt == null ? null : L(d.endedAt));
      add(d.iri, TM.recordedBy, ref(c.opId));
    }
  }
  for (const P of R.people || []) {
    pre.push(`    FILTER NOT EXISTS { ${I(P.iri)} ${I(TM.type)} ?xpt }`);
    add(P.iri, TM.type, I(TM.Person));
    add(P.iri, TM.identifier, L(P.identifier));
    add(P.iri, TM.name, P.name == null ? null : L(P.name));
    add(P.iri, TM.glyph, P.glyph == null ? null : L(P.glyph));
    add(P.iri, TM.resolved, P.resolved == null ? null : L(String(P.resolved)));
    for (const a of P.aliases) add(P.iri, TM.aliases, L(a));
    add(P.iri, TM.recordedBy, ref(c.opId));
  }
  return { target, pre, fresh, freshSubject, ins, delAll, delAny, delOwned, delLinked, condIns, insAt, verGuard, dispatchHold };
}

function compileRecord(c) {
  if (c.kind === 'origin.prepare') return compileOriginPrepare(c);   // #1629 s2
  if (c.kind === 'card.write') return compileCardWrite(c);   // #1598
  if (c.kind === 'entity.put' && c.record.entity.kind === 'collection') return compileCollectionWrite(c);   // #1624
  const digest = recordDigest(c);
  const OP = ref(c.opId);
  const plan = planRecord(c);
  const where = [];
  const pre = [...plan.pre];
  const top = [];
  const dBinds = [];
  const del = [];
  const dIns = [];
  const bDel = [];   // #1638 — bookkeeping templates (inside GRAPH <bk>)
  const bIns = [];
  const names = new Map();
  const v = (text) => {
    let n = names.get(text);
    if (!n) { n = `r${names.size}`; names.set(text, n); dBinds.push(ok(text, n)); }
    return `?d_${n}`;
  };

  where.push(...dupGuard(OP));

  for (const iri of plan.fresh) pre.push(...fresh(ref(iri)));
  for (const iri of plan.freshSubject || []) pre.push(...freshSubject(ref(iri)));   // #1626
  if (plan.dispatchHold) dispatchHoldClauses({ obligationId: plan.dispatchHold, OP, pre, dBinds, bIns });   // #1749 A8
  if (plan.verGuard) {
    dBinds.push(ok('?xv', 'xvOld'), ok('?xv + 1', 'xvNew'));
    bDel.push(`  ${v(ref(plan.verGuard))} ${EX.ver} ?d_xvOld .`);
    bIns.push(`  ${v(ref(plan.verGuard))} ${EX.ver} ?d_xvNew .`);
  }
  plan.delAll.forEach(({ s, p, keep }, k) => {
    top.push(`  OPTIONAL { ${ref(s)} ${ref(p)} ?xd${k} }`);
    dBinds.push(ok(`?xd${k}`, `xd${k}`));
    del.push(`  ${v(ref(s))} ${ref(p)} ?d_xd${k} .`);
    if (keep) dIns.push(`  ${v(ref(keep[0]))} ${ref(keep[1])} ?d_xd${k} .`);
  });
  (plan.delAny || []).forEach(({ s, keep }, k) => {
    top.push(`  OPTIONAL { ${ref(s)} ?xap${k} ?xao${k} FILTER(?xap${k} NOT IN (${keep.map(ref).join(', ')})) }`);
    dBinds.push(ok(`?xap${k}`, `xap${k}`), ok(`?xao${k}`, `xao${k}`));
    del.push(`  ${v(ref(s))} ?d_xap${k} ?d_xao${k} .`);
  });
  (plan.delOwned || []).forEach(({ owner, prefix }, k) => {
    // #1638 — the attachment's default-graph triples go (wildcard), and so does its recordedBy in the bookkeeping graph
    // (read INSIDE this optional, where ?xs is bound: a free read would bind every recordedBy in the store).
    top.push(`  OPTIONAL { ?xs${k} ${ref(LOGBORN_TERMS.attachmentOf)} ${ref(owner)} . ?xs${k} ?xsp${k} ?xso${k} FILTER(STRSTARTS(STR(?xs${k}), ${JSON.stringify(prefix)})) OPTIONAL { GRAPH ${BK} { ?xs${k} ${EX.recordedBy} ?xsr${k} } } }`);
    dBinds.push(ok(`?xs${k}`, `xs${k}`), ok(`?xsp${k}`, `xsp${k}`), ok(`?xso${k}`, `xso${k}`), ok(`?xsr${k}`, `xsr${k}`));
    del.push(`  ?d_xs${k} ?d_xsp${k} ?d_xso${k} .`);
    bDel.push(`  ?d_xs${k} ${EX.recordedBy} ?d_xsr${k} .`);
  });
  (plan.delLinked || []).forEach(({ link, owner, type, pred }, k) => {
    top.push(`  OPTIONAL { ?xl${k} ${ref(link)} ${ref(owner)} ; ${ref(LOGBORN_TERMS.type)} ${ref(type)} ; ${ref(pred)} ?xlo${k} }`);
    dBinds.push(ok(`?xl${k}`, `xl${k}`), ok(`?xlo${k}`, `xlo${k}`));
    del.push(`  ?d_xl${k} ${ref(pred)} ?d_xlo${k} .`);
  });
  (plan.condIns || []).forEach(({ s, p, o, unless }, k) => {
    // ?xcn is never bound, so IF(...) yields an UNBOUND ?xc (no triple) when the node IS of the type, else the literal
    top.push(`  BIND(IF(EXISTS { ${ref(unless[0])} ${ref(LOGBORN_TERMS.type)} ${ref(unless[1])} }, ?xcn${k}, ${o}) AS ?xc${k})`);
    dBinds.push(ok(`?xc${k}`, `xc${k}`));
    dIns.push(`  ${v(ref(s))} ${ref(p)} ?d_xc${k} .`);
  });
  // #1638 — route each planned triple by the one definition of bookkeeping (ver, recordedBy, entityJson… go to the bk graph)
  for (const [s, p, o] of plan.ins) (isBookkeeping(s, p) ? bIns : dIns).push(`  ${v(ref(s))} ${ref(p)} ${v(o)} .`);
  for (const [s, p] of plan.insAt || []) dIns.push(`  ${v(ref(s))} ${ref(p)} ?n_at .`);   // #1762 S2
  // #1762 S1b — the record's ONE activity (part 0), in the same ok-guarded data INSERT as the record: APPLIED commits both,
  // a refused or replayed write inserts neither. No card-only facts: entityKind is set.
  if (c.record.history) {
    const { used, ...H } = c.record.history;
    historyActivityQuads(c, { iri: used, history: H }, 0).forEach((t) => dIns.push(`  ${v(t[0])} ${v(t[1])} ${t[2] === '?n_at' ? '?n_at' : v(t[2])} .`));
  }

  pre.push(`    BIND(true AS ?ok)`);
  where.push(`  OPTIONAL {`, ...pre, `  }`);
  where.push(...top);
  where.push(`  BIND(IF(BOUND(?ok), ${EX.APPLIED}, ${EX.PRECONDITION_FAILED}) AS ?n_outcome)`);
  where.push(nb(JSON.stringify(digest), 'digest'), nb(ref(c.actor), 'actor'), nb('NOW()', 'at'));
  if (plan.target) where.push(nb(ref(plan.target), 'target0'));
  where.push(...dBinds);

  bDel.unshift(`  ${MARKER_SUBJECT} ${EX.commitSeq} ?s .`);
  bIns.unshift(`  ${MARKER_SUBJECT} ${EX.commitSeq} ?s1 .`,
    `  ${OP} ${EX.outcome} ?n_outcome .`, `  ${OP} ${EX.digest} ?n_digest .`, `  ${OP} ${EX.actor} ?n_actor .`,
    `  ${OP} ${EX.at} ?n_at .`, `  ${OP} ${EX.commitSeq} ?s1 .`, ...(plan.target ? [`  ${OP} ${EX.target} ?n_target0 .`] : []));

  const sparql = assemble(del, bDel, dIns, bIns, where);
  const check = staticCheck(sparql, c.opId);
  if (!check.ok) fail(`compiler rejected its own output: ${check.errors.join('; ')}`);
  return { sparql, digest, canonical: c };
}

// ---------- #1598: card.write — one or more cards in ONE guarded update ----------
//
// The server projects each card with the replica's own projection (core/cards-graph.mjs) and sends the quads; the
// compiler VALIDATES that every quad belongs to the card it is written for, adds the version guard, and owns deletion.
//
//   GUARD (one conjunctive ?ok across all parts, review 05:56Z): each update part's `urn:ex:ver` equals its
//   expectedVersion; each create part's subject holds nothing yet; the shortId counter (when present) equals its
//   expected value. Any stale part means NOTHING lands.
//   DELETE (one top-level OPTIONAL, a UNION over the owned triples of every update part, so rows are the SUM of the
//   parts' triples, never their product): the card subject; derived Blocker/ReleaseCondition nodes reached by their
//   back-link and under `<card>/`; check nodes reached by hasCheck; inbound `dependsOn`; RDF-list cells hanging off the
//   card (blank nodes); and the part's PRIOR quads, which reach derived nodes with no back-link (DependencyRecord).
//   SHARED nodes (concepts, commits, unresolved references) are inserted idempotently and NEVER deleted by a card write.
//   INSERT: the new quads, `urn:ex:ver`, `entityJson` (the REST wire state) and recordedBy, all ok-guarded.
// A card write never touches a column node: a quad naming a column as SUBJECT is refused.

const CW = Object.freeze({
  scrum: 'https://scrumboard.local/ns#', schema: 'https://schema.org/', rdfType: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
  rdfRest: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#rest',
  check: 'https://scrumboard.local/check/', concept: 'https://scrumboard.local/concept/', commit: 'https://scrumboard.local/commit/',
  unresolved: 'https://scrumboard.local/unresolved/', counter: 'https://scrumboard.local/counter/nextShortId',
});
const CW_SHARED_PREFIXES = [CW.concept, CW.commit, CW.unresolved];
const CW_SHARED_PREDICATES = new Set([CW.rdfType, `${CW.schema}name`, `${CW.schema}identifier`]);
// #1638 — a caller never writes bookkeeping: every predicate the one definition lists is reserved to the compiler
const CW_RESERVED_PREDICATES = new Set([`${NS}ver`, `${NS}recordedBy`, `${CW.scrum}entityJson`, ...BOOKKEEPING_PREDICATES.map((p) => p.slice(1, -1))]);
const unref = (t) => (t.startsWith('<') ? t.slice(1, -1) : null);
/**
 * A card.write term: validated by canonTerm, then a plain or language-tagged literal is re-encoded with recLit, which
 * escapes everything outside a safe ASCII set (`;` included). Card text is free text: "…; delete the old one" written
 * as a raw literal makes staticCheck read a second operation (measured: 10 of 1,491 live cards in the #1598
 * rehearsal). Typed literals (integer, boolean, dateTime) have lexical forms that cannot carry one.
 */
function cardTerm(term, what) {
  // Projections also carry decimals and doubles (a model's cost); canonTerm's slice domain does not, so they are checked
  // here: a strict lexical form, never a value that could carry anything but a number.
  if (term && term.type === 'literal' && (term.datatype === `${XSD}decimal` || term.datatype === `${XSD}double`)) {
    const lex = typeof term.value === 'string' ? term.value.trim() : '';
    const okLex = term.datatype === `${XSD}decimal` ? /^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(lex) : /^([+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?|INF|-INF|NaN)$/.test(lex);
    if (!okLex) fail(`${what}: not an ${term.datatype.slice(XSD.length)}: ${JSON.stringify(term.value)}`);
    return `"${lex}"^^<${term.datatype}>`;
  }
  const t = canonTerm(term, what);
  if (term.type !== 'literal' || (term.datatype != null && term.datatype !== `${XSD}string`)) return t;
  return term.lang != null ? `${recLit(term.value)}@${term.lang.toLowerCase()}` : recLit(term.value);
}

/** Classify one canonical quad for the card `iri`: 'owned' | 'shared' | 'dependsOn'. Refuses anything else. */
function cardQuadClass([s, p, o], iri, id, what) {
  const S = unref(s), P = unref(p);
  if (S == null || P == null) fail(`${what}: subject and predicate must be IRIs`);
  if (CW_RESERVED_PREDICATES.has(P)) fail(`${what}: ${P} is written by the compiler, not the caller`);
  if (S === iri || S.startsWith(`${iri}/`) || S.startsWith(`${CW.check}${id}-`)) return 'owned';
  if (CW_SHARED_PREFIXES.some((x) => S.startsWith(x))) {
    if (!CW_SHARED_PREDICATES.has(P)) fail(`${what}: a shared node carries only type, name and identifier`);
    return 'shared';
  }
  if (S.startsWith(PERSON_IRI) && P === `${CW.scrum}dependsOn` && o === ref(iri)) return 'dependsOn';
  fail(`${what}: ${S} is not owned by ${iri}`);
}

// #1762 S1 — one part's event-time facts (contract on #1762 "S1 CONTRACT"). Values are closed: op from a fixed list, ids
// and columns as short safe strings, versions as integers or 'unknown'. Nothing free-text rides an activity.
const HISTORY_OPS = Object.freeze(['create', 'update', 'delete', 'move', 'claim', 'release', 'reproject']);   // reproject: references re-derived, the card itself unchanged
const SAFE_HISTORY_ID = /^[A-Za-z0-9._~-]{1,100}$/;
function canonCardHistory(h, w, isRemove) {
  obj(h, ['op', 'shortId', 'holder', 'columnBefore', 'columnAfter', 'versionAfter'], w);
  if (!HISTORY_OPS.includes(h.op)) fail(`${w}.op must be one of ${HISTORY_OPS.join(', ')}`);
  if ((h.op === 'delete') !== isRemove) fail(`${w}.op: a remove part is exactly a delete`);
  const idOrNull = (x, f) => (x == null ? null : (typeof x === 'string' && SAFE_HISTORY_ID.test(x) ? x : fail(`${w}.${f} must be a short safe id or null`)));
  const col = (x, f) => (x === 'unknown' ? 'unknown' : idOrNull(x, f));
  const shortId = h.shortId == null ? null : intLit(h.shortId, `${w}.shortId`);
  const versionAfter = h.versionAfter === 'unknown' ? 'unknown' : intLit(h.versionAfter, `${w}.versionAfter`);
  if (h.columnAfter == null) fail(`${w}.columnAfter is required (a column id or 'unknown')`);
  const out = { op: h.op, shortId, holder: idOrNull(h.holder, 'holder'), columnAfter: col(h.columnAfter, 'columnAfter'), versionAfter };
  if ('columnBefore' in h) out.columnBefore = h.columnBefore === null ? null : col(h.columnBefore, 'columnBefore');
  if ((h.op === 'create' || h.op === 'move') && !('columnBefore' in out)) fail(`${w}.columnBefore is required on a ${h.op}`);
  return out;
}

function canonEntityHistory(h, w, isRemove) {
  obj(h, ['op', 'entityKind', 'versionAfter'], w);
  if (!['create', 'update', 'delete'].includes(h.op)) fail(`${w}.op must be create, update or delete`);
  if ((h.op === 'delete') !== isRemove) fail(`${w}.op: a remove part is exactly a delete`);
  if (typeof h.entityKind !== 'string' || !SAFE_HISTORY_ID.test(h.entityKind)) fail(`${w}.entityKind must be a short safe kind`);
  return { op: h.op, entityKind: h.entityKind, versionAfter: h.versionAfter === 'unknown' ? 'unknown' : intLit(h.versionAfter, `${w}.versionAfter`) };
}

function canonCardWrite(i, { origin = i.origin != null } = {}) {
  if (!Array.isArray(i.parts) || (!i.parts.length && i.counter == null && !(Array.isArray(i.collections) && i.collections.length))) fail('card.write.parts is a non-empty array (or empty, with a counter or collections)');
  const parts = i.parts.map((x, k) => {
    const w = `parts[${k}]`;
    obj(x, ['iri', 'expectedVersion', 'version', 'quads', 'prior', 'json', 'remove', 'importDigest', 'history', ...(origin ? ['reason'] : [])], w);
    const history = x.history == null ? null : canonCardHistory(x.history, `${w}.history`, x.remove === true);
    // #1744 — a non-subject part of an origin plan says WHY it rides the write; bindOriginPlan checks it against the route
    if (x.reason != null && !ORIGIN_PART_REASONS.includes(x.reason)) fail(`${w}.reason must be one of ${ORIGIN_PART_REASONS.join(', ')}`);
    // A REMOVE part (a card deleted): guarded on its version, every owned triple deleted, nothing inserted.
    if (x.remove === true) {
      const iri = checkIri(x.iri, `${w}.iri`);
      if (!iri.startsWith(ENTITY_IRI) || !/^[A-Za-z0-9-]{1,64}$/.test(iri.slice(ENTITY_IRI.length))) fail(`${w}.iri must be ${ENTITY_IRI}<card id>`);
      const id = iri.slice(ENTITY_IRI.length);
      if (x.quads != null || x.json != null || x.version != null) fail(`${w}: a remove part carries no quads, json or version`);
      const expectedVersion = intLit(x.expectedVersion, `${w}.expectedVersion`);
      if (!Array.isArray(x.prior)) fail(`${w}.prior must be an array`);
      const prior = x.prior.map((q, n) => {
        if (!Array.isArray(q) || q.length !== 3) fail(`${w}.prior[${n}] is [s, p, o]`);
        const t = q.map((term, j) => cardTerm(term, `${w}.prior[${n}][${j}]`));
        if (cardQuadClass(t, iri, id, `${w}.prior[${n}]`) === 'shared') fail(`${w}.prior[${n}]: a shared node is never deleted by a card write`);
        return t;
      });
      return { iri, remove: true, expectedVersion, prior: [...new Map(prior.map((t) => [t.join(' '), t])).values()].sort((a, b) => (a.join(' ') < b.join(' ') ? -1 : 1)), ...(history ? { history } : {}) };
    }
    if (x.remove != null && x.remove !== false) fail(`${w}.remove must be true or absent`);
    const iri = checkIri(x.iri, `${w}.iri`);
    if (!iri.startsWith(ENTITY_IRI) || !/^[A-Za-z0-9-]{1,64}$/.test(iri.slice(ENTITY_IRI.length))) fail(`${w}.iri must be ${ENTITY_IRI}<card id>`);
    const id = iri.slice(ENTITY_IRI.length);
    const expectedVersion = x.expectedVersion == null ? null : intLit(x.expectedVersion, `${w}.expectedVersion`);
    const version = intLit(x.version, `${w}.version`);
    if (expectedVersion != null && BigInt(version) <= BigInt(expectedVersion)) fail(`${w}.version must be above expectedVersion`);
    const quadList = (list, label, allowShared) => {
      if (!Array.isArray(list)) fail(`${w}.${label} must be an array`);
      const out = list.map((q, n) => {
        if (!Array.isArray(q) || q.length !== 3) fail(`${w}.${label}[${n}] is [s, p, o]`);
        const t = q.map((term, j) => cardTerm(term, `${w}.${label}[${n}][${j}]`));
        const cls = cardQuadClass(t, iri, id, `${w}.${label}[${n}]`);
        if (cls === 'shared' && !allowShared) fail(`${w}.${label}[${n}]: a shared node is never deleted by a card write`);
        return t;
      });
      return [...new Map(out.map((t) => [t.join(' '), t])).values()].sort((a, b) => (a.join(' ') < b.join(' ') ? -1 : 1));
    };
    const quads = quadList(x.quads, 'quads', true);
    if (!quads.some(([s, p]) => s === ref(iri) && p === ref(CW.rdfType))) fail(`${w}.quads must type the card`);
    const prior = expectedVersion == null ? (x.prior == null || (Array.isArray(x.prior) && !x.prior.length) ? [] : fail(`${w}.prior: a create has no prior state`)) : quadList(x.prior ?? [], 'prior', false);
    // #1598 (review 06:27Z) — a migrated card records the sha-256 of the document card it came from, on its own node
    // `<card>/import` (no card write deletes it), so the file's copy can later be removed only when its lineage matches.
    let importDigest = null;
    if (x.importDigest != null) {
      if (expectedVersion != null) fail(`${w}.importDigest: only a create records where it came from`);
      if (typeof x.importDigest !== 'string' || !/^[0-9a-f]{64}$/.test(x.importDigest)) fail(`${w}.importDigest must be a sha-256 hex digest`);
      importDigest = x.importDigest;
    }
    return { iri, expectedVersion, version, quads, prior, json: rStr(x.json, `${w}.json`), ...(importDigest ? { importDigest } : {}), ...(x.reason != null ? { reason: x.reason } : {}), ...(history ? { history } : {}) };
  }).sort((a, b) => (a.iri < b.iri ? -1 : 1));
  if (new Set(parts.map((p) => p.iri)).size !== parts.length) fail('card.write: a card appears in two parts');
  // #1762 S1 — FAIL CLOSED: history is all or nothing. A write where some parts carry their activity facts and some do not
  // would commit a change with no record of it, so it is refused before it is compiled.
  if (parts.some((p) => p.history) && !parts.every((p) => p.history)) fail('card.write: history must be on every part or on none');
  // #1598 K4 — an announcement committed with a card change rides the SAME update as a PendingAnnouncement node under the
  // card (`<card>/announce/<mutationId>`, never deleted by a card write), so a crash after this update cannot leave a
  // claim whose announcement was never queued: the boot re-queues any the document does not know.
  const pending = (i.pending ?? []).map((x, k) => {
    const w = `pending[${k}]`;
    obj(x, ['card', 'mutationId', 'json'], w);
    const card = checkIri(x.card, `${w}.card`);
    if (!parts.some((p) => p.iri === card && !p.remove)) fail(`${w}.card must be a card this write creates or updates`);
    if (typeof x.mutationId !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(x.mutationId)) fail(`${w}.mutationId must be 1-64 characters of [A-Za-z0-9-]`);
    return { iri: `${card}/announce/${x.mutationId}`, json: rStr(x.json, `${w}.json`) };
  }).sort((a, b) => (a.iri < b.iri ? -1 : 1));
  let counter = null;
  if (i.counter != null) {
    const c = obj(i.counter, ['expected', 'next'], 'counter');
    counter = { expected: c.expected == null ? null : intLit(c.expected, 'counter.expected'), next: intLit(c.next, 'counter.next') };
    if (counter.expected != null && BigInt(counter.next) <= BigInt(counter.expected)) fail('counter.next must be above counter.expected');
  }
  // #1624 — collection entities written in the SAME update as the cards (e.g. an agent's retire releases its cards).
  const collections = i.collections == null ? [] : canonCollectionWrite({ kind: 'collection', parts: i.collections }).parts;
  if (!parts.length && !collections.length && i.counter == null) fail('card.write carries no part');
  { const all = [...parts, ...collections]; if (all.some((p) => p.history) && !all.every((p) => p.history)) fail('card.write: history must be on every part (cards and collections) or on none'); }   // #1762 S1
  // #1744 — `indexGuard: true` makes a write that adds or removes a shortId prove the reference index is complete and that it
  // re-projects EVERY card naming that shortId (contract v2 V2-2, F2). `indexGuard: 'marker'` (mode on, finding 5) is the same
  // proof, required only once the store holds the completion marker: before the backfill it admits the write, after it the
  // index can no longer be bypassed by leaving an environment variable unset. Absent = maintained but not enforced.
  if (i.indexGuard != null && i.indexGuard !== true && i.indexGuard !== 'marker') fail('indexGuard must be true, "marker" or absent');
  // #1744 — the entities a wiki-create plan READ (its parent and the apex chain), each pinned at the version it saw (F4)
  let reads = [];
  if (i.reads != null) {
    if (!origin) fail('reads ride an origin plan only');
    if (!Array.isArray(i.reads)) fail('reads must be an array');
    reads = i.reads.map((r, k) => {
      obj(r, ['iri', 'version'], `reads[${k}]`);
      const iri = checkIri(r.iri, `reads[${k}].iri`);
      if (!iri.startsWith(ENTITY_IRI)) fail(`reads[${k}].iri must be ${ENTITY_IRI}<card id>`);
      return { iri, version: intLit(r.version, `reads[${k}].version`) };
    }).sort((a, b) => (a.iri < b.iri ? -1 : 1));
    if (new Set(reads.map((r) => r.iri)).size !== reads.length) fail('reads: an entity appears twice');
  }
  // #1744 — a done-move's sibling walk names its anchor (absent: siblings at or after the new order; null: from the top;
  // an iri: after that card), so the compiler can prove the shifted set is the walk, exactly (contract v2 V2-3)
  let walk = null;
  if (i.walk != null) {
    if (!origin) fail('walk rides an origin plan only');
    obj(i.walk, ['anchor'], 'walk');
    walk = { anchor: i.walk.anchor === null ? null : i.walk.anchor === undefined ? undefined : checkIri(i.walk.anchor, 'walk.anchor') };
    if (walk.anchor !== null && walk.anchor !== undefined && !walk.anchor.startsWith(ENTITY_IRI)) fail('walk.anchor must be a card iri');
    if (walk.anchor === undefined) walk = {};
  }
  return { parts, counter, ...(pending.length ? { pending } : {}), ...(collections.length ? { collections } : {}), ...(i.indexGuard != null ? { indexGuard: i.indexGuard } : {}), ...(reads.length ? { reads } : {}), ...(walk ? { walk } : {}) };
}

/**
 * #1744 — the reference-index completeness guard, as WHERE clauses inside the write's one ?ok OPTIONAL (contract v2 V2-2, F2).
 * It binds ?ok only if: the completion marker is exactly true; and, for every shortId this write adds or removes, every
 * card whose coverage names it is a part of this write (so a new, changed or deleted referrer since prepare refuses).
 * #1769: it no longer re-proves the whole index's internal consistency (indexInvariantClauses) inside every write — that
 * proof is the verifier's; see the comment in the body.
 */
/** #1769 — the completion marker reads exactly `true` (an xsd:boolean) and nothing else: the part of the index's health a
 * WRITE depends on. O(1): two triple patterns on one subject. */
function indexMarkerClauses() {
  return [
    `    GRAPH ${BK} { ${ref(CRI.marker)} ${ref(CRI.complete)} "true"^^<http://www.w3.org/2001/XMLSchema#boolean> . }`,
    // and NOTHING else (#116 review, finding 2): a marker reading both true and false is not complete
    `    FILTER NOT EXISTS { GRAPH ${BK} { ${ref(CRI.marker)} ${ref(CRI.complete)} ?ixmo . } FILTER(!sameTerm(?ixmo, "true"^^<http://www.w3.org/2001/XMLSchema#boolean>)) }`,
  ];
}

function indexInvariantClauses() {
  const VER = ref(`${NS}ver`), JSONP = ref(`${CW.scrum}entityJson`), CARD = ref(`${CW.scrum}Card`), TYPE = ref(CW.rdfType);
  const IV = ref(CRI.indexedVersion), ID = ref(CRI.indexedJsonDigest), IN = ref(CRI.namesShortId), IC = ref(CRI.namesCount), IS = ref(CRI.namesSum), IL = ref(CRI.namesList);
  const INT = `<http://www.w3.org/2001/XMLSchema#integer>`;
  const covOf = (cardVar, out) => `BIND(IRI(CONCAT(${JSON.stringify(CRI.card(''))}, STRAFTER(STR(${cardVar}), ${JSON.stringify(ENTITY_IRI)}))) AS ${out})`;
  const out = [
    ...indexMarkerClauses(),
    `    FILTER NOT EXISTS { ?ixc ${TYPE} ${CARD} . GRAPH ${BK} { ?ixc ${VER} ?ixv ; ${JSONP} ?ixj . } ${covOf('?ixc', '?ixn')}`,
    `      FILTER NOT EXISTS { GRAPH ${BK} { ?ixn ${IV} ?ixv2 ; ${ID} ?ixd . } FILTER(?ixv2 = ?ixv && ?ixd = SHA256(STR(?ixj))) } }`,
    `    FILTER NOT EXISTS { GRAPH ${BK} { ?ixa ${IV} ?ixa1 , ?ixa2 . } FILTER(!sameTerm(?ixa1, ?ixa2)) }`,
    `    FILTER NOT EXISTS { GRAPH ${BK} { ?ixb ${ID} ?ixb1 , ?ixb2 . } FILTER(!sameTerm(?ixb1, ?ixb2)) }`,
    `    FILTER NOT EXISTS { GRAPH ${BK} { ?ixo ${IV} ?ixov . } BIND(IRI(CONCAT(${JSON.stringify(ENTITY_IRI)}, STRAFTER(STR(?ixo), ${JSON.stringify(CRI.card(''))}))) AS ?ixoc) FILTER NOT EXISTS { ?ixoc ${TYPE} ${CARD} } }`,
    `    FILTER NOT EXISTS { GRAPH ${BK} { ?ixt ${IN} ?ixtn . } FILTER(DATATYPE(?ixtn) != ${INT}) }`,
    `    FILTER NOT EXISTS { GRAPH ${BK} { ?ixm ${IV} ?ixmv . } FILTER NOT EXISTS { GRAPH ${BK} { ?ixm ${IC} ?ixmc ; ${IS} ?ixms . } } }`,
    `    FILTER NOT EXISTS { { SELECT ?ixg (COUNT(?ixgn) AS ?ixgk) (SUM(?ixgn) AS ?ixgs) WHERE { GRAPH ${BK} { ?ixg ${IV} ?ixgv . OPTIONAL { ?ixg ${IN} ?ixgn . } } } GROUP BY ?ixg }`,
    `      GRAPH ${BK} { ?ixg ${IC} ?ixgc ; ${IS} ?ixgt . } FILTER(?ixgk != ?ixgc || ?ixgs != ?ixgt) }`,
    // (the parentheses matter: the engine reads `a - b + 1` as `a - (b + 1)`, measured)
    // the EXACT name set (F2): one namesList per node; every name triple is IN it; its length is namesCount. With the name
    // triples distinct and counted above, that makes the triples and the list the same set
    `    FILTER NOT EXISTS { GRAPH ${BK} { ?ixh ${IV} ?ixhv . } FILTER NOT EXISTS { GRAPH ${BK} { ?ixh ${IL} ?ixhl . } } }`,
    `    FILTER NOT EXISTS { GRAPH ${BK} { ?ixe ${IL} ?ixe1 , ?ixe2 . } FILTER(!sameTerm(?ixe1, ?ixe2)) }`,
    `    FILTER NOT EXISTS { GRAPH ${BK} { ?ixl ${IN} ?ixln ; ${IL} ?ixll . } FILTER(!CONTAINS(CONCAT(",", STR(?ixll), ","), CONCAT(",", STR(?ixln), ","))) }`,
    `    FILTER NOT EXISTS { GRAPH ${BK} { ?ixq ${IL} ?ixql ; ${IC} ?ixqc . } BIND(IF(STR(?ixql) = "", 0, (STRLEN(STR(?ixql)) - STRLEN(REPLACE(STR(?ixql), ",", ""))) + 1) AS ?ixqk) FILTER(?ixqk != ?ixqc) }`,
  ];
  return out;
}

/** #1744 — the index's health alone, as a read: one row when the invariant holds, none when it does not (the server's diagnosis). */
/** #1744 — whether the completion marker exists at all, in any state: one row when it does (the marker-keyed guard's key). */
export const cardRefIndexMarkerSparql = () => `SELECT ?ixmk WHERE { GRAPH ${BK} { ${ref(CRI.marker)} ${ref(CRI.complete)} ?ixmk . } } LIMIT 1`;
/** #1769 — every value the completion marker holds (no LIMIT): complete is exactly one xsd:boolean `true`. */
export const cardRefIndexMarkerValuesSparql = () => `SELECT ?ixmk WHERE { GRAPH ${BK} { ${ref(CRI.marker)} ${ref(CRI.complete)} ?ixmk . } }`;
export const cardRefIndexHealthySparql = () => `SELECT ?ixok WHERE {\n${indexInvariantClauses().join('\n')}\n    BIND(true AS ?ixok)\n} LIMIT 1`;

function indexGuardClauses(R) {
  // only a write that ADDS or REMOVES a shortId depends on the index; a plain update maintains it but is not held by it
  if (!R.parts.some((P) => P.remove || P.expectedVersion == null)) return [];
  const IN = ref(CRI.namesShortId), INT = `<http://www.w3.org/2001/XMLSchema#integer>`;
  // #1769 — the MARKER only, never the whole-index invariant: that is a scan of every card (a SHA256 of each stored JSON,
  // the re-aggregation of every coverage node), measured at 31–34 s on the real board's 1,633 cards, inside every create
  // and delete. The whole-index proof is the JS verifier's (core/card-ref-index-verify.mjs), which is strictly stronger
  // and runs before every enforced start, at READY and on its schedule, latching the marker false on a violation — and a
  // false marker refuses here. What this guard alone cannot see between verifications is a coverage node made wrong by a
  // writer that bypassed the compiler; the #1748 write floor refuses such writers at the executor.
  const out = indexMarkerClauses();
  const covs = R.parts.map((P) => ref(CRI.card(P.iri.slice(ENTITY_IRI.length))));
  const notIn = covs.length ? ` FILTER(?ixr NOT IN (${covs.join(', ')}))` : '';
  R.parts.forEach((P, k) => {
    let S = null;
    if (P.remove) {   // the removed card's shortId, from its public identifier
      out.push(`    ${ref(P.iri)} ${ref('https://schema.org/identifier')} ?ixrm${k} .`);
      S = `xsd:integer(?ixrm${k})`.replace('xsd:integer', INT);
    } else if (P.expectedVersion == null) {
      // a create's shortId: a positive safe integer, and the SAME one its public identifier triple carries. Anything else
      // refuses (fail closed): a guard that silently added no namer clause would admit the create unproven
      const sid = JSON.parse(P.json).shortId;
      if (!Number.isSafeInteger(sid) || sid < 1) fail(`an index-guarded create needs an integer shortId (${P.iri})`);
      const idq = P.quads.filter((q) => q[0] === ref(P.iri) && q[1] === ref('https://schema.org/identifier'));
      if (idq.length !== 1 || !new RegExp(`^"${sid}"(\\^\\^.*)?$`).test(idq[0][2])) fail(`an index-guarded create's identifier triple is not its JSON shortId ${sid} (${P.iri})`);
      S = `"${sid}"^^${INT}`;
    }
    if (S) out.push(`    FILTER NOT EXISTS { GRAPH ${BK} { ?ixr ${IN} ?ixrs . } FILTER(?ixrs = ${S})${notIn} }`);
  });
  return out;
}

/**
 * The stored structure a card.write REPLACES for one existing card, as UNION branches binding (s p o): its own triples, its
 * blocker and release-condition children, its checks, the dependsOn back-links, and its list nodes. One definition, used by
 * the delete itself and by the reference-resolve proof (#1744), so what is proved is what is deleted.
 */
function cardStructureBranches(iri, k, [xs, xp, xo] = ['?xs', '?xp', '?xo'], x = 'x') {
  const I = ref(iri);
  const back = (pred, type) => `    { ${xs} ${ref(`${CW.scrum}${pred}`)} ${I} ; ${ref(CW.rdfType)} ${ref(`${CW.scrum}${type}`)} . FILTER(STRSTARTS(STR(${xs}), ${JSON.stringify(`${iri}/`)})) ${xs} ${xp} ${xo} }`;
  return [
    `    { ${I} ${xp} ${xo} BIND(${I} AS ${xs}) }`,
    back('blocks', 'Blocker'),
    back('ofCard', 'ReleaseCondition'),
    `    { ${I} ${ref(`${CW.scrum}hasCheck`)} ${xs} . ${xs} ${xp} ${xo} }`,
    `    { ${xs} ${ref(`${CW.scrum}dependsOn`)} ${I} BIND(${ref(`${CW.scrum}dependsOn`)} AS ${xp}) BIND(${I} AS ${xo}) }`,
    `    { ${I} ?${x}l${k} ?${x}h${k} FILTER(isBlank(?${x}h${k})) ?${x}h${k} ${ref(CW.rdfRest)}* ${xs} . ${xs} ${xp} ${xo} }`,
    // #1787 — the card's attachment nodes, ALL of their triples, whatever they hold: proven owned twice (linked to this card
    // by attachmentOf AND under its /attachment/ prefix, as the post path does). Without this a write deleted only the
    // triples its prior projection named, so a stale or extra attachment fact survived every rewrite (#138 review).
    `    { ${xs} ${ref(`${CW.scrum}attachmentOf`)} ${I} . FILTER(STRSTARTS(STR(${xs}), ${JSON.stringify(`${iri}/attachment/`)})) ${xs} ${xp} ${xo} }`,
  ];
}

/**
 * #1744 D6 — what resolving #N changes in ONE card's projection, from its JSON alone: `add` = the triples projecting it with
 * #N → the new card gives and projecting it with #N unresolved does not; `rem` = the reverse, minus the shared nodes (the
 * unresolved node itself, concepts, commits), which a card write never deletes. Other names resolve identically in both.
 */
const SHARED_SUBJECT_PREFIXES = ['https://scrumboard.local/unresolved/', 'https://scrumboard.local/concept/', 'https://scrumboard.local/commit/'];
// The card projector (cards-graph.mjs cardQuads) REGISTERS itself on load: importing it here would put the oxigraph package
// in server.js's static import graph, which must boot with no npm dependencies (#868). A reference-resolve part compiled
// with no projector loaded is refused, never admitted unproven.
let projectCard = null;
export function registerCardProjector(fn) { projectCard = fn; }
function resolutionDiff(card, N, newId) {
  if (!projectCard) fail('a reference-resolve part needs the card projector (cards-graph.mjs), which is not loaded');
  const proj = (map) => projectCard(card, map).map((q) => q.map((t, j) => cardTerm(t, `resolution[${j}]`)));
  const A = proj(new Map([[Number(N), newId]])), B = proj(new Map());
  const key = (q) => q.join(' ');
  const a = new Set(A.map(key)), b = new Set(B.map(key));
  const shared = (q) => SHARED_SUBJECT_PREFIXES.some((x) => q[0].startsWith(`<${x}`));
  return { add: A.filter((q) => !b.has(key(q))), rem: B.filter((q) => !a.has(key(q)) && !shared(q)) };
}

/**
 * #1744 — a wiki-create's `reference-resolve` parts (contract v1 D6, F4): each is an EXISTING card whose stored JSON is
 * byte-identical to the part's (no semantic edit rides this reason) and whose coverage names the new #N. Its triples are
 * tied to that JSON by an exact diff against the structure the write replaces (D6): every ADDED triple re-points a stored
 * (subject, predicate) edge from the unresolved #N to the new card, and every REMOVED triple, own or child, is such an edge
 * with its resolved twin added. Nothing else may change under this reason (F4).
 */
function referenceResolveClauses(R) {
  const JSONP = ref(`${CW.scrum}entityJson`), IN = ref(CRI.namesShortId), INT = `<http://www.w3.org/2001/XMLSchema#integer>`;
  const NEW = ref(`${ENTITY_IRI}${R.origin.provenance.cardId}`);
  const subject = R.parts.find((P) => P.iri === `${ENTITY_IRI}${R.origin.provenance.cardId}`);
  const N = JSON.parse(subject.json).shortId;
  const UNRES = ref(`https://scrumboard.local/unresolved/${N}`);
  const out = [];
  // the NEW page's own resolver facts (F4, V2-1), still true at commit: every card it points at exists, and every #M it
  // records as unresolved still has no card. A card deleted, or a #M created, between prepare and commit refuses the create.
  const own = subject.iri, UNRES_NS = 'https://scrumboard.local/unresolved/';
  const objs = [...new Set(subject.quads.map((q) => q[2]))];
  for (const [i, o] of objs.entries()) {
    const iri = o.startsWith('<') && o.endsWith('>') ? o.slice(1, -1) : null;
    if (!iri) continue;
    if (iri.startsWith(ENTITY_IRI) && iri !== own && !iri.startsWith(`${own}/`)) out.push(`    FILTER EXISTS { ${o} ${ref(CW.rdfType)} ?rft${i} }`);
    const m = iri.startsWith(UNRES_NS) ? /^(\d+)$/.exec(iri.slice(UNRES_NS.length)) : null;
    if (m) out.push(`    FILTER NOT EXISTS { ?rfu${i} ${ref(CW.rdfType)} ${ref(`${CW.scrum}Card`)} ; ${ref('https://schema.org/identifier')} ?rfi${i} . FILTER(STR(?rfi${i}) = "${m[1]}") }`);
  }
  const NONE = '(<urn:ex:none> <urn:ex:none> <urn:ex:none>)';
  const tuples = (xs) => xs.map((q) => `(${q.join(' ')})`).join(' ') || NONE;
  R.parts.forEach((P, k) => {
    if (P.reason !== 'reference-resolve') return;
    const I = ref(P.iri), COV = ref(CRI.card(P.iri.slice(ENTITY_IRI.length)));
    const values = P.quads.map((q) => `(${q.join(' ')})`).join(' ');
    const diff = resolutionDiff(JSON.parse(P.json), N, R.origin.provenance.cardId);
    // every triple the resolution must add is IN the part (none silently left unresolved)
    const have = new Set(P.quads.map((q) => q.join(' ')));
    for (const q of diff.add) if (!have.has(q.join(' '))) fail(`reference-resolve part ${P.iri} omits the resolved triple ${q.join(' ')}`);
    // and every triple the resolution REMOVES is gone from the part: a stale edge to the unresolved #N may not ride beside
    // its resolved twin (D6: the part IS the projection with #N resolved)
    for (const q of diff.rem) if (have.has(q.join(' '))) fail(`reference-resolve part ${P.iri} keeps the stale unresolved triple ${q.join(' ')}`);
    out.push(
      `    GRAPH ${BK} { ${I} ${JSONP} ?rrj${k} . } FILTER(STR(?rrj${k}) = ${recLit(P.json)})`,
      `    GRAPH ${BK} { ${COV} ${IN} "${N}"^^${INT} . }`,
      // D6 — the part's triples are the projection of its UNCHANGED JSON with #N resolved: the only triples it may add are
      // those that projecting the JSON with #N → the new card gives and projecting it with #N unresolved does not (A − B),
      // and the only stored triples it may drop are the reverse (B − A). Both sets come from the JSON, never from the caller.
      `    FILTER NOT EXISTS { VALUES (?rqs${k} ?rqp${k} ?rqo${k}) { ${values} } FILTER NOT EXISTS { ?rqs${k} ?rqp${k} ?rqo${k} } FILTER NOT EXISTS { VALUES (?ras${k} ?rap${k} ?rao${k}) { ${tuples(diff.add)} } FILTER(sameTerm(?ras${k}, ?rqs${k}) && sameTerm(?rap${k}, ?rqp${k}) && sameTerm(?rao${k}, ?rqo${k})) } }`,
      `    FILTER NOT EXISTS { { ${cardStructureBranches(P.iri, k, [`?res${k}`, `?rep${k}`, `?reo${k}`], 're').join(' UNION ')} } FILTER NOT EXISTS { VALUES (?rvs${k} ?rvp${k} ?rvo${k}) { ${values} } FILTER(sameTerm(?rvs${k}, ?res${k}) && sameTerm(?rvp${k}, ?rep${k}) && sameTerm(?rvo${k}, ?reo${k})) } FILTER NOT EXISTS { VALUES (?rds${k} ?rdp${k} ?rdo${k}) { ${tuples(diff.rem)} } FILTER(sameTerm(?rds${k}, ?res${k}) && sameTerm(?rdp${k}, ?rep${k}) && sameTerm(?rdo${k}, ?reo${k})) } }`,
    );
  });
  return out;
}

/** #1744 — the stored-state half of a done-move's proof (V2-3): see bindDoneMovePlan for the half checked from the parts. */
function doneMoveClauses(R) {
  const JSONP = ref(`${CW.scrum}entityJson`), COLP = ref('https://scrumboard.local/ns#column'), IDP = ref('https://schema.org/identifier');
  const CARD = ref(`${CW.scrum}Card`), TYPE = ref(CW.rdfType), INT = `<http://www.w3.org/2001/XMLSchema#integer>`;
  const subject = R.parts.find((P) => P.reason == null);
  if (!subject) fail('a done-move plan holds a subject part with no reason');
  const sj = JSON.parse(subject.json);
  const at = Number(sj.order);
  const COL = ref(`https://scrumboard.local/column/${encodeURIComponent(sj.column)}`);   // core/jsonld.mjs columnIri
  const sibs = R.parts.filter((P) => P.reason === 'sibling-order');
  const out = [];
  const anchor = R.walk?.anchor;
  if (anchor) out.push(`    ${ref(anchor)} ${ORDER_P} ?wao ; ${IDP} ?was .`);
  sibs.forEach((P, k) => {
    const I = ref(P.iri);
    const j = JSON.parse(P.json);
    const old = priorOrderOf(P);
    // a listed sibling is IN the walk: after the anchor by (order, shortId), when there is one (V2-3: no surplus part)
    if (anchor) out.push(`    FILTER(${old} > ?wao || (${old} = ?wao && ${j.shortId} > ${INT}(?was)))`);
    // the stored JSON is the new JSON with ONLY order and version reverted. bumpCardVersion maps an integer v ≥ 0 to v + 1 and
    // anything else to 1, so a new version of 1 may come from 0, null, or no version key at all (it was appended last): an
    // exact comparison against that closed set, never a looser one
    const candidates = [JSON.stringify({ ...j, order: old, version: j.version - 1 })];
    if (j.version === 1) {
      candidates.push(JSON.stringify({ ...j, order: old, version: null }));
      const { version: _v, ...rest } = j; candidates.push(JSON.stringify({ ...rest, order: old }));
    }
    out.push(`    GRAPH ${BK} { ${I} ${JSONP} ?wsj${k} . } FILTER(STR(?wsj${k}) IN (${[...new Set(candidates)].map(recLit).join(', ')}))`);
    // only its order triple changes
    out.push(`    FILTER NOT EXISTS { VALUES (?wqs${k} ?wqp${k} ?wqo${k}) { ${P.quads.map((q) => `(${q.join(' ')})`).join(' ')} } FILTER NOT EXISTS { ?wqs${k} ?wqp${k} ?wqo${k} } FILTER(!(sameTerm(?wqs${k}, ${I}) && sameTerm(?wqp${k}, ${ORDER_P}) && sameTerm(?wqo${k}, "${j.order}"^^${INT}))) }`);
    // nothing else is dropped: every stored triple of the card's WHOLE replaced structure (own, children such as blockers and
    // checks, back-links, list nodes) the part does not keep is its old order triple (V2-3: no other quad delta)
    out.push(`    FILTER NOT EXISTS { { ${cardStructureBranches(P.iri, k, [`?wes${k}`, `?wep${k}`, `?weo${k}`], 'we').join(' UNION ')} } FILTER NOT EXISTS { VALUES (?wvs${k} ?wvp${k} ?wvo${k}) { ${P.quads.map((q) => `(${q.join(' ')})`).join(' ')} } FILTER(sameTerm(?wvs${k}, ?wes${k}) && sameTerm(?wvp${k}, ?wep${k}) && sameTerm(?wvo${k}, ?weo${k})) } FILTER(!(sameTerm(?wes${k}, ${I}) && sameTerm(?wep${k}, ${ORDER_P}) && sameTerm(?weo${k}, "${old}"^^${INT}))) }`);
  });
  // no card outside the plan sits where the walk would reach: order in [lower, at + m], lower by the anchor
  const top = at + sibs.length;
  const listed = R.parts.map((P) => ref(P.iri)).join(', ');
  let range;
  if (anchor === null) range = `FILTER(?wyo <= ${top})`;
  else if (anchor) {
    range = `FILTER(?wyo <= ${top} && (?wyo > ?wao || (?wyo = ?wao && ${INT}(?wys) > ${INT}(?was))))`;
  } else range = `FILTER(?wyo >= ${at} && ?wyo <= ${top})`;
  out.push(`    FILTER NOT EXISTS { ?wy ${TYPE} ${CARD} ; ${COLP} ${COL} ; ${ORDER_P} ?wyo ; ${IDP} ?wys . FILTER(?wy NOT IN (${listed})) ${range} }`);
  return out;
}

// #1762 S1 — the activity node of part k of a card.write, as triples (contract on #1762 "S1 CONTRACT"). They ride the
// write's own data INSERT, whose template binds only when the write's preconditions hold (?ok): APPLIED commits the change
// and its activity together, and a refused write inserts neither. `?n_at` is the receipt's own NOW().
const SCRUM_NS = 'https://scrumboard.local/ns#', PROV_NS = 'http://www.w3.org/ns/prov#', ACTIVITY_NS = 'https://scrumboard.local/activity/';
const PERSON_NS = 'https://scrumboard.local/person/';
export const changeActivityIri = (opId, k) => `${ACTIVITY_NS}op-${createHash('sha256').update(opId).digest('hex').slice(0, 32)}-${k}`;
// #1762 S1b — the activity names a PERSON: the log-born kinds' actor is the slice's authenticated seat IRI (urn:ex:seat/<key>),
// the same seat as person/<key>; every other actor already is a person IRI.
const activityAgent = (actor) => (actor.startsWith('urn:ex:seat/') ? `${PERSON_NS}${actor.slice('urn:ex:seat/'.length)}` : actor);
function historyActivityQuads(c, P, k) {
  const H = P.history, A = ref(changeActivityIri(c.opId, k)), S = (n) => ref(SCRUM_NS + n), PR = (n) => ref(PROV_NS + n);
  const term = (x) => (x === 'unknown' ? S('unknown') : x === null ? S('none') : null);
  const out = [
    [A, ref(CW.rdfType), PR('Activity')], [A, ref(CW.rdfType), S('ChangeActivity')],
    [A, S('op'), recLit(H.op)], [A, S('entityKind'), recLit(H.entityKind ?? 'card')], [A, PR('used'), ref(P.iri)],
    [A, PR('wasAssociatedWith'), ref(activityAgent(c.actor))], [A, PR('startedAtTime'), '?n_at'],
    [A, S('part'), String(k)], [A, S('recordedBy'), ref(c.opId)],
    [A, S('versionAfter'), H.versionAfter === 'unknown' ? S('unknown') : H.versionAfter],
  ];
  if (H.entityKind != null) return out;   // a collection entity: no card-only facts
  out.push([A, S('holderAtWrite'), H.holder == null ? S('none') : ref(PERSON_NS + encodeURIComponent(H.holder))],
    [A, S('columnAfter'), term(H.columnAfter) ?? recLit(H.columnAfter)]);
  if (H.shortId != null) out.push([A, S('shortId'), recLit(String(H.shortId))]);
  if ('columnBefore' in H) out.push([A, S('columnBefore'), term(H.columnBefore) ?? recLit(H.columnBefore)]);
  return out;
}

function compileCardWrite(c) {
  const digest = recordDigest(c);
  const OP = ref(c.opId);
  const R = c.record;
  const VER = ref(`${NS}ver`), REC = ref(`${NS}recordedBy`), JSONP = ref(`${CW.scrum}entityJson`), CTR = ref(CW.counter);
  const where = [], pre = [], top = [], dBinds = [], del = [], dIns = [], bDel = [], bIns = [];
  const names = new Map();
  const v = (text) => {
    let n = names.get(text);
    if (!n) { n = `r${names.size}`; names.set(text, n); dBinds.push(ok(text, n)); }
    return `?d_${n}`;
  };
  where.push(...dupGuard(OP));

  const branches = [];
  R.parts.forEach((P, k) => {
    const I = ref(P.iri);
    // #1744 — the card's reference-index coverage node is maintained by the COMPILER in this same update, for every part: the
    // old node is deleted (a create clears any orphan; a remove leaves none) and, unless the card is removed, the new one is
    // derived from the part's own version and stored JSON. Callers never send it (cardQuadClass refuses its predicates).
    const COV = ref(CRI.card(P.iri.slice(ENTITY_IRI.length)));
    branches.push(bkBranch(COV));
    if (!P.remove) {
      const nms = cardNames(JSON.parse(P.json));
      bIns.push(`  ${v(COV)} ${ref(CRI.indexedVersion)} ${v(P.version)} .`, `  ${v(COV)} ${ref(CRI.indexedJsonDigest)} ${v(recLit(jsonDigest(P.json)))} .`,
        `  ${v(COV)} ${ref(CRI.namesCount)} ${v(intLit(String(nms.length), 'namesCount'))} .`, `  ${v(COV)} ${ref(CRI.namesSum)} ${v(intLit(String(nms.reduce((a, b) => a + b, 0)), 'namesSum'))} .`,
        `  ${v(COV)} ${ref(CRI.namesList)} ${v(recLit(namesListOf(nms)))} .`);
      for (const n of nms) bIns.push(`  ${v(COV)} ${ref(CRI.namesShortId)} ${v(intLit(String(n), 'namesShortId'))} .`);
    }
    if (P.expectedVersion == null) pre.push(...freshSubject(I));
    else {
      pre.push(`    GRAPH ${BK} { ${I} ${VER} ?xv${k} . }`, `    FILTER(?xv${k} = ${P.expectedVersion})`);   // #1638 — the version stamp is bookkeeping
      // #1638 — the card's bookkeeping (ver, recordedBy, entityJson) goes with it: read inside the bk graph, deleted there.
      // #1666 — as one more UNION branch, so its rows ADD; a top-level OPTIONAL per card multiplied them (3^N × the rest).
      branches.push(bkBranch(I));
      branches.push(...cardStructureBranches(P.iri, k));
      if (P.prior.length) branches.push(`    { VALUES (?xs ?xp ?xo) {\n${P.prior.map((q) => `      (${q.join(' ')})`).join('\n')}\n    } }`);
    }
    if (P.history) historyActivityQuads(c, P, k).forEach((t) => dIns.push(`  ${v(t[0])} ${v(t[1])} ${t[2] === '?n_at' ? '?n_at' : v(t[2])} .`));   // #1762 S1
    if (P.remove) return;
    if (P.importDigest) {
      const IMP = ref(`${P.iri}/import`);
      dIns.push(`  ${v(IMP)} ${ref(CW.rdfType)} ${v(ref(`${CW.scrum}CardImport`))} .`, `  ${v(IMP)} ${ref(`${CW.scrum}sourceDigest`)} ${v(recLit(P.importDigest))} .`);
    }
    for (const [s, p, o] of P.quads) dIns.push(`  ${v(s)} ${v(p)} ${v(o)} .`);
    bIns.push(`  ${v(I)} ${VER} ${v(P.version)} .`, `  ${v(I)} ${REC} ${v(OP)} .`, `  ${v(I)} ${JSONP} ${v(recLit(P.json))} .`);
  });
  collectionClauses(R.collections || [], { OP, v, pre, top, branches, dIns, bIns, bDel, dBinds, tag: 'c', history: { c, offset: R.parts.length } });
  for (const A of R.pending || []) {
    pre.push(...freshSubject(ref(A.iri)));
    dIns.push(`  ${v(ref(A.iri))} ${ref(CW.rdfType)} ${v(ref(`${CW.scrum}PendingAnnouncement`))} .`);
    bIns.push(`  ${v(ref(A.iri))} ${JSONP} ${v(recLit(A.json))} .`);   // #1638 — the announcement's entityJson copy is bookkeeping
  }
  if (R.counter) {
    if (R.counter.expected == null) pre.push(`    FILTER NOT EXISTS { GRAPH ${BK} { ${CTR} ${VER} ?xcf } }`);
    else {
      pre.push(`    GRAPH ${BK} { ${CTR} ${VER} ?xc . }`, `    FILTER(?xc = ${R.counter.expected})`);
      dBinds.push(ok('?xc', 'xcOld'));
      bDel.push(`  ${v(CTR)} ${VER} ?d_xcOld .`);
    }
    bIns.push(`  ${v(CTR)} ${VER} ${v(R.counter.next)} .`);
  }
  // #1744 — a wiki-create commit is ALWAYS index-guarded (its parts must be exactly the cards naming the new #N), pins every
  // entity its plan read (the parent and apex chain, F4), and proves each reference-resolve part changes nothing but the
  // edge into the new card
  const wikiCreate = R.origin?.route === WIKI_CREATE_ROUTE;
  if (R.indexGuard === 'marker' && !wikiCreate) {
    // either no completion marker exists at all (the index is not yet backfilled), or the full proof holds; a marker in any
    // other state than complete true keys the proof too, and the proof then refuses
    const g = indexGuardClauses(R);
    if (g.length) pre.push(`    { FILTER NOT EXISTS { GRAPH ${BK} { ${ref(CRI.marker)} ${ref(CRI.complete)} ?ixmk . } } }`, `    UNION`, `    {`, ...g, `    }`);
  } else if (R.indexGuard || wikiCreate) pre.push(...indexGuardClauses(R));
  (R.reads || []).forEach((r, k) => pre.push(`    GRAPH ${BK} { ${ref(r.iri)} ${VER} ?xrd${k} . }`, `    FILTER(?xrd${k} = ${r.version})`));
  if (wikiCreate) pre.push(...referenceResolveClauses(R));
  if (R.origin?.route === 'done-nudge' && R.parts.some((P) => P.reason === 'sibling-order')) pre.push(...doneMoveClauses(R));   // #1744
  if (R.origin) originCommitClauses(c, digest, { OP, v, pre, dBinds, bDel, bIns });   // #1629 s2 — absent, nothing here runs
  pre.push(`    BIND(true AS ?ok)`);
  where.push(`  OPTIONAL {`, ...pre, `  }`);
  where.push(...top);
  if (branches.length) {
    where.push(`  OPTIONAL {`, branches.join('\n    UNION\n'), `  }`);
    dBinds.push(ok('?xs', 'xs'), ok('?xp', 'xp'), ok('?xo', 'xo'));
    del.push(`  ?d_xs ?d_xp ?d_xo .`);
    if (branches.some(isBkBranch)) {   // #1666 — a bk row leaves ?xs unbound and a data row leaves ?xbs unbound: each template skips the other's
      dBinds.push(ok('?xbs', 'xbs'), ok('?xbp', 'xbp'), ok('?xbo', 'xbo'));
      bDel.push(`  ?d_xbs ?d_xbp ?d_xbo .`);
    }
  }
  where.push(`  BIND(IF(BOUND(?ok), ${EX.APPLIED}, ${EX.PRECONDITION_FAILED}) AS ?n_outcome)`);
  where.push(nb(JSON.stringify(digest), 'digest'), nb(ref(c.actor), 'actor'), nb('NOW()', 'at'), nb(ref(R.parts.length ? R.parts[0].iri : (R.collections?.length ? R.collections[0].iri : CW.counter)), 'target0'));
  where.push(...dBinds);
  bDel.unshift(`  ${MARKER_SUBJECT} ${EX.commitSeq} ?s .`);
  bIns.unshift(`  ${MARKER_SUBJECT} ${EX.commitSeq} ?s1 .`,
    `  ${OP} ${EX.outcome} ?n_outcome .`, `  ${OP} ${EX.digest} ?n_digest .`, `  ${OP} ${EX.actor} ?n_actor .`,
    `  ${OP} ${EX.at} ?n_at .`, `  ${OP} ${EX.commitSeq} ?s1 .`, `  ${OP} ${EX.target} ?n_target0 .`);
  const sparql = assemble(del, bDel, dIns, bIns, where);
  const check = staticCheck(sparql, c.opId);
  if (!check.ok) fail(`compiler rejected its own output: ${check.errors.join('; ')}`);
  return { sparql, digest, canonical: c };
}

// ---------- #1629 slice 2: origin.prepare, and the origin-bearing card.write commit ----------
//
// r3 on #1629 (frozen with the rows, card v117). One origin = one business change that owes N announcements:
//   origin.prepare   writes ONE Prepared node: the canonical descriptor and plan, their digests, the identity, and
//                    occurredAt = the executor's NOW(). Nothing else: no allocator, no business quad, no Origin.
//   card.write+origin the commit: the plan's business change, the Origin, N Obligations, N slice-1 reservations, the
//                    allocator advance and `prepared committedBy <op>`, all under the ONE ?ok guard, which also holds the
//                    COMPLETE prepared match (§4 guard 3: byte-equal stored JSON, every field singular, no committedBy).
// The receipt is card.write's, unchanged; its digest binds the origin. Every digest is derived here, never sent.

/** r3 §1: the permanent mutation namespace. Generated once (Python uuid4, 2026-10-20T03:46:33Z); never regenerated. */
export const ORIGIN_NAMESPACE = 'cd807138-eefc-40d2-9a80-525e666e6269';
export const ORIGIN_PART_REASONS = Object.freeze(['reference-resolve', 'sibling-order']);   // #1744 (v1 D6)
/** #1744 — the page create: a NEW card, its counter advance and its reference re-projections, as one origin (slot `wiki`). */
export const WIKI_CREATE_ROUTE = 'wiki-create';
export const ORIGIN_CARD_ROUTES = Object.freeze(['claim', 'release', 'done-nudge', 'wiki']);
export const ORIGIN_AGENT_ROUTES = Object.freeze(['agent-rest', 'agent-retire']);
export const ORIGIN_ROUTES = Object.freeze([...ORIGIN_CARD_ROUTES, ...ORIGIN_AGENT_ROUTES, WIKI_CREATE_ROUTE]);   // #1744
const ORIGIN_SLOT_RE = /^[a-z][a-z0-9-]{0,31}$/;
/** The agent entity IRI for a seat: the rule #1624's agent route uses (server.js:5003 at 429e487). */
export const originAgentIri = (seat) => `https://scrumboard.local/agent/${encodeURIComponent(seat)}`;
const nonEmpty = (v) => typeof v === 'string' && v !== '' && v.isWellFormed();

/** r3 §1: the closed 5-tuple key, a JSON array (never a slash join). Throws ValidationError on any bad field. */
export function originKeyOf(route, subject, requestKey, originActor) {
  if (!ORIGIN_ROUTES.includes(route)) fail(`origin route must be one of ${ORIGIN_ROUTES.join(', ')}`);
  for (const [k, x] of [['subject', subject], ['requestKey', requestKey], ['originActor', originActor]]) {
    if (!nonEmpty(x)) fail(`origin ${k} must be a non-empty well-formed string`);
  }
  return JSON.stringify(['origin-v1', route, subject, requestKey, originActor]);
}
/** UUIDv5 of the origin key under ORIGIN_NAMESPACE (RFC 4122, sha-1). */
export function mutationIdOf(originKey) {
  if (!nonEmpty(originKey)) fail('originKey must be a non-empty well-formed string');
  const ns = Buffer.from(ORIGIN_NAMESPACE.replace(/-/g, ''), 'hex');
  const h = createHash('sha1').update(ns).update(Buffer.from(originKey, 'utf8')).digest();
  const b = Buffer.from(h.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  const x = b.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}
export const originPrepareOp = (mutationId) => `${ORIGIN_TERMS.PREPARE_OP_PREFIX}${mutationId}`;
export const originCommitOp = (mutationId) => `${ORIGIN_TERMS.COMMIT_OP_PREFIX}${mutationId}`;
export const originDescriptorDigest = (desc) => createHash('sha256').update(`originDescriptorV 1\n${JSON.stringify(desc)}`).digest('hex');
export const originPlanDigest = (plan) => createHash('sha256').update(`originPlanV 1\n${JSON.stringify(plan)}`).digest('hex');

/**
 * r3 §3: the closed descriptor, canonicalized (fixed key order, mentions sorted). `commit` admits the one commit-only
 * member, occurredAt (Q4 option (a)), and returns it beside the descriptor it is projected out of.
 */
export function canonOriginDescriptor(d, { commit = false } = {}) {
  obj(d, ['route', 'subject', 'requestKey', 'originActor', 'mutationId', 'provenance', 'slots', ...(commit ? ['occurredAt'] : [])], 'origin');
  const key = originKeyOf(d.route, d.subject, d.requestKey, d.originActor);
  const mutationId = mutationIdOf(key);
  if (d.mutationId !== mutationId) fail(`origin.mutationId ${JSON.stringify(d.mutationId)} is not the recomputed ${mutationId}`);
  let provenance;
  if (d.route === WIKI_CREATE_ROUTE) {
    // #1744 D2/V2-1 — the subject is the route's slot, the card id is DERIVED from the mutation (so a retry can't mint a
    // second card), the version is 1, and the frozen request digest is bound into the descriptor (and so its digest)
    if (d.subject !== 'wiki') fail('a wiki-create origin has subject "wiki"');
    const p = obj(d.provenance, ['cardId', 'version', 'requestDigest'], 'origin.provenance');
    if (p.cardId !== mutationIdOf(`${mutationId}:card`)) fail(`origin.provenance.cardId must be the derived ${mutationIdOf(`${mutationId}:card`)}`);
    if (p.version !== 1) fail('a wiki-create origin creates its card at version 1');
    if (typeof p.requestDigest !== 'string' || !/^[0-9a-f]{64}$/.test(p.requestDigest)) fail('origin.provenance.requestDigest must be a sha-256 hex digest');
    provenance = { cardId: p.cardId, version: 1, requestDigest: p.requestDigest };
  } else if (ORIGIN_CARD_ROUTES.includes(d.route)) {
    const p = obj(d.provenance, ['cardId', 'version'], 'origin.provenance');
    if (p.cardId !== d.subject) fail('origin.provenance.cardId must equal origin.subject');
    if (!Number.isSafeInteger(p.version) || p.version < 1) fail('origin.provenance.version must be a positive safe integer');
    provenance = { cardId: p.cardId, version: p.version };
  } else {
    const p = obj(d.provenance, ['agent', 'releasedCards'], 'origin.provenance');
    if (p.agent !== d.subject) fail('origin.provenance.agent must equal origin.subject');
    if (!Array.isArray(p.releasedCards) || !p.releasedCards.length) fail('origin.provenance.releasedCards is a non-empty array (zero released means no prepare)');
    if (p.releasedCards.some((x) => !nonEmpty(x))) fail('origin.provenance.releasedCards holds non-empty card ids');
    if (new Set(p.releasedCards).size !== p.releasedCards.length) fail('origin.provenance.releasedCards: a card appears twice');
    provenance = { agent: p.agent, releasedCards: [...p.releasedCards] };
  }
  if (!Array.isArray(d.slots) || !d.slots.length) fail('origin.slots is a non-empty array');
  const slots = d.slots.map((s, k) => {
    const w = `origin.slots[${k}]`;
    obj(s, ['slot', 'author', 'body', 'mentions', 'notify'], w);
    if (typeof s.slot !== 'string' || !ORIGIN_SLOT_RE.test(s.slot)) fail(`${w}.slot must match ${ORIGIN_SLOT_RE}`);
    if (!nonEmpty(s.author)) fail(`${w}.author is required`);
    if (!nonEmpty(s.body)) fail(`${w}.body is required`);
    if (!Array.isArray(s.mentions) || s.mentions.some((m) => typeof m !== 'string' || !m.isWellFormed())) fail(`${w}.mentions must be an array of strings`);
    if (typeof s.notify !== 'boolean') fail(`${w}.notify must be a boolean`);
    return { slot: s.slot, author: s.author, body: s.body, mentions: [...s.mentions].sort(), notify: s.notify };
  });
  if (new Set(slots.map((s) => s.slot)).size !== slots.length) fail('origin.slots: a slot appears twice');
  const descriptor = { route: d.route, subject: d.subject, requestKey: d.requestKey, originActor: d.originActor, mutationId, provenance, slots };
  if (!commit) return { descriptor, key };
  if (!nonEmpty(d.occurredAt) || !/^-?\d{4,}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(d.occurredAt)) fail('origin.occurredAt must be an xsd:dateTime lexical form, copied from readPreparedOrigin');
  return { descriptor, key, occurredAt: d.occurredAt };
}

/** The common fields of an origin intention (r3 §3 correction 3): people and evidence absent or empty, the actor frozen. */
function originCommon(descriptor, { actor, evidence, people }, opId, wantOp) {
  if (people.length) fail('an origin intention carries no people (Person effects would bypass planDigest)');
  if (evidence.length) fail('an origin intention carries no evidence');
  if (actor !== `${PERSON_IRI}${descriptor.originActor}`) fail(`actor must be ${PERSON_IRI}${descriptor.originActor}, the person of origin.originActor`);
  if (opId !== wantOp) fail(`opId must be ${wantOp}`);
}

/**
 * r3 §3 route-shape binding, STRUCTURAL: the descriptor's identity and provenance tie to the plan's parts. Plus g3, the
 * canonical-plan refusal: on an agent route, no released card's NEW quads may keep a claimedBy edge, to anyone.
 */
function bindOriginPlan(descriptor, plan) {
  if (plan.pending) fail('an origin plan carries no K4 pending announcement');
  if (descriptor.route === WIKI_CREATE_ROUTE) return bindWikiCreatePlan(descriptor, plan);
  if (plan.reads?.length) fail('only a wiki-create origin plan carries reads');
  if (plan.parts.some((p) => p.reason != null && p.reason !== 'sibling-order')) fail('a reference-resolve part rides a wiki-create origin only');
  if (descriptor.route === 'done-nudge' && plan.parts.length > 1) return bindDoneMovePlan(descriptor, plan);   // #1744
  if (plan.walk) fail('only a done-move origin plan carries a walk');
  if (plan.counter != null) fail('an origin plan carries no counter');
  const live = (p, w) => {
    if (p.remove) fail(`${w}: an origin plan removes nothing`);
    if (p.expectedVersion == null) fail(`${w}: an origin plan updates an existing entity (an expectedVersion), never creates one`);
  };
  if (ORIGIN_CARD_ROUTES.includes(descriptor.route)) {
    if (plan.parts.length !== 1) fail('a card-route origin plan holds exactly one card part');
    if (plan.collections?.length) fail('a card-route origin plan holds no collections');
    const [P] = plan.parts;
    live(P, 'parts[0]');
    if (P.iri !== `${ENTITY_IRI}${descriptor.subject}`) fail(`the card part must be ${ENTITY_IRI}${descriptor.subject}`);
    if (Number(P.version) !== descriptor.provenance.version) fail('origin.provenance.version must equal the card part\'s new version');
    return;
  }
  const C = plan.collections ?? [];
  if (C.length !== 1 || C[0].collection !== 'agents' || C[0].iri !== originAgentIri(descriptor.subject)) fail(`an agent-route origin plan holds exactly one collection part: the agents entity ${originAgentIri(descriptor.subject)}`);
  live(C[0], 'collections[0]');
  const want = descriptor.provenance.releasedCards.map((id) => `${ENTITY_IRI}${id}`);
  if (plan.parts.length !== want.length || plan.parts.some((p, k) => p.iri !== want[k])) fail('the card parts must be exactly origin.provenance.releasedCards, in that order');
  const claimed = ref(`${CW.scrum}claimedBy`);
  plan.parts.forEach((p, k) => {
    live(p, `parts[${k}]`);
    if (p.quads.some(([s, pr]) => s === ref(p.iri) && pr === claimed)) fail(`g3: released card ${p.iri} keeps a claimedBy edge`);
  });
}

/**
 * #1744 — a wiki-create plan (contract v1 D4–D6, v2 V2-1): exactly ONE create part, the derived card at version 1, whose JSON
 * names that id and the frozen shortId N; the counter advances exactly N → N+1; every other part is an EXISTING card riding as
 * `reference-resolve` (its JSON unchanged and its only edge changes into the new card: checked by the compiler against the
 * stored state, at commit); nothing is removed; no collections. The index guard is forced for this route at commit.
 */
function bindWikiCreatePlan(descriptor, plan) {
  if (plan.collections?.length) fail('a wiki-create plan holds no collections');
  const subject = `${ENTITY_IRI}${descriptor.provenance.cardId}`;
  const S = plan.parts.filter((p) => p.iri === subject);
  if (S.length !== 1) fail(`a wiki-create plan holds exactly one part for the derived card ${subject}`);
  const [P] = S;
  if (P.remove || P.expectedVersion != null || P.version !== '1') fail('the wiki-create subject part is a create at version 1');
  if (P.reason != null) fail('the wiki-create subject part carries no reason');
  let card;
  try { card = JSON.parse(P.json); } catch { fail('the wiki-create subject part carries card JSON'); }
  if (card.id !== descriptor.provenance.cardId || card.version !== 1 || !Number.isSafeInteger(card.shortId) || card.shortId < 1) fail('the wiki-create card JSON must carry the derived id, version 1 and a shortId');
  const N = String(card.shortId);
  if (!plan.counter || plan.counter.expected !== N || plan.counter.next !== String(card.shortId + 1)) fail(`a wiki-create plan advances the counter exactly ${N} → ${card.shortId + 1}`);
  for (const [k, p] of plan.parts.entries()) {
    if (p.iri === subject) continue;
    if (p.remove || p.expectedVersion == null) fail(`parts[${k}]: a wiki-create plan creates only its own card and removes nothing`);
    if (p.reason !== 'reference-resolve') fail(`parts[${k}]: every other part of a wiki-create plan rides as reference-resolve`);
  }
}

/** #1744 — the old order a sibling part's PRIOR quads give (the stored JSON comparison at commit proves it), or null. */
const ORDER_P = `<https://scrumboard.local/ns#order>`;
function priorOrderOf(P) {
  const q = (P.prior || []).find(([s, pr]) => s === ref(P.iri) && pr === ORDER_P);
  const m = q && /^"(-?\d+)"\^\^<http:\/\/www\.w3\.org\/2001\/XMLSchema#integer>$/.exec(q[2]);
  return m ? Number(m[1]) : null;
}
/**
 * #1744 (V2-3, F1) — a done-move's plan: the subject (into done at order `at`) plus its shifted siblings, each a
 * `sibling-order` part. Checked here from the parts alone: every sibling is an existing card staying in the subject's
 * column, its old order (from its prior quads) and shortId give the walk order (order asc, shortId asc), the new orders
 * are exactly at+1 … at+m in that order, and each old order is at most its new order − 1 (no gap was jumped). The rest is
 * proved against the STORED state at commit (doneMoveClauses): each sibling's stored JSON is its new JSON with only order and
 * version reverted, only its order triple changes, and no unlisted card sits where the walk would have reached.
 */
function bindDoneMovePlan(descriptor, plan) {
  if (plan.counter != null) fail('an origin plan carries no counter');
  if (plan.collections?.length) fail('a card-route origin plan holds no collections');
  const subject = `${ENTITY_IRI}${descriptor.subject}`;
  const S = plan.parts.filter((p) => p.iri === subject);
  if (S.length !== 1) fail(`a done-move plan holds exactly one part for its subject ${subject}`);
  const [P] = S;
  if (P.remove || P.expectedVersion == null) fail('the done-move subject is an existing card');
  if (P.reason != null) fail('the done-move subject part carries no reason');
  if (Number(P.version) !== descriptor.provenance.version) fail('origin.provenance.version must equal the card part\'s new version');
  const sj = JSON.parse(P.json);
  const at = Number(sj.order);
  if (!Number.isSafeInteger(at)) fail('the done-move subject has an integer order');
  const sibs = plan.parts.filter((p) => p.iri !== subject).map((p, k) => {
    if (p.remove || p.expectedVersion == null) fail(`sibling ${k}: a done-move shifts existing cards only`);
    if (p.reason !== 'sibling-order') fail(`sibling ${k}: every other part of a done-move rides as sibling-order`);
    const j = JSON.parse(p.json);
    if (j.column !== sj.column) fail(`sibling ${p.iri} is not in the subject's column`);
    const old = priorOrderOf(p);
    if (old == null) fail(`sibling ${p.iri}: its prior state carries no order`);
    if (!Number.isSafeInteger(j.order) || !Number.isSafeInteger(j.shortId)) fail(`sibling ${p.iri}: an integer order and shortId`);
    return { p, old, now: j.order, shortId: j.shortId };
  }).sort((a, b) => (a.old - b.old) || (a.shortId - b.shortId));
  const unanchored = plan.walk == null || plan.walk.anchor === undefined;
  sibs.forEach((x, k) => {
    // V2-3 — no surplus part: an unanchored walk starts at `at`, so a card below it is not in the walk (an anchored walk's
    // lower bound is the anchor's stored position, checked at commit by doneMoveClauses)
    if (unanchored && x.old < at) fail(`sibling ${x.p.iri} (order ${x.old}) is below the walk's start ${at}: it does not shift`);
    if (x.now !== at + k + 1) fail(`the walk gives sibling ${x.p.iri} order ${at + k + 1}, not ${x.now}`);
    if (x.old > x.now - 1) fail(`sibling ${x.p.iri} was past a gap (order ${x.old}): it does not shift`);
  });
}

/** A plan canonicalized by canonCardWrite itself, with pending and origin refused (r3 §3). */
function canonOriginPlan(plan) {
  obj(plan, ['parts', 'counter', 'collections', 'reads', 'walk'], 'plan');
  return canonCardWrite({ parts: plan.parts ?? [], counter: plan.counter, collections: plan.collections, reads: plan.reads, walk: plan.walk }, { origin: true });
}

/**
 * A STORED origin plan re-admitted (review v122): the reader's twin of canonOriginPlan + bindOriginPlan. The stored plan
 * holds canonical term strings, which canonCardWrite does not take as input, so this checks that form directly: exact
 * keys, canonical integers, sorted unique quads each owned by its part, parts in iri order, then the route binding.
 */
export function admitStoredOriginPlan(descriptor, plan) {
  const keys = (x, want, opt, w) => {
    if (!x || typeof x !== 'object' || Array.isArray(x)) fail(`${w} is an object`);
    const k = Object.keys(x);
    if (want.some((n) => !k.includes(n)) || k.some((n) => !want.includes(n) && !opt.includes(n))) fail(`${w} has keys ${JSON.stringify(k)}`);
  };
  const int = (s, w) => { if (typeof s !== 'string' || canonInteger(s) !== s || s.startsWith('-')) fail(`${w} is not a canonical integer`); };
  // a stored term is canonical only if the FORWARD rules (cardTerm) reproduce it byte for byte from its own parse
  const LIT = /^"((?:[^"\\]|\\.)*)"(?:@([^"]+)|\^\^<([^<>]*)>)?$/;
  const parseTerm = (t) => {
    if (t.startsWith('<') && t.endsWith('>')) return { type: 'uri', value: t.slice(1, -1) };
    const m = LIT.exec(t);
    if (!m) return null;
    let value;
    try { value = JSON.parse(`"${m[1]}"`); } catch { return null; }
    return { type: 'literal', value, ...(m[2] != null ? { lang: m[2] } : {}), ...(m[3] != null ? { datatype: m[3] } : {}) };
  };
  const isTerm = (t) => {
    if (typeof t !== 'string') return false;
    const p = parseTerm(t);
    if (!p) return false;
    try { return cardTerm(p, 'stored term') === t; } catch (e) { if (e instanceof ValidationError) return false; throw e; }
  };
  const quads = (list, w, each) => {
    if (!Array.isArray(list)) fail(`${w} is an array`);
    list.forEach((q, n) => {
      if (!Array.isArray(q) || q.length !== 3 || q.some((t) => !isTerm(t))) fail(`${w}[${n}] is three canonical terms`);
      if (n && !(list[n - 1].join(' ') < q.join(' '))) fail(`${w}[${n}] is out of canonical order`);
      each(q, `${w}[${n}]`);
    });
  };
  const versions = (p, w) => {
    int(p.version, `${w}.version`);
    if (p.expectedVersion === null && descriptor.route === WIKI_CREATE_ROUTE) { rStr(p.json, `${w}.json`); return; }   // #1744 — its create
    int(p.expectedVersion, `${w}.expectedVersion`);
    if (BigInt(p.version) <= BigInt(p.expectedVersion)) fail(`${w}.version must be above expectedVersion`);
    rStr(p.json, `${w}.json`);
  };
  const ordered = (list, w) => list.forEach((p, k) => { if (k && !(list[k - 1].iri < p.iri)) fail(`${w}[${k}] is out of iri order`); });
  keys(plan, ['parts', 'counter'], ['collections', 'reads', 'walk'], 'plan');
  if (plan.walk != null) { keys(plan.walk, [], ['anchor'], 'plan.walk'); if (plan.walk.anchor != null) checkIri(plan.walk.anchor, 'plan.walk.anchor'); }
  if (plan.counter != null) { keys(plan.counter, ['expected', 'next'], [], 'plan.counter'); int(plan.counter.expected, 'plan.counter.expected'); int(plan.counter.next, 'plan.counter.next'); }
  if (plan.reads != null) { if (!Array.isArray(plan.reads) || !plan.reads.length) fail('plan.reads, when present, is a non-empty array'); plan.reads.forEach((r, k) => { keys(r, ['iri', 'version'], [], `plan.reads[${k}]`); checkIri(r.iri, `plan.reads[${k}].iri`); int(r.version, `plan.reads[${k}].version`); if (k && !(plan.reads[k - 1].iri < r.iri)) fail(`plan.reads[${k}] is out of iri order`); }); }
  if (!Array.isArray(plan.parts)) fail('plan.parts is an array');
  plan.parts.forEach((p, k) => {
    const w = `plan.parts[${k}]`;
    keys(p, ['iri', 'expectedVersion', 'version', 'quads', 'prior', 'json'], ['reason', 'history'], w);
    if (p.reason != null && !ORIGIN_PART_REASONS.includes(p.reason)) fail(`${w}.reason is not a known part reason`);
    // #1762 S1 — a stored part's activity facts are admitted only in their own canonical form (as every other field is)
    if (p.history != null && JSON.stringify(canonCardHistory(p.history, `${w}.history`, false)) !== JSON.stringify(p.history)) fail(`${w}.history is not its own canonical form`);
    const iri = checkIri(p.iri, `${w}.iri`), id = iri.slice(ENTITY_IRI.length);
    if (!iri.startsWith(ENTITY_IRI) || !/^[A-Za-z0-9-]{1,64}$/.test(id)) fail(`${w}.iri must be ${ENTITY_IRI}<card id>`);
    versions(p, w);
    quads(p.quads, `${w}.quads`, (t, wq) => cardQuadClass(t, iri, id, wq));
    if (!p.quads.some(([s, pr]) => s === ref(iri) && pr === ref(CW.rdfType))) fail(`${w}.quads must type the card`);
    quads(p.prior, `${w}.prior`, (t, wq) => { if (cardQuadClass(t, iri, id, wq) === 'shared') fail(`${wq}: a shared node is never deleted by a card write`); });
  });
  ordered(plan.parts, 'plan.parts');
  if (plan.collections != null) {
    if (!Array.isArray(plan.collections) || !plan.collections.length) fail('plan.collections, when present, is a non-empty array');
    plan.collections.forEach((p, k) => {
      const w = `plan.collections[${k}]`;
      keys(p, ['collection', 'iri', 'expectedVersion', 'version', 'quads', 'prior', 'json'], ['unique', 'requires', 'history'], w);
      // #1762 S1 (review 131) — a stored collection part's activity facts are admitted only in their own canonical form
      if (p.history != null && JSON.stringify(canonEntityHistory(p.history, `${w}.history`, false)) !== JSON.stringify(p.history)) fail(`${w}.history is not its own canonical form`);
      if (typeof p.collection !== 'string' || !COLL_KEY_RE.test(p.collection)) fail(`${w}.collection must name a collection`);
      const iri = checkIri(p.iri, `${w}.iri`);
      versions(p, w);
      const own = (t, wq) => {
        if (t[0] !== ref(iri) && !t[0].startsWith(`<${iri}/list/`)) fail(`${wq}: subject ${t[0]} is not ${ref(iri)}`);
        if (CW_RESERVED_PREDICATES.has(unref(t[1])) || unref(t[1]) === `${CW.scrum}inCollection`) fail(`${wq}: ${t[1]} is written by the compiler`);
      };
      quads(p.quads, `${w}.quads`, own);
      quads(p.prior, `${w}.prior`, own);
      const iriTerm = (t, wt) => { if (!isTerm(t) || unref(t) == null) fail(`${wt} is an IRI term`); };
      if (p.unique != null) {
        if (!Array.isArray(p.unique) || !p.unique.length) fail(`${w}.unique, when present, is a non-empty array`);
        p.unique.forEach((u, n) => {
          keys(u, ['all'], [], `${w}.unique[${n}]`);
          if (!Array.isArray(u.all) || !u.all.length) fail(`${w}.unique[${n}].all is a non-empty array`);
          u.all.forEach((a, j) => {
            keys(a, ['predicate', 'value'], [], `${w}.unique[${n}].all[${j}]`);
            iriTerm(a.predicate, `${w}.unique[${n}].all[${j}].predicate`);
            if (!isTerm(a.value)) fail(`${w}.unique[${n}].all[${j}].value is a canonical term`);
          });
        });
      }
      if (p.requires != null) {
        if (!Array.isArray(p.requires) || !p.requires.length) fail(`${w}.requires, when present, is a non-empty array`);
        p.requires.forEach((r, n) => { iriTerm(r, `${w}.requires[${n}]`); if (n && !(p.requires[n - 1] < r)) fail(`${w}.requires[${n}] is out of order`); });
      }
    });
    ordered(plan.collections, 'plan.collections');
  }
  bindOriginPlan(descriptor, plan);
  // rebuilt in canonCardWrite's own key order, so a caller comparing its JSON to the stored bytes refuses a reordering
  const cardPart = (p) => ({ iri: p.iri, expectedVersion: p.expectedVersion, version: p.version, quads: p.quads, prior: p.prior, json: p.json, ...(p.reason != null ? { reason: p.reason } : {}), ...(p.history != null ? { history: p.history } : {}) });   // #1762 S1
  const collPart = (p) => ({ collection: p.collection, iri: p.iri, expectedVersion: p.expectedVersion, version: p.version, quads: p.quads, prior: p.prior, json: p.json,
    ...(p.unique ? { unique: p.unique.map((u) => ({ all: u.all.map((a) => ({ predicate: a.predicate, value: a.value })) })) } : {}), ...(p.requires ? { requires: p.requires } : {}), ...(p.history != null ? { history: p.history } : {}) });   // #1762 S1
  return { parts: plan.parts.map(cardPart), counter: plan.counter, ...(plan.collections ? { collections: plan.collections.map(collPart) } : {}), ...(plan.reads ? { reads: plan.reads.map((r) => ({ iri: r.iri, version: r.version })) } : {}), ...(plan.walk ? { walk: { ...plan.walk } } : {}) };
}

function canonOriginPrepare(i, common) {
  const { descriptor } = canonOriginDescriptor(i.origin);
  const plan = canonOriginPlan(i.plan);
  bindOriginPlan(descriptor, plan);
  originCommon(descriptor, common, common.opId, originPrepareOp(descriptor.mutationId));
  return { origin: descriptor, plan };
}

function canonOriginCommit(i, record, common) {
  if (record.pending) fail('origin and pending are mutually exclusive on a card.write');
  const { descriptor, occurredAt } = canonOriginDescriptor(i.origin, { commit: true });
  bindOriginPlan(descriptor, record);
  originCommon(descriptor, common, common.opId, originCommitOp(descriptor.mutationId));
  return originCommitRecord(descriptor, record, occurredAt);
}
/** The canonical record of an origin commit: the plan's own fields, then the origin (descriptor + occurredAt). */
const originCommitRecord = (descriptor, plan, occurredAt) => ({ parts: plan.parts, counter: plan.counter, ...(plan.collections?.length ? { collections: plan.collections } : {}), ...(plan.reads?.length ? { reads: plan.reads } : {}), ...(plan.walk ? { walk: plan.walk } : {}), origin: { ...descriptor, occurredAt } });
/** The plan half of an origin commit's record: what planDigest binds. */
const originPlanOf = (record) => ({ parts: record.parts, counter: record.counter, ...(record.collections?.length ? { collections: record.collections } : {}), ...(record.reads?.length ? { reads: record.reads } : {}), ...(record.walk ? { walk: record.walk } : {}) });

/**
 * r3 §2a.5a: the digest of the origin commit RECONSTRUCTED from stored canonical parts — the descriptor, the plan and the
 * Prepared occurredAt, the derived op and the frozen actor — with card.write's own digest function. A reader compares a
 * stored receipt digest to THIS, never to another stored string.
 */
export function originCommitDigest(descriptor, plan, occurredAt) {
  return recordDigest({ kind: 'card.write', opId: originCommitOp(descriptor.mutationId), actor: `${PERSON_IRI}${descriptor.originActor}`, evidence: [], record: originCommitRecord(descriptor, plan, occurredAt) });
}

const strLit = (s) => recLit(s);
const XSD_STRING = `<${XSD}string>`, XSD_DATETIME = `<${XSD}dateTime>`;
/** An exact plain string literal equal to `want` (no language tag, no other datatype). */
const plainEq = (x, want) => `    FILTER(isLiteral(${x}) && DATATYPE(${x}) = ${XSD_STRING} && LANG(${x}) = "" && STR(${x}) = ${strLit(want)})`;

function compileOriginPrepare(c) {
  const digest = recordDigest(c);
  const OP = ref(c.opId);
  const { origin: D, plan } = c.record;
  const T = ORIGIN_TERMS;
  const PREP = T.preparedSubject(D.mutationId);
  const where = [], pre = [], top = [], dBinds = [], del = [], dIns = [], bDel = [], bIns = [];
  const names = new Map();
  const v = (text) => {
    let n = names.get(text);
    if (!n) { n = `r${names.size}`; names.set(text, n); dBinds.push(ok(text, n)); }
    return `?d_${n}`;
  };
  where.push(...dupGuard(OP));
  pre.push(`    FILTER NOT EXISTS { ${inEither(`${PREP} ?xq_p ?xq_o`)} }`);   // Prepared absent (one per mutationId)
  // #1747 R1 — and no Origin: a native Origin follows its Prepared node, so one without it is an IMPORTED origin, which is
  // settled history and is never prepared again
  pre.push(`    FILTER NOT EXISTS { ${inEither(`${T.originSubject(D.mutationId)} ?xq_op ?xq_oo`)} }`);
  bIns.push(
    `  ${v(PREP)} a ${v(T.Prepared)} .`,
    `  ${v(PREP)} ${T.mutationId} ${v(strLit(D.mutationId))} .`,
    `  ${v(PREP)} ${T.originKeyJson} ${v(strLit(originKeyOf(D.route, D.subject, D.requestKey, D.originActor)))} .`,
    `  ${v(PREP)} ${T.route} ${v(strLit(D.route))} .`,
    `  ${v(PREP)} ${T.originActor} ${v(strLit(D.originActor))} .`,
    `  ${v(PREP)} ${T.descriptorJson} ${v(strLit(JSON.stringify(D)))} .`,
    `  ${v(PREP)} ${T.descriptorDigest} ${v(strLit(originDescriptorDigest(D)))} .`,
    `  ${v(PREP)} ${T.planJson} ${v(strLit(JSON.stringify(plan)))} .`,
    `  ${v(PREP)} ${T.planDigest} ${v(strLit(originPlanDigest(plan)))} .`,
    `  ${v(PREP)} ${T.occurredAt} ${v('?n_at')} .`,   // r3 §0 A: the prepare update's own NOW()
  );
  pre.push(`    BIND(true AS ?ok)`);
  where.push(`  OPTIONAL {`, ...pre, `  }`);
  where.push(...top);
  where.push(`  BIND(IF(BOUND(?ok), ${EX.APPLIED}, ${EX.PRECONDITION_FAILED}) AS ?n_outcome)`);
  where.push(nb(JSON.stringify(digest), 'digest'), nb(ref(c.actor), 'actor'), nb('NOW()', 'at'), nb(PREP, 'target0'));
  where.push(...dBinds);
  bDel.unshift(`  ${MARKER_SUBJECT} ${EX.commitSeq} ?s .`);
  bIns.unshift(`  ${MARKER_SUBJECT} ${EX.commitSeq} ?s1 .`,
    `  ${OP} ${EX.outcome} ?n_outcome .`, `  ${OP} ${EX.digest} ?n_digest .`, `  ${OP} ${EX.actor} ?n_actor .`,
    `  ${OP} ${EX.at} ?n_at .`, `  ${OP} ${EX.commitSeq} ?s1 .`, `  ${OP} ${EX.target} ?n_target0 .`);
  const sparql = assemble(del, bDel, dIns, bIns, where);
  const check = staticCheck(sparql, c.opId);
  if (!check.ok) fail(`compiler rejected its own output: ${check.errors.join('; ')}`);
  return { sparql, digest, canonical: c };
}

/**
 * The origin half of an origin commit, added to compileCardWrite's ONE update (r3 §4). Guards go into `pre` (the same
 * ?ok as every business guard); effects into the bookkeeping templates through `v` (ok-guarded).
 */
function originCommitClauses(c, digest, { OP, v, pre, dBinds, bDel, bIns }) {
  const R = c.record;
  const { occurredAt, ...D } = R.origin;
  const plan = originPlanOf(R);
  const T = ORIGIN_TERMS;
  const mid = D.mutationId;
  const PREP = T.preparedSubject(mid), ORIG = T.originSubject(mid);
  const N = D.slots.length;
  // guard 3 — the COMPLETE Prepared shape (§2a.7): typed, every field exactly once, byte-equal to THIS commit, uncommitted
  const fields = [['mutationId', 'xq_m', mid], ['originKeyJson', 'xq_k', originKeyOf(D.route, D.subject, D.requestKey, D.originActor)],
    ['route', 'xq_r', D.route], ['originActor', 'xq_a', D.originActor], ['descriptorJson', 'xq_d', JSON.stringify(D)],
    ['descriptorDigest', 'xq_dd', originDescriptorDigest(D)], ['planJson', 'xq_p', JSON.stringify(plan)], ['planDigest', 'xq_pd', originPlanDigest(plan)]];
  pre.push(`    GRAPH ${BK} { ${PREP} a ${T.Prepared} ; ${[...fields.map(([p, x]) => `${T[p]} ?${x}`), `${T.occurredAt} ?xq_o`].join(' ; ')} . }`);
  for (const [, x, want] of fields) pre.push(plainEq(`?${x}`, want));
  // Q4: the copied occurredAt equals the ONE stored xsd:dateTime, as its lexical form — no normalization, no clock
  pre.push(`    FILTER(isLiteral(?xq_o) && DATATYPE(?xq_o) = ${XSD_DATETIME} && STR(?xq_o) = ${strLit(occurredAt)})`);
  for (const [p, x] of [...fields.map(([p, x]) => [p, x]), ['occurredAt', 'xq_o']]) {
    pre.push(`    FILTER NOT EXISTS { GRAPH ${BK} { ${PREP} ${T[p]} ?${x}2 FILTER(!sameTerm(?${x}2, ?${x})) } }`);
  }
  pre.push(`    FILTER NOT EXISTS { GRAPH ${BK} { ${PREP} ${T.committedBy} ?xq_cb } }`);
  // closed shape, as the reader holds it: one rdf:type and no predicate outside the nine fields
  pre.push(`    FILTER NOT EXISTS { GRAPH ${BK} { ${PREP} a ?xq_t2 FILTER(!sameTerm(?xq_t2, ${T.Prepared})) } }`);
  pre.push(`    FILTER NOT EXISTS { GRAPH ${BK} { ${PREP} ?xq_x ?xq_y FILTER(?xq_x NOT IN (${[ref(CW.rdfType), ...fields.map(([p]) => T[p]), T.occurredAt].join(', ')})) } }`);
  // guard 3a — the agent routes' executor pre-state guards against the actual domain graph (g1 held, g2 complete)
  if (ORIGIN_AGENT_ROUTES.includes(D.route)) {
    const HOLDER = ref(`${PERSON_IRI}${D.subject}`), CLAIMED = ref(`${CW.scrum}claimedBy`);
    for (const P of R.parts) pre.push(`    ${ref(P.iri)} ${CLAIMED} ${HOLDER} .`);   // g1
    pre.push(`    FILTER NOT EXISTS { ?xq_h ${CLAIMED} ${HOLDER} ; ${ref(CW.rdfType)} ${ref(`${CW.scrum}Card`)} . FILTER(?xq_h NOT IN (${R.parts.map((P) => ref(P.iri)).join(', ')})) }`);   // g2
  }
  // guard 4 — origin absence: no Origin and no Obligation subject for any slot
  pre.push(`    FILTER NOT EXISTS { ${inEither(`${ORIG} ?xq_op ?xq_oo`)} }`);
  D.slots.forEach((s, k) => pre.push(`    FILTER NOT EXISTS { ${inEither(`${T.obligationSubject(mid, s.slot)} ?xq_bp${k} ?xq_bo${k}`)} }`));
  // #1629 s3 G-P — nothing may already sit at a slot's derived post IRI or at its deterministic publication op, in either
  // graph, as subject or object: a post written first at that postId would otherwise be reserved beside, not refused.
  // (Origin clauses only: a standalone postseq.reserve is unchanged.)
  D.slots.forEach((s, k) => {
    for (const [x, iri] of [['xg_p', ref(`${ENTITY_IRI}${announcePostId(mid, s.slot)}`)], ['xg_o', ref(announceOpIdFor(mid, s.slot))]]) {
      pre.push(`    FILTER NOT EXISTS { ${inEither(`${iri} ?${x}a${k} ?${x}b${k}`)} }`, `    FILTER NOT EXISTS { ${inEither(`?${x}c${k} ?${x}d${k} ${iri}`)} }`);
    }
  });
  // guards 5 and 6, and the reservations + allocator advance: the slice-1 clauses, unchanged (variables tagged `o`)
  const items = D.slots.map((s) => ({
    mode: 'announcement', mutationId: mid, slot: s.slot, postId: announcePostId(mid, s.slot),
    draft: canonAnnouncementDraft({ body: s.body, author: s.author, originActor: D.originActor, occurredAt, mentions: s.mentions, notify: s.notify }),
  }));
  allocationClauses({ items, N, OP, digest, v, pre, dBinds, bDel, bIns, t: 'o' });
  // the Origin, its Obligations, and the prepared link
  bIns.push(
    `  ${v(ORIG)} a ${v(T.Origin)} .`,
    `  ${v(ORIG)} ${T.mutationId} ${v(strLit(mid))} .`,
    `  ${v(ORIG)} ${T.originKeyJson} ${v(strLit(fields[1][2]))} .`,
    `  ${v(ORIG)} ${T.descriptorDigest} ${v(strLit(originDescriptorDigest(D)))} .`,
    `  ${v(ORIG)} ${T.planDigest} ${v(strLit(originPlanDigest(plan)))} .`,
    `  ${v(ORIG)} ${T.committedAt} ${v('?n_at')} .`,
    `  ${v(ORIG)} ${T.commitOp} ${v(OP)} .`,
    `  ${v(ORIG)} ${T.slotCount} ${v(psqSafeInt(N))} .`,
  );
  const provenanceJson = JSON.stringify(D.provenance);
  D.slots.forEach((s, k) => {
    const OB = T.obligationSubject(mid, s.slot);
    bIns.push(
      `  ${v(OB)} a ${v(T.Obligation)} .`,
      `  ${v(OB)} ${T.obligationId} ${v(strLit(`${mid}:${s.slot}`))} .`,
      `  ${v(OB)} ${T.mutationId} ${v(strLit(mid))} .`,
      `  ${v(OB)} ${T.slot} ${v(strLit(s.slot))} .`,
      `  ${v(OB)} ${T.index} ${v(psqSafeInt(k))} .`,
      `  ${v(OB)} ${T.status} ${v(strLit('pending'))} .`,
      `  ${v(OB)} ${T.mode} ${v(strLit('publisher'))} .`,
      `  ${v(OB)} ${T.provenanceJson} ${v(strLit(provenanceJson))} .`,
      `  ${v(OB)} ${T.reservation} ${v(POSTSEQ_TERMS.reservation(items[k].postId))} .`,
    );
  });
  bIns.push(`  ${v(PREP)} ${T.committedBy} ${v(OP)} .`);
}

// ---------- #1624: entity.put kind 'collection' — mutable small-kind entities in ONE guarded update ----------
//
// The K13 families that the document guarded with its write lock (procedures and their versions, runs, models,
// predicates, kinds, agents and their prompts): REST stages a locked write and commits the touched entities here, the
// same transaction shape as #1598's card.write (review 08:37Z: reuse that machinery through the single allowlisted
// entity.put). Each part is one entity of one collection:
//   GUARD   every part together: its `urn:ex:ver` equals expectedVersion (or its subject is fresh for a create), and
//           every declared UNIQUE value (e.g. a model key, a predicate name, a procedure + version number) is held by no
//           OTHER member of that collection. One stale or colliding part means nothing lands.
//   DELETE  each update/remove part's own subject (its projection is subject-only: measured for every family here) and
//           its prior quads.
//   INSERT  the projection, `scrum:inCollection "<key>"`, `urn:ex:ver`, `entityJson` and recordedBy.
// A quad whose subject is not the part's own IRI is refused: no part can write into another entity.

const COLL_KEY_RE = /^[a-z][A-Za-z0-9]{0,40}$/;

function canonCollectionWrite(e) {
  obj(e, ['kind', 'parts'], 'entity');
  if (!Array.isArray(e.parts) || !e.parts.length) fail('entity.parts is a non-empty array');
  const parts = e.parts.map((x, k) => {
    const w = `entity.parts[${k}]`;
    obj(x, ['collection', 'iri', 'expectedVersion', 'version', 'quads', 'prior', 'json', 'remove', 'unique', 'requires', 'history'], w);
    if (typeof x.collection !== 'string' || !COLL_KEY_RE.test(x.collection)) fail(`${w}.collection must name a collection`);
    const history = x.history == null ? null : canonEntityHistory(x.history, `${w}.history`, x.remove === true);   // #1762 S1
    const iri = checkIri(x.iri, `${w}.iri`);
    const own = (list, label) => {
      if (!Array.isArray(list)) fail(`${w}.${label} must be an array`);
      const out = list.map((q, n) => {
        if (!Array.isArray(q) || q.length !== 3) fail(`${w}.${label}[${n}] is [s, p, o]`);
        const t = q.map((term, j) => cardTerm(term, `${w}.${label}[${n}][${j}]`));
        // the entity's own subject, or a cell of a list it owns (`<iri>/list/…`, named by the server, see collections-unit)
        if (t[0] !== ref(iri) && !t[0].startsWith(`<${iri}/list/`)) fail(`${w}.${label}[${n}]: subject ${t[0]} is not ${ref(iri)}`);
        if (CW_RESERVED_PREDICATES.has(unref(t[1])) || unref(t[1]) === `${CW.scrum}inCollection`) fail(`${w}.${label}[${n}]: ${t[1]} is written by the compiler`);
        return t;
      });
      return [...new Map(out.map((t) => [t.join(' '), t])).values()].sort((a, b) => (a.join(' ') < b.join(' ') ? -1 : 1));
    };
    if (x.remove === true) {
      if (x.quads != null || x.json != null || x.version != null || x.unique != null || x.requires != null) fail(`${w}: a remove part carries no quads, json, version, unique or requires`);
      return { collection: x.collection, iri, remove: true, expectedVersion: intLit(x.expectedVersion, `${w}.expectedVersion`), prior: own(x.prior ?? [], 'prior'), ...(history ? { history } : {}) };
    }
    if (x.remove != null && x.remove !== false) fail(`${w}.remove must be true or absent`);
    const expectedVersion = x.expectedVersion == null ? null : intLit(x.expectedVersion, `${w}.expectedVersion`);
    const version = intLit(x.version, `${w}.version`);
    if (expectedVersion != null && BigInt(version) <= BigInt(expectedVersion)) fail(`${w}.version must be above expectedVersion`);
    // A unique entry is one {predicate, value} or a conjunction {all: [{predicate, value}, …]} (a procedure version is
    // unique by its procedure AND its number, not by either alone).
    const pair = (u, w2) => { obj(u, ['predicate', 'value'], w2); return { predicate: ref(checkIri(u.predicate, `${w2}.predicate`)), value: cardTerm(u.value, `${w2}.value`) }; };
    const unique = (x.unique ?? []).map((u, n) => {
      const w2 = `${w}.unique[${n}]`;
      if (u && Array.isArray(u.all)) {
        obj(u, ['all'], w2);
        if (!u.all.length) fail(`${w2}.all is a non-empty array`);
        return { all: u.all.map((a, j) => pair(a, `${w2}.all[${j}]`)) };
      }
      return { all: [pair(u, w2)] };
    });
    // A reference this write SETS: the subject it names must exist in the graph when the update runs (a concurrent
    // delete makes the write PRECONDITION_FAILED instead of leaving a dangling link). Never a lock on the target.
    if (x.requires != null && !Array.isArray(x.requires)) fail(`${w}.requires must be an array`);
    const requires = [...new Set((x.requires ?? []).map((r, n) => ref(checkIri(r, `${w}.requires[${n}]`))))].sort();
    return { collection: x.collection, iri, expectedVersion, version, quads: own(x.quads, 'quads'),
      prior: expectedVersion == null ? (x.prior == null || (Array.isArray(x.prior) && !x.prior.length) ? [] : fail(`${w}.prior: a create has no prior state`)) : own(x.prior ?? [], 'prior'),
      json: rStr(x.json, `${w}.json`), ...(unique.length ? { unique } : {}), ...(requires.length ? { requires } : {}), ...(history ? { history } : {}) };
  }).sort((a, b) => (a.iri < b.iri ? -1 : 1));
  if (new Set(parts.map((p) => p.iri)).size !== parts.length) fail('entity.parts: an entity appears in two parts');
  if (parts.some((p) => p.history) && !parts.every((p) => p.history)) fail('entity.parts: history must be on every part or on none');   // #1762 S1 — fail closed
  return { kind: 'collection', parts };
}

// #1666 — one update part's bookkeeping triples, as a branch of the deletion UNION (shared ?xbs ?xbp ?xbo).
const bkBranch = (I) => `    { GRAPH ${BK} { ${I} ?xbp ?xbo } BIND(${I} AS ?xbs) }`;
const isBkBranch = (b) => b.endsWith(' AS ?xbs) }');

/**
 * The clauses one set of collection parts contributes to an update: guards into `pre`, deletion branches into
 * `branches`, inserts into `dIns` (through `v`, the update's ?d_ binder). Shared by entity.put kind 'collection' and by
 * card.write's `collections` (a write that touches cards AND a collection entity is still ONE guarded update).
 */
function collectionClauses(parts, { OP, v, pre, top, branches, dIns, bIns, bDel, dBinds, tag, history = null }) {
  const VER = ref(`${NS}ver`), REC = ref(`${NS}recordedBy`), JSONP = ref(`${CW.scrum}entityJson`), INC = ref(`${CW.scrum}inCollection`);
  parts.forEach((P, k) => {
    const I = ref(P.iri), KEY = recLit(P.collection);
    if (P.expectedVersion == null) pre.push(...freshSubject(I));
    else {
      pre.push(`    GRAPH ${BK} { ${I} ${VER} ?xcv${tag}${k} . }`, `    ${I} ${INC} ${KEY} .`, `    FILTER(?xcv${tag}${k} = ${P.expectedVersion})`);   // #1638 — ver is bookkeeping
      // #1638 — the entity's bookkeeping (ver, recordedBy, entityJson) is deleted from the bk graph with its domain triples
      branches.push(bkBranch(I));   // #1666 — a UNION branch, never a top-level OPTIONAL (rows add, not multiply)
      branches.push(`    { ${I} ?xp ?xo BIND(${I} AS ?xs) }`);
      if (P.prior.length) branches.push(`    { VALUES (?xs ?xp ?xo) {\n${P.prior.map((q) => `      (${q.join(' ')})`).join('\n')}\n    } }`);
    }
    for (const U of P.unique || []) pre.push(`    FILTER NOT EXISTS { ?xu ${INC} ${KEY} ; ${U.all.map((a) => `${a.predicate} ${a.value}`).join(' ; ')} . FILTER(?xu != ${I}) }`);
    (P.requires || []).forEach((T, j) => pre.push(`    FILTER EXISTS { ${T} ?xrp${tag}${k}_${j} ?xro${tag}${k}_${j} }`));
    if (P.history && history) historyActivityQuads(history.c, P, history.offset + k).forEach((t) => dIns.push(`  ${v(t[0])} ${v(t[1])} ${t[2] === '?n_at' ? '?n_at' : v(t[2])} .`));   // #1762 S1
    if (P.remove) return;
    for (const [s, p, o] of P.quads) dIns.push(`  ${v(s)} ${v(p)} ${v(o)} .`);
    dIns.push(`  ${v(I)} ${INC} ${v(KEY)} .`);
    bIns.push(`  ${v(I)} ${VER} ${v(P.version)} .`, `  ${v(I)} ${REC} ${v(OP)} .`, `  ${v(I)} ${JSONP} ${v(recLit(P.json))} .`);
  });
}

function compileCollectionWrite(c) {
  const digest = recordDigest(c);
  const OP = ref(c.opId);
  const R = c.record.entity;
  const where = [], pre = [], top = [], dBinds = [], del = [], dIns = [], bDel = [], bIns = [], branches = [];
  const names = new Map();
  const v = (text) => {
    let n = names.get(text);
    if (!n) { n = `r${names.size}`; names.set(text, n); dBinds.push(ok(text, n)); }
    return `?d_${n}`;
  };
  where.push(...dupGuard(OP));
  collectionClauses(R.parts, { OP, v, pre, top, branches, dIns, bIns, bDel, dBinds, tag: 'c', history: { c, offset: 0 } });
  pre.push(`    BIND(true AS ?ok)`);
  where.push(`  OPTIONAL {`, ...pre, `  }`);
  where.push(...top);
  if (branches.length) {
    where.push(`  OPTIONAL {`, branches.join('\n    UNION\n'), `  }`);
    dBinds.push(ok('?xs', 'xs'), ok('?xp', 'xp'), ok('?xo', 'xo'));
    del.push(`  ?d_xs ?d_xp ?d_xo .`);
    if (branches.some(isBkBranch)) {   // #1666 — a bk row leaves ?xs unbound and a data row leaves ?xbs unbound: each template skips the other's
      dBinds.push(ok('?xbs', 'xbs'), ok('?xbp', 'xbp'), ok('?xbo', 'xbo'));
      bDel.push(`  ?d_xbs ?d_xbp ?d_xbo .`);
    }
  }
  where.push(`  BIND(IF(BOUND(?ok), ${EX.APPLIED}, ${EX.PRECONDITION_FAILED}) AS ?n_outcome)`);
  where.push(nb(JSON.stringify(digest), 'digest'), nb(ref(c.actor), 'actor'), nb('NOW()', 'at'), nb(ref(R.parts[0].iri), 'target0'));
  where.push(...dBinds);
  bDel.unshift(`  ${MARKER_SUBJECT} ${EX.commitSeq} ?s .`);
  bIns.unshift(`  ${MARKER_SUBJECT} ${EX.commitSeq} ?s1 .`,
    `  ${OP} ${EX.outcome} ?n_outcome .`, `  ${OP} ${EX.digest} ?n_digest .`, `  ${OP} ${EX.actor} ?n_actor .`,
    `  ${OP} ${EX.at} ?n_at .`, `  ${OP} ${EX.commitSeq} ?s1 .`, `  ${OP} ${EX.target} ?n_target0 .`);
  const sparql = assemble(del, bDel, dIns, bIns, where);
  const check = staticCheck(sparql, c.opId);
  if (!check.ok) fail(`compiler rejected its own output: ${check.errors.join('; ')}`);
  return { sparql, digest, canonical: c };
}

// ---------- #1562: LangGraph checkpoint-saver kinds ----------
//
// Five kinds — lg.put, lg.putWrites, lg.deleteThread, lg.runTransition, lg.reap — that
// compile through the SAME three-category template as the kinds above and are
// read back by the SAME staticCheck: a top-level duplicate guard, a commit-marker
// bump and a receipt bound whenever the guard passes, and every DOMAIN template
// triple carrying a ?d_ variable that is IF(BOUND(?ok), x, ?u).
//
// The PRECONDITION of every lg kind is the thread generation (deleteThread
// bumps it); put and putWrites also refuse a checkpoint deleteThread tombstoned
// (an old run's config); lg.runTransition also needs the branch head and status;
// lg.reap needs a tombstoned parent. The
// process-fact transition (design v0.2 §1) is computed in ?x_ helper bindings
// and then passed through the ?ok guard like every other domain value: the guard
// is necessary for a domain triple, and the transition may further leave a ?x_
// value unbound so its triple is skipped.
//
// The compiler, not the caller, mints every IRI and encodes every caller string
// (percent-encoding for identifiers, base64 for opaque payloads), so a literal in
// the update text is always inside [A-Za-z0-9+/=%._~!*'()-] and can never carry
// SPARQL syntax that the static checker would have to parse around.

export const LG_KINDS = Object.freeze(['lg.put', 'lg.putWrites', 'lg.deleteThread', 'lg.runTransition', 'lg.reap']);
/**
 * #1629 slice 1 — the postseq.reserve primitive: ONE compiler-owned guarded executor update that reserves N consecutive
 * numbers for an ordered batch of derived postIds (ordinary + announcement modes share the allocator). Compiles through
 * the SAME three-category discipline as every other kind: a top-level duplicate guard, a commit-marker bump, a receipt
 * bound whenever the guard passes, and EVERY DOMAIN template triple carrying a `?d_` (ok-guarded). The allocator and
 * reservations live in the bookkeeping graph, classified by the shared POSTSEQ_TERMS vocabulary (core/graph-vocab.mjs).
 */
export const POSTSEQ_RESERVE_KIND = 'postseq.reserve';
export const POSTSEQ_KINDS = Object.freeze([POSTSEQ_RESERVE_KIND]);
/** WRITES_IDX_MAP of @langchain/langgraph-checkpoint 1.1.5, pinned (a special write's idx is its channel's). */
export const LG_SPECIAL_IDX = Object.freeze({ __error__: -1, __scheduled__: -2, __interrupt__: -3, __resume__: -4 });
const LG_FIELDS = {
  'lg.put': ['scope', 'thread', 'ns', 'gen', 'cid', 'parentCid', 'step', 'payloadType', 'payload', 'metaType', 'metadata', 'meta', 'channelVersions', 'blobs'],
  'lg.putWrites': ['scope', 'thread', 'ns', 'gen', 'cid', 'taskId', 'resumer', 'writes'],
  'lg.deleteThread': ['scope', 'thread', 'gen'],
  'lg.runTransition': ['scope', 'thread', 'ns', 'gen', 'cid', 'to'],
  'lg.reap': ['scope', 'thread', 'ns', 'gen', 'cid', 'parentCid'],
};
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const SAFE_LIT_RE = /^[A-Za-z0-9+/=%._~!*'()-]*$/;
const SCOPE_RE = /^[A-Za-z0-9_-]{1,64}$/;
const enc = encodeURIComponent;

const str = (v, what) => (typeof v === 'string' ? v : fail(`${what}: string required`));
const optStr = (v, what) => (v == null ? null : str(v, what));
const b64 = (v, what) => (typeof v === 'string' && B64_RE.test(v) ? v : fail(`${what}: base64 string required`));
/** Any safe integer, negative allowed (steps start at -1, special write idx are negative). */
const sint = (v, what) => {
  const s = typeof v === 'number' ? (Number.isSafeInteger(v) ? String(v) : fail(`${what}: unsafe integer`)) : v;
  if (typeof s !== 'string') fail(`${what}: integer required`);
  return canonInteger(s);
};
const optSint = (v, what) => (v == null ? null : sint(v, what));
const byKey = (k) => (a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0);

/** IRI minting for the saver's records. Exported so reads use the identical spelling. */
export const lgMint = Object.freeze({
  scope: (scope) => `${LG_NS}${scope}`,
  thread: (scope, tid) => `${LG_NS}${scope}/thr/${enc(tid)}`,
  ns: (scope, tid, ns) => `${LG_NS}${scope}/thr/${enc(tid)}/ns:${enc(ns)}`,
  cp: (scope, tid, ns, cid) => `${lgMint.ns(scope, tid, ns)}/cp/${enc(cid)}`,
  write: (scope, tid, ns, cid, task, idx) => `${lgMint.cp(scope, tid, ns, cid)}/w/${enc(task)}/${idx}`,
  blob: (scope, tid, ns, ch, ver) => `${lgMint.ns(scope, tid, ns)}/blob/${enc(ch)}/${enc(ver)}`,
  branch: (scope, tid, ns, cid) => `${lgMint.ns(scope, tid, ns)}/branch/${enc(cid)}`,
});

function canonicalizeLg(i) {
  for (const k of Object.keys(i)) if (!['kind', 'opId', 'actor', 'lg'].includes(k)) fail(`unknown field ${k} for kind ${i.kind}`);
  const opId = checkIri(i.opId, 'opId');
  if (!opId.startsWith(`${NS}op/`)) fail(`opId must be under ${NS}op/`);
  const actor = checkIri(i.actor, 'actor');
  const g = i.lg || {};
  for (const k of Object.keys(g)) if (!LG_FIELDS[i.kind].includes(k)) fail(`unknown field lg.${k} for kind ${i.kind}`);
  const scope = str(g.scope, 'lg.scope');
  if (!SCOPE_RE.test(scope)) fail('lg.scope must match [A-Za-z0-9_-]{1,64}');
  const out = { scope, thread: str(g.thread, 'lg.thread'), gen: intLit(g.gen, 'lg.gen') };
  if (i.kind !== 'lg.deleteThread') {
    out.ns = str(g.ns, 'lg.ns');
    out.cid = str(g.cid, 'lg.cid');
    if (out.cid === '') fail('lg.cid must be non-empty');
  }
  if (i.kind === 'lg.put') {
    out.parentCid = optStr(g.parentCid, 'lg.parentCid');
    out.step = optSint(g.step, 'lg.step');
    out.payloadType = str(g.payloadType, 'lg.payloadType');
    out.payload = b64(g.payload, 'lg.payload');
    out.metaType = str(g.metaType, 'lg.metaType');
    out.metadata = b64(g.metadata, 'lg.metadata');
    out.meta = (g.meta || []).map((m, k) => ({ key: str(m?.key, `lg.meta[${k}].key`), value: b64(m?.value, `lg.meta[${k}].value`) })).sort(byKey('key'));
    if (new Set(out.meta.map((m) => m.key)).size !== out.meta.length) fail('duplicate metadata key');
    out.channelVersions = (g.channelVersions || []).map((v, k) => ({ channel: str(v?.channel, `lg.channelVersions[${k}].channel`), version: str(v?.version, `lg.channelVersions[${k}].version`) })).sort(byKey('channel'));
    if (new Set(out.channelVersions.map((v) => v.channel)).size !== out.channelVersions.length) fail('duplicate channel in channelVersions');
    out.blobs = (g.blobs || []).map((b, k) => ({
      channel: str(b?.channel, `lg.blobs[${k}].channel`), version: str(b?.version, `lg.blobs[${k}].version`),
      type: str(b?.type, `lg.blobs[${k}].type`), value: b64(b?.value ?? '', `lg.blobs[${k}].value`),
    })).sort(byKey('channel'));
    if (new Set(out.blobs.map((b) => b.channel)).size !== out.blobs.length) fail('duplicate channel in blobs');
  } else if (i.kind === 'lg.putWrites') {
    out.taskId = str(g.taskId, 'lg.taskId');
    out.resumer = optStr(g.resumer, 'lg.resumer');
    if (!Array.isArray(g.writes) || g.writes.length === 0) fail('lg.writes: at least one write');
    out.writes = g.writes.map((w, k) => {
      const channel = str(w?.channel, `lg.writes[${k}].channel`);
      const idx = sint(w?.idx, `lg.writes[${k}].idx`);
      const special = LG_SPECIAL_IDX[channel];
      if (special !== undefined ? idx !== String(special) : idx.startsWith('-')) fail(`lg.writes[${k}].idx ${idx} does not match channel ${channel}`);
      return { idx, channel, type: str(w?.type, `lg.writes[${k}].type`), value: b64(w?.value ?? '', `lg.writes[${k}].value`), assignee: optStr(w?.assignee, `lg.writes[${k}].assignee`) };
    });
    if (new Set(out.writes.map((w) => w.idx)).size !== out.writes.length) fail('duplicate write idx in one batch');
  } else if (i.kind === 'lg.runTransition') {
    if (!['done', 'failed'].includes(g.to)) fail('lg.to must be done or failed');
    out.to = g.to;
  } else if (i.kind === 'lg.reap') {
    out.parentCid = str(g.parentCid, 'lg.parentCid');
    if (out.parentCid === '') fail('lg.parentCid must be non-empty');
  }
  return { kind: i.kind, opId, actor, evidence: [], targets: [], newAssertion: null, authority: null, grant: null, rule: null, lg: out };
}

function digestLg(c) {
  const body = createHash('sha256').update(JSON.stringify(c.lg)).digest('hex');
  const lines = [`digestV ${DIGEST_V}`, `canonV ${CANON_V}`, `kind ${c.kind}`, `opId ${ref(c.opId)}`, `actor ${ref(c.actor)}`, `lg ${body}`];
  return createHash('sha256').update(lines.join('\n') + '\n').digest('hex');
}

/** A caller string as a SPARQL literal: percent-encoded, so always inside SAFE_LIT_RE. */
const elit = (s) => `"${enc(s)}"`;
const blit = (s) => {
  if (!SAFE_LIT_RE.test(s)) fail('internal: unsafe literal');
  return `"${s}"`;
};

function compileLg(c, digest) {
  const g = c.lg;
  const OP = ref(c.opId);
  const SCOPE = ref(lgMint.scope(g.scope));
  const THR = ref(lgMint.thread(g.scope, g.thread));
  const where = [];
  const pre = [];
  const xs = [];
  const dBinds = [];
  const del = [];
  const ins = [];
  const D = (name, expr) => { dBinds.push(ok(expr, name)); return `?d_${name}`; };
  const T = (list, s, p, o) => list.push(`  ${s} ${p} ${o} .`);

  where.push(...dupGuard(OP));
  D('op', OP);

  // precondition: the thread generation the caller read (deleteThread bumps it). This is the
  // write FENCE against deleteThread: it sits in the same WHERE as the write, so the executor
  // evaluates it atomically with it, and every domain triple is gated on ?ok — an lg.* write
  // that lands after the generation moved is PRECONDITION_FAILED and writes nothing
  // (tests/langgraph-saver-fences.test.mjs).
  //
  // The generation a caller reads is the CURRENT one, so it cannot fence an OLD run that reads
  // it after the delete. That run's config still names its old checkpoint id, and deleteThread
  // tombstones every checkpoint it removes (<cp> lg:deletedInGen g). So, also in this WHERE:
  // a put whose PARENT, or a putWrites whose CHECKPOINT, is tombstoned and not live again is
  // refused (PRECONDITION_FAILED). A checkpoint that is neither live nor tombstoned is still
  // accepted for putWrites: that is writes-before-put (async durability).
  const tomb = (X) => `    FILTER NOT EXISTS { ${X} ${LG.deletedInGen} ?x_tg_any . FILTER NOT EXISTS { ${X} ${LG.inThread} ${THR} } }`;
  if (g.gen === '0') pre.push(`    FILTER NOT EXISTS { ${THR} ${LG.gen} ?x_anyGen }`);
  else pre.push(`    ${THR} ${LG.gen} ?x_g .`, `    FILTER(?x_g = ${g.gen})`);

  const common = () => ({ thr: D('thr', THR), scope: D('scope', SCOPE), tid: D('tid', elit(g.thread)) });

  if (c.kind === 'lg.deleteThread') {
    pre.push(`    OPTIONAL { ?x_n ${LG.inThread} ${THR} . ?x_n ?x_p ?x_o }`);
    T(del, D('n', '?x_n'), D('p', '?x_p'), D('o', '?x_o'));
    // tombstone every checkpoint removed here with the generation it belonged to
    xs.push(`  BIND(IF(EXISTS { ?x_n a ${LG.Checkpoint} }, ?x_n, ?u) AS ?x_tc)`);
    T(ins, D('tc', '?x_tc'), LG.deletedInGen, D('tg', g.gen));
    const thr = D('thr', THR);
    if (g.gen !== '0') T(del, thr, LG.gen, D('og', '?x_g'));
    T(ins, thr, LG.gen, D('ng', String(Number(g.gen) + 1)));
  } else if (c.kind === 'lg.reap') {
    // after a put was refused because its parent is tombstoned: that put's checkpoint can never be
    // stored, so tombstone it too (a later putWrites for it is then refused) and remove any of its
    // writes that were accepted as writes-before-put in the meantime
    const C = ref(lgMint.cp(g.scope, g.thread, g.ns, g.cid));
    const P = ref(lgMint.cp(g.scope, g.thread, g.ns, g.parentCid));
    pre.push(`    ${P} ${LG.deletedInGen} ?x_ptg .`, `    FILTER NOT EXISTS { ${P} ${LG.inThread} ${THR} }`, `    FILTER NOT EXISTS { ${C} ${LG.inThread} ${THR} }`);
    pre.push(`    OPTIONAL { ?x_w ${LG.checkpoint} ${C} . ?x_w ${LG.inThread} ${THR} . ?x_w ?x_wp ?x_wo }`);
    T(del, D('w', '?x_w'), D('wp', '?x_wp'), D('wo', '?x_wo'));
    T(ins, D('c', C), LG.deletedInGen, D('ptg', '?x_ptg'));
  } else if (c.kind === 'lg.runTransition') {
    const C = ref(lgMint.cp(g.scope, g.thread, g.ns, g.cid));
    pre.push(`    ${C} ${LG.branch} ?x_b .`, `    ?x_b ${LG.headId} ${elit(g.cid)} .`, `    ?x_b ${LG.status} ?x_st .`,
      `    FILTER(?x_st = ${LG.running} || ?x_st = ${LG.resumed})`);
    const b = D('b', '?x_b');
    T(del, b, LG.status, D('ost', '?x_st'));
    T(ins, b, LG.status, D('to', LG[g.to]));
  } else if (c.kind === 'lg.put') {
    const C = ref(lgMint.cp(g.scope, g.thread, g.ns, g.cid));
    const CID = elit(g.cid);
    const NEWB = ref(lgMint.branch(g.scope, g.thread, g.ns, g.cid));
    // branch: extend the parent's branch only if the parent is that branch's head; otherwise this is a fork
    if (g.parentCid != null) {
      const P = ref(lgMint.cp(g.scope, g.thread, g.ns, g.parentCid));
      pre.push(tomb(P)); // an OLD run's config: its parent was removed by deleteThread
      xs.push(`  OPTIONAL { ${P} ${LG.branch} ?x_pb . ?x_pb ${LG.headId} ?x_pbh }`);
      xs.push(`  BIND(IF(COALESCE(?x_pbh = ${elit(g.parentCid)}, false), ?x_pb, ${NEWB}) AS ?x_b)`);
    } else xs.push(`  BIND(${NEWB} AS ?x_b)`);
    xs.push(`  BIND(?x_b = ${NEWB} AS ?x_isNew)`);
    for (const [p, v] of [['status', 'st'], ['head', 'oh'], ['headId', 'ohid'], ['asOfStep', 'oas'], ['incarnation', 'oinc'], ['waitingAt', 'owat'], ['waitingOn', 'owon']]) {
      xs.push(`  OPTIONAL { ?x_b ${LG[p]} ?x_${v} }`);
    }
    // interrupt writes that reached the store BEFORE this put (async durability)
    xs.push(`  OPTIONAL { SELECT (COUNT(?x_iw) AS ?x_ic) (MIN(?x_ia0) AS ?x_ia) WHERE { ?x_iw ${LG.checkpoint} ${C} . ?x_iw ${LG.idx} -3 . OPTIONAL { ?x_iw ${LG.assignee} ?x_ia0 } } }`);
    // transition table (v0.2 #1): a put NEVER clears WAITING; done/failed are terminal for an
    // incarnation, so a put that extends a finished branch opens the next incarnation
    xs.push(`  BIND(COALESCE(?x_st = ${LG.waiting}, false) AS ?x_ww)`);
    xs.push(`  BIND(COALESCE(?x_st = ${LG.done} || ?x_st = ${LG.failed}, false) AS ?x_wt)`);
    xs.push(`  BIND(COALESCE(?x_ic > 0, false) AS ?x_ci)`);
    xs.push(`  BIND(IF(?x_ww, ${LG.waiting}, IF(?x_ci, ${LG.waiting}, ${LG.running})) AS ?x_nst)`);
    xs.push(`  BIND(IF(?x_isNew || ?x_wt, COALESCE(?x_oinc + 1, 1), ?x_oinc) AS ?x_ninc)`);
    xs.push(`  BIND(IF(?x_ww, ?x_owat, IF(?x_ci, ${CID}, ?u)) AS ?x_nwat)`);
    xs.push(`  BIND(IF(?x_ww, ?x_owon, IF(?x_ci, ?x_ia, ?u)) AS ?x_nwon)`);
    for (let k = 0; k < g.blobs.length; k++) {
      const B = ref(lgMint.blob(g.scope, g.thread, g.ns, g.blobs[k].channel, g.blobs[k].version));
      xs.push(`  BIND(IF(EXISTS { ${B} ${LG.blobType} ?x_z${k} }, ?u, ${B}) AS ?x_bl${k})`);
    }

    const { thr, scope, tid } = common();
    const nsl = D('ns', elit(g.ns));
    const cp = D('c', C);
    const cid = D('cid', CID);
    const b = D('b', '?x_b');
    const step = g.step != null ? D('step', g.step) : null;
    // checkpoint node
    T(ins, cp, 'a', D('Checkpoint', LG.Checkpoint));
    T(ins, cp, LG.inScope, scope); T(ins, cp, LG.inThread, thr); T(ins, cp, LG.thread, tid); T(ins, cp, LG.ns, nsl);
    T(ins, cp, LG.checkpointId, cid);
    if (g.parentCid != null) {
      T(ins, cp, LG.parentId, D('pcid', elit(g.parentCid)));
      T(ins, cp, LG.parent, D('par', ref(lgMint.cp(g.scope, g.thread, g.ns, g.parentCid))));
    }
    if (step) T(ins, cp, LG.step, step);
    T(ins, cp, LG.payloadType, D('pt', elit(g.payloadType)));
    T(ins, cp, LG.payload, D('pv', blit(g.payload)));
    T(ins, cp, LG.metaType, D('mt', elit(g.metaType)));
    T(ins, cp, LG.metadata, D('mv', blit(g.metadata)));
    T(ins, cp, LG.branch, b);
    g.meta.forEach((m, k) => T(ins, cp, lgMetaPredicate(m.key), D(`m${k}`, blit(m.value))));
    g.channelVersions.forEach((v, k) => T(ins, cp, LG.usesBlob, D(`ub${k}`, ref(lgMint.blob(g.scope, g.thread, g.ns, v.channel, v.version)))));
    // blobs: insert-if-absent (a channel+version is immutable once written)
    g.blobs.forEach((bl, k) => {
      const n = D(`bl${k}`, `?x_bl${k}`);
      T(ins, n, 'a', D(`Blob${k}`, LG.Blob)); T(ins, n, LG.inScope, scope); T(ins, n, LG.inThread, thr);
      T(ins, n, LG.channel, D(`blch${k}`, elit(bl.channel))); T(ins, n, LG.version, D(`blv${k}`, elit(bl.version)));
      T(ins, n, LG.blobType, D(`blt${k}`, elit(bl.type))); T(ins, n, LG.blobValue, D(`blval${k}`, blit(bl.value)));
    });
    // branch (process) node
    const nst = D('nst', '?x_nst'); const ninc = D('ninc', '?x_ninc'); const nwat = D('nwat', '?x_nwat'); const nwon = D('nwon', '?x_nwon');
    T(del, b, LG.status, D('ost', '?x_st')); T(del, b, LG.head, D('oh', '?x_oh')); T(del, b, LG.headId, D('ohid', '?x_ohid'));
    T(del, b, LG.asOfStep, D('oas', '?x_oas')); T(del, b, LG.incarnation, D('oinc', '?x_oinc'));
    T(del, b, LG.waitingAt, D('owat', '?x_owat')); T(del, b, LG.waitingOn, D('owon', '?x_owon'));
    T(ins, b, 'a', D('Branch', LG.Branch)); T(ins, b, LG.inScope, scope); T(ins, b, LG.inThread, thr); T(ins, b, LG.thread, tid); T(ins, b, LG.ns, nsl);
    T(ins, b, LG.status, nst); T(ins, b, LG.head, cp); T(ins, b, LG.headId, cid); if (step) T(ins, b, LG.asOfStep, step);
    T(ins, b, LG.incarnation, ninc); T(ins, b, LG.waitingAt, nwat); T(ins, b, LG.waitingOn, nwon);
  } else if (c.kind === 'lg.putWrites') {
    const C = ref(lgMint.cp(g.scope, g.thread, g.ns, g.cid));
    const CID = elit(g.cid);
    const allSpecial = g.writes.every((w) => w.idx.startsWith('-'));
    const hasInt = g.writes.some((w) => w.channel === '__interrupt__');
    const hasRes = g.writes.some((w) => w.channel === '__resume__');
    const hasErr = g.writes.some((w) => w.channel === '__error__');
    pre.push(tomb(C)); // an OLD run's config: its checkpoint was removed by deleteThread
    const { thr, scope, tid } = common();
    const nsl = D('ns', elit(g.ns));
    const cp = D('c', C);
    const cid = D('cid', CID);
    const task = D('task', elit(g.taskId));
    g.writes.forEach((w, k) => {
      const W = ref(lgMint.write(g.scope, g.thread, g.ns, g.cid, g.taskId, w.idx));
      let n;
      if (allSpecial) {
        // replace: the (task, idx) node's mutable fields are deleted and re-inserted
        n = D(`w${k}`, W);
        for (const [p, v] of [['valueType', 'ovt'], ['value', 'ovv'], ['assignee', 'oas'], ['resumer', 'ors']]) {
          xs.push(`  OPTIONAL { ${W} ${LG[p]} ?x_${v}${k} }`);
          T(del, n, LG[p], D(`${v}${k}`, `?x_${v}${k}`));
        }
      } else {
        // insert-if-absent
        xs.push(`  BIND(IF(EXISTS { ${W} ${LG.idx} ?x_z${k} }, ?u, ${W}) AS ?x_w${k})`);
        n = D(`w${k}`, `?x_w${k}`);
      }
      T(ins, n, 'a', D(`Write${k}`, LG.Write)); T(ins, n, LG.inScope, scope); T(ins, n, LG.inThread, thr);
      T(ins, n, LG.thread, tid); T(ins, n, LG.ns, nsl);
      T(ins, n, LG.checkpoint, cp); T(ins, n, LG.checkpointId, cid); T(ins, n, LG.taskId, task);
      T(ins, n, LG.idx, D(`idx${k}`, w.idx)); T(ins, n, LG.channel, D(`ch${k}`, elit(w.channel)));
      T(ins, n, LG.valueType, D(`vt${k}`, elit(w.type))); T(ins, n, LG.value, D(`v${k}`, blit(w.value)));
      if (w.assignee != null && w.channel === '__interrupt__') T(ins, n, LG.assignee, D(`asg${k}`, elit(w.assignee)));
      if (g.resumer != null && w.channel === '__resume__') T(ins, n, LG.resumer, D(`rsm${k}`, elit(g.resumer)));
    });
    if (hasInt || hasRes || hasErr) {
      // the checkpoint's branch, if the checkpoint is already stored (writes may precede put)
      xs.push(`  OPTIONAL { ${C} ${LG.branch} ?x_b . ?x_b ${LG.status} ?x_st . ?x_b ${LG.headId} ?x_hid . OPTIONAL { ?x_b ${LG.waitingAt} ?x_wat } OPTIONAL { ?x_b ${LG.waitingOn} ?x_won } OPTIONAL { ?x_b ${LG.resumedBy} ?x_orb } }`);
      const b = D('b', '?x_b');
      if (hasInt) {
        // an interrupt at the branch head → WAITING, on the DECLARED assignee only
        const asg = g.writes.filter((w) => w.channel === '__interrupt__' && w.assignee != null).map((w) => w.assignee).sort()[0];
        xs.push(`  BIND(COALESCE(?x_hid = ${CID} && !(?x_st = ${LG.done} || ?x_st = ${LG.failed}), false) AS ?x_fire)`);
        xs.push(`  BIND(IF(?x_fire, ${LG.waiting}, ?x_st) AS ?x_nst)`);
        xs.push(`  BIND(IF(?x_fire, ${CID}, ?x_wat) AS ?x_nwat)`);
        xs.push(`  BIND(IF(?x_fire, ${asg != null ? elit(asg) : '?u'}, ?x_won) AS ?x_nwon)`);
      } else if (hasRes) {
        // WAITING is cleared ONLY by an authorized resume at or after the interrupt's checkpoint
        const auth = g.resumer == null ? 'false' : `(!BOUND(?x_won) || ?x_won = ${elit(g.resumer)})`;
        xs.push(`  BIND(COALESCE(?x_st = ${LG.waiting} && ${CID} >= ?x_wat && ${auth}, false) AS ?x_fire)`);
        xs.push(`  BIND(IF(?x_fire, IF(?x_hid = ${CID}, ${LG.resumed}, ${LG.running}), ?x_st) AS ?x_nst)`);
        xs.push(`  BIND(IF(?x_fire, ?u, ?x_wat) AS ?x_nwat)`);
        xs.push(`  BIND(IF(?x_fire, ?u, ?x_won) AS ?x_nwon)`);
        xs.push(`  BIND(IF(?x_fire, ${g.resumer != null ? elit(g.resumer) : '?u'}, ?x_orb) AS ?x_nrb)`);
        T(del, b, LG.resumedBy, D('orb', '?x_orb'));
        T(ins, b, LG.resumedBy, D('nrb', '?x_nrb'));
      }
      if (hasInt || hasRes) {
        T(del, b, LG.status, D('ost', '?x_st')); T(del, b, LG.waitingAt, D('owat', '?x_wat')); T(del, b, LG.waitingOn, D('owon', '?x_won'));
        T(ins, b, LG.status, D('nst', '?x_nst')); T(ins, b, LG.waitingAt, D('nwat', '?x_nwat')); T(ins, b, LG.waitingOn, D('nwon', '?x_nwon'));
      }
      if (hasErr) {
        xs.push(`  BIND(IF(COALESCE(?x_hid = ${CID}, false), ${CID}, ?u) AS ?x_err)`);
        T(ins, b, LG.lastErrorAt, D('err', '?x_err'));
      }
    }
  }

  pre.push(`    BIND(true AS ?ok)`);
  where.push(`  OPTIONAL {`, ...pre, `  }`);
  where.push(...xs);
  where.push(`  BIND(IF(BOUND(?ok), ${EX.APPLIED}, ${EX.PRECONDITION_FAILED}) AS ?n_outcome)`);
  where.push(nb(JSON.stringify(digest), 'digest'), nb(ref(c.actor), 'actor'), nb('NOW()', 'at'));
  where.push(...dBinds);

  // #1638 — the lg.* triples are all DOMAIN (urn:ex:lg/…, default graph); the marker and the receipt are the only bookkeeping
  const bDel = [`  ${MARKER_SUBJECT} ${EX.commitSeq} ?s .`];
  const rec = [`  ${MARKER_SUBJECT} ${EX.commitSeq} ?s1 .`,
    `  ${OP} ${EX.outcome} ?n_outcome .`, `  ${OP} ${EX.digest} ?n_digest .`, `  ${OP} ${EX.actor} ?n_actor .`,
    `  ${OP} ${EX.at} ?n_at .`, `  ${OP} ${EX.commitSeq} ?s1 .`];
  const sparql = assemble(del, bDel, ins, rec, where);
  const check = staticCheck(sparql, c.opId);
  if (!check.ok) fail(`compiler rejected its own output: ${check.errors.join('; ')}`);
  return { sparql, digest, canonical: c };
}

// =====================================================================================
// #1629 slice 1 — THE POSTSEQ.RESERVE PRIMITIVE: one compiler-owned guarded executor update that reserves
// N consecutive numbers for an ordered batch of derived postIds (ordinary + announcement modes share the allocator).
//
//   Compile path:  the same three-category discipline as every other kind, the unchanged staticCheck, no raw-update API.
//   One request:  DELETE/INSERT/WHERE. Duplicate guard (op-receipt), commit-marker bump, receipt binding.
//
//   ALLOCATOR precondition (read INSIDE WHERE, ok-guarded, single typed tuple):
//     exactly one <urn:ex:postseq/allocator> typed <urn:ex:postseq/Allocator>, with one epoch (a non-empty string),
//     one positive safe-integer nextPostSeq, one positive safe-integer version — all required, all duplicated -> ?ok
//     stays unbound and the request is PRECONDITION_FAILED with nothing written.
//
//   IDENTITY-ABSENCE precondition: each derived postId <urn:ex:postseq/reservation/postId> has no triples in either
//   graph (an existing reservation OR a stray reference). A duplicate identity -> ?ok stays unbound.
//
//   ADVANCE: when every guard holds, ?ok binds, every per-item `?d_postSeq_k = ?d_next + k` is ?d_guarded (no MAX-safe
//   overflow allowed: both the next and the postSeq+N are checked against MAX_SAFE_INTEGER, refuses otherwise), the
//   nextPostSeq and version are advanced atomically (nextPostSeq += N, version += 1), and N reservation nodes (in
//   frozen item order, one executor-side NOW() per batch) are inserted into the bookkeeping graph.
//
//   RECEIPT: only on APPLIED (?n_outcome), bound by the same ok-guard, exactly as for every other kind.
//
// Replay of the same opId lands APPLIED via the stored receipt (no allocation; nothing changes). A changed draft for
// the same identities has the same opId, a different digest, and is REJECTED/intent-collision at the receipt step
// (DS1). A bad allocator (no tuple / two tuples / non-integer nextPostSeq / nextPostSeq == 0 / decimal typed / advance
// past MAX / a fresh identity that already exists) is PRECONDITION_FAILED and NOTHING is written (A2).

const POSTSEQ_OP_PREFIX = POSTSEQ_TERMS.OP_PREFIX;
const PERSON_IRI_PSQ = 'https://scrumboard.local/person/';
const XSD_PSQ = 'http://www.w3.org/2001/XMLSchema#';

const psqLit = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const psqInt = (n) => `"${n}"^^<${XSD_PSQ}integer>`;

const psqSafeInt = (n) => (Number.isSafeInteger(n) ? String(n) : fail(`unsafe integer: ${n}`));
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * #1629 s3 G-R — a post.create whose postId names a slice-1 reservation must be the post that reservation froze. Decided
 * INSIDE the post's own update (the pure compiler cannot know whether the executor holds a reservation): when nothing
 * reserves this postId the clause is vacuous; when ANYTHING does — any triple at the canonical reservation IRI, in either
 * graph, or any subject claiming this postId in the bookkeeping graph — the reservation must be well-formed and match, or the update refuses.
 * Well-formed and matching: typed Reservation, mode "announcement", exactly one postId (this one), exactly one integer
 * postSeq equal to the post's, exactly one identityJson naming this mutation and slot, exactly one draftJson equal to this
 * post's canonical announcement draft, nothing at the reservation IRI in the default graph, and no other subject claiming
 * the postId. A post.create carries no `notify`, so the draft is matched under both notify values: every CONTENT field is
 * bound, and notify (which governs dispatch, not the post) is not on the post to compare.
 */
function reservedPostGuard(P) {
  const id = P.iri.slice(ENTITY_IRI.length);
  const seatOf = (iri) => iri.slice(PERSON_IRI.length);
  const R = POSTSEQ_TERMS.reservation(id), PT = POSTSEQ_TERMS;
  const pid = strLit(id);
  const draft = (notify) => strLit(JSON.stringify(canonAnnouncementDraft({ body: P.body, author: seatOf(P.author), originActor: seatOf(P.originActor), occurredAt: P.occurredAt, mentions: P.mentions, notify })));
  const ident = strLit(JSON.stringify({ mutationId: P.mutationId, slot: P.slot }));
  const claims = (s, o) => `${s} ${PT.postId} ${o} . FILTER(isLiteral(${o}) && STR(${o}) = ${pid})`;
  // a CLAIM is read in the bookkeeping graph only: the static check refuses any read of a bookkeeping predicate (postId)
  // outside it, and no compiler path writes one there. The canonical IRI is checked in BOTH graphs (a variable predicate).
  const detected = `${inEither(`${R} ?xr_p ?xr_o`)} UNION { GRAPH ${BK} { ${claims('?xr_s', '?xr_v')} } }`;
  const fields = [['Reservation type', ref(CW.rdfType), '?xr_t'], ['mode', PT.mode, '?xr_m'], ['postId', PT.postId, '?xr_pi'],
    ['postSeq', PT.postSeq, '?xr_ps'], ['identityJson', PT.identityJson, '?xr_ij'], ['draftJson', PT.draftJson, '?xr_dj']];
  const wf = [
    `GRAPH ${BK} { ${fields.map(([, p, x]) => `${R} ${p} ${x} .`).join(' ')} }`,
    `FILTER(sameTerm(?xr_t, ${PT.Reservation}))`,
    `FILTER(sameTerm(?xr_m, ${strLit('announcement')}))`,
    `FILTER(sameTerm(?xr_pi, ${pid}))`,
    `FILTER(isLiteral(?xr_ps) && DATATYPE(?xr_ps) = <${XSD_PSQ}integer> && ?xr_ps = ${psqSafeInt(P.postSeq)})`,
    `FILTER(sameTerm(?xr_ij, ${ident}))`,
    `FILTER(sameTerm(?xr_dj, ${draft(true)}) || sameTerm(?xr_dj, ${draft(false)}))`,
    ...fields.map(([, p, x], k) => `FILTER NOT EXISTS { GRAPH ${BK} { ${R} ${p} ?xr_d${k} FILTER(!sameTerm(?xr_d${k}, ${x})) } }`),
    `FILTER NOT EXISTS { ${R} ?xr_dp ?xr_do }`,
    `FILTER NOT EXISTS { GRAPH ${BK} { ${claims('?xr_s2', '?xr_v2')} FILTER(!sameTerm(?xr_s2, ${R})) } }`,
  ];
  return [`    FILTER(NOT EXISTS { ${detected} } || EXISTS { ${wf.join(' ')} })`];
}

function canonicalizePostseqReserve(i) {
  for (const k of Object.keys(i)) if (!['kind', 'opId', 'actor', 'reservations'].includes(k)) fail(`unknown field ${k} for kind ${i.kind}`);
  if (!Array.isArray(i.reservations) || i.reservations.length === 0) fail('reservations must be a non-empty array');
  const actor = checkIri(i.actor, 'actor');
  const opId = checkIri(i.opId, 'opId');
  if (!opId.startsWith(POSTSEQ_OP_PREFIX)) fail(`opId must start with ${POSTSEQ_OP_PREFIX}`);
  const items = _canonReservationBatch(i.reservations, 'reservations');
  const want = _reserveOpId(items);
  if (opId !== want) fail(`opId ${opId} does not equal reserveOpId(reservations) ${want} (a closed schema picks the opId from the identities; a different opId is refused)`);
  return { kind: i.kind, opId, actor, evidence: [], targets: [], newAssertion: null, authority: null, grant: null, rule: null, postseq: { items } };
}

function digestPostseq(c) {
  const lines = [`digestV ${DIGEST_V}`, `canonV ${CANON_V}`, `kind ${c.kind}`, `opId ${ref(c.opId)}`, `actor ${ref(c.actor)}`,
    `postseq ${JSON.stringify(_reserveDigestBody(c.postseq.items))}`];
  return createHash('sha256').update(lines.join('\n') + '\n').digest('hex');
}

/**
 * #1629 slice 2 — the slice-1 ALLOCATION clauses, extracted unchanged so an origin commit composes the SAME allocator guard,
 * advance and reservation nodes inside its own update (r3 §4: compilePostseqReserve stays byte-identical). `t` prefixes every
 * variable this adds; slice 1 passes "" and compiles exactly the text it always did.
 */
function allocationClauses({ items, N, OP, digest, v, pre, dBinds, bDel, bIns, t = '' }) {
  const ALLOC = POSTSEQ_TERMS.allocator;
  pre.push(`    GRAPH ${[BK]} { ${ALLOC} a ${POSTSEQ_TERMS.Allocator} ; ${POSTSEQ_TERMS.postSeqEpoch} ?${t}x_epoch ; ${POSTSEQ_TERMS.nextPostSeq} ?${t}x_next ; ${POSTSEQ_TERMS.version} ?${t}x_version . }`);
  // the epoch is a non-empty PLAIN string literal: an IRI, a language-tagged literal or a typed value refuses.
  pre.push(`    FILTER(isLiteral(?${t}x_epoch) && DATATYPE(?${t}x_epoch) = <${XSD_PSQ}string> && LANG(?${t}x_epoch) = "" && STR(?${t}x_epoch) != "")`);
  // overflow guards (P2): the advance of NEXT and VERSION are EACH independently checked against MAX_SAFE_INTEGER,
  // refuses otherwise. The postSeq allocations per-item are intrinsically bounded (next + k <= next + N).
  pre.push(`    FILTER(?${t}x_next + ${psqSafeInt(N)} <= ${psqInt(MAX_SAFE.toString())})`);
  pre.push(`    FILTER(?${t}x_version + 1 <= ${psqInt(MAX_SAFE.toString())})`);
  pre.push(`    FILTER(?${t}x_version + 1 > 0)`);
  // datatype / sign / single-tuple checks INSIDE the OPTIONAL { all preconditions } so a failure leaves ?ok unbound
  // (and the receipt still records PRECONDITION_FAILED) instead of dropping the whole WHERE solution.
  pre.push(`    FILTER(DATATYPE(?${t}x_next) = <${XSD_PSQ}integer> && DATATYPE(?${t}x_version) = <${XSD_PSQ}integer>)`);
  pre.push(`    FILTER(?${t}x_next > 0 && ?${t}x_version > 0)`);
  // exactly one allocator SUBJECT: any other node typed Allocator in the bookkeeping graph refuses the whole batch.
  pre.push(`    FILTER NOT EXISTS { GRAPH ${[BK]} { ?${t}x_alloc2 a ${POSTSEQ_TERMS.Allocator} FILTER(?${t}x_alloc2 != ${ALLOC}) } }`);
  // exactly one nextPostSeq / version / postSeqEpoch value on the allocator subject — TERM identity (sameTerm), not
  // value inequality, so a different numeric datatype with the same lexical value cannot evade the duplicate check.
  pre.push(`    FILTER NOT EXISTS { GRAPH ${[BK]} { ${ALLOC} ${POSTSEQ_TERMS.nextPostSeq} ?${t}xn2 FILTER(!sameTerm(?${t}xn2, ?${t}x_next)) } }`);
  pre.push(`    FILTER NOT EXISTS { GRAPH ${[BK]} { ${ALLOC} ${POSTSEQ_TERMS.version} ?${t}xv2 FILTER(!sameTerm(?${t}xv2, ?${t}x_version)) } }`);
  pre.push(`    FILTER NOT EXISTS { GRAPH ${[BK]} { ${ALLOC} ${POSTSEQ_TERMS.postSeqEpoch} ?${t}xe2 FILTER(!sameTerm(?${t}xe2, ?${t}x_epoch)) } }`);
  items.forEach((it, k) => {
    const SUBJ = POSTSEQ_TERMS.reservation(it.postId);
    pre.push(`    FILTER NOT EXISTS { ${inEither(`${SUBJ} ?${t}xp ?${t}xo`)} }`);
  });
  // #1749 the RECOVERY HOLD: while a promoted restore is unreconciled, the allocator does not bind (both paths share this),
  // and the receipt names the refusal by code. A hold present means ?ok is unbound, so the code is only ever on a refusal.
  const HOLD_HERE = `GRAPH ${POSTSEQ_TERMS.RECOVERY_GRAPH} { ${POSTSEQ_TERMS.recoveryHold} ?${t}xh_p ?${t}xh_o }`;
  pre.push(`    FILTER NOT EXISTS { ${HOLD_HERE} }`);
  dBinds.push(nb(`IF(EXISTS { ${HOLD_HERE} }, ${JSON.stringify(POSTSEQ_TERMS.RECOVERY_HOLD_CODE)}, ?u)`, 'reason'));
  bIns.push(`  ${OP} ${EX.reason} ?n_reason .`);

  dBinds.push(ok(`?${t}x_next`, `${t}next`), ok(`?${t}x_version`, `${t}verOld`), ok(`?${t}x_version + 1`, `${t}verNew`));
  dBinds.push(ok(`?${t}x_next + ${psqSafeInt(N)}`, `${t}nextNew`));
  items.forEach((it, k) => {
    dBinds.push(ok(`?${t}x_next + ${psqSafeInt(k)}`, `${t}ps${k}`));
  });

  bDel.push(`  ${v(ALLOC)} ${POSTSEQ_TERMS.nextPostSeq} ?d_${t}next .`,
            `  ${v(ALLOC)} ${POSTSEQ_TERMS.version} ?d_${t}verOld .`);
  bIns.push(`  ${v(ALLOC)} ${POSTSEQ_TERMS.nextPostSeq} ?d_${t}nextNew .`,
            `  ${v(ALLOC)} ${POSTSEQ_TERMS.version} ?d_${t}verNew .`);

  items.forEach((it, k) => {
    const SUBJ = POSTSEQ_TERMS.reservation(it.postId);
    const ident = it.mode === 'ordinary'
      ? JSON.stringify({ author: it.author, requestId: it.requestId })
      : JSON.stringify({ mutationId: it.mutationId, slot: it.slot });
    const draftJson = JSON.stringify(it.draft);
    bIns.push(
      `  ${v(SUBJ)} a ${v(POSTSEQ_TERMS.Reservation)} .`,
      `  ${v(SUBJ)} ${POSTSEQ_TERMS.mode} ${v(psqLit(it.mode))} .`,
      `  ${v(SUBJ)} ${POSTSEQ_TERMS.postId} ${v(psqLit(it.postId))} .`,
      `  ${v(SUBJ)} ${POSTSEQ_TERMS.reserveOpId} ${v(OP)} .`,
      `  ${v(SUBJ)} ${POSTSEQ_TERMS.reserveDigest} ${v(psqLit(digest))} .`,
      `  ${v(SUBJ)} ${POSTSEQ_TERMS.postSeqEpoch} ${v(`?${t}x_epoch`)} .`,
      `  ${v(SUBJ)} ${POSTSEQ_TERMS.postSeq} ?d_${t}ps${k} .`,
      `  ${v(SUBJ)} ${POSTSEQ_TERMS.createdAt} ${v('?n_at')} .`,
      `  ${v(SUBJ)} ${POSTSEQ_TERMS.index} ${v(psqSafeInt(k))} .`,
      `  ${v(SUBJ)} ${POSTSEQ_TERMS.identityJson} ${v(psqLit(ident))} .`,
      `  ${v(SUBJ)} ${POSTSEQ_TERMS.draftJson} ${v(psqLit(draftJson))} .`,
    );
  });
}

/**
 * #1749 A8-2 THE DISPATCH HOLD, inside a dispatch intention's own update: it does not bind while (a) a RecoveryHold exists, for
 * ANY obligation, or (b) this obligation's AmbiguousObligation is "held" (both read from the recovery graph, never anywhere
 * else); the receipt names the refusal DISPATCH_HELD. A hold present means ?ok is unbound, so the code is only on a refusal.
 */
function dispatchHoldClauses({ obligationId, OP, pre, dBinds, bIns }) {
  const RG = POSTSEQ_TERMS.RECOVERY_GRAPH;
  const AO = POSTSEQ_TERMS.ambiguousObligation(createHash('sha256').update(String(obligationId), 'utf8').digest('hex'));
  const HOLD = `GRAPH ${RG} { ${POSTSEQ_TERMS.recoveryHold} ?xdh_p ?xdh_o }`;
  const AMBIG = `GRAPH ${RG} { ${AO} ${POSTSEQ_TERMS.state} ?xda_s FILTER(STR(?xda_s) = "held") }`;
  pre.push(`    FILTER NOT EXISTS { ${HOLD} }`, `    FILTER NOT EXISTS { ${AMBIG} }`);
  dBinds.push(nb(`IF(EXISTS { ${HOLD} } || EXISTS { ${AMBIG} }, ${JSON.stringify(POSTSEQ_TERMS.DISPATCH_HELD_CODE)}, ?u)`, 'reason'));
  bIns.push(`  ${OP} ${EX.reason} ?n_reason .`);
}

function compilePostseqReserve(c, digest) {
  const items = c.postseq.items;
  const N = items.length;
  const OP = ref(c.opId);
  const where = [], pre = [], top = [], dBinds = [], del = [], dIns = [], bDel = [], bIns = [];
  const names = new Map();
  const v = (text) => {
    let n = names.get(text);
    if (!n) { n = `r${names.size}`; names.set(text, n); dBinds.push(ok(text, n)); }
    return `?d_${n}`;
  };

  where.push(...dupGuard(OP));

  allocationClauses({ items, N, OP, digest, v, pre, dBinds, bDel, bIns });

  pre.push(`    BIND(true AS ?ok)`);
  where.push(`  OPTIONAL {`, ...pre, `  }`);
  where.push(...top);
  where.push(`  BIND(IF(BOUND(?ok), ${EX.APPLIED}, ${EX.PRECONDITION_FAILED}) AS ?n_outcome)`);
  where.push(nb(JSON.stringify(digest), 'digest'), nb(ref(c.actor), 'actor'), nb('NOW()', 'at'));
  where.push(...dBinds);

  bDel.unshift(`  ${MARKER_SUBJECT} ${EX.commitSeq} ?s .`);
  bIns.unshift(`  ${MARKER_SUBJECT} ${EX.commitSeq} ?s1 .`,
    `  ${OP} ${EX.outcome} ?n_outcome .`, `  ${OP} ${EX.digest} ?n_digest .`, `  ${OP} ${EX.actor} ?n_actor .`,
    `  ${OP} ${EX.at} ?n_at .`, `  ${OP} ${EX.commitSeq} ?s1 .`);
  const sparql = assemble(del, bDel, dIns, bIns, where);
  const check = staticCheck(sparql, c.opId);
  if (!check.ok) fail(`compiler rejected its own output: ${check.errors.join('; ')}`);
  return { sparql, digest, canonical: c };
}
// ---------- #1629 slice 3: obligation.settle — an announcement obligation's ONE terminal transition ----------
//
// Frozen settle interface (#1629 v162, commons 45064): { kind, opId 'urn:ex:op/obligation/settle/<obligationId>/<transition>',
// actor, obligationId '<mutationId>:<slot>', transition 'publish' | 'block', reason?, publication? }. Every identity the
// guard touches is DERIVED from obligationId (the obligation subject, the reservation, the deterministic postId and post op);
// nothing names them separately. Only the Obligation's status moves, and only from pending: a terminal status is never
// overwritten (a conflicting transition is PRECONDITION_FAILED; the same one replays through the duplicate-op guard).
//   publish  the caller's `publication` values are CANDIDATES: the compiler rebuilds the deterministic post.create from them
//            and its digest, and the update verifies every one against the executor — the reservation's draft (under either
//            notify, as in G-R), postSeq and createdAt (= publicationAt); the post op's receipt APPLIED with exactly that
//            digest and the author's person as actor; the post a live Comment. Dispatch comes before settlement (r3 C2):
//            this record is written only after the notify policy was dispatched.
//   block    reason in a closed set; 'tombstoned' is proved by the derived post IRI being a RedactedPost. No publication
//            candidate or post receipt is asked for.
// Both carry `origin` {descriptor, plan, occurredAt} (R1, and R1b for block): either terminal status is written only for an
// obligation bound to its committed origin, verified in the update against the stored Prepared, Origin and commit receipt.
// Every stored proof field is read single-valued and well-formed; malformed or unavailable proof never settles.
export const SETTLE_KIND = 'obligation.settle';
export const SETTLE_TRANSITIONS = Object.freeze(['publish', 'block']);
export const SETTLE_BLOCK_REASONS = Object.freeze(['tombstoned']);
export const settleOpId = (obligationId, transition) => `${NS}op/obligation/settle/${obligationId}/${transition}`;
const OBLIGATION_ID_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([a-z][a-z0-9-]{0,31})$/;

function canonicalizeSettle(i) {
  for (const k of Object.keys(i)) if (!['kind', 'opId', 'actor', 'obligationId', 'transition', 'reason', 'publication', 'origin'].includes(k)) fail(`unknown field ${k} for kind ${i.kind}`);
  const actor = checkIri(i.actor, 'actor');
  const m = typeof i.obligationId === 'string' ? OBLIGATION_ID_RE.exec(i.obligationId) : null;
  if (!m) fail('obligationId must be <mutationId>:<slot>');
  const [, mutationId, slot] = m;
  if (!SETTLE_TRANSITIONS.includes(i.transition)) fail(`transition must be one of ${SETTLE_TRANSITIONS.join(', ')}`);
  const opId = checkIri(i.opId, 'opId');
  if (opId !== settleOpId(i.obligationId, i.transition)) fail(`opId must be ${settleOpId(i.obligationId, i.transition)}`);
  // R1b (bbf3344 re-review) — BOTH terminal transitions carry the origin candidates: a terminal status is written only
  // for an obligation bound to its committed origin, so block proves that binding exactly as publish does
  if (i.origin === undefined) fail(`a ${i.transition} carries its origin candidates: {descriptor, plan, occurredAt}`);
  const og = obj(i.origin, ['descriptor', 'plan', 'occurredAt'], 'origin');
  if (typeof og.occurredAt !== 'string' || !og.occurredAt) fail('origin.occurredAt is the Prepared record\'s stored lexical time');
  const { descriptor } = canonOriginDescriptor(og.descriptor);
  if (descriptor.mutationId !== mutationId) fail('origin.descriptor names another mutation than obligationId');
  // the plan arrives in either of its two forms — the intention form origin.prepare took, or the STORED form a reader
  // parsed from planJson — and both reduce to the one canonical plan; the update then compares its bytes to planJson,
  // so a plan that is not the stored one refuses whichever way it came
  let plan;
  try { plan = canonOriginPlan(og.plan); } catch (e) { if (!(e instanceof ValidationError)) throw e; plan = admitStoredOriginPlan(descriptor, og.plan); }
  bindOriginPlan(descriptor, plan);
  const index = descriptor.slots.findIndex((x) => x.slot === slot);
  if (index < 0) fail('origin.descriptor has no slot for obligationId');
  const originProof = { descriptorJson: JSON.stringify(descriptor), planJson: JSON.stringify(plan), occurredAt: og.occurredAt,
    descriptorDigest: originDescriptorDigest(descriptor), planDigest: originPlanDigest(plan),
    commitOp: originCommitOp(mutationId), commitDigest: originCommitDigest(descriptor, plan, og.occurredAt), index, consistent: true };
  let reason = null, publication = null;
  if (i.transition === 'block') {
    if (!SETTLE_BLOCK_REASONS.includes(i.reason)) fail(`a block reason must be one of ${SETTLE_BLOCK_REASONS.join(', ')}`);
    if (i.publication !== undefined) fail('a block carries no publication');
    reason = i.reason;
  } else {
    if (i.reason !== undefined) fail('a publish carries no reason');
    const p = obj(i.publication, ['payload', 'postSeq', 'publicationAt'], 'publication');
    const pl = obj(p.payload, ['author', 'body', 'originActor', 'occurredAt', 'mentions', 'notify'], 'publication.payload');
    if (pl.notify !== undefined && typeof pl.notify !== 'boolean') fail('publication.payload.notify, when present, is a boolean');
    // the post the publisher would build from these values: built by the SAME function, canonicalized by the SAME rules
    const intent = announcePostCreateIntention({ mutationId, slot, postSeq: p.postSeq, publicationAt: p.publicationAt,
      payload: { author: pl.author, body: pl.body, originActor: pl.originActor, occurredAt: pl.occurredAt, mentions: pl.mentions } });
    const post = canonicalizeRecord(intent);
    publication = { postSeq: p.postSeq, publicationAt: p.publicationAt, author: pl.author, body: pl.body, originActor: pl.originActor,
      occurredAt: pl.occurredAt, mentions: [...pl.mentions], notify: pl.notify ?? null, postOp: post.opId, postActor: post.actor, postDigest: recordDigest(post) };
    // the payload must be this slot's frozen content: a mismatch is decided in the update (PRECONDITION_FAILED), not here
    const fs = descriptor.slots[index];
    originProof.consistent = pl.author === fs.author && pl.body === fs.body && pl.originActor === descriptor.originActor && pl.occurredAt === og.occurredAt
      && JSON.stringify([...pl.mentions].sort()) === JSON.stringify(fs.mentions) && (pl.notify === undefined || pl.notify === fs.notify);
  }
  return { kind: i.kind, opId, actor, evidence: [], targets: [], newAssertion: null, authority: null, grant: null, rule: null,
    settle: { obligationId: i.obligationId, mutationId, slot, transition: i.transition, reason, publication, origin: originProof } };
}

function digestSettle(c) {
  const lines = [`digestV ${DIGEST_V}`, `canonV ${CANON_V}`, `kind ${c.kind}`, `opId ${ref(c.opId)}`, `actor ${ref(c.actor)}`,
    `settle ${JSON.stringify(c.settle)}`];
  return createHash('sha256').update(lines.join('\n') + '\n').digest('hex');
}

function compileSettle(c, digest) {
  const S = c.settle, T = ORIGIN_TERMS, PT = POSTSEQ_TERMS;
  const OP = ref(c.opId);
  const OB = T.obligationSubject(S.mutationId, S.slot);
  const postId = announcePostId(S.mutationId, S.slot);
  const RES = PT.reservation(postId);
  const POST = ref(`${ENTITY_IRI}${postId}`);
  const where = [], pre = [], top = [], dBinds = [], del = [], dIns = [], bDel = [], bIns = [];
  const names = new Map();
  const v = (text) => {
    let n = names.get(text);
    if (!n) { n = `r${names.size}`; names.set(text, n); dBinds.push(ok(text, n)); }
    return `?d_${n}`;
  };
  where.push(...dupGuard(OP));
  /** `subject p ?x`, with ?x the ONLY value of p on subject, in the bookkeeping graph */
  const single = (subject, p, x) => [`    GRAPH ${BK} { ${subject} ${p} ${x} . }`,
    `    FILTER NOT EXISTS { GRAPH ${BK} { ${subject} ${p} ${x}_2 FILTER(!sameTerm(${x}_2, ${x})) } }`];
  // the obligation: typed, its stored identity equal to the derived one, single-valued, and PENDING
  pre.push(`    GRAPH ${BK} { ${OB} a ${T.Obligation} . }`);
  for (const [p, x, want] of [[T.obligationId, '?xs_oid', strLit(S.obligationId)], [T.mutationId, '?xs_mid', strLit(S.mutationId)],
    [T.slot, '?xs_slot', strLit(S.slot)], [T.reservation, '?xs_res', RES], [T.status, '?xs_st', strLit('pending')]]) {
    pre.push(...single(OB, p, x), `    FILTER(sameTerm(${x}, ${want}))`);
  }
  // R1 + R1b — BOTH transitions are bound to the COMMITTED origin: the Prepared record holds exactly the candidate
  // preparation, the Origin holds its digests and names the commit op, Prepared.committedBy and the reservation's
  // reserveOpId are that op, and the op's receipt is APPLIED with the commit digest RECONSTRUCTED from the frozen preparation
  const G = S.origin, PREP = T.preparedSubject(S.mutationId), ORIG = T.originSubject(S.mutationId), COP = ref(G.commitOp);
  pre.push(`    GRAPH ${BK} { ${PREP} a ${T.Prepared} . ${ORIG} a ${T.Origin} . }`);
  for (const [subj, p, x, want] of [
    [PREP, T.descriptorJson, '?xo_dj', strLit(G.descriptorJson)], [PREP, T.planJson, '?xo_pj', strLit(G.planJson)],
    [PREP, T.descriptorDigest, '?xo_dd', strLit(G.descriptorDigest)], [PREP, T.planDigest, '?xo_pd', strLit(G.planDigest)],
    [PREP, T.committedBy, '?xo_cb', COP],
    [ORIG, T.mutationId, '?xo_om', strLit(S.mutationId)], [ORIG, T.descriptorDigest, '?xo_odd', strLit(G.descriptorDigest)],
    [ORIG, T.planDigest, '?xo_opd', strLit(G.planDigest)], [ORIG, T.commitOp, '?xo_oc', COP],
    [RES, PT.reserveOpId, '?xo_ro', COP], [RES, PT.index, '?xo_ri', psqSafeInt(G.index)],
    [COP, EX.outcome, '?xo_co', EX.APPLIED], [COP, EX.digest, '?xo_cd', strLit(G.commitDigest)],
  ]) pre.push(...single(subj, p, x), `    FILTER(sameTerm(${x}, ${want}))`);
  pre.push(...single(PREP, T.occurredAt, '?xo_oa'), `    FILTER(isLiteral(?xo_oa) && DATATYPE(?xo_oa) = <${XSD_PSQ}dateTime> && STR(?xo_oa) = ${strLit(G.occurredAt)})`);
  if (S.transition === 'block') {
    pre.push(`    ${POST} ${ref(TM.type)} ${ref(TM.RedactedPost)} .`);   // reason 'tombstoned': the deterministic post is a tombstone
  } else {
    const P = S.publication;
    const draft = (notify) => strLit(JSON.stringify(canonAnnouncementDraft({ body: P.body, author: P.author, originActor: P.originActor, occurredAt: P.occurredAt, mentions: P.mentions, notify })));
    // the reservation the obligation names: its draft, postSeq and createdAt are the candidate's, each single-valued
    // notify given: the frozen draft must match EXACTLY; absent: under either value (as G-R, whose post carries no notify)
    const drafts = P.notify == null ? [draft(true), draft(false)] : [draft(P.notify)];
    pre.push(...single(RES, PT.draftJson, '?xs_dj'), `    FILTER(${drafts.map((d) => `sameTerm(?xs_dj, ${d})`).join(' || ')})`);
    pre.push(...single(RES, PT.identityJson, '?xs_ij'), `    FILTER(sameTerm(?xs_ij, ${strLit(JSON.stringify({ mutationId: S.mutationId, slot: S.slot }))}))`);
    pre.push(...single(RES, PT.postSeq, '?xs_ps'), `    FILTER(isLiteral(?xs_ps) && DATATYPE(?xs_ps) = <${XSD_PSQ}integer> && ?xs_ps = ${psqSafeInt(P.postSeq)})`);
    pre.push(...single(RES, PT.createdAt, '?xs_ca'), `    FILTER(isLiteral(?xs_ca) && DATATYPE(?xs_ca) = <${XSD_PSQ}dateTime> && STR(?xs_ca) = ${strLit(P.publicationAt)})`);
    // the post op's receipt: APPLIED, with exactly the rebuilt digest and the author's person as actor
    const POP = ref(P.postOp);
    pre.push(...single(POP, EX.outcome, '?xs_out'), `    FILTER(sameTerm(?xs_out, ${EX.APPLIED}))`);
    pre.push(...single(POP, EX.digest, '?xs_dg'), `    FILTER(sameTerm(?xs_dg, ${strLit(P.postDigest)}))`);   // R2: the exact plain-string term
    pre.push(...single(POP, EX.actor, '?xs_ac'), `    FILTER(sameTerm(?xs_ac, ${ref(P.postActor)}))`);
    pre.push(`    ${POST} ${ref(TM.type)} ${ref(TM.Comment)} .`, `    FILTER NOT EXISTS { ${POST} ${ref(TM.type)} ${ref(TM.RedactedPost)} }`);
    if (!S.origin.consistent) pre.push('    FILTER(false)');   // the payload is not this slot's frozen content
  }
  dispatchHoldClauses({ obligationId: S.obligationId, OP, pre, dBinds, bIns });   // #1749 A8: either transition settles a dispatch
  const next = S.transition === 'publish' ? 'published' : 'blocked';
  bDel.push(`  ${v(OB)} ${T.status} ${v(strLit('pending'))} .`);
  bIns.push(`  ${v(OB)} ${T.status} ${v(strLit(next))} .`);

  pre.push(`    BIND(true AS ?ok)`);
  where.push(`  OPTIONAL {`, ...pre, `  }`);
  where.push(...top);
  where.push(`  BIND(IF(BOUND(?ok), ${EX.APPLIED}, ${EX.PRECONDITION_FAILED}) AS ?n_outcome)`);
  where.push(nb(JSON.stringify(digest), 'digest'), nb(ref(c.actor), 'actor'), nb('NOW()', 'at'), nb(OB, 'target0'));
  where.push(...dBinds);
  bDel.unshift(`  ${MARKER_SUBJECT} ${EX.commitSeq} ?s .`);
  bIns.unshift(`  ${MARKER_SUBJECT} ${EX.commitSeq} ?s1 .`,
    `  ${OP} ${EX.outcome} ?n_outcome .`, `  ${OP} ${EX.digest} ?n_digest .`, `  ${OP} ${EX.actor} ?n_actor .`,
    `  ${OP} ${EX.at} ?n_at .`, `  ${OP} ${EX.commitSeq} ?s1 .`, `  ${OP} ${EX.target} ?n_target0 .`);
  const sparql = assemble(del, bDel, dIns, bIns, where);
  const check = staticCheck(sparql, c.opId);
  if (!check.ok) fail(`compiler rejected its own output: ${check.errors.join('; ')}`);
  return { sparql, digest, canonical: c };
}
