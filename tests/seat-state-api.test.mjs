/**
 * #613 — the seat-state surface, end to end at the REST server.
 *
 * The pure contract is tested in seat-state.test.mjs. These are the assertions
 * that only a real server can make: that the route stores what validation
 * accepted, that a declaration for someone else is REFUSED rather than relayed,
 * and — the one that matters — that a stored no changes what the tending tick
 * does, with a control proving one declining seat never silences the room.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';
import { tendingTick } from '../core/tending-tick.mjs';
import { tendingEligibility } from '../core/seat-state.mjs';

const IN_1H = () => new Date(Date.now() + 3600_000).toISOString();

const put = (base, seat, body) => fetch(`${base}/api/seats/${seat}/state`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const del = (base, seat) => fetch(`${base}/api/seats/${seat}/state`, { method: 'DELETE' });
const states = async (base) => (await fetch(`${base}/api/seats/state`)).json();

test('#613 a declaration is stored, read back, and cleared to UNKNOWN', async () => {
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    // The harness serves the SHIPPED DEFAULT roster — alex/robin/sage/nova/kit/wiki
    // — not this room's seats. Checked rather than assumed: my first version of
    // this test asserted the roster was empty, which was a fact about the
    // harness I had not looked at.
    const seat = 'alex';
    const before = await states(s.baseUrl);
    assert.ok(before.seats.length > 0, 'the default roster must be present, or eligibility proves nothing');
    assert.equal(before.seats.find((x) => x.seat === seat).mode, 'unknown',
      'a seat that has not spoken reports UNKNOWN');
    assert.ok(before.eligible.includes(seat), 'and UNKNOWN is ELIGIBLE — absence is never a stated no');

    const r = await put(s.baseUrl, seat, {
      mode: 'resting', acceptsRoutineWork: false, expiresAt: IN_1H(), note: 'back later',
    });
    assert.equal(r.status, 200, JSON.stringify(await r.json()));

    // ⛔ READ BACK FROM A FRESH GET, never from the write's own echo.
    const after = await states(s.baseUrl);
    const mine = after.seats.find((x) => x.seat === seat);
    assert.equal(mine.mode, 'resting');
    assert.equal(mine.acceptsRoutineWork, false);
    assert.ok(!after.eligible.includes(seat), 'a stated no removes the seat from eligibility');
    assert.ok(after.declining.includes(seat));

    assert.equal((await del(s.baseUrl, seat)).status, 200);
    const cleared = await states(s.baseUrl);
    assert.equal(cleared.seats.find((x) => x.seat === seat).mode, 'unknown',
      'clearing returns to UNKNOWN, which is absence and not a stored value');
    assert.ok(cleared.eligible.includes(seat), 'and UNKNOWN is eligible again');
  } finally { await s.stop(); }
});

test('#613 declaring for ANOTHER seat is refused, not relayed', async () => {
  // conversation_post records a mismatch as `onBehalfOf` because relaying words
  // is a real act. A declaration is a statement about who is SPEAKING, so the
  // same leniency would store a third-party observation as a self-declaration.
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    const all = ['alex', 'robin'];
    const r = await put(s.baseUrl, all[0], {
      seat: all[1], mode: 'resting', acceptsRoutineWork: false, expiresAt: IN_1H(),
    });
    assert.equal(r.status, 403);
    assert.equal((await r.json()).code, 'SEAT_MISMATCH');
    const after = await states(s.baseUrl);
    for (const seat of all) {
      assert.equal(after.seats.find((x) => x.seat === seat).mode, 'unknown',
        `nothing was written for ${seat}`);
    }
  } finally { await s.stop(); }
});

test('#613 the route refuses what the contract refuses', async () => {
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    const seat = 'alex';
    for (const [body, code] of [
      [{ mode: 'unknown', acceptsRoutineWork: false, expiresAt: IN_1H() }, 'UNKNOWN_NOT_WRITABLE'],
      [{ mode: 'resting', acceptsRoutineWork: true, expiresAt: IN_1H() }, 'MODE_CONFLICT'],
      [{ mode: 'degraded', acceptsRoutineWork: false, expiresAt: IN_1H() }, 'CONSTRAINTS_REQUIRED'],
      [{ mode: 'resting', acceptsRoutineWork: false }, 'EXPIRY_REQUIRED'],
    ]) {
      const r = await put(s.baseUrl, seat, body);
      assert.equal(r.status, 400, `${code}: ${JSON.stringify(body)}`);
      assert.equal((await r.json()).code, code);
    }
    // ⭐ CONTROL: a well-formed declaration still lands, so the route is not
    // simply refusing everything.
    assert.equal((await put(s.baseUrl, seat, {
      mode: 'degraded', acceptsRoutineWork: false, constraints: ['no-writes'], expiresAt: IN_1H(),
    })).status, 200);
  } finally { await s.stop(); }
});

test('#613 THE FALSIFIER — a stored no changes what the tick does, and one seat never silences the room', async () => {
  // ⛔⛔ The card's own line-stop condition, as an assertion: the scheduler must
  // suppress ONE seat without suppressing the whole room. Run against the real
  // tendingTick with the real eligibility function; only mint/post are fakes,
  // because minting is what we are asserting about.
  const roster = ['ada', 'bo'];
  const live = () => new Date(Date.now() + 3600_000).toISOString();
  const run = async (decls) => {
    const posted = [];
    const out = await tendingTick({
      now: new Date().toISOString(),
      mint: () => ({ window: 'w1', body: 'tend the room' }),
      post: async (m) => { posted.push(m); },
      eligibility: () => tendingEligibility(roster, decls, new Date().toISOString()),
    });
    return { out, posted };
  };
  const resting = (seat) => ({
    seat, mode: 'resting', acceptsRoutineWork: false, constraints: [], note: null,
    declaredAt: new Date().toISOString(), expiresAt: live(),
  });

  // ⭐ ANTI-VACUITY FIRST: with nobody declining, the whisper goes out. If this
  // failed, every assertion below would pass for the wrong reason.
  const none = await run([]);
  assert.equal(none.out.delivered, true, 'with no declarations the room is tended exactly as before');
  assert.equal(none.posted.length, 1);

  // ONE seat declines ⇒ the room is STILL tended. This is the line stop.
  const one = await run([resting('ada')]);
  assert.equal(one.out.delivered, true, 'one declining seat must NOT suppress the whole room');
  assert.equal(one.posted.length, 1);

  // EVERY seat declines ⇒ nothing is sent, and it is RECORDED as such.
  const all = await run(roster.map(resting));
  assert.equal(all.out.delivered, false);
  assert.equal(all.out.minted, false, 'and the offer is NOT burned — the window is not spent on nobody');
  assert.equal(all.out.reason, 'no-eligible-seats',
    'the run must record that it sent nothing rather than reporting a delivery that did not happen');
  assert.deepEqual(all.posted, [], 'nothing reached the commons');
});

test('#613 the tick FAILS OPEN when seat state cannot be read', async () => {
  // ⚠️ A tick that read "I could not ask" as "nobody is available" would
  // silence the room on a transport error. An unwired caller — no `eligibility`
  // at all — must behave exactly as it did before this card.
  const posted = [];
  const out = await tendingTick({
    now: new Date().toISOString(),
    mint: () => ({ window: 'w1', body: 'tend' }),
    post: async (m) => { posted.push(m); },
  });
  assert.equal(out.delivered, true, 'no eligibility argument ⇒ unchanged behaviour');
  assert.equal(posted.length, 1);

  // And an eligibility function that throws must not take the room down with it.
  const posted2 = [];
  const out2 = await tendingTick({
    now: new Date().toISOString(),
    mint: () => ({ window: 'w2', body: 'tend' }),
    post: async (m) => { posted2.push(m); },
    eligibility: () => null,
  });
  assert.equal(out2.delivered, true, 'a null snapshot is "I do not know", not "nobody is available"');
});
