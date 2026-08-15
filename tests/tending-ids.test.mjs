/**
 * #804 — the canonical @id contract, shared by #805 bootstrap and #804 runtime.
 *
 * Two implementations of "the id" would drift, and the drift would present as
 * duplicate nodes rather than as a bug. So the functions are published once and
 * both builds import them.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  promptId, promptVersionId, playlistId, playlistVersionId,
  silenceId, mintId, claimAttemptId, controlEventId, newEventKey,
} from '../core/tending-ids.mjs';

// ── ⭐ THE ONE THAT MATTERS: identical text must not merge lineages ────────

test('⛔ two DIFFERENT prompts with IDENTICAL text get different version ids', () => {
  // ⇒ THE DISCRIMINATION: an id derived from body text would return the SAME
  // value here, silently merging two lineages into one node — one author, one
  // history, and no error anywhere. The merge is invisible precisely because
  // the result looks like a well-formed single prompt.
  const sameText = '*quietly* Shhhh. Quiet hour.';
  const a = promptVersionId('quiet-hour', 1);
  const b = promptVersionId('backlog-nudge', 1);
  assert.notEqual(a, b, 'identity is the prompt lineage, never the body');
  // and the body genuinely plays no part — passing it nowhere is the point
  assert.equal(a.includes(encodeURIComponent(sameText)), false);
});

test('a prompt keeps ONE durable identity across every reworking', () => {
  const p = promptId('quiet-hour');
  assert.equal(promptVersionId('quiet-hour', 1).startsWith(p), true);
  assert.equal(promptVersionId('quiet-hour', 7).startsWith(p), true);
  assert.notEqual(promptVersionId('quiet-hour', 1), promptVersionId('quiet-hour', 7));
});

// ── idempotency by construction ───────────────────────────────────────────

test('⭐ every id is a pure function — re-running bootstrap upserts, never duplicates', () => {
  // Idempotency by construction rather than by a "does it already exist?"
  // check, which can race and can drift between two callers.
  const pairs = [
    [() => promptId('quiet-hour'), 'promptId'],
    [() => promptVersionId('quiet-hour', 3), 'promptVersionId'],
    [() => playlistId('default'), 'playlistId'],
    [() => playlistVersionId('default', 2), 'playlistVersionId'],
    [() => silenceId('2026-08-15T00:00:00.000Z'), 'silenceId'],
    [() => mintId('2026-08-15T00:00:00.000Z', '2026-08-15T00:05:00.000Z'), 'mintId'],
    [() => claimAttemptId('fixed-key-1'), 'claimAttemptId'],
    [() => controlEventId('fixed-key-2'), 'controlEventId'],
  ];
  for (const [fn, name] of pairs) {
    assert.equal(fn(), fn(), `${name} must be deterministic`);
  }
});

// ── ⛔ EVENTS: uniqueness may NEVER be inferred from timestamp + identity ──

test('⛔ two attempts on the SAME mint, SAME millisecond, SAME declared seat are DISTINCT', () => {
  // ⇒ THE DISCRIMINATION: an id derived from (mint, receivedAt, declaredSeat)
  // returns ONE value here, silently collapsing two genuine attempts into a
  // single node. Under contention — the exact condition these records exist to
  // capture — that discards one of the two facts, and a lost refusal is
  // precisely what made the 2026-08-14 incident unadjudicable.
  const a = claimAttemptId(newEventKey());
  const b = claimAttemptId(newEventKey());
  assert.notEqual(a, b, 'each attempt is its own event, not a function of when it arrived');
});

test('⛔ two control events at the SAME timestamp remain distinct', () => {
  const a = controlEventId(newEventKey());
  const b = controlEventId(newEventKey());
  assert.notEqual(a, b);
});

test('an event id REFUSES to be derived — it demands an explicit key', () => {
  // Refusing loudly is the point: a caller that has no unique key must be told,
  // not handed a plausible id computed from a timestamp.
  assert.throws(() => claimAttemptId(), /explicit unique eventKey/);
  assert.throws(() => claimAttemptId(''), /explicit unique eventKey/);
  assert.throws(() => controlEventId(undefined), /explicit unique eventKey/);
});

test('newEventKey is unique per call', () => {
  const keys = new Set(Array.from({ length: 200 }, () => newEventKey()));
  assert.equal(keys.size, 200);
});

test('a silence is identified by when it began', () => {
  assert.notEqual(silenceId('2026-08-15T00:00:00.000Z'), silenceId('2026-08-15T01:00:00.000Z'));
});

test('the id functions refuse junk rather than producing a plausible id', () => {
  assert.throws(() => promptId(''), /required/);
  assert.throws(() => promptVersionId('x', 0), /positive integer/);
  assert.throws(() => promptVersionId('x', 1.5), /positive integer/);
  assert.throws(() => silenceId(undefined), /required/);
  assert.throws(() => mintId('a'), /required/);
});
