/**
 * #683 slice 3b — WIRING the cursors to the real event log.
 *
 * Slice 3a shipped `core/cursors.mjs`: correct, tested, and imported by nothing
 * for six days. This slice binds it to the log and to a delivery identity, so
 * the tests here are about the SEAMS rather than the arithmetic — the arithmetic
 * already has its own file.
 *
 * Every test names the incident it encodes. The two that matter most:
 *   - a response that never completed must not advance anything (#624 itself)
 *   - replay must work for a seat that CANNOT authenticate (@minimo, who has no
 *     bearer token and will not have one until #779 — if this slice needs a
 *     token, it has not cured #624 for the seat that motivated it)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendEvent } from '../core/event-log.mjs';
import { loadCursors, saveCursors } from '../core/cursors.mjs';
import {
  deliveryIdentity, registerFor, serveFor, noteInbound, envelopeFor, reachabilityReport,
  discardPendingServes,
} from '../core/cursor-service.mjs';

let n = 0;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), `cursorsvc-${process.pid}-${n++}-`));

/** Append `count` card events, returns the stored events. */
function seed(dir, count, { day = '2026-08-11' } = {}) {
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(appendEvent(dir, {
      op: 'create',
      entity: { kind: 'card', id: `card-${i}`, shortId: 100 + i },
      state: { title: `card ${i}` },
      actor: 'tester',
    }, { now: `${day}T00:0${Math.min(i, 9)}:00.000Z` }));
  }
  return out;
}

// ── delivery identity: the key cursors are stored under ────────────────────

test('#683 identity — a #410-registered lane keys on its endpoint id', () => {
  const id = deliveryIdentity({ registrySeatId: 'minimo.sb' });
  assert.equal(id.key, 'registry:minimo.sb');
  assert.equal(id.kind, 'registry');
});

test('#683 identity — a token-bound session with no registration keys on its seat', () => {
  // @wren and @indigo have NEVER registered through #410 (measured: 0 and 0).
  // Keying only on the registry would give this half of the room no cursors.
  const id = deliveryIdentity({ bearerSeat: 'indigo' });
  assert.equal(id.key, 'bearer:indigo');
  assert.equal(id.kind, 'bearer');
});

test('#683 identity — REGISTRY WINS, so #779 cannot orphan a cursor', () => {
  // The whole point of the precedence. When @minimo's client gains a bearer
  // token, her lanes keep the same key and their persisted cursors survive.
  // The reverse precedence would silently re-key every cursor she owns on the
  // day we make her visible — an outage caused by fixing observability.
  const before = deliveryIdentity({ registrySeatId: 'minimo.sb' });
  const after = deliveryIdentity({ registrySeatId: 'minimo.sb', bearerSeat: 'minimo' });
  assert.equal(after.key, before.key, 'gaining a token must not change the cursor key');
});

test('#683 identity — namespaces cannot collide', () => {
  // A registry seatId and a bearer seat name are different vocabularies with no
  // authority keeping them apart; unprefixed they could name the same key and
  // silently share one cursor between two lanes.
  assert.notEqual(
    deliveryIdentity({ registrySeatId: 'indigo' }).key,
    deliveryIdentity({ bearerSeat: 'indigo' }).key,
  );
});

test('#683 identity — neither ⇒ NO cursor, and it says so rather than guessing', () => {
  // An anonymous stream has nothing durable to remember it by. Inventing a key
  // (a session id, say) would create a cursor that can never be resumed and
  // would pin retention forever.
  assert.equal(deliveryIdentity({}), null);
  assert.equal(deliveryIdentity({ registrySeatId: '', bearerSeat: null }), null);
});

// ── the pull path ─────────────────────────────────────────────────────────

test('#683 a fresh lane registers at HEAD and is owed nothing', () => {
  const dir = tmp();
  seed(dir, 5);
  const { cursor, fresh, envelope } = registerFor(dir, 'registry:minimo.sb');
  assert.equal(fresh, true);
  assert.equal(cursor, 5);
  assert.equal(envelope.lag, 0);
  assert.equal(serveFor(dir, 'registry:minimo.sb').events.length, 0);
});

test('#683 REPLAY WORKS FOR AN UNBOUND SEAT — @wren\'s acceptance bar', () => {
  // @minimo cannot authenticate. If replay required a bearer token this slice
  // would fix every seat except the one #624 was written for.
  const dir = tmp();
  seed(dir, 2);
  const id = deliveryIdentity({ registrySeatId: 'minimo.sb' });   // NO bearerSeat
  registerFor(dir, id.key);
  seed(dir, 3);                                                   // missed while deaf
  const { events } = serveFor(dir, id.key);
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((e) => e.seq), [3, 4, 5]);
});

test('#683 a pull SERVES but does not ACK — the cursor holds until the seat speaks again', () => {
  const dir = tmp();
  seed(dir, 2);
  registerFor(dir, 'bearer:indigo');
  seed(dir, 2);
  serveFor(dir, 'bearer:indigo').commit();
  assert.equal(loadCursors(dir).seats['bearer:indigo'].acked, 2, 'acked must NOT move on serve');
  assert.equal(loadCursors(dir).seats['bearer:indigo'].served, 4);
});

test('#683 the NEXT inbound call is the ack', () => {
  const dir = tmp();
  seed(dir, 2);
  registerFor(dir, 'bearer:indigo');
  seed(dir, 2);
  serveFor(dir, 'bearer:indigo').commit();
  noteInbound(dir, 'bearer:indigo');
  assert.equal(loadCursors(dir).seats['bearer:indigo'].acked, 4, 'aliveness after the response is the ack');
});

test('#683 LOST RESPONSE ⇒ the same events are re-served, never skipped', () => {
  // At-least-once. The seat may see an event twice (dedup by seq, documented in
  // the envelope); it may never see one zero times.
  const dir = tmp();
  seed(dir, 1);
  registerFor(dir, 'bearer:indigo');
  seed(dir, 3);
  const first = serveFor(dir, 'bearer:indigo');
  first.commit();
  const second = serveFor(dir, 'bearer:indigo');   // no inbound between: unacked
  assert.deepEqual(second.events.map((e) => e.seq), first.events.map((e) => e.seq),
    'an unacked serve is re-served in full');
});

test('#683 STREAM DEATH MID-REPLAY ⇒ NOTHING advances (blocker-1, and the reason commit is separate)', () => {
  // `serveFor` only READS. Nothing is recorded until `commit()`, which the
  // caller runs after the response is fully written. A stream that dies while
  // the bytes are in flight never reaches commit, so the cursor cannot advance
  // past events the seat never received.
  //
  // ⚠️ This is why serving and recording are two calls rather than one. A
  // single-call API records at the moment of DECIDING what to send, which is
  // #624 reimplemented inside its own cure — and it would pass a test that
  // only checked "the right events came back".
  const dir = tmp();
  seed(dir, 1);
  registerFor(dir, 'bearer:indigo');
  seed(dir, 4);
  const pull = serveFor(dir, 'bearer:indigo');
  assert.deepEqual(pull.events.map((e) => e.seq), [2, 3, 4, 5]);
  // …the stream dies here. commit() is never reached.
  assert.equal(loadCursors(dir).seats['bearer:indigo'].served, null, 'an uncommitted serve records nothing');
  noteInbound(dir, 'bearer:indigo');
  assert.equal(loadCursors(dir).seats['bearer:indigo'].acked, 1, 'an ack with nothing served must not skip');
  assert.deepEqual(serveFor(dir, 'bearer:indigo').events.map((e) => e.seq), [2, 3, 4, 5],
    'everything the seat missed is still owed to it');
});

// ── the fence: two sessions, one lane name ────────────────────────────────

test('#683 FENCE — a superseded session cannot ack a range served to another (the SILENT one)', () => {
  // `core/seat-registry.mjs` says registration is "trusted input in v1 — author
  // is client-supplied". Two processes can hold one lane name, and the registry
  // log itself cannot tell them apart: "(reconnect or DUPLICATE config?)".
  //
  // Under one shared cursor and no fence: A is served 2–5 and acks, B never
  // received them and never will. That is #624's loss class arriving through
  // the key of its own cure — and silent, because a cursor's job is to assert
  // delivery. This is the only bar item that fails without a trace.
  const dir = tmp();
  seed(dir, 1);
  registerFor(dir, 'registry:minimo.sb');
  seed(dir, 4);
  serveFor(dir, 'registry:minimo.sb', { via: 'epoch1:sessionA' }).commit();

  // …B registers the same lane name. Its inbound call must NOT ack A's range.
  const r = noteInbound(dir, 'registry:minimo.sb', { via: 'epoch2:sessionB' });
  assert.equal(r.fenced, true, 'a stranger acking someone else\'s range must be refused');
  assert.equal(r.acked, false);
  assert.equal(loadCursors(dir).seats['registry:minimo.sb'].acked, 1, 'the cursor did not move');
  assert.deepEqual(serveFor(dir, 'registry:minimo.sb').events.map((e) => e.seq), [2, 3, 4, 5],
    're-served in full — duplicate delivery is acceptable, silent loss is not');
});

test('#683 FENCE — the session that WAS served may ack normally', () => {
  // The positive control for the fence: it must refuse strangers without
  // refusing the ordinary case, or it is just a broken ack path.
  const dir = tmp();
  seed(dir, 1);
  registerFor(dir, 'registry:minimo.sb');
  seed(dir, 4);
  serveFor(dir, 'registry:minimo.sb', { via: 'epoch1:sessionA' }).commit();
  const r = noteInbound(dir, 'registry:minimo.sb', { via: 'epoch1:sessionA' });
  assert.equal(r.fenced, false);
  assert.equal(r.acked, true);
  assert.equal(loadCursors(dir).seats['registry:minimo.sb'].acked, 5);
});

test('#683 FENCE — pending serves are discarded on server restart, because EPOCHS RESET', () => {
  // Measured by @wren: seat-registry's epochCounter lives in a closure and is
  // never persisted, so epochs went 3,4 → 5,6 → 1,2 across restarts — BACKWARDS.
  // A fence that survived a restart could therefore be satisfied by coincidence:
  // a pre-restart epoch=1 matching a post-restart epoch=1. The fence must be
  // ephemeral because its discriminator is ephemeral.
  const dir = tmp();
  seed(dir, 1);
  registerFor(dir, 'registry:minimo.sb');
  seed(dir, 3);
  serveFor(dir, 'registry:minimo.sb', { via: 'epoch1:sessionA' }).commit();
  discardPendingServes(dir);                       // ← what the server calls at boot
  const st = loadCursors(dir);
  assert.equal(st.seats['registry:minimo.sb'].served, null, 'no pending serve survives a restart');
  assert.equal(st.seats['registry:minimo.sb'].acked, 1, 'the DURABLE cursor is untouched');
  assert.deepEqual(serveFor(dir, 'registry:minimo.sb').events.map((e) => e.seq), [2, 3, 4]);
});

test('#683 two lanes of one agent keep INDEPENDENT cursors', () => {
  // @minimo runs minimo.sb and minimo.cs. One lane acking must not mark the
  // other lane's events delivered — that would be #624 with extra steps.
  const dir = tmp();
  seed(dir, 1);
  registerFor(dir, 'registry:minimo.sb');
  registerFor(dir, 'registry:minimo.cs');
  seed(dir, 2);
  serveFor(dir, 'registry:minimo.sb').commit();
  noteInbound(dir, 'registry:minimo.sb');
  assert.equal(loadCursors(dir).seats['registry:minimo.sb'].acked, 3);
  assert.equal(loadCursors(dir).seats['registry:minimo.cs'].acked, 1, 'the other lane is untouched');
  assert.equal(serveFor(dir, 'registry:minimo.cs').events.length, 2);
});

test('#683 RESTART SURVIVAL — cursors are identical across a process restart', () => {
  // Everything here is on disk by construction; the test exists because a
  // cursor that resets on restart would make every restart a deafness event,
  // which is the ceremony this slice retires.
  const dir = tmp();
  seed(dir, 3);
  registerFor(dir, 'bearer:indigo');
  seed(dir, 2);
  serveFor(dir, 'bearer:indigo').commit();
  noteInbound(dir, 'bearer:indigo');
  const before = JSON.parse(JSON.stringify(loadCursors(dir)));   // simulate: nothing in memory
  assert.deepEqual(loadCursors(dir), before);
  assert.equal(serveFor(dir, 'bearer:indigo').events.length, 0, 'nothing re-served after a clean ack');
});

// ── the envelope: server-computed, so the client compares nothing ──────────

test('#683 the envelope carries the four fields the room ruled on', () => {
  const dir = tmp();
  seed(dir, 2);
  registerFor(dir, 'bearer:indigo');
  const later = seed(dir, 2, { day: '2026-08-12' });
  const env = envelopeFor(dir, 'bearer:indigo');
  assert.equal(env.head_seq, 4);
  assert.equal(env.last_acked_seq, 2);
  assert.equal(env.lag, 2);
  assert.equal(env.oldest_unserved_at, later[0].recorded_at,
    'the AGE signal — the enforcement card keys on this, not on divergence');
});

test('#683 oldest_unserved_at is null when nothing is outstanding', () => {
  const dir = tmp();
  seed(dir, 2);
  registerFor(dir, 'bearer:indigo');
  assert.equal(envelopeFor(dir, 'bearer:indigo').oldest_unserved_at, null);
});

test('#683 an unknown lane gets an envelope that says UNKNOWN, not zero', () => {
  // A confident zero for a lane we have never seen is the defect class this
  // board spent 2026-08-10 cataloguing: an answer to a question not understood.
  const dir = tmp();
  seed(dir, 3);
  const env = envelopeFor(dir, 'bearer:nobody');
  assert.equal(env.known, false);
  assert.equal(env.last_acked_seq, null);
  assert.equal(env.lag, null, 'lag from an absent cursor is unknown, not 0');
});

// ── reachability: inbound-only, with the positive control ──────────────────

test('#683 UNCONFIRMED — inbound recent, lag growing (the 8-hour incident, scored right)', () => {
  const dir = tmp();
  seed(dir, 1);
  registerFor(dir, 'registry:minimo.sb', { now: '2026-08-11T02:00:00.000Z' });
  seed(dir, 5);   // the room moves on; she receives none of it
  const rep = reachabilityReport(dir, { now: Date.parse('2026-08-11T02:01:00.000Z') });
  const row = rep.find((r) => r.identity === 'registry:minimo.sb');
  assert.equal(row.state, 'unconfirmed');   // #992: renamed from 'deaf' — it measures unacked lag, not reception
  assert.equal(row.lag, 5);
});

test('#683 POSITIVE CONTROL — the outbound-shaped question calls the same seat healthy', () => {
  // This is the control the card demands, and it is the whole argument for the
  // inbound-only rule: "we have an open stream and we sent to it" scored the
  // deaf seat healthy for EIGHT HOURS. Both projections run on one state here,
  // so the difference cannot be attributed to anything else.
  const dir = tmp();
  seed(dir, 1);
  registerFor(dir, 'registry:minimo.sb', { now: '2026-08-11T02:00:00.000Z' });
  seed(dir, 5);
  const now = Date.parse('2026-08-11T02:01:00.000Z');
  const inbound = reachabilityReport(dir, { now }).find((r) => r.identity === 'registry:minimo.sb');
  const outbound = reachabilityReport(dir, { now, inputs: 'stream_open', streamOpen: { 'registry:minimo.sb': true } })
    .find((r) => r.identity === 'registry:minimo.sb');
  assert.equal(inbound.state, 'unconfirmed');   // #992
  assert.equal(outbound.state, 'reachable',
    'the banned instrument disagrees — that disagreement IS the finding');
});

test('#683 UNREACHABLE — no inbound for a long time', () => {
  const dir = tmp();
  seed(dir, 1);
  registerFor(dir, 'bearer:indigo', { now: '2026-08-11T00:00:00.000Z' });
  const rep = reachabilityReport(dir, { now: Date.parse('2026-08-11T03:00:00.000Z') });
  assert.equal(rep.find((r) => r.identity === 'bearer:indigo').state, 'unreachable');
});

test('#683 a bearer lane ADOPTS a cursor on its first inbound call', () => {
  // @wren and @indigo never call scrum/session/register — measured, 0 and 0.
  // Without adoption they would have no cursor and no replay, and the slice
  // would cover exactly the half of the room it wasn't written for.
  const dir = tmp();
  seed(dir, 4);
  const r = noteInbound(dir, 'bearer:indigo');
  assert.equal(r.adopted, true);
  assert.equal(loadCursors(dir).seats['bearer:indigo'].acked, 4, 'adopts at HEAD, not zero');
  seed(dir, 2);
  assert.deepEqual(serveFor(dir, 'bearer:indigo').events.map((e) => e.seq), [5, 6],
    'and is owed everything after the moment we first saw it');
});

// ── retention: the defects @wren found at the verifier bar ────────────────

/** Delete a day-segment, as a retention sweep eventually will. */
function trimSegment(dir, day) {
  fs.unlinkSync(path.join(dir, `events-${day}.jsonl`));
}

test('#683 RETENTION — a pull REFUSES rather than serving a partial range', () => {
  // Serving "whatever survives" lets the lane ack past events it can never
  // receive: permanent, silent, and `lag` reads 0 afterwards. That is #624
  // arriving through its own cure. /api/changes has refused this since #679 and
  // the card says to reuse the shape — this is the reuse.
  const dir = tmp();
  seed(dir, 3, { day: '2026-08-01' });
  registerFor(dir, 'registry:minimo.sb');
  loadCursors(dir).seats['registry:minimo.sb'].acked = 0;
  saveCursors(dir, Object.assign(loadCursors(dir), {
    seats: { 'registry:minimo.sb': { acked: 0, served: null, last_inbound_at: '2026-08-01T00:00:00.000Z', last_inbound_seq: 0, registered_at: '2026-08-01T00:00:00.000Z' } },
  }));
  seed(dir, 2, { day: '2026-08-11' });
  trimSegment(dir, '2026-08-01');                 // retention eats what it was owed
  const pull = serveFor(dir, 'registry:minimo.sb');
  assert.equal(pull.refused, 'CURSOR_TOO_OLD');
  assert.equal(pull.events.length, 0, 'a partial answer is worse than a refusal here');
  assert.equal(pull.gap.missingFrom, 1);
  assert.equal(pull.gap.missingTo, 3);
  assert.equal(pull.commit(), null, 'a refused pull commits nothing');
  assert.equal(loadCursors(dir).seats['registry:minimo.sb'].acked, 0, 'the cursor did not move');
});

test('#683 RETENTION — oldest_unserved_at goes UNKNOWN, never younger (it fails unsafe otherwise)', () => {
  // readEvents(sinceSeq: acked) returns the oldest SURVIVING event, which after
  // a trim is NEWER than the oldest genuinely-unserved one. A badly-stale lane
  // would report as fresher than it is — and this is the field an age-based
  // staleness guard keys on, so it would clear exactly the three-day-stale
  // harness it exists to catch. Three states, not two.
  const dir = tmp();
  seed(dir, 2, { day: '2026-08-01' });
  saveCursors(dir, { version: 1, seats: { 'bearer:indigo': { acked: 0, served: null, last_inbound_at: '2026-08-01T00:00:00.000Z', last_inbound_seq: 0, registered_at: '2026-08-01T00:00:00.000Z' } } });
  seed(dir, 2, { day: '2026-08-11' });
  const before = envelopeFor(dir, 'bearer:indigo');
  assert.equal(before.oldest_unserved_state, 'known');
  assert.equal(before.oldest_unserved_at, '2026-08-01T00:00:00.000Z');
  trimSegment(dir, '2026-08-01');
  const after = envelopeFor(dir, 'bearer:indigo');
  assert.equal(after.oldest_unserved_state, 'trimmed');
  assert.equal(after.oldest_unserved_at, null, 'never a younger timestamp — unknown is the safe direction');
  assert.equal(after.oldest_retained_at, '2026-08-11T00:00:00.000Z', 'and it says what it CAN see');
});

test('#683 RETENTION — a contiguous log is not mistaken for a trimmed one', () => {
  // The positive control: `oldestSeq <= acked + 1` is the healthy case and must
  // not refuse, or every ordinary pull would 400.
  const dir = tmp();
  seed(dir, 4);
  saveCursors(dir, { version: 1, seats: { 'bearer:indigo': { acked: 0, served: null, last_inbound_at: '2026-08-11T00:00:00.000Z', last_inbound_seq: 0, registered_at: '2026-08-11T00:00:00.000Z' } } });
  const pull = serveFor(dir, 'bearer:indigo');
  assert.equal(pull.refused, undefined);
  assert.deepEqual(pull.events.map((e) => e.seq), [1, 2, 3, 4]);
  assert.equal(envelopeFor(dir, 'bearer:indigo').oldest_unserved_state, 'known');
});
