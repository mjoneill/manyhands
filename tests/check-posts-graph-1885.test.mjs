/**
 * #1885 review of 359df8d: postsSinceQuery compares the post's dateCreated with the lapse time as STRINGS, and a seat
 * declaration's expiresAt is stored as declared (core/seat-state.mjs accepts anything Date.parse takes). A positive-offset expiry
 * would lexically exclude a later post written in Z. lapsedSeats must hand the query the lapse as a UTC ISO instant.
 *   N1  an expiry declared with +02:00 comes out as the same instant in Z, so a post after it in Z compares as later.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lapsedSeats, postsSinceQuery } from '../core/check-posts-graph.mjs';

test('N1 a lapse declared with a +02:00 offset is handed to the query as the same instant in UTC', () => {
  const now = '2026-11-19T12:00:00.000Z';
  const items = lapsedSeats([{ seat: 'ada', role: 'scrum-master', expiresAt: '2026-11-19T09:00:00+02:00' }], now);
  assert.deepEqual(items, [{ seat: 'ada', since: '2026-11-19T07:00:00.000Z' }]);
  assert.ok('2026-11-19T08:00:00.000Z' > items[0].since, 'a post at 08:00Z, after the 07:00Z lapse, compares as later');
  assert.match(postsSinceQuery(items), /"2026-11-19T07:00:00\.000Z"/);
});
