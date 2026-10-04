/**
 * #1561 — THE FIRST CUTOVER UNIT: the three log-born kinds (memory, decision,
 * seat-state) read from and written to the graph EXECUTOR instead of the event
 * log + whole-document save + in-process replica.
 *
 * OFF unless SCRUM_GRAPH_UNIT_LOGBORN=1 AND the graph slice is enabled
 * (SCRUM_GRAPH_EXECUTOR_URL). With it OFF nothing here is called except the
 * three folds, which moved here verbatim from server.js so the server, the
 * migration and the tests share ONE reading of the rows.
 *
 *   write   one compiled, guarded, receipted intention (core/graph-compiler.mjs
 *           record kinds) per API write. The actor is the AUTHENTICATED seat
 *           (`urn:ex:seat/<seat>`, core/graph-auth.mjs), never a body field.
 *   read    one SELECT against the executor, rows shortened exactly as the
 *           replica's queryGraphAll shortens them, folded by the SAME folds.
 *   fail    an unreadable executor is GRAPH_EXECUTOR_UNAVAILABLE (503 at the
 *           routes), never an empty list dressed as "none".
 *   people  every write that names a person (memory owner / version author,
 *           decidedBy, declaredSeat) runs a reviewer's planner (core/graph-people.mjs)
 *           against the graph's Person identities, and its `plan.create` rides the
 *           SAME intention as `people` — bound by the digest, ok-guarded. Under the
 *           #619 closed source set (assignees, author-of-a-post, createdBy) none of
 *           these references is a source, so `plan.create` is EMPTY for every unit
 *           write: the unit never mints a Person. A reference to a person with no
 *           graph identity is REPORTED to the audit sink (unresolvedReferences),
 *           never minted and never stripped.
 *
 * IRIs: the domain's person references are `https://scrumboard.local/person/<key>`;
 * the WRITER (actor, the receipt's urn:ex:actor) is `urn:ex:seat/<seat>`. Nothing
 * here relates the two: an actor IRI is an authentication fact about the request,
 * not a Person identity, and no bridge triple is written.
 */
import crypto from 'node:crypto';
import { LOGBORN_TERMS as TM, recLit } from './graph-compiler.mjs';
import { seatActor, authorizeWrite } from './graph-auth.mjs';
import { authDecision } from './credentials.mjs';
import { declarationsFromRows } from './seat-state.mjs';
import { planPersonRetention } from './graph-people.mjs';

export const PERSON_BASE = 'https://scrumboard.local/person/';
export const DECISION_BASE = 'https://scrumboard.local/decision/';
export const SEAT_DECL_BASE = 'https://scrumboard.local/entity/seat-state/';
const ROLE_IRI = (key) => `https://scrumboard.local/role/${encodeURIComponent(String(key))}`;   // = graph-replica ROLE_IRI
/** The actor of an unauthenticated write on a BYPASSED trial board (never a seat: nobody is bound). */
export const TRIAL_UNBOUND_ACTOR = 'urn:ex:trial/unbound';

/** Is the unit on? Throws (the server refuses to start) when the flag is set without the slice. */
export function logbornUnitConfig(env = process.env, { sliceEnabled }) {
  if (env.SCRUM_GRAPH_UNIT_LOGBORN !== '1') return { enabled: false };
  if (!sliceEnabled) throw new Error('REFUSED: SCRUM_GRAPH_UNIT_LOGBORN=1 needs the graph slice (SCRUM_GRAPH_EXECUTOR_URL + SCRUM_GRAPH_DATASET_ID): the unit\'s records live only in the executor');
  return { enabled: true };
}

// ── the folds (moved verbatim from server.js) ────────────────────────────────

/** Graph rows → Map<memory uuid, {identity, versions}> in the ENTITY shape (what the event state carries). */
export function memoriesFromRows(rows) {
  const local = (iri) => String(iri).replace(/^.*[#/:]/, '');
  const ids = new Map();      // identity iri → identity
  const vers = new Map();     // version iri → version
  for (const r of rows) {
    const t = local(r.t), p = local(r.p), o = r.o == null ? null : String(r.o);
    if (t === 'Memory') {
      const n = ids.get(r.s) || { '@id': r.s, '@type': 'scrum:Memory' };
      ids.set(r.s, n);
      if (p === 'identifier') n.identifier = o;
      else if (p === 'name') n.name = o;
      else if (p === 'owner') n['scrum:owner'] = local(o);
      else if (p === 'tag') n['scrum:tag'] = [...(n['scrum:tag'] || []), o];
      else if (p === 'currentVersion') n['scrum:currentVersion'] = o;
      else if (p === 'relatedTo') n['scrum:relatedTo'] = [...(n['scrum:relatedTo'] || []), o];
      else if (p === 'priority') n['scrum:priority'] = o;
    } else if (t === 'MemoryVersion') {
      const v = vers.get(r.s) || { '@id': r.s, '@type': 'scrum:MemoryVersion' };
      vers.set(r.s, v);
      if (p === 'ofMemory') v['scrum:ofMemory'] = o;
      else if (p === 'version') v['scrum:version'] = Number(o);
      else if (p === 'body') v['scrum:body'] = o;
      else if (p === 'author') v.author = local(o);
      else if (p === 'dateCreated') v.dateCreated = o;
    }
  }
  const out = new Map();
  for (const n of ids.values()) {
    if (Array.isArray(n['scrum:tag'])) n['scrum:tag'].sort();          // a graph is a SET; the wire order is documented, not incidental
    if (Array.isArray(n['scrum:relatedTo'])) n['scrum:relatedTo'].sort();
    out.set(n.identifier, { identity: n, versions: [] });
  }
  for (const v of vers.values()) {
    const m = [...out.values()].find((x) => x.identity['@id'] === v['scrum:ofMemory']);
    if (m) m.versions.push(v);
  }
  for (const m of out.values()) m.versions.sort((a, b) => (a['scrum:version'] || 0) - (b['scrum:version'] || 0));
  return out;
}

// ── #1561 identity history: the sequence of title/tags/priority a memory has held ──
//
// One entry shape for both stores: { title, tags (sorted: a graph is a set), priority | null },
// oldest first, the current state last, CONSECUTIVE equal entries collapsed (a body-only edit
// or a relatedTo edit is not a new identity on the wire, on either path).
const identityEntry = (name, tags, priority) => ({ title: name ?? null, tags: [...new Set([...(tags || [])].map(String))].sort(), priority: priority ?? null });
export function collapseIdentities(list) {
  const out = [];
  for (const e of list) if (!out.length || JSON.stringify(out.at(-1)) !== JSON.stringify(e)) out.push(e);
  return out;
}
/** An entity-shape identity (what the event log and the folds carry) → one entry. */
export const identityOf = (identity) => identityEntry(identity?.name, [].concat(identity?.['scrum:tag'] || []), identity?.['scrum:priority']);
/**
 * Flag OFF: the identity states the event log recorded for memory `iri`, oldest first
 * (not collapsed). Each memory event carries the WHOLE state (#971: `{identity, versions}`;
 * the older #651 shape carries the identity alone). Refusals and other kinds are skipped.
 */
export function identitiesFromEvents(events, iri) {
  const out = [];
  for (const ev of events) {
    if (ev?.entity?.kind !== 'memory' || ev.entity.id !== iri || ev.op === 'refused') continue;
    const identity = ev.state?.identity ?? (ev.state?.['@type'] === 'scrum:Memory' ? ev.state : null);
    if (identity) out.push(identityOf(identity));
  }
  return out;
}
/**
 * Flag ON: graph rows (?s ?t ?p ?o, shortened) of one memory and its MemoryRevision nodes →
 * the states in order: each revision's prior values (by revision number), then the current.
 */
export function identitiesFromRows(rows, memoryIri) {
  const local = (iri) => String(iri).replace(/^.*[#/:]/, '');
  const revs = new Map();
  const cur = { tags: [] };
  for (const r of rows) {
    const t = local(r.t), p = local(r.p), o = r.o == null ? null : String(r.o);
    if (t === 'Memory' && r.s === memoryIri) {
      if (p === 'name') cur.name = o; else if (p === 'tag') cur.tags.push(o); else if (p === 'priority') cur.priority = o;
    } else if (t === 'MemoryRevision') {
      const n = revs.get(r.s) || { tags: [] };
      revs.set(r.s, n);
      if (p === 'ofMemory') n.of = o; else if (p === 'revision') n.rev = Number(o);
      else if (p === 'priorName') n.name = o; else if (p === 'priorTag') n.tags.push(o); else if (p === 'priorPriority') n.priority = o;
    }
  }
  const ordered = [...revs.values()].filter((n) => n.of === memoryIri).sort((a, b) => a.rev - b.rev);
  return [...ordered, cur].map((n) => identityEntry(n.name, n.tags, n.priority));
}

// #1322 — the inverse edges and liveness, computed over the whole set once:
// a ruling is LIVE unless something supersedes it or it is a duplicate.
export function annotateDecisionRelations(list) {
  const byId = new Map(list.map((e) => [e.identifier, e]));
  for (const e of list) { e._supersededBy = []; e._duplicates = []; }
  for (const e of list) {
    for (const t of [].concat(e['scrum:supersedes'] || [])) byId.get(t)?._supersededBy.push(e.identifier);
    if (e['scrum:duplicateOf']) byId.get(e['scrum:duplicateOf'])?._duplicates.push(e.identifier);
  }
  return list;
}

export function decisionsFromRows(rows, { limit } = {}) {
  if (Number.isFinite(limit) && rows.length >= limit) {
    throw Object.assign(new Error(`decision read returned ${rows.length} rows against a cap of ${limit}: the set may be cut mid-decision, so it is refused rather than answered short`), { code: 'DECISIONS_TRUNCATED' });
  }
  const local = (iri) => String(iri).replace(/^.*[#/:]/, '');
  const nodes = new Map();
  for (const r of rows) {
    const n = nodes.get(r.d) || { '@id': r.d, '@type': 'scrum:Decision', 'scrum:constrains': [] };
    nodes.set(r.d, n);
    const p = local(r.p), o = r.o == null ? null : String(r.o);
    if (p === 'identifier') n.identifier = o;
    else if (p === 'statement') n['scrum:statement'] = o;
    else if (p === 'decidedBy') n['scrum:decidedBy'] = local(o);
    else if (p === 'constrains') n['scrum:constrains'].push(o);
    else if (p === 'reopensIf') n['scrum:reopensIf'] = o;
    else if (p === 'dateCreated') n.dateCreated = o;
    else if (p === 'supersedes') (n['scrum:supersedes'] ??= []).push(local(o));   // #1322
    else if (p === 'duplicateOf') n['scrum:duplicateOf'] = local(o);
  }
  // A graph is a SET: the order topics were typed in is not a fact it keeps.
  // Sorted, so the wire order is deterministic and documented rather than
  // whichever order the engine returned rows in. (The one property the
  // document path had that this path does not; recorded on #1147.)
  for (const n of nodes.values()) { n['scrum:constrains'].sort(); if (n['scrum:supersedes']) n['scrum:supersedes'].sort(); }
  return annotateDecisionRelations([...nodes.values()].sort((a, b) => String(a.dateCreated || '').localeCompare(String(b.dateCreated || ''))));
}

// ── entity shape → intention payload (the replica's projection rules) ─────────

const asPerson = (v) => (String(v).startsWith('http') ? String(v) : PERSON_BASE + v);   // = projectMemory / projectDecision
const asDecision = (t) => (String(t).startsWith('http') ? String(t) : DECISION_BASE + t);
const str = (v) => (v === undefined || v === null ? null : String(v));
const opIri = (tag) => `urn:ex:op/logborn/${tag}/${crypto.randomUUID()}`;
const withPeople = (intention, people) => (Array.isArray(people) && people.length ? { ...intention, people } : intention);

// ── Person identities (#1561, a reviewer's contract docs/graph-person-retention.md) ──

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
export const Q_PEOPLE = `SELECT ?s ?p ?o WHERE { ?s <${RDF_TYPE}> <${TM.Person}> ; ?p ?o }`;
/** Typed nodes at Person IRIs (any type), for the planner's `occupied` check. */
export const Q_PERSON_IRI_TYPES = `SELECT ?s ?t WHERE { ?s <${RDF_TYPE}> ?t FILTER(STRSTARTS(STR(?s), "${PERSON_BASE}")) }`;

/**
 * Executor rows {s,p,o} (full IRIs, raw values) of Person nodes → canonical Person nodes in the planner's whitelist shape.
 * #1561 (a reviewer's review): malformed identities are REFUSED here, before folding, never normalised. An
 * unreadable `resolved` used to become false, and two names chose whichever row came last (row order
 * changed the answer). Exactly one identifier; at most one name, glyph and resolved; resolved is
 * "true" or "false". Anything else throws PERSON_INTEGRITY, so a malformed node never reaches the
 * planner looking valid.
 */
export function peopleFromRows(rows) {
  const vals = new Map();   // iri → predicate → Set(values)
  for (const r of rows) {
    const s = String(r.s), p = String(r.p);
    if (r.o == null) continue;
    const byP = vals.get(s) || new Map();
    vals.set(s, byP);
    (byP.get(p) || byP.set(p, new Set()).get(p)).add(String(r.o));
  }
  const bad = (iri, why) => { throw Object.assign(new Error(`PERSON_INTEGRITY: ${iri}: ${why}`), { code: 'PERSON_INTEGRITY' }); };
  const out = [];
  for (const [iri, byP] of vals) {
    const one = (p, label, required) => {
      const v = [...(byP.get(p) || [])];
      if (v.length > 1) bad(iri, `more than one ${label} (${v.map((x) => JSON.stringify(x)).join(', ')})`);
      if (required && v.length === 0) bad(iri, `no ${label}`);
      return v[0];
    };
    const n = { '@type': 'Person', '@id': iri, identifier: one(TM.identifier, 'identifier', true) };
    const name = one(TM.name, 'name'); if (name !== undefined) n.name = name;
    const glyph = one(TM.glyph, 'glyph'); if (glyph !== undefined) n['scrum:glyph'] = glyph;
    const resolved = one(TM.resolved, 'resolved');
    if (resolved !== undefined) {
      if (resolved !== 'true' && resolved !== 'false') bad(iri, `resolved is ${JSON.stringify(resolved)}, not "true" or "false"`);
      n['scrum:resolved'] = resolved === 'true';
    }
    const aliases = byP.get(TM.aliases);
    if (aliases) n['scrum:aliases'] = [...aliases].sort();
    out.push(n);
  }
  return out.sort((a, b) => String(a.identifier).localeCompare(String(b.identifier)));
}

/**
 * The Person plan for ONE unit write. `entities` are the typed first-unit entity
 * nodes the write carries (scrum:Memory / scrum:MemoryVersion / scrum:Decision /
 * scrum:SeatDeclaration), passed as `domain.firstUnitEntities` per the contract.
 * No `prior` (this is not an import) and an empty roster: the planner's closed
 * source set decides, and a unit write holds none of its sources.
 *   → { people: plan.create, unresolvedReferences }
 */
export function planUnitPeople({ entities, canonicalPeople, occupied = [] }) {
  const plan = planPersonRetention({ domain: { firstUnitEntities: entities }, roster: {}, canonicalPeople, prior: [], occupied });
  return { people: plan.create, unresolvedReferences: plan.unresolvedReferences };
}

function memoryVersionsPayload(versions) {
  return versions.map((v) => ({
    iri: v['@id'], version: v['scrum:version'] == null ? null : String(v['scrum:version']),
    body: str(v['scrum:body']), author: v.author ? asPerson(v.author) : null, dateCreated: str(v.dateCreated),
  }));
}
function memoryStatePayload(identity) {
  return {
    name: str(identity.name), tags: [].concat(identity['scrum:tag'] || []).map(String),
    priority: str(identity['scrum:priority']), currentVersion: identity['scrum:currentVersion'] || null,
    relatedTo: [].concat(identity['scrum:relatedTo'] || []).map(String),
  };
}
export function memoryCreateIntention({ actor, identity, versions, opId = opIri('memory'), people }) {
  return withPeople({
    kind: 'memory.create', opId, actor,
    memory: { iri: identity['@id'], identifier: str(identity.identifier), owner: identity['scrum:owner'] ? asPerson(identity['scrum:owner']) : null, ...memoryStatePayload(identity) },
    versions: memoryVersionsPayload(versions),
  }, people);
}
/** `newVersions` are ONLY the versions this write adds; `identity` is the WHOLE new mutable state. */
export function memoryReviseIntention({ actor, identity, newVersions, expectedRev, opId = opIri('memory'), people }) {
  return withPeople({
    kind: 'memory.revise', opId, actor,
    target: { iri: identity['@id'], expectedVersion: String(expectedRev) },
    set: memoryStatePayload(identity), versions: memoryVersionsPayload(newVersions),
  }, people);
}
export function decisionCreateIntention({ actor, entity, withRelations = true, opId = opIri('decision'), people }) {
  return withPeople({
    kind: 'decision.create', opId, actor,
    decision: {
      iri: entity['@id'], identifier: str(entity.identifier), statement: str(entity['scrum:statement']),
      decidedBy: entity['scrum:decidedBy'] ? asPerson(entity['scrum:decidedBy']) : null,
      constrains: [].concat(entity['scrum:constrains'] || []).map(String), reopensIf: str(entity['scrum:reopensIf']),
      dateCreated: str(entity.dateCreated),
      supersedes: withRelations ? [].concat(entity['scrum:supersedes'] || []).map(asDecision) : [],
      duplicateOf: withRelations ? [].concat(entity['scrum:duplicateOf'] || []).map(asDecision) : [],
    },
  }, people);
}
export function decisionRelateIntention({ actor, iri, supersedes = [], duplicateOf = [], opId = opIri('decision') }) {
  return { kind: 'decision.relate', opId, actor, target: iri, supersedes: supersedes.map(asDecision), duplicateOf: duplicateOf.map(asDecision) };
}
export const seatIri = (seat) => PERSON_BASE + seat;   // = projectSeatDeclarationEvent (not encoded)
export function seatDeclareIntention({ actor, seat, decl, iri, ends = null, at = null, endedAt = null, opId = opIri('seat'), people }) {
  return withPeople({
    kind: 'seat.declare', opId, actor, seat: seatIri(seat), ends, at,
    declaration: {
      iri, mode: String(decl.mode),
      ...(typeof decl.acceptsRoutineWork === 'boolean' ? { acceptsRoutineWork: String(decl.acceptsRoutineWork) } : {}),
      constraints: [].concat(decl.constraints || []).map(String),
      note: decl.note ? String(decl.note) : null, declaredAt: str(decl.declaredAt), expiresAt: decl.expiresAt ? String(decl.expiresAt) : null,
      role: decl.role ? (String(decl.role).startsWith('http') ? String(decl.role) : ROLE_IRI(decl.role)) : null,
      endedAt,
    },
  }, people);
}
export function seatClearIntention({ actor, seat, ends, at, opId = opIri('seat') }) {
  return { kind: 'seat.clear', opId, actor, seat: seatIri(seat), ends, at };
}

// ── executor reads ───────────────────────────────────────────────────────────

const I = (x) => `<${x}>`;
export const Q_MEMORIES = `SELECT ?s ?t ?p ?o WHERE { ?s ${I(TM.type)} ?t ; ?p ?o . VALUES ?t { ${I(TM.Memory)} ${I(TM.MemoryVersion)} } }`;
export const qOneMemory = (identifier) => `SELECT ?s ?t ?p ?o WHERE { ?m ${I(TM.type)} ${I(TM.Memory)} ; ${I(TM.identifier)} ${recLit(String(identifier))} . `
  + `{ BIND(?m AS ?s) } UNION { ?s ${I(TM.ofMemory)} ?m } ?s ${I(TM.type)} ?t ; ?p ?o . VALUES ?t { ${I(TM.Memory)} ${I(TM.MemoryVersion)} } }`;
/** One memory, its versions AND its revision nodes, in one query (one snapshot). */
export const qOneMemoryHistory = (identifier) => `SELECT ?s ?t ?p ?o WHERE { ?m ${I(TM.type)} ${I(TM.Memory)} ; ${I(TM.identifier)} ${recLit(String(identifier))} . `
  + `{ BIND(?m AS ?s) } UNION { ?s ${I(TM.ofMemory)} ?m } ?s ${I(TM.type)} ?t ; ?p ?o . VALUES ?t { ${I(TM.Memory)} ${I(TM.MemoryVersion)} ${I(TM.MemoryRevision)} } }`;
export const Q_DECISIONS = `SELECT ?d ?p ?o WHERE { ?d ${I(TM.type)} ${I(TM.Decision)} ; ?p ?o }`;
export const Q_OPEN_SEAT_DECLS = `SELECT ?d ?p ?o WHERE { ?d ${I(TM.type)} ${I(TM.SeatDeclaration)} ; ?p ?o FILTER NOT EXISTS { ?d ${I(TM.endedAt)} ?x } }`;

// #1570 — graph_query's copy of the unit's records (see replaceLogbornRecords in
// core/graph-replica.mjs). The executor's bookkeeping (`urn:ex:ver`,
// `urn:ex:recordedBy`) is excluded: the flag-OFF graph never carried it, and an
// unchanged query must return the same rows with the flag ON.
const MARKER = '<urn:ex:dataset>';
export const Q_POSITION = `SELECT ?e ?seq WHERE { ${MARKER} <urn:ex:epoch> ?e ; <urn:ex:commitSeq> ?seq }`;
export const Q_RECORD_TRIPLES = `SELECT ?s ?p ?o ?e ?seq WHERE { { ${MARKER} <urn:ex:epoch> ?e ; <urn:ex:commitSeq> ?seq } UNION `
  + `{ ?s ${I(TM.type)} ?t ; ?p ?o . VALUES ?t { ${I(TM.Memory)} ${I(TM.MemoryVersion)} ${I(TM.Decision)} ${I(TM.SeatDeclaration)} } `
  + 'FILTER(!STRSTARTS(STR(?p), "urn:ex:")) } }';

/** The replica's queryGraphAll shortening, for an IRI table passed in (graph-replica's IRI). */
export function makeShorten(iriTable) {
  const entries = Object.entries(iriTable);
  return (value) => {
    for (const [p, iri] of entries) if (value.startsWith(iri)) return `${p}:${value.slice(iri.length)}`;
    return value;
  };
}
/** Executor bindings → the plain rows the folds read (IRIs shortened, literals raw). */
export function plainRows(rows, shorten) {
  return rows.map((b) => Object.fromEntries(Object.entries(b).map(([k, t]) => [k, t.type === 'uri' ? shorten(t.value) : t.value])));
}
const unavailable = (why) => Object.assign(new Error(`graph executor unavailable: ${why}`), { code: 'GRAPH_EXECUTOR_UNAVAILABLE' });

/**
 * The unit's runtime: reads and writes through the slice's client, fenced.
 *   slice   { client, fence, trialBypass }   (core/graph-slice-routes.mjs)
 *   loadIri async () → graph-replica's IRI table (for the shortening; loaded lazily,
 *           as the server loads the replica module lazily)
 */
/** The default audit sink for unresolved Person references: one JSON line on stderr. */
export const stderrPersonAudit = (entry) => console.error(`[#1561 person-audit] ${JSON.stringify(entry)}`);

/** The typed first-unit entity nodes an intention references people through (for the planner). */
export function entitiesOfIntention(intention) {
  const out = [];
  if (intention.kind === 'memory.create') {
    out.push({ '@id': intention.memory.iri, '@type': 'scrum:Memory', ...(intention.memory.owner ? { 'scrum:owner': intention.memory.owner } : {}) });
  }
  if (intention.kind === 'memory.create' || intention.kind === 'memory.revise') {
    for (const v of intention.versions || []) out.push({ '@id': v.iri, '@type': 'scrum:MemoryVersion', ...(v.author ? { author: v.author } : {}) });
  }
  if (intention.kind === 'decision.create') {
    out.push({ '@id': intention.decision.iri, '@type': 'scrum:Decision', ...(intention.decision.decidedBy ? { 'scrum:decidedBy': intention.decision.decidedBy } : {}) });
  }
  if (intention.kind === 'seat.declare') {
    out.push({ '@id': intention.declaration.iri, '@type': 'scrum:SeatDeclaration', 'scrum:declaredSeat': intention.seat });
  }
  return out;
}

export function createLogbornUnit({ slice, loadIri, audit = stderrPersonAudit }) {
  let shorten = null;
  async function select(sparql) {
    shorten ??= makeShorten(await loadIri());
    const fenced = await slice.fence();
    if (fenced) throw unavailable(fenced);
    const r = await slice.client.query(sparql);
    if (!r.ok) throw unavailable(r.reason);
    return r.rows;
  }
  async function readMemories() {
    return memoriesFromRows(plainRows(await select(Q_MEMORIES), shorten));
  }
  /** One memory AND its write revision, from ONE query (one snapshot): {identity, versions, rev} or null. */
  async function readMemory(identifier) {
    const raw = await select(qOneMemory(identifier));
    const m = memoriesFromRows(plainRows(raw, shorten)).get(String(identifier));
    if (!m) return null;
    const verRow = raw.find((b) => b.p.value === TM.ver && shorten(b.s.value) === m.identity['@id']);
    return { ...m, rev: verRow ? Number(verRow.o.value) : null };
  }
  /** One memory with its identity history, from ONE query: {identity, versions, identities} or null. */
  async function readMemoryHistory(identifier) {
    const rows = plainRows(await select(qOneMemoryHistory(identifier)), shorten);
    const m = memoriesFromRows(rows).get(String(identifier));
    if (!m) return null;
    return { ...m, identities: collapseIdentities(identitiesFromRows(rows, m.identity['@id'])) };
  }
  async function readDecisions() {
    return decisionsFromRows(plainRows(await select(Q_DECISIONS), shorten));
  }
  /** The open declarations (the replica's shape) and, per seat, the open node's IRI. */
  async function readOpenSeatDecls() {
    const raw = await select(Q_OPEN_SEAT_DECLS);
    const iriBySeat = new Map();
    for (const b of raw) {
      if (b.p.value === TM.declaredSeat && b.o.value.startsWith(PERSON_BASE)) iriBySeat.set(decodeURIComponent(b.o.value.slice(PERSON_BASE.length)), b.d.value);
    }
    return { decls: declarationsFromRows(plainRows(raw, shorten)), iriBySeat };
  }
  /**
   * WHO is writing. Authenticated → `urn:ex:seat/<seat>`; a bypassed trial board's
   * unauthenticated write → TRIAL_UNBOUND_ACTOR; otherwise refused.
   */
  function actorFor(req, kind) {
    let a = req.auth;
    // #1561 launch (the owner 2026-10-04 18:40Z; reviewers 18:41Z): on a board
    // that is not in SCRUM_AUTH=required, THIS unit's writes still need a key. The
    // request's matched credential is judged exactly as required mode would judge
    // it, scope `act` included; a missing, unknown, expired, revoked or read-scope
    // key is refused. Nothing else on the board changes: req.auth keeps observe's
    // answer, and the graph slice routes keep #1559's rule.
    if (!(a && a.enforced === true) && !slice.trialBypass) {
      const d = authDecision({ binding: req.authBinding ?? null, mode: 'required', need: 'act' });
      if (!d.ok) return { refused: `${d.code}: ${d.error}`, status: d.status };
      a = d;
    }
    const authenticated = !!(a && a.enforced === true && a.seat);
    const actor = authenticated ? seatActor(a.seat) : TRIAL_UNBOUND_ACTOR;
    const refused = authorizeWrite({ auth: a, kind, actor, trialBypass: slice.trialBypass });
    return refused ? { refused } : { actor };
  }
  /**
   * The Person plan for a write: the graph's Person identities (one SELECT), then
   * the planner. `plan.create` rides the intention as `people` (bound by its digest);
   * unresolvedReferences go to the audit sink and are NEVER an authority.
   */
  async function planPeople(intention) {
    const entities = entitiesOfIntention(intention);
    if (!entities.length) return { intention, unresolvedReferences: [] };
    // only the person IRIs this write references: a unit write's plan.create is empty by
    // construction, so the identities it does not name cannot change its plan or its report
    const refs = [...new Set(entities.flatMap((e) => ['scrum:owner', 'author', 'scrum:decidedBy', 'scrum:declaredSeat']
      .map((k) => e[k]).filter((v) => typeof v === 'string').map(asPerson)))];
    if (!refs.length) return { intention, unresolvedReferences: [] };
    const values = `VALUES ?s { ${refs.map((r) => `<${r}>`).join(' ')} }`;
    const [pr, tr] = [await slice.client.query(`SELECT ?s ?p ?o WHERE { ${values} ?s <${RDF_TYPE}> <${TM.Person}> ; ?p ?o }`),
      await slice.client.query(`SELECT ?s ?t WHERE { ${values} ?s <${RDF_TYPE}> ?t }`)];
    if (!pr.ok) throw unavailable(pr.reason);
    if (!tr.ok) throw unavailable(tr.reason);
    const canonicalPeople = peopleFromRows(pr.rows.map((b) => ({ s: b.s.value, p: b.p.value, o: b.o.value })));
    const occupied = tr.rows.map((b) => ({ '@id': b.s.value, '@type': b.t.value === TM.Person ? 'Person' : b.t.value }));
    const plan = planUnitPeople({ entities, canonicalPeople, occupied });
    return { intention: withPeople(intention, plan.people), unresolvedReferences: plan.unresolvedReferences };
  }
  /** One intention → its outcome. UNKNOWN is reconciled by receipt, then replayed once if absent. */
  async function write(intention0) {
    const fenced = await slice.fence();
    if (fenced) return { outcome: 'UNAVAILABLE', reason: fenced };
    let intention, unresolvedReferences;
    try { ({ intention, unresolvedReferences } = await planPeople(intention0)); } catch (e) {
      if (e?.code === 'GRAPH_EXECUTOR_UNAVAILABLE') return { outcome: 'UNAVAILABLE', reason: e.message };
      throw e;
    }
    let r = await slice.client.update(intention);
    if (r.outcome === 'UNKNOWN') {
      const rc = await slice.client.reconcile(intention);
      if (rc.outcome === 'ABSENT') r = await slice.client.update(intention);
      else if (rc.outcome !== 'UNKNOWN') r = rc;
    }
    if (unresolvedReferences.length && r.outcome === 'APPLIED') {
      try { audit({ at: new Date().toISOString(), opId: intention.opId, kind: intention.kind, actor: intention.actor, unresolvedReferences }); } catch { /* an audit sink never fails a write that has already committed */ }
    }
    return { ...r, opId: intention.opId, kind: intention.kind, actor: intention.actor, people: intention.people || [], unresolvedReferences };
  }
  /** #1561 — one fenced SELECT, raw bindings (the change feed folds them: core/logborn-feed.mjs). */
  async function query(sparql) { return select(sparql); }
  /** #1570 — where the executor stands: `epoch:commitSeq`. Moves on EVERY applied write (and on a restore promotion). */
  async function position() {
    const raw = await select(Q_POSITION);
    if (raw.length !== 1) throw unavailable(`commit marker read returned ${raw.length} rows`);
    return `${raw[0].e.value}:${raw[0].seq.value}`;
  }
  /**
   * #1570 — every record of the unit's kinds, minus the executor's own `urn:ex:`
   * bookkeeping, AND the position they were read at, from ONE query (one snapshot):
   * { position, triples: [{s, p, o}] } with SPARQL-JSON terms.
   */
  async function readRecordTriples() {
    const raw = await select(Q_RECORD_TRIPLES);
    const pos = raw.filter((b) => b.seq);
    if (pos.length !== 1) throw unavailable(`commit marker read returned ${pos.length} rows`);
    return { position: `${pos[0].e.value}:${pos[0].seq.value}`, triples: raw.filter((b) => b.s).map(({ s, p, o }) => ({ s, p, o })) };
  }
  return { readMemories, readMemory, readMemoryHistory, readDecisions, readOpenSeatDecls, actorFor, write, query, position, readRecordTriples };
}
