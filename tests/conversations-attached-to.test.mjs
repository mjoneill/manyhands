/**
 * #778 — `attachedTo` must resolve the card it names, or refuse.
 *
 * The defect: a card id that resolves to NOTHING returned HTTP 200 with an
 * empty list — byte-identical to a real card that simply has no discussion.
 * A reader could not tell "this card was never discussed" from "you asked
 * about a card that does not exist," and on 2026-08-10 a reader didn't: the
 * number printed on every card is its shortId, `attachedTo=755` resolves to
 * no card under the UUID join, and the answer was a well-formed empty thread.
 *
 * This is the reader-facing half of #761. The join fix (accepting both key
 * formats) is real work; most of the damage is delivered by this one line,
 * and refusing costs nothing.
 *
 * ⚠️ THE POSITIVE CONTROL IS THE POINT. A guard that refuses everything
 * passes every test written to prove it refuses. Half the tests below assert
 * the ordinary cases still answer — a real card, a card with no posts at all,
 * and the board-level `null` filter — because "does it fire?" and "does it
 * fire only when it should?" are different questions and only the second one
 * is a test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, startMcpServer, mcpSession, makeBoardFixture } from './helpers/harness.mjs';

const json = (body) => ({
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

/** A board with one real card and one post attached to it. */
async function fixture() {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], conversations: [] }) });
  const card = await (await fetch(`${srv.baseUrl}/api/cards`, json({ title: 'a real card', createdBy: 'ada' }))).json();
  await fetch(`${srv.baseUrl}/api/conversations`, json({ body: 'a real post', author: 'bex', attachedTo: card.id }));
  return { srv, card };
}

// ── the defect ────────────────────────────────────────────────────────────

test('#778 a nonexistent card id REFUSES rather than answering empty', async () => {
  const { srv } = await fixture();
  try {
    const res = await fetch(`${srv.baseUrl}/api/conversations?attachedTo=00000000-0000-0000-0000-000000000000`);
    const body = await res.json();
    assert.equal(res.status, 404, 'a question about a card that does not exist is not a question we can answer');
    assert.equal(body.code, 'NO_SUCH_CARD');
    assert.match(body.error, /00000000-0000-0000-0000-000000000000/, 'the refusal names the id it could not resolve');
  } finally { await srv.stop(); }
});

test('#778 a shortId refuses AND says what to pass instead — the 2026-08-10 reader', async () => {
  // The number printed on every card is its shortId. Someone will type it.
  // Refusing without saying why just moves the confusion; the hint is the
  // difference between an error and a dead end.
  const { srv } = await fixture();
  try {
    const res = await fetch(`${srv.baseUrl}/api/conversations?attachedTo=755`);
    const body = await res.json();
    assert.equal(res.status, 404);
    assert.equal(body.code, 'NO_SUCH_CARD');
    assert.match(body.error, /uuid/i, 'a bare number is a shortId; say so rather than leaving the reader guessing');
  } finally { await srv.stop(); }
});

// ── the positive controls: the guard must not fire on the ordinary cases ───

test('#778 POSITIVE CONTROL — a real card still returns its thread', async () => {
  const { srv, card } = await fixture();
  try {
    const res = await fetch(`${srv.baseUrl}/api/conversations?attachedTo=${card.id}`);
    assert.equal(res.status, 200);
    const list = await res.json();
    assert.equal(list.length, 1);
    assert.equal(list[0].body, 'a real post');
  } finally { await srv.stop(); }
});

test('#778 POSITIVE CONTROL — a real card with NO posts answers empty, and that is the true zero', async () => {
  // This is the case the defect was impersonating. It must still work, and it
  // must be distinguishable from the refusal above — otherwise the fix has
  // only moved which of the two answers is wrong.
  const { srv } = await fixture();
  try {
    const quiet = await (await fetch(`${srv.baseUrl}/api/cards`, json({ title: 'nobody talked about this', createdBy: 'ada' }))).json();
    const res = await fetch(`${srv.baseUrl}/api/conversations?attachedTo=${quiet.id}`);
    assert.equal(res.status, 200, 'a real card with no discussion is a real, answerable question');
    assert.deepEqual(await res.json(), []);
  } finally { await srv.stop(); }
});

test('#778 POSITIVE CONTROL — attachedTo=null still filters to board-level', async () => {
  const { srv } = await fixture();
  try {
    await fetch(`${srv.baseUrl}/api/conversations`, json({ body: 'board level', author: 'cy' }));
    const res = await fetch(`${srv.baseUrl}/api/conversations?attachedTo=null`);
    assert.equal(res.status, 200, '"null" is a filter, not a card id');
    const list = await res.json();
    assert.equal(list.length, 1);
    assert.equal(list[0].body, 'board level');
  } finally { await srv.stop(); }
});

test('#778 POSITIVE CONTROL — an unfiltered list is untouched', async () => {
  const { srv } = await fixture();
  try {
    const res = await fetch(`${srv.baseUrl}/api/conversations`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).length, 1);
  } finally { await srv.stop(); }
});

// ── the refusal must not depend on whether the card has posts ──────────────

test('#778 the refusal is about CARD EXISTENCE, not post count', async () => {
  // A subtle way to get this wrong: refuse only when the result set is empty.
  // That would answer correctly for a nonexistent card and *also* refuse for
  // a real quiet card — the two states collapsed again, in the other
  // direction. The check must ask the card list, not the post list.
  const { srv } = await fixture();
  try {
    const quiet = await (await fetch(`${srv.baseUrl}/api/cards`, json({ title: 'quiet but real', createdBy: 'ada' }))).json();
    const real = await fetch(`${srv.baseUrl}/api/conversations?attachedTo=${quiet.id}`);
    const fake = await fetch(`${srv.baseUrl}/api/conversations?attachedTo=11111111-2222-3333-4444-555555555555`);
    assert.equal(real.status, 200, 'zero posts on a real card is 200');
    assert.equal(fake.status, 404, 'zero posts because the card is absent is 404');
    assert.deepEqual(await real.json(), [], 'and the 200 case is genuinely empty');
  } finally { await srv.stop(); }
});

// ── the BENEFICIARY path: an agent calling the tool, not a shell calling curl ─

test('#778 an AGENT asking by shortId is TOLD, not handed an empty list', async () => {
  // The reader this defect cost was an agent calling conversation_list, so the
  // curl behaviour above is not the acceptance — this is. `apiCall` turns a
  // non-2xx into a thrown Error carrying `detail.error`, so the question is
  // whether the guidance survives that hop and reaches the model as words.
  //
  // Checked rather than inferred from reading apiCall: on 2026-08-10 an
  // inference from reading a function one level up is exactly what produced
  // the wrong conclusion this card exists to prevent.
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], conversations: [] }) });
  const mcp = await startMcpServer({ restApiBase: srv.baseUrl });
  try {
    const session = await mcpSession(mcp.mcpUrl);
    const result = await session.callTool('conversation_list', { attachedTo: '755' });
    const text = JSON.stringify(result);
    assert.match(text, /no card with id 755/, 'the agent is told what failed');
    assert.match(text, /uuid/i, 'and what to pass instead');
    assert.doesNotMatch(text, /^\[\]$/, 'never a bare empty list');
  } finally {
    await mcp.stop(); await srv.stop();
  }
});
