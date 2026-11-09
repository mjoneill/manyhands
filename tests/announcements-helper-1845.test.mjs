/**
 * #1845 slice 2 — the shared announcement helper names ONE card, never a card whose number merely starts with it.
 *
 * A plain substring match for "claimed #1" also selects "claimed #12" and "claimed #10". With one claim per run that cannot bite;
 * once the helper spreads into a file that claims several cards, "exactly ONE obligation for #1" would see two, or a post count for
 * #1 would include #12's. These rows hold the matcher to the boundary: the number ends where a digit does not follow.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mentionsCard, bodyMatches } from './helpers/announcements.mjs';

const bodies = ['ada claimed #1', 'gizmo claimed #12', 'ada claimed #10 — on behalf of a run', 'ada released #1', 'ada claimed #1.', 'ada claimed #1 (again)'];

test('H1 ONE CARD, NOT ITS PREFIXES: "claimed #1" selects #1 and never #12 or #10', () => {
  const one = mentionsCard('claimed', 1);
  assert.deepEqual(bodies.filter(one), ['ada claimed #1', 'ada claimed #1.', 'ada claimed #1 (again)']);
  assert.deepEqual(bodies.filter(mentionsCard('claimed', 12)), ['gizmo claimed #12']);
  assert.deepEqual(bodies.filter(mentionsCard('claimed', 10)), ['ada claimed #10 — on behalf of a run']);
});

test('H2 THE PHRASE IS PART OF THE MATCH: a release of #1 is not a claim of #1', () => {
  assert.deepEqual(bodies.filter(mentionsCard('released', 1)), ['ada released #1']);
});

test('H3 THE PHRASE IS TEXT, NOT A PATTERN: regex characters in it match only themselves', () => {
  assert.equal(mentionsCard('done.', 2)('doneX #2'), false, 'the dot is a dot, not any character');
  assert.equal(mentionsCard('(a)', 2)('a #2'), false, 'parentheses are text, not a group');
  assert.equal(mentionsCard('(a)', 2)('(a) #2'), true);
  assert.equal(mentionsCard('done.', 2)('done. #2'), true);
});

test('H4 AN OUTBOX ENTRY IS MATCHED BY ITS FROZEN BODY', () => {
  const entries = bodies.map((body, i) => ({ obligationId: `o${i}`, payload: { body } }));
  assert.deepEqual(entries.filter(bodyMatches(mentionsCard('claimed', 1))).map((e) => e.obligationId), ['o0', 'o4', 'o5']);
  assert.equal(bodyMatches(mentionsCard('claimed', 1))({}), false, 'an entry with no body matches nothing');
});
