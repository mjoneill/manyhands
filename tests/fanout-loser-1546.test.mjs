/**
 * #1546 — a receivers drop must NAME THE CLIENT KEY whose stream count fell.
 *
 * The card's DONE WHEN (as handed over, with the later wording fix):
 *   (a) healthcheck 1→0  → the alarm names healthcheck
 *   (b) a seat 1→0       → the alarm names that seat, and a seat drop still alarms
 *   (c) unbound 2→1, no bound key changed → the alarm says "unattributed
 *       receiver loss" and makes no deafness claim
 *
 * THE TRAP THESE ROWS ARE BUILT AROUND. The watch settles a drop over two ticks
 * (arm, then fire). At the firing tick the seats map is IDENTICAL to the arming
 * tick's, so a diff against "the previous tick" sees nothing changed and names
 * nobody. The only baseline that holds the loss is the reading from BEFORE the
 * drop. Every row below therefore runs the real three-tick shape (baseline, arm,
 * fire) through the whole script, not the pure function with two hand-built
 * maps.
 *
 * ASSERTED ON THE PRINTED LINE (the DRYRUN body a human reads), not on state.
 *
 * FORMAT, PRE-REGISTERED. The card's example is `healthcheck: 1→0`. These rows
 * accept `name: before→after` with optional spaces around the colon and either
 * the arrow or `->`. A builder who words it differently (for instance "lost 1")
 * has a row that fails for wording, and the right response is to say so on the
 * card and change the row, not to bend the output to match a guess.
 *
 * SHAPE OF THE LIVE FIRINGS (10-03 and 10-10): bound=[healthcheck:0,alpha:1,
 * beta:4,gamma:1] unbound=2, receivers 9→8, sessions flat. The fixtures use
 * those numbers.
 */
import { test, after } from 'node:test';
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

const SESSIONS = 14; // flat across every tick: streams die under live sessions
const seat = (streams) => ({ streams, sessions: streams || 1, lastBeatAt: null });

/** A /channel/status payload. `streams` is per seat key; `unboundStreams` is
 *  how many of `receivers` belong to no bound key. receivers = sum + unbound. */
function status({ healthcheck = 1, alpha = 1, beta = 4, gamma = 1, unboundStreams = 2 }, { rawSeats = {}, receivers } = {}) {
  return {
    receivers: receivers ?? healthcheck + alpha + beta + gamma + unboundStreams,
    sessions: SESSIONS,
    binding: 'active',
    unbound: unboundStreams,
    mode: 'soft',
    pending: 0,
    seats: { healthcheck: seat(healthcheck), alpha: seat(alpha), beta: seat(beta), gamma: seat(gamma), ...rawSeats },
  };
}

async function tick(stateFile, payload) {
  const srv = http.createServer((_, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(payload));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const { stdout } = await run(process.execPath, [SCRIPT], {
      env: {
        ...process.env,
        SCRUM_STATUS_URL: `http://127.0.0.1:${srv.address().port}/channel/status`,
        SCRUM_POST_URL: 'http://127.0.0.1:9/api/conversations', // dead port: no maintenance read (#837)
        SCRUM_FANOUT_STATE: stateFile,
        SCRUM_FANOUT_DRYRUN: '1',
      },
    });
    return stdout;
  } finally {
    await new Promise((r) => srv.close(r));
  }
}

// Every scenario makes its own state directory. The suite runner counts what a file leaves in its TMPDIR (#1672)
// and fails the run on a new leak, so each directory is recorded and removed once the file's tests are done.
const stateDirs = [];
const tmpState = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fanout-1546-'));
  stateDirs.push(dir);
  return path.join(dir, 'watch.state');
};
after(() => { for (const dir of stateDirs) fs.rmSync(dir, { recursive: true, force: true }); });
const posted = (out) => {
  const m = out.match(/DRYRUN would post: ([\s\S]*)$/m);
  return m ? m[1] : null;
};
// `name: before→after`, spaces optional, arrow or ->
const loss = (name, from, to) => new RegExp(`\\b${name}\\s*:\\s*${from}\\s*(?:→|->)\\s*${to}\\b`);
const anyLoss = (name) => new RegExp(`\\b${name}\\s*:\\s*\\d+\\s*(?:→|->)\\s*\\d+\\b`);

/** baseline, then the drop twice (arm, fire). Returns { armed, fired } bodies. */
async function drop(before, after, afterOpts = {}, beforeOpts = {}) {
  const state = tmpState();
  const base = await tick(state, status(before, beforeOpts));
  assert.equal(posted(base), null, 'the baseline tick posts nothing');
  const armed = await tick(state, status(after, afterOpts));
  assert.equal(posted(armed), null, 'the first tick of a drop only arms');
  const fired = await tick(state, status(after, afterOpts));
  return { fired: posted(fired), firedRaw: fired };
}

// ---------------------------------------------------------------- controls

test('#1546 CONTROL — the fixture reproduces the live shape: receivers 9→8 under flat sessions fires once', async () => {
  const { fired } = await drop({}, { healthcheck: 0 });
  assert.ok(fired, 'the drop must fire on the current code, or none of the rows below has a premise');
  assert.match(fired, /receivers dropped 9 → 8/);
  assert.match(fired, /healthcheck:0/, 'the existing bracket still prints the post-drop snapshot');
});

test('#1546 CONTROL — nothing falls, nothing fires, and no loss clause appears', async () => {
  const state = tmpState();
  for (let i = 0; i < 3; i++) assert.equal(posted(await tick(state, status({}))), null, `tick ${i + 1}`);
});

// ------------------------------------------------------------------- rows

test('#1546 (a) healthcheck 1→0 — the alarm names healthcheck and the count that fell', async () => {
  const { fired } = await drop({}, { healthcheck: 0 });
  assert.ok(fired, 'a healthcheck drop still posts (a stream that cannot hold is itself a finding)');
  assert.match(fired, loss('healthcheck', 1, 0), 'names healthcheck with before→after');
  for (const s of ['alpha', 'beta', 'gamma']) {
    assert.doesNotMatch(fired, anyLoss(s), `${s} did not lose a stream and must not be named as having lost one`);
  }
});

test('#1546 (b) a seat 1→0 — the alarm still posts and names that seat, not healthcheck', async () => {
  const { fired } = await drop({}, { alpha: 0 });
  assert.ok(fired, 'a seat stream drop still alarms');
  assert.match(fired, loss('alpha', 1, 0), 'names alpha with before→after');
  assert.doesNotMatch(fired, anyLoss('healthcheck'), 'healthcheck held its stream and must not be named as having lost one');
});

test('#1546 (b2) a seat with several streams 4→3 — the count that fell is the seat’s own', async () => {
  const { fired } = await drop({}, { beta: 3 });
  assert.ok(fired);
  assert.match(fired, loss('beta', 4, 3));
});

test('#1546 (d) two keys fall in the same drop — both are named, each with its own counts', async () => {
  const { fired } = await drop({}, { healthcheck: 0, beta: 3 });
  assert.ok(fired);
  assert.match(fired, /receivers dropped 9 → 7/);
  assert.match(fired, loss('healthcheck', 1, 0));
  assert.match(fired, loss('beta', 4, 3));
});

test('#1546 (c) unbound 2→1 with every bound key unchanged — says "unattributed receiver loss" and claims no deafness', async () => {
  const { fired } = await drop({}, { unboundStreams: 1 });
  assert.ok(fired, 'the drop is still shown, not hidden');
  assert.match(fired, /unattributed receiver loss/i);
  for (const s of ['healthcheck', 'alpha', 'beta', 'gamma']) {
    assert.doesNotMatch(fired, anyLoss(s), `no bound key changed, so ${s} must not be named`);
  }
  // The existing sentence is the claim under test; "not deafness" would be a
  // different sentence, so the match is on the claim's wording, not the word.
  assert.doesNotMatch(fired, /which is deafness/i, 'must not assert deafness for a loss it cannot attribute');
  // NOT asserted: the generic caution "A seat quiet since the last restart may be
  // deaf" that the alarm appends to every firing. It names no seat and makes no
  // claim about this loss; whether it should stay is the builder's and reviewer's
  // call, and a row that rejected it would fail a build the card allows.
});

test('#1546 the loss is read against the reading BEFORE the drop, not the arming tick', async () => {
  // The arm and fire ticks carry identical seats. A previous-tick diff sees no
  // change at the firing tick; this row exists so that implementation fails.
  const state = tmpState();
  await tick(state, status({}));
  await tick(state, status({ healthcheck: 0 }));
  const third = posted(await tick(state, status({ healthcheck: 0 })));
  assert.ok(third);
  assert.match(third, loss('healthcheck', 1, 0), 'the firing tick names the key that fell at the drop');
});

// ------------------------------------------------- review findings, 6616feb
//
// Two defects found on review of the first build, each asserted on the PRINTED
// warning, which is what a seat reads.

test('#1546 (e) a PARTIAL loss (4→3) is named as a loss and does not declare the seat deaf', async () => {
  const { fired } = await drop({}, { beta: 3 });
  assert.ok(fired);
  assert.match(fired, loss('beta', 4, 3), 'the loss is still named, with its counts');
  // beta still holds three streams. The sentence under test is the one that says a
  // named seat "is deaf until it reconnects"; the generic caution about a seat
  // quiet since the last restart is a different sentence and is not asserted on.
  assert.doesNotMatch(fired, /seat is deaf|is deaf until|deaf until (it|they) reconnect/i,
    'a seat that still holds streams must not be called deaf');
});

// An UNKNOWN count is not a ZERO count. A key whose measurement is missing
// (no `streams` field) or explicitly null must not be rendered as having fallen
// to 0, and the line must not claim a count it does not have.
// Accepts a word saying so, or an unknown marker in place of the count (`4→?` or `?→3`).
const UNKNOWN_WORDING = /unknown|not attributable|unmeasured|unread|could not be (?:read|measured)|:\s*\d+\s*(?:→|->)\s*\?|:\s*\?\s*(?:→|->)\s*\d+/i;
async function unknownCount(rawBeta) {
  // receivers fall 9→8 through the unbound streams, with sessions flat; beta's
  // seat object is replaced by `rawBeta`.
  return drop({}, { unboundStreams: 1 }, { rawSeats: { beta: rawBeta }, receivers: 8 });
}
async function assertUnknownIsNotZero(rawBeta) {
  const { fired } = await unknownCount(rawBeta);
  assert.ok(fired, 'the receivers drop still posts');
  assert.doesNotMatch(fired, loss('beta', 4, 0), 'an unread count must not be printed as a fall to 0');
  assert.doesNotMatch(fired, anyLoss('beta'), 'beta must not be named as having lost anything on an unread count');
  assert.doesNotMatch(fired, /no bound key's count fell/i, 'must not assert that no count fell when one could not be read');
  assert.match(fired, UNKNOWN_WORDING, 'the line says the count is unknown rather than staying silent');
}

test('#1546 (f) a present key whose `streams` field is missing is not reported as 4→0', async () => {
  await assertUnknownIsNotZero({ sessions: 1, lastBeatAt: null });
});

test('#1546 (f2) a key with explicit `streams: null` is not reported as 4→0', async () => {
  await assertUnknownIsNotZero({ streams: null, sessions: 1, lastBeatAt: null });
});

// ------------------------------------------------- the same defect, other side
//
// The rows above leave the count unknown AFTER the drop. An unknown count
// BEFORE it is the mirror: nothing can be compared, so the line must not claim
// that no count fell. (The first set of rows left this side out.)
async function unknownBaseline(rawBeta, after = { beta: 3 }, afterOpts = {}) {
  return drop({}, after, afterOpts, { rawSeats: { beta: rawBeta } });
}

test('#1546 (g) a key whose count was UNKNOWN before the drop is not read as "no count fell"', async () => {
  const { fired } = await unknownBaseline({ sessions: 1, lastBeatAt: null }); // `streams` missing before, 3 after
  assert.ok(fired, 'the receivers drop still posts');
  assert.doesNotMatch(fired, /no bound key's count fell/i, 'a comparison that could not be made is not evidence that nothing fell');
  assert.doesNotMatch(fired, anyLoss('beta'), 'nothing is known about beta before the drop, so it is not named as having lost anything');
  assert.match(fired, UNKNOWN_WORDING, 'the line says the count is unknown');
});

test('#1546 (g2) the same with explicit `streams: null` before the drop', async () => {
  const { fired } = await unknownBaseline({ streams: null, sessions: 1, lastBeatAt: null });
  assert.ok(fired);
  assert.doesNotMatch(fired, /no bound key's count fell/i);
  assert.doesNotMatch(fired, anyLoss('beta'));
  assert.match(fired, UNKNOWN_WORDING);
});

test('#1546 (g3) an unknown baseline for one key does not hide a known loss by another', async () => {
  // beta unread before; gamma falls 1→0 (receivers 9→8). The known loss is named
  // and the unknown key is still reported as unknown.
  const { fired } = await unknownBaseline({ sessions: 1, lastBeatAt: null }, { beta: 3, gamma: 0 }, { receivers: 8 });
  assert.ok(fired);
  assert.match(fired, loss('gamma', 1, 0), 'the known loss is named');
  assert.doesNotMatch(fired, /no bound key's count fell/i);
  assert.match(fired, UNKNOWN_WORDING, 'beta is reported as unknown, not silently dropped');
});
