/**
 * #777 — `/api/conversations` must REFUSE an unknown param, not ignore it.
 *
 * The defect: an unrecognised query param was silently dropped and the endpoint
 * answered with its ENTIRE corpus — 14,468 conversations as of the day this was
 * written — under a 200. So `?athor=wren` (a typo) and `?` (no filter at all)
 * produce byte-identical responses, and the typo reads exactly like a filter
 * that matched everything.
 *
 * ⚠️ The sibling endpoints already refuse. `/api/changes` and `/api/cards` both
 * return 400 naming the unsupported param AND the supported set, and #683's
 * `/api/cursors/*` shipped with the same guard from birth — its own comment
 * says so, citing this card. ⇒ This was never a design question: it is a
 * pattern that existed one endpoint over and was never applied here.
 *
 * ⚠️ THE POSITIVE CONTROLS ARE THE POINT. A guard that refuses everything
 * passes every test written to prove it refuses. Every supported param is
 * exercised below, plus the no-param case, because "does it fire?" and "does it
 * fire ONLY when it should?" are different questions and only the second is a
 * test. All six supported params are asserted individually — a guard whose
 * allow-list is missing one would silently break a working filter, which is a
 * worse defect than the one being fixed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const json = (body) => ({
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

/** A board with two posts by different authors, one attached to a card. */
async function fixture() {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], conversations: [] }) });
  const card = await (await fetch(`${srv.baseUrl}/api/cards`, json({ title: 'a card', createdBy: 'ada' }))).json();
  // ⚠️ The mention must name a ROSTER seat: extractMentions() resolves against
  // ROSTER, so `@bex` (a fixture name) is never extracted and `mentions_me=bex`
  // would match nothing. Asserting 1 on that was my own wrong assumption, caught
  // by this file's positive control before the guard existed — which is the
  // control doing exactly its job.
  await fetch(`${srv.baseUrl}/api/conversations`, json({ body: 'from ada @wren', author: 'ada', attachedTo: card.id }));
  await fetch(`${srv.baseUrl}/api/conversations`, json({ body: 'from bex', author: 'bex' }));
  return { srv, card };
}

const list = (srv, qs = '') => fetch(`${srv.baseUrl}/api/conversations${qs}`);

// ── the defect ──────────────────────────────────────────────────────────────

test('#777 an UNKNOWN param is refused, not ignored', async () => {
  const { srv } = await fixture();
  try {
    const res = await list(srv, '?bogus=1');
    assert.equal(res.status, 400, 'an unsupported param must refuse');
    const body = await res.json();
    assert.match(body.error, /bogus/, 'the refusal NAMES the offending param');
    assert.deepEqual(body.unsupported, ['bogus']);
  } finally { await srv.stop(); }
});

test('#777 the refusal NAMES the supported params — an error a caller can act on', async () => {
  const { srv } = await fixture();
  try {
    const body = await (await list(srv, '?bogus=1')).json();
    // Without this the caller learns only that they were wrong, not what is right.
    for (const p of ['attachedTo', 'author', 'since', 'mentions_me', 'before', 'limit']) {
      assert.match(body.error, new RegExp(p), `the supported set must mention ${p}`);
    }
  } finally { await srv.stop(); }
});

test('#777 ⭐ THE ACTUAL DAMAGE — a TYPO no longer returns the whole corpus', async () => {
  // This is the defect in its real clothes. `athor` is one keystroke from
  // `author`; before the guard it returned every conversation on the board
  // with a 200, indistinguishable from an unfiltered list.
  const { srv } = await fixture();
  try {
    const typo = await list(srv, '?athor=ada');
    const unfiltered = await list(srv, '');
    assert.equal(unfiltered.status, 200);
    assert.equal(typo.status, 400,
      'a typo must NOT silently become "give me everything"');
  } finally { await srv.stop(); }
});

test('#777 several unknown params are ALL named, not just the first', async () => {
  const { srv } = await fixture();
  try {
    const body = await (await list(srv, '?bogus=1&alsobad=2')).json();
    assert.deepEqual(body.unsupported.sort(), ['alsobad', 'bogus'],
      'a caller with two typos should not have to fix them one round-trip at a time');
  } finally { await srv.stop(); }
});

// ── POSITIVE CONTROLS: every supported param must still work ────────────────

test('#777 POSITIVE CONTROL — no params still returns the full list', async () => {
  const { srv } = await fixture();
  try {
    const res = await list(srv, '');
    assert.equal(res.status, 200);
    assert.equal((await res.json()).length, 2, 'the unfiltered list is untouched');
  } finally { await srv.stop(); }
});

test('#777 POSITIVE CONTROL — every supported param is accepted and still filters', async () => {
  const { srv, card } = await fixture();
  try {
    // Each assertion would fail if the allow-list omitted that param — which is
    // the way a fail-closed guard breaks working callers.
    const byAuthor = await list(srv, '?author=ada');
    assert.equal(byAuthor.status, 200);
    assert.equal((await byAuthor.json()).length, 1, 'author still filters');

    const byCard = await list(srv, `?attachedTo=${card.id}`);
    assert.equal(byCard.status, 200);
    assert.equal((await byCard.json()).length, 1, 'attachedTo still filters');

    const boardLevel = await list(srv, '?attachedTo=null');
    assert.equal(boardLevel.status, 200);
    assert.equal((await boardLevel.json()).length, 1, 'attachedTo=null still filters');

    // ⚠️ ACCEPTANCE only, not a count. `mentions_me` filters on the `mentions`
    // array, which `extractMentions()` populates from ROSTER — and this fixture
    // server has no roster, so nothing is ever extracted and the filter matches
    // nothing regardless of the guard. Asserting a count here would test mention
    // EXTRACTION, which is not this file's subject, and would fail for a reason
    // that has nothing to do with #777.
    // ⇒ What matters for the guard is that the param is ALLOWED (200, not 400).
    const byMention = await list(srv, '?mentions_me=wren');
    assert.equal(byMention.status, 200, 'mentions_me must not be refused as unsupported');

    const bySince = await list(srv, '?since=1970-01-01T00:00:00.000Z');
    assert.equal(bySince.status, 200);
    assert.equal((await bySince.json()).length, 2, 'since still filters');

    const byBefore = await list(srv, '?before=2999-01-01T00:00:00.000Z');
    assert.equal(byBefore.status, 200);
    assert.equal((await byBefore.json()).length, 2, 'before still filters');

    const byLimit = await list(srv, '?limit=1');
    assert.equal(byLimit.status, 200);
    assert.equal((await byLimit.json()).length, 1, 'limit still filters');
  } finally { await srv.stop(); }
});

test('#777 POSITIVE CONTROL — supported params COMBINE without tripping the guard', async () => {
  // The guard checks each key independently; a combination must not read as
  // unsupported. Cheap to assert, and the failure would be invisible until a
  // real caller used two filters at once.
  const { srv } = await fixture();
  try {
    const res = await list(srv, '?author=ada&limit=5');
    assert.equal(res.status, 200);
    assert.equal((await res.json()).length, 1);
  } finally { await srv.stop(); }
});
