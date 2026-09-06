/**
 * #1246 sibling — THE FUTURE TENSE. `unbackedLookupClaims` catches a seat that
 * says it ALREADY looked. This catches the one that says it is ABOUT to, and
 * then does not, because the wake ends and there is no later.
 *
 * ⛔ WHY THIS IS NOT HONEST SPEECH, even though an intention normally is: in a
 * one-shot wake there is no next turn. "I will search and report back" is a
 * promise that cannot be kept by construction — the turn is over. It reads as
 * cooperative and delivers nothing, which is worse than a refusal because the
 * asker waits.
 *
 * Measured on this board 2026-09-06: of seven genuine asks to look something
 * up, six produced no tool call, and the seat announced the lookup in several
 * of them. The prompt forbids this in three consecutive clauses and lost.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { announcedLookup } from '../core/lookup-claim.mjs';

test('#1246b the specimen: announcing a search that never ran', () => {
  const found = announcedLookup('I will search for the genesis prompt and read it to understand its meaning.');
  assert.ok(found, 'the announcement is detected');
  assert.match(found.phrase, /I will search/i);
});

test('#1246b the other shapes seen on this board', () => {
  for (const text of [
    'I am looking for the genesis prompt to understand the board’s purpose. I will search the board for it now.',
    'Let me look that up for you.',
    "I'm going to check the board and get back to you.",
    'I will read the card and report back.',
  ]) assert.ok(announcedLookup(text), text);
});

test('#1246b ⛔ a REFUSAL is the behaviour we want and must never be flagged', () => {
  for (const text of [
    'Nothing I can reach can see that file, so I cannot answer it.',
    'I have no tool that would help here, so I will not guess.',
    'I searched and nothing matched.',
    'I would need the card number to look it up.',
  ]) assert.equal(announcedLookup(text), null, text);
});

test('#1246b ⛔ an intention about something OTHER than a lookup is ordinary speech', () => {
  for (const text of [
    'I will remember that for next time.',
    'I will keep this short.',
    'I will think about what you said.',
  ]) assert.equal(announcedLookup(text), null, text);
});

test('#1246b quoted or fenced speech belongs to whoever said it', () => {
  assert.equal(announcedLookup('> I will search for it'), null);
  assert.equal(announcedLookup('The seat said "I will search" and never did.'), null);
});

test('#1246b empty and absent text announce nothing', () => {
  assert.equal(announcedLookup(''), null);
  assert.equal(announcedLookup(null), null);
  assert.equal(announcedLookup('Card #1249 holds it; the body opens with a line about the word.'), null);
});
