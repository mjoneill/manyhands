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

  // Incident 2, deeper baseline: 6→4 is a NEW signature and must fire.
  await tick(state, 4);
  assert.equal(fired(await tick(state, 4)), true, '6→4 intervenes and fires — escalation stays loud');
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
  assert.equal(st.sigTimes['9->2'], undefined, 'stale unrelated entry evicted');
  assert.ok(st.sigTimes['5->4'], 'the just-fired signature holds a fresh entry');
});
