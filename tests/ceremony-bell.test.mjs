/**
 * #1815 — ceremonies open themselves. Rows R1–R9 from the card's ROWS v1/v1.1.
 *
 * The bell is a pure tick with everything injected (like tendingTick), so each
 * row runs on a fixture clock with no server. The store is the real file-backed
 * store over a temp file, so R2's restart case exercises the persistence that
 * ships, not a Map.
 *
 * Sabotage profiles (applied by scripts, each with `assert old in src` first):
 *   (a) drop the key check            → R2 fails
 *   (b) hardcode the opener seat      → R3 fails
 *   (c) gate on the tending silence   → R6 fails
 *   (d) drop schedule change-detect   → R9 fails
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ceremonyBellTick,
  fileBellStore,
  scheduleSource,
  validateSchedule,
  BELL_TOLERANCE_MS,
} from '../core/ceremony-bell.mjs';

// Every temp dir a row makes is removed when the file ends: the suite runner fails a file that leaves entries behind.
const made = [];
const dir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bell-')); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
// 2026-11-11 is a Wednesday (UTC weekday 3).
const W = (h, m = 0, s = 0) =>
  `2026-11-11T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.000Z`;
const REVIEW = { kind: 'review', weekday: 3, time: '16:00', preRead: '1816' };

function seats({ sm = 'seat-sm', po = 'seat-po', smExpired = false } = {}) {
  const s = [];
  if (sm) s.push({ seat: sm, role: 'scrum-master', expired: smExpired, expiresAt: '2026-11-20T00:00:00Z' });
  if (po) s.push({ seat: po, role: 'po', expired: false, expiresAt: '2026-11-20T00:00:00Z' });
  s.push({ seat: 'seat-other', role: null, expired: false });
  return { seats: s };
}

function harness({ d = dir(), schedule = [REVIEW], seatState = seats(), postAt } = {}) {
  const posts = [];
  const events = [];
  const store = fileBellStore(path.join(d, 'bell-state.json'));
  return {
    d, posts, events, store,
    tick: (now, extra = {}) => ceremonyBellTick({
      now,
      schedule,
      seatState: () => seatState,
      store: extra.store || store,
      post: async (body) => {
        const createdAt = postAt ? postAt(now) : now;
        posts.push({ ...body, createdAt });
        return { id: `p${posts.length}`, createdAt };
      },
      record: (e) => events.push(e),
      // What tendingTick would be handed; the bell must ignore it (R6).
      recentPosts: extra.recentPosts || [],
      quietAfterMinutes: 58,
    }),
  };
}

const openers = (h) => h.posts.filter((p) => p.kind === 'opener');
const flags = (h) => h.posts.filter((p) => p.kind === 'flag');

// R1 ────────────────────────────────────────────────────────────────────────
test('R1: at the slot the bell posts one opener naming the ceremony, the SM and the pre-read', async () => {
  const h = harness();
  await h.tick(W(16, 0, 30));
  assert.equal(openers(h).length, 1);
  const b = openers(h)[0].body;
  assert.match(b, /review/i);
  assert.match(b, /seat-sm/);
  assert.match(b, /#1816/);
  const fired = h.events.filter((e) => e.outcome === 'fired');
  assert.equal(fired.length, 1);
  assert.equal(fired[0].openerSource, 'role');
  assert.equal(fired[0].key, `review@${W(16)}`);
});

test('R1 control: before the slot nothing fires', async () => {
  const h = harness();
  await h.tick(W(15, 59, 59));
  assert.equal(h.posts.length, 0);
});

// R2 ────────────────────────────────────────────────────────────────────────
test('R2: a second tick in the window does not post again, and says why', async () => {
  const h = harness();
  await h.tick(W(16, 0, 30));
  await h.tick(W(16, 1, 30));
  assert.equal(openers(h).length, 1);
  const dup = h.events.filter((e) => e.outcome === 'suppressed-duplicate');
  assert.equal(dup.length, 1);
  assert.equal(dup[0].key, `review@${W(16)}`);
});

test('R2: a restart (fresh store over the same file) does not post again', async () => {
  const h = harness();
  await h.tick(W(16, 0, 30));
  const reopened = fileBellStore(path.join(h.d, 'bell-state.json'));
  await h.tick(W(16, 2), { store: reopened });
  assert.equal(openers(h).length, 1);
});

test('R2c: two ticks racing one bell over one store post once', async () => {
  // The seat-state read is the await between "is it taken?" and "take it".
  const h = harness();
  const slowSeats = () => new Promise((r) => setTimeout(() => r(seats()), 20));
  const tick = (store) => ceremonyBellTick({
    now: W(16, 0, 30), schedule: [REVIEW], seatState: slowSeats, store,
    post: async (b) => { h.posts.push(b); return { id: 'x', createdAt: W(16, 0, 30) }; },
    record: (e) => h.events.push(e),
  });
  const other = fileBellStore(path.join(h.d, 'bell-state.json'));
  await Promise.all([tick(h.store), tick(other)]);
  assert.equal(openers(h).length, 1);
});

// R3 / R3b ──────────────────────────────────────────────────────────────────
test('R3: SM unheld → the PO is named as opener, and the post says the SM role is unheld', async () => {
  const h = harness({ seatState: seats({ sm: null }) });
  await h.tick(W(16, 0, 30));
  assert.equal(openers(h).length, 1);
  const b = openers(h)[0].body;
  assert.match(b, /seat-po/);
  assert.doesNotMatch(b, /seat-sm/);
  assert.match(b, /scrum master.*unheld|unheld.*scrum master/i);
  assert.equal(h.events.find((e) => e.outcome === 'fired').openerSource, 'po-fallback');
});

test('R3: an EXPIRED SM declaration counts as unheld', async () => {
  const h = harness({ seatState: seats({ smExpired: true }) });
  await h.tick(W(16, 0, 30));
  assert.equal(openers(h).length, 1, 'one opener');
  assert.match(openers(h)[0].body, /seat-po/);
  assert.doesNotMatch(openers(h)[0].body, /seat-sm/);
});

test('R3b: no SM and no PO → it still posts, and says both roles are unheld', async () => {
  const h = harness({ seatState: seats({ sm: null, po: null }) });
  await h.tick(W(16, 0, 30));
  assert.equal(openers(h).length, 1);
  assert.match(openers(h)[0].body, /no scrum master or po/i);
  assert.equal(h.events[0].outcome, 'fired-no-holder');
});

// R4 ────────────────────────────────────────────────────────────────────────
test('R4: every event carries key, slot, tick time, outcome and opener', async () => {
  const h = harness();
  await h.tick(W(16, 0, 30));
  await h.tick(W(16, 1));
  const keyed = h.events.filter((x) => x.key);
  assert.ok(keyed.length >= 2, `both ticks recorded an event (got ${keyed.length})`);
  for (const e of keyed) {
    for (const f of ['key', 'kind', 'slot', 'tickAt', 'outcome', 'opener', 'openerSource']) {
      assert.ok(f in e, `event missing ${f}: ${JSON.stringify(e)}`);
    }
  }
});

// R5 / R5b ──────────────────────────────────────────────────────────────────
test('R5: a boot after the window does not catch up — no post, and the miss is recorded', async () => {
  const h = harness();
  await h.tick(W(18, 0));
  assert.equal(h.posts.length, 0);
  const m = h.events.filter((e) => e.outcome === 'missed-past-window');
  assert.equal(m.length, 1);
  await h.tick(W(18, 1));
  assert.equal(h.events.filter((e) => e.outcome === 'missed-past-window').length, 1, 'recorded once, not every tick');
});

test('R5b: a boot at 16:03, inside the tolerance, still fires', async () => {
  const h = harness();
  await h.tick(W(16, 3));
  assert.equal(openers(h).length, 1);
});

// R6 ────────────────────────────────────────────────────────────────────────
test('R6: an active room (post one minute before the slot) does not stop the bell', async () => {
  const h = harness();
  await h.tick(W(16, 0, 30), {
    recentPosts: [{ author: 'seat-po', createdAt: W(15, 59), body: 'busy' }],
  });
  assert.equal(openers(h).length, 1);
});

// R7 ────────────────────────────────────────────────────────────────────────
test('R7: an opener that landed on time raises no flag', async () => {
  const h = harness();
  await h.tick(W(16, 0, 30));
  await h.tick(W(16, 6));
  assert.equal(flags(h).length, 0);
  assert.equal(h.events.filter((e) => e.outcome === 'landed-on-time').length, 1);
});

test('R7: lateness is read from the stored createdAt, not the tick clock', async () => {
  // The tick runs at 16:00:30 but the server stamps the post 7 minutes late.
  const h = harness({ postAt: () => W(16, 7) });
  await h.tick(W(16, 0, 30));
  await h.tick(W(16, 8));
  await h.tick(W(16, 9));
  assert.equal(flags(h).length, 1, 'exactly one flag per bell');
  assert.match(flags(h)[0].body, /late/i);
  assert.match(flags(h)[0].body, /420\s*s|7\s*min/);
});

test('R7: an opener that never posted raises one "missing" flag after the window', async () => {
  const h = harness();
  h.store.put(`review@${W(16)}`, { state: 'attempted', at: W(16, 0, 10) }); // a post that threw
  await h.tick(W(16, 6));
  await h.tick(W(16, 7));
  assert.equal(flags(h).length, 1);
  assert.match(flags(h)[0].body, /missing|no opener/i);
});

// R10 ──────────────────────────────────────────────────────────────────────
// Over REST the state write can fail AFTER the opener has posted. That is not a failed post: the room has its opener.
function failingPostedPut(store) {
  return { get: (k) => store.get(k), reserve: (k, v) => store.reserve(k, v),
    put: (k, v) => { if (v.state === 'posted') throw new Error('injected: state write refused'); return store.put(k, v); } };
}
test('R10: the opener posts but its state write fails → one opener, recorded as fired-state-not-saved, never post-failed', async () => {
  const h = harness();
  await h.tick(W(16, 0, 30), { store: failingPostedPut(h.store) });
  assert.equal(openers(h).length, 1, 'the opener posted');
  const outs = h.events.map((e) => e.outcome);
  assert.ok(!outs.includes('post-failed'), `a post that landed is not a failed post (${outs})`);
  const e = h.events.find((x) => x.outcome === 'fired-state-not-saved');
  assert.ok(e, `the lost state write is recorded (${outs})`);
  assert.equal(e.postId, 'p1', 'with the post it lost');
  assert.match(e.error, /state write refused/);
});
test('R10b: the after-window flag for that slot says what the store knows (nothing recorded), not that nothing landed', async () => {
  const h = harness();
  await h.tick(W(16, 0, 30), { store: failingPostedPut(h.store) });
  await h.tick(W(16, 6));
  assert.equal(flags(h).length, 1);
  assert.match(flags(h)[0].body, /recorded/, flags(h)[0].body);
  assert.doesNotMatch(flags(h)[0].body, /landed/, 'the store cannot know whether a post landed');
});

// R11 ──────────────────────────────────────────────────────────────────────
// The bell is reserved before the seats are read, so a seat-state read that throws must not burn the ceremony, and it
// must not claim nobody is declared: "I could not ask" is not "nobody holds the role".
test('R11: seat state unreadable → it still posts, says the role holders could not be read, and names nobody', async () => {
  const h = harness();
  await ceremonyBellTick({ now: W(16, 0, 30), schedule: [REVIEW], store: h.store, record: (e) => h.events.push(e),
    seatState: async () => { throw new Error('injected: seat state unreadable'); },
    post: async (b) => { h.posts.push(b); return { id: 'p1', createdAt: W(16, 0, 31) }; } });
  assert.equal(openers(h).length, 1, 'the ceremony still opens');
  const body = openers(h)[0].body;
  assert.match(body, /could not be read/i, body);
  assert.doesNotMatch(body, /No scrum master or PO is declared/, 'it does not claim nobody is declared');
  assert.doesNotMatch(body, /@/, 'and names nobody');
  const e = h.events.find((x) => x.key && x.outcome && x.outcome.startsWith('fired'));
  assert.equal(e?.openerSource, 'seat-state-unreadable', JSON.stringify(h.events));
  assert.match(e?.seatStateError || '', /injected/);
});

// R8 / R9 ───────────────────────────────────────────────────────────────────
function writeSched(file, entries) {
  fs.writeFileSync(file, JSON.stringify({ enabled: true, ceremonies: entries }));
}

test('R8: the schedule is read from its file each tick — an edit applies with no restart', async () => {
  const d = dir();
  const file = path.join(d, 'ceremony-schedule.json');
  writeSched(file, [REVIEW]);
  const src = scheduleSource(file);
  const events = [];
  const posts = [];
  const tick = (now) => ceremonyBellTick({
    now, schedule: src, seatState: () => seats(),
    store: fileBellStore(path.join(d, 's.json')),
    post: async (b) => { posts.push(b); return { id: 'x', createdAt: now }; },
    record: (e) => events.push(e),
  });
  await tick(W(16, 0, 30));
  writeSched(file, [REVIEW, { kind: 'retro', weekday: 3, time: '17:00', preRead: '1816' }]);
  await tick(W(17, 0, 30));
  assert.equal(posts.filter((p) => p.kind === 'opener').length, 2);
  assert.match(posts[1].body, /retro/i);
});

test('R8: an invalid entry refuses the whole schedule — nothing posts, the entry is named', async () => {
  const d = dir();
  const file = path.join(d, 'ceremony-schedule.json');
  writeSched(file, [REVIEW, { kind: 'retro', weekday: 9, time: '25:00' }]);
  const events = [];
  const posts = [];
  await ceremonyBellTick({
    now: W(16, 0, 30), schedule: scheduleSource(file), seatState: () => seats(),
    store: fileBellStore(path.join(d, 's.json')),
    post: async (b) => { posts.push(b); return { id: 'x', createdAt: W(16) }; },
    record: (e) => events.push(e),
  });
  assert.equal(posts.length, 0);
  const r = events.find((e) => e.type === 'schedule-refused');
  assert.ok(r, 'a schedule-refused event');
  assert.match(r.error, /retro/);
});

test('R8: validateSchedule rejects bad weekday, bad time and missing kind', () => {
  assert.equal(validateSchedule({ ceremonies: [REVIEW] }).ok, true);
  assert.equal(validateSchedule({ ceremonies: [{ ...REVIEW, weekday: 7 }] }).ok, false);
  assert.equal(validateSchedule({ ceremonies: [{ ...REVIEW, time: '16:60' }] }).ok, false);
  assert.equal(validateSchedule({ ceremonies: [{ weekday: 3, time: '16:00' }] }).ok, false);
  assert.equal(validateSchedule({}).ok, false);
});

test('R8: the bell has its own enabled flag — disabled posts nothing', async () => {
  const d = dir();
  const file = path.join(d, 'ceremony-schedule.json');
  fs.writeFileSync(file, JSON.stringify({ enabled: false, ceremonies: [REVIEW] }));
  const posts = [];
  await ceremonyBellTick({
    now: W(16, 0, 30), schedule: scheduleSource(file), seatState: () => seats(),
    store: fileBellStore(path.join(d, 's.json')),
    post: async (b) => { posts.push(b); return { id: 'x', createdAt: W(16) }; },
    record: () => {},
  });
  assert.equal(posts.length, 0);
});

test('R9: schedule-loaded is recorded on first read and on change only, with path, mtime, sha256, slots', async () => {
  const d = dir();
  const file = path.join(d, 'ceremony-schedule.json');
  writeSched(file, [REVIEW]);
  const src = scheduleSource(file);
  const events = [];
  const run = (now) => ceremonyBellTick({
    now, schedule: src, seatState: () => seats(),
    store: fileBellStore(path.join(d, 's.json')),
    post: async () => ({ id: 'x', createdAt: now }),
    record: (e) => events.push(e),
  });
  await run(W(10)); await run(W(10, 1)); await run(W(10, 2));
  let loaded = events.filter((e) => e.type === 'schedule-loaded');
  assert.equal(loaded.length, 1, 'not on every tick');
  for (const f of ['path', 'mtime', 'sha256', 'slots']) assert.ok(f in loaded[0], `missing ${f}`);
  assert.match(loaded[0].sha256, /^[0-9a-f]{64}$/);
  writeSched(file, [REVIEW, { kind: 'retro', weekday: 3, time: '17:00' }]);
  await run(W(10, 3));
  loaded = events.filter((e) => e.type === 'schedule-loaded');
  assert.equal(loaded.length, 2);
  assert.notEqual(loaded[0].sha256, loaded[1].sha256);
});

test('the tolerance is five minutes', () => {
  assert.equal(BELL_TOLERANCE_MS, 5 * 60 * 1000);
});
