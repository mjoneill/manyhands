/**
 * #953 slice 2 — `quietAfterMinutes` is PERSISTED CONFIG, not a constant.
 *
 * Acceptance 5: "RESTART PRESERVES the setting." That falls out of using the
 * existing sidecar rather than inventing a second mechanism — and the config
 * module's own header already anticipated this exact extension:
 *
 *   "This is also the seed of the PAUSE control the successor requires —
 *    explicit persisted state, never a sentinel cadence value. Pause is this
 *    mechanism with a second field, NOT A NEW ONE."
 *
 * ⚠️ THE TRAP THIS FILE EXISTS TO CATCH. `validateTendingConfig` returns
 * `{ enabled: input.enabled }` — a whitelist. Any field it does not know about
 * is DROPPED, and `writeTendingConfig` validates before persisting, so a
 * setting written through the supported path would round-trip to nothing with
 * no error at any layer. That is #823's shape (a write accepted and silently
 * discarded) arriving in the config surface, and the owner would experience it
 * as "I set it and it didn't stick."
 *
 * ⛔ The default stays 20 for compatibility with @michael's stated intent
 * ("default was 20"), and it is a DEFAULT rather than a recorded choice — the
 * card is explicit that we lack evidence about who picked the live cadence and
 * must not rewrite history around it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  validateTendingConfig, readTendingConfig, writeTendingConfig,
  quietAfterMinutes, DEFAULT_QUIET_AFTER_MINUTES,
} from '../tending-config.mjs';

const tmpFile = (tag) => path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), `tending953-${tag}-`)), 'tending-config.json',
);

/**
 * ⭐⭐⭐ THE CONTROL FOR THE WHITELIST TRAP. Write through the supported path,
 * read back through the supported path, and assert the value survived. A
 * validator that drops the field passes every other test in this file.
 */
test('#953 quietAfterMinutes ROUND-TRIPS through write → read', () => {
  const f = tmpFile('roundtrip');
  writeTendingConfig({ enabled: true, quietAfterMinutes: 45 }, f);
  const back = readTendingConfig(f);
  assert.equal(back.quietAfterMinutes, 45,
    'the setting was accepted and did not survive the write — a whitelist validator dropped it, '
    + 'and the owner would experience that as "I set it and it did not stick"');
  assert.equal(back.enabled, true, 'and the existing field is unharmed');

  // Acceptance 5: a restart is a fresh read of the same file.
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).quietAfterMinutes, 45,
    'the value must be ON DISK, or it cannot survive a restart');
});

test('#953 an absent quietAfterMinutes DEFAULTS rather than disabling the gate', () => {
  const f = tmpFile('absent');
  fs.writeFileSync(f, JSON.stringify({ enabled: true }));
  assert.equal(readTendingConfig(f).quietAfterMinutes, DEFAULT_QUIET_AFTER_MINUTES);
  assert.equal(quietAfterMinutes(f), DEFAULT_QUIET_AFTER_MINUTES,
    'every config written before this slice must keep working');
  assert.equal(DEFAULT_QUIET_AFTER_MINUTES, 20,
    "@michael's stated default was 20 minutes; changing it silently would be a second undisclosed choice");
});

/**
 * ⛔ REFUSE, don't coerce. A malformed value must not be quietly turned into a
 * number — "0" or "" or null coerced to 0 would mean "never quiet enough" or
 * "always quiet", and both are silent behaviour changes.
 */
test('#953 an INVALID quietAfterMinutes is refused, not coerced', () => {
  for (const bad of ['20', 0, -5, null, Number.NaN, Infinity, {}]) {
    assert.throws(() => validateTendingConfig({ enabled: true, quietAfterMinutes: bad }),
      `quietAfterMinutes ${JSON.stringify(bad)} must be REFUSED, not coerced into a threshold`);
  }
});

test('#953 a corrupt config still fails CLOSED, as before', () => {
  const f = tmpFile('corrupt');
  fs.writeFileSync(f, '{ not json');
  const c = readTendingConfig(f);
  assert.equal(c.enabled, false, 'unreadable config must leave tending OFF — unchanged behaviour');
  assert.equal(c.quietAfterMinutes, DEFAULT_QUIET_AFTER_MINUTES,
    'and still expose a usable threshold rather than undefined');
});
