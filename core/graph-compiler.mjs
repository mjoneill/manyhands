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
import { EX, NS, RECEIPT_PREDICATES, MARKER_SUBJECT, MARKER_PREDICATES, LG, LG_NS, lgMetaPredicate } from './graph-vocab.mjs';

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
  if (RECORD_KINDS.includes(i.kind)) return canonicalizeRecord(i);   // #1561 — the log-born unit's kinds
  if (!KINDS.includes(i.kind)) fail(`kind must be one of ${[...KINDS, ...RECORD_KINDS, ...LG_KINDS].join(', ')}`);
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
const fresh = (iri) => [`    FILTER NOT EXISTS { ${iri} ?fp ?fo }`, `    FILTER NOT EXISTS { ?fs ?fp2 ${iri} }`];

/**
 * Compile a validated intention to ONE SPARQL update. Returns
 * { sparql, digest, canonical }. Throws ValidationError.
 */
export function compile(intention) {
  const c = canonicalize(intention);
  if (c.lg) return compileLg(c, digestOf(c)); // #1562: same template, same staticCheck
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

  // --- duplicate guard (top level) + marker ---
  where.push(`  OPTIONAL { ${OP} ${EX.digest} ?dup }`);
  where.push(`  FILTER(!BOUND(?dup))`);
  where.push(`  ${EX.dataset} ${EX.commitSeq} ?s .`);
  where.push(`  BIND(?s + 1 AS ?s1)`);

  dBinds.push(ok(OP, 'op'));
  c.evidence.forEach((e, k) => dBinds.push(ok(ref(e), `ev${k}`)));

  if (c.grant) {
    const G = c.grant;
    pre.push(...fresh(ref(G.iri)));
    dBinds.push(ok(ref(G.iri), 'g'), ok(EX.Grant, 'Grant'), ok(ref(G.grantee), 'grantee'), ok(ref(G.scope), 'scope'),
      ok(String(G.mayRetire), 'mayRetire'), ok('true', 'active'), ok(G.rev, 'rev'));
    dIns.push(`  ?d_g a ?d_Grant .`, `  ?d_g ${EX.grantee} ?d_grantee .`, `  ?d_g ${EX.scope} ?d_scope .`,
      `  ?d_g ${EX.mayRetire} ?d_mayRetire .`, `  ?d_g ${EX.active} ?d_active .`, `  ?d_g ${EX.rev} ?d_rev .`,
      `  ?d_g ${EX.recordedBy} ?d_op .`);
    c.evidence.forEach((_, k) => dIns.push(`  ?d_g ${EX.evidence} ?d_ev${k} .`));
  } else if (c.rule) {
    pre.push(...fresh(ref(c.rule.iri)));
    dBinds.push(ok(ref(c.rule.iri), 'r'), ok('1', 'one'));
    dIns.push(`  ?d_r ${EX.rev} ?d_one .`, `  ?d_r ${EX.recordedBy} ?d_op .`);
    c.evidence.forEach((_, k) => dIns.push(`  ?d_r ${EX.evidence} ?d_ev${k} .`));
  } else {
    const N = c.newAssertion;
    const T = c.targets;
    T.forEach((t, k) => {
      pre.push(`    ${ref(t.iri)} ${EX.ver} ?v${k} ; ${EX.status} ${EX.current} ; ${EX.scope} ${ref(N.scope)} ;`);
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
      `  ?d_new ${EX.status} ?d_current .`, `  ?d_new ${EX.ver} ?d_one .`, `  ?d_new ${EX.author} ?d_author .`,
      `  ?d_new ${EX.recordedBy} ?d_op .`);
    c.evidence.forEach((_, k) => dIns.push(`  ?d_new ${EX.evidence} ?d_ev${k} .`));
    T.forEach((_, k) => {
      dIns.push(`  ?d_new ${EX.supersedes} ?d_t${k} .`);
      del.push(`  ?d_t${k} ${EX.status} ?d_current .`);
      del.push(`  ?d_t${k} ${EX.ver} ?d_oldv${k} .`);
      dIns.push(`  ?d_t${k} ${EX.status} ?d_retired .`, `  ?d_t${k} ${EX.ver} ?d_nv${k} .`, `  ?d_t${k} ${EX.retiredBy} ?d_op .`);
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
  del.unshift(`  ${MARKER_SUBJECT} ${EX.commitSeq} ?s .`);
  ins.push(`  ${MARKER_SUBJECT} ${EX.commitSeq} ?s1 .`);
  ins.push(`  ${OP} ${EX.outcome} ?n_outcome .`, `  ${OP} ${EX.digest} ?n_digest .`, `  ${OP} ${EX.actor} ?n_actor .`,
    `  ${OP} ${EX.at} ?n_at .`, `  ${OP} ${EX.commitSeq} ?s1 .`);
  if (c.authority) {
    ins.push(`  ${OP} ${EX.grant} ?n_grant .`, `  ${OP} ${EX.grantRev} ?n_grantRev .`,
      `  ${OP} ${EX.rule} ?n_rule .`, `  ${OP} ${EX.ruleRev} ?n_ruleRev .`);
  }
  c.targets.forEach((_, k) => ins.push(`  ${OP} ${EX.target} ?n_target${k} .`));
  ins.push(...dIns);

  const sparql = `DELETE {\n${del.join('\n')}\n}\nINSERT {\n${ins.join('\n')}\n}\nWHERE {\n${where.join('\n')}\n}\n`;
  const check = staticCheck(sparql, c.opId);
  if (!check.ok) fail(`compiler rejected its own output: ${check.errors.join('; ')}`);
  return { sparql, digest, canonical: c };
}

// ---------- the static checker: categories from the TEXT, by its own rules ----------

const TRIPLE_RE = /^\s*(\S+) (\S+) (\S+) \.$/;

/**
 * Read a compiled update back and check every template triple carries its
 * category's guard. The category is derived from (subject, predicate) alone:
 *   RECEIPT  subject is the op IRI and predicate is a receipt predicate
 *   MARKER   subject is ex:dataset and predicate is a marker predicate
 *   DOMAIN   everything else
 */
export function staticCheck(sparql, opId) {
  const errors = [];
  const op = ref(opId);
  const block = (name) => {
    const m = new RegExp(`(?:^|\\n)${name} \\{\\n([\\s\\S]*?)\\n\\}`).exec(sparql);
    return m ? m[1].split('\n').filter((l) => l.trim()) : [];
  };
  const where = block('WHERE').join('\n');
  // every ?d_ variable must be defined only as IF(BOUND(?ok), x, ?u)
  const dDefs = {};
  for (const m of where.matchAll(/BIND\((.*) AS \?(d_\w+)\)/g)) dDefs[m[2]] = m[1];
  for (const [v, expr] of Object.entries(dDefs)) {
    if (!/^IF\(BOUND\(\?ok\), .+, \?u\)$/.test(expr)) errors.push(`?${v} is not ok-guarded`);
  }
  if ((where.match(/BIND\(true AS \?ok\)/g) || []).length !== 1) errors.push('?ok must be bound exactly once');
  if (!/^\s*OPTIONAL \{ <[^>]+> <urn:ex:digest> \?dup \}\n\s*FILTER\(!BOUND\(\?dup\)\)/.test(where)) errors.push('duplicate guard missing or not first');
  if (/;\s*(INSERT|DELETE)/i.test(sparql)) errors.push('multi-operation request');

  const triples = [];
  for (const [name, lines] of [['DELETE', block('DELETE')], ['INSERT', block('INSERT')]]) {
    for (const l of lines) {
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
      triples.push({ block: name, s, p, o, cat });
    }
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
export const RECORD_KINDS = Object.freeze(['memory.create', 'memory.revise', 'decision.create', 'decision.relate', 'seat.declare', 'seat.clear', 'person.import']);

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
};

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

function canonicalizeRecord(i) {
  const allowed = ['kind', 'opId', 'actor', 'evidence', 'people', ...RECORD_FIELDS[i.kind]];
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
  const ins = [];          // [subject IRI, predicate IRI, object TEXT]
  const delAll = [];       // [{s, p, keep?:[subject, predicate]}]: every current value is removed (and, with keep, recorded there)
  let verGuard = null;
  let target;
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
    pre.push(`    ${I(M)} ${I(TM.type)} ${I(TM.Memory)} ; ${I(TM.ver)} ?xv .`, `    FILTER(?xv = ${R.target.expectedVersion})`);
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
  return { target, pre, fresh, ins, delAll, verGuard };
}

function compileRecord(c) {
  const digest = recordDigest(c);
  const OP = ref(c.opId);
  const plan = planRecord(c);
  const where = [];
  const pre = [...plan.pre];
  const top = [];
  const dBinds = [];
  const del = [];
  const dIns = [];
  const names = new Map();
  const v = (text) => {
    let n = names.get(text);
    if (!n) { n = `r${names.size}`; names.set(text, n); dBinds.push(ok(text, n)); }
    return `?d_${n}`;
  };

  where.push(`  OPTIONAL { ${OP} ${EX.digest} ?dup }`);
  where.push(`  FILTER(!BOUND(?dup))`);
  where.push(`  ${EX.dataset} ${EX.commitSeq} ?s .`);
  where.push(`  BIND(?s + 1 AS ?s1)`);

  for (const iri of plan.fresh) pre.push(...fresh(ref(iri)));
  if (plan.verGuard) {
    dBinds.push(ok('?xv', 'xvOld'), ok('?xv + 1', 'xvNew'));
    del.push(`  ${v(ref(plan.verGuard))} ${EX.ver} ?d_xvOld .`);
    dIns.push(`  ${v(ref(plan.verGuard))} ${EX.ver} ?d_xvNew .`);
  }
  plan.delAll.forEach(({ s, p, keep }, k) => {
    top.push(`  OPTIONAL { ${ref(s)} ${ref(p)} ?xd${k} }`);
    dBinds.push(ok(`?xd${k}`, `xd${k}`));
    del.push(`  ${v(ref(s))} ${ref(p)} ?d_xd${k} .`);
    if (keep) dIns.push(`  ${v(ref(keep[0]))} ${ref(keep[1])} ?d_xd${k} .`);
  });
  for (const [s, p, o] of plan.ins) dIns.push(`  ${v(ref(s))} ${ref(p)} ${v(o)} .`);

  pre.push(`    BIND(true AS ?ok)`);
  where.push(`  OPTIONAL {`, ...pre, `  }`);
  where.push(...top);
  where.push(`  BIND(IF(BOUND(?ok), ${EX.APPLIED}, ${EX.PRECONDITION_FAILED}) AS ?n_outcome)`);
  where.push(nb(JSON.stringify(digest), 'digest'), nb(ref(c.actor), 'actor'), nb('NOW()', 'at'));
  if (plan.target) where.push(nb(ref(plan.target), 'target0'));
  where.push(...dBinds);

  del.unshift(`  ${MARKER_SUBJECT} ${EX.commitSeq} ?s .`);
  const ins = [`  ${MARKER_SUBJECT} ${EX.commitSeq} ?s1 .`,
    `  ${OP} ${EX.outcome} ?n_outcome .`, `  ${OP} ${EX.digest} ?n_digest .`, `  ${OP} ${EX.actor} ?n_actor .`,
    `  ${OP} ${EX.at} ?n_at .`, `  ${OP} ${EX.commitSeq} ?s1 .`, ...(plan.target ? [`  ${OP} ${EX.target} ?n_target0 .`] : []), ...dIns];

  const sparql = `DELETE {\n${del.join('\n')}\n}\nINSERT {\n${ins.join('\n')}\n}\nWHERE {\n${where.join('\n')}\n}\n`;
  const check = staticCheck(sparql, c.opId);
  if (!check.ok) fail(`compiler rejected its own output: ${check.errors.join('; ')}`);
  return { sparql, digest, canonical: c };
}

// ---------- #1562: LangGraph checkpoint-saver kinds ----------
//
// Four kinds — lg.put, lg.putWrites, lg.deleteThread, lg.runTransition — that
// compile through the SAME three-category template as the kinds above and are
// read back by the SAME staticCheck: a top-level duplicate guard, a commit-marker
// bump and a receipt bound whenever the guard passes, and every DOMAIN template
// triple carrying a ?d_ variable that is IF(BOUND(?ok), x, ?u).
//
// The only PRECONDITION of every lg kind is the thread generation (deleteThread
// bumps it), plus, for lg.runTransition, the branch head and status. The
// process-fact transition (design v0.2 §1) is computed in ?x_ helper bindings
// and then passed through the ?ok guard like every other domain value: the guard
// is necessary for a domain triple, and the transition may further leave a ?x_
// value unbound so its triple is skipped.
//
// The compiler, not the caller, mints every IRI and encodes every caller string
// (percent-encoding for identifiers, base64 for opaque payloads), so a literal in
// the update text is always inside [A-Za-z0-9+/=%._~!*'()-] and can never carry
// SPARQL syntax that the static checker would have to parse around.

export const LG_KINDS = Object.freeze(['lg.put', 'lg.putWrites', 'lg.deleteThread', 'lg.runTransition']);
/** WRITES_IDX_MAP of @langchain/langgraph-checkpoint 1.1.5, pinned (a special write's idx is its channel's). */
export const LG_SPECIAL_IDX = Object.freeze({ __error__: -1, __scheduled__: -2, __interrupt__: -3, __resume__: -4 });
const LG_FIELDS = {
  'lg.put': ['scope', 'thread', 'ns', 'gen', 'cid', 'parentCid', 'step', 'payloadType', 'payload', 'metaType', 'metadata', 'meta', 'channelVersions', 'blobs'],
  'lg.putWrites': ['scope', 'thread', 'ns', 'gen', 'cid', 'taskId', 'resumer', 'writes'],
  'lg.deleteThread': ['scope', 'thread', 'gen'],
  'lg.runTransition': ['scope', 'thread', 'ns', 'gen', 'cid', 'to'],
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

  where.push(`  OPTIONAL { ${OP} ${EX.digest} ?dup }`);
  where.push(`  FILTER(!BOUND(?dup))`);
  where.push(`  ${EX.dataset} ${EX.commitSeq} ?s .`);
  where.push(`  BIND(?s + 1 AS ?s1)`);
  D('op', OP);

  // precondition: the thread generation the caller read (deleteThread bumps it)
  if (g.gen === '0') pre.push(`    FILTER NOT EXISTS { ${THR} ${LG.gen} ?x_anyGen }`);
  else pre.push(`    ${THR} ${LG.gen} ?x_g .`, `    FILTER(?x_g = ${g.gen})`);

  const common = () => ({ thr: D('thr', THR), scope: D('scope', SCOPE), tid: D('tid', elit(g.thread)) });

  if (c.kind === 'lg.deleteThread') {
    pre.push(`    OPTIONAL { ?x_n ${LG.inThread} ${THR} . ?x_n ?x_p ?x_o }`);
    T(del, D('n', '?x_n'), D('p', '?x_p'), D('o', '?x_o'));
    const thr = D('thr', THR);
    if (g.gen !== '0') T(del, thr, LG.gen, D('og', '?x_g'));
    T(ins, thr, LG.gen, D('ng', String(Number(g.gen) + 1)));
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

  del.unshift(`  ${MARKER_SUBJECT} ${EX.commitSeq} ?s .`);
  const rec = [`  ${MARKER_SUBJECT} ${EX.commitSeq} ?s1 .`,
    `  ${OP} ${EX.outcome} ?n_outcome .`, `  ${OP} ${EX.digest} ?n_digest .`, `  ${OP} ${EX.actor} ?n_actor .`,
    `  ${OP} ${EX.at} ?n_at .`, `  ${OP} ${EX.commitSeq} ?s1 .`];
  const sparql = `DELETE {\n${del.join('\n')}\n}\nINSERT {\n${[...rec, ...ins].join('\n')}\n}\nWHERE {\n${where.join('\n')}\n}\n`;
  const check = staticCheck(sparql, c.opId);
  if (!check.ok) fail(`compiler rejected its own output: ${check.errors.join('; ')}`);
  return { sparql, digest, canonical: c };
}
