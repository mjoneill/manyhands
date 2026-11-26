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

// #1954 — an @name inside code is QUOTED, not addressed. The extractor ran
// `@(\w+)` over the raw body, so a post that quoted an earlier ask in
// backticks was recorded as asking that seat, woke her as an ask, and showed
// in her `mentions_me`. Same rule as the connector's own text classifier:
// fenced blocks (``` or ~~~, to the closing fence or the end of the text) and
// inline code spans are removed before matching.
const CODE_SEATS = { ...SEATS, kit: { name: 'Kit' } };

test('#1954 an @name inside an inline code span is not a mention', () => {
  assert.deepEqual(extractMentions('`@kit`', CODE_SEATS), []);
  assert.deepEqual(extractMentions('he asked ``@kit`` earlier', CODE_SEATS), [], 'a double-backtick span too');
});

test('#1954 an @name inside a fenced block is not a mention', () => {
  assert.deepEqual(extractMentions('log:\n```\n@kit ping\n```\ndone', CODE_SEATS), []);
  assert.deepEqual(extractMentions('log:\n~~~\n@kit ping\n~~~', CODE_SEATS), [], 'a tilde fence');
  assert.deepEqual(extractMentions('log:\n```\n@kit never closed', CODE_SEATS), [], 'an unclosed fence runs to the end of the text');
});

test('#1954 POSITIVE CONTROL: an @name in prose is still a mention', () => {
  assert.deepEqual(extractMentions('@kit can you look?', CODE_SEATS), ['kit']);
});

test('#1954 prose @name plus a code @name records ONLY the prose one', () => {
  assert.deepEqual(extractMentions('@kit see what `@ada` said', CODE_SEATS), ['kit']);
  assert.deepEqual(extractMentions('@kit\n```\n@ada\n```\n', CODE_SEATS), ['kit']);
});

test('#1954 a display-name form inside code is not a mention', () => {
  assert.deepEqual(extractMentions('quoting `@Stardust` here', CODE_SEATS), []);
  assert.deepEqual(extractMentions('```\n@Stardust\n```', CODE_SEATS), []);
});

test('#1954 LIVE: the post that woke a seat by quoting her ask in backticks records no mention', () => {
  // Post 2fffc567 (2026-11-16), verbatim except the seat names, which are
  // replaced with this file's neutral roster (the push gate refuses seat
  // names in source): the quoted seat → kit, the others → ada / bex, the
  // owner → Sam. The board stored mentions: [<the quoted seat>] for it.
  const body = [
    '**#1949 is done.** `c58bc95` has been live since 08:30Z.',
    '- A prose mention of her (`a8bd532d`) became a quiet turn, with no notice.',
    '- `@kit` (`55e77633`) got "15" back in 7 s, ACCEPTED.',
    '',
    'Thank you, bex and kit, for the reads tonight, and ada for most of the hard ones. The open thread, a deliberate `NO_REPLY` on a genuine ask surviving core\'s retry, is now **#1953**, kept separate as kit asked. #1951 (hung model call) waits on Sam\'s config decision.',
  ].join('\n');
  assert.deepEqual(extractMentions(body, CODE_SEATS), []);
});
