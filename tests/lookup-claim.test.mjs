/**
 * #1246 — a claimed lookup from a wake that called no tool is a CONTRADICTION
 * the board can detect on its own, with no judgement about whether the content
 * was correct. The prompt already forbids it in English and is enforced by
 * nothing; under pressure the instruction lost.
 *
 * ⛔ The governing risk is the FALSE POSITIVE, and it is asymmetric: a false
 * accusation of fabrication is worse than the fabrication. So most of what
 * follows is the honest speech this must stay silent about.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unbackedLookupClaims } from '../core/lookup-claim.mjs';

const HOP = { id: 'h1', name: 'card_get', arguments: { shortId: 858 }, ok: true, rowCount: 1 };

test('#1246 the specimen: a claim to have read, from a wake with zero hops', () => {
  const text = 'I have read the genesis prompt. The line that resonates most with me is the '
    + 'instruction to treat the board as a shared space where we build knowledge together.';
  const found = unbackedLookupClaims(text, []);
  assert.equal(found.length, 1, 'exactly one claim, not one per sentence');
  assert.match(found[0].phrase, /I have read/i);
  assert.equal(found[0].verb, 'read');
});

test('#1246 the same sentence with a tool call behind it is NOT flagged', () => {
  const text = 'I have read the card and it says the loop is done.';
  assert.deepEqual(unbackedLookupClaims(text, [HOP]), [], 'a wake that looked may say it looked');
});

test('#1246 a hop that FAILED does not back a claim — it proves the opposite', () => {
  const failed = { id: 'h1', name: 'board_search', arguments: { q: 'x' }, ok: false, error: 'board unreachable' };
  assert.equal(unbackedLookupClaims('I searched for it.', [failed]).length, 1);
});

test('#1246 ⛔ NEGATION is honest speech and must stay silent', () => {
  for (const text of [
    'I have not read the genesis prompt.',
    "I haven't checked the board this wake.",
    'I did not find anything about that.',
    'I have never looked at that file.',
    'I cannot say I searched, because I did not.',
  ]) assert.deepEqual(unbackedLookupClaims(text, []), [], text);
});

test('#1246 ⛔ a claim about a PREVIOUS turn is honest speech and must stay silent', () => {
  for (const text of [
    'Earlier I searched for that and came up empty.',
    'Yesterday I checked and it was still open.',
    'On my last wake I read the card body.',
    'Previously I found two of them.',
    'Last time I looked, the column was empty.',
  ]) assert.deepEqual(unbackedLookupClaims(text, []), [], text);
});

test('#1246 ⛔ QUOTED speech belongs to whoever said it', () => {
  for (const text of [
    '> I have read the genesis prompt.',
    'The wake row says "I searched" and no hop backs it.',
    'The offending phrase is `I have read` — that is what to detect.',
    '```\nI have read the file\n```',
  ]) assert.deepEqual(unbackedLookupClaims(text, []), [], text);
});

test('#1246 ⛔ an INTENTION is not a claim', () => {
  for (const text of [
    'I will read it on the next wake.',
    'I can check that if you grant me the tool.',
    'I would have looked, but I have no tool for it.',
    'Should I search for it?',
  ]) assert.deepEqual(unbackedLookupClaims(text, []), [], text);
});

test('#1246 several distinct claims are each named once', () => {
  const found = unbackedLookupClaims('I searched the board. I checked the column. I searched again.', []);
  assert.deepEqual(found.map((f) => f.verb).sort(), ['checked', 'searched'], 'by verb, not by occurrence');
});

test('#1246 empty and absent text are not contradictions', () => {
  assert.deepEqual(unbackedLookupClaims('', []), []);
  assert.deepEqual(unbackedLookupClaims(null, []), []);
  assert.deepEqual(unbackedLookupClaims('A quiet answer with no claim in it.', []), []);
});
