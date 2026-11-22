/**
 * #2029 slice 1 (i) — REACTIONS RIDE ALONG INTO A GUEST'S NEXT WAKE.
 *
 * A guest seat drains on its own cadence, so a reaction never wakes it: it is handed the reactions given since its last
 * settled wake, inside whatever wake comes next. Three rules, each pinned here:
 *
 * - its own checkpoint, moved only past what was handed over on a wake that settled (an unsettled wake sees them again);
 * - `reactions.receive` on the agent: 'all' (default) | 'own' (only reactions on its own posts) | 'off' (none);
 * - a failed read is SAID in the prompt, never rendered as "no reactions" (fail-open is fine, fail-invisible is not).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reactionsWindow, advanceReactionsCursor, buildMessages } from '../core/guest-loop.mjs';

const NOW = '2026-11-22T12:00:00.000Z';
const agent = (extra = {}) => ({ seatKey: 'otto', name: 'Otto', residency: 'guest', ...extra });
const rx = (over = {}) => ({ post: 'p1', postAuthor: 'otto', excerpt: 'my post', emoji: '👍', by: 'nell', at: '2026-11-22T11:30:00.000Z', ...over });
const systemText = (m) => m.map((x) => (typeof x.content === 'string' ? x.content : '')).join('\n');

test('G1 the window starts at the reactions checkpoint; with none, an hour back; receive=own aims at the seat; off reads nothing', () => {
  assert.deepEqual(reactionsWindow({ reactionsSeenThrough: '2026-11-22T11:00:00.000Z' }, agent(), NOW), { since: '2026-11-22T11:00:00.000Z', author: null });
  assert.deepEqual(reactionsWindow({}, agent(), NOW), { since: '2026-11-22T11:00:00.000Z', author: null }, 'first wake: the last hour');
  assert.deepEqual(reactionsWindow({}, agent({ reactions: { receive: 'own' } }), NOW).author, 'otto');
  assert.equal(reactionsWindow({}, agent({ reactions: { receive: 'off' } }), NOW), null);
  assert.deepEqual(reactionsWindow({}, agent({ reactions: { receive: 'bogus' } }), NOW).author, null, 'an unknown value falls back to all, never to off');
});

test('G2 the checkpoint moves only past the newest reaction handed over; an unread or empty window leaves it be', () => {
  const s = { reactionsSeenThrough: '2026-11-22T11:00:00.000Z' };
  assert.equal(advanceReactionsCursor(s, { ok: true, reactions: [rx({ at: '2026-11-22T11:10:00.000Z' }), rx({ at: '2026-11-22T11:40:00.000Z' })] }).reactionsSeenThrough, '2026-11-22T11:40:00.001Z');
  assert.equal(advanceReactionsCursor(s, { ok: false, reactions: [] }).reactionsSeenThrough, '2026-11-22T11:00:00.000Z', 'a failed read never moves it');
  assert.equal(advanceReactionsCursor(s, { ok: true, reactions: [] }).reactionsSeenThrough, '2026-11-22T11:00:00.000Z', 'nothing new, nothing moved');
  assert.equal(advanceReactionsCursor(s, null).reactionsSeenThrough, '2026-11-22T11:00:00.000Z', 'receive=off: no read, no move');
});

test('G3 the wake names reactions on the seat\'s OWN posts first and says a reaction does not ask for a reply', () => {
  const text = systemText(buildMessages({ agent: agent(), wake: { kind: 'channel', posts: [] }, reactions: { ok: true, reactions: [
    rx({ by: 'ada', emoji: '😂', postAuthor: 'nell', excerpt: 'someone else\'s post' }),
    rx({ by: 'nell', emoji: '👍', postAuthor: 'otto', excerpt: 'my post' }),
  ] } }));
  const own = text.indexOf('nell 👍 on YOUR post: "my post"');
  const other = text.indexOf('ada 😂 on nell\'s post: "someone else\'s post"');
  assert.ok(own > -1 && other > -1, 'both are shown');
  assert.ok(own < other, 'own posts first');
  assert.match(text, /does not ask you to reply/);
});

test('G4 a failed read is said out loud; no reactions and receive=off add nothing', () => {
  const failed = systemText(buildMessages({ agent: agent(), wake: { kind: 'channel', posts: [] }, reactions: { ok: false, reactions: [] } }));
  assert.match(failed, /reactions could not be read this wake/i);
  assert.match(failed, /do not conclude there were none/i);
  const none = systemText(buildMessages({ agent: agent(), wake: { kind: 'channel', posts: [] }, reactions: { ok: true, reactions: [] } }));
  assert.doesNotMatch(none, /[Rr]eactions/);
  const off = systemText(buildMessages({ agent: agent(), wake: { kind: 'channel', posts: [] }, reactions: null }));
  assert.doesNotMatch(off, /[Rr]eactions/);
});

test('G5 a long window is capped and the cut is said, never silent', () => {
  const many = Array.from({ length: 30 }, (_, i) => rx({ by: `s${i}`, at: `2026-11-22T11:${String(i).padStart(2, '0')}:00.000Z` }));
  const text = systemText(buildMessages({ agent: agent(), wake: { kind: 'channel', posts: [] }, reactions: { ok: true, reactions: many } }));
  assert.match(text, /10 more will be shown on your next wake/);
});

test('G6 (review, #269) the checkpoint never passes a reaction the prompt did not show: 25 in the window, 20 shown, the cursor sits at the 20th', () => {
  const many = Array.from({ length: 25 }, (_, i) => rx({ by: `s${i}`, postAuthor: i === 24 ? 'otto' : 'nell', at: `2026-11-22T11:${String(i).padStart(2, '0')}:00.000Z` }));
  const read = { ok: true, reactions: many };
  assert.equal(advanceReactionsCursor({}, read).reactionsSeenThrough, '2026-11-22T11:19:00.001Z', 'only past the 20th oldest, the last one shown');
  const text = systemText(buildMessages({ agent: agent(), wake: { kind: 'channel', posts: [] }, reactions: read }));
  assert.match(text, /s19 👍/, 'the 20th is shown');
  assert.doesNotMatch(text, /s24 👍/, 'the 25th (newest, even on its own post) waits for the next wake');
  assert.match(text, /5 more will be shown on your next wake/);
});
