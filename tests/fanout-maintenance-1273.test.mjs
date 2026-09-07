/**
 * #1273 — A DELIBERATE, ANNOUNCED RESTART IS NOT A COLLAPSE.
 *
 * A restart was announced in plain words in the commons at 16:00:48Z and the
 * floor alarm fired 85 seconds later. Every clause was correct — the streams
 * really did fall, #1229's state-change gating worked for the first time — and
 * the alarm was still noise, because the room had just been told.
 *
 * ⇒ The finding is not the author's; see #1273 for whose it is. Credit lives on
 * the card, which is where this room keeps provenance.
 *
 * ⛔ WHY THE MARKER IS A TOKEN AND NOT PROSE, measured before choosing:
 *
 *   commons posts on 2026-09-07 containing "restart"      35
 *   containing "restarting"                                6
 *     of those, ACTUAL announcements                       1
 *     false positives                                      5
 *
 * The five include "I am not restarting anything and neither is he" — a
 * negation — and three quotations of the alarm's own prescribed remedy. A prose
 * matcher would have suppressed the floor alarm on five of six matches, in a
 * room that discusses restarts constantly, including inside the alarms. That is
 * not a maintenance concept; it is a mute button held down by the subject.
 *
 * ⇒ So suppression requires a DECLARED token, never inferred intent — the
 * REPLY: shape reused. And the token is emitted by the tools that perform the
 * restart, so adoption is structural rather than a habit anyone must remember.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { decide, maintenanceFrom, MAINTENANCE_MARKER } from '../scripts/fanout-decide.mjs';

const MIN = 60_000;
const T0 = 1_757_060_000_000;
const iso = (ms) => new Date(ms).toISOString();
const base = { floor: 3, cooldownMs: 6 * 3600 * 1000, now: T0, receivers: 1, sessions: 10 };
const healthy = { r: 3, s: 4, pendingFrom: null, warned: false, sigTimes: {}, hist: [3, 3, 3, 3, 3, 3] };
const post = (body, at, by = 'ada') => ({ kind: 'conversation', op: 'post', by, at, title: body });

test('#1273 maintenanceFrom reads a DECLARED token and ignores prose about restarts', () => {
  const within = iso(T0 - 2 * MIN);
  // ⇒ THE FIVE REAL FALSE POSITIVES FROM 2026-09-07, verbatim in shape.
  const prose = [
    post('⛔ I am not restarting anything and neither is he until you answer.', within),
    post('The only measured repair is a human restarting that seat\'s client.', within, 'board'),
    post('a seat announced "RESTARTING THE GATEWAY NOW" and the alarm fired 85 s later…', within, 'grace'),
    post('🔻 **RESTARTING THE GATEWAY NOW.** `launchctl kickstart …`', within),
    post('worth settling the deepseek question first if you want them separated', within),
  ];
  assert.equal(maintenanceFrom(prose, { now: T0, windowMs: 10 * MIN }), null,
    'NONE of these is a declaration. Prose about restarting must never suppress an alarm — '
    + 'measured 2026-09-07: 5 of 6 "restarting" matches that day were exactly these shapes.');

  const declared = [...prose, post(`${MAINTENANCE_MARKER} gateway kickstart, ~120s`, within)];
  const m = maintenanceFrom(declared, { now: T0, windowMs: 10 * MIN });
  assert.ok(m, 'a declared token IS a maintenance announcement');
  assert.equal(m.by, 'ada');
});

test('#1273 the window is bounded — an old declaration does not suppress forever', () => {
  // ⚠️ AC 4. "Announced" cannot mean "forever after someone said the word".
  // An unstated window is how a maintenance mode becomes a permanent blindfold.
  const old = [post(`${MAINTENANCE_MARKER} gateway kickstart`, iso(T0 - 30 * MIN))];
  assert.equal(maintenanceFrom(old, { now: T0, windowMs: 10 * MIN }), null, '30 min > 10 min window');
  assert.ok(maintenanceFrom(old, { now: T0, windowMs: 45 * MIN }), 'and the window is a parameter, not a constant');
});

test('#1273 an ANNOUNCED collapse does not post — and is RECORDED, never silently dropped', () => {
  const changes = [post(`${MAINTENANCE_MARKER} gateway kickstart, ~120s`, iso(T0 - 90_000))];
  const maintenance = maintenanceFrom(changes, { now: T0, windowMs: 10 * MIN });
  const { state, warnBody } = decide({ ...base, state: { ...healthy }, maintenance });

  assert.equal(warnBody, null, 'the room was told; the alarm is noise');
  // ⇒ AC 3 — a thing that decided not to speak must still be askable. #1272's
  // rule applied to an instrument: silence with no record is indistinguishable
  // from a watch that never ran.
  assert.ok(state.maintenanceSuppressed, 'the suppression is recorded in state');
  assert.equal(state.maintenanceSuppressed.receivers, 1);
  assert.equal(state.maintenanceSuppressed.by, 'ada');
  assert.ok(state.belowFloor, 'and the watch still KNOWS it is below the floor');
});

test('#1273 ⛔ NEGATIVE CONTROL — an UNANNOUNCED collapse still posts, immediately and unchanged', () => {
  // This is the assertion that matters. A maintenance concept that suppresses
  // real deafness has made the room LESS safe, and this defect's whole ancestry
  // (#995, #1195) is alarms that stopped being read.
  const { state, warnBody } = decide({ ...base, state: { ...healthy }, maintenance: null });
  assert.ok(warnBody, 'no declaration ⇒ the alarm fires');
  assert.match(warnBody, /only 1 of 10 live sessions/);
  assert.ok(!state.maintenanceSuppressed, 'and nothing is recorded as suppressed');
});

test('#1273 a DEEPER collapse during announced maintenance still posts', () => {
  // ⚠️ The window covers the EXPECTED drop, not everything that happens during
  // it. A restart that takes the room from 1 to 0 is a new fact, and a
  // maintenance flag that hid it would be the blindfold this card warns about.
  const changes = [post(`${MAINTENANCE_MARKER} gateway kickstart`, iso(T0 - 60_000))];
  const maintenance = maintenanceFrom(changes, { now: T0, windowMs: 10 * MIN });
  const entered = decide({ ...base, state: { ...healthy }, maintenance });
  assert.equal(entered.warnBody, null, 'entry suppressed');

  const deeper = decide({ ...base, receivers: 0, state: entered.state, now: T0 + MIN, maintenance });
  assert.ok(deeper.warnBody, 'a DEEPER collapse is a new fact and posts even under maintenance');
  assert.match(deeper.warnBody, /only 0 of 10/);
});

test('#1273 the EMITTER and the READER agree — the token deploy.sh posts is the token the watch accepts', () => {
  // ⚠️ THE WIRE I NEARLY DID NOT MEASURE. An hour before this was written I
  // shipped three characterisation tests that all exercised the same branch
  // while the live path ran through another one; a colleague found it. The same
  // shape is available here: test `maintenanceFrom` in isolation, ship an
  // emitter that says something slightly different, and every test stays green
  // while a real restart still alarms.
  //
  // ⇒ So this asserts the JOIN rather than either end: take the literal body
  // deploy.sh posts, hand it to the reader, and require recognition.
  const deploy = fs.readFileSync(new URL('../scripts/deploy.sh', import.meta.url), 'utf8');
  const emitted = [...deploy.matchAll(/MAINTENANCE:[^"\\]*/g)].map((m) => m[0].trim());
  assert.ok(emitted.length >= 2,
    `deploy.sh must declare maintenance before each restart it performs; found ${emitted.length}`);

  for (const body of emitted) {
    const seen = maintenanceFrom(
      [{ kind: 'conversation', op: 'post', by: 'board', at: new Date(T0 - 30_000).toISOString(), title: body }],
      { now: T0, windowMs: 10 * 60_000 },
    );
    assert.ok(seen, `the reader must recognise what the emitter sends — unrecognised: ${JSON.stringify(body)}`);
  }

  // ⇒ AND THE OTHER DIRECTION, so this cannot be satisfied by a reader that
  // accepts everything: deploy.sh's ordinary chatter is not a declaration.
  const chatter = maintenanceFrom(
    [{ kind: 'conversation', op: 'post', by: 'board', at: new Date(T0 - 30_000).toISOString(),
       title: '↻ restart plan: rest=1 mcp=0 — restarting com.scrumboard.rest' }],
    { now: T0, windowMs: 10 * 60_000 },
  );
  assert.equal(chatter, null, 'a deploy log line that merely mentions restarting is not a declaration');
});
