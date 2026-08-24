/**
 * #1027 — the flow report. Does work FINISH?
 *
 * The room has five watches — liveness, delivery, integrity, durability, code
 * quality — plus the deploy-drift report added the same night. None of them
 * asks whether work ARRIVES. On 2026-08-23, seven commits across four p1 cards
 * produced ZERO completions and nobody noticed until the principal did, by eye.
 *
 * ⛔⛔ THE DEFECT THIS INSTRUMENT MUST NOT COMMIT, and it is the whole design:
 *
 *   A report that derives its population FROM ACTIVITY CANNOT SEE INACTIVITY.
 *
 * If seats are discovered by iterating claims, a seat holding nothing has no
 * row — so the one signal that mattered (a teammate who pulled nothing for
 * hours) is the exact signal the natural implementation deletes. The roster is
 * therefore an INPUT, not an inference, and test 1 pins it.
 *
 * Read-only, pure over its inputs, exits 0. It reports; it does not gate.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flowReport } from '../tools/flow-report.mjs';

const NOW = Date.parse('2026-08-24T03:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3600_000).toISOString();

const CARDS = [
  { shortId: 1, column: 'backlog', claimedBy: 'ada', claimedAt: hoursAgo(9), updatedAt: hoursAgo(9) },
  { shortId: 2, column: 'backlog', claimedBy: 'ada', claimedAt: hoursAgo(1), updatedAt: hoursAgo(1) },
  { shortId: 3, column: 'done',    updatedAt: hoursAgo(2) },
  { shortId: 4, column: 'backlog', updatedAt: hoursAgo(2) },
  { shortId: 5, column: 'backlog', updatedAt: hoursAgo(30) },
];

test('#1027 ⭐ a seat that has pulled NOTHING still gets a row — the signal a claims-walk deletes', async () => {
  // ⭐⭐⭐ THE LOAD-BEARING TEST. This is the failure of 2026-08-23 encoded: a
  // teammate held nothing for hours and no instrument could say so, because
  // every view of "who is working" was built by walking work. The roster is an
  // INPUT so that absence has somewhere to appear.
  const r = flowReport({ cards: CARDS, roster: ['ada', 'bex', 'cy'], now: NOW });
  assert.equal(r.ok, true);

  const names = r.wip.map((w) => w.seat).sort();
  assert.deepEqual(names, ['ada', 'bex', 'cy'],
    'every roster seat must appear, including those holding nothing');

  const idle = r.wip.filter((w) => w.held === 0).map((w) => w.seat).sort();
  assert.deepEqual(idle, ['bex', 'cy'], 'and the empty-handed ones must be identifiable');
  assert.ok(r.lines.join('\n').includes('bex'), 'a seat holding nothing must be VISIBLE in the output');
});

test('#1027 WIP counts per seat, and long-held claims are surfaced with their age', async () => {
  // A claim is a mutex, not a deed: the holder is structurally the last to
  // notice they are still holding it.
  const r = flowReport({ cards: CARDS, roster: ['ada', 'bex'], now: NOW, staleClaimHours: 4 });
  const ada = r.wip.find((w) => w.seat === 'ada');
  assert.equal(ada.held, 2);

  assert.equal(r.staleClaims.length, 1, 'exactly one claim is older than the threshold');
  assert.equal(r.staleClaims[0].shortId, 1);
  assert.ok(r.staleClaims[0].hours >= 8, `expected ~9h, got ${r.staleClaims[0].hours}`);
});

test('#1027 ⭐ counts TOUCHED vs FINISHED — the pair whose gap was invisible', async () => {
  // Seven commits, four cards, zero completions. Neither number alone shows it:
  // "4 touched" reads as progress and "0 finished" reads as idle. The GAP is
  // the finding, so both are reported together or neither means anything.
  const r = flowReport({ cards: CARDS, roster: ['ada'], now: NOW, windowHours: 24 });
  assert.equal(r.touched, 4, 'four cards moved inside the window (the 30h-old one did not)');
  assert.equal(r.finished, 1, 'one of them reached done');
  assert.match(r.summary, /4 touched/);
  assert.match(r.summary, /1 finished/);
});

test('#1027 ⛔ zero finished is STATED, never implied by silence', async () => {
  // #726 — a line that appears only on trouble is an alarm with extra steps.
  // And zero-finished is precisely the state that must not be silent, because
  // it is indistinguishable from a quiet healthy day unless it is printed.
  const noneDone = CARDS.map((c) => ({ ...c, column: 'backlog' }));
  const r = flowReport({ cards: noneDone, roster: ['ada'], now: NOW, windowHours: 24 });
  assert.equal(r.finished, 0);
  assert.match(r.summary, /0 finished/, 'zero must be SAID');
});

test('#1027 ⛔ no cards is UNKNOWN, never "0 WIP, all healthy"', async () => {
  // The same false all-clear the drift report refuses. A failed fetch and an
  // idle room produce identical numbers, and only one of them is information.
  const r = flowReport({ cards: null, roster: ['ada'], now: NOW });
  assert.equal(r.ok, false, 'an unusable input must not yield a report');
  assert.equal(r.touched, null, 'and must NOT present counts — least of all zeros');
  assert.match(r.summary, /UNKNOWN/i);
  assert.match(r.error, /card/i);
});

test('#1027 an EMPTY board is a real zero, and is distinguished from a failed read', async () => {
  // The other side of the same coin: [] is a genuine measurement of an empty
  // board. Refusing it would make the instrument unable to report health.
  const r = flowReport({ cards: [], roster: ['ada'], now: NOW });
  assert.equal(r.ok, true, 'an empty board is measurable, unlike a missing one');
  assert.equal(r.touched, 0);
  assert.equal(r.wip.length, 1, 'the roster still gets its rows');
});

test('#1027 ⭐ splits AWAITING-DEPLOY from still-open — but only where the graph can KNOW it', async () => {
  // a review correction, adopted: two states are not enough. A card whose
  // commits exist but are not in production is a different fact from a card
  // nobody has started, and last night the room conflated them.
  //
  // ⛔ AND THE HONEST LIMIT, which is the sharper half: "finished" is NOT
  // derivable. A card can carry commits AND real remaining work — all four of
  // last night's did, and each says so in PROSE. So this reports the fact it
  // can establish (undeployed commits) and refuses to infer the one it cannot
  // (whether the work is done). Naming a card "awaiting deploy" when its
  // default is still unsafe would be the overclaim the flow report exists to
  // prevent, committed by the flow report.
  const deployed = new Set(['a'.repeat(40)]);
  const cards = [
    { shortId: 10, column: 'backlog', implementedBy: ['b'.repeat(40)], updatedAt: hoursAgo(1) },
    { shortId: 11, column: 'backlog', implementedBy: ['a'.repeat(40)], updatedAt: hoursAgo(1) },
    { shortId: 12, column: 'backlog', updatedAt: hoursAgo(1) },
  ];
  const r = flowReport({ cards, roster: ['ada'], now: NOW, deployedShas: deployed });

  assert.deepEqual(r.hasUndeployedWork.map((c) => c.shortId), [10],
    'only the card whose commits are absent from production');
  assert.match(r.summary, /1 with undeployed/);
  assert.ok(!/finished-but-undeployable|complete/i.test(r.summary),
    'the report must NOT claim these cards are FINISHED — it cannot know that');
});

test('#1027 without a deployed-sha set, the deploy split is ABSENT rather than guessed', async () => {
  const cards = [{ shortId: 10, column: 'backlog', implementedBy: ['b'.repeat(40)], updatedAt: hoursAgo(1) }];
  const r = flowReport({ cards, roster: ['ada'], now: NOW });
  assert.equal(r.hasUndeployedWork, null,
    'no deployment facts in ⇒ no deployment claims out. Silence, not zero.');
  assert.ok(!/undeployed/.test(r.summary));
});
