/**
 * #1216 — THE DAILY DIGEST: every failing STANDING check, rendered into one
 * commons post at the first quiet window after 08:00Z, with per-item AGE, and
 * never posted when there is nothing to say.
 *
 * The rails these cases pin were each paid for once already:
 *   never post an empty digest (#1212, #952)  ·  render the check's own TEXT,
 *   never a ✅/❌ of our own (#1162)  ·  "unless the room is active" is the
 *   tending quiet rule, not a second definition (#953)  ·  age is the point
 *   (#727: a warning can be ignored; a "6 d" that reads the same three
 *   mornings running cannot be unread).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderDigest, digestWindow, digestTick } from '../core/digest.mjs';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'digest-')), 'digest-state.json');

const PHANTOM = {
  id: 'phantom-block',
  claim: 'an OPEN card declares blockedBy a card that is already done — the block cannot block anything',
  rows: [{ blocked: '1215', blocker: '1217' }, { blocked: '1083', blocker: '1088' }],
};
const UNREGISTERED = {
  id: 'unregistered-kinds',
  claim: 'a write carried a kind absent from the registry',
  rows: [{ kind: 'scrum:Foo', card: '1234', by: 'ada' }],
};

// ── rendering ────────────────────────────────────────────────────────────────

test('#1216 nothing failing → NO body. An empty digest is noise, and every post wakes N harnesses', () => {
  const r = renderDigest({ standing: [{ id: 'phantom-block', claim: 'x', rows: [] }], now: '2026-09-06T08:00:00Z', firstSeen: {} });
  assert.equal(r.body, null);
  assert.deepEqual(r.firstSeen, {}, 'and nothing is remembered about items that do not exist');
});

test('#1216 one failing check → one line carrying the check\'s OWN claim text, the count, the rows, and the verb', () => {
  const r = renderDigest({ standing: [PHANTOM], now: '2026-09-06T08:00:00Z', firstSeen: {} });
  assert.ok(r.body);
  assert.match(r.body, /phantom-block/);
  assert.match(r.body, /an OPEN card declares blockedBy a card that is already done/, 'the assertion TEXT, not a status');
  assert.doesNotMatch(r.body, /✅|❌/, 'the digest never summarises a check into a tick of its own (#1162)');
  assert.match(r.body, /2 /, 'the count');
  assert.match(r.body, /1215.*1217|1215/, 'the specific things');
  assert.match(r.body, /→/, 'the one verb that clears it');
});

test('#1216 AGE is the point: an item seen for the first time reads "new"; one first seen six days ago reads "6 d"', () => {
  const first = renderDigest({ standing: [PHANTOM], now: '2026-09-06T08:00:00Z', firstSeen: {} });
  assert.match(first.body, /new/);
  const later = renderDigest({ standing: [PHANTOM], now: '2026-09-12T08:00:00Z', firstSeen: first.firstSeen });
  assert.match(later.body, /oldest 6 d/);
});

test('#1216 an item that stops failing is FORGOTTEN, so a recurrence reads as new rather than as a 30-day-old wound', () => {
  const a = renderDigest({ standing: [PHANTOM], now: '2026-09-06T08:00:00Z', firstSeen: {} });
  const b = renderDigest({ standing: [{ ...PHANTOM, rows: [] }], now: '2026-09-07T08:00:00Z', firstSeen: a.firstSeen });
  assert.equal(b.body, null);
  assert.deepEqual(b.firstSeen, {});
});

test('#1216 a SECOND failing standing check appears as a second line with no code change', () => {
  const r = renderDigest({ standing: [PHANTOM, UNREGISTERED], now: '2026-09-06T08:00:00Z', firstSeen: {} });
  const lines = r.body.split('\n').filter((l) => /^[⚠️🔴]/u.test(l));
  assert.equal(lines.length, 2);
  assert.match(r.body, /unregistered-kinds/);
  assert.match(r.body, /kind_register/, 'the registry item names its verb');
});

test('#1216 a standing check that ERRORED is printed as an error line, never as "nothing wrong" (#1162)', () => {
  const r = renderDigest({ standing: [{ id: 'phantom-block', claim: 'x', error: 'replica cold' }], now: '2026-09-06T08:00:00Z', firstSeen: {} });
  assert.ok(r.body, 'a check that could not run is something the board knows is wrong');
  assert.match(r.body, /could not run|error/i);
  assert.match(r.body, /replica cold/);
});

// ── the window: 24 h, anchored at 08:00Z ─────────────────────────────────────

test('#1216 the window key is the UTC date, but the day starts at 08:00Z (03:00 CDT), stated in UTC so DST moves nothing', () => {
  assert.equal(digestWindow('2026-09-06T07:59:59Z'), 'digest:2026-09-05');
  assert.equal(digestWindow('2026-09-06T08:00:00Z'), 'digest:2026-09-06');
  assert.equal(digestWindow('2026-09-06T23:30:00Z'), 'digest:2026-09-06');
});

// ── the tick: quiet rule reused, once per window, provenance recorded ─────────

function harness({ file, standing, activity = null, quietAfterMinutes = 30 }) {
  const posts = [], mints = [], errors = [];
  return {
    posts, mints, errors,
    tick: (now) => digestTick({
      now, file,
      standing: () => standing,
      post: async (b) => { posts.push(b); },
      onMinted: (m) => mints.push(m),
      quietAfterMinutes,
      lastActivityAt: () => activity,
      onError: (e) => errors.push(e),
    }),
  };
}

test('#1216 the digest fires ONCE at the first quiet tick after 08:00Z and records a mint carrying the rendered body', async () => {
  const file = tmp();
  const h = harness({ file, standing: [PHANTOM] });
  const r1 = await h.tick('2026-09-06T08:00:30Z');
  assert.equal(r1.minted, true);
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].author, 'board');
  assert.match(h.posts[0].body, /\[digest 2026-09-06\]/, 'the window key travels IN the message, like every whisper');
  assert.equal(h.mints.length, 1);
  assert.equal(h.mints[0].window, 'digest:2026-09-06');
  assert.match(h.mints[0].body, /phantom-block/, 'the mint carries what was said, so "what did the digest say on the 6th" is a query');
  const r2 = await h.tick('2026-09-06T09:00:00Z');
  assert.equal(r2.minted, false, 'same window — silent');
  assert.equal(h.posts.length, 1);
  const r3 = await h.tick('2026-09-07T08:00:30Z');
  assert.equal(r3.minted, true, 'next window — fires again, and the age has grown');
  assert.match(h.posts[1].body, /1 d/);
});

test('#1216 NEGATIVE CONTROL: the failing item is fixed → the next morning NOTHING posts, and no mint is recorded', async () => {
  const file = tmp();
  let standing = [PHANTOM];
  const h = harness({ file, standing: [] });
  h.tick = (now) => digestTick({ now, file, standing: () => standing, post: async (b) => { h.posts.push(b); }, onMinted: (m) => h.mints.push(m), quietAfterMinutes: 30, lastActivityAt: () => null });
  await h.tick('2026-09-06T08:00:30Z');
  assert.equal(h.posts.length, 1);
  standing = [{ ...PHANTOM, rows: [] }];                    // registered / cleared
  const r = await h.tick('2026-09-07T08:00:30Z');
  assert.equal(r.minted, false);
  assert.equal(r.reason, 'nothing-to-say');
  assert.equal(h.posts.length, 1, 'no empty digest');
  assert.equal(h.mints.length, 1, 'no mint for a non-firing');
});

test('#1216 "unless the room is active" IS the tending quiet rule: active at 08:00Z → defers; fires at the next quiet tick; at most once', async () => {
  const file = tmp();
  let activity = '2026-09-06T07:59:00Z';                      // a seat posted a minute ago
  const h = harness({ file, standing: [PHANTOM], activity });
  h.tick = (now) => digestTick({ now, file, standing: () => [PHANTOM], post: async (b) => { h.posts.push(b); }, onMinted: (m) => h.mints.push(m), quietAfterMinutes: 30, lastActivityAt: () => activity });
  const r1 = await h.tick('2026-09-06T08:00:30Z');
  assert.equal(r1.minted, false);
  assert.match(r1.reason, /room-active/);
  assert.equal(h.posts.length, 0);
  const r2 = await h.tick('2026-09-06T08:40:00Z');           // 41 min quiet
  assert.equal(r2.minted, true);
  assert.equal(h.posts.length, 1);
});

test('#1216 the digest window does NOT burn when the room is active: no state is written before the post', async () => {
  const file = tmp();
  await digestTick({ now: '2026-09-06T08:00:30Z', file, standing: () => [PHANTOM], post: async () => {}, quietAfterMinutes: 30, lastActivityAt: () => '2026-09-06T07:59:00Z' });
  assert.equal(fs.existsSync(file), false, 'a deferred digest leaves no window claimed');
});

test('#1216 a checks surface that cannot be read SKIPS the window rather than posting stale or empty words', async () => {
  const file = tmp();
  const posts = [];
  const r = await digestTick({ now: '2026-09-06T08:00:30Z', file, standing: () => { throw new Error('checks unreachable'); }, post: async (b) => posts.push(b), quietAfterMinutes: 30, lastActivityAt: () => null });
  assert.equal(r.minted, false);
  assert.equal(r.reason, 'standing-unreadable');
  assert.equal(posts.length, 0);
});

// ── #725 part 2's lesson: a green module with no production caller reads as
// working while the live board does nothing. This pins the CALLER.
test('#1216 the digest tick is WIRED: mcp-server.mjs calls digestTick on the tending interval, gated by the same switch', () => {
  const src = fs.readFileSync(new URL('../mcp-server.mjs', import.meta.url), 'utf8');
  assert.match(src, /import \{ digestTick \} from '\.\/core\/digest\.mjs'/);
  assert.match(src, /digestTick\(\{/, 'the function is called, not merely imported');
  assert.match(src, /if \(tendingEnabled\(\)\) digestTickOnce\(\)/, 'and it rides the operator switch');
});
