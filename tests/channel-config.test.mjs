/**
 * #263 — persisted channel-delivery config: validation, defaults, atomic
 * round-trip. The bounds matter (a bad save must not be able to wedge delivery).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateConfig, readConfig, writeConfig, DEFAULT_CONFIG, LIMITS } from '../channel-config.mjs';

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

// ── #737 — the advertised bound must BE the enforced bound ────────────────
//
// The owner typed 120 and 360 into fields labelled "seconds" and was told
// "soft window must satisfy 0 <= minMs <= maxMs <= 300000". The rejection was
// correct — 360s is 360000ms, over the 5-minute ceiling — but the sentence
// quotes milliseconds at someone looking at a seconds field, so there is no way
// to derive "the limit is 300" from it. The editor now states bounds in seconds,
// which means it needs them from the server rather than as a copied constant.
//
// The hazard that copy would create is exactly what these tests close: LIMITS
// is published for the UI, so a LIMITS that disagreed with validateConfig would
// advertise a value the server refuses — a false assurance on the path of the
// action, which is worse than the unreadable message it replaced.
//
// So these do not assert LIMITS equals 300000 (that passes trivially and would
// pass just as well if both sides were wrong together). They assert the
// advertised edge is ACCEPTED and one unit past it is REJECTED, i.e. that the
// number the UI shows is the number the validator enforces.
test('#737 the advertised soft ceiling is exactly the enforced one', () => {
  const at = validateConfig({
    mode: 'soft',
    soft: { minMs: LIMITS.soft.minMs, maxMs: LIMITS.soft.maxMs },
    hard: { timeoutMs: 300000 },
    tokenRing: { timeoutMs: 300000 },
  });
  assert.equal(at.soft.maxMs, LIMITS.soft.maxMs, 'the advertised ceiling must be accepted');

  assert.throws(() => validateConfig({
    mode: 'soft',
    soft: { minMs: LIMITS.soft.minMs, maxMs: LIMITS.soft.maxMs + 1 },
    hard: { timeoutMs: 300000 },
    tokenRing: { timeoutMs: 300000 },
  }), /soft window/, 'one millisecond past the advertised ceiling must be refused');
});

test('#737 the advertised hard and token-ring bounds are the enforced ones', () => {
  const edges = (timeoutMs, ringMs) => validateConfig({
    mode: 'hard', soft: { minMs: 0, maxMs: 1000 },
    hard: { timeoutMs }, tokenRing: { timeoutMs: ringMs },
  });

  assert.ok(edges(LIMITS.hard.minMs, LIMITS.tokenRing.minMs), 'advertised floors must be accepted');
  assert.ok(edges(LIMITS.hard.maxMs, LIMITS.tokenRing.maxMs), 'advertised ceilings must be accepted');

  assert.throws(() => edges(LIMITS.hard.minMs - 1, LIMITS.tokenRing.minMs), /hard\.timeoutMs/);
  assert.throws(() => edges(LIMITS.hard.maxMs + 1, LIMITS.tokenRing.minMs), /hard\.timeoutMs/);
  assert.throws(() => edges(LIMITS.hard.minMs, LIMITS.tokenRing.minMs - 1), /token-ring/);
  assert.throws(() => edges(LIMITS.hard.minMs, LIMITS.tokenRing.maxMs + 1), /token-ring/);
});

// The owner's exact input, kept as a named case so the regression is legible:
// 120→360 seconds is a REAL violation, not a false rejection. Whether the
// ceiling should be 5 minutes at all is a product question (#737 does not
// change it) — but if it is ever raised, this test is where the decision
// becomes visible rather than silent.
test('#737 120s→360s is genuinely out of range — the ceiling is 300s, not a UI bug', () => {
  assert.throws(() => validateConfig({
    mode: 'soft',
    soft: { minMs: 120 * 1000, maxMs: 360 * 1000 },
    hard: { timeoutMs: 300000 },
    tokenRing: { timeoutMs: 300000 },
  }), /soft window/);

  assert.ok(validateConfig({
    mode: 'soft',
    soft: { minMs: 120 * 1000, maxMs: 300 * 1000 },
    hard: { timeoutMs: 300000 },
    tokenRing: { timeoutMs: 300000 },
  }), '120s→300s sits exactly at the ceiling and must be accepted');
});
