/**
 * #761 — THE WRITE SIDE. `attachedTo` must resolve to a card, or be refused.
 *
 * #778 fixed the READ side: asking about a card that does not exist refuses
 * instead of answering an empty list. That guard is what made the write-side
 * damage invisible — `attachedTo=<a bad id>` answers "no card with id", which
 * reads as "you asked wrong", never as "comments are stranded here".
 *
 * Measured on the live board 2026-09-08, all 25,722 conversations:
 *
 *   card-attached posts        1395
 *     UUID that resolves       1265
 *     UUID that resolves to    18     ⇐ typos and fabrications. Still arriving:
 *       nothing                          8 in July, 7 in August, 3 in September.
 *     a shortId, card exists   110    ⇐ unreachable under the UUID join.
 *                                        33 in July, 77 in August, ZERO in
 *                                        September — a CLOSED population.
 *     malformed                2
 *
 * ⭐ THE SHORTID HALF IS NOT A LIVE PRACTICE, so this does not reject it — a
 * resolvable shortId is COERCED to the card's UUID. Coercion breaks no caller
 * and closes the split; rejection would only move the failure. Refusal is
 * reserved for a value that names nothing in either format, which is the only
 * kind still being written.
 *
 * ⚠️ THE POSITIVE CONTROLS ARE THE POINT. A guard that refuses everything
 * passes every test written to prove it refuses. Half of these assert the
 * ordinary paths still answer — board-level posts, the literal "null" a
 * client sends for absence (#688), and a plain UUID — because "does it fire?"
 * and "does it fire ONLY when it should?" are different questions.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, startMcpServer, mcpSession, makeBoardFixture } from './helpers/harness.mjs';

const json = (body) => ({
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

async function fixture() {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], conversations: [] }) });
  const card = await (await fetch(`${srv.baseUrl}/api/cards`, json({ title: 'a real card', createdBy: 'ada' }))).json();
  return { srv, card };
}

const post = (srv, body) => fetch(`${srv.baseUrl}/api/conversations`, json(body));

// ── the defect: a value that names nothing is accepted and stranded ────────

test('#761 an attachedTo UUID that resolves to NOTHING is refused, not stored', async () => {
  // The 2026-09-08 incident: one digit group wrong on a real card id. The
  // write returned 201 with a real comment id and the comment was attached to
  // nothing. A read-back does not catch this — the comment exists and reads
  // back perfectly. It is the EDGE that points nowhere, and the edge had no
  // reader.
  const { srv } = await fixture();
  try {
    const res = await post(srv, {
      body: 'a long comment somebody is about to lose', author: 'ada',
      attachedTo: '67a10b15-d422-4901-89c4-af8d93288906',
    });
    assert.equal(res.status, 400, 'a reference that names nothing is not a reference');
    const b = await res.json();
    assert.match(b.error, /67a10b15-d422-4901-89c4-af8d93288906/, 'the refusal names the id it could not resolve');
    assert.equal(b.code, 'NO_SUCH_CARD');
  } finally { await srv.stop(); }
});

test('#761 the refused post is NOT written — the board is unchanged', async () => {
  // A 400 that still appends is worse than no check: the caller now believes
  // nothing was written.
  const { srv } = await fixture();
  try {
    await post(srv, { body: 'should not survive', author: 'ada', attachedTo: '11111111-2222-3333-4444-555555555555' });
    const all = await (await fetch(`${srv.baseUrl}/api/conversations`)).json();
    assert.equal(all.length, 0, 'the refused post left no trace');
  } finally { await srv.stop(); }
});

test('#761 a bare number that names no card is refused too', async () => {
  const { srv } = await fixture();
  try {
    const res = await post(srv, { body: 'x', author: 'ada', attachedTo: '999999' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /999999/);
  } finally { await srv.stop(); }
});

test('#761 a value that is NEITHER a uuid nor a number is refused', async () => {
  // Two such values are already stored on the live board, and one of them is
  // worse than a typo: `e9f636fe-3927-4e8e-aa***` is a REDACTION MARKER that
  // survived into a stored reference. The other is a uuid missing its first
  // two characters. Neither can ever resolve, and neither was covered until a
  // sabotage run found this: removing this branch left all twelve other tests
  // green, because every one of them fed a well-formed uuid or a bare number.
  const { srv } = await fixture();
  try {
    for (const bad of ['e9f636fe-3927-4e8e-aa***', '960e08-1474-4bc6-878d-3a7732c4080f', 'the card about tokens']) {
      const res = await post(srv, { body: 'x', author: 'ada', attachedTo: bad });
      assert.equal(res.status, 400, `${bad} names no card and must be refused`);
    }
    const all = await (await fetch(`${srv.baseUrl}/api/conversations`)).json();
    assert.equal(all.length, 0, 'and none of them were stored');
  } finally { await srv.stop(); }
});

test('#761 ⛔ a number-ish string must NOT coerce onto a real card', async () => {
  // Found in review, and it is worse than the defect this file fixes.
  // `Number()` accepts hex, binary, exponents, trailing dots, signs and
  // whitespace, so with `Number.isInteger(Number(x))` as the guard:
  //
  //   '0x1F' -> 31 · '0b11111' -> 31 · '1e3' -> 1000 · '12.0' -> 12
  //
  // Every one resolved to a REAL card — silently, and to the wrong one.
  //
  // ⭐ A dangling edge is detectable: sweeping every post finds all of them.
  // A WRONG edge resolves, renders and reads back perfectly, and no sweep can
  // ever tell it from a correct one. Refusing is the only safe answer.
  const srv = await startRestServer({
    board: makeBoardFixture({
      cards: [
        { id: 'uuid-31', shortId: 31, title: 'thirty one', column: 'backlog', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'uuid-1000', shortId: 1000, title: 'one thousand', column: 'backlog', createdAt: '2026-01-01T00:00:00.000Z' },
      ],
      conversations: [],
    }),
  });
  try {
    for (const bad of ['0x1F', '0b11111', '1e3', '31.', '+31', ' 31 ', '\n31']) {
      const res = await post(srv, { body: 'x', author: 'ada', attachedTo: bad });
      assert.equal(res.status, 400, `${JSON.stringify(bad)} is not how anyone writes a card number`);
    }
    // POSITIVE CONTROL: the plain decimal form still resolves, so the guard
    // has not simply turned shortIds off.
    const good = await post(srv, { body: 'x', author: 'ada', attachedTo: '31' });
    assert.equal(good.status, 201);
    assert.equal((await good.json()).attachedTo, 'uuid-31');
  } finally { await srv.stop(); }
});

// ── the key split: coerce, do not reject ──────────────────────────────────

test('#761 a resolvable shortId is COERCED to the card UUID and stored that way', async () => {
  const { srv, card } = await fixture();
  try {
    const res = await post(srv, { body: 'keyed by shortId', author: 'ada', attachedTo: String(card.shortId) });
    assert.equal(res.status, 201, 'a shortId names a real card; refusing it would only move the failure');
    assert.equal((await res.json()).attachedTo, card.id, 'stored under the canonical key, not as typed');
  } finally { await srv.stop(); }
});

test('#761 ⭐ THE WHOLE DEFECT: a shortId-keyed post is findable by the card UUID', async () => {
  // This is what 110 posts on the live board cannot do. #500 carries 29 posts
  // and #619 carries 24 — whole design threads — and querying either card by
  // its own UUID returns EMPTY. Storing the canonical key is the only
  // assertion here that matters; the status code above is a detail.
  const { srv, card } = await fixture();
  try {
    await post(srv, { body: 'the lost thread', author: 'bex', attachedTo: String(card.shortId) });
    const list = await (await fetch(`${srv.baseUrl}/api/conversations?attachedTo=${card.id}`)).json();
    assert.equal(list.length, 1, 'a card queried by its own id returns its own discussion');
    assert.equal(list[0].body, 'the lost thread');
  } finally { await srv.stop(); }
});

test('#761 a number-shaped shortId sent as a NUMBER coerces too', async () => {
  // JSON lets a caller send 619, not "619". The old write path stored only
  // strings, so a numeric attachedTo fell through to null and the post
  // silently became board-level — a different loss with the same cause.
  const { srv, card } = await fixture();
  try {
    const res = await post(srv, { body: 'numeric key', author: 'ada', attachedTo: card.shortId });
    assert.equal(res.status, 201);
    assert.equal((await res.json()).attachedTo, card.id);
  } finally { await srv.stop(); }
});

test('#761 REGRESSION — a card id that is not uuid-shaped still resolves', async () => {
  // The first version of the resolver matched a UUID regex before looking
  // anything up, so a card whose id is `bk` was refused and the raised-hand
  // clear path broke — the ONE path #761's body warns about by name: "do not
  // 'fix' that path into requiring a resolved card, or orphans become
  // unclearable." I read that warning and shipped the thing it forbids; the
  // suite caught it, the warning did not.
  //
  // The resolver now asks the card list instead of recognising a shape. This
  // test pins that difference, because "ids look like uuids" is true right up
  // until a fixture, a migration, or an import says otherwise.
  const srv = await startRestServer({
    board: makeBoardFixture({
      cards: [{ id: 'bk', shortId: 1, title: 'a card with a non-uuid id', column: 'backlog', createdAt: '2026-01-01T00:00:00.000Z' }],
      conversations: [],
    }),
  });
  try {
    const res = await post(srv, { body: 'attached by a short opaque id', author: 'ada', attachedTo: 'bk' });
    assert.equal(res.status, 201, 'the card list is the authority on what a card id looks like');
    assert.equal((await res.json()).attachedTo, 'bk');
  } finally { await srv.stop(); }
});

// ── positive controls: the guard must not fire on the ordinary cases ───────

test('#761 POSITIVE CONTROL — a resolvable UUID is stored unchanged', async () => {
  const { srv, card } = await fixture();
  try {
    const res = await post(srv, { body: 'ordinary', author: 'ada', attachedTo: card.id });
    assert.equal(res.status, 201);
    assert.equal((await res.json()).attachedTo, card.id);
  } finally { await srv.stop(); }
});

test('#761 POSITIVE CONTROL — the literal string "null" still means board-level (#688)', async () => {
  // 42 live posts proved a client serialises absence as the string "null".
  // That is not a card id and must not become a refusal.
  const { srv } = await fixture();
  try {
    const res = await post(srv, { body: 'board level', author: 'ada', attachedTo: 'null' });
    assert.equal(res.status, 201, '"null" is a client\'s serialised absence, not a bad reference');
    assert.equal((await res.json()).attachedTo, null);
  } finally { await srv.stop(); }
});

test('#761 POSITIVE CONTROL — an absent attachedTo is board-level', async () => {
  const { srv } = await fixture();
  try {
    const res = await post(srv, { body: 'plain commons post', author: 'ada' });
    assert.equal(res.status, 201);
    assert.equal((await res.json()).attachedTo, null);
  } finally { await srv.stop(); }
});

test('#761 POSITIVE CONTROL — an explicit null is board-level', async () => {
  const { srv } = await fixture();
  try {
    const res = await post(srv, { body: 'explicit null', author: 'ada', attachedTo: null });
    assert.equal(res.status, 201);
    assert.equal((await res.json()).attachedTo, null);
  } finally { await srv.stop(); }
});

test('#761 POSITIVE CONTROL — the guard does not depend on the card having posts', async () => {
  // The mirror of #778's test: refusing only when the thread is empty would
  // collapse "no such card" and "quiet card" all over again, in the other
  // direction. The check asks the CARD list.
  const { srv, card } = await fixture();
  try {
    const first = await post(srv, { body: 'first', author: 'ada', attachedTo: card.id });
    const second = await post(srv, { body: 'second', author: 'bex', attachedTo: card.id });
    assert.equal(first.status, 201, 'the first post on a quiet card is fine');
    assert.equal(second.status, 201, 'and so is the second');
  } finally { await srv.stop(); }
});

// ── the beneficiary: an agent calling the tool, not a shell calling curl ───

test('#761 an AGENT posting to a nonexistent card is TOLD, not given a 201', async () => {
  // The reader this cost was an agent calling conversation_post and reading a
  // 201 with a real comment id. Checked at the MCP hop rather than inferred
  // from the REST behaviour, because the whole class of defect this card
  // documents is a guard that exists one layer away from the caller.
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], conversations: [] }) });
  const mcp = await startMcpServer({ restApiBase: srv.baseUrl });
  try {
    const session = await mcpSession(mcp.mcpUrl);
    const result = await session.callTool('conversation_post', {
      body: 'a comment that must not be stranded', author: 'ada',
      attachedTo: '67a10b15-d422-4901-89c4-af8d93288906',
    });

    // ⚠️ ASSERT THE BEHAVIOUR, NOT THE STRING. Written first as two regexes
    // over JSON.stringify(result) — and both were useless: the bad id appears
    // in a SUCCESS response too (it is echoed back on the created comment),
    // and `"id":` never matches because the payload is escaped as \"id\".
    // That version passed against the unfixed server, which is a test that
    // proves nothing. The board is the only honest witness here.
    const stored = await (await fetch(`${srv.baseUrl}/api/conversations`)).json();
    assert.equal(stored.length, 0, 'the post must not land anywhere — a stranded comment is the defect');

    const text = JSON.stringify(result);
    assert.match(text, /67a10b15-d422-4901-89c4-af8d93288906/, 'and the agent is told WHICH id failed');
    assert.match(text, /no card with id/i, 'in words, not as a silent 201');
    assert.match(text, /uuid/i, 'and what to send instead');
    assert.equal(result.result.isError, true, 'flagged as an error, not returned as a result to be read past');
  } finally {
    await mcp.stop(); await srv.stop();
  }
});
