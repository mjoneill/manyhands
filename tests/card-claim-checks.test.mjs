/**
 * #792 / #857 §VI — A CLAIM CAN CARRY THE MEASUREMENT THAT WOULD FALSIFY IT.
 *
 * ⛔ THE PROBLEM, from #792, which is a card about this exact failure:
 *
 *   "#714 card said BUILD THIS FIRST / tree held every item ALREADY SHIPPED.
 *    #773 card said the fixes were not chosen / tree held BOTH were built.
 *    The card and the tree disagreed, and the card is what a reader trusts."
 *
 * And #857 §IV — the apex card's own built/not-built table — rotted TWICE in
 * thirty hours, listing three cards as NOT BUILT while they sat in `done`.
 * Both times a person had to notice.
 *
 * ⛔ #792 KILLED THE OBVIOUS DESIGNS, and its objection is the real one:
 *
 *   "a bot that diffs card claims against the tree ⇒ needs claims to be
 *    machine-readable; THEY ARE PROSE, DELIBERATELY"
 *
 * ⭐ THE WAY THROUGH IS TO STOP TRYING TO READ THE PROSE. The author who writes
 * a load-bearing claim is the one person who knows what would make it false, at
 * the moment they know it. So they attach the check THEN — an ASK query and the
 * answer it must give — and the prose stays prose.
 *
 *   claim   "people and columns are not yet nodes"
 *   ask     ASK { ?p a schema:Person }
 *   expect  false                       ⇐ the day this returns true, the claim is stale
 *
 * ⚠️ WHAT THIS IS NOT. It does not verify the claim is TRUE — no mechanism can.
 * It detects that the world moved under a claim whose author named a tripwire.
 * A claim with no check is unwatched and must be REPORTED as unwatched rather
 * than counted as holding — an unmeasured claim named "passing" is the exact
 * defect this file exists to remove.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

// ⚠️ The first version of this control used `ASK { ?p a schema:Person }` with
// expect:false, on the assumption that a fixture board has no people. It does:
// declaring an author mints `person:ada`, so the "holding" control was itself
// stale and the test failed for a reason that had nothing to do with the code.
// Probed rather than reasoned about. The control now names a type nothing
// mints, so it holds for a stated reason instead of an assumed one.
// ⚠️ CHANGED BY #1104, and the reason matters more than the edit.
//
// This was `ASK { ?x a scrum:Sasquatch }` — a deliberately impossible type, so
// the control could never trip. #1104's unknown-term guard now REFUSES a term
// the projection can never emit, so that ask became an `error` rather than a
// `holds` and this control failed.
//
// ⛔ THE FIX IS NOT TO EXEMPT /api/checks. A falsifier whose predicate is
// misspelled holds FOREVER and can never fire — "a check that cannot fail" is
// the exact failure this endpoint exists to prevent, so surfacing it as `error`
// is the endpoint working better, not worse. `scrum:Decision` is REAL and this
// fixture has none, which is what the control actually needs: a tripwire that
// COULD trip and hasn't.
const CHECK_HOLDS = {
  claim: 'this board holds no Decisions',
  ask: 'ASK { ?d a scrum:Decision }',
  expect: false,
};
const CHECK_STALE = {
  claim: 'this board contains no cards at all',
  ask: 'ASK { ?c a schema:CreativeWork }',
  expect: false,           // ⇐ deliberately FALSE-in-practice: cards exist, so this is stale
};

async function post(baseUrl, body) {
  const res = await fetch(`${baseUrl}/api/cards`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('#792 checks round-trip through create — declared, accepted, AND stored', async () => {
  // ⚠️ #831's three-list invariant, as a wire test rather than a promise: a field
  // the schema declares and the validator accepts but the constructor drops is
  // accepted with a 201 and silently discarded, and the caller cannot tell.
  const s = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    const r = await post(s.baseUrl, { title: 'carries a check', checks: [CHECK_HOLDS], by: 'ada' });
    assert.equal(r.status, 201);
    assert.equal(r.body.ignoredFields, undefined,
      'the route must not report `checks` as ignored — that is the create/patch disagreement class');

    // The 201 body is the write's own echo. The FRESH read is the evidence.
    const got = await (await fetch(`${s.baseUrl}/api/cards/${r.body.shortId}`)).json();
    assert.deepEqual(got.checks, [CHECK_HOLDS], 'read back from a fresh GET, not from the echo');
  } finally { await s.stop(); }
});

test('#792 /api/checks reports a claim whose world has moved', async () => {
  const s = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    const holds = await post(s.baseUrl, { title: 'a claim that still holds', checks: [CHECK_HOLDS], by: 'ada' });
    const stale = await post(s.baseUrl, { title: 'a claim the world outgrew', checks: [CHECK_STALE], by: 'ada' });

    const res = await fetch(`${s.baseUrl}/api/checks`);
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));

    const byCard = Object.fromEntries(body.results.map((r) => [r.shortId, r]));

    // ⭐ THE PAIRED CONTROL. Reporting the stale one proves nothing on its own —
    // a checker that flags everything would also flag it. The holding claim must
    // come back holding in the SAME run.
    assert.equal(byCard[holds.body.shortId].checks[0].status, 'holds',
      'control: a claim whose tripwire has not tripped must NOT be reported stale');
    assert.equal(byCard[stale.body.shortId].checks[0].status, 'stale',
      'the board now has cards, so "this board contains no cards at all" is falsified');

    assert.equal(body.stale, 1, 'exactly one stale claim, counted');
    assert.equal(byCard[stale.body.shortId].checks[0].claim, CHECK_STALE.claim,
      'the report names the CLAIM in the author\'s words, not just a query');
  } finally { await s.stop(); }
});

test('#792 a card with no checks is UNWATCHED, never "passing"', async () => {
  // ⛔ THE LESSON FROM #866, APPLIED BEFORE IT COSTS ANYTHING. An unmeasurable
  // direction must not be named agreement. A board where nobody wrote a check is
  // not a board whose claims all hold — it is a board nothing is watching, and
  // a summary that says "0 stale" without saying "of 1 watched" is the vibes
  // number this whole night has been about.
  const s = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    await post(s.baseUrl, { title: 'no checks at all', by: 'ada' });
    await post(s.baseUrl, { title: 'watched', checks: [CHECK_HOLDS], by: 'ada' });

    const body = await (await fetch(`${s.baseUrl}/api/checks`)).json();
    assert.equal(body.cardsWatched, 1, 'one card carries checks');
    assert.equal(body.cardsUnwatched, 1, 'and one carries none — reported, not ignored');
    assert.equal(body.results.length, 1, 'only watched cards produce results');
    assert.equal(body.stale, 0);
  } finally { await s.stop(); }
});

test('#792 a malformed check is REFUSED at the door, not stored and discovered later', async () => {
  const s = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    for (const [bad, why] of [
      [[{ claim: 'no ask', expect: false }], 'a claim with no query cannot be checked'],
      [[{ claim: 'x', ask: 'ASK { ?s ?p ?o }' }], 'a check with no expectation cannot fail'],
      [[{ claim: 'x', ask: 'DELETE { ?s ?p ?o }', expect: false }], 'writes must never run'],
      [[{ claim: 'x', ask: 'SELECT ?s WHERE { ?s ?p ?o }', expect: false }], 'must be an ASK — SELECT has no boolean'],
      ['not an array', 'checks must be a list'],
    ]) {
      const r = await post(s.baseUrl, { title: 'bad', checks: bad, by: 'ada' });
      assert.equal(r.status, 400, `${why} — got ${r.status} ${JSON.stringify(r.body)}`);
    }
  } finally { await s.stop(); }
});

test('#792 a check that cannot run is reported as ERROR, never as holding', async () => {
  // ⚠️ THE FAIL-SILENT TRAP THIS WHOLE SURFACE COULD BECOME. If a broken query
  // resolved to "holds", the checker would go green precisely when it stopped
  // working — a health signal blind to its own failure, which is the defect
  // class the room has spent the day naming.
  const s = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    // Syntactically valid at write time, unrunnable against the store.
    const r = await post(s.baseUrl, {
      title: 'a check that breaks', by: 'ada',
      checks: [{ claim: 'nonsense', ask: 'ASK { ?s <not a valid iri> ?o }', expect: true }],
    });
    if (r.status === 400) return;   // refusing at the door is also a correct answer

    const body = await (await fetch(`${s.baseUrl}/api/checks`)).json();
    const res = body.results.find((x) => x.shortId === r.body.shortId);
    assert.equal(res.checks[0].status, 'error',
      'an unrunnable check must be ERROR — never "holds", which would make a broken '
      + 'watcher indistinguishable from a watched claim');
    assert.ok(body.errors >= 1, 'and errors are counted separately from stale');
  } finally { await s.stop(); }
});
