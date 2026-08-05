/**
 * #699 — mention extraction validated against the roster.
 *
 * ⚠️ THESE TESTS EXIST BECAUSE THE API TESTS COULD NOT REACH THE CASE.
 * The default roster has `key === lowercase(name)` for every seat, so a
 * canonicalisation test written against it passes on plain lowercasing —
 * it was green before any code was written. The alias case is only
 * reachable with a roster where the two differ, which is what the live
 * board actually has (one seat's key and display name are different words).
 *
 * That is the wired-falsifier requirement: a test whose failing input can
 * never arrive is indistinguishable from a passing check.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractMentions } from '../core/people.mjs';

// key !== lowercase(name) for `nova`, which is the whole point.
const SEATS = {
  ada:  { name: 'Ada' },
  bex:  { name: 'Bex' },
  nova: { name: 'Stardust' },   // ← display name differs from key
};

test('#699 a display name canonicalises to the seat KEY', () => {
  assert.deepEqual(extractMentions('ping @Stardust please', SEATS), ['nova'],
    'the recorded mention is the key, not the spelling the author used');
});

test('#699 key and display name collapse to ONE canonical entry', () => {
  assert.deepEqual(extractMentions('@nova and @Stardust and @NOVA', SEATS), ['nova'],
    'three spellings of one seat are one mention — this is the query-correctness fix');
});

test('#699 MUTATION GUARD: without canonicalisation this returns two entries', () => {
  // Pins the behaviour the plain-lowercase implementation would produce.
  const out = extractMentions('@nova @Stardust', SEATS);
  assert.equal(out.length, 1, 'a lowercase-only extractor yields ["nova","stardust"] — 2, not 1');
  assert.equal(out[0], 'nova');
});

test('#699 an @token matching no seat is not a mention', () => {
  assert.deepEqual(
    extractMentions('the @context prefix, an @gmail address, @latest, @2026', SEATS), [],
    'JSON-LD terms, email domains, npm tags and years are not colleagues',
  );
});

test('#699 POSITIVE CONTROL: real seats survive alongside junk', () => {
  // Without this, every assertion above passes for an extractor returning [].
  assert.deepEqual(extractMentions('@context @ada @vocab @bex @2026', SEATS).sort(), ['ada', 'bex']);
});

test('#699 an empty or absent roster records NOTHING, and never throws', () => {
  // Fail-closed here is correct: this is a filter, not a diagnostic. With no
  // roster there is no basis to call any token a person, and inventing one
  // would be the fabrication core/people.mjs's header forbids.
  assert.deepEqual(extractMentions('@ada @anyone', {}), []);
  assert.deepEqual(extractMentions('@ada', undefined), []);
  assert.deepEqual(extractMentions(null, SEATS), [], 'non-string body is empty, not a throw');
});

test('#699 a seat entry with no name still matches on its key', () => {
  assert.deepEqual(extractMentions('@solo', { solo: {} }), ['solo'],
    'a roster entry missing a display name must not break key matching');
});
