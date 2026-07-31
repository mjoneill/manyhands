/**
 * #578 — claim/release notifications (child lane of #576).
 *
 * `POST /api/cards/:id/claim` is the ONLY card mutation on this server that
 * carries an identity (`by`). Everything else — PATCH, the browser's whole-board
 * /api/save — is anonymous. So a claim transition is the one card event we can
 * announce truthfully today, and this suite pins that announcement.
 *
 * ⚠️ SCOPE, so a future reader doesn't over-read a green run: this fires on
 * CLAIM and RELEASE only. It would NOT have fired on the 2026-07-31 event that
 * motivated #576 — a seat writing to the description of someone else's card,
 * with no claim and no resolvable actor. This is a floor, not the fix.
 *
 * Behaviour tests: they assert that a post exists in the commons with the right
 * fields, not that some emitter function exists. The negative controls are the
 * load-bearing half — see the comment above each.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const json = (extra = {}) => ({
  headers: { 'Content-Type': 'application/json' },
  ...extra,
});

/** A board with one card assigned to `sage`, so actor ≠ assignee is testable. */
function boardWithCard(overrides = {}) {
  return makeBoardFixture({
    cards: [{
      id: 'card-uuid-1',
      shortId: 42,
      title: 'A card someone else owns',
      description: '',
      type: 'task',
      assignees: ['sage'],
      labels: [],
      priority: null,
      column: 'backlog',
      order: 0,
      createdAt: '2026-07-31T00:00:00.000Z',
      updatedAt: '2026-07-31T00:00:00.000Z',
      relationships: { relatedTo: [], blockedBy: [] },
      claimedBy: null,
      claimedAt: null,
      ...overrides,
    }],
    nextShortId: 43,
  });
}

/** Board-level commons posts (attachedTo null), newest last. */
async function commonsPosts(baseUrl) {
  const res = await fetch(`${baseUrl}/api/conversations?attachedTo=null`);
  assert.equal(res.status, 200);
  return await res.json();
}

const claim = (baseUrl, id, by) =>
  fetch(`${baseUrl}/api/cards/${id}/claim`, json({ method: 'POST', body: JSON.stringify({ by }) }));

const release = (baseUrl, id, by) =>
  fetch(`${baseUrl}/api/cards/${id}/claim`, json({ method: 'DELETE', body: JSON.stringify({ by }) }));

function claimTest(name, board, fn) {
  test(name, async () => {
    const server = await startRestServer({ board });
    try {
      await fn(server);
    } finally {
      await server.stop();
    }
  });
}

// ── the announcement ────────────────────────────────────────────────────

claimTest(
  'a claim announces itself once, naming card, claimant and assignee',
  boardWithCard(),
  async ({ baseUrl }) => {
    const res = await claim(baseUrl, 42, 'alex');
    assert.equal(res.status, 200);

    const posts = await commonsPosts(baseUrl);
    assert.equal(posts.length, 1, 'exactly one post — not zero, not two');

    const [post] = posts;
    assert.match(post.body, /\b42\b/, 'names the card');
    assert.match(post.body, /alex/, 'names the claimant');
    assert.match(post.body, /sage/, 'names the assignee, so the owner can see it is about them');
    assert.match(post.body, /claim/i, 'says what happened');
    assert.equal(post.attachedTo, null, 'board-level: the surface everyone already reads');
  },
);

claimTest(
  'a release announces itself once, naming card and releaser',
  boardWithCard({ claimedBy: 'alex', claimedAt: '2026-07-31T00:00:00.000Z' }),
  async ({ baseUrl }) => {
    const res = await release(baseUrl, 42, 'alex');
    assert.equal(res.status, 200);

    const posts = await commonsPosts(baseUrl);
    assert.equal(posts.length, 1, 'exactly one post');
    assert.match(posts[0].body, /\b42\b/, 'names the card');
    assert.match(posts[0].body, /alex/, 'names the releaser');
    assert.match(posts[0].body, /releas/i, 'says what happened');
  },
);

// ── negative controls: the half that makes a green run mean something ────

// A 409 is a REQUEST, not a transition. If this fires, the room gets a
// notification every time a losing racer retries — the nuisance mode.
claimTest(
  'a refused claim (409, already held) announces NOTHING',
  boardWithCard({ claimedBy: 'robin', claimedAt: '2026-07-31T00:00:00.000Z' }),
  async ({ baseUrl }) => {
    const res = await claim(baseUrl, 42, 'alex');
    assert.equal(res.status, 409, 'held by other');

    assert.deepEqual(await commonsPosts(baseUrl), [], 'no state changed, so nothing to announce');
  },
);

// A release by a non-holder is refused; refusing is not a transition either.
claimTest(
  'a refused release (409, held by other) announces NOTHING',
  boardWithCard({ claimedBy: 'robin', claimedAt: '2026-07-31T00:00:00.000Z' }),
  async ({ baseUrl }) => {
    const res = await release(baseUrl, 42, 'alex');
    assert.equal(res.status, 409);

    assert.deepEqual(await commonsPosts(baseUrl), [], 'nothing changed, nothing announced');
  },
);

// An invalid claimant never reaches the write. If this announced, the emitter
// would be sitting upstream of the validation that protects it.
claimTest(
  'an invalid claimant (400) announces NOTHING',
  boardWithCard(),
  async ({ baseUrl }) => {
    const res = await claim(baseUrl, 42, 'not a valid key!!');
    assert.equal(res.status, 400);

    assert.deepEqual(await commonsPosts(baseUrl), [], 'rejected input produces no room noise');
  },
);

// SPECIFICITY: an ordinary edit must stay silent. This is what stops the
// notification from becoming a change-log — and it is the honest boundary of
// this lane, because a PATCH is exactly the event #576 was filed about and
// exactly the one we cannot attribute.
claimTest(
  'an ordinary PATCH announces NOTHING — this lane is claims only',
  boardWithCard(),
  async ({ baseUrl }) => {
    const res = await fetch(`${baseUrl}/api/cards/42`, json({
      method: 'PATCH',
      body: JSON.stringify({ description: 'someone else edited this' }),
    }));
    assert.equal(res.status, 200);

    assert.deepEqual(await commonsPosts(baseUrl), [], 'PATCH carries no identity; announcing it would name nobody');
  },
);

// ── the announcement must not be able to break the claim ─────────────────

// The claim is the coordination primitive; the notification is decoration on
// top of it. If the post ever became load-bearing, a broken emitter would take
// the rail down with it.
claimTest(
  'the claim still succeeds and persists even if the room is unreachable',
  boardWithCard(),
  async ({ baseUrl, boardFile }) => {
    const res = await claim(baseUrl, 42, 'alex');
    assert.equal(res.status, 200);

    // Read it back through a fresh request: the server re-reads the file on
    // every call, so this is a disk round-trip, not a memory read.
    const after = await (await fetch(`${baseUrl}/api/cards/42`)).json();
    assert.equal(after.claimedBy, 'alex', 'the claim itself is what must never be lost');

    // And assert on the bytes, shape-agnostically — the on-disk document is
    // JSON-LD (#227) and this test should not care which projection it is.
    const { readFileSync } = await import('node:fs');
    assert.match(readFileSync(boardFile, 'utf8'), /"alex"/, 'the claimant is persisted');
  },
);
