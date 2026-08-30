/**
 * #1110 — seat declarations become queryable INTERVALS in the graph.
 *
 * #613 shipped declarations as API state: what is true NOW, for the seats you
 * ask about. The graph question is different — joinable over TIME: "which seats
 * held a declining declaration at the moment of the 18:40:14Z tending run?"
 * After 20:00Z the API answers UNKNOWN (correctly — expiry is not renewed) and
 * the reason that run looked the way it did survives only in a console line.
 *
 * The card's own design constraint, honoured here: a declaration is a STATEFUL
 * INTERVAL, not an event. A bare present-tense predicate would answer the
 * question the API already answers and none of the ones the card exists for.
 * So each seat-state EVENT projects an immutable scrum:SeatDeclaration node
 * carrying its interval: scrum:declaredAt → scrum:expiresAt, and scrum:endedAt
 * when a later declare/clear superseded it early. History survives re-declares
 * and clears because the EVENT LOG is the source, not the document (which keeps
 * only the latest row per seat).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraphStore, queryGraph, projectActivities, vocabularyDrift } from '../core/graph-replica.mjs';

const EV = (seq, at, op, state) => ({
  seq, recorded_at: at, occurred_at: at, actor: state?.seat ?? 'ada', op,
  entity: { kind: 'seat-state', id: state?.seat ?? 'ada' },
  ...(state ? { state } : { state: { seat: 'ada' } }),
});
const DECL = (over = {}) => ({
  seat: 'ada', mode: 'resting', acceptsRoutineWork: false, constraints: [],
  note: 'x', declaredAt: '2026-08-30T14:51:50.072Z', expiresAt: '2026-08-30T15:30:00.000Z', ...over,
});
const store = () => buildGraphStore({ '@graph': [] });
const rows = (s, q) => queryGraph(s, q, { limit: 100 }).rows || [];

/** The card's acceptance question, parameterised by instant. */
const heldAt = (s, t) => rows(s, `SELECT ?seat WHERE {
  ?d a scrum:SeatDeclaration ; scrum:declaredSeat ?seat ;
     scrum:acceptsRoutineWork "false" ; scrum:declaredAt ?t0 ; scrum:expiresAt ?exp .
  FILTER(?t0 <= "${t}" && "${t}" < ?exp)
  FILTER NOT EXISTS { ?d scrum:endedAt ?end . FILTER(?end <= "${t}") }
}`).map((r) => String(r.seat));

test('#1110 a declare event projects an interval: held inside it, not held after expiry', () => {
  const s = store();
  projectActivities(s, [EV(10, '2026-08-30T14:51:50.143Z', 'create', DECL())]);
  assert.deepEqual(heldAt(s, '2026-08-30T15:00:00.000Z'), ['person:ada'], 'inside the interval');
  assert.deepEqual(heldAt(s, '2026-08-30T16:00:00.000Z'), [], 'after expiresAt — expiry needs no event');
  assert.deepEqual(heldAt(s, '2026-08-30T14:00:00.000Z'), [], 'before declaredAt');
});

test('#1110 a re-declare ENDS the prior interval and opens a new one — both stay queryable', () => {
  const s = store();
  projectActivities(s, [
    EV(10, '2026-08-30T14:51:50.143Z', 'create', DECL()),
    EV(11, '2026-08-30T14:53:59.010Z', 'update', DECL({ declaredAt: '2026-08-30T14:53:58.917Z', expiresAt: '2026-08-30T20:00:00.000Z' })),
  ]);
  // The card's own concrete loss, answered: the 18:40:14Z run.
  assert.deepEqual(heldAt(s, '2026-08-30T18:40:14.620Z'), ['person:ada'], 'the run-time question, answerable after the fact');
  assert.deepEqual(heldAt(s, '2026-08-30T14:52:30.000Z'), ['person:ada'], 'the FIRST interval still answers for its own window');
  const both = rows(s, 'SELECT ?d WHERE { ?d a scrum:SeatDeclaration }');
  assert.equal(both.length, 2, 'history: two declarations, not an overwritten one');
  // And after the second expires, nothing — expiry is not renewed by anything.
  assert.deepEqual(heldAt(s, '2026-08-30T20:00:00.000Z'), [], 'at expiry instant, no longer held');
});

test('#1110 a clear ENDS the interval and creates no node — UNKNOWN is absence, in the graph as in the API', () => {
  const s = store();
  projectActivities(s, [
    EV(10, '2026-08-30T14:51:50.143Z', 'create', DECL({ expiresAt: '2026-08-30T23:00:00.000Z' })),
    EV(11, '2026-08-30T15:10:00.000Z', 'delete', { seat: 'ada' }),
  ]);
  assert.deepEqual(heldAt(s, '2026-08-30T15:00:00.000Z'), ['person:ada'], 'held before the clear');
  assert.deepEqual(heldAt(s, '2026-08-30T15:30:00.000Z'), [], 'not held after — endedAt from the clear, well before expiresAt');
  assert.equal(rows(s, 'SELECT ?d WHERE { ?d a scrum:SeatDeclaration }').length, 1, 'the clear itself is no declaration');
});

test('#1110 idempotent by seq: replaying the same events adds nothing', () => {
  const s = store();
  const evs = [EV(10, '2026-08-30T14:51:50.143Z', 'create', DECL()), EV(11, '2026-08-30T15:10:00.000Z', 'delete', { seat: 'ada' })];
  projectActivities(s, evs);
  const size = s.size;
  projectActivities(s, evs);
  assert.equal(s.size, size, 'a rebuild is not new history');
});

test('#1110 the new terms are DECLARED — the #1104 drift guard must not go red in prod', () => {
  const s = store();
  projectActivities(s, [EV(10, '2026-08-30T14:51:50.143Z', 'create', DECL({ constraints: ['slow'] }))]);
  const d = vocabularyDrift(s);
  assert.deepEqual(d.undeclared, [], `every emitted term is in GRAPH_VOCABULARY: ${JSON.stringify(d.undeclared)}`);
});
