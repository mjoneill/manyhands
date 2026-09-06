/**
 * #1241 — the status bar shows who is ACTUALLY here, and counts who is not.
 *
 * The bar listed every seat, so a seat that went quiet weeks ago crowded out
 * one that arrived this morning. The constraint that makes this non-trivial is
 * #717/#718: a stopped seat and a quiet seat are indistinguishable, so a bar
 * that silently drops people replaces a crowding problem with a vanishing one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constellationOrder } from '../core/identity.mjs';

const NOW = Date.parse('2026-09-06T16:00:00.000Z');
const min = (n) => n * 60 * 1000;

test('#1241 live = spoke inside the window, ordered freshest first', () => {
  const minds = [{ key: 'kit' }, { key: 'sage' }, { key: 'robin' }, { key: 'nova' }];
  const last = new Map([
    ['kit', NOW - min(60 * 24 * 9)],   // nine days ago
    ['sage', NOW - min(2)],
    ['robin', NOW - min(1)],
    ['nova', NOW - min(30)],
  ]);
  const { live, quiet, quietCount } = constellationOrder(minds, last, NOW);
  assert.deepEqual(live.map((m) => m.key), ['robin', 'sage', 'nova'], 'freshest first');
  assert.deepEqual(quiet.map((m) => m.key), ['kit'], 'nine days ago is not in the room');
  assert.equal(quietCount, 1);
});

test('#1241 ⛔ the quiet are COUNTED, never deleted — #717: a stopped seat and a quiet seat look the same', () => {
  const minds = [{ key: 'a' }, { key: 'gone' }, { key: 'never' }];
  const last = new Map([['a', NOW - min(1)], ['gone', NOW - min(90)]]);
  const { live, quiet, quietCount } = constellationOrder(minds, last, NOW);
  assert.deepEqual(live.map((m) => m.key), ['a']);
  // Both the faded and the never-seen are still REPORTED. A bar that renders
  // only the living cannot answer "did someone stop?" — which is the failure
  // this board already has a card about.
  assert.equal(quietCount, 2);
  assert.deepEqual(quiet.map((m) => m.key), ['gone', 'never'], 'most-recently-faded first; never-spoken last');
  assert.equal(quiet.find((m) => m.key === 'never').lastPostMs, null, 'never-spoken is null, not zero — absence is not a timestamp');
});

test('#1241 spoke-EVER is not spoke-NOW — the boundary is the window, not existence', () => {
  const minds = [{ key: 'edge' }];
  const justInside = constellationOrder(minds, new Map([['edge', NOW - min(44)]]), NOW);
  const justOutside = constellationOrder(minds, new Map([['edge', NOW - min(46)]]), NOW);
  assert.equal(justInside.live.length, 1);
  assert.equal(justOutside.live.length, 0, 'a seat that posted last Tuesday is not in the room');
  assert.equal(justOutside.quietCount, 1);
});

test('#1241 an empty room reports empty rather than throwing, and a plain object works as the map', () => {
  const none = constellationOrder([], new Map(), NOW);
  assert.deepEqual(none.live, []); assert.equal(none.quietCount, 0);
  // the caller builds a Map today; accepting a plain object keeps the pure
  // function usable from a test or a server without constructing one.
  const viaObject = constellationOrder([{ key: 'x' }], { x: NOW - min(3) }, NOW);
  assert.deepEqual(viaObject.live.map((m) => m.key), ['x']);
});
