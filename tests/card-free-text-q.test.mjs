/**
 * #656 — free-text `q` on the card list. The last read-half gap, and the one
 * the board asked for itself.
 *
 * ⭐ THE WARRANT IS MEASURED, NOT ARGUED. #656 step 2 has recorded every
 * unsupported filter since it shipped, and #801 made those records durable.
 * `q` is the top real signal in that log — seats asked for free-text search,
 * were refused, and went elsewhere. The refusal string even says so out loud:
 * "free-text q not yet".
 *
 *   ⇒ So this is not a feature someone imagined. It is the board's own miss log
 *     being read and answered, which is exactly what #801 said the log was for:
 *     "the miss log IS the roadmap".
 *
 * ⚠️ STATED LIMITS, because a search that quietly does less than a caller
 * assumes is worse than one that refuses:
 *
 *   · SUBSTRING, case-insensitive. Not tokenised, not stemmed, no ranking.
 *     "build" matches "rebuilding". "built" does NOT match "build".
 *   · Searches TITLE, DESCRIPTION and LABELS — not comments.
 *     ⚠️ WIDENED 2026-08-30 to include labels (@michael's design: curated
 *     taxonomy terms so a seat can find a card by a word its author chose).
 *     Until that day this limit was PROSE-ONLY — the only one of the five
 *     with no test behind it, which is how it could have been crossed in
 *     silence. It is asserted below now, in its new form.
 *   · Combines with every other filter as AND, never OR.
 *
 * Those limits are asserted below rather than described, so a future change
 * that silently widens or narrows them turns a test red instead of surprising
 * a caller.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const card = (shortId, title, description, extra = {}) => ({
  id: `u-${shortId}`, shortId, title, description,
  type: 'task', labels: [], assignees: [], column: 'backlog', order: shortId,
  createdAt: '2026-08-01T00:00:00.000Z', relationships: {}, ...extra,
});

const board = () => makeBoardFixture({
  cards: [
    card(1, 'Voiceprint recognition mismatch', 'the enrolled speaker scores 0.24 on live speech'),
    card(2, 'Rebuilding the graph replica', 'incremental sync by content hash'),
    card(3, 'Unrelated', 'nothing to see', { labels: ['other'] }),
    card(4, 'VOICEPRINT in caps', 'case should not matter'),
    card(5, 'Done work', 'voiceprint appears here too', { column: 'done' }),
  ],
  nextShortId: 6,
});

async function q(baseUrl, qs) {
  const res = await fetch(`${baseUrl}/api/cards?${qs}`);
  const body = await res.json();
  return { status: res.status, body, read: res.headers.get('x-board-read') };
}

test('#656 q matches the title, case-insensitively', async () => {
  const s = await startRestServer({ board: board() });
  try {
    const r = await q(s.baseUrl, 'q=voiceprint&as=ada');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.cards.map((c) => c.shortId).sort((a, b) => a - b), [1, 4, 5],
      'title match, CAPS match, and a body-only match — all three');
  } finally { await s.stop(); }
});

test('#656 q matches the DESCRIPTION, not just the title', async () => {
  // ⚠️ The interesting half. A search that only reads titles would pass a naive
  // smoke test and miss most of what anyone is actually looking for — the body
  // is where the substance lives on this board.
  const s = await startRestServer({ board: board() });
  try {
    const r = await q(s.baseUrl, 'q=content%20hash&as=ada');
    assert.deepEqual(r.body.cards.map((c) => c.shortId), [2],
      'matched on description text that appears in no title');
  } finally { await s.stop(); }
});

test('#656 q ANDs with other filters — never widens the result set', async () => {
  const s = await startRestServer({ board: board() });
  try {
    const all = await q(s.baseUrl, 'q=voiceprint&as=ada');
    const scoped = await q(s.baseUrl, 'q=voiceprint&column=done&as=ada');
    assert.equal(all.body.cards.length, 3);
    assert.deepEqual(scoped.body.cards.map((c) => c.shortId), [5],
      'adding a filter must NARROW. A search that ORs its way to more results is '
      + 'the shape that makes people stop trusting a filter.');
  } finally { await s.stop(); }
});

test('#656 a no-match q returns an EMPTY list with 200 — not an error, not everything', async () => {
  // ⛔ #764's ghost. That defect returned `200` with zero cards for a query that
  // should have matched everything, and nothing distinguished "no matches" from
  // "your query was mangled". Both directions are pinned here: a genuine miss is
  // empty, and the paired control proves the search was working when it said so.
  const s = await startRestServer({ board: board() });
  try {
    const miss = await q(s.baseUrl, 'q=zzzznotpresent&as=ada');
    assert.equal(miss.status, 200);
    assert.equal(miss.body.cards.length, 0, 'a genuine miss is empty');

    const control = await q(s.baseUrl, 'q=voiceprint&as=ada');
    // #715 — on failure, say which read served each response: a shared board
    // that was built empty and a filter that dropped three cards are the same
    // number from outside, and CI is the only place this has ever failed.
    assert.equal(control.body.cards.length, 3,
      `control: the search was alive in the same server that returned the empty set`
      + ` (miss read: ${miss.read ?? 'n/a'}; control read: ${control.read ?? 'n/a'})`);
  } finally { await s.stop(); }
});

test('#656 the limits are REAL — substring, not tokenised or stemmed', async () => {
  // ⚠️ Asserted rather than documented. "built" not matching "build" is a
  // genuine limitation; if someone later adds stemming, this test tells them
  // they changed the contract instead of letting a caller discover it.
  const s = await startRestServer({ board: board() });
  try {
    const sub = await q(s.baseUrl, 'q=build&as=ada');
    assert.deepEqual(sub.body.cards.map((c) => c.shortId), [2],
      'substring: "build" DOES match inside "Rebuilding"');

    const stem = await q(s.baseUrl, 'q=built&as=ada');
    assert.equal(stem.body.cards.length, 0,
      'NOT stemmed: "built" does not match "build". A limitation, pinned so a '
      + 'future change is a decision rather than a surprise.');
  } finally { await s.stop(); }
});

test('#656 q REACHES LABELS — widened 2026-08-30, asserted so it cannot drift back', async () => {
  // ⭐ THE WARRANT: 189 of the first 200 cards carry labels and none of that was
  // reachable by free-text search. A curated label is the author's deliberate
  // word for the thing; prose is whatever they happened to type. @michael's
  // point: let a seat find the card by the chosen term.
  //
  // ⚠️ HISTORY, kept because it is the reason this test exists at all: until
  // 2026-08-30 "not labels" was the ONE stated limit with no assertion behind
  // it — five limits documented, four pinned. The gap was found by reading this
  // file's own preamble against its own contents, and pinned BEFORE the change
  // so that widening it would go red first. It did.
  const s = await startRestServer({ board: board() });
  try {
    const r = await q(s.baseUrl, 'q=other&as=ada');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.cards.map((c) => c.shortId), [3],
      'card 3 carries labels:["other"] and the string appears NOWHERE in its '
      + 'title or description — so a match proves the label itself was searched.');

    // ⛔ AND THE LIMIT THAT DID NOT MOVE: still substring, still not stemmed.
    // Widening one axis must not quietly widen another.
    const stem = await q(s.baseUrl, 'q=othe&as=ada');
    assert.deepEqual(stem.body.cards.map((c) => c.shortId), [3],
      'substring still: "othe" matches inside the label "other"');
  } finally { await s.stop(); }
});

test('#656 q NO LONGER records a retrieval miss — the log closes its own loop', async () => {
  // ⭐⭐ THE POINT. #801's log recorded `q` as the top unmet need. Shipping it
  // must remove `q` from that log, or the roadmap never converges and the same
  // request is "captured" forever while nobody notices it was answered.
  const s = await startRestServer({ board: board() });
  try {
    await q(s.baseUrl, 'q=voiceprint&as=ada');
    const misses = await (await fetch(`${s.baseUrl}/api/misses`)).json();
    assert.equal(misses.byParam.filter((p) => p.param === 'q').length, 0,
      'q is a supported param now and must stop being recorded as a miss');

    // Paired control: an ACTUALLY unsupported param still records, so the
    // absence above is "q is supported", not "the miss log stopped working".
    await q(s.baseUrl, 'q=x&stillNotAThing=1&as=ada&bestEffort=true');
    const after = await (await fetch(`${s.baseUrl}/api/misses`)).json();
    assert.ok(after.byParam.some((p) => p.param === 'stillNotAThing'),
      'control: the miss log is still recording — so the q absence means something');
  } finally { await s.stop(); }
});

test('#656 the refusal string no longer advertises q as missing', async () => {
  // ⚠️ #659's finding: the 400 body is the only place a seat learns what the
  // door can do, and a stale version teaches them to leave. It literally said
  // "free-text q not yet".
  const s = await startRestServer({ board: board() });
  try {
    const r = await q(s.baseUrl, 'definitelyNotAParam=1&as=ada');
    assert.equal(r.status, 400);
    assert.ok(!/free-text q not yet/.test(r.body.error),
      `the door still claims q is unavailable: ${r.body.error}`);
    assert.ok(/\bq\b/.test(r.body.error), 'and q must appear in the SUPPORTED list');
  } finally { await s.stop(); }
});
