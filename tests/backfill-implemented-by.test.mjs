/**
 * #814 — the backfill's HARVEST rule, pinned.
 *
 * The steward's criteria are the spec:
 *   BF1  anchored to a REAL git sha — never invented
 *   BF2  not findable ⇒ EMPTY, never a best guess
 *   BF3  backfill makes the schema visible, not the schema true
 *
 * ⭐ The direction is the load-bearing choice. This harvests COMMIT → CARD from
 * subject lines: `fix(#764): …` is an author's explicit statement, made at the
 * time of the work, in an immutable object. Reading a card body and guessing
 * which commit shipped it is the "best guess" BF2 forbids, and is how a backfill
 * manufactures a history that never happened.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harvest } from '../tools/backfill-implemented-by.mjs';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

test('#814 BF1 — a card links only to shas actually read from git', () => {
  const got = harvest([`${SHA_A} fix(#764): the parser stopped returning zero`]);
  assert.deepEqual([...got.get('764')], [SHA_A]);
});

test('#814 BF1 — a SHORT sha is refused, never expanded', () => {
  // #821's rule, and it is not cosmetic: the graph cannot expand an
  // abbreviation, so a short and a long form become TWO nodes for one commit.
  const got = harvest([`a75a247 fix(#764): short sha`]);
  assert.equal(got.size, 0, 'a line whose sha is not 40 chars contributes nothing');
});

test('#814 BF2 — only the SUBJECT is harvested, never the body', () => {
  // A body routinely discusses other cards — "same shape as #831", "unlike
  // #593". Those are references, not claims of implementation. Harvesting them
  // would assert that a commit implemented every card it mentioned in passing.
  const lines = [`${SHA_A} feat(#725): wire the event log into the graph`];
  const got = harvest(lines);
  assert.deepEqual([...got.keys()], ['725'],
    'the subject named exactly one card, so exactly one card is claimed');
});

test('#814 one commit may implement several cards, and several commits one card', () => {
  const got = harvest([
    `${SHA_A} fix(#801)(#656): the miss log and the search that answered it`,
    `${SHA_B} fix(#801): mark answered needs`,
  ]);
  assert.deepEqual([...got.get('801')].sort(), [SHA_A, SHA_B].sort());
  assert.deepEqual([...got.get('656')], [SHA_A]);
});

test('#814 a subject with no card reference yields nothing', () => {
  // ⚠️ THE PAIRED CONTROL. Without it, a harvester that matched everything
  // would pass every test above.
  const got = harvest([`${SHA_A} chore: tidy imports`]);
  assert.equal(got.size, 0, 'no card named ⇒ no claim made');
});

test('#814 a malformed log line is skipped, not guessed at', () => {
  const got = harvest(['', 'nosha', `${SHA_A}`]);
  assert.equal(got.size, 0);
});

test('#814 a bare number is NOT a card reference', () => {
  // "fixes 764 tests" must not be read as card #764. The hash is the marker,
  // and requiring it is the difference between a citation and a coincidence.
  const got = harvest([`${SHA_A} perf: 764 tests now run in 40s`]);
  assert.equal(got.size, 0, 'only #NNN counts');
});
