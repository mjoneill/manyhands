/**
 * #726 — the fanout watch alarms on ordinary client turnover.
 *
 * These cases are NOT invented. Every "real log" case below is transcribed from
 * the live watch log (SCRUM_FANOUT_STATE's sibling .log), read 2026-08-07, and
 * the expected result is what the watch SHOULD have done, not what it did.
 *
 * The regression block matters as much as the new behaviour: this decision has
 * been fixed six times in production (#664 #666 #668 #690 #703 #713) with no
 * test ever written, and #726 extracts it into a pure function. An extraction
 * that silently drops one of those six fixes would trade a false-positive bug
 * for a false-NEGATIVE one — strictly worse, since #624 says a deaf seat has no
 * queue and no replay. So each prior fix gets a case that fails without it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../scripts/fanout-decide.mjs';

const HOUR = 3600 * 1000;
const COOLDOWN = 6 * HOUR;
const T0 = 1_754_570_000_000; // fixed clock — never Date.now() in a test

// Defaults matching the live plist: floor 3.
const base = { floor: 3, cooldownMs: COOLDOWN, now: T0 };
const fresh = { r: 7, pendingFrom: null, warned: false, sigTimes: {}, hist: [7, 7, 7, 7, 7, 7] };

/** Drive several ticks through decide(), returning every warnBody produced. */
function run(readings, state = fresh, opts = {}) {
  let st = { ...state };
  const warnings = [];
  for (const [i, reading] of readings.entries()) {
    const out = decide({ ...base, ...opts, now: T0 + i * 300_000, state: st, ...reading });
    st = out.state;
    warnings.push(out.warnBody);
  }
  return { state: st, warnings, fired: warnings.filter(Boolean) };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE NEW BEHAVIOUR — sessions falling WITH receivers is a client leaving
// ─────────────────────────────────────────────────────────────────────────────

test('real log 11:33→11:43Z: receivers 7→6 while sessions 13→11 is turnover, not deafness', () => {
  const { fired } = run([
    { receivers: 7, sessions: 13 },
    { receivers: 6, sessions: 11 },  // arm — a client left, taking its stream
    { receivers: 6, sessions: 11 },  // this tick posted HTTP 201 in production
  ]);
  assert.deepEqual(fired, [], 'sessions fell further than receivers — nothing went deaf');
});

test('real log 12:43→12:53Z: restart churn that is already recovering must not alarm', () => {
  const { fired } = run([
    { receivers: 7, sessions: 12 },
    { receivers: 4, sessions: 5 },   // arm — mcp restart killed sessions AND streams
    { receivers: 5, sessions: 10 },  // this tick posted HTTP 201; it was RECOVERING
  ]);
  assert.deepEqual(fired, [], 'sessions recovered in step with receivers');
});

test('#624 PRESERVED: sessions recover but streams do not — this is real deafness', () => {
  const { fired } = run([
    { receivers: 7, sessions: 12 },
    { receivers: 4, sessions: 5 },   // arm — the restart itself
    { receivers: 4, sessions: 12 },  // clients reconnected; streams did NOT re-open
  ]);
  assert.equal(fired.length, 1, 'sessions back to baseline with receivers still down MUST warn');
  assert.match(fired[0], /receivers dropped 7 → 4/);
});

test('the discriminator is evaluated against the BASELINE, not the previous tick', () => {
  // Tick-to-tick would see sessions 5→12 (a RISE) and receivers 4→4 (flat) and
  // conclude nothing changed. Only the baseline comparison exposes the deafness.
  const { fired } = run([
    { receivers: 7, sessions: 12 },
    { receivers: 4, sessions: 5 },
    { receivers: 4, sessions: 12 },
  ]);
  assert.equal(fired.length, 1);
});

test('partial stream recovery still warns when sessions outrun receivers', () => {
  const { fired } = run([
    { receivers: 7, sessions: 12 },
    { receivers: 3, sessions: 6 },
    { receivers: 4, sessions: 12 },  // sessions fully back, receivers 3 short
  ]);
  assert.equal(fired.length, 1, 'a 3-stream shortfall under a full session count is deafness');
});

// ─────────────────────────────────────────────────────────────────────────────
// REGRESSIONS — one per prior production fix. Each fails if that fix is lost.
// ─────────────────────────────────────────────────────────────────────────────

test('#664 a one-tick dip does not warn (re-registration churn)', () => {
  const { fired } = run([
    { receivers: 7, sessions: 12 },
    { receivers: 6, sessions: 12 },  // arm only
    { receivers: 7, sessions: 12 },  // recovered before the second tick
  ]);
  assert.deepEqual(fired, [], 'a drop must persist two ticks');
});

test('#666 the cooldown is PER SIGNATURE — an intervening signature must not release it', () => {
  const st = {
    r: 7, pendingFrom: null, warned: false,
    sigTimes: { 'drop:4': T0 - HOUR },        // 4 already muted, one hour ago
    hist: [7, 7, 7, 7, 7, 7],
  };
  const { fired } = run([
    { receivers: 6, sessions: 12 },
    { receivers: 4, sessions: 12 },  // arm at 4
    { receivers: 4, sessions: 12 },  // would warn, but drop:4 is muted
  ], st);
  assert.deepEqual(fired, [], 'drop:4 is inside its 6h window');
});

test('#690 the cooldown axis is SEVERITY — a deeper drop fires through the mute', () => {
  const st = {
    r: 7, pendingFrom: null, warned: false,
    sigTimes: { 'drop:5': T0 - HOUR },        // 5 muted
    hist: [7, 7, 7, 7, 7, 7],
  };
  const { fired } = run([
    { receivers: 7, sessions: 12 },
    { receivers: 2, sessions: 12 },  // arm at 2 — strictly worse than the muted 5
    { receivers: 2, sessions: 12 },
  ], st);
  assert.equal(fired.length, 1, 'escalation is never muted');
});

test('#690 an IMPROVED destination stays silent even though its key is new', () => {
  const st = {
    r: 7, pendingFrom: null, warned: false,
    sigTimes: { 'drop:2': T0 - HOUR },        // 2 muted; 5 is better than 2
    hist: [7, 7, 7, 7, 7, 7],
  };
  const { fired } = run([
    { receivers: 7, sessions: 12 },
    { receivers: 5, sessions: 12 },
    { receivers: 5, sessions: 12 },
  ], st);
  assert.deepEqual(fired, [], 'a strictly better state must not re-alarm');
});

test('#668 settle-vs-drop: falling back to a level held for most of history is silent', () => {
  const st = {
    r: 7, pendingFrom: null, warned: false, sigTimes: {},
    hist: [5, 5, 5, 5, 5, 7],                 // 5 is the real baseline; 7 was a spike
  };
  const { fired } = run([
    { receivers: 5, sessions: 12 },           // the spike receding, not seats lost
    { receivers: 5, sessions: 12 },
  ], st);
  assert.deepEqual(fired, [], 'a return to a long-held level is a settle');
});

test('#668 only healthy readings enter the held-level memory', () => {
  const { state } = run([
    { receivers: 7, sessions: 12 },
    { receivers: 4, sessions: 12 },  // armed — must NOT be recorded as a baseline
  ]);
  assert.ok(!state.hist.includes(4), 'a fault plateau is not a baseline');
});

test('floor path fires on total collapse and is severity-keyed', () => {
  const { fired } = run([
    { receivers: 7, sessions: 12 },
    { receivers: 1, sessions: 12 },
    { receivers: 1, sessions: 12 },
  ]);
  assert.ok(fired.some((w) => /only 1 of 12 live sessions/.test(w)), 'floor must fire below 3');
});

test('#690 migration: pair-keyed cooldown entries are converted, not dropped', () => {
  const st = {
    r: 7, pendingFrom: null, warned: false,
    sigTimes: { '7->4': T0 - HOUR },          // legacy key from before #690
    hist: [7, 7, 7, 7, 7, 7],
  };
  const { fired, state } = run([
    { receivers: 7, sessions: 12 },
    { receivers: 4, sessions: 12 },
    { receivers: 4, sessions: 12 },
  ], st);
  assert.ok(!('7->4' in state.sigTimes), 'legacy key migrated');
  assert.deepEqual(fired, [], 'migrated mute still suppresses — no re-fire storm on deploy');
});

test('expired cooldown entries are evicted', () => {
  const st = {
    r: 7, pendingFrom: null, warned: false,
    sigTimes: { 'drop:4': T0 - 7 * HOUR },    // older than the 6h window
    hist: [7, 7, 7, 7, 7, 7],
  };
  const { fired } = run([
    { receivers: 7, sessions: 12 },
    { receivers: 4, sessions: 12 },
    { receivers: 4, sessions: 12 },
  ], st);
  assert.equal(fired.length, 1, 'an expired mute must not suppress');
});

// ─────────────────────────────────────────────────────────────────────────────
// ANTI-VACUITY — if decide() never warns at all, every test above passes for
// the wrong reason. This asserts the harness can observe a warning.
// ─────────────────────────────────────────────────────────────────────────────

test('anti-vacuity: the harness CAN see a warning', () => {
  const { fired } = run([
    { receivers: 7, sessions: 12 },
    { receivers: 4, sessions: 12 },
    { receivers: 4, sessions: 12 },
  ]);
  assert.equal(fired.length, 1, 'if this fails, every suppression test above is vacuous');
});

// ── #1229 — THE FLOOR ALARM POSTS ONCE PER STATE CHANGE, NOT ONCE PER COOLDOWN.
// Measured on #1168: 58 identical floor posts in fifteen days, one every ~6 h
// as the cooldown expired; the two real deafness incidents inside that band
// each produced one more identical post nobody could read. A replay of that
// shape (below the floor for five days, tick every 5 min) must post ONCE on
// entry and ONCE on recovery, and still post on a deeper collapse or a fresh
// one — the negative control that keeps this from becoming silence.
test('#1229 five days below the floor → ONE entry post; recovery → ONE post; a deeper collapse and a fresh collapse still post; a flap inside the cooldown does not', () => {
  const MIN = 60_000; const HOUR = 3600_000;
  let state = { r: 7, s: 12, pendingFrom: null, warned: false, sigTimes: {}, hist: [7, 7, 7, 7, 7, 7] };
  const posts = [];
  const tick = (t, receivers, sessions = 8) => {
    const out = decide({ ...base, now: t, receivers, sessions, state });
    state = out.state; if (out.warnBody) posts.push({ t, body: out.warnBody });
  };
  // 5 days below the floor at 2 of 8, one tick every 5 minutes: 1,440 ticks.
  let t = T0;
  for (let i = 0; i < 1440; i++) { tick(t, 2); t += 5 * MIN; }
  const entry = posts.filter((p) => /only 2 of 8/.test(p.body));
  assert.equal(entry.length, 1, `entry posts once, not ${entry.length} times (the 08-21→09-05 shape was 58)`);
  assert.equal(state.belowFloor, true, 'the state file says it is still below, for anyone who asks');
  // A deeper collapse while below is a NEW fact and posts.
  tick(t, 1); t += 5 * MIN;
  assert.ok(/only 1 of 8/.test(posts.at(-1).body), 'deeper collapse posts');
  for (let i = 0; i < 100; i++) { tick(t, 1); t += 5 * MIN; }
  assert.equal(posts.filter((p) => /only 1 of 8/.test(p.body)).length, 1, 'and only once');
  // Recovery posts once, naming the duration, and clears the floor state.
  tick(t, 5); t += 5 * MIN;
  assert.match(posts.at(-1).body, /back above the floor — 5 of 8 .* it was below for \d+ min/);
  assert.equal(state.belowFloor, false);
  const n = posts.length;
  for (let i = 0; i < 50; i++) { tick(t, 5); t += 5 * MIN; }
  assert.equal(posts.length, n, 'above the floor, silence');
  // A FRESH collapse after the cooldown has passed posts again (the negative control).
  t += 7 * HOUR;
  tick(t, 2); t += 5 * MIN;
  assert.ok(/only 2 of 8/.test(posts.at(-1).body), 'a new collapse after recovery + cooldown posts');
  // Flap: recover and re-collapse at the SAME depth inside the cooldown → silent both ways.
  tick(t, 5); t += 5 * MIN;   // recovery post (announced entry)
  const m = posts.length;
  tick(t, 2); t += 5 * MIN;   // re-entry 5 min later, same depth → flap, silent
  assert.equal(posts.length, m, 'a same-depth re-entry inside the cooldown is a flap, not a post');
  tick(t, 5); t += 5 * MIN;   // recovery from a suppressed entry → also silent
  assert.equal(posts.length, m, 'recovery from a flap-suppressed entry is silent too');
});

// ── #1229 SENT BACK (grader, 2026-11-11T12:04Z): two live silences on
// 11-08/09. The flap guard measured from the last ENTRY and used the 6 h
// cooldown, so a collapse 3.5 h after a recovery that HELD was called a flap;
// and the recovery check asked only whether the ENTRY posted, so a band the
// room heard about through a DEEPER post never heard it end. The suite above
// separated its fresh collapse by 7 h, past the cooldown, which is why it
// stayed green. These rows replay the live shape at 5-minute ticks.
function floorRun() {
  let state = { r: 4, s: 8, pendingFrom: null, warned: false, sigTimes: {}, hist: [4, 4, 4, 4, 4, 4] };
  const posts = [];
  const tick = (t, receivers, sessions = 8, extra = {}) => {
    const out = decide({ ...base, now: t, receivers, sessions, state, ...extra });
    state = out.state; if (out.warnBody) posts.push({ t, body: out.warnBody });
  };
  return { posts, tick, get state() { return state; } };
}
const FMIN = 60_000;
const floorPosts = (posts) => posts.filter((p) => /fanout watch: (only \d+ of|back above the floor)/.test(p.body));

test('#1229 sent back: a collapse 3.5 h after a HELD recovery posts, and its recovery posts (live 11-08 13:35Z → 11-09 12:02Z)', () => {
  const r = floorRun(); let t = T0;
  r.tick(t, 0); t += 5 * FMIN;                                    // 13:35 entry at 0 → posts
  r.tick(t, 4); t += 5 * FMIN;                                    // 13:40 recovery → posts
  for (let i = 0; i < 42; i++) { r.tick(t, 4); t += 5 * FMIN; }   // holds 3.5 h above
  const before = floorPosts(r.posts).length;
  assert.equal(before, 2, 'entry and recovery both posted');
  r.tick(t, 2); t += 5 * FMIN;                                    // 17:18 new collapse to 2
  assert.equal(floorPosts(r.posts).length, 3, 'a collapse after a recovery that HELD is news, not a flap');
  assert.match(r.posts.at(-1).body, /only 2 of 8/);
  for (let i = 0; i < 70; i++) { r.tick(t, 2); t += 5 * FMIN; }   // holds below
  r.tick(t, 1); t += 5 * FMIN;                                    // 23:48 deeper → posts
  assert.match(r.posts.at(-1).body, /only 1 of 8/);
  for (let i = 0; i < 100; i++) { r.tick(t, 1); t += 5 * FMIN; }
  r.tick(t, 4); t += 5 * FMIN;                                    // 11-09 12:02 recovery
  assert.match(r.posts.at(-1).body, /back above the floor — 4 of 8/, 'the room that heard the collapse hears it end');
});

test('#1229 sent back: a band announced ONLY by a deeper post still posts its recovery', () => {
  const r = floorRun(); let t = T0;
  r.tick(t, 2); t += 5 * FMIN;                                    // entry → posts
  r.tick(t, 4); t += 5 * FMIN;                                    // recovery → posts
  r.tick(t, 2); t += 5 * FMIN;                                    // re-entry 5 min later → flap, silent
  const n = floorPosts(r.posts).length;
  assert.equal(n, 2, 'the quick re-entry is a flap');
  r.tick(t, 1); t += 5 * FMIN;                                    // deeper while below → posts
  assert.match(r.posts.at(-1).body, /only 1 of 8/);
  r.tick(t, 4); t += 5 * FMIN;                                    // recovery → must post
  assert.match(r.posts.at(-1).body, /back above the floor — 4 of 8/);
});

test('#1229 sent back: a flap-suppressed dip that HOLDS past the flap window posts once, then its recovery posts', () => {
  const r = floorRun(); let t = T0;
  r.tick(t, 2); t += 5 * FMIN;
  r.tick(t, 4); t += 5 * FMIN;
  r.tick(t, 2); t += 5 * FMIN;                                    // flap, silent
  for (let i = 0; i < 4; i++) { r.tick(t, 2); t += 5 * FMIN; }    // 25 min below: still a flap
  assert.equal(floorPosts(r.posts).length, 2, 'inside the flap window, silent');
  for (let i = 0; i < 30; i++) { r.tick(t, 2); t += 5 * FMIN; }   // holds 2.5 h more
  const held = r.posts.filter((p) => /only 2 of 8/.test(p.body));
  assert.equal(held.length, 2, 'the held dip posts ONCE (2 = the original entry + this one)');
  r.tick(t, 4); t += 5 * FMIN;
  assert.match(r.posts.at(-1).body, /back above the floor — 4 of 8/);
});

test('#1229 sent back: an announced-maintenance dip that holds stays silent (the #1273 suppression is not undone by the hold rule)', () => {
  const r = floorRun(); let t = T0;
  const maintenance = { by: 'seat-a', at: t };
  for (let i = 0; i < 24; i++) { r.tick(t, 1, 8, { maintenance }); t += 5 * FMIN; }   // 2 h below under maintenance
  assert.equal(floorPosts(r.posts).length, 0, 'announced maintenance: no entry, no hold post');
  r.tick(t, 4); t += 5 * FMIN;
  assert.equal(floorPosts(r.posts).length, 0, 'and no recovery post for a band nobody was told about');
});
