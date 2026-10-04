#!/usr/bin/env node
/**
 * #1561 — ROLL BACK THE LOG-BORN UNIT: turn SCRUM_GRAPH_UNIT_LOGBORN OFF without
 * losing anything written while it was ON.
 *
 * With the flag ON, memory / decision / seat-state writes land ONLY in the graph
 * executor (one receipted intention each, opId under `urn:ex:op/logborn/`). A flag-OFF
 * server reads those kinds from the board document + event log, so turning the flag
 * off would silently forget them. This script writes each such write BACK into the
 * event log, as the event a flag-OFF server would have appended for the same request,
 * so a flag-OFF server then serves the same memories (versions, identity history),
 * decisions (relations), seat states and change rows.
 *
 * WHAT IS EXPORTED: every APPLIED receipt of a LIVE unit write, in commitSeq order.
 * The migration's own receipts (`urn:ex:op/migrate-1561/`) are not: the records they
 * copied are still in the document / log they were copied from.
 *
 * HOW EACH IS RECONSTRUCTED (the executor keeps state, not requests):
 *   memory   create / revise: the state AFTER the op is the next revision node's prior*
 *            values (`<memory>/revision/<k+1>`), or the current state for the newest op;
 *            the versions are those whose recording op committed at or before it. The
 *            event carries the WHOLE memory `{identity, versions}` (#971).
 *   decision create: the node; relate: the edges it added. The executor does not record
 *            which edges a relate added, so each op's edges are FOUND by its digest: the
 *            subset of the decision's edges that reproduces the receipt's digest.
 *   seat     declare: the declaration node it recorded (+ the one it ended); clear: the
 *            declaration it ended. Flag-OFF events carry the declaration / `{seat}`.
 * EVERY reconstructed intention must reproduce its receipt's DIGEST (core/graph-compiler
 * canonicalize + digestOf) — the executor's own record of what was asked. A receipt that
 * does not is REFUSED before anything is written: a rollback that guesses is a second,
 * unaudited authority.
 *
 * ATTRIBUTION: `actor` is what the change feed credits for that op (core/logborn-feed.mjs,
 * reused, not re-derived); `occurred_at` is the receipt's time; `recorded_at` is the
 * rollback's (seq and recorded_at stay monotonic, as the log requires). Each event carries
 * `reverseExport: { opId, commitSeq, at, actor (the receipt's urn:ex:seat IRI), digest,
 * epoch, incarnation, tool }`, which is how a reader tells a reverse-exported event from a native
 * one. `incarnation` (the executor marker's ex:incarnation, 32 hex digits, #1577) is what lets a
 * consumer holding an executor position PROVE an export came from the store it read: a replay
 * lane or forward cursor translates only exports whose incarnation AND epoch equal its own.
 *
 * REFUSES (exit 1), BEFORE any write, when:
 *   - a live receipt's nodes do not reproduce its digest, or name nodes that are missing;
 *   - a live op recorded a Person node (the unit never mints one; flag-OFF has no event for it);
 *   - a unit record was recorded by an op that is neither a live write nor the migration;
 *   - a touched memory still has LEGACY document rows (flag-OFF drops them on touch and
 *     they are READ until then; this tool does not rewrite the document). A legacy SEAT
 *     row is counted and never read, on both paths: noted, not refused;
 *   - an outstanding UNKNOWN (--pending) cannot be reconciled by receipt;
 *   - the executor or the event log moves while it runs (a server is still writing);
 *   - --run without --pending (the record of outstanding UNKNOWN writes; may be empty).
 *
 * OUTSTANDING UNKNOWNS: a flag-ON server that could not learn a write's outcome answers
 * 503 GRAPH_WRITE_UNKNOWN with the opId and logs `[#1561 unknown-write] {json}` to stderr.
 * `--pending <file>` takes those lines (the server's stderr log as-is, or JSON lines, or
 * bare opIds). With every server stopped no further receipt can appear, so each is FINAL:
 * APPLIED → exported (it is in the receipt set); PRECONDITION_FAILED or ABSENT → reported
 * as NOT APPLIED (the caller's write did not happen; re-issue it against the flag-OFF server).
 *
 * REPLICA SNAPSHOT: a flag-ON server's graph snapshot holds the executor's records under
 * executor IRIs (#1570 read view); a flag-OFF warm boot would keep them beside the
 * re-projected ones. --run moves `graph-snapshot.*` aside (`.pre-rollback-1561-<stamp>`)
 * whenever it writes, so the next boot is cold and rebuilds from document + log.
 *
 * Idempotent: an op already in the log (by reverseExport.opId) is not written again.
 *
 *   node scripts/rollback-logborn-1561.mjs --board <board-data.json> [--events <dir>] \
 *     --executor http://127.0.0.1:<port> --dataset-id <id> \
 *     [--run --pending <file> | --verify] [--snapshot-dir <dir>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadDomain } from '../core/store.mjs';
import { readEvents, appendEvent, nextSeq } from '../core/event-log.mjs';
import { createGraphClient } from '../core/graph-client.mjs';
import { LOGBORN_TERMS as TM, canonicalize, digestOf } from '../core/graph-compiler.mjs';
import { NS } from '../core/graph-vocab.mjs';
import { Q_POSITION, DECISION_BASE } from '../core/logborn-unit.mjs';
import { feedQuery, feedRowsFromBindings, isoAt, LIVE_OP_PREFIX } from '../core/logborn-feed.mjs';
import { snapshotPaths } from '../core/graph-snapshot.mjs';
import { buildSource, readTarget, groupRecords, compareRecords, compareFolds, sourceHistories, targetHistories } from './migrate-logborn-1561.mjs';

export const TOOL = 'scripts/rollback-logborn-1561.mjs';
const MIGRATE_OP_PREFIX = `${NS}op/migrate-1561/`;
const R = (local) => `${NS}${local}`;
const UNIT_TYPES = [TM.Memory, TM.MemoryVersion, TM.MemoryRevision, TM.Decision, TM.SeatDeclaration];
const MAX_EDGES = 12;   // a decision's relation edges searched by digest: 2^n candidates per op

const local = (iri) => String(iri).replace(/^.*[#/:]/, '');   // = the folds' local()
const decisionId = (iri) => (String(iri).startsWith(DECISION_BASE) ? String(iri).slice(DECISION_BASE.length) : String(iri));
const roleKey = (iri) => decodeURIComponent(String(iri).replace(/^.*\/role\//, ''));
const stable = (x) => JSON.stringify(x, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v));
const unreadable = (why) => Object.assign(new Error(`executor unreadable: ${why}`), { code: 'EXECUTOR_UNREADABLE' });

// ── reading the executor: one picture of receipts, unit nodes and the feed ──
export async function readExecutor(client) {
  const q = async (sparql) => { const r = await client.query(sparql); if (!r.ok) throw unreadable(r.reason); return r.rows; };
  const id = await client.datasetIdentity();
  if (!id.ok) throw unreadable(id.reason);
  const pos = await q(Q_POSITION);
  if (pos.length !== 1) throw unreadable(`commit marker read returned ${pos.length} rows`);
  const position = `${pos[0].e.value}:${pos[0].seq.value}`;

  const receipts = new Map();
  for (const b of await q(`SELECT ?op ?p ?o WHERE { ?op <${R('commitSeq')}> ?seq ; ?p ?o . FILTER(STRSTARTS(STR(?op), "${NS}op/")) }`)) {
    const r = receipts.get(b.op.value) || { opId: b.op.value };
    receipts.set(b.op.value, r);
    const p = b.p.value.startsWith(NS) ? b.p.value.slice(NS.length) : null;
    if (p === 'commitSeq') r.seq = Number(b.o.value);
    else if (['outcome', 'digest', 'actor', 'at', 'target'].includes(p)) r[p] = b.o.value;
  }
  const nodes = new Map();
  const seen = new Set();
  for (const b of await q(`SELECT ?s ?p ?o WHERE { ?s <${TM.type}> ?t . VALUES ?t { ${UNIT_TYPES.map((t) => `<${t}>`).join(' ')} } ?s ?p ?o }`)) {
    const key = `${b.s.value}\u0000${b.p.value}\u0000${b.o.type}\u0000${b.o.value}`;
    if (seen.has(key)) continue;   // a node with two unit types comes back twice
    seen.add(key);
    const n = nodes.get(b.s.value) || { s: b.s.value, types: new Set(), props: new Map() };
    nodes.set(b.s.value, n);
    if (b.p.value === TM.type) n.types.add(b.o.value);
    else (n.props.get(b.p.value) || n.props.set(b.p.value, []).get(b.p.value)).push(b.o.value);
  }
  const livePeople = (await q(`SELECT ?s ?op WHERE { ?s <${TM.type}> <${TM.Person}> ; <${TM.recordedBy}> ?op FILTER(STRSTARTS(STR(?op), ${JSON.stringify(LIVE_OP_PREFIX)})) }`))
    .map((b) => ({ person: b.s.value, opId: b.op.value }));
  const feed = feedRowsFromBindings(await q(feedQuery(0)));
  // #1561 lanes — the store INCARNATION (#1577), from the feed's marker row (the same snapshot,
  // normalised by incarnationTag; feedRowsFromBindings refuses a marker without a readable one).
  // Without it an export cannot prove which store it came from: two promoted restores share an epoch.
  return { datasetId: id.datasetId, epoch: String(id.epoch), incarnation: feed.incarnation, position, receipts, nodes, livePeople, feed };
}

// ── reconstruction: each live APPLIED receipt → the flag-OFF event, digest-proven ──
export function reconstruct(ex, { legacy = null } = {}) {
  const problems = [];
  const notes = [];
  const vals = (n, p) => (n ? n.props.get(p) || [] : []);
  const one = (n, p) => {
    const v = vals(n, p);
    if (v.length > 1) problems.push(`${n.s}: ${v.length} values for single-valued ${p}`);
    return v.length ? v[0] : null;
  };
  const digestOfIntention = (i) => { try { return digestOf(canonicalize(i)); } catch (e) { return `invalid: ${e.message}`; } };
  const byType = (t) => [...ex.nodes.values()].filter((n) => n.types.has(t));
  const recordedBy = new Map();
  for (const n of ex.nodes.values()) for (const op of vals(n, TM.recordedBy)) (recordedBy.get(op) || recordedBy.set(op, []).get(op)).push(n);
  const seqOfOp = (op) => ex.receipts.get(op)?.seq;

  // every unit record must have been written by a receipted live write or by the migration
  for (const [op, list] of recordedBy) {
    const r = ex.receipts.get(op);
    if (!r) problems.push(`${list.map((n) => n.s).join(', ')}: recorded by ${op}, which has no receipt`);
    else if (!op.startsWith(LIVE_OP_PREFIX) && !op.startsWith(MIGRATE_OP_PREFIX)) problems.push(`${list.map((n) => n.s).join(', ')}: recorded by ${op}, neither a live unit write nor the #1561 migration`);
  }
  for (const p of ex.livePeople) problems.push(`${p.person}: a Person recorded by live write ${p.opId} — the unit never mints one and a flag-OFF server has no event for it`);

  const revisionsOf = new Map();
  for (const n of byType(TM.MemoryRevision)) {
    const m = one(n, TM.ofMemory);
    (revisionsOf.get(m) || revisionsOf.set(m, new Map()).get(m)).set(Number(one(n, TM.revision)), n);
  }
  const versionsOf = new Map();
  for (const n of byType(TM.MemoryVersion)) { const m = one(n, TM.ofMemory); (versionsOf.get(m) || versionsOf.set(m, []).get(m)).push(n); }
  const verNum = (v) => Number(one(v, TM.version));

  const live = [...ex.receipts.values()].filter((r) => r.opId.startsWith(LIVE_OP_PREFIX)).sort((a, b) => a.seq - b.seq);
  const applied = live.filter((r) => r.outcome === `${NS}APPLIED`);
  const notApplied = live.filter((r) => r.outcome === `${NS}PRECONDITION_FAILED`).map((r) => r.opId);
  for (const r of live) if (r.outcome !== `${NS}APPLIED` && r.outcome !== `${NS}PRECONDITION_FAILED`) problems.push(`${r.opId}: receipt outcome ${r.outcome}`);
  const rowByOp = new Map(ex.feed.rows.map((row) => [row.graph.opId, row]));
  if (rowByOp.size !== applied.length || applied.some((r) => !rowByOp.has(r.opId))) problems.push(`the change feed reads ${rowByOp.size} live writes, the receipts ${applied.length}`);

  const memoryState = (M, k) => {   // the mutable state AFTER the op that left the memory at write revision k+1
    const rev = revisionsOf.get(M)?.get(k + 1);
    const n = rev || ex.nodes.get(M);
    const P = rev ? { name: TM.priorName, tag: TM.priorTag, priority: TM.priorPriority, cv: TM.priorCurrentVersion, rel: TM.priorRelatedTo }
      : { name: TM.name, tag: TM.tag, priority: TM.priority, cv: TM.currentVersion, rel: TM.relatedTo };
    return { name: one(n, P.name), tags: [...vals(n, P.tag)].sort(), priority: one(n, P.priority), currentVersion: one(n, P.cv), relatedTo: [...vals(n, P.rel)].sort() };
  };
  const versionPayload = (v) => ({ iri: v.s, version: one(v, TM.version), body: one(v, TM.body), author: one(v, TM.author), dateCreated: one(v, TM.dateCreated) });
  const versionEntity = (v, M) => ({
    '@id': v.s, '@type': 'scrum:MemoryVersion', 'scrum:ofMemory': M, 'scrum:version': verNum(v), 'scrum:body': one(v, TM.body),
    ...(one(v, TM.author) ? { author: local(one(v, TM.author)) } : {}), dateCreated: one(v, TM.dateCreated),
  });

  const exports = [];
  const touched = { memories: new Set(), seats: new Set() };
  const attributedEdges = new Map();   // decision → Set of 's <iri>' / 'd <iri>'
  for (const r of applied) {
    const row = rowByOp.get(r.opId);
    if (!row) continue;
    const fail = (why) => problems.push(`${r.opId} (commitSeq ${r.seq}, ${row.kind} ${row.op}): ${why}`);
    const mine = recordedBy.get(r.opId) || [];
    const base = { kind: null, opId: r.opId, actor: r.actor };
    let event = null;
    if (row.kind === 'memory') {
      const M = row.id;
      const m = ex.nodes.get(M);
      if (!m) { fail(`memory ${M} is not in the executor`); continue; }
      touched.memories.add(M);
      const added = mine.filter((n) => n.types.has(TM.MemoryVersion));
      let k = 0;
      if (row.op === 'update') {
        const revs = mine.filter((n) => n.types.has(TM.MemoryRevision));
        if (revs.length !== 1) { fail(`${revs.length} revision nodes recorded (a revise records exactly one)`); continue; }
        k = Number(one(revs[0], TM.revision));
      }
      const state = memoryState(M, k);
      const intention = row.op === 'create'
        ? { ...base, kind: 'memory.create', memory: { iri: M, identifier: one(m, TM.identifier), owner: one(m, TM.owner), ...state }, versions: added.map(versionPayload) }
        : { ...base, kind: 'memory.revise', target: { iri: M, expectedVersion: String(k) }, set: state, versions: added.map(versionPayload) };
      if (digestOfIntention(intention) !== r.digest) { fail(`the memory's nodes do not reproduce the receipt's digest (the state after this ${row.op} cannot be told from the store)`); continue; }
      const versions = (versionsOf.get(M) || []).filter((v) => {
        const s = seqOfOp(one(v, TM.recordedBy));
        if (s == null) fail(`version ${v.s} has no recording receipt`);
        return s != null && s <= r.seq;
      }).sort((a, b) => verNum(a) - verNum(b));
      const identity = {
        '@id': M, '@type': 'scrum:Memory', identifier: one(m, TM.identifier), name: state.name,
        ...(one(m, TM.owner) ? { 'scrum:owner': local(one(m, TM.owner)) } : {}),
        ...(state.tags.length ? { 'scrum:tag': state.tags } : {}),
        ...(state.priority ? { 'scrum:priority': state.priority } : {}),
        ...(state.currentVersion ? { 'scrum:currentVersion': state.currentVersion } : {}),
        ...(state.relatedTo.length ? { 'scrum:relatedTo': state.relatedTo } : {}),
      };
      event = { op: row.op, actor: row.by, entity: { kind: 'memory', id: M }, state: { identity, versions: versions.map((v) => versionEntity(v, M)) } };
    } else if (row.kind === 'decision') {
      const D = row.id;
      const d = ex.nodes.get(D);
      if (!d) { fail(`decision ${D} is not in the executor`); continue; }
      const edges = [...vals(d, TM.supersedes).map((iri) => ({ p: 's', iri })), ...vals(d, TM.duplicateOf).map((iri) => ({ p: 'd', iri }))];
      if (edges.length > MAX_EDGES) { fail(`${edges.length} relation edges: more than ${MAX_EDGES} to search by digest`); continue; }
      const make = (sub) => (row.op === 'create'
        ? { ...base, kind: 'decision.create', decision: { iri: D, identifier: one(d, TM.identifier), statement: one(d, TM.statement), decidedBy: one(d, TM.decidedBy),
          constrains: vals(d, TM.constrains), reopensIf: one(d, TM.reopensIf), dateCreated: one(d, TM.dateCreated),
          supersedes: sub.filter((e) => e.p === 's').map((e) => e.iri), duplicateOf: sub.filter((e) => e.p === 'd').map((e) => e.iri) } }
        : { ...base, kind: 'decision.relate', target: D, supersedes: sub.filter((e) => e.p === 's').map((e) => e.iri), duplicateOf: sub.filter((e) => e.p === 'd').map((e) => e.iri) });
      const hits = [];
      for (let mask = row.op === 'create' ? 0 : 1; mask < 2 ** edges.length; mask++) {
        const sub = edges.filter((_, i) => mask & (1 << i));
        if (digestOfIntention(make(sub)) === r.digest) hits.push(sub);
      }
      if (hits.length !== 1) { fail(hits.length ? `${hits.length} edge sets reproduce the digest` : 'no subset of the decision\'s edges reproduces the receipt\'s digest'); continue; }
      const sub = hits[0];
      const set = attributedEdges.get(D) || attributedEdges.set(D, new Set()).get(D);
      for (const e of sub) set.add(`${e.p} ${e.iri}`);
      const sup = sub.filter((e) => e.p === 's').map((e) => decisionId(e.iri));
      const dup = sub.filter((e) => e.p === 'd').map((e) => decisionId(e.iri));
      if (dup.length > 1) { fail(`${dup.length} duplicateOf edges in one write: a flag-OFF decision event carries one`); continue; }
      const state = row.op === 'create'
        ? { '@id': D, '@type': 'scrum:Decision', identifier: one(d, TM.identifier), 'scrum:statement': one(d, TM.statement),
          ...(one(d, TM.decidedBy) ? { 'scrum:decidedBy': local(one(d, TM.decidedBy)) } : {}),
          'scrum:constrains': [...vals(d, TM.constrains)].sort(), 'scrum:reopensIf': one(d, TM.reopensIf), dateCreated: one(d, TM.dateCreated) }
        : { '@id': D, '@type': 'scrum:Decision', identifier: one(d, TM.identifier) };
      if (sup.length) state['scrum:supersedes'] = sup;
      if (dup.length) state['scrum:duplicateOf'] = dup[0];
      event = { op: row.op, actor: row.by, entity: { kind: 'decision', id: D }, state };
    } else if (row.kind === 'seat-state') {
      const seat = row.id;
      touched.seats.add(seat);
      const endsNode = r.target ? ex.nodes.get(r.target) : null;
      if (r.target && !endsNode) { fail(`the declaration it ended (${r.target}) is not in the executor`); continue; }
      const at = endsNode ? one(endsNode, TM.endedAt) : null;
      if (row.op === 'delete') {
        const intention = { ...base, kind: 'seat.clear', seat: one(endsNode, TM.declaredSeat), ends: r.target, at };
        if (digestOfIntention(intention) !== r.digest) { fail('the ended declaration does not reproduce the receipt\'s digest'); continue; }
        event = { op: 'delete', actor: row.by, entity: { kind: 'seat-state', id: seat }, state: { seat } };
      } else {
        const decls = mine.filter((n) => n.types.has(TM.SeatDeclaration));
        if (decls.length !== 1) { fail(`${decls.length} declarations recorded (a declare records exactly one)`); continue; }
        const n = decls[0];
        const arw = one(n, TM.acceptsRoutineWork);
        const role = one(n, TM.role);
        const intention = { ...base, kind: 'seat.declare', seat: one(n, TM.declaredSeat), ends: r.target ?? null, at,
          declaration: { iri: n.s, mode: one(n, TM.mode), acceptsRoutineWork: arw, constraints: vals(n, TM.constraint), note: one(n, TM.note),
            declaredAt: one(n, TM.declaredAt), expiresAt: one(n, TM.expiresAt), role, endedAt: null } };
        if (digestOfIntention(intention) !== r.digest) { fail('the declaration does not reproduce the receipt\'s digest'); continue; }
        event = { op: row.op, actor: row.by, entity: { kind: 'seat-state', id: seat }, state: {
          seat, mode: one(n, TM.mode), ...(arw != null ? { acceptsRoutineWork: arw === 'true' } : {}), constraints: [...vals(n, TM.constraint)].sort(),
          note: one(n, TM.note), declaredAt: one(n, TM.declaredAt), expiresAt: one(n, TM.expiresAt), ...(role ? { role: roleKey(role) } : {}) } };
      }
    } else {
      fail(`unknown kind ${row.kind}`);
      continue;
    }
    exports.push({ opId: r.opId, commitSeq: r.seq, at: r.at, receiptActor: r.actor, digest: r.digest, row, event: {
      ...event, occurred_at: isoAt(r.at),
      reverseExport: { opId: r.opId, commitSeq: r.seq, at: r.at, actor: r.actor, digest: r.digest, epoch: ex.epoch, incarnation: ex.incarnation, tool: TOOL },
    } });
  }
  // every relation edge of a decision a live op wrote is accounted for (no edge the export would drop)
  for (const [D, set] of attributedEdges) {
    const d = ex.nodes.get(D);
    const created = applied.some((r) => rowByOp.get(r.opId)?.kind === 'decision' && rowByOp.get(r.opId).op === 'create' && rowByOp.get(r.opId).id === D);
    if (!created) continue;   // a migrated decision's other edges are already in the log
    const all = [...vals(d, TM.supersedes).map((i) => `s ${i}`), ...vals(d, TM.duplicateOf).map((i) => `d ${i}`)];
    const missing = all.filter((e) => !set.has(e));
    if (missing.length) problems.push(`${D}: edge(s) ${missing.join(', ')} attributed to no write`);
  }
  // flag-OFF drops a touched memory's / seat's LEGACY document rows in the same write; this tool does not rewrite the document
  if (legacy) {
    for (const row of Array.isArray(legacy.memories) ? legacy.memories : []) {
      const M = row?.['@id'] && touched.memories.has(row['@id']) ? row['@id'] : row?.['scrum:ofMemory'] && touched.memories.has(row['scrum:ofMemory']) ? row['scrum:ofMemory'] : null;
      if (M) problems.push(`${M}: the board document still carries its legacy row ${row['@id']}; a flag-OFF write would have dropped it, and this rollback does not rewrite the document`);
    }
    // a legacy SEAT row is counted (`legacyRows`) and never read (#1143), on BOTH paths: the
    // flag-ON server served the same count, so leaving it changes nothing served. Noted, not refused.
    for (const row of Array.isArray(legacy.seatStates) ? legacy.seatStates : []) {
      if (touched.seats.has(row?.['scrum:seat'])) notes.push(`seat ${row['scrum:seat']}: the board document still carries a legacy seat row (counted as legacyRows, never read); a flag-OFF write would have dropped it — the next flag-OFF write for that seat will`);
    }
  }
  return { exports, problems, notes, notApplied, appliedCount: applied.length };
}

// ── outstanding UNKNOWN writes, reconciled by receipt ──
/** Lines of a server's stderr (`[#1561 unknown-write] {json}`), JSON lines, or bare opIds → [{opId, …}]. */
export function parsePending(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const at = t.indexOf('[#1561 unknown-write] ');
    const json = at >= 0 ? t.slice(at + '[#1561 unknown-write] '.length) : t.startsWith('{') ? t : null;
    if (json) { const o = JSON.parse(json); if (typeof o?.opId === 'string') out.push(o); continue; }
    if (/^urn:ex:op\//.test(t)) out.push({ opId: t });
  }
  return out;
}
export function reconcilePending(pending, ex) {
  const res = { applied: [], absent: [], notApplied: [], unreconcilable: [] };
  for (const p of pending) {
    const opId = p?.opId;
    if (typeof opId !== 'string' || !opId.startsWith(LIVE_OP_PREFIX)) { res.unreconcilable.push(String(opId)); continue; }
    const r = ex.receipts.get(opId);
    if (!r) res.absent.push(opId);
    else if (r.outcome === `${NS}APPLIED`) res.applied.push(opId);
    else if (r.outcome === `${NS}PRECONDITION_FAILED`) res.notApplied.push(opId);
    else res.unreconcilable.push(opId);
  }
  return res;
}

// ── verification, both ways ──
const seatSignature = (r) => {
  const one = (p) => r.byPred.get(p)?.[0]?.value ?? null;
  const many = (p) => (r.byPred.get(p) || []).map((o) => o.value).sort();
  return stable({ seat: one(TM.declaredSeat), mode: one(TM.mode), arw: one(TM.acceptsRoutineWork), constraints: many(TM.constraint), note: one(TM.note),
    declaredAt: one(TM.declaredAt), expiresAt: one(TM.expiresAt), role: one(TM.role), ended: r.byPred.has(TM.endedAt) });
};
export async function verify({ board, eventList, client, ex, plan }) {
  const diffs = [];
  // 1. executor → log and log → executor: every live write is in the log exactly once, as reconstructed
  const inLog = eventList.filter((e) => e.reverseExport);
  const byOp = new Map();
  for (const e of inLog) (byOp.get(e.reverseExport.opId) || byOp.set(e.reverseExport.opId, []).get(e.reverseExport.opId)).push(e);
  const want = new Map(plan.exports.map((x) => [x.opId, x]));
  for (const x of plan.exports) {
    const got = byOp.get(x.opId) || [];
    if (got.length !== 1) { diffs.push(`executor→log: ${x.opId} is in the log ${got.length} times`); continue; }
    const pick = (e) => stable({ op: e.op, actor: e.actor, entity: e.entity, state: e.state, occurred_at: e.occurred_at, reverseExport: e.reverseExport });
    if (pick(got[0]) !== pick(x.event)) diffs.push(`executor→log: ${x.opId} differs from what the executor holds (seq ${got[0].seq})`);
  }
  for (const [op] of byOp) if (!want.has(op)) diffs.push(`log→executor: reverse-exported ${op} is not a live APPLIED write in this executor`);
  // 2. the change rows: same order, same kind / op / id / by, original time kept
  const logRows = inLog.filter((e) => want.has(e.reverseExport.opId)).sort((a, b) => a.seq - b.seq);
  const feedRows = [...ex.feed.rows].sort((a, b) => a.graph.commitSeq - b.graph.commitSeq);
  const asRow = (k, o, i, b) => `${k} ${o} ${i} by=${b}`;
  const a = feedRows.map((r) => asRow(r.kind, r.op, r.id, r.by));
  const b = logRows.map((e) => asRow(e.entity.kind, e.op, e.entity.id, e.actor));
  if (stable(a) !== stable(b)) diffs.push(`change rows differ: executor feed ${a.length} rows, log ${b.length} (first difference at ${a.findIndex((x, i) => x !== b[i])})`);
  for (const e of logRows) if (e.occurred_at !== isoAt(e.reverseExport.at)) diffs.push(`${e.reverseExport.opId}: occurred_at ${e.occurred_at} is not the receipt's time ${e.reverseExport.at}`);
  // 3. what a flag-OFF server serves (document + log, projected) ⇄ what the flag-ON server served (the executor)
  const srcTriples = buildSource({ board, events: eventList });
  const tgtTriples = await readTarget(client);
  const src = groupRecords(srcTriples), tgt = groupRecords(tgtTriples);
  const noSeats = (m) => new Map([...m].filter(([, r]) => r.type !== 'seat'));
  const cmp = compareRecords(noSeats(src), noSeats(tgt));
  diffs.push(...cmp.diffs.map((d) => `records ${d}`));
  diffs.push(...compareFolds(srcTriples, tgtTriples));
  // seat declarations: the same intervals both ways, IRIs and end times normalised (they differ by construction)
  const sigs = (m) => [...m.values()].filter((r) => r.type === 'seat').map(seatSignature).sort();
  const ss = sigs(src), ts = sigs(tgt);
  const count = (xs) => xs.reduce((m, x) => m.set(x, (m.get(x) || 0) + 1), new Map());
  const cs = count(ss), ct = count(ts);
  for (const [x, n] of cs) if ((ct.get(x) || 0) !== n) diffs.push(`seat declaration log→executor: ${x} ×${n} in the log, ×${ct.get(x) || 0} in the executor`);
  for (const [x, n] of ct) if (!cs.has(x)) diffs.push(`seat declaration executor→log: ${x} ×${n} only in the executor`);
  // identity history, both ways
  const sh = sourceHistories(src, eventList);
  const th = await targetHistories(client);
  for (const [m, w] of sh) { const g = th.byMemory.get(m) || []; if (stable(g) !== stable(w)) diffs.push(`${m}: identity history differs (log ${w.length} states, executor ${g.length})`); }
  for (const m of th.byMemory.keys()) if (!sh.has(m)) diffs.push(`${m}: in the executor, not in the log`);
  return { diffs, counts: { log: cmp.counts.source, executor: cmp.counts.target, seatIntervals: { log: ss.length, executor: ts.length } } };
}

// ── the run ──
export async function rollback({ board, events, client, mode = 'dry-run', pending = null, snapshotDir = null, log = () => {} }) {
  const report = { mode, refused: null, planned: 0, written: 0, alreadyExported: 0, notApplied: [], pending: null, position: null, snapshot: null, counts: null, diffs: [], ms: {} };
  const refuse = (why, extra = {}) => Object.assign(report, { refused: why, ...extra });
  const t = (k, t0) => { report.ms[k] = Math.round(performance.now() - t0); };
  if (mode === 'run' && !Array.isArray(pending)) return refuse('--run needs the record of outstanding UNKNOWN writes (--pending <file>, which may be empty): an unreconciled write would be silently dropped');
  let t0 = performance.now();
  let ex;
  try { ex = await readExecutor(client); } catch (e) { return refuse(`cannot read the executor: ${e.message}`); }
  t('readExecutor', t0);
  report.position = ex.position;
  t0 = performance.now();
  const logHead = nextSeq(events);
  const eventList = readEvents(events);
  t('readLog', t0);
  const legacy = loadDomain(board);
  t0 = performance.now();
  const plan = reconstruct(ex, { legacy });
  t('reconstruct', t0);
  report.notApplied = plan.notApplied;
  report.notes = plan.notes;
  if (Array.isArray(pending)) {
    report.pending = reconcilePending(pending, ex);
    if (report.pending.unreconcilable.length) return refuse('outstanding UNKNOWN write(s) cannot be reconciled by receipt', { diffs: report.pending.unreconcilable.map((o) => `${o}: not a live unit write with a readable receipt`) });
  }
  if (plan.problems.length) return refuse('the executor holds writes this rollback cannot carry faithfully', { diffs: plan.problems });
  const done = new Set(eventList.filter((e) => e.reverseExport).map((e) => e.reverseExport.opId));
  const todo = plan.exports.filter((x) => !done.has(x.opId));
  report.alreadyExported = plan.exports.length - todo.length;
  report.planned = todo.length;
  report.byKind = todo.reduce((m, x) => { const k = `${x.event.entity.kind}:${x.event.op}`; m[k] = (m[k] || 0) + 1; return m; }, {});
  const snaps = snapshotDir ? Object.values(snapshotPaths(snapshotDir)).filter((f) => fs.existsSync(f)) : [];
  report.snapshot = { present: snaps, movedAside: [] };
  log(`executor ${ex.datasetId} at ${ex.position}: ${plan.appliedCount} live writes applied (${plan.notApplied.length} not applied) · in the log already: ${report.alreadyExported} · to write: ${todo.length}`);

  if (mode === 'verify') {
    t0 = performance.now();
    const v = await verify({ board, eventList, client, ex, plan });
    t('verify', t0);
    Object.assign(report, v);
    if (report.diffs.length) return refuse('verification failed');
    return report;
  }
  if (mode !== 'run') return report;

  if (todo.length) {
    // quiescence: nothing else may be writing the executor or the log
    let now;
    try { now = await readExecutor(client); } catch (e) { return refuse(`cannot re-read the executor: ${e.message}`); }
    if (now.position !== ex.position) return refuse(`the executor moved while planning (${ex.position} → ${now.position}): a server is still writing; stop every server first`);
    if (nextSeq(events) !== logHead) return refuse('the event log moved while planning: a server is still writing; stop every server first');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    for (const f of snaps) { const to = `${f}.pre-rollback-1561-${stamp}`; fs.renameSync(f, to); report.snapshot.movedAside.push(to); }
    t0 = performance.now();
    for (const x of todo) { appendEvent(events, x.event); report.written += 1; }
    t('write', t0);
  }
  t0 = performance.now();
  const after = await readExecutor(client);
  if (after.position !== ex.position) report.diffs.push(`the executor moved during the rollback (${ex.position} → ${after.position})`);
  const v = await verify({ board, eventList: readEvents(events), client, ex, plan });
  t('verify', t0);
  report.counts = v.counts;
  report.diffs.push(...v.diffs);
  if (report.diffs.length) return refuse('verification failed');
  return report;
}

// ── CLI ──
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const board = opt('--board'), executor = opt('--executor'), datasetId = opt('--dataset-id'), pendingFile = opt('--pending');
  const events = opt('--events') ?? (board ? `${board.replace(/\.json$/, '')}-events` : null);
  if (!board || !executor || !datasetId) {
    console.error('usage: --board <file> --executor <url> --dataset-id <id> [--events <dir>] [--run --pending <file> | --verify] [--snapshot-dir <dir>]');
    process.exit(2);
  }
  const mode = args.includes('--run') ? 'run' : args.includes('--verify') ? 'verify' : 'dry-run';
  const pending = pendingFile ? parsePending(fs.readFileSync(pendingFile, 'utf8')) : null;
  const snapshotDir = opt('--snapshot-dir') ?? path.dirname(path.resolve(board));
  const client = createGraphClient({ baseUrl: executor, expectedDatasetId: datasetId, timeoutMs: 120000 });
  const report = await rollback({ board, events, client, mode, pending, snapshotDir, log: (s) => console.error(s) });
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.refused ? 1 : 0);
}
