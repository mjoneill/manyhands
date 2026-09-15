/**
 * #455 — the stale-claim inquiry: the board ASKS about a silent claim, once per
 * silence, and never reclaims.
 *
 * The acceptance test from the ruling (2026-09-15 01:58Z), verbatim: "a claim
 * aged past N with no holder event produces exactly one commons post; a
 * one-line answer clears it; a working seat with attributed writes never sees
 * it." Plus the two edges the room added: a write ELSEWHERE does not reset the
 * clock, and an answer that names its next check moves the clock to it.
 *
 * Sabotages, each failing a different test:
 *   - count a write anywhere as a card write → "elsewhere" test
 *   - drop the episode key's lastHolderWriteAt → "asked twice" test
 *   - ignore quietUntil                        → "names its next check" test
 *   - post from the check itself / reclaim     → the seam's "still claimed" assertion
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { staleClaims, nextCheckFrom } from '../core/stale-claims.mjs';
import { staleClaimAskTick, unasked, episodeKey, renderAsk, staleClaimStateFilePath } from '../core/stale-claim-ask.mjs';
import { startPair, makeBoardFixture } from './helpers/harness.mjs';

const T0 = Date.parse('2026-09-15T08:00:00.000Z');
const at = (h) => new Date(T0 + h * 3.6e6).toISOString();
const card = (id, shortId, extra = {}) => ({
  id, shortId, title: `card ${shortId}`, description: '', type: 'task', column: 'backlog', order: 0,
  assignees: [], labels: [], priority: null, createdAt: at(-24), updatedAt: at(-24), version: 1,
  relationships: { relatedTo: [], blockedBy: [] }, ...extra,
});
const held = (id, shortId, by, sinceH) => card(id, shortId, { claimedBy: by, claimedAt: at(sinceH) });
const ev = (actor, cardId, h, op = 'update') => ({ seq: 1, recorded_at: at(h), actor, op, entity: { kind: 'card', id: cardId } });
const post = (author, attachedTo, h, body = 'working') => ({ id: `${author}-${h}`, author, attachedTo, createdAt: at(h), body });

test('#455 a claim silent past N is a row; a fresh claim and a working holder are not', () => {
  const rows = staleClaims({
    now: at(3),
    hours: 1,
    cards: [
      held('silent', 10, 'bo', 0),          // 3 h, nothing since
      held('fresh', 20, 'bo', 2.5),         // 0.5 h old
      held('working', 30, 'bex', 0),        // held 3 h, wrote on the card 20 min ago
    ],
    conversations: [],
    events: () => [ev('bex', 'working', 2.67)],
  });
  assert.deepEqual(rows.map((r) => [r.shortId, r.holder, r.silentHours]), [[10, 'bo', 3]],
    `only the silent one: ${JSON.stringify(rows)}`);
});

test('#455 a post by the holder ON the card counts as a write; a write ELSEWHERE does not reset the clock', () => {
  const rows = staleClaims({
    now: at(3),
    hours: 1,
    cards: [held('a', 10, 'bo', 0), held('b', 20, 'bo', 0)],
    conversations: [post('bo', 'a', 2.5)],            // bo answered on card a
    events: () => [ev('bo', 'other-card', 2.9)],      // bo wrote on some OTHER card just now
  });
  assert.deepEqual(rows.map((r) => r.shortId), [20],
    `card a is cleared by the post; card b is still silent despite bo writing elsewhere: ${JSON.stringify(rows)}`);
});

test('#455 the claim\'s own event does not count as a write after it', () => {
  const rows = staleClaims({
    now: at(3), hours: 1,
    cards: [held('a', 10, 'bo', 0)],
    events: () => [ev('bo', 'a', 0.0002)],   // the claim event, ~0.7 s after claimedAt
  });
  assert.equal(rows.length, 1, 'the claim itself is not evidence of work');
});

test('#455 an answer that names its next check moves the clock to it', () => {
  const base = { hours: 1, cards: [held('a', 10, 'bo', 0)], events: () => [] };
  // Tuesday 2026-09-15 08:00Z: "still on it, next observable Thursday" said at +0.5 h
  const said = [post('bo', 'a', 0.5, 'still on it, next observable is Thursday')];
  assert.deepEqual(staleClaims({ ...base, now: at(30), conversations: said }), [], 'Wednesday: quiet, they said Thursday');
  const thu = staleClaims({ ...base, now: '2026-09-17T00:30:00.000Z', conversations: said });
  assert.equal(thu.length, 1, 'Thursday came and nothing landed — asked again');
  assert.equal(thu[0].quietUntil, '2026-09-17T00:00:00.000Z');
  // an ISO date works the same way; a bare "still on it" only restarts the N clock
  assert.deepEqual(staleClaims({ ...base, now: at(30), conversations: [post('bo', 'a', 0.5, 'back on it 2026-09-18')] }), []);
  assert.equal(staleClaims({ ...base, now: at(2), conversations: [post('bo', 'a', 0.5, 'still on it')] }).length, 1);
});

test('#455 nextCheckFrom reads the two spellings the room uses and nothing else', () => {
  assert.equal(nextCheckFrom('next observable Thursday', '2026-09-15T08:00:00Z'), '2026-09-17T00:00:00.000Z');
  assert.equal(nextCheckFrom('Thursday', '2026-09-17T08:00:00Z'), '2026-09-24T00:00:00.000Z', 'said on a Thursday = next week');
  assert.equal(nextCheckFrom('by 2026-09-18T15:00Z', '2026-09-15T08:00:00Z'), '2026-09-18T15:00:00.000Z');
  assert.equal(nextCheckFrom('still on it', '2026-09-15T08:00:00Z'), null);
  assert.equal(nextCheckFrom('see #1388 at 12:00', '2026-09-15T08:00:00Z'), null, 'a card number and a clock time are not a date');
});

test('#455 the ask fires ONCE per silence episode; a holder write makes a new episode; cleared rows are pruned', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stale-455-')), 'state.json');
  const posts = [];
  const postFn = async (b) => { posts.push(b); };
  const row = { id: 'a', shortId: 10, title: 'card 10', holder: 'bo', claimedAt: at(0), lastHolderWriteAt: at(0), silentHours: 1.5, quietUntil: null };

  await staleClaimAskTick({ now: at(1.5), rows: [row], post: postFn, file });
  await staleClaimAskTick({ now: at(1.6), rows: [{ ...row, silentHours: 1.6 }], post: postFn, file });
  assert.equal(posts.length, 1, 'the same silence is asked about once, not every tick (#1359)');
  assert.match(posts[0].body, /^🕰 #10 «card 10» — bo, what happened\?/);
  assert.doesNotMatch(posts[0].body, /@bo/, 'named, not @-mentioned — a mention is a paid wake');
  assert.equal(posts[0].attachedTo, null, 'one commons line');

  // bo answers on the card at +2 h ("still on it"); the row disappears; then silence again → asked ONCE more
  await staleClaimAskTick({ now: at(2), rows: [], post: postFn, file });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).asked, {}, 'a cleared episode is pruned from the state');
  const again = { ...row, lastHolderWriteAt: at(2), silentHours: 1.2 };
  await staleClaimAskTick({ now: at(3.2), rows: [again], post: postFn, file });
  await staleClaimAskTick({ now: at(3.3), rows: [again], post: postFn, file });
  assert.equal(posts.length, 2, 'a fresh N of silence after an answer is a new episode — asked once');

  // unreadable rows: nothing asked, nothing forgotten
  const r = await staleClaimAskTick({ now: at(4), rows: null, post: postFn, file });
  assert.equal(r.reason, 'rows unreadable');
  assert.equal(posts.length, 2);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).asked).length, 1, 'state untouched by an unreadable tick');
});

test('#455 a failed post is not recorded as asked — it is asked next tick', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stale-455-')), 'state.json');
  const row = { id: 'a', shortId: 10, title: 'card 10', holder: 'bo', claimedAt: at(0), lastHolderWriteAt: at(0), silentHours: 2, quietUntil: null };
  let fail = true; const posts = [];
  const postFn = async (b) => { if (fail) throw new Error('REST 000'); posts.push(b); };
  await staleClaimAskTick({ now: at(2), rows: [row], post: postFn, file });
  assert.equal(posts.length, 0);
  fail = false;
  await staleClaimAskTick({ now: at(2.1), rows: [row], post: postFn, file });
  assert.equal(posts.length, 1);
});

test('#455 the state file lives beside the tending config (the data dir a deploy does not refresh), unless named', () => {
  const saved = { a: process.env.SCRUM_STALE_CLAIM_STATE_FILE, t: process.env.SCRUM_TENDING_CONFIG_FILE };
  try {
    delete process.env.SCRUM_STALE_CLAIM_STATE_FILE;
    process.env.SCRUM_TENDING_CONFIG_FILE = '/srv/board/tending-config.json';
    assert.equal(staleClaimStateFilePath(), '/srv/board/stale-claim-state.json');
    process.env.SCRUM_STALE_CLAIM_STATE_FILE = '/elsewhere/s.json';
    assert.equal(staleClaimStateFilePath(), '/elsewhere/s.json', 'an explicit path wins');
    delete process.env.SCRUM_STALE_CLAIM_STATE_FILE; delete process.env.SCRUM_TENDING_CONFIG_FILE;
    assert.match(staleClaimStateFilePath(), /stale-claim-state\.json$/, 'a dev checkout falls back to the tree');
  } finally {
    if (saved.a) process.env.SCRUM_STALE_CLAIM_STATE_FILE = saved.a; else delete process.env.SCRUM_STALE_CLAIM_STATE_FILE;
    if (saved.t) process.env.SCRUM_TENDING_CONFIG_FILE = saved.t; else delete process.env.SCRUM_TENDING_CONFIG_FILE;
  }
});

test('#455 unasked/episodeKey — the key changes on every holder write and every named next check', () => {
  const a = { id: 'a', claimedAt: at(0), lastHolderWriteAt: at(0), quietUntil: null };
  assert.notEqual(episodeKey(a), episodeKey({ ...a, lastHolderWriteAt: at(1) }));
  assert.notEqual(episodeKey(a), episodeKey({ ...a, quietUntil: at(24) }));
  const { fresh, asked } = unasked([a], { [episodeKey(a)]: at(1), stale: at(0) });
  assert.deepEqual(fresh, []);
  assert.deepEqual(Object.keys(asked), [episodeKey(a)], 'keys with no row any more are pruned');
  assert.match(renderAsk({ ...a, shortId: 1, title: 't', holder: 'h', silentHours: 50 }), /for 2 d\./);
});

/**
 * THE SEAM — the real adapter against the real REST: a claim aged past N with
 * no holder event produces exactly ONE commons post from `board`, the card is
 * STILL CLAIMED afterwards (never reclaims), and the holder's one-line answer
 * on the card clears the row. N is 1 h by ruling; the fixture backdates the
 * claim so no test waits an hour.
 */
test('#455 SEAM — the adapter asks once about a silent claim, never reclaims, and the answer clears it', async () => {
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stale-455-')), 'state.json');
  const tendingFile = path.join(path.dirname(stateFile), 'tending.json');
  fs.writeFileSync(tendingFile, JSON.stringify({ enabled: true, quietAfterMinutes: 69 }));
  const board = makeBoardFixture({
    cards: [
      held('silent', 10, 'bo', -3),        // claimed 3 h before the fixture's "now" (the server's clock is real, so: 3 h ago)
      held('working', 20, 'bex', -3),
    ],
    conversations: [post('bex', 'working', -0.2, 'still on it, next observable is the test')],
  });
  // fixture stamps are relative to T0 (08:00Z today); shift them to real time so "3 h ago" is 3 h ago
  const shift = Date.now() - T0;
  for (const c of board.cards) c.claimedAt = new Date(Date.parse(c.claimedAt) + shift).toISOString();
  for (const m of board.conversations) m.createdAt = new Date(Date.parse(m.createdAt) + shift).toISOString();

  const pair = await startPair({
    board,
    mcpEnv: { SCRUM_TENDING_CONFIG_FILE: tendingFile, SCRUM_STALE_CLAIM_STATE_FILE: stateFile, MCP_WHISPER_TICK_MS: '400' },
  });
  const { rest, mcp } = pair;
  const asks = async () => {
    const all = await (await fetch(`${rest.baseUrl}/api/conversations`)).json();
    return all.filter((m) => m.author === 'board' && /^🕰 #/.test(m.body || ''));
  };
  try {
    await new Promise((r) => setTimeout(r, 2_500));   // ≥ 5 ticks
    let a = await asks();
    assert.equal(a.length, 1, `exactly one ask across several ticks: ${JSON.stringify(a.map((m) => m.body))}`);
    assert.match(a[0].body, /#10 «card 10» — bo, what happened\?/);
    assert.doesNotMatch(a[0].body, /#20/, 'the working holder (a post on the card 12 min ago) is never asked');
    const still = await (await fetch(`${rest.baseUrl}/api/cards/silent`)).json();
    assert.equal(still.claimedBy, 'bo', 'NEVER RECLAIMS — the claim is exactly where it was');

    // bo answers in one line, on the card
    const res = await fetch(`${rest.baseUrl}/api/conversations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: 'bo', attachedTo: 'silent', body: 'still on it, next observable is the seam test going green' }),
    });
    assert.equal(res.status, 201);
    await new Promise((r) => setTimeout(r, 1_500));
    const std = (await (await fetch(`${rest.baseUrl}/api/checks`)).json()).standing.find((s) => s.id === 'stale-claims');
    assert.deepEqual(std.rows, [], `the answer cleared the row: ${JSON.stringify(std)}`);
    a = await asks();
    assert.equal(a.length, 1, 'no second ask after the answer');
  } finally {
    await pair.stop();
  }
});
