/**
 * #666 — the cooldown gate must be PER SIGNATURE, not last-signature-only.
 *
 * #666's finding: `lastSig` was a single string, so an intervening
 * signature (6→4) overwrote it and RELEASED the previous signature's (5→4)
 * gate — case 4 of the card's stub fired when it should still be muted. Both
 * signatures alternated in production the same morning, so the failure is
 * live, not theoretical. Direction is under-muting (noisier, never quieter).
 *
 * Fix under test: `sigTimes` — a map of signature → lastWarnAt, with TTL
 * eviction at the cooldown horizon (an expired entry is inert anyway).
 * Old-format state ({lastSig, lastWarnAt}) must migrate, not reset — a
 * deploy mid-incident must not re-fire a muted warning.
 *
 * The script is exercised whole (child process + stub status server +
 * DRYRUN), because the overnight lesson is that the stub harness, not
 * reasoning about branches, is what actually answers these questions.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'fanout-watch.mjs');

/** One watch tick: serve {receivers, sessions} once, run the script in DRYRUN, return stdout. */
async function tick(stateFile, receivers) {
  const srv = http.createServer((_, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ receivers, sessions: receivers + 3 }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const { stdout } = await run(process.execPath, [SCRIPT], {
      env: {
        ...process.env,
        SCRUM_STATUS_URL: `http://127.0.0.1:${srv.address().port}/channel/status`,
        SCRUM_FANOUT_STATE: stateFile,
        SCRUM_FANOUT_DRYRUN: '1',
      },
    });
    return stdout;
  } finally {
    await new Promise((r) => srv.close(r));
  }
}

const fired = (out) => /DRYRUN would post/.test(out);
const tmpState = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fanout-666-')), 'watch.state');

test('baseline behavior unchanged: two-tick drop fires once, repeat within cooldown is muted', async () => {
  const state = tmpState();
  assert.equal(fired(await tick(state, 7)), false, 'baseline tick');
  assert.equal(fired(await tick(state, 4)), false, 'first tick of drop only arms');
  assert.equal(fired(await tick(state, 4)), true, 'persisted drop fires');
  assert.equal(fired(await tick(state, 4)), false, 'same incident stays warned');
  assert.equal(fired(await tick(state, 7)), false, 'recovery is silent');
  assert.equal(fired(await tick(state, 4)), false, 'new incident arms');
  assert.equal(fired(await tick(state, 4)), false, 'same signature inside cooldown is muted');
});

test('#666 case 4: an intervening signature must NOT release an earlier signature’s gate', async () => {
  const state = tmpState();
  // Incident 1: 5→4 fires, recovers.
  await tick(state, 5);
  await tick(state, 4);
  assert.equal(fired(await tick(state, 4)), true, '5→4 fires fresh');
  await tick(state, 6); // recovery (also lifts the baseline to 6)

  // Incident 2, deeper baseline: 6→4.
  // ⚠️ EXPECTATION REVERSED BY #690, deliberately. Under pair-keying this was
  // a "new signature" and fired. Under severity-keying it lands on the SAME
  // destination — the room already knows receivers hit 4, and that two seats
  // were lost instead of one does not change how many are live. #666's actual
  // guarantee is asserted at the END of this test and is UNAFFECTED; this line
  // was always scaffolding to reach it. Direction of the change: more muting,
  // and only of repetition — the escalation property has its own test.
  await tick(state, 4);
  assert.equal(fired(await tick(state, 4)), false,
    '6→4 is repetition at the same depth (#690) — muted, not news');
  await tick(state, 6); // recovery

  // Simulate the production alternation: baseline settles back at 5 with both
  // signatures' cooldowns still running (this is the state the morning of
  // 2026-08-04 was actually in). Seeding the script's own persisted state is
  // the contract-level way to reach it.
  const st = JSON.parse(fs.readFileSync(state, 'utf8'));
  st.r = 5; st.pendingFrom = null; st.warned = false;
  fs.writeFileSync(state, JSON.stringify(st));

  // Incident 3: 5→4 again, still inside its own 6h window. THE bug fired here.
  await tick(state, 4);
  assert.equal(fired(await tick(state, 4)), false,
    '5→4 must still be muted by ITS OWN cooldown despite the intervening 6→4');
});

test('old-format state migrates: lastSig/lastWarnAt still mute after a deploy mid-incident', async () => {
  const state = tmpState();
  fs.writeFileSync(state, JSON.stringify({
    r: 5, pendingFrom: null, warned: false,
    lastSig: '5->4', lastWarnAt: Date.now() - 60_000, // fired a minute ago, pre-upgrade
  }));
  await tick(state, 4);
  assert.equal(fired(await tick(state, 4)), false, 'migrated cooldown honored, no re-fire');
});

test('TTL: an expired signature entry fires again and stale entries are evicted', async () => {
  const state = tmpState();
  fs.writeFileSync(state, JSON.stringify({
    r: 5, pendingFrom: null, warned: false,
    sigTimes: { '5->4': Date.now() - 7 * 3600 * 1000, '9->2': Date.now() - 8 * 3600 * 1000 },
  }));
  await tick(state, 4);
  assert.equal(fired(await tick(state, 4)), true, 'a 7h-old entry is past the 6h window — fires');
  const st = JSON.parse(fs.readFileSync(state, 'utf8'));
  // #690: keys are destination-scoped now (`drop:N`), and the seeded pair keys
  // above are migrated then evicted for age. The TTL property under test is
  // unchanged — only the key spelling moved.
  assert.equal(st.sigTimes['9->2'], undefined, 'stale unrelated entry evicted');
  assert.equal(st.sigTimes['drop:2'], undefined, 'and its migrated form is evicted too, not resurrected');
  assert.ok(st.sigTimes['drop:4'], 'the just-fired depth holds a fresh entry');
});

test('#668: the floor alarm respects the same per-signature cooldown as the delta alarm', async () => {
  const state = tmpState();
  await tick(state, 7); // baseline
  assert.equal(fired(await tick(state, 2)), true, 'total collapse below floor fires immediately');
  assert.equal(fired(await tick(state, 2)), false, 'still collapsed — warned gate holds');
  await tick(state, 7); // recovery clears the warned gate
  assert.equal(fired(await tick(state, 2)), false,
    'same collapse depth inside the cooldown must be MUTED — the warned gate alone resets on every recovery');
  assert.equal(fired(await tick(state, 1)), true, 'a DEEPER collapse is a new floor signature and fires through the mute');
});

test('a deploy spike receding to a recently-held level is a SETTLE, not a drop (no warning)', async () => {
  // The 2026-08-04 17:15Z false positive: baseline 5 all afternoon, deploy
  // re-registration spike to 7, settle back to 5 → the watch took the spike
  // as the floor and reported the return to normal as a fault, firing at the
  // exact moment the room was watching hardest.
  const state = tmpState();
  for (const r of [5, 5, 5, 5]) assert.equal(fired(await tick(state, r)), false, 'steady baseline');
  await tick(state, 7); // deploy spike
  await tick(state, 7);
  assert.equal(fired(await tick(state, 5)), false, 'first tick of the recede must not warn');
  assert.equal(fired(await tick(state, 5)), false,
    'a return to a level held for most of recent history is a settle, not a two-tick drop');
});

test('a genuine drop below any recently-held level still fires through the settle logic', async () => {
  const state = tmpState();
  for (const r of [5, 5, 5, 5]) await tick(state, r);
  await tick(state, 7); // spike
  await tick(state, 7);
  await tick(state, 4); // NOT a recently-held level — arm
  assert.equal(fired(await tick(state, 4)), true, '7→4 past the settle check must still fire');
});

// ── #690: the cooldown must key on SEVERITY, not on the (from→to) pair ────
//
// The file's own comment declares the axis: "the cooldown mutes repetition,
// never escalation." The implementation keyed on `${from}->${to}`, so the two
// diverged the moment the DESTINATION went up: 7→6 is a different key from
// 7→4 and fired, though 6 receivers is strictly better than the 4 we had
// already alarmed about. Measured in production 2026-08-04:
//
//   17:15Z  7 → 5     18:41Z  7 → 4  (worst yet)     01:56Z  7 → 6  ← fired anyway
//
// Restart churn WALKS the key space instead of repeating a key, so the mute
// was real per-key and near-useless in aggregate. Rule: a drop fires only if
// its destination is BELOW every destination currently muted.

test('#690 a SHALLOWER drop after a deeper one is muted — the production case', async () => {
  const state = tmpState();
  await tick(state, 7);
  await tick(state, 4);
  assert.equal(fired(await tick(state, 4)), true, '7→4 fires: nothing muted yet');
  await tick(state, 7);                                  // recovery
  await tick(state, 6);
  assert.equal(fired(await tick(state, 6)), false,
    '7→6 must be MUTED: 6 receivers is strictly better than the 4 already alarmed about, '
    + 'so this is repetition wearing a different key — the exact 01:56Z post that filed this card');
});

test('#690 escalation still fires through the mute — the property the muting must not cost', async () => {
  const state = tmpState();
  await tick(state, 7);
  await tick(state, 4);
  assert.equal(fired(await tick(state, 4)), true, '7→4 fires');
  await tick(state, 7);
  await tick(state, 3);
  assert.equal(fired(await tick(state, 3)), true,
    '7→3 is DEEPER than anything muted and must fire immediately — muting repetition '
    + 'must never buy silence on a worsening fault');
});

test('#690 same destination from a different baseline is repetition, not news', async () => {
  // ⚠️ This REVERSES the #666 test's line-79 expectation, deliberately. That
  // assertion was scaffolding for #666's real check (a signature's own gate
  // must not be released by an intervening one), which still holds — and holds
  // MORE strongly here. What changes is the direction: #666 fixed an
  // under-muting bug; this fixes an under-muting bug one level up.
  const state = tmpState();
  await tick(state, 5);
  await tick(state, 4);
  assert.equal(fired(await tick(state, 4)), true, '5→4 fires');
  await tick(state, 6);                                  // recovery lifts baseline to 6
  await tick(state, 4);
  assert.equal(fired(await tick(state, 4)), false,
    '6→4 lands on the SAME destination — the room already knows receivers hit 4; '
    + 'that two seats were lost instead of one does not change how many are live');
});

test('#690 the floor path has the SAME defect and the same fix', async () => {
  // The card claimed floor was "the right shape to copy" because it keys on
  // destination alone. Reading it properly: keying on destination is necessary
  // and NOT sufficient — floor:2 after floor:0 is still a fresh key for a
  // strictly better state. Same bug, milder, fixed with the same rule.
  const state = tmpState();
  await tick(state, 7);
  assert.equal(fired(await tick(state, 0)), true, 'total collapse fires');
  await tick(state, 7);                                  // recovery
  assert.equal(fired(await tick(state, 2)), false,
    'floor:2 after floor:0 must be MUTED — 2 streams is better than 0, not news');
});

test('#690 old pair-format cooldowns MIGRATE, so a deploy mid-window does not re-fire', async () => {
  // Live state at upgrade time holds `7->4` style keys. Dropping them would
  // re-fire every muted signature the moment this ships — the #666 migration
  // lesson, which that card learned the same way.
  const state = tmpState();
  fs.writeFileSync(state, JSON.stringify({
    r: 7, pendingFrom: null, warned: false,
    sigTimes: { '7->4': Date.now() - 60_000 },           // fired a minute ago, pre-upgrade
  }));
  await tick(state, 6);
  assert.equal(fired(await tick(state, 6)), false,
    'the migrated 7→4 cooldown must mute a shallower 7→6 immediately after upgrade');
  const st = JSON.parse(fs.readFileSync(state, 'utf8'));
  assert.equal(st.sigTimes['7->4'], undefined, 'the old pair key is rewritten, not left to rot');
  assert.ok(st.sigTimes['drop:4'], 'migrated to a destination-keyed entry');
});

test('#690 expiry re-arms: once the window passes, the same depth fires again', async () => {
  const state = tmpState();
  fs.writeFileSync(state, JSON.stringify({
    r: 7, pendingFrom: null, warned: false,
    sigTimes: { 'drop:4': Date.now() - 7 * 3600 * 1000 }, // past the 6h horizon
  }));
  await tick(state, 6);
  assert.equal(fired(await tick(state, 6)), true,
    'an expired entry pins nothing — 7→6 fires because no live mute is deeper');
});
