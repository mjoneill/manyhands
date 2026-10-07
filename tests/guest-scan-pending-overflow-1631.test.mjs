/**
 * #1631 (review 2026-10-07T19:31Z) — the pending list never drops an owed mention to make room. Builder's rows, pure:
 *   PO1 over capacity: nothing moves (pending unchanged, the cursor unchanged), and the overflow is reported.
 *   PO2 at capacity exactly: the scan advances as normal (the guard is not over-eager).
 *   PO3 a pending mention leaves only by its own settlement: the answer cursor passing it does not drop it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advanceScan, settlePending, PENDING_MAX } from '../core/guest-loop.mjs';

const at = (i) => new Date(Date.UTC(2026, 9, 7, 0, 0, i)).toISOString();
const mention = (i) => ({ id: `m${i}`, author: 'ada', body: `@pip question ${i}`, createdAt: at(i), mentions: ['pip'] });
// Every fixture mention is stamped AFTER the cutover line (contract item 4), so the legacy exclusion never applies here.
const CUTOVER = { legacyBefore: new Date(Date.UTC(2026, 9, 6)).toISOString() };
const plain = (i) => ({ id: `p${i}`, author: 'ada', body: `chatter ${i}`, createdAt: at(i) });

test('PO1 over capacity: no owed mention is trimmed and the cursor does not move past the uncaptured ones', () => {
  const owed = Array.from({ length: PENDING_MAX }, (_, i) => ({ ...mention(i) }));
  const state = { ...CUTOVER, pending: owed, scannedThrough: at(PENDING_MAX) };
  const window_ = { complete: true, messages: [mention(PENDING_MAX + 1), plain(PENDING_MAX + 2)] };
  const next = advanceScan(state, window_, 'pip');
  assert.equal(next.pending.length, PENDING_MAX, 'nothing trimmed');
  assert.equal(next.pending[0].id, 'm0', 'the oldest debt is still there');
  assert.equal(next.scannedThrough, at(PENDING_MAX), 'the cursor did not move past the uncaptured mention');
  assert.deepEqual(next.pendingOverflow, { owed: PENDING_MAX + 1, max: PENDING_MAX });
});

test('PO2 at capacity exactly: the scan advances and the overflow marker clears', () => {
  const owed = Array.from({ length: PENDING_MAX - 1 }, (_, i) => ({ ...mention(i) }));
  const state = { ...CUTOVER, pending: owed, scannedThrough: at(PENDING_MAX), pendingOverflow: { owed: 999, max: PENDING_MAX } };
  const next = advanceScan(state, { complete: true, messages: [mention(PENDING_MAX + 1), plain(PENDING_MAX + 2)] }, 'pip');
  assert.equal(next.pending.length, PENDING_MAX);
  assert.equal(next.scannedThrough, at(PENDING_MAX + 2));
  assert.equal(next.pendingOverflow, undefined);
});

test('PO3 a pending mention leaves only by its own settlement, not because the answer cursor passed it', () => {
  const state = { ...CUTOVER, pending: [mention(1)], lastAnsweredId: 'm5', lastAnsweredAt: at(5), scannedThrough: at(5) };
  const next = advanceScan(state, { complete: true, messages: [plain(6)] }, 'pip');
  assert.deepEqual(next.pending.map((m) => m.id), ['m1'], 'the cursor at m5 does not discharge m1');
  assert.deepEqual(settlePending(next, 'm1').pending, [], 'its own settlement does');
});

test('PO4 the cutover line is the cursor AT CUTOVER, not the cursor now: a post-cutover mention behind today\'s answer cursor is still captured', () => {
  const state = { legacyBefore: at(2), lastAnsweredAt: at(10), lastAnsweredId: 'm10', scannedThrough: at(10) };
  const next = advanceScan(state, { complete: true, messages: [mention(5), plain(11)] }, 'pip');
  assert.deepEqual(next.pending.map((m) => m.id), ['m5'], 'stamped after the cutover line, so owed, though the answer cursor has passed it');
  const legacy = advanceScan(state, { complete: true, messages: [mention(1), plain(11)] }, 'pip');
  assert.deepEqual(legacy.pending, [], 'stamped before the cutover line: outside the guarantee, not captured');
});
