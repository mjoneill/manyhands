/**
 * #1010 condition 5 — THE RESPONSE MUST DISCLOSE ITS OWN TRUNCATION.
 *
 * Measured on the live corpus 2026-08-24, and the defect is NARROWER than the
 * card's headline suggests — which is why the fix is a header and not an
 * envelope:
 *
 *   ?q=deaf              -> 671 rows   the COMPLETE match set. Uncapped.
 *   ?q=deaf&limit=1000   -> 200 rows   silently clamped to MAX_CONV_LIST_LIMIT
 *   ?q=deaf&limit=201    -> 200 rows   silently clamped
 *   ?q=deaf&limit=50     ->  50 rows   honest, under the cap
 *
 * So a caller who asks for nothing gets everything; a caller who asks for MORE
 * THAN THE CAP gets 200 and no signal. That is #1028's class on a second
 * endpoint: "returns fewer than asked without saying it clamped."
 *
 * ⭐ AND THE REAL COST THIS REMOVES: obtaining the true count today means
 * fetching the uncapped set — 1,736,095 bytes for `deaf`. There is no
 * count-only mode. A header supplies the number for nothing, which is what
 * makes a "671 matches" UI affordable at all.
 *
 * ⛔ WHY A HEADER AND NOT AN ENVELOPE: the body is a BARE ARRAY. Wrapping it in
 * {messages, total} would break every existing caller to add a number. The
 * header is additive — the body stays byte-identical — and a test below pins
 * that.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const convs = [
  { id: 'a', body: 'canary one',   author: 'ada', attachedTo: null, createdAt: '2026-08-01T00:00:00.000Z', mentions: [] },
  { id: 'b', body: 'canary two',   author: 'bex', attachedTo: null, createdAt: '2026-08-02T00:00:00.000Z', mentions: [] },
  { id: 'c', body: 'canary three', author: 'cy',  attachedTo: null, createdAt: '2026-08-03T00:00:00.000Z', mentions: [] },
  { id: 'd', body: 'a lone sparrow', author: 'cy', attachedTo: null, createdAt: '2026-08-04T00:00:00.000Z', mentions: [] },
];
const fixture = () => makeBoardFixture({ cards: [], conversations: convs });
// Shrink the cap rather than seeding 201 messages: the defect is about the
// relationship between the cap and the match count, not about big numbers.
const CAP2 = { SCRUM_MAX_CONV_LIST_LIMIT: '2' };

async function get(base, qs) {
  const r = await fetch(`${base}/api/conversations${qs}`);
  return { status: r.status, body: await r.json(), total: r.headers.get('x-total-count') };
}

test('#1010 a CLAMPED response discloses the true match count, so truncation is detectable', async () => {
  const s = await startRestServer({ board: fixture(), env: CAP2 });
  try {
    const r = await get(s.baseUrl, '?q=canary&limit=99');
    assert.equal(r.status, 200);
    assert.equal(r.body.length, 2, 'precondition: the cap clamped 99 down to 2');
    assert.equal(r.total, '3',
      'the header must carry the TRUE match count (3), not the returned count (2) — '
      + 'otherwise a caller cannot tell 2-of-2 from 2-of-3, which is the whole defect');
    assert.ok(r.body.length < Number(r.total),
      'and from those two numbers alone a caller computes truncation with no inference');
  } finally { await s.stop(); }
});

test('#1010 ⭐ NEGATIVE CONTROL — a COMPLETE response must not look truncated', async () => {
  // ⛔ The over-disclosure failure: if the header reported the corpus size, or
  // the cap, or anything other than the match count, every complete response
  // would read as truncated and the signal would be worthless.
  const s = await startRestServer({ board: fixture(), env: CAP2 });
  try {
    const r = await get(s.baseUrl, '?q=sparrow&limit=99');
    assert.equal(r.body.length, 1, 'one match, under the cap');
    assert.equal(r.total, '1', 'rows == total means COMPLETE, and must say so');
  } finally { await s.stop(); }
});

test('#1010 ⭐ NEGATIVE CONTROL — the BODY is unchanged: still a bare array', async () => {
  // ⛔ THE LOAD-BEARING CONTROL. An envelope would disclose the total and break
  // every existing caller to do it. The disclosure must cost nothing to anyone
  // who ignores it.
  const s = await startRestServer({ board: fixture() });
  try {
    const raw = await (await fetch(`${s.baseUrl}/api/conversations?q=canary`)).text();
    assert.ok(raw.trimStart().startsWith('['),
      `the response must remain a bare JSON array, not an envelope. Got: ${raw.slice(0, 80)}`);
    const parsed = JSON.parse(raw);
    assert.ok(Array.isArray(parsed) && parsed.length === 3, 'and carry the same rows as before');
  } finally { await s.stop(); }
});

test('#1010 the count is stated even when it is ZERO (#726)', async () => {
  // A line that appears only on trouble is an alarm with extra steps, and its
  // absence is unreadable: a missing header cannot be distinguished from an old
  // server that never sent one.
  const s = await startRestServer({ board: fixture() });
  try {
    const r = await get(s.baseUrl, '?q=zzzz-no-such-term');
    assert.deepEqual(r.body, []);
    assert.equal(r.total, '0', 'zero matches is a real answer and must be stated');
  } finally { await s.stop(); }
});

test('#1010 an UNCAPPED query reports total == rows, so the two agree when nothing was dropped', async () => {
  const s = await startRestServer({ board: fixture() });
  try {
    const r = await get(s.baseUrl, '?q=canary');
    assert.equal(r.body.length, 3, 'no limit passed ⇒ uncapped, per #202');
    assert.equal(r.total, '3');
  } finally { await s.stop(); }
});
