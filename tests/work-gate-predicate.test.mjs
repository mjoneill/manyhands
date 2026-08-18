/**
 * #890 — the RAIL and the INSTRUMENT must share one predicate, not two copies.
 *
 * ⛔ THE DEFECT, found by a peer within minutes of #886 landing:
 *
 *     core/work-gate.mjs     decideCoveredAction        matches ACTOR and CARD
 *     core/sprint-signals.mjs signalTwoUngrantedActions matches ACTOR alone
 *
 * Before #886 those were the same rule expressed twice. #886 changed one of
 * them, so the instrument now reports violations of a rule the gate no longer
 * implements. Measured on the branch: 10/10 "ungranted actions", every one of
 * which the scoped gate permits.
 *
 * ⭐⭐⭐ AND THE TEST THAT SHOULD HAVE CAUGHT IT PASSES. sprint-signals.test.mjs
 * asserts `COVERED_OPS deepEqual ENFORCED_OPS` and is green — because that test
 * was built for a defect where two LISTS held different strings. This
 * divergence is in the matching PREDICATE, which was never shared and never had
 * a constant to compare.
 *
 *   ⇒ The single-source-of-truth fix unified the cheap half of the agreement
 *     and left the expensive half duplicated, and the test asserting agreement
 *     now passes over exactly the half that disagrees.
 *
 * ⚠️ SO THE FIX IS NOT "TEACH THE SIGNAL ABOUT CARDS." That would be a third
 * expression of the rule, correct on the day it is written. The rule becomes a
 * FUNCTION, exported from the module that enforces it, and the instrument calls
 * it. A copy cannot drift if there is only one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { holdsOpenWindow, decideCoveredAction, UNSCOPABLE_OPS } from '../core/work-gate.mjs';

const NOW = '2026-08-18T12:00:00.000Z';

const window881 = {
  id: 'w-881',
  card: 881,
  declaredBy: 'ada',
  replyBy: '2026-08-18T12:45:00.000Z',
  required: ['bo', 'grace'],
  transitions: [
    { type: 'declare', by: 'ada', at: '2026-08-18T11:59:00.000Z' },
    { type: 'bid', by: 'ada', at: '2026-08-18T11:59:00.000Z' },
  ],
};

test('#890 the predicate is EXPORTED — the rule has one home', () => {
  assert.equal(typeof holdsOpenWindow, 'function',
    'if this is not exported, every consumer must re-express the rule and #890 recurs');
});

test('#890 the predicate answers actor AND card, and returns the window it matched', () => {
  const hit = holdsOpenWindow({ actor: 'ada', card: 881, workObjects: [window881], now: NOW });
  assert.equal(hit?.id, 'w-881', 'the WINDOW, not a boolean — the caller needs its id to report');

  assert.equal(holdsOpenWindow({ actor: 'ada', card: 884, workObjects: [window881], now: NOW }), null,
    'a different card is different work');
  assert.equal(holdsOpenWindow({ actor: 'grace', card: 881, workObjects: [window881], now: NOW }), null,
    'a seat who did not bid holds nothing');
});

test('#890 ⭐⭐ THE GATE ANSWERS THROUGH THE PREDICATE — one rule, checked two ways', () => {
  // ⛔ THE POINT OF THE WHOLE CARD. If decideCoveredAction ever disagrees with
  // holdsOpenWindow, the rail and every instrument built on the predicate have
  // silently forked again — which is #890 recurring under a new number.
  for (const [actor, card] of [['ada', 881], ['ada', 884], ['grace', 881], ['bo', 881]]) {
    const gate = decideCoveredAction({ actor, card, workObjects: [window881], now: NOW });
    const predicate = holdsOpenWindow({ actor, card, workObjects: [window881], now: NOW });
    assert.equal(gate.allow, predicate === null,
      `gate and predicate disagree for ${actor} on #${card}`);
    if (predicate) assert.equal(gate.workObjectId, predicate.id, 'and they must name the SAME window');
  }
});

test('#890 an ARBITRATION_DUE window is held too — the instrument counts what the gate refuses', () => {
  // ⚠️ The instrument's old predicate included ARBITRATION_DUE and so must the
  // shared one, or unifying them would quietly NARROW the measurement while
  // looking like a pure refactor.
  const contested = {
    ...window881,
    transitions: [
      ...window881.transitions,
      { type: 'contest', by: 'bo', at: '2026-08-18T12:00:30.000Z' },
    ],
  };
  const after = '2026-08-18T13:00:00.000Z';
  assert.ok(holdsOpenWindow({ actor: 'ada', card: 881, workObjects: [contested], now: after }),
    'a contested window past replyBy still binds — arbitration is not a grant');
});

test('#890 a window with NO card matches nothing — fail-open on both sides', () => {
  const cardless = { ...window881, card: null };
  assert.equal(holdsOpenWindow({ actor: 'ada', card: 881, workObjects: [cardless], now: NOW }), null);
  assert.equal(holdsOpenWindow({ actor: 'ada', card: null, workObjects: [window881], now: NOW }), null);
});

test('#890 ⛔ R4 — `create` is named as an op the gate CANNOT scope', () => {
  // ⭐ R4 (the room's taxonomy, extended for this): a rail whose covered
  // population is empty must SAY SO. Zero refusals and zero refusable actions
  // are byte-identical from outside the rail.
  //
  // A create brings a card into existence and therefore names none at decision
  // time. Any instrument scoring compliance over creates alone is dividing by a
  // population that cannot contain a violation — and reporting 0/N, which reads
  // as innocence rather than as absence of evidence.
  assert.ok(UNSCOPABLE_OPS.includes('create'),
    'the fact that create cannot be scoped must be a CONSTANT the instrument can read, '
    + 'not a sentence in a comment that only humans can act on');
});
