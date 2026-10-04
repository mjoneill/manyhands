/**
 * #1558 slice — the D1 authority resolver. Pure protocol against the graph
 * executor (read-only). Builder's DEV fixtures only; no sealed G1 instances.
 *
 * Boundary (agreed #1558 03:10Z–03:14Z, #1565 D1 v1):
 *
 *   createAuthorityResolver({query})  → { resolve }
 *     query(sparql) is the injected graph-client SELECT method (called as a
 *     function). It returns { ok:true, head, rows } on a complete SELECT, or
 *     { ok:false, status:'UNAVAILABLE', reason } on any transport / malformed
 *     binding.
 *
 *   resolve({topic, predicate, scope, evaluationTime})
 *     uses raw absolute IRI strings for the first three and a required
 *     evaluation time string. Subject to the graph, not to "graceful OWL"
 *     inferences. Slice = exact scope, immediate-effective only; no role
 *     hierarchy, no arbitrary scope containment, no future-effective or
 *     retroactive grant policy.
 *
 *   envelope:
 *     { status, topic, predicate, scope, evaluationTime,
 *       observedRevision { datasetId, epoch, commitSeq },
 *       currentAuthorities[], otherAssertions[], retirements[],
 *       governingRules[], reason, completeness }
 *     status ∈ { CURRENT, NO_AUTHORITY, UNRESOLVED, UNAVAILABLE }
 *     one SELECT per resolve, no pre-reads, no LIMIT/pagination.
 *
 *   statuses:
 *   'NO_AUTHORITY'  complete successful evaluation, zero eligible rows
 *   'CURRENT'       one authorized unretired binding; corroborating
 *                   same-value binding assertions are listed side by side
 *                   preserving identities (not collapsed)
 *   'UNRESOLVED'    two+ incompatible eligible binding assertions with no
 *                   resolved supersession (not newest-wins); OR
 *                   dangling supersession edge, OR a supersession cycle, OR
 *                   a raw retired status with no replacement basis, OR
 *                   invalid grant/scope basis. Reason carries the code.
 *   'UNAVAILABLE'   query failure, malformed result, missing or
 *                   contradictory marker, incomplete transport, or a
 *                   candidate count mismatch (rows were clipped)
 */
import { EX, NS } from './graph-vocab.mjs';

const XSD = 'http://www.w3.org/2001/XMLSchema#';
const TERM_TYPES = new Set(['uri', 'literal', 'bnode']);

const IRI_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:[^\s<>"{}|^`\\]+$/;

function isAbsoluteIri(v) {
  return typeof v === 'string' && IRI_RE.test(v) && !v.startsWith('_:');
}
function checkIri(v, what) {
  if (!isAbsoluteIri(v)) {
    const err = new Error(`${what}: not an absolute IRI`);
    err.code = 'INVALID_IRI';
    throw err;
  }
  return v;
}
function termKey(t) {
  if (!t) return '';
  return `${t.type}:${t.value}|${t.datatype || ''}|${t['xml:lang'] || ''}`;
}
function termExactString(t) {
  if (!t) return null;
  if (t.type === 'uri') return t.value;
  if (t.type === 'literal') return t.value;
  return null;
}
function isIntegerTerm(t) {
  return t?.type === 'literal' && t.datatype === `${XSD}integer`;
}
function isIntegerLexical(s) {
  return typeof s === 'string' && /^\+?\d+$/.test(s);
}
function asIntString(t, what) {
  if (!isIntegerTerm(t)) return { ok: false, reason: `${what || 'int'}: not xsd:integer` };
  if (!isIntegerLexical(t.value)) return { ok: false, reason: `${what || 'int'}: lexical not integer` };
  return { ok: true, value: t.value };
}

import { STATUS_MEANING } from './authority-meaning.mjs';
export { STATUS_MEANING };

function envelope({ status, topic, predicate, scope, evaluationTime, observedRevision, currentAuthorities = [], otherAssertions = [], retirements = [], governingRules = [], reason = '', completeness = 'complete' }) {
  return {
    status, meaning: STATUS_MEANING[status] ?? null, topic, predicate, scope, evaluationTime,
    observedRevision,
    currentAuthorities, otherAssertions, retirements, governingRules,
    reason, completeness,
  };
}

/**
 * The one SELECT — #1558 repair (the builder, backup for a reviewer; review 1 R1/R2).
 *
 * FOUR ANCHORED BLOCKS under one OPTIONAL, each re-anchoring the candidate to
 * the topic, so no block can bind a variable from outside the topic and no
 * block depends on another having matched:
 *   kind "cand"  the candidate's own fields (each OPTIONAL, so a malformed
 *                assertion still surfaces and is validated, not filtered)
 *   kind "prov"  the candidate's ex:recordedBy receipt, its fields, and the
 *                grant and rule that receipt names. Joined through recordedBy
 *                ALONE: a plain assertion's receipt has no ex:target (R1), and
 *                the grant/rule are reached only from THIS receipt (R2).
 *   kind "sup"   each superseded target and the target's own fields
 *   kind "ret"   the candidate's own ex:retiredBy receipt and its fields
 * Plus the graph-owned marker and the same-query candidate count.
 */
const R_FIELDS = ['outcome', 'actor', 'grant', 'grantRev', 'rule', 'ruleRev', 'target', 'digest', 'commitSeq'];
const C_FIELDS = ['predicate', 'scope', 'status', 'value', 'binding', 'ver', 'author', 'recordedBy', 'supersedes', 'retiredBy', 'evidence'];
const G_FIELDS = ['grantee', 'scope', 'mayRetire', 'active', 'rev'];
const T_FIELDS = ['subject', 'predicate', 'scope', 'status', 'value', 'binding', 'ver', 'retiredBy'];
export function buildAuthorityQuery({ topic, predicate, scope }) {
  void predicate; void scope;   // eligibility is decided in the reducer, so ineligible assertions still surface
  const T = `<${topic}>`;
  const ex = (l) => `<${NS}${l}>`;
  // Subject-first pattern order: puts `?var ex:subject <T>` first in each block so the
  // measured pyoxigraph0.5.11 fixture avoids unrelated-Assertion scans. Triple set and
  // checks unchanged; ordering is engine/version dependent.
  const anchor = `?candidate ${ex('subject')} ${T} ; a ${ex('Assertion')} .`;
  const rOpts = (v) => R_FIELDS.map((f) => `OPTIONAL { ${v} ${ex(f)} ?r_${f} }`).join('\n        ');
  return `SELECT * WHERE {
  ${ex('dataset')} ${ex('commitSeq')} ?marker .
  OPTIONAL { ${ex('dataset')} ${ex('datasetId')} ?m_datasetId }
  OPTIONAL { ${ex('dataset')} ${ex('epoch')} ?m_epoch }
  { SELECT (COUNT(DISTINCT ?cc) AS ?candidateCount) WHERE { ?cc ${ex('subject')} ${T} ; a ${ex('Assertion')} } }
  # COVERAGE (a reviewer review 3): distinct supporting triples per block, counted in the SAME snapshot,
  # so a response that keeps every candidate id but drops a supporting row is detected as incomplete.
  { SELECT (COUNT(*) AS ?nCandTriples) WHERE { SELECT DISTINCT ?k1 ?k2 ?k3 WHERE {
      ?k1 ${ex('subject')} ${T} ; a ${ex('Assertion')} ; ?k2 ?k3 . FILTER(?k2 IN (${C_FIELDS.map(ex).join(', ')})) } } }
  { SELECT (COUNT(*) AS ?nRecTriples) WHERE { SELECT DISTINCT ?k1 ?k2 ?k3 WHERE {
      ?kc ${ex('subject')} ${T} ; a ${ex('Assertion')} . { ?kc ${ex('recordedBy')} ?k1 } UNION { ?kc ${ex('retiredBy')} ?k1 }
      ?k1 ?k2 ?k3 . FILTER(?k2 IN (${R_FIELDS.map(ex).join(', ')})) } } }
  { SELECT (COUNT(*) AS ?nGrantTriples) WHERE { SELECT DISTINCT ?k1 ?k2 ?k3 WHERE {
      ?kc ${ex('subject')} ${T} ; a ${ex('Assertion')} ; ${ex('recordedBy')} ?kr . ?kr ${ex('grant')} ?k1 .
      ?k1 ?k2 ?k3 . FILTER(?k2 IN (${G_FIELDS.map(ex).join(', ')})) } } }
  { SELECT (COUNT(*) AS ?nRuleTriples) WHERE { SELECT DISTINCT ?k1 ?k3 WHERE {
      ?kc ${ex('subject')} ${T} ; a ${ex('Assertion')} ; ${ex('recordedBy')} ?kr . ?kr ${ex('rule')} ?k1 . ?k1 ${ex('rev')} ?k3 } } }
  { SELECT (COUNT(*) AS ?nTargetTriples) WHERE { SELECT DISTINCT ?k1 ?k2 ?k3 WHERE {
      ?kc ${ex('subject')} ${T} ; a ${ex('Assertion')} ; ${ex('supersedes')} ?k1 .
      ?k1 ?k2 ?k3 . FILTER(?k2 IN (${T_FIELDS.map(ex).join(', ')})) } } }
  OPTIONAL {
    {
      ${anchor} BIND("cand" AS ?kind)
      OPTIONAL { ?candidate ${ex('predicate')} ?c_pred }
      OPTIONAL { ?candidate ${ex('scope')} ?c_scope }
      OPTIONAL { ?candidate ${ex('status')} ?c_status }
      OPTIONAL { ?candidate ${ex('value')} ?c_value }
      OPTIONAL { ?candidate ${ex('binding')} ?c_binding }
      OPTIONAL { ?candidate ${ex('ver')} ?c_ver }
      OPTIONAL { ?candidate ${ex('author')} ?c_author }
      OPTIONAL { ?candidate ${ex('recordedBy')} ?c_recordedBy }
      OPTIONAL { ?candidate ${ex('supersedes')} ?c_supersedes }
      OPTIONAL { ?candidate ${ex('retiredBy')} ?c_retiredBy }
      OPTIONAL { ?candidate ${ex('evidence')} ?c_evidence }
    } UNION {
      ${anchor} ?candidate ${ex('recordedBy')} ?rec . BIND("prov" AS ?kind)
        ${rOpts('?rec')}
      OPTIONAL { ?rec ${ex('grant')} ?grant .
        OPTIONAL { ?grant ${ex('grantee')} ?g_grantee }
        OPTIONAL { ?grant ${ex('scope')} ?g_scope }
        OPTIONAL { ?grant ${ex('mayRetire')} ?g_mayRetire }
        OPTIONAL { ?grant ${ex('active')} ?g_active }
        OPTIONAL { ?grant ${ex('rev')} ?g_rev } }
      OPTIONAL { ?rec ${ex('rule')} ?rule . OPTIONAL { ?rule ${ex('rev')} ?rr_rev } }
    } UNION {
      ${anchor} ?candidate ${ex('supersedes')} ?target . BIND("sup" AS ?kind)
      OPTIONAL { ?target ${ex('subject')} ?old_subject }
      OPTIONAL { ?target ${ex('predicate')} ?old_predicate }
      OPTIONAL { ?target ${ex('scope')} ?old_scope }
      OPTIONAL { ?target ${ex('status')} ?old_status }
      OPTIONAL { ?target ${ex('value')} ?old_value }
      OPTIONAL { ?target ${ex('binding')} ?old_binding }
      OPTIONAL { ?target ${ex('ver')} ?old_ver }
      OPTIONAL { ?target ${ex('retiredBy')} ?old_retiredBy }
    } UNION {
      ${anchor} ?candidate ${ex('retiredBy')} ?rec . BIND("ret" AS ?kind)
        ${rOpts('?rec')}
    }
  }
}`;
}

function validateBindings(head, rows) {
  const vars = new Set(head?.vars || []);
  for (const row of rows) {
    for (const [k, v] of Object.entries(row)) {
      if (!vars.has(k)) return `unknown binding var: ${k}`;
      if (!v || typeof v !== 'object') return `binding ${k} not an object`;
      if (!TERM_TYPES.has(v.type)) return `binding ${k} bad type`;
      if (typeof v.value !== 'string') return `binding ${k} bad value`;
      const keys = Object.keys(v);
      if (keys.some((kk) => !['type', 'value', 'datatype', 'xml:lang'].includes(kk))) return `binding ${k} extra keys`;
      if (v.type !== 'literal' && (v.datatype != null || v['xml:lang'] != null)) return `binding ${k} uri with datatype/lang`;
      if (v.datatype != null && v['xml:lang'] != null) return `binding ${k} both datatype and lang`;
    }
  }
  return null;
}

// ---------- reduce: every field is a SET, so a repeated field is a visible conflict ----------
const addTo = (obj, k, term) => { if (!term) return; (obj[k] ??= new Map()).set(termKey(term), term); };
const vals = (obj, k) => [...(obj[k]?.values() || [])];
function one(obj, k) {
  const v = vals(obj, k);
  return v.length === 1 ? { ok: true, term: v[0] } : { ok: false, count: v.length };
}
const iriOf = (t) => (t && t.type === 'uri' ? t.value : null);
const isTrue = (t) => t?.type === 'literal' && t.value === 'true' && (t.datatype == null || t.datatype === `${XSD}boolean`);

function reduceBindings(rows) {
  const markers = new Map();
  const problems = [];
  const cands = new Map();
  const receipts = new Map();
  const grants = new Map();
  const rules = new Map();
  const targets = new Map();
  const get = (m, k) => { let v = m.get(k); if (!v) { v = { iri: k }; m.set(k, v); } return v; };

  for (const row of rows) {
    if (row.marker) {
      const seq = asIntString(row.marker, 'marker');
      let m = markers.get(NS + 'dataset');
      if (!m) { m = { seq: null, datasetId: null, epoch: null }; markers.set(NS + 'dataset', m); }
      if (!seq.ok) problems.push(`marker-non-integer:${seq.reason}`);
      else if (m.seq != null && m.seq !== seq.value) m.seq = '__CONFLICT__';
      else if (m.seq !== '__CONFLICT__') m.seq = seq.value;
      if (row.m_datasetId?.type === 'literal') {
        if (m.datasetId != null && m.datasetId !== row.m_datasetId.value) problems.push('datasetId-conflict');
        else m.datasetId = row.m_datasetId.value;
      }
      if (row.m_epoch) {
        const ep = asIntString(row.m_epoch, 'm_epoch');
        if (!ep.ok) problems.push(`epoch-non-integer:${ep.reason}`);
        else if (m.epoch != null && m.epoch !== ep.value) problems.push('epoch-conflict');
        else m.epoch = ep.value;
      }
    }
    const cIri = iriOf(row.candidate);
    if (!cIri) continue;
    const c = get(cands, cIri);
    const kind = row.kind?.value;
    if (kind === 'cand') {
      for (const [k, v] of [['predicate', 'c_pred'], ['scope', 'c_scope'], ['status', 'c_status'], ['value', 'c_value'], ['binding', 'c_binding'],
        ['ver', 'c_ver'], ['author', 'c_author'], ['recordedBy', 'c_recordedBy'], ['supersedes', 'c_supersedes'], ['retiredBy', 'c_retiredBy'],
        ['evidence', 'c_evidence']]) addTo(c, k, row[v]);
    } else if (kind === 'prov' || kind === 'ret') {
      const recIri = iriOf(row.rec);
      if (!recIri) continue;
      const r = get(receipts, recIri);
      r.seen = true;
      for (const f of R_FIELDS) addTo(r, f, row[`r_${f}`]);
      if (kind === 'prov') {
        const gIri = iriOf(row.grant);
        if (gIri) { const g = get(grants, gIri); for (const f of G_FIELDS) addTo(g, f, row[`g_${f}`]); }
        const rlIri = iriOf(row.rule);
        if (rlIri) addTo(get(rules, rlIri), 'rev', row.rr_rev);
      }
    } else if (kind === 'sup') {
      const tIri = iriOf(row.target);
      if (!tIri) continue;
      const t = get(targets, tIri);
      for (const f of T_FIELDS) {
        if (row[`old_${f}`]) { t.hasAny = true; addTo(t, f, row[`old_${f}`]); }
      }
    }
  }
  // coverage: what the rows carry, to compare with the same-snapshot counts
  const sz = (m, fields) => [...m.values()].reduce((n, e) => n + fields.reduce((k, f) => k + (e[f]?.size || 0), 0), 0);
  const coverage = { nCandTriples: sz(cands, C_FIELDS), nRecTriples: sz(receipts, R_FIELDS), nGrantTriples: sz(grants, G_FIELDS),
    nRuleTriples: sz(rules, ['rev']), nTargetTriples: sz(targets, T_FIELDS) };
  return { markers, problems, cands, receipts, grants, rules, targets, coverage };
}

function serializeReceipt(r) {
  if (!r) return null;
  const s1 = (k) => { const o = one(r, k); return o.ok ? o.term.value : null; };
  const local = (v) => (v && v.startsWith(NS) ? v.slice(NS.length) : v);
  const tg = vals(r, 'target').map((t) => t.value).sort();
  return { iri: r.iri, outcome: local(s1('outcome')), actor: s1('actor'), grant: s1('grant'), grantRev: s1('grantRev'),
    rule: s1('rule'), ruleRev: s1('ruleRev'), target: tg[0] ?? null, targets: tg, digest: s1('digest'), commitSeq: s1('commitSeq') };
}

/**
 * Certify ONE eligible current binding candidate. Every supporting fact must
 * be present, single-valued and consistent; anything missing or contradictory
 * is a named problem (→ UNRESOLVED), never a silent CURRENT (a reviewer, D1,
 * #1558 04:01:42Z). Revisions bumped AFTER the receipt do not invalidate it:
 * the receipt's recorded grantRev/ruleRev ARE the historical basis.
 */
function certify(c, red, scope, problems) {
  const p = (code) => problems.push(`${code}:${c.iri}`);
  const rb = vals(c, 'recordedBy').map(iriOf).filter(Boolean);
  if (rb.length === 0) { p(vals(c, 'supersedes').length ? 'missing-retirement-basis' : 'bootstrap-recordedBy-absent'); return null; }
  if (rb.length > 1) { p('recordedBy-conflict'); return null; }
  const R = red.receipts.get(rb[0]);
  if (!R?.seen || !vals(R, 'outcome').length) { p('missing-receipt'); return null; }
  const s1 = (k) => { const o = one(R, k); if (!o.ok) { p(o.count ? `receipt-${k}-conflict` : `missing-receipt-${k}`); return null; } return o.term; };
  const outcome = s1('outcome'); const actor = s1('actor'); const grant = s1('grant'); const grantRev = s1('grantRev'); const rule = s1('rule'); const ruleRev = s1('ruleRev');
  if (outcome && outcome.value !== `${NS}APPLIED`) p('receipt-not-applied');
  if (grantRev && !asIntString(grantRev).ok) p('receipt-grantRev-invalid');
  if (ruleRev && !asIntString(ruleRev).ok) p('receipt-ruleRev-invalid');
  const author = one(c, 'author');
  if (author.ok && actor && author.term.value !== actor.value) p('author-actor-mismatch');
  if (!author.ok && author.count > 1) p('author-conflict');
  if (grant) {
    const G = red.grants.get(grant.value);
    if (!G || !vals(G, 'grantee').length) p('grant-missing');
    else {
      const gs = (k) => { const o = one(G, k); if (!o.ok) { p(o.count ? `grant-${k}-conflict` : `grant-${k}-missing`); return null; } return o.term; };
      const grantee = gs('grantee'); const gScope = gs('scope'); const active = gs('active');
      if (grantee && actor && grantee.value !== actor.value) p('grantee-mismatch');
      if (gScope && gScope.value !== scope) problems.push(`grant-scope-mismatch:${c.iri}:${gScope.value}`);
      if (active && !isTrue(active)) p('grant-inactive');
      const sup = vals(c, 'supersedes').map(iriOf).filter(Boolean);
      if (sup.length) {
        const mr = gs('mayRetire');
        if (mr && !isTrue(mr)) p('grant-no-retire');
        const recTargets = new Set(vals(R, 'target').map(iriOf));
        for (const t of sup) {
          if (!recTargets.has(t)) problems.push(`retirement-receipt-mismatch:${c.iri}:${t}`);
          const T = red.targets.get(t);
          if (T?.hasAny) {
            const st = one(T, 'status');
            if (!st.ok || st.term.value !== `${NS}retired`) problems.push(`retirement-incomplete:${c.iri}:${t}`);
            const tr = vals(T, 'retiredBy').map(iriOf);
            if (tr.length === 0) problems.push(`retiredBy-missing:${c.iri}:${t}`);
            else if (tr.length > 1) problems.push(`retiredBy-conflict:${c.iri}:${t}`);
            else if (tr[0] !== R.iri) problems.push(`retiredBy-mismatch:${c.iri}:${t}`);
          }
        }
      }
    }
  }
  if (rule) {
    const RL = red.rules.get(rule.value);
    if (!RL || !vals(RL, 'rev').length) p('rule-missing');
  }
  return R;
}

function synthesize(red, request) {
  const { topic, predicate, scope, evaluationTime } = request;
  const problems = [...red.problems];
  const all = [...red.cands.values()];
  const s1v = (c, k) => { const o = one(c, k); return o.ok ? o.term : null; };
  const statusOf = (c) => { const o = one(c, 'status'); if (!o.ok) return o.count ? 'conflict' : null; return o.term.value === `${NS}current` ? 'current' : o.term.value === `${NS}retired` ? 'retired' : 'unknown'; };
  const isEligible = (c) => iriOf(s1v(c, 'predicate')) === predicate && iriOf(s1v(c, 'scope')) === scope;

  // every candidate on the topic must be WELL-FORMED before it is classified: a malformed one
  // never quietly becomes an observation or "ineligible" (a reviewer review 3 #2)
  const isBool = (t) => t?.type === 'literal' && (t.value === 'true' || t.value === 'false') && (t.datatype == null || t.datatype === `${XSD}boolean`);
  const REQUIRED = { predicate: (t) => t.type === 'uri', scope: (t) => t.type === 'uri', status: (t) => t.type === 'uri',
    value: (t) => t.type !== 'bnode', binding: isBool, ver: (t) => asIntString(t).ok, author: (t) => t.type === 'uri' };
  const malformed = new Set();
  for (const c of all) {
    for (const [k, okType] of Object.entries(REQUIRED)) {
      const v = vals(c, k);
      if (v.length === 0) { problems.push(`candidate-malformed:${c.iri}:${k}-missing`); malformed.add(c.iri); }
      else if (v.length > 1) { problems.push(`assertion-conflict:${c.iri}:${k}`); malformed.add(c.iri); }
      else if (!okType(v[0])) { problems.push(`candidate-malformed:${c.iri}:${k}-invalid`); malformed.add(c.iri); }
    }
    const st = statusOf(c);
    if (st === 'unknown') { problems.push(`status-invalid:${c.iri}:unknown`); malformed.add(c.iri); }
  }
  const eligible = all.filter(isEligible);
  const binding = eligible.filter((c) => isTrue(s1v(c, 'binding')));
  const current = binding.filter((c) => statusOf(c) === 'current');
  const retired = binding.filter((c) => statusOf(c) === 'retired');

  // supersession structure (over every candidate's edges)
  const supersededBy = new Map();
  for (const c of all) for (const t of vals(c, 'supersedes').map(iriOf).filter(Boolean)) {
    if (!supersededBy.has(t)) supersededBy.set(t, []);
    supersededBy.get(t).push(c);
    if (!red.cands.has(t) && !red.targets.get(t)?.hasAny) problems.push(`dangling-supersedes:${t}`);
  }
  for (const c of all) {
    const seen = new Set([c.iri]); const stack = vals(c, 'supersedes').map(iriOf).filter(Boolean);
    while (stack.length) {
      const t = stack.pop();
      if (t === c.iri) { problems.push(`supersession-cycle:${c.iri}`); break; }
      if (seen.has(t) || !red.cands.has(t)) continue;
      seen.add(t);
      stack.push(...vals(red.cands.get(t), 'supersedes').map(iriOf).filter(Boolean));
    }
  }

  // certify each current binding assertion
  const basis = new Map();
  for (const c of current) basis.set(c.iri, certify(c, red, scope, problems));

  // a retired binding assertion needs a replacement basis: some candidate supersedes it
  // and that candidate's APPLIED receipt targets it (the header's promise; review F4)
  const retirements = [];
  for (const c of retired) {
    const by = (supersededBy.get(c.iri) || []).filter((x) => {
      const rb = vals(x, 'recordedBy').map(iriOf);
      const R = rb.length === 1 ? red.receipts.get(rb[0]) : null;
      return R && vals(R, 'outcome').some((o) => o.value === `${NS}APPLIED`) && vals(R, 'target').some((t) => t.value === c.iri);
    });
    if (!by.length) { problems.push(`retired-without-basis:${c.iri}`); continue; }
    const own = vals(c, 'retiredBy').map(iriOf);
    const replacing = new Set(by.map((x) => vals(x, 'recordedBy').map(iriOf)[0]));
    if (own.length !== 1) problems.push(`retiredBy-${own.length ? 'conflict' : 'missing'}:${c.iri}`);
    else if (!replacing.has(own[0])) problems.push(`retiredBy-mismatch:${c.iri}`);
    for (const x of by) {
      const R = red.receipts.get(vals(x, 'recordedBy').map(iriOf)[0]);
      retirements.push({ target: c.iri, by: x.iri, receipt: serializeReceipt(R) });
    }
  }

  const governingRules = [];
  for (const R of basis.values()) {
    if (!R) continue;
    const rl = one(R, 'rule');
    if (rl.ok && !governingRules.some((g) => g.iri === rl.term.value)) {
      const RL = red.rules.get(rl.term.value);
      const rv = RL ? one(RL, 'rev') : { ok: false };
      governingRules.push({ iri: rl.term.value, rev: rv.ok ? rv.term.value : null });
    }
  }

  const authEnv = (c) => {
    const R = basis.get(c.iri);
    const ser = serializeReceipt(R);
    return { iri: c.iri, value: s1v(c, 'value'), binding: true, status: statusOf(c), ver: s1v(c, 'ver')?.value ?? null,
      author: iriOf(s1v(c, 'author')) ?? ser?.actor ?? null,
      recordedBy: ser ?? (vals(c, 'recordedBy').length ? { iri: iriOf(vals(c, 'recordedBy')[0]), basis: 'absent' } : null),
      evidence: vals(c, 'evidence').map(iriOf).sort(),
      bootstrap: !vals(c, 'recordedBy').length };
  };
  // E1/E2: why each non-governing assertion does NOT govern, in the same envelope
  const retiredByMap = new Map(retirements.map((r) => [r.target, r]));
  const notGoverning = (c) => {
    if (!isEligible(c)) return 'ineligible: different predicate or scope from the request (exact match only)';
    const b = s1v(c, 'binding');
    if (b && !isTrue(b)) return 'non-binding observation: it cannot displace binding authority, whoever made it and however new it is';
    if (statusOf(c) === 'retired') { const r = retiredByMap.get(c.iri); return r ? `retired: superseded by ${r.by} under receipt ${r.receipt?.iri} (grant ${r.receipt?.grant} rev ${r.receipt?.grantRev})` : 'retired: no valid replacement basis (see reason)'; }
    return null;
  };
  const obsEnv = (c) => ({ iri: c.iri, predicate: iriOf(s1v(c, 'predicate')), scope: iriOf(s1v(c, 'scope')), value: s1v(c, 'value'),
    binding: s1v(c, 'binding') ? isTrue(s1v(c, 'binding')) : null, status: statusOf(c), ver: s1v(c, 'ver')?.value ?? null,
    author: iriOf(s1v(c, 'author')) ?? serializeReceipt(red.receipts.get(iriOf(vals(c, 'recordedBy')[0])))?.actor ?? null,
    recordedBy: iriOf(vals(c, 'recordedBy')[0]) ?? null, supersedes: vals(c, 'supersedes').map(iriOf),
    retiredBy: vals(c, 'retiredBy').map(iriOf), evidence: vals(c, 'evidence').map(iriOf).sort(), eligible: isEligible(c),
    notGoverning: notGoverning(c) });

  const base = { topic, predicate, scope, evaluationTime, observedRevision: null, retirements, governingRules, completeness: 'complete' };
  const others = (exclude) => all.filter((c) => !exclude.includes(c)).map(obsEnv);
  const uniq = [...new Set(problems)];
  if (uniq.length) {
    return envelope({ ...base, status: 'UNRESOLVED', reason: uniq.join(';'), currentAuthorities: current.map(authEnv), otherAssertions: others(current) });
  }
  if (!current.length) return envelope({ ...base, status: 'NO_AUTHORITY', reason: 'no-binding-assertion: nothing binding is recorded for this topic, predicate and scope', currentAuthorities: [], otherAssertions: others([]) });
  const byValue = new Map();
  for (const c of current) { const k = termKey(s1v(c, 'value')); if (!byValue.has(k)) byValue.set(k, []); byValue.get(k).push(c); }
  if (byValue.size === 1) {
    const why = current.map((c) => { const r = serializeReceipt(basis.get(c.iri)); return `${c.iri} is binding and current, recorded by ${r.iri} (${r.outcome}) by ${r.actor} under grant ${r.grant} rev ${r.grantRev} and rule ${r.rule} rev ${r.ruleRev}`; });
    const shown = all.filter((c) => !current.includes(c)).length;
    return envelope({ ...base, status: 'CURRENT', reason: `governing: ${why.join('; ')}${shown ? `. ${shown} other assertion(s) on this topic do not govern; each says why (notGoverning)` : ''}`,
      currentAuthorities: current.map(authEnv), otherAssertions: others(current) });
  }
  return envelope({ ...base, status: 'UNRESOLVED', reason: `binding-conflict: ${byValue.size} distinct eligible values with no resolved supersession`,
    currentAuthorities: current.map(authEnv), otherAssertions: others(current) });
}

/**
 * Factory. Returns the {resolve} entry. The injected `query` is called exactly
 * once per resolve. It MUST return { ok:true, head, rows } on a complete SELECT,
 * or { ok:false, status:'UNAVAILABLE', reason } on any transport / malformed
 * binding.
 */
export function createAuthorityResolver({ query }) {
  if (typeof query !== 'function') throw new Error('createAuthorityResolver: query must be a function');

  async function resolve({ topic, predicate, scope, evaluationTime } = {}) {
    try {
      checkIri(topic, 'topic');
      checkIri(predicate, 'predicate');
      checkIri(scope, 'scope');
    } catch (e) {
      return envelope({ status: 'UNAVAILABLE', topic: null, predicate: null, scope: null, evaluationTime: evaluationTime || null,
        observedRevision: null, reason: 'invalid-iri: ' + e.message,
        completeness: 'incomplete' });
    }
    if (typeof evaluationTime !== 'string' || evaluationTime.length === 0) {
      return envelope({ status: 'UNAVAILABLE', topic, predicate, scope, evaluationTime: null,
        observedRevision: null, reason: 'evaluation-time-required: immediate-effective resolution needs an explicit evaluation time string',
        completeness: 'incomplete' });
    }

    const sparql = buildAuthorityQuery({ topic, predicate, scope });
    let res;
    try {
      res = await query(sparql);
    } catch (e) {
      return envelope({ status: 'UNAVAILABLE', topic, predicate, scope, evaluationTime,
        observedRevision: null, reason: 'query-threw: ' + (e?.message || e),
        completeness: 'incomplete' });
    }
    if (!res || res.ok !== true) {
      return envelope({ status: 'UNAVAILABLE', topic, predicate, scope, evaluationTime,
        observedRevision: null, reason: (res && res.reason) ? res.reason : 'transport: query returned no result',
        completeness: 'incomplete' });
    }
    const head = res.head;
    const bindings = res.rows;
    if (!head || !Array.isArray(head.vars)) {
      return envelope({ status: 'UNAVAILABLE', topic, predicate, scope, evaluationTime,
        observedRevision: null, reason: 'malformed-result: missing head.vars',
        completeness: 'incomplete' });
    }
    if (!Array.isArray(bindings)) {
      return envelope({ status: 'UNAVAILABLE', topic, predicate, scope, evaluationTime,
        observedRevision: null, reason: 'malformed-result: missing rows',
        completeness: 'incomplete' });
    }
    const bindErr = validateBindings(head, bindings);
    if (bindErr) {
      return envelope({ status: 'UNAVAILABLE', topic, predicate, scope, evaluationTime,
        observedRevision: null, reason: 'malformed-binding: ' + bindErr,
        completeness: 'incomplete' });
    }

    // Marker is the foundation; check it first. A missing marker produces zero rows
    // (the outer pattern requires the commitSeq triple), so the count guard would
    // otherwise misreport as candidate-count-mismatch.
    if (bindings.length === 0) {
      return envelope({ status: 'UNAVAILABLE', topic, predicate, scope, evaluationTime,
        observedRevision: null, reason: 'incomplete-result: zero rows — the marker row is always returned, so an empty result was clipped or the store has no marker',
        completeness: 'incomplete' });
    }
    const reduce = reduceBindings(bindings);
    const marker = reduce.markers.get(NS + 'dataset');
    if (!marker) {
      return envelope({ status: 'UNAVAILABLE', topic, predicate, scope, evaluationTime,
        observedRevision: null, reason: 'marker-missing: no commit marker in the store',
        completeness: 'incomplete' });
    }
    if (marker.seq === '__CONFLICT__' || marker.seq == null) {
      return envelope({ status: 'UNAVAILABLE', topic, predicate, scope, evaluationTime,
        observedRevision: null, reason: 'marker-contradictory: commitSeq absent or has multiple conflicting values',
        completeness: 'incomplete' });
    }
    if (!marker.datasetId) {
      return envelope({ status: 'UNAVAILABLE', topic, predicate, scope, evaluationTime,
        observedRevision: null, reason: 'marker-incomplete: missing datasetId',
        completeness: 'incomplete' });
    }
    if (marker.epoch == null) {
      return envelope({ status: 'UNAVAILABLE', topic, predicate, scope, evaluationTime,
        observedRevision: null, reason: 'marker-incomplete: missing epoch',
        completeness: 'incomplete' });
    }

    // Count guard: embedded ?candidateCount vs distinct candidate ids.
    const distinctIds = new Set();
    for (const b of bindings) {
      const t = b.candidate;
      if (t && t.type === 'uri') distinctIds.add(t.value);
    }
    const embeddedCount = bindings.find((b) => b.candidateCount != null)?.candidateCount;
    const embeddedOk = embeddedCount && embeddedCount.type === 'literal' && embeddedCount.datatype === `${XSD}integer` && isIntegerLexical(embeddedCount.value);
    if (!embeddedOk) {
      return envelope({ status: 'UNAVAILABLE', topic, predicate, scope, evaluationTime,
        observedRevision: null, reason: 'incomplete-result: embedded ?candidateCount missing or non-integer',
        completeness: 'incomplete' });
    }
    if (embeddedCount.value !== String(distinctIds.size)) {
      return envelope({ status: 'UNAVAILABLE', topic, predicate, scope, evaluationTime,
        observedRevision: null, reason: `candidate-count-mismatch: embedded count ${embeddedCount.value} ≠ distinct candidate ids ${distinctIds.size} (clipped?)`,
        completeness: 'incomplete' });
    }

    for (const k of Object.keys(reduce.coverage)) {
      const t = bindings.find((b) => b[k] != null)?.[k];
      if (!t || t.type !== 'literal' || !isIntegerLexical(t.value)) {
        return envelope({ status: 'UNAVAILABLE', topic, predicate, scope, evaluationTime, observedRevision: null,
          reason: `incomplete-result: coverage count ${k} missing or non-integer`, completeness: 'incomplete' });
      }
      if (t.value !== String(reduce.coverage[k])) {
        return envelope({ status: 'UNAVAILABLE', topic, predicate, scope, evaluationTime, observedRevision: null,
          reason: `incomplete-result: ${k} counted ${t.value} in the snapshot but the rows carry ${reduce.coverage[k]} (supporting rows clipped?)`, completeness: 'incomplete' });
      }
    }
    const env = synthesize(reduce, { topic, predicate, scope, evaluationTime });
    env.observedRevision = {
      datasetId: marker.datasetId,
      epoch: marker.epoch,
      commitSeq: marker.seq,
    };
    return env;
  }

  return { resolve };
}