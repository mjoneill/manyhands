/**
 * #794 — a card's discussion was invisible to the only surface anyone reads
 * cards with.
 *
 * `handleGetCard` returned `data.cards[idx]` — the raw stored object. There is
 * no comment key on it, so `card_get` (which proxies that endpoint) answered
 * with the description and nothing else. Measured 2026-08-12: #755 carries 70
 * comments and a reader saw zero of them.
 *
 * ⚠️ WHY THAT IS WORSE THAN AN ORDINARY OMISSION. This board's convention is to
 * put findings in card COMMENTS when the description is too large to rewrite
 * safely — #534, no compare-and-swap, so any PATCH sends the whole body and
 * races it. So the SAFE write surface was the INVISIBLE one, and the visible
 * one was the risky one. A four-point coordination design was recorded on #755
 * that morning, correctly, and would have been read by nobody.
 *
 * ── THE CONSTRAINT IS WHAT MAKES THIS NON-OBVIOUS ──────────────────────────
 * ⛔ Do NOT inline the comments. #755 has 70; injecting them into every read
 * moves the size problem from the write path to the read path, which is the
 * same defect wearing the other shoe. The response must stay BOUNDED and must
 * NOT scale with discussion length.
 *
 * ── AND THE FIXTURE IS LOAD-BEARING, NOT THOROUGH ──────────────────────────
 * Measured over the live corpus: 722 cards, 739 attached comments across 152
 * cards. The median across ALL cards is ZERO — 79% have none. So a test
 * against a randomly-chosen card returns nothing and NEVER RUNS THE CODE UNDER
 * TEST. Among cards that have any, the median is 2. The gap between 2 and 70
 * is where a naive fix lives, so the high-count case is asserted explicitly
 * and the assertion is that the response stays bounded — not merely that
 * stubs appear.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, startMcpServer, mcpSession, makeBoardFixture } from './helpers/harness.mjs';

const RECENT_CAP = 3;        // must match server.js
const PREVIEW_CHARS = 140;   // must match server.js

const card = (id, shortId) => ({
  id, shortId, title: `card ${shortId}`, description: 'body', type: 'task',
  assignees: [], labels: [], for: '', priority: null, column: 'backlog', order: 0,
  createdAt: '2026-05-01T00:00:00.000Z', updatedAt: '2026-05-01T00:00:00.000Z',
  relationships: { relatedTo: [], blockedBy: [] },
});

const comment = (n, attachedTo, body) => ({
  id: `conv-${n}`, body, author: n % 2 ? 'ann' : 'ben', attachedTo,
  attachments: [], mentions: [],
  createdAt: new Date(Date.UTC(2026, 7, 12, 0, n)).toISOString(),
});

async function serverWith(cards, conversations) {
  return startRestServer({ board: makeBoardFixture({ cards, conversations }) });
}

// ── the defect ──────────────────────────────────────────────────────────────

test('#794 card_get reports HOW MANY comments a card has — it used to report nothing', async () => {
  const srv = await serverWith(
    [card('c1', 1)],
    [comment(1, 'c1', 'first'), comment(2, 'c1', 'second'), comment(3, null, 'board-level')],
  );
  try {
    const got = await (await fetch(`${srv.baseUrl}/api/cards/c1`)).json();
    assert.ok(got.comments, 'the card carries no comment metadata at all — this is the defect');
    assert.equal(got.comments.total, 2,
      'the count must include only comments attached to THIS card; the board-level one is not its discussion');
  } finally { await srv.stop(); }
});

test('#794 a card with NO discussion says zero rather than omitting the field', async () => {
  // ⚠️ The distinction #778 is about, arriving on a different surface: "never
  // discussed" and "the reader cannot see the discussion" must not look alike.
  // An absent key means the second; total:0 means the first.
  const srv = await serverWith([card('c1', 1)], []);
  try {
    const got = await (await fetch(`${srv.baseUrl}/api/cards/c1`)).json();
    assert.ok(got.comments, 'the field must be present even when empty, or absence is ambiguous');
    assert.equal(got.comments.total, 0);
    assert.deepEqual(got.comments.recent, []);
  } finally { await srv.stop(); }
});

// ── ⭐ THE BOUNDED ASSERTION — the one that matters ──────────────────────────

test('#794 ⭐ 70 COMMENTS — the fixture that matters, and the response stays BOUNDED', async () => {
  // #755 carries 70. A median card carries ZERO, so a randomly-chosen fixture
  // never runs this path at all. This is the case a naive fix passes on a small
  // card and fails here.
  const convs = Array.from({ length: 70 }, (_, i) => comment(i + 1, 'c1', `comment number ${i + 1}`));
  const srv = await serverWith([card('c1', 1)], convs);
  try {
    const got = await (await fetch(`${srv.baseUrl}/api/cards/c1`)).json();
    assert.equal(got.comments.total, 70, 'the COUNT is unbounded — it is one number and it must be true');
    assert.ok(got.comments.recent.length <= RECENT_CAP,
      `recent carried ${got.comments.recent.length} stubs — the payload scales with discussion length, `
      + 'which is the read-path version of the write-path problem this card exists to fix');
  } finally { await srv.stop(); }
});

test('#794 ⭐⭐ the added payload does not grow with discussion length — 2 comments vs 200', async () => {
  // The discriminating test. `total` differs; the SIZE of what is added must not.
  const small = await serverWith([card('c1', 1)], [comment(1, 'c1', 'a'), comment(2, 'c1', 'b')]);
  let smallBytes;
  try {
    const got = await (await fetch(`${small.baseUrl}/api/cards/c1`)).json();
    smallBytes = JSON.stringify(got.comments).length;
  } finally { await small.stop(); }

  const many = await serverWith(
    [card('c1', 1)],
    Array.from({ length: 200 }, (_, i) => comment(i + 1, 'c1', `comment ${i + 1}`)),
  );
  try {
    const got = await (await fetch(`${many.baseUrl}/api/cards/c1`)).json();
    const manyBytes = JSON.stringify(got.comments).length;
    assert.ok(got.comments.total === 200, 'the count still tracks reality');
    assert.ok(manyBytes < smallBytes * 3,
      `2 comments produced ${smallBytes} bytes and 200 produced ${manyBytes} — the metadata is scaling `
      + 'with the discussion. A bounded field must be roughly constant.');
  } finally { await many.stop(); }
});

test('#794 a long comment is TRUNCATED in the preview — one comment must not blow the bound', async () => {
  // The cap on COUNT is not enough: one 40KB comment would defeat it alone.
  const srv = await serverWith([card('c1', 1)], [comment(1, 'c1', 'x'.repeat(40_000))]);
  try {
    const got = await (await fetch(`${srv.baseUrl}/api/cards/c1`)).json();
    const [stub] = got.comments.recent;
    assert.ok(stub.preview.length <= PREVIEW_CHARS + 1,
      `preview carried ${stub.preview.length} chars — capping the NUMBER of stubs does not bound the `
      + 'response if a single body is unbounded');
  } finally { await srv.stop(); }
});

// ── the stubs must be usable, and newest-first ──────────────────────────────

test('#794 the stubs carry enough to decide whether to fetch, newest first', async () => {
  const srv = await serverWith(
    [card('c1', 1)],
    [comment(1, 'c1', 'oldest'), comment(2, 'c1', 'middle'), comment(3, 'c1', 'newest')],
  );
  try {
    const got = await (await fetch(`${srv.baseUrl}/api/cards/c1`)).json();
    const [first] = got.comments.recent;
    assert.equal(first.preview, 'newest', 'recent must be NEWEST first — the point is what changed lately');
    assert.ok(first.author, 'a stub without an author cannot be judged');
    assert.ok(first.createdAt, 'a stub without a date cannot be judged');
    assert.ok(first.id, 'a stub without an id cannot be followed to the full comment');
  } finally { await srv.stop(); }
});

// ── ⭐ POSITIVE CONTROL: the beneficiary is an AGENT, so assert the MCP surface ──

test('#794 ⭐ BENEFICIARY — card_get through MCP carries it, not just the REST endpoint', async () => {
  // #628's lesson: the tool surface is what agents actually read, and a fix
  // proven only against REST can still leave every seat blind.
  const rest = await serverWith([card('c1', 1)], [comment(1, 'c1', 'hello'), comment(2, 'c1', 'again')]);
  const mcp = await startMcpServer({ restApiBase: rest.baseUrl });
  try {
    const s = await mcpSession(mcp.mcpUrl);
    const res = await s.callTool('card_get', { id: 'c1' });
    const payload = JSON.parse(res.result.content[0].text);
    assert.equal(payload.comments.total, 2,
      'card_get is the surface every seat reads a card with — if it is blind here, the fix did not land');
  } finally { await mcp.stop(); await rest.stop(); }
});
