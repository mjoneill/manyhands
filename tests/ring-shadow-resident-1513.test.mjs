/**
 * #1513 — SHADOW record for the RESIDENT path: what each resident's slot looked
 * like against the receipt trail the runner already writes
 * (offered → claimed → turn-started → published). Log only: it reads delivery
 * events and reports; it decides nothing. The specimen behind it: round 1 of the
 * #1362 trial, a live turn (turn-started 22:45:09Z) inside a slot that expired at
 * 22:49:28Z, its output landing at 22:53:43Z.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { residentSlotShadow } from '../core/ring-shadow.mjs';

const T = (s) => `2026-09-28T22:${s}Z`;
const ev = (state, at, extra = {}) => ({ state, at: T(at), ...extra });
const slot = { seat: 'bubbles', cycle: 3, openedAt: T('44:26.000'), deadline: T('49:26.000') };

test('a slot that expired with a live turn inside it says so, and how long the turn had been running', () => {
  const r = residentSlotShadow({
    ...slot, outcome: 'timeout', closedAt: T('49:28.858'),
    deliveries: [{ id: 'd1', offeredAt: T('44:27.000'), state: 'turn-started', events: [ev('offered', '44:27.000'), ev('claimed', '44:54.000'), ev('turn-started', '45:09.585')] }],
  });
  assert.equal(r.outcome, 'timeout');
  assert.equal(r.turnRunningAtClose, true, 'the receipt existed and the slot ignored it');
  assert.equal(r.turnRunMsAtClose, 259273, 'turn-started 22:45:09.585 → close 22:49:28.858');
  assert.equal(r.offerToClaimMs, 27000);
  assert.equal(r.claimToTurnStartMs, 15585);
  assert.equal(r.publishedAt, null);
});

test('a runner that never claimed is a different miss from a turn still running', () => {
  const r = residentSlotShadow({
    ...slot, outcome: 'timeout', closedAt: T('49:28.858'),
    deliveries: [{ id: 'd1', offeredAt: T('44:27.000'), state: 'offered', events: [ev('offered', '44:27.000')] }],
  });
  assert.equal(r.turnRunningAtClose, false);
  assert.equal(r.claimedAt, null);
  assert.equal(r.turnStartedAt, null);
});

test('a slot that closed on a published turn reports the turn length and no overrun', () => {
  const r = residentSlotShadow({
    ...slot, outcome: 'published', closedAt: T('46:10.000'),
    deliveries: [{ id: 'd1', offeredAt: T('44:27.000'), state: 'published', events: [ev('offered', '44:27.000'), ev('claimed', '44:54.000'), ev('turn-started', '45:09.000'), ev('published', '46:09.500')] }],
  });
  assert.equal(r.turnRunningAtClose, false);
  assert.equal(r.turnMs, 60500);
  assert.equal(r.publishedAfterClose, false);
});

test('an output that lands AFTER the slot closed is marked, so the late-result fence is observable', () => {
  const r = residentSlotShadow({
    ...slot, outcome: 'timeout', closedAt: T('49:28.858'),
    deliveries: [{ id: 'd1', offeredAt: T('44:27.000'), state: 'published', events: [ev('offered', '44:27.000'), ev('claimed', '44:54.000'), ev('turn-started', '45:09.585'), ev('published', '53:43.180')] }],
  });
  assert.equal(r.publishedAfterClose, true);
  assert.equal(r.turnRunningAtClose, true, 'at the close it had not published yet');
  assert.equal(r.turnMs, 513595, 'turn-started → published = 8 min 33.6 s, the figure #1513 sizes from');
});

test('several offers to one record use the earliest claim/turn-start and the latest publish, and tolerate a record with no events', () => {
  const r = residentSlotShadow({
    ...slot, outcome: 'published', closedAt: T('47:00.000'),
    deliveries: [
      { id: 'd1', offeredAt: T('44:27.000'), state: 'published', events: [ev('offered', '44:27.000'), ev('claimed', '44:50.000'), ev('turn-started', '45:00.000'), ev('published', '46:00.000')] },
      { id: 'd2', offeredAt: T('44:28.000'), state: 'published', events: [ev('offered', '44:28.000'), ev('claimed', '44:51.000'), ev('turn-started', '45:01.000'), ev('published', '46:30.000')] },
      { id: 'd3', offeredAt: T('44:29.000'), state: 'offered' },
    ],
  });
  assert.equal(r.deliveryCount, 3);
  assert.equal(r.claimedAt, T('44:50.000'));
  assert.equal(r.turnStartedAt, T('45:00.000'));
  assert.equal(r.publishedAt, T('46:30.000'));
});
