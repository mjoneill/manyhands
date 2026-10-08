#!/usr/bin/env node
/**
 * #1561 — COPY THE LOG-BORN RECORDS (memory, decision, seat-state) FROM A BOARD
 * INTO A GRAPH EXECUTOR STORE, and verify the copy BOTH WAYS.
 *
 * SOURCE is what a flag-OFF server reads today: the board document projected by
 * the replica (rows an older document still carries) PLUS the event log projected
 * by projectActivities (everything born in the log). It is built here, in memory,
 * with the replica's own functions — the same code that serves the reads.
 *
 * Records are compared at the TRIPLE level (subject, predicate, object; the
 * executor's own `urn:ex:` bookkeeping excluded), and again as the FOLDED shapes
 * the API serves (memoriesFromRows, decisionsFromRows, declarationsFromRows).
 *
 *   default   DRY RUN: builds the source, reads the target, prints the plan,
 *             writes NOTHING.
 *   --run     preflight, then one guarded intention per record, then verify.
 *   --verify  verify only (no writes): source ⇄ target.
 *
 * REFUSES (exit 1, and before any write where it can know in advance) when:
 *   - the source holds what the record kinds cannot carry faithfully: an unknown
 *     predicate, a typed or language-tagged literal, two values for a
 *     single-valued field, a version of no memory, two open declarations for one seat;
 *   - the target already holds a record of these kinds that the source does not,
 *     or holds one with the same IRI and different content;
 *   - any write is not APPLIED;
 *   - after writing, counts or content differ in EITHER direction.
 *
 * Identity history (#1561, RECORD_V 2): the event log holds every prior title/tags/priority
 * of a log-born memory (each event carries the whole state). The memory is created with its
 * FIRST state and then revised once per later state, so the target holds the same revision
 * nodes the unit writes; verification compares the sequences (collapsed, as the API serves
 * them) source ⇄ target. Body versions are all carried by the create, as before, so the
 * revision nodes' priorCurrentVersion is the final one, not the historical one (not served).
 *
 * PERSON IDENTITIES (#1561, a reviewer's contract docs/graph-person-retention.md):
 * before the records, ONE guarded, receipted `person.import` materialises the
 * planner's `plan.create` — planned from the board document's Person nodes
 * (`prior: domain.people ?? []`, passed explicitly), the closed source set
 * (assignees, post authors, createdBy) and the event-born records as typed
 * `domain.firstUnitEntities`, against the target's existing Person identities
 * (canonical: they win, are never rewritten, and are never deleted). Its opId is
 * the hash of its payload. The planner's `unresolvedReferences` (owners, deciders,
 * seats with no identity) are NOT minted: they go to the AUDIT SURFACE — the
 * `audit` callback, which the CLI writes as a JSON file (`--audit <file>`,
 * required with --run) together with the import's opId and digest.
 * Verification, both ways: every Person the import recorded equals, triple for
 * triple, what the plan says it creates, and every planned identity is a Person
 * in the target.
 *
 * Idempotent: every intention has a deterministic opId (the record's IRI, hashed),
 * so a rerun replays (and a record already present with equal content is skipped).
 * Relations (memory relatedTo, decision supersedes/duplicateOf) are written in a
 * second pass, after every record exists. A run that STOPS between the passes
 * leaves records whose content differs from the source, which the preflight then
 * refuses: discard that target store and run again (it is not resumable mid-pass).
 * Rollback: the target store is new; discard it. Nothing in the board is written.
 *
 * It talks to the executor DIRECTLY (localhost), as `--actor` (a urn:ex:seat/<seat>
 * IRI): the operator running it. The server's per-request auth is not involved.
 *
 *   node scripts/migrate-logborn-1561.mjs --board <board-data.json> [--events <dir>] \
 *     --executor http://127.0.0.1:<port> --dataset-id <id> --actor urn:ex:seat/<you> [--roster <roster.json>] \
 *     [--run --audit <file> | --verify]
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadDomain } from '../core/store.mjs';
import { domainToJsonLd } from '../core/jsonld.mjs';
import { readEvents } from '../core/event-log.mjs';
import { buildGraphStore, projectActivities, IRI } from '../core/graph-replica.mjs';
import { createGraphClient } from '../core/graph-client.mjs';
import { LOGBORN_TERMS as TM } from '../core/graph-compiler.mjs';
import { NS, BK } from '../core/graph-vocab.mjs';
import { memoriesFromRows, decisionsFromRows, makeShorten, identitiesFromEvents, identitiesFromRows, identityOf, collapseIdentities, peopleFromRows, Q_PERSON_IRI_TYPES } from '../core/logborn-unit.mjs';
import { declarationsFromRows } from '../core/seat-state.mjs';
import { planPersonRetention } from '../core/graph-people.mjs';
import { loadRoster } from '../core/roster-config.mjs';

const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';
const TYPES = { [TM.Memory]: 'memory', [TM.MemoryVersion]: 'version', [TM.Decision]: 'decision', [TM.SeatDeclaration]: 'seat' };
const Q_RECORDS = `SELECT ?s ?p ?o WHERE { ?s <${TM.type}> ?t ; ?p ?o . VALUES ?t { ${Object.keys(TYPES).map((t) => `<${t}>`).join(' ')} } }`;
// #1638 — the TARGET lives in an executor, where a record's domain triples are in the default graph and its write revision
// and provenance (ver, recordedBy, retiredBy) are bookkeeping in the named graph. The SOURCE is an in-memory store with no
// named graph, so it keeps Q_RECORDS; the target reads the same rows through this two-branch union (same shape).
// #1638 — the stamps live ONLY in the bookkeeping graph: the default-graph branch excludes them, the bookkeeping branch is
// the only place they are read from, and refuseMisplacedStamps() refuses a target that carries one in the default graph.
const STAMP_IN = `<${TM.ver}>, <${TM.recordedBy}>, <${NS}retiredBy>`;
const RECORD_TYPES = `VALUES ?t { ${Object.keys(TYPES).map((t) => `<${t}>`).join(' ')} }`;
async function refuseMisplacedStamps(client, typeClause, what) {
  const r = await client.query(`SELECT ?s ?p WHERE { ${typeClause} ?s ?p ?o FILTER(?p IN (${STAMP_IN})) } LIMIT 5`);
  if (!r.ok) throw new Error(`target unreadable: ${r.reason}`);
  if (r.rows.length) throw new Error(`target has bookkeeping in the DEFAULT graph on ${what} (misplaced; it belongs in ${BK}): ${r.rows.map((b) => `${b.s.value} ${b.p.value}`).join('; ')}`);
}
const Q_RECORDS_TARGET = `SELECT ?s ?p ?o WHERE { { ?s <${TM.type}> ?t ; ?p ?o . ${RECORD_TYPES} FILTER(?p NOT IN (${STAMP_IN})) }
  UNION { ?s <${TM.type}> ?t . VALUES ?t { ${Object.keys(TYPES).map((t) => `<${t}>`).join(' ')} } GRAPH ${BK} { ?s ?p ?o FILTER(?p IN (<${TM.ver}>, <${TM.recordedBy}>, <${NS}retiredBy>)) } } }`;

// predicate → 'one' | 'many', per record type. Anything else on a record is REFUSED.
const SHAPE = {
  memory: { [TM.type]: 'one', [TM.identifier]: 'one', [TM.name]: 'one', [TM.owner]: 'one', [TM.tag]: 'many', [TM.priority]: 'one', [TM.currentVersion]: 'one', [TM.relatedTo]: 'many' },
  version: { [TM.type]: 'one', [TM.ofMemory]: 'one', [TM.version]: 'one', [TM.body]: 'one', [TM.author]: 'one', [TM.dateCreated]: 'one' },
  decision: { [TM.type]: 'one', [TM.identifier]: 'one', [TM.statement]: 'one', [TM.decidedBy]: 'one', [TM.constrains]: 'many', [TM.reopensIf]: 'one', [TM.dateCreated]: 'one', [TM.supersedes]: 'many', [TM.duplicateOf]: 'many' },
  seat: { [TM.type]: 'one', [TM.declaredSeat]: 'one', [TM.mode]: 'one', [TM.acceptsRoutineWork]: 'one', [TM.constraint]: 'many', [TM.note]: 'one', [TM.declaredAt]: 'one', [TM.expiresAt]: 'one', [TM.role]: 'one', [TM.endedAt]: 'one' },
};
const LITERAL_PREDS = new Set([TM.identifier, TM.name, TM.tag, TM.priority, TM.version, TM.body, TM.dateCreated, TM.statement, TM.constrains, TM.reopensIf,
  TM.mode, TM.acceptsRoutineWork, TM.constraint, TM.note, TM.declaredAt, TM.expiresAt, TM.endedAt]);

/** A term as comparable text: <iri> or a JSON string; typed/tagged literals keep their type so they never compare equal to plain. */
const termText = ({ kind, value, datatype, lang }) => (kind === 'uri' ? `<${value}>`
  : `${JSON.stringify(value)}${lang ? `@${lang}` : datatype && datatype !== XSD_STRING ? `^^<${datatype}>` : ''}`);

// ── reading both sides into one shape: [{s, p, o:{kind,value,datatype,lang}}] ──
export function buildSource({ board, events }) {
  const store = buildGraphStore(domainToJsonLd(loadDomain(board)));
  if (events) projectActivities(store, Array.isArray(events) ? events : readEvents(events));
  const out = [];
  for (const b of store.query(Q_RECORDS)) {
    const o = b.get('o');
    out.push({ s: b.get('s').value, p: b.get('p').value,
      o: o.termType === 'NamedNode' ? { kind: 'uri', value: o.value } : o.termType === 'Literal' ? { kind: 'lit', value: o.value, datatype: o.datatype?.value, lang: o.language || null } : { kind: 'bnode', value: o.value } });
  }
  return out;
}
export async function readTarget(client) {
  await refuseMisplacedStamps(client, `?s <${TM.type}> ?t . ${RECORD_TYPES}`, 'a log-born record');
  const r = await client.query(Q_RECORDS_TARGET);
  if (!r.ok) throw new Error(`target unreadable: ${r.reason}`);
  return r.rows.map((b) => ({ s: b.s.value, p: b.p.value,
    o: b.o.type === 'uri' ? { kind: 'uri', value: b.o.value } : b.o.type === 'literal' ? { kind: 'lit', value: b.o.value, datatype: b.o.datatype, lang: b.o['xml:lang'] || null } : { kind: 'bnode', value: b.o.value } }));
}

/** Triples → Map<subject, {type, triples:Set<text>, byPred:Map<p, terms[]>}>; executor bookkeeping (urn:ex:) dropped. */
export function groupRecords(triples) {
  const recs = new Map();
  for (const t of triples) {
    if (t.p.startsWith(NS)) continue;
    let r = recs.get(t.s);
    if (!r) { r = { s: t.s, type: null, triples: new Set(), byPred: new Map() }; recs.set(t.s, r); }
    r.triples.add(`<${t.p}> ${termText(t.o)}`);
    if (!r.byPred.has(t.p)) r.byPred.set(t.p, []);
    r.byPred.get(t.p).push(t.o);
    if (t.p === TM.type && TYPES[t.o.value]) r.type = TYPES[t.o.value];
  }
  return recs;
}

/** What the record kinds cannot carry faithfully. Every entry is a refusal. */
export function shapeProblems(recs) {
  const problems = [];
  const memories = new Set([...recs.values()].filter((r) => r.type === 'memory').map((r) => r.s));
  const openBySeat = new Map();
  for (const r of recs.values()) {
    const shape = SHAPE[r.type];
    for (const [p, terms] of r.byPred) {
      if (!shape[p]) { problems.push(`${r.s}: predicate ${p} is not one the ${r.type} kind carries`); continue; }
      if (shape[p] === 'one' && terms.length > 1) problems.push(`${r.s}: ${terms.length} values for single-valued ${p}`);
      for (const o of terms) {
        if (o.kind === 'bnode') problems.push(`${r.s}: a blank node under ${p}`);
        else if (LITERAL_PREDS.has(p) !== (o.kind === 'lit')) problems.push(`${r.s}: ${p} has a ${o.kind} where the kind writes ${LITERAL_PREDS.has(p) ? 'a literal' : 'an IRI'}`);
        else if (o.kind === 'lit' && (o.lang || (o.datatype && o.datatype !== XSD_STRING))) problems.push(`${r.s}: ${p} is a typed or tagged literal (${termText(o)}); the kinds write plain strings`);
      }
    }
    if (r.type === 'version') {
      const of = r.byPred.get(TM.ofMemory)?.[0]?.value;
      if (!of || !memories.has(of)) problems.push(`${r.s}: a memory version of no memory (${of ?? 'none'}): the API cannot read it and the kind cannot write it`);
    }
    if (r.type === 'seat' && !r.byPred.has(TM.endedAt)) {
      const seat = r.byPred.get(TM.declaredSeat)?.[0]?.value;
      if (openBySeat.has(seat)) problems.push(`${seat}: two open declarations (${openBySeat.get(seat)}, ${r.s})`);
      openBySeat.set(seat, r.s);
    }
    if (r.type === 'seat' && !r.byPred.has(TM.mode)) problems.push(`${r.s}: a declaration with no mode`);
  }
  return problems;
}

// ── records → intentions (deterministic opIds) ──
const one = (r, p) => r.byPred.get(p)?.[0]?.value ?? null;
const many = (r, p) => (r.byPred.get(p) || []).map((o) => o.value);
const opFor = (kind, iri) => `${NS}op/migrate-1561/${kind}/${crypto.createHash('sha256').update(iri).digest('hex').slice(0, 32)}`;

/** Per source memory: the identity states (collapsed), oldest first, ending in the source's current state. */
export function sourceHistories(recs, eventList = []) {
  const out = new Map();
  for (const r of recs.values()) if (r.type === 'memory') {
    const current = identityOf({ name: one(r, TM.name), 'scrum:tag': many(r, TM.tag), 'scrum:priority': one(r, TM.priority) });
    out.set(r.s, collapseIdentities([...identitiesFromEvents(eventList, r.s), current]));
  }
  return out;
}
const Q_HISTORY = `SELECT ?s ?t ?p ?o WHERE { ?s <${TM.type}> ?t ; ?p ?o . VALUES ?t { <${TM.Memory}> <${TM.MemoryRevision}> } }`;
/** The target's identity history per memory (revision nodes + current), collapsed; and revision nodes of no memory. */
export async function targetHistories(client) {
  const r = await client.query(Q_HISTORY);
  if (!r.ok) throw new Error(`target unreadable: ${r.reason}`);
  const rows = r.rows.map((b) => ({ s: b.s.value, t: b.t.value, p: b.p.value, o: b.o.value }));
  const mems = new Set(rows.filter((x) => x.t === TM.Memory).map((x) => x.s));
  const orphans = [...new Set(rows.filter((x) => x.t === TM.MemoryRevision && x.p === TM.ofMemory && !mems.has(x.o)).map((x) => x.s))];
  return { byMemory: new Map([...mems].map((m) => [m, collapseIdentities(identitiesFromRows(rows, m))])), orphans };
}

export function intentionsFor(recs, actor, histories = sourceHistories(recs)) {
  const list = [...recs.values()].sort((a, b) => (a.s < b.s ? -1 : 1));
  const out = { creates: [], history: [], relates: [] };
  const versionsOf = new Map();
  for (const r of list) if (r.type === 'version') {
    const m = one(r, TM.ofMemory);
    if (!versionsOf.has(m)) versionsOf.set(m, []);
    versionsOf.get(m).push({ iri: r.s, version: one(r, TM.version), body: one(r, TM.body), author: one(r, TM.author), dateCreated: one(r, TM.dateCreated) });
  }
  for (const r of list) {
    if (r.type === 'memory') {
      const state = { name: one(r, TM.name), tags: many(r, TM.tag), priority: one(r, TM.priority), currentVersion: one(r, TM.currentVersion) };
      // the identity history: created in its FIRST state, revised once per later state
      const states = histories.get(r.s) || [identityOf({ name: state.name, 'scrum:tag': state.tags, 'scrum:priority': state.priority })];
      const asState = (e) => ({ name: e.title, tags: e.tags, priority: e.priority, currentVersion: state.currentVersion });
      out.creates.push({ record: r.s, intention: { kind: 'memory.create', opId: opFor('memory', r.s), actor,
        memory: { iri: r.s, identifier: one(r, TM.identifier), owner: one(r, TM.owner), ...asState(states[0]), relatedTo: [] },
        versions: versionsOf.get(r.s) || [] } });
      for (let i = 1; i < states.length; i++) {
        out.history.push({ record: r.s, intention: { kind: 'memory.revise', opId: opFor(`memory-history-${i}`, r.s), actor,
          target: { iri: r.s, expectedVersion: String(i) }, set: { ...asState(states[i]), relatedTo: [] }, versions: [] } });
      }
      // relatedTo in a last pass, like decision relations: an edge naming a memory not yet
      // created would make that memory's IRI non-fresh, and its own create would be refused.
      // ONE guarded revise at the write revision the history left, carrying the whole state.
      if (r.byPred.has(TM.relatedTo)) {
        out.relates.push({ record: r.s, intention: { kind: 'memory.revise', opId: opFor('memory-relations', r.s), actor,
          target: { iri: r.s, expectedVersion: String(states.length) }, set: { ...state, relatedTo: many(r, TM.relatedTo) }, versions: [] } });
      }
    } else if (r.type === 'decision') {
      out.creates.push({ record: r.s, intention: { kind: 'decision.create', opId: opFor('decision', r.s), actor,
        decision: { iri: r.s, identifier: one(r, TM.identifier), statement: one(r, TM.statement), decidedBy: one(r, TM.decidedBy),
          constrains: many(r, TM.constrains), reopensIf: one(r, TM.reopensIf), dateCreated: one(r, TM.dateCreated), supersedes: [], duplicateOf: [] } } });
      // relations in a second pass: an edge may name a decision created later in the walk
      if (r.byPred.has(TM.supersedes) || r.byPred.has(TM.duplicateOf)) {
        out.relates.push({ record: r.s, intention: { kind: 'decision.relate', opId: opFor('decision-relations', r.s), actor,
          target: r.s, supersedes: many(r, TM.supersedes), duplicateOf: many(r, TM.duplicateOf) } });
      }
    } else if (r.type === 'seat') {
      out.creates.push({ record: r.s, intention: { kind: 'seat.declare', opId: opFor('seat', r.s), actor, seat: one(r, TM.declaredSeat), ends: null, at: null,
        declaration: { iri: r.s, mode: one(r, TM.mode), acceptsRoutineWork: one(r, TM.acceptsRoutineWork), constraints: many(r, TM.constraint),
          note: one(r, TM.note), declaredAt: one(r, TM.declaredAt), expiresAt: one(r, TM.expiresAt), role: one(r, TM.role), endedAt: one(r, TM.endedAt) } } });
    }
  }
  return out;
}

// ── Person identities ──
export const PEOPLE_OP_PREFIX = `${NS}op/migrate-1561/people/`;
/** The import's opId: a function of its payload, so a rerun with the same plan replays and a different plan is a different op. */
export const peopleOpFor = (create) => `${PEOPLE_OP_PREFIX}${crypto.createHash('sha256').update(JSON.stringify(create)).digest('hex').slice(0, 32)}`;

/** The source records as typed first-unit entity nodes (the planner's `domain.firstUnitEntities`). */
export function firstUnitEntitiesOf(recs) {
  const out = [];
  for (const r of recs.values()) {
    const e = { '@id': r.s };
    if (r.type === 'memory') Object.assign(e, { '@type': 'scrum:Memory' }, one(r, TM.owner) ? { 'scrum:owner': one(r, TM.owner) } : {});
    else if (r.type === 'version') Object.assign(e, { '@type': 'scrum:MemoryVersion' }, one(r, TM.author) ? { author: one(r, TM.author) } : {});
    else if (r.type === 'decision') Object.assign(e, { '@type': 'scrum:Decision' }, one(r, TM.decidedBy) ? { 'scrum:decidedBy': one(r, TM.decidedBy) } : {});
    else if (r.type === 'seat') Object.assign(e, { '@type': 'scrum:SeatDeclaration' }, one(r, TM.declaredSeat) ? { 'scrum:declaredSeat': one(r, TM.declaredSeat) } : {});
    else continue;
    out.push(e);
  }
  return out;
}

/** The target's Person identities: canonical nodes, Person-IRI types (occupied), and which import op recorded each. */
// #1638 — Q_PEOPLE (core) reads the default graph only; this script also needs each Person's recordedBy (which import op
// wrote it), now bookkeeping in the named graph. Same rows as before: the domain triples plus ver/recordedBy/retiredBy.
const Q_PEOPLE_TARGET = `SELECT ?s ?p ?o WHERE { { ?s <${TM.type}> <${TM.Person}> ; ?p ?o FILTER(?p NOT IN (${STAMP_IN})) }
  UNION { ?s <${TM.type}> <${TM.Person}> . GRAPH ${BK} { ?s ?p ?o FILTER(?p IN (<${TM.ver}>, <${TM.recordedBy}>, <${NS}retiredBy>)) } } }`;
export async function readTargetPeople(client) {
  await refuseMisplacedStamps(client, `?s <${TM.type}> <${TM.Person}> .`, 'a Person');
  const pr = await client.query(Q_PEOPLE_TARGET);
  if (!pr.ok) throw new Error(`target unreadable: ${pr.reason}`);
  const tr = await client.query(Q_PERSON_IRI_TYPES);
  if (!tr.ok) throw new Error(`target unreadable: ${tr.reason}`);
  const rows = pr.rows.map((b) => ({ s: b.s.value, p: b.p.value, o: b.o.value, ot: b.o.type }));
  const triples = new Map();   // iri → Set of '<p> term' (executor bookkeeping excluded)
  const recordedBy = new Map();
  for (const r of rows) {
    if (r.p === TM.recordedBy) { recordedBy.set(r.s, [...(recordedBy.get(r.s) || []), r.o]); continue; }
    if (r.p.startsWith(NS)) continue;
    if (!triples.has(r.s)) triples.set(r.s, new Set());
    triples.get(r.s).add(`<${r.p}> ${r.ot === 'uri' ? `<${r.o}>` : JSON.stringify(r.o)}`);
  }
  return {
    canonical: peopleFromRows(rows), triples, recordedBy,
    occupied: tr.rows.map((b) => ({ '@id': b.s.value, '@type': b.t.value === TM.Person ? 'Person' : b.t.value })),
  };
}
/** The triples the compiler writes for one planned Person (person.import), in readTargetPeople's text form. */
export function plannedPersonTriples(p) {
  const t = new Set([`<${TM.type}> <${TM.Person}>`, `<${TM.identifier}> ${JSON.stringify(p.identifier)}`]);
  if (p.name != null) t.add(`<${TM.name}> ${JSON.stringify(p.name)}`);
  if (p['scrum:glyph'] != null) t.add(`<${TM.glyph}> ${JSON.stringify(p['scrum:glyph'])}`);
  if (typeof p['scrum:resolved'] === 'boolean') t.add(`<${TM.resolved}> ${JSON.stringify(String(p['scrum:resolved']))}`);
  for (const a of p['scrum:aliases'] || []) t.add(`<${TM.aliases}> ${JSON.stringify(a)}`);
  return t;
}
/**
 * The Person plan. `canonicalPeople` are the target's identities NOT recorded by an
 * earlier run of this import (those were canonical before the migration touched the
 * store), so a rerun and a verify re-derive the SAME `create` the run wrote.
 */
export function planPeople({ legacy, src, target, roster }) {
  const imported = (iri) => (target.recordedBy.get(iri) || []).some((op) => op.startsWith(PEOPLE_OP_PREFIX));
  const canonicalPeople = target.canonical.filter((p) => !imported(p['@id']));
  const plan = planPersonRetention({
    domain: { ...legacy, firstUnitEntities: firstUnitEntitiesOf(src) },
    roster, canonicalPeople, prior: legacy.people ?? [], occupied: target.occupied,
  });
  // the legacy collections and firstUnitEntities can name the same reference: one line each
  const seen = new Set();
  const unresolvedReferences = plan.unresolvedReferences.filter((u) => { const k = `${u.source}|${u.predicate}|${u.identifier}`; if (seen.has(k)) return false; seen.add(k); return true; });
  return { ...plan, unresolvedReferences, imported };
}
/** Both ways: what the import recorded = what the plan creates (triple for triple); every planned identity is a Person. */
export function comparePeople(plan, target) {
  const diffs = [];
  const want = new Map(plan.create.map((p) => [p['@id'], p]));
  const got = [...target.triples.keys()].filter((iri) => plan.imported(iri));
  for (const [iri, p] of want) {
    const have = target.triples.get(iri);
    if (!have || !plan.imported(iri)) { diffs.push(`person source→target: ${iri} was not imported`); continue; }
    const missing = [...plannedPersonTriples(p)].filter((t) => !have.has(t));
    if (missing.length) diffs.push(`person source→target: ${iri} lacks ${missing.join(' | ')}`);
  }
  for (const iri of got) {
    const p = want.get(iri);
    if (!p) { diffs.push(`person target→source: ${iri} was imported but the plan does not create it`); continue; }
    const expected = plannedPersonTriples(p);
    const extra = [...target.triples.get(iri)].filter((t) => !expected.has(t));
    if (extra.length) diffs.push(`person target→source: ${iri} holds ${extra.join(' | ')}`);
  }
  const persons = new Set(target.canonical.map((p) => p['@id']));
  for (const p of plan.people) if (!persons.has(p['@id'])) diffs.push(`person: planned identity ${p['@id']} is not a Person in the target`);
  return diffs;
}

// ── verification, both ways ──
/** Every source record in the target with the same triples, and every target record in the source with the same triples. */
export function compareRecords(src, tgt) {
  const diffs = [];
  const counts = (recs) => Object.fromEntries(Object.values(TYPES).map((t) => [t, [...recs.values()].filter((r) => r.type === t).length]));
  const cs = counts(src), ct = counts(tgt);
  for (const k of Object.keys(cs)) if (cs[k] !== ct[k]) diffs.push(`count ${k}: source ${cs[k]}, target ${ct[k]}`);
  for (const [dir, a, b] of [['source→target', src, tgt], ['target→source', tgt, src]]) {
    for (const r of a.values()) {
      const o = b.get(r.s);
      if (!o) { diffs.push(`${dir}: ${r.s} is missing`); continue; }
      const missing = [...r.triples].filter((t) => !o.triples.has(t));
      if (missing.length) diffs.push(`${dir}: ${r.s} lacks ${missing.slice(0, 3).join(' | ')}${missing.length > 3 ? ` (+${missing.length - 3})` : ''}`);
    }
  }
  return { diffs, counts: { source: cs, target: ct } };
}
/** The folded shapes the API serves, from each side. Differences here are what a reader would see. */
export function compareFolds(srcTriples, tgtTriples) {
  const shorten = makeShorten(IRI);
  const rows = (ts, cols) => ts.filter((t) => !t.p.startsWith(NS)).map((t) => {
    const o = t.o.kind === 'uri' ? shorten(t.o.value) : t.o.value;
    return cols === 'mem' ? { s: shorten(t.s), p: shorten(t.p), o } : { d: shorten(t.s), p: shorten(t.p), o };
  });
  const typed = (ts, type) => { const subj = new Set(ts.filter((t) => t.p === TM.type && t.o.value === type).map((t) => t.s)); return ts.filter((t) => subj.has(t.s)); };
  const memRows = (ts) => {
    const out = [];
    for (const t of rows([...typed(ts, TM.Memory), ...typed(ts, TM.MemoryVersion)], 'mem')) out.push(t);
    // memoriesFromRows wants ?t per row: attach the subject's type
    const typeOf = new Map(ts.filter((t) => t.p === TM.type).map((t) => [shorten(t.s), shorten(t.o.value)]));
    return out.map((r) => ({ ...r, t: typeOf.get(r.s) }));
  };
  const openSeat = (ts) => { const ended = new Set(ts.filter((t) => t.p === TM.endedAt).map((t) => t.s)); return typed(ts, TM.SeatDeclaration).filter((t) => !ended.has(t.s)); };
  const sortKeys = (x) => JSON.stringify(x, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v));
  const memWire = (ts) => [...memoriesFromRows(memRows(ts)).entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const decWire = (ts) => decisionsFromRows(rows(typed(ts, TM.Decision))).sort((a, b) => (a['@id'] < b['@id'] ? -1 : 1));
  // constraints are a set in both stores, folded in row order: compared as a set (#1561 rollback found it)
  const seatWire = (ts) => declarationsFromRows(rows(openSeat(ts))).map((d) => ({ ...d, constraints: [...d.constraints].sort() })).sort((a, b) => (a.seat < b.seat ? -1 : 1));
  const diffs = [];
  for (const [name, f] of [['memories', memWire], ['decisions', decWire], ['open seat declarations', seatWire]]) {
    if (sortKeys(f(srcTriples)) !== sortKeys(f(tgtTriples))) diffs.push(`folded ${name} differ between source and target`);
  }
  return diffs;
}

// ── the run ──
export async function migrate({ board, events = null, client, actor, mode = 'dry-run', roster = {}, audit = null, log = () => {} }) {
  const report = { mode, refused: null, planned: 0, written: 0, skipped: 0, counts: null, diffs: [], people: null };
  const refuse = (why, extra = {}) => Object.assign(report, { refused: why, ...extra });
  const id = await client.datasetIdentity();
  if (!id.ok) return refuse(`target identity: ${id.reason}`);
  const eventList = events ? readEvents(events) : [];
  const srcTriples = buildSource({ board, events: eventList });
  const src = groupRecords(srcTriples);
  const problems = shapeProblems(src);
  if (problems.length) return refuse('the source holds records the kinds cannot carry faithfully', { diffs: problems });
  const histories = sourceHistories(src, eventList);
  const legacy = loadDomain(board);
  const personPlan = async () => {
    const target = await readTargetPeople(client);
    let plan;
    try { plan = planPeople({ legacy, src, target, roster }); } catch (e) { return { error: e.message }; }
    return { plan, target };
  };

  const verify = async () => {
    const tgtTriples = await readTarget(client);
    const cmp = compareRecords(src, groupRecords(tgtTriples));
    report.counts = cmp.counts;
    report.diffs = [...cmp.diffs, ...compareFolds(srcTriples, tgtTriples)];
    const vers = tgtTriples.filter((t) => t.p === TM.ver).map((t) => t.s);
    for (const r of src.values()) if (r.type === 'memory' && !vers.includes(r.s)) report.diffs.push(`${r.s}: no write revision (urn:ex:ver) in the target: the unit could not revise it`);
    // the identity history, both ways: every source memory's sequence equals the target's,
    // and the target holds no revision node of a memory outside the source
    const th = await targetHistories(client);
    for (const [m, want] of histories) {
      const got = th.byMemory.get(m) || [];
      if (JSON.stringify(got) !== JSON.stringify(want)) report.diffs.push(`${m}: identity history differs (source ${want.length} states: ${want.map((e) => JSON.stringify(e.title)).join(' → ')}; target ${got.length}: ${got.map((e) => JSON.stringify(e.title)).join(' → ')})`);
    }
    for (const o of th.orphans) report.diffs.push(`target→source: revision node ${o} of no memory`);
    const pp = await personPlan();
    if (pp.error) report.diffs.push(`person plan: ${pp.error}`);
    else report.diffs.push(...comparePeople(pp.plan, pp.target));
    if (report.diffs.length) return refuse('verification failed');
    return report;
  };
  if (mode === 'verify') return verify();

  // preflight: what the target already holds
  const tgt = groupRecords(await readTarget(client));
  const extra = [...tgt.values()].filter((r) => !src.has(r.s)).map((r) => `target holds ${r.type ?? 'a record'} ${r.s} that the source does not`);
  const differing = [...tgt.values()].filter((r) => src.has(r.s)).filter((r) => {
    const s = src.get(r.s);
    return s.triples.size !== r.triples.size || [...s.triples].some((t) => !r.triples.has(t));
  }).map((r) => `target holds ${r.s} with different content`);
  if (extra.length || differing.length) return refuse('the target is not a prefix of the source', { diffs: [...extra, ...differing] });

  const pp = await personPlan();
  if (pp.error) return refuse('the Person plan refused', { diffs: [pp.error] });
  const { plan: people } = pp;
  // already imported by an earlier run (same payload ⇒ same opId): nothing to write
  const pending = people.create.filter((p) => !people.imported(p['@id']));
  const personImport = pending.length ? { kind: 'person.import', opId: peopleOpFor(pending), actor, people: pending } : null;
  report.people = { create: pending.length, retained: people.retained.length, unresolvedReferences: people.unresolvedReferences, opId: personImport?.opId ?? null };

  const plan = intentionsFor(src, actor, histories);
  const all = [...plan.creates, ...plan.history, ...plan.relates];
  const todo = all.filter((x) => !tgt.has(x.record));
  report.planned = todo.length + (personImport ? 1 : 0);
  report.skipped = all.length - todo.length;
  log(`source: ${src.size} records · target already holds ${tgt.size} · to write: ${todo.length} intentions + ${personImport ? `1 person.import (${pending.length} identities)` : 'no person.import'} · unresolved person references: ${people.unresolvedReferences.length}`);
  if (mode !== 'run') return report;

  if (personImport) {
    const r = await client.update(personImport);
    if (r.outcome !== 'APPLIED') return refuse(`write person.import: ${r.outcome}${r.reason ? ` (${r.reason})` : ''}`);
    report.written += 1;
    report.people.digest = r.digest ?? null;
  }
  if (audit) audit({ opId: report.people.opId, digest: report.people.digest ?? null, actor, create: report.people.create, retained: report.people.retained, unresolvedReferences: people.unresolvedReferences });

  for (const { record, intention } of todo) {
    const r = await client.update(intention);
    if (r.outcome !== 'APPLIED') return refuse(`write ${intention.kind} for ${record}: ${r.outcome}${r.reason ? ` (${r.reason})` : ''}`);
    report.written += 1;
  }
  return verify();
}

// ── CLI ──
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const board = opt('--board'), executor = opt('--executor'), datasetId = opt('--dataset-id'), actor = opt('--actor'), auditFile = opt('--audit'), rosterFile = opt('--roster');
  const events = opt('--events') ?? (board ? `${board.replace(/\.json$/, '')}-events` : null);
  if (!board || !executor || !datasetId || !actor?.startsWith('urn:ex:seat/')) {
    console.error('usage: --board <file> --executor <url> --dataset-id <id> --actor urn:ex:seat/<you> [--events <dir>] [--run | --verify]');
    process.exit(2);
  }
  const mode = args.includes('--run') ? 'run' : args.includes('--verify') ? 'verify' : 'dry-run';
  if (mode === 'run' && !auditFile) { console.error('--run needs --audit <file>: the unresolved Person references are written there'); process.exit(2); }
  const roster = rosterFile ? { seats: loadRoster(rosterFile, (w) => console.error(`roster: ${w}`)) ?? {} } : {};
  const client = createGraphClient({ baseUrl: executor, expectedDatasetId: datasetId, timeoutMs: 60000 });
  const audit = auditFile ? (entry) => {
    fs.writeFileSync(auditFile, JSON.stringify({ at: new Date().toISOString(), datasetId, board, ...entry }, null, 2));
  } : null;
  const report = await migrate({ board, events, client, actor, mode, roster, audit, log: (s) => console.error(s) });
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.refused ? 1 : 0);
}
