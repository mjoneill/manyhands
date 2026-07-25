/**
 * #263 — persisted channel-delivery config: validation, defaults, atomic
 * round-trip. The bounds matter (a bad save must not be able to wedge delivery).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateConfig, readConfig, writeConfig, DEFAULT_CONFIG } from '../channel-config.mjs';

const tmpFile = () => path.join(os.tmpdir(), `scrum-chan-cfg-${process.pid}-${Math.random().toString(36).slice(2)}.json`);

test('validateConfig accepts a well-formed config and normalizes numbers', () => {
  const c = validateConfig({ mode: 'hard', soft: { minMs: '10000', maxMs: '20000' }, hard: { timeoutMs: '120000' } });
  assert.equal(c.mode, 'hard');
  assert.deepEqual(c.soft, { minMs: 10000, maxMs: 20000 });
  assert.deepEqual(c.hard, { timeoutMs: 120000 });
});

test('validateConfig rejects a bad mode', () => {
  assert.throws(() => validateConfig({ mode: 'sideways', soft: { minMs: 0, maxMs: 1 }, hard: { timeoutMs: 60000 } }), /mode must be/);
});

test('validateConfig rejects max < min and an out-of-range soft window', () => {
  assert.throws(() => validateConfig({ mode: 'soft', soft: { minMs: 50000, maxMs: 10000 }, hard: { timeoutMs: 60000 } }), /soft window/);
  assert.throws(() => validateConfig({ mode: 'soft', soft: { minMs: 0, maxMs: 9999999 }, hard: { timeoutMs: 60000 } }), /soft window/);
});

test('validateConfig rejects a hard timeout outside the safe range', () => {
  assert.throws(() => validateConfig({ mode: 'hard', soft: { minMs: 0, maxMs: 1 }, hard: { timeoutMs: 5000 } }), /timeoutMs/);
  assert.throws(() => validateConfig({ mode: 'hard', soft: { minMs: 0, maxMs: 1 }, hard: { timeoutMs: 99999999 } }), /timeoutMs/);
});

test('readConfig returns defaults when the file is missing', () => {
  assert.deepEqual(readConfig(tmpFile()), DEFAULT_CONFIG);
});

test('readConfig returns defaults when the file is corrupt (never crashes)', () => {
  const f = tmpFile();
  fs.writeFileSync(f, 'not json {{{');
  assert.deepEqual(readConfig(f), DEFAULT_CONFIG);
  fs.unlinkSync(f);
});

test('writeConfig persists, and readConfig reads it back', () => {
  const f = tmpFile();
  const written = writeConfig({ mode: 'hard', soft: { minMs: 30000, maxMs: 45000 }, hard: { timeoutMs: 240000 } }, f);
  assert.equal(written.mode, 'hard');
  assert.deepEqual(readConfig(f), { mode: 'hard', soft: { minMs: 30000, maxMs: 45000 }, hard: { timeoutMs: 240000 }, tokenRing: { timeoutMs: 300000 } });
  fs.unlinkSync(f);
});

// #410 — token-ring mode: off/soft/hard behavior is unchanged; this only adds an
// accepted mode + a bounded lease TTL, defaulting when the sub-config is absent.
test('validateConfig accepts mode:token-ring and defaults the lease TTL when absent', () => {
  const c = validateConfig({ mode: 'token-ring', soft: { minMs: 30000, maxMs: 60000 }, hard: { timeoutMs: 300000 } });
  assert.equal(c.mode, 'token-ring');
  assert.deepEqual(c.tokenRing, { timeoutMs: 300000 }, 'token-ring TTL defaults when not supplied');
});

test('validateConfig normalizes a supplied token-ring.timeoutMs string to a number', () => {
  const c = validateConfig({ mode: 'token-ring', soft: { minMs: 30000, maxMs: 60000 }, hard: { timeoutMs: 300000 }, tokenRing: { timeoutMs: '120000' } });
  assert.deepEqual(c.tokenRing, { timeoutMs: 120000 });
});

test('validateConfig rejects a token-ring lease TTL below the debounce floor or above the ceiling', () => {
  const base = { mode: 'token-ring', soft: { minMs: 30000, maxMs: 60000 }, hard: { timeoutMs: 300000 } };
  assert.throws(() => validateConfig({ ...base, tokenRing: { timeoutMs: 60000 } }), /token-ring\.timeoutMs/, 'below 90s floor (would reap before ~60s debounce) rejected');
  assert.throws(() => validateConfig({ ...base, tokenRing: { timeoutMs: 99999999 } }), /token-ring\.timeoutMs/, 'above 30min ceiling rejected');
});

test('DEFAULT_CONFIG carries a token-ring sub-config and stays soft-by-default', () => {
  assert.equal(DEFAULT_CONFIG.mode, 'soft', 'token-ring is opt-in; default delivery unchanged');
  assert.deepEqual(DEFAULT_CONFIG.tokenRing, { timeoutMs: 300000 });
});

test('writeConfig throws on invalid input and does NOT write the file', () => {
  const f = tmpFile();
  assert.throws(() => writeConfig({ mode: 'nope' }, f), /mode must be/);
  assert.equal(fs.existsSync(f), false, 'invalid config never hit disk');
});
