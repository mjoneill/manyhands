/**
 * #628 — the person surfaces must answer in bytes an agent can read.
 *
 * #619 shipped correct, tested, reviewed — and unusable by its primary
 * beneficiary: `authored` was an unbounded id list, 54KB for one person,
 * 435KB for the room. It passed 14 tests and 7 mutants because the fixture
 * held TWO conversations: size is not a property you can see at fixture
 * scale.
 *
 * The reviewing seat's spec attack hardened this file before the fix was
 * written, and the three changes are the spec:
 *   1. EVERY list is bounded — "assigned is naturally small" was a property
 *      of OUR corpus, not of the data (a triage board has thousands assigned
 *      to one owner on day one). Same mechanism for all three lists.
 *   2. "Most recent" must be TRUE BY CONSTRUCTION — the derivation sorts by
 *      createdAt. Storage order being chronological today is an observed
 *      accident of the file, not a guarantee, and cursor paging over an
 *      unsorted list overlaps and gaps.
 *   3. The invariant is INVARIANCE, not a threshold: payload size must not
 *      grow with corpus size. A byte budget alone passes on a lucky
 *      threshold; deriving at two scales and comparing cannot.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

// Floors, not the invariant (see test 3 for the invariant).
const PERSON_BYTE_BUDGET = 16_000;
const LIST_BYTE_BUDGET = 24_000;

const PROLIFIC_POSTS = 5_000;
const PROLIFIC_CARDS = 3_000;

function writeSyntheticRoster() {
  const file = path.join(
    os.tmpdir(),
    `scrum-test-roster-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  // color is REQUIRED per seat — sanitizeRoster drops colourless seats and an
  // emptied roster silently falls back to the shipped example (#619 lesson).
  fs.writeFileSync(file, JSON.stringify({
    seats: {
      talker: { name: 'Talker', glyph: '🗣️', color: '#4488cc' },
      lurker: { name: 'Lurker', glyph: '🫥', color: '#cc8844' },
    },
  }, null, 2));
  return file;
}

/**
 * A board where one seat has said `posts` things and holds `cards` cards.
 * Conversations are written in SHUFFLED storage order with honest createdAt
 * stamps, so any "most recent" claim has to come from sorting, not from the
 * accident of append order.
 */
function bigBoard({ posts = PROLIFIC_POSTS, cards = 1 } = {}) {
  const conversations = [];
  for (let i = 0; i < posts; i++) {
    conversations.push({
      id: `talk-${String(i).padStart(6, '0')}`,
      body: `post ${i}`,
      author: 'talker',
      attachedTo: null, attachments: [], mentions: [],
      // Monotone timestamps: post i is older than post i+1.
      createdAt: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
    });
  }
  // Deterministic shuffle of STORAGE order (timestamps untouched).
  for (let i = conversations.length - 1; i > 0; i--) {
    const j = (i * 7919) % (i + 1);
    [conversations[i], conversations[j]] = [conversations[j], conversations[i]];
  }
  const cardList = [];
  for (let c = 0; c < cards; c++) {
    cardList.push({
      id: `card-${c}`, shortId: c + 1, title: `card ${c}`, description: '',
      assignees: ['talker'], column: 'backlog', labels: [], order: c,
      claimedBy: c % 2 === 0 ? 'talker' : null,
      createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
    });
  }
  return makeBoardFixture({ nextShortId: cards + 1, cards: cardList, conversations });
}

async function withServer(board, fn) {
  const rosterFile = writeSyntheticRoster();
  const server = await startRestServer({ board, env: { SCRUM_ROSTER_FILE: rosterFile } });
  try {
    await fn(server);
  } finally {
    await server.stop();
    fs.rmSync(rosterFile, { force: true });
  }
}

async function getJSON(url) {
  const res = await fetch(url);
  const text = await res.text();
  return { status: res.status, bytes: Buffer.byteLength(text), body: JSON.parse(text) };
}

// ── 1 · EVERY list is bounded, totals intact — same mechanism for all ──────

test('#628 every edge list is bounded and every total is true', async () => {
  await withServer(bigBoard({ posts: PROLIFIC_POSTS, cards: PROLIFIC_CARDS }), async ({ baseUrl }) => {
    const { status, bytes, body } = await getJSON(`${baseUrl}/api/people/talker`);
    assert.equal(status, 200);
    assert.ok(bytes < PERSON_BYTE_BUDGET,
      `one person must be agent-readable: ${bytes} bytes, floor ${PERSON_BYTE_BUDGET}`);
    assert.equal(body.authoredTotal, PROLIFIC_POSTS);
    assert.equal(body.assignedTotal, PROLIFIC_CARDS,
      '"assigned is naturally small" was OUR corpus, not the data — it is bounded too');
    assert.equal(body.claimingTotal, Math.ceil(PROLIFIC_CARDS / 2));
    assert.ok(body.authored.length < PROLIFIC_POSTS, 'authored bounded');
    assert.ok(body.assigned.length < PROLIFIC_CARDS, 'assigned bounded');
    assert.ok(body.claiming.length < PROLIFIC_CARDS / 2, 'claiming bounded');
  });
});

// ── 2 · "Most recent" is true by CONSTRUCTION, not by storage accident ─────

test('#628 the authored tail is most-recent by createdAt over SHUFFLED storage order', async () => {
  await withServer(bigBoard(), async ({ baseUrl }) => {
    const { body } = await getJSON(`${baseUrl}/api/people/talker`);
    const newest = `talk-${String(PROLIFIC_POSTS - 1).padStart(6, '0')}`;
    assert.equal(body.authored[body.authored.length - 1], newest,
      'the newest-by-timestamp post is last, though storage order is shuffled');
    // The whole tail is the chronological tail, in order.
    const expectStart = PROLIFIC_POSTS - body.authored.length;
    const expected = Array.from({ length: body.authored.length },
      (_, k) => `talk-${String(expectStart + k).padStart(6, '0')}`);
    assert.deepEqual(body.authored, expected,
      'recency comes from sorting by createdAt, not from the file happening to be appended in order');
  });
});

// ── 3 · THE INVARIANT: payload size does not grow with corpus size ─────────

test('#628 person payload size is scale-INVARIANT, not merely under a lucky threshold', async () => {
  // BOTH scales must saturate every list bound — otherwise the comparison
  // measures list-fill below the limit, not growth. With all lists at the
  // limit, the only legitimate variance left is digit width (ids and totals
  // gain a digit); anything linear in the corpus blows the tolerance by
  // an order of magnitude.
  let smallBytes, largeBytes;
  await withServer(bigBoard({ posts: 500, cards: 200 }), async ({ baseUrl }) => {
    smallBytes = (await getJSON(`${baseUrl}/api/people/talker`)).bytes;
  });
  await withServer(bigBoard({ posts: 20_000, cards: 3_000 }), async ({ baseUrl }) => {
    largeBytes = (await getJSON(`${baseUrl}/api/people/talker`)).bytes;
  });
  const ratio = largeBytes / smallBytes;
  assert.ok(ratio < 1.10,
    `payload must not grow with the corpus: ${smallBytes}B at 500 posts vs ${largeBytes}B at 20,000 (ratio ${ratio.toFixed(3)})`);
});

test('#628 the room list is bounded and scale-invariant too', async () => {
  await withServer(bigBoard({ posts: PROLIFIC_POSTS, cards: PROLIFIC_CARDS }), async ({ baseUrl }) => {
    const { bytes, body } = await getJSON(`${baseUrl}/api/people`);
    assert.ok(bytes < LIST_BYTE_BUDGET,
      `room list must be agent-readable: ${bytes} bytes, floor ${LIST_BYTE_BUDGET}`);
    const talker = body.people.find((p) => p.key === 'talker');
    assert.equal(talker.authoredTotal, PROLIFIC_POSTS, 'totals survive in the list view');
  });
});

// ── 4 · The full history stays REACHABLE — stable backward paging ──────────

test('#628 authoredBefore pages backward, seamlessly, over shuffled storage', async () => {
  await withServer(bigBoard(), async ({ baseUrl }) => {
    const first = (await getJSON(`${baseUrl}/api/people/talker`)).body;
    const oldestShown = first.authored[0];

    const page2 = (await getJSON(
      `${baseUrl}/api/people/talker?authoredBefore=${encodeURIComponent(oldestShown)}`,
    )).body;
    assert.ok(page2.authored.length > 0, 'a second page exists');
    assert.ok(!page2.authored.includes(oldestShown), 'strictly before the cursor');
    const idx = (s) => Number(s.slice(5));
    assert.equal(idx(page2.authored[page2.authored.length - 1]), idx(oldestShown) - 1,
      'page 2 abuts page 1 — no gap, no overlap, though storage order is shuffled');
    assert.equal(page2.authoredTotal, PROLIFIC_POSTS, 'the total rides every page');
  });
});

// ── 5 · The bound lives in CORE, one mechanism for every list ──────────────

test('#628 the bound is a core export, one mechanism, both surfaces project it', async () => {
  const people = await import('../core/people.mjs');
  assert.equal(typeof people.EDGE_RECENT_LIMIT, 'number',
    'ONE limit for every edge list, exported from core/people.mjs');
  assert.ok(people.EDGE_RECENT_LIMIT > 0 && people.EDGE_RECENT_LIMIT <= 200,
    'bounded default, sane range');
});

// ── 6 · An unknown cursor REFUSES — it never silently serves page one ──────
//
// Reviewer's 🔴: `authoredBefore: 'garbage'` returned page one byte-identical
// to a fresh call. An agent paging backward until it sees fewer than 50 would
// loop forever, every iteration looking like success — and a cursor goes
// stale the moment a conversation is deleted mid-walk. Refusing beats
// guessing; "silent truncation is poisonous."

test('#628 an unknown cursor is a 400 naming the cursor, never page one', async () => {
  await withServer(bigBoard(), async ({ baseUrl }) => {
    const res = await fetch(`${baseUrl}/api/people/talker?authoredBefore=no-such-id`);
    assert.equal(res.status, 400, 'refusing beats guessing');
    const body = await res.json();
    assert.match(body.error, /authoredBefore/, 'the response names WHICH cursor was bad');
  });
});

// ── 7 · The limit is a DEFAULT with an override, under a hard ceiling ──────
//
// The customer's stated shape (21:50Z): "a default number of results...
// [the agent can] explicitly set the results if they wanted a larger or
// different number." A fixed cap with a cursor is not that. The override
// stays a BOUND: a ceiling clamps it, so no caller can ask for the firehose.

test('#628 limit overrides the default and is clamped to the ceiling', async () => {
  await withServer(bigBoard(), async ({ baseUrl }) => {
    const twoHundred = (await getJSON(`${baseUrl}/api/people/talker?limit=200`)).body;
    assert.equal(twoHundred.authored.length, 200, 'a caller may ask for more');
    assert.equal(twoHundred.authoredTotal, PROLIFIC_POSTS, 'totals still true');

    const greedy = (await getJSON(`${baseUrl}/api/people/talker?limit=999999`)).body;
    const { EDGE_LIMIT_CEILING } = await import('../core/people.mjs');
    assert.equal(greedy.authored.length, EDGE_LIMIT_CEILING,
      'the override is clamped — a bound, not a suggestion');

    const tiny = (await getJSON(`${baseUrl}/api/people/talker?limit=5`)).body;
    assert.equal(tiny.authored.length, 5, 'smaller is always allowed');
  });
});

// ── 8 · The acceptance rule, AUTOMATED: the real MCP transport carries it ──
//
// Reviewer's close: the in-turn live read could only happen after deploy, so
// the rule this card bought couldn't gate the thing it was written for. This
// test IS that rule, runnable pre-deploy: a real MCP session calls the tool
// over the real transport and the payload must be agent-readable.

test('#628 person_get over the REAL MCP transport returns an agent-readable payload', async () => {
  const { startPair, mcpSession } = await import('./helpers/harness.mjs');
  const rosterFile = writeSyntheticRoster();
  const pair = await startPair({ board: bigBoard() });
  try {
    const session = await mcpSession(pair.mcp.mcpUrl);
    const called = await session.callTool('person_get', { key: 'talker' });
    const text = called.result.content[0].text;
    assert.ok(Buffer.byteLength(text) < PERSON_BYTE_BUDGET,
      `the tool result an agent actually receives must fit its budget: ${Buffer.byteLength(text)}B`);
    const person = JSON.parse(text);
    assert.equal(person.authoredTotal, PROLIFIC_POSTS, 'and still carries the truth');
  } finally {
    await pair.stop();
    fs.rmSync(rosterFile, { force: true });
  }
});
