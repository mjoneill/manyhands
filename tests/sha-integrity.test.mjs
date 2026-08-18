/**
 * #896 — every sha on the board must resolve to a real commit.
 *
 * ⛔ THE DEFECT, measured on its own author. I wrote `implementedBy` on two cards
 * forty minutes apart and BOTH shas were fabricated — I read the seven-character
 * abbreviation out of `git push` output and typed forty, inventing thirty-three
 * each time. Both passed every check the write path has, because the field
 * validates SHAPE (40 lowercase hex) and not EXISTENCE.
 *
 * ⚠️ AND THE GUARD IS WHAT MADE IT EASIER. An hour earlier the same field refused
 * me for a SHORT sha. I read that refusal as evidence the field was protected.
 *
 *   ⇒ A guard that refuses the failure mode you are watching for tells you
 *     nothing about the one you are not.
 *
 * ── WHY THIS IS A STANDING CHECK AND NOT A VALIDATOR ────────────────────────
 *
 * The obvious fix is to resolve on write. It is wrong here, and MEASURED wrong:
 *
 *     a dev-only commit          dev can resolve it   YES
 *                                PROD can resolve it   NO
 *
 * The REST server serves from the deploy clone, and the real order is
 * commit → push → write the card → THEN pull and deploy. At write time the
 * serving clone genuinely does not have the object yet. ⇒ **A write-path check
 * would have refused every legitimate sha written tonight.**
 *
 * ⭐ A rail whose failure mode is "the board stops accepting truth" is worse
 * than the defect it prevents — the work gate spent an afternoon proving that
 * by refusing three correct actions. So this refuses nothing: it watches the
 * whole population continuously and reports.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectShas, verifyShaIntegrity } from '../core/sha-integrity.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const UUID = '11111111-2222-3333-4444-555555555555';

const board = () => ({
  nodes: [
    { shortId: 1, implementedBy: [A] },
    // ⚠️ BOTH FIELDS, because the fabrication landed in BOTH. The corrected card
    // carried the invented sha in `implementedBy` AND in five `acceptance[].evidence`
    // slots; fixing only the first would have left five copies of the same lie.
    { shortId: 2, acceptance: [{ condition: 'x', evidence: [B, `commit:${A}`] }] },
    { shortId: 3, acceptance: [{ condition: 'y', evidence: [`entity:${UUID}`, UUID] }] },
    { shortId: 4 },
  ],
});

test('#896 collects shas from implementedBy AND acceptance evidence, both cards named', () => {
  const found = collectShas(board());
  assert.deepEqual([...found.keys()].sort(), [A, B].sort(),
    'a uuid is not a sha and must not be reported as an unresolvable commit');
  assert.deepEqual([...found.get(A)].sort(), [1, 2],
    'the same sha on two cards names both — a fix has to reach every copy');
});

test('#896 ⛔ an unresolvable sha is REPORTED with the cards carrying it', async () => {
  const r = await verifyShaIntegrity(board(), { resolve: async (shas) => new Set([A]) });
  assert.equal(r.status, 'measured');
  assert.equal(r.checked, 2);
  assert.equal(r.unresolved.length, 1);
  assert.equal(r.unresolved[0].sha, B);
  assert.deepEqual(r.unresolved[0].cards, [2],
    'naming the sha without naming the card leaves the reader an archaeology job');
});

test('#896 ⭐ a clean board reports a REAL zero, over a stated denominator', async () => {
  const r = await verifyShaIntegrity(board(), { resolve: async () => new Set([A, B]) });
  assert.equal(r.status, 'measured');
  assert.deepEqual(r.unresolved, []);
  assert.equal(r.checked, 2, 'the zero is only meaningful beside what it was checked against');
});

test('#896 ⛔⛔ REPO UNREACHABLE IS UNMEASURABLE, NEVER ZERO', async () => {
  // ⭐ THE WHOLE DISCIPLINE OF THIS FILE. "No fabrications found" and "I could
  // not look" are byte-identical from outside unless the instrument says which
  // one it is — and this check runs in a server that may not have a git repo
  // beside it at all. A zero here would read as an audited, clean board.
  const r = await verifyShaIntegrity(board(), {
    resolve: async () => { throw new Error('not a git repository'); },
  });
  assert.equal(r.status, 'unmeasurable');
  assert.equal('unresolved' in r, false, 'an unmeasurable check must carry no findings');
  assert.match(r.missingInput, /git|repositor/i);
  assert.equal(r.checked, 2, 'it may still say how many it WOULD have checked');
});

test('#896 an empty population is UNMEASURABLE too — nothing to be clean about', async () => {
  const r = await verifyShaIntegrity({ nodes: [{ shortId: 1 }] }, { resolve: async () => new Set() });
  assert.equal(r.status, 'unmeasurable',
    'zero shas checked and zero unresolved is a structural zero, not a clean board');
});

test('#896 the check NAMES what it cannot see, in its own output', async () => {
  // ⚠️ Carried from tools/verify-implemented-by.mjs, whose wording is exactly
  // right: a REAL commit that has not been fetched into this clone resolves as
  // missing here. Unresolvable means UNVERIFIABLE FROM HERE, not fabricated —
  // and this check runs on the deploy clone, which LAGS the push by design.
  const r = await verifyShaIntegrity(board(), { resolve: async () => new Set([A]) });
  assert.match(r.blindTo, /fetched|clone|lag/i);
  assert.match(r.blindTo, /not fabricated|unverifiable/i,
    'without this, a lagging clone turns every fresh sha into an accusation');
});

test('#896 one resolver call for the whole population, not one per sha', async () => {
  // A check that spawned a process per sha would be 264 processes on a board
  // this size, on an endpoint anyone can hit.
  let calls = 0;
  await verifyShaIntegrity(board(), {
    resolve: async (shas) => { calls += 1; assert.equal(shas.length, 2); return new Set(shas); },
  });
  assert.equal(calls, 1);
});
