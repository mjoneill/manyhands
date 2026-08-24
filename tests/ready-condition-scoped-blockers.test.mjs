/**
 * #1041 — a constraint that blocks ONE acceptance condition is promoted to CARD
 * scope, so the queue reports a card as parked behind an epic when most of it is
 * deliverable.
 *
 * ⛔ THE MEASURED COST. #125 is a p1 impersonation defect. Five of its six
 * conditions were approved by the owner and gate-discharged; ONE (4b) was
 * correctly blocked on an unscheduled auth card. `board_ready` returned
 * `open-blocker:310`, which reads as "parked behind an unscheduled auth epic."
 * Those two sentences send a reader to opposite ends of the backlog, and the
 * card sat four days at the wrong end.
 *
 * ── THE RULING THIS IMPLEMENTS (recorded on the card BEFORE this build) ──────
 *
 *   OFFER THE CARD, AND NAME THE BLOCKED CONDITION.
 *   Neither hide it nor offer it silently.
 *
 * ⭐ WHY NOT "WITHHOLD": that is today, and its cost is the four days above.
 * ⭐ WHY NOT "OFFER SILENTLY": the objection is that a seat starts work it
 *   cannot finish. #125's own branch answers that — it built 5 of 6 and marked
 *   the sixth a declared `todo` WITH ITS REASON, green and honest. Partial
 *   completion under a DECLARED block is healthy here. It stops being healthy
 *   when the block is a SURPRISE found mid-build.
 * ⇒ So the defect is the ONE-BIT MODEL, not its polarity: both answers keep
 *   ready/not-ready as a single bit for a card whose conditions are in mixed
 *   states, and merely flip which way it points.
 *
 * ⚠️ DISCLOSURE: the seat that wrote that ruling wrote this build. The ruling is
 * on the card, argued, with a reversal test, and was published before a line of
 * this existed — precisely so a reader can check whether the implementation
 * drifted toward what was easy rather than what was ruled.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { domainToJsonLd } from '../core/jsonld.mjs';
import { buildGraphStore } from '../core/graph-replica.mjs';
import { readyFromStore, pageReady } from '../core/ready-query.mjs';

const card = (id, shortId, name, extra = {}) => ({
  '@id': id, '@type': 'CreativeWork', identifier: shortId, name, board: {}, ...extra,
});

/**
 * ⭐ THE DISCRIMINATING FIXTURE. Every blocked card here points at the SAME live
 * target, so "is it offered?" cannot be answered by looking at the target — only
 * by looking at whether the block is condition-scoped. A fixture where the two
 * cards blocked differently could pass while reading the wrong field.
 */
const domain = () => ({
  nodes: [
    // ⇒ THE CASE. Card-level edge to `live`, and that edge is fully accounted
    // for by ONE acceptance condition. This is #125's shape.
    card('scoped', 10, 'five conditions deliverable, one blocked', {
      column: 'backlog', 'scrum:priority': 'p1', blockedBy: ['live'],
      'scrum:acceptance': [
        { condition: 'deliverable one', evidence: [] },
        { condition: 'deliverable two', evidence: [] },
        { condition: 'the blocked half — needs the auth work first', evidence: [], blockedBy: ['live'] },
      ],
    }),
    // ⛔ CONTROL 1 (acceptance 2) — blocked in FULL. Same target, no condition
    // claims it, so the card must STILL read blocked and must not leak into the
    // queue as "partially blocked".
    card('whole', 20, 'blocked entirely, no condition scoping', {
      column: 'backlog', 'scrum:priority': 'p1', blockedBy: ['live'],
      'scrum:acceptance': [{ condition: 'something', evidence: [] }],
    }),
    // ⛔ CONTROL 2 (acceptance 3) — MANY conditions, NONE blocked. The count of
    // conditions must never be confused with the count of BLOCKED conditions.
    card('many', 30, 'many conditions, none blocked', {
      column: 'backlog', 'scrum:priority': 'p1',
      'scrum:acceptance': [
        { condition: 'a', evidence: [] }, { condition: 'b', evidence: [] },
        { condition: 'c', evidence: [] }, { condition: 'd', evidence: [] },
      ],
    }),
    // ⛔ CONTROL 3 — a card blocked by TWO targets where only ONE is
    // condition-scoped. Partial accounting must NOT be enough: the unaccounted
    // blocker still removes the card.
    card('partial', 40, 'two blockers, only one scoped', {
      column: 'backlog', 'scrum:priority': 'p1', blockedBy: ['live', 'other'],
      'scrum:acceptance': [
        { condition: 'scoped to live only', evidence: [], blockedBy: ['live'] },
      ],
    }),
    card('live', 50, 'the blocking work', { column: 'backlog', 'scrum:priority': 'p1' }),
    card('other', 60, 'a second blocking card', { column: 'backlog', 'scrum:priority': 'p1' }),
  ],
  messages: [], people: [], columns: [],
});

const verdicts = () => pageReady(readyFromStore(buildGraphStore(domainToJsonLd(domain()))));

test('#1041 a card whose ONLY open blocker is scoped to one condition is OFFERED', () => {
  const { ready } = verdicts();
  assert.equal(ready.some((c) => c.shortId === 10), true,
    'the card is deliverable apart from one declared condition and must reach the queue — '
    + 'withholding it is the defect that cost #125 four days');
});

test('#1041 ⭐ …AND THE OFFER NAMES THE BLOCKED CONDITION — silence is the other failure', () => {
  const { ready } = verdicts();
  const entry = ready.find((c) => c.shortId === 10);
  assert.ok(entry, 'precondition: the card must be offered at all');
  const reasons = (entry.reasons || []).join(' ');

  // ⛔ THE HALF THE RULING INSISTS ON. "Partially blocked" must never become a
  // silent synonym for "ready" — the reason has to sit in the READY ENTRY, not
  // only in the excluded list, or this trades an invisible block for an unread
  // one.
  assert.match(reasons, /blocked-condition/,
    `the ready entry must carry the blocked condition as a reason. Got: ${reasons}`);
  assert.match(reasons, /50|live/,
    `and it must name WHAT the condition waits on, or a reader cannot act on it. Got: ${reasons}`);
  assert.equal(reasons.includes('no-open-blockers'), false,
    'it must NOT also claim "no-open-blockers" — that is the false reason #965 was filed for');
});

test('#1041 ⛔ NEGATIVE CONTROL — a card blocked in FULL still reads blocked', () => {
  const { ready, excluded } = verdicts();
  assert.equal(ready.some((c) => c.shortId === 20), false,
    'a card with no condition claiming its blocker must not leak in as "partially blocked"');
  assert.equal(excluded.find((c) => c.shortId === 20)?.reason, 'open-blocker:50',
    'and it keeps its existing reason unchanged');
});

test('#1041 ⛔ NEGATIVE CONTROL — the count of CONDITIONS is not the count of BLOCKED conditions', () => {
  const { ready } = verdicts();
  const entry = ready.find((c) => c.shortId === 30);
  assert.ok(entry, 'a card with four conditions and no blocker is ordinary available work');
  const reasons = (entry.reasons || []).join(' ');
  assert.equal(reasons.includes('blocked-condition'), false,
    `having conditions must not read as having BLOCKED conditions. Got: ${reasons}`);
  assert.match(reasons, /no-open-blockers/, 'it is plain ready work and should say so');
});

test('#1041 ⛔ NEGATIVE CONTROL — PARTIAL accounting is not enough: an unscoped blocker still excludes', () => {
  const { ready, excluded } = verdicts();
  assert.equal(ready.some((c) => c.shortId === 40), false,
    'one blocker scoped to a condition does not excuse a SECOND blocker nobody claimed — '
    + 'this is the shape that would quietly offer genuinely blocked work');
  assert.equal(excluded.find((c) => c.shortId === 40)?.reason, 'open-blocker:60',
    'and the reason must name the UNACCOUNTED blocker, not the scoped one');
});
