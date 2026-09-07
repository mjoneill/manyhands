/**
 * #953 slice 1 — THE SILENCE GATE. A tending whisper waits for a genuinely
 * quiet room instead of firing on a clock edge.
 *
 * ⛔ THE DEFECT, reported by the person who specified the behaviour.
 * @michael, 2026-08-20T11:04Z:
 *
 *   "it seems to fire even when the board is active and messages are flowing
 *    through. Ideally it was supposed to fire every X minutes (60 is the
 *    default) AND ONLY IF there hasn't been a comment on the board within the
 *    last Y minutes (default was 20). I don't think it does this though. it
 *    looks like it just emits regardless."
 *
 * ⇒ He was right, and there was no gate to be broken: the live code is #802's
 * clock window. `tending-tick.mjs` took NO room-state input at all, so there
 * was no parameter a policy could change.
 *
 * Instances, all landing within ~21s of the top of an hour — the signature of
 * a clock rather than a stale timestamp:
 *
 *   11:00:02Z post · 11:00:21Z WHISPER · 11:00:34Z post      19s of quiet
 *   11:58:35Z post · 12:00:21Z WHISPER · 12:00:27Z post     106s of quiet
 *   22:00:22Z WHISPER, into a live three-way conversation, SECONDS after
 *             @michael asked in that same room why it still did this
 *
 * The stated gate is 20 MINUTES. The observed quiet was 19 seconds.
 *
 * ── THE ACTIVITY POLICY (acceptance 6) — DECIDED, not chosen by the builder ──
 * @michael, 2026-08-20T22:4xZ, verbatim: "agree. proceed" — on the
 * recommendation that HUMAN and AGENT/SEAT comments COUNT as activity, while
 * TENDING POSTS and BOARD/SYSTEM notices DO NOT.
 *
 * ⭐⭐⭐ The second half is the load-bearing one. THE WHISPER'S OWN POST IS A
 * MESSAGE. If it counted, the timer would re-arm forever and silence-reset
 * would degenerate into the fixed hourly clock this card exists to replace —
 * while passing a casual demo. The Value Steward named this as the semantic
 * choice a builder must not make invisibly, so it is written here and tested.
 *
 * ⚠️ SCOPE: this file is the GATE ONLY. The Settings surface (@michael changing
 * `quietAfterMinutes` himself) and persistence across restart are acceptance
 * 1 and 5, and the card is NOT done without them — the steward disqualifier is
 * explicit that a control he cannot reach fails. Recorded so this slice is not
 * mistaken for the whole card.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tendingTick } from '../core/tending-tick.mjs';

const AT = (iso) => new Date(iso).toISOString();
const prompt = { window: '2026-08-20T14:00:00.000Z', body: 'quietly, hello' };

/** A tick harness whose room-state is entirely injectable, like the rest. */
function harness({ now, lastActivityAt = null, quietAfterMinutes }) {
  const posted = [];
  return {
    posted,
    run: () => tendingTick({
      now: AT(now),
      quietAfterMinutes,
      lastActivityAt: () => (lastActivityAt == null ? null : AT(lastActivityAt)),
      mint: () => prompt,
      post: async (b) => { posted.push(b); },
    }),
  };
}

/**
 * ⭐⭐⭐ CRITERION 1 — THE CONTROL, AND IT RUNS FIRST.
 *
 * This card's subject is a condition that SUPPRESSES output, so the cheapest
 * way to pass every other test here is to break the emitter entirely. Without
 * this, "no whisper appeared" is indistinguishable from "the whisper is dead".
 */
test('#953 CONTROL: after real quiet, the whisper STILL EMITS', async () => {
  const h = harness({
    now: '2026-08-20T14:00:00.000Z',
    lastActivityAt: '2026-08-20T13:30:00.000Z', // 30 minutes ago
    quietAfterMinutes: 20,
  });
  const r = await h.run();
  assert.equal(r.delivered, true, `a quiet room must still be tended: ${JSON.stringify(r)}`);
  assert.equal(h.posted.length, 1);
  assert.match(h.posted[0].body, /quietly, hello/);
});

test('#953 a room active INSIDE the window is not tended', async () => {
  const h = harness({
    now: '2026-08-20T14:00:00.000Z',
    lastActivityAt: '2026-08-20T13:59:41.000Z', // 19 SECONDS ago — the live instance
    quietAfterMinutes: 20,
  });
  const r = await h.run();
  assert.equal(r.delivered, false,
    'the whisper fired 19 seconds after a post — this is the exact reported defect');
  assert.equal(r.minted, false, 'and it must not burn the offer either');
  assert.equal(h.posted.length, 0);
  assert.match(r.reason, /active|quiet/i, `the reason must NAME why: ${JSON.stringify(r)}`);
});

/**
 * ⭐ ACCEPTANCE 4 — INDEPENDENT OF WALL-CLOCK BOUNDARIES, and this is the test
 * that can actually fail.
 *
 * A correct silence-reset implementation and the current clock window are
 * INDISTINGUISHABLE at an hour boundary — and every emission on this card's
 * record landed within ~21 seconds of one. So the expiry here is deliberately
 * arranged mid-hour: 14:37, which no clock window would choose.
 */
test('#953 quiet expiring MID-HOUR emits — the gate is not a clock', async () => {
  const h = harness({
    now: '2026-08-20T14:37:00.000Z',
    lastActivityAt: '2026-08-20T14:16:00.000Z', // 21 minutes ago, nowhere near a boundary
    quietAfterMinutes: 20,
  });
  assert.equal((await h.run()).delivered, true,
    'a whisper that only ever fires near the top of an hour is still the clock window');
});

/**
 * ⛔⛔ ACCEPTANCE 6, THE HALF THAT MATTERS. The whisper's own post is a message.
 * If it counts as activity it resets its own timer forever.
 */
test('#953 the whisper\'s OWN post does not count as activity', async () => {
  // The activity source is asked for qualifying activity only. A caller that
  // hands back its own board post is the degenerate case, so the gate is given
  // a source that has correctly excluded it: null means "no qualifying
  // activity", even though a tending post exists.
  const h = harness({
    now: '2026-08-20T14:00:00.000Z',
    lastActivityAt: null,
    quietAfterMinutes: 20,
  });
  assert.equal((await h.run()).delivered, true,
    'with no QUALIFYING activity the room is quiet, however many board posts exist — otherwise '
    + 'silence-reset re-arms on its own output and degenerates into the hourly clock');
});

test('#953 the threshold is CONFIGURABLE, not a second hardcoded constant', async () => {
  const at = '2026-08-20T14:00:00.000Z';
  const fiveAgo = '2026-08-20T13:55:00.000Z';

  assert.equal((await harness({ now: at, lastActivityAt: fiveAgo, quietAfterMinutes: 20 }).run()).delivered,
    false, '5 minutes of quiet under a 20-minute threshold must NOT emit');
  assert.equal((await harness({ now: at, lastActivityAt: fiveAgo, quietAfterMinutes: 2 }).run()).delivered,
    true, 'the same room under a 2-minute threshold MUST emit — or the value is decorative');
});

/**
 * ⚠️ BACKWARD COMPATIBILITY. Every existing caller and test constructs a tick
 * with no room-state at all. A gate that treats "I was told nothing" as "the
 * room is busy" silences tending everywhere it has not yet been wired — which
 * is the emitter-breaking failure criterion 1 exists to catch, arriving
 * through the default instead of through a bug.
 */
test('#953 with NO activity source supplied, behaviour is unchanged', async () => {
  const posted = [];
  const r = await tendingTick({
    now: AT('2026-08-20T14:00:00.000Z'),
    mint: () => prompt,
    post: async (b) => { posted.push(b); },
  });
  assert.equal(r.delivered, true,
    'an un-wired caller must keep emitting; a gate that fails CLOSED silences the feature');
  assert.equal(posted.length, 1);
});

// ────────────────────────────────────────────────────────────────────────────
// #953 — WIRED BUT BLIND. The gate fails OPEN when it was never wired, which is
// deliberate and protected by the test directly above. This block is the OTHER
// unknown: a gate that IS configured, IS handed a reader, asks it, and gets
// nothing back.
//
// ⛔ Today those two are the same line. `if (last)` treats "nobody told me"
// and "I asked and could not find out" identically, so a configured gate that
// cannot read the room fires exactly like a board that has no gate at all.
//
// ⚠️ THE SPECIMEN IS REAL: during the 2026-09-06 outage the board was
// unreachable for ~18 minutes and a whisper fired inside a busy hour. From
// outside, that firing is indistinguishable from a correctly-timed one — which
// is #717/#718's shape (a stopped thing and a quiet thing look the same),
// arriving in the instrument built to measure quiet.
//
// ⭐ FAIL-OPEN IS NOT THE SAME AS FAIL-INVISIBLE. Unwired keeps firing; blind
// SUPPRESSES and SAYS SO, so the difference is queryable rather than silent.
// ────────────────────────────────────────────────────────────────────────────

test('#953 ⛔ null is NOT blindness — "I looked and nothing qualifies" is a QUIET room and must be tended', async () => {
  const posted = [];
  const r = await tendingTick({
    now: AT('2026-08-20T14:00:00.000Z'),
    quietAfterMinutes: 60,
    lastActivityAt: () => null,          // the classifier found no QUALIFYING activity
    mint: () => prompt,
    post: async (b) => { posted.push(b); },
  });
  // ⚠️ Written after breaking it: the first cut of this fix read null as blind
  // and silenced exactly the case the whole feature exists for.
  assert.equal(r.delivered, true, 'no qualifying activity IS quiet — this is the feature, not the failure');
  assert.equal(posted.length, 1);
});

test('#953 WIRED BUT BLIND: an unparseable timestamp is blindness, not quiet', async () => {
  const r = await tendingTick({
    now: AT('2026-08-20T14:00:00.000Z'),
    quietAfterMinutes: 60,
    lastActivityAt: () => 'not-a-date',
    mint: () => prompt,
    post: async () => {},
  });
  assert.equal(r.delivered, false);
  assert.match(String(r.reason), /activity-unknown/);
});

test('#953 WIRED BUT BLIND: a reader that THROWS is blindness, not a crash and not quiet', async () => {
  const r = await tendingTick({
    now: AT('2026-08-20T14:00:00.000Z'),
    quietAfterMinutes: 60,
    lastActivityAt: () => { throw new Error('board unreachable'); },
    mint: () => prompt,
    post: async () => {},
  });
  assert.equal(r.delivered, false, 'an unreachable board must not fire the whisper');
  assert.match(String(r.reason), /activity-unknown/);
});

test('#953 ⛔ THE PROTECTION HOLDS: unwired still fires, and the two are DISTINGUISHABLE', async () => {
  const unwired = await tendingTick({
    now: AT('2026-08-20T14:00:00.000Z'), mint: () => prompt, post: async () => {},
  });
  const blind = await tendingTick({
    now: AT('2026-08-20T15:00:00.000Z'), quietAfterMinutes: 60,
    lastActivityAt: () => { throw new Error('board unreachable'); },
    mint: () => prompt, post: async () => {},
  });
  // ⛔ The whole point of splitting them: same "I have no timestamp", opposite
  // correct answers, and a reader can tell which happened.
  assert.equal(unwired.delivered, true, 'never wired ⇒ keep emitting (the comment protects this)');
  assert.equal(blind.delivered, false, 'wired but blind ⇒ suppress');
  assert.notEqual(String(unwired.reason), String(blind.reason), 'and they must not report the same thing');
});

// ────────────────────────────────────────────────────────────────────────────
// #953 — THE ACTIVITY CLASSIFIER. The steward's item 6, as a named function
// rather than a filter buried in a call site, because it is the semantic
// choice she said a builder must not make invisibly.
// ────────────────────────────────────────────────────────────────────────────

import { lastQualifyingActivity, NON_ACTIVITY_AUTHORS } from '../core/tending-tick.mjs';

const msg = (author, createdAt) => ({ author, createdAt, body: 'x' });

test('#953 human and agent comments COUNT as activity', () => {
  const at = '2026-08-20T14:00:00.000Z';
  for (const who of ['michael', 'wren', 'indigo', 'minimo']) {
    assert.equal(lastQualifyingActivity([msg(who, at)]), at,
      `${who}'s comment must count — humans and seats are both the room being awake`);
  }
});

test('#953 board and system posts DO NOT count', () => {
  assert.equal(lastQualifyingActivity([
    msg('board', '2026-08-20T14:00:00.000Z'),
    msg('system', '2026-08-20T14:05:00.000Z'),
  ]), null, 'a window containing only board/system notices is a QUIET room');
  assert.deepEqual([...NON_ACTIVITY_AUTHORS].sort(), ['board', 'system']);
});

/**
 * ⭐⭐⭐ THE ONE THAT MATTERS. A whisper is authored `board`. If it counted, it
 * would reset the timer governing the next whisper, forever.
 */
test('#953 a whisper does not re-arm its own timer', () => {
  const human = '2026-08-20T14:00:00.000Z';
  const whisperAfter = '2026-08-20T14:30:00.000Z';
  assert.equal(
    lastQualifyingActivity([msg('michael', human), msg('board', whisperAfter)]),
    human,
    'the later BOARD post must not become the activity timestamp — otherwise silence-reset '
    + 'degenerates into the fixed hourly clock this card exists to replace',
  );
});

test('#953 the LATEST qualifying message wins, whatever the order', () => {
  const late = '2026-08-20T14:20:00.000Z';
  assert.equal(lastQualifyingActivity([
    msg('wren', late), msg('indigo', '2026-08-20T14:01:00.000Z'), msg('board', '2026-08-20T14:59:00.000Z'),
  ]), late, 'unsorted input must still yield the newest qualifying post');
});

test('#953 malformed rows are skipped, not crashed on', () => {
  assert.equal(lastQualifyingActivity([null, {}, { author: 'wren' }, { createdAt: 'x' }]), null);
  assert.equal(lastQualifyingActivity(undefined), null);
});
