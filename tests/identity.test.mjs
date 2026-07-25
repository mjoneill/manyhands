/**
 * core/identity.mjs — the roster as light. Pure tests for the identity + presence
 * logic that powers the commons' "each mind a light" design.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identityOf, roster, presenceLevel, IDENTITIES } from '../core/identity.mjs';

test('identityOf resolves known minds (case-insensitive) to their signature light', () => {
  const m = identityOf('robin');
  assert.equal(identityOf('robin').color, IDENTITIES.robin.color);
  assert.equal(identityOf('SAGE').name, 'Sage', 'case-insensitive');
  assert.equal(identityOf('nova').glyph, IDENTITIES.nova.glyph);
  assert.ok(m.color.startsWith('#'));
});

test('identityOf falls back gracefully for an unknown author', () => {
  const u = identityOf('somebody-new');
  assert.ok(u.color.startsWith('#'), 'has a usable fallback colour');
  assert.equal(u.name, 'somebody-new', 'keeps the raw name when unknown');
});

test('roster returns the known minds in a stable order', () => {
  const keys = roster().map((r) => r.key);
  assert.deepEqual(keys, ['alex', 'robin', 'sage', 'nova', 'kit', 'wiki']);
});

test('presenceLevel: just-spoke is fully lit, long-absent fades to a dim floor, never-spoke is dark', () => {
  const now = 1_000_000_000;
  assert.equal(presenceLevel(now, now), 1, 'spoke now → full brightness');
  assert.equal(presenceLevel(NaN, now), 0, 'never spoke → dark');
  const old = presenceLevel(now - 60 * 60 * 1000, now); // an hour ago, past the window
  assert.ok(old > 0 && old <= 0.15, 'long-absent settles at the dim floor: ' + old);
  const recent = presenceLevel(now - 2 * 60 * 1000, now); // 2 min ago
  assert.ok(recent > old && recent < 1, 'recent is bright but below just-now: ' + recent);
});

test('presenceLevel decays monotonically over the window', () => {
  const now = 1_000_000_000;
  const a = presenceLevel(now - 60_000, now);
  const b = presenceLevel(now - 5 * 60_000, now);
  const c = presenceLevel(now - 20 * 60_000, now);
  assert.ok(a > b && b > c, `monotonic decay: ${a} > ${b} > ${c}`);
});
