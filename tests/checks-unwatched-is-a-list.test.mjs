/**
 * #857 §VI — `cardsUnwatched: 793` IS A NUMBER WHERE THE READER NEEDS A LIST.
 *
 * ⚰️ THE PATTERN THIS BOARD KEEPS RE-LEARNING, four times in one day:
 *
 *   npm audit "0 vulnerabilities"   →  8 reported, and the fix was the LIST
 *   "45% of cards are isolated"     →  95 cards, and 95 is a LIST
 *   "475 activities have no actor"  →  a query, not an absence
 *   "cardsUnwatched: 793"           →  ⛔ still a number
 *
 * ⇒ ⭐ A COUNT TELLS YOU THERE IS A PROBLEM. A LIST TELLS YOU WHOSE. `/api/checks`
 * was built to refuse the flattering reading of `stale: 0` — and it does, honestly,
 * by publishing the unwatched count beside it. But nothing a reader can ACT on
 * comes out of that number: 793 is indistinguishable from 793 typo reports.
 *
 * ── WHAT THIS ADDS, AND WHY IT IS BOUNDED ─────────────────────────────────
 *
 * `unwatchedByType` — the distribution, so "which KIND of claim is unmeasured?"
 * is answerable without fetching anything. Same shape as #629's facets, and for
 * the same reason: learn the shape before paying for the rows.
 *
 * `unwatchedGoals` — the actual list, for `goal` cards only. A goal is the type
 * this room PLANS from (#857, #858, #859 are all goals), it is the smallest
 * type on the board, and an unwatched goal is the case that has already bitten:
 * §IV rotted four times and Phase 2 closed on a stale corpus claim.
 *
 * ⛔ NOT the full 793. A payload nobody reads is the same failure as a number
 * nobody can act on, one size larger — and this endpoint's own note already
 * warns against answers that look complete.
 *
 * ⚠️ `goal` is a JUDGEMENT about which cards matter most, stated here so it can
 * be argued with rather than discovered in the code. It is not a claim that
 * other types don't need watching; it is a claim about where to start.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer } from './helpers/harness.mjs';

const mk = (baseUrl, body) => fetch(`${baseUrl}/api/cards`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ createdBy: 'ada', ...body }),
}).then((r) => r.json());

const checks = async (baseUrl) => {
  const r = await fetch(`${baseUrl}/api/checks`);
  return { status: r.status, body: await r.json() };
};

const A_CHECK = { claim: 'people exist', ask: 'ASK { ?p a schema:Person }', expect: true };

test('#857 §VI the unwatched count is accompanied by a distribution over card type', async () => {
  const s = await startRestServer();
  try {
    await mk(s.baseUrl, { title: 'a goal', type: 'goal' });
    await mk(s.baseUrl, { title: 'a bug', type: 'bug' });
    await mk(s.baseUrl, { title: 'another bug', type: 'bug' });

    const { status, body } = await checks(s.baseUrl);
    assert.equal(status, 200, `checks must answer: ${JSON.stringify(body).slice(0, 200)}`);
    assert.deepEqual(
      body.unwatchedByType, { bug: 2, goal: 1 },
      '"793 unwatched" is not actionable; "which KIND is unmeasured" is the first '
      + `refinement a reader needs. got ${JSON.stringify(body.unwatchedByType)}`,
    );
  } finally { await s.stop(); }
});

test('#857 §VI unwatched GOAL cards come back as a LIST, not a count', async () => {
  const s = await startRestServer();
  try {
    const g = await mk(s.baseUrl, { title: 'the plan nobody watches', type: 'goal' });
    await mk(s.baseUrl, { title: 'a task', type: 'task' });

    const { body } = await checks(s.baseUrl);
    assert.deepEqual(
      body.unwatchedGoals, [{ shortId: g.shortId, title: 'the plan nobody watches' }],
      'a goal is the type this room plans from, and an unwatched plan is the case '
      + `that has already bitten. got ${JSON.stringify(body.unwatchedGoals)}`,
    );
  } finally { await s.stop(); }
});

test('#857 §VI a WATCHED goal leaves the list — the list is of the gap, not of goals', async () => {
  const s = await startRestServer();
  try {
    const watched = await mk(s.baseUrl, { title: 'watched goal', type: 'goal', checks: [A_CHECK] });
    const bare = await mk(s.baseUrl, { title: 'bare goal', type: 'goal' });

    const { body } = await checks(s.baseUrl);
    const ids = (body.unwatchedGoals || []).map((g) => g.shortId);
    assert.ok(!ids.includes(watched.shortId), 'a goal that carries a check must NOT be listed as a gap');
    assert.ok(ids.includes(bare.shortId), 'and one that carries none must be');
    // ⭐ ANCHOR. Both assertions above pass on an endpoint that returns an empty
    // list for everything — the first vacuously, and then the second catches it.
    // Stated so the pairing is deliberate rather than lucky.
    assert.equal(body.cardsWatched, 1, 'exactly one card carries a check here');
    assert.equal(body.unwatchedByType.goal, 1, 'and exactly one goal is counted as unwatched');
  } finally { await s.stop(); }
});

test('#857 §VI an all-watched board reports an EMPTY list, not a missing field', async () => {
  const s = await startRestServer();
  try {
    await mk(s.baseUrl, { title: 'watched goal', type: 'goal', checks: [A_CHECK] });
    const { body } = await checks(s.baseUrl);
    assert.deepEqual(
      body.unwatchedGoals, [],
      'ABSENCE OF A GAP IS A RESULT. A missing field reads as "not measured" and an '
      + 'empty array reads as "measured, none found" — and this endpoint exists '
      + 'precisely because those two are confusable.',
    );
    assert.deepEqual(body.unwatchedByType, {}, 'nothing unwatched means an empty distribution, not undefined');
  } finally { await s.stop(); }
});

test('#857 §VI the note tells the reader what the list does NOT cover', async () => {
  const s = await startRestServer();
  try {
    await mk(s.baseUrl, { title: 'a task', type: 'task' });
    const { body } = await checks(s.baseUrl);
    // The endpoint already refuses the flattering reading of `stale: 0`. A
    // bounded list invites a second flattering reading — "the gap is the goals"
    // — so the payload must say out loud that it is bounded and to what.
    assert.match(
      JSON.stringify(body.note), /goal/i,
      'the note must state that the LIST is bounded to goals while the COUNT is not, '
      + `or a reader takes an empty unwatchedGoals as an empty gap. got ${JSON.stringify(body.note)}`,
    );
  } finally { await s.stop(); }
});
