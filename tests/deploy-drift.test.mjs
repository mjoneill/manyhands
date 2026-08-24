/**
 * #606 — the deploy-drift report. Five instances of "no git-side signal is a
 * deploy" and the remedy this card specified has never been built.
 *
 * ⛔ THE THREE WAYS THIS INSTRUMENT CAN LIE, all of them drawn from THIS CARD's
 * own history rather than imagined:
 *
 *  1  A LOCAL `origin/main` ONLY MOVES ON FETCH (instance 3). A check that
 *     compares against it without saying when it was last fetched reports
 *     "0 behind" from a six-hour-old idea of the remote — and nothing in the
 *     output says the comparison is stale. That is a check that CANNOT FAIL,
 *     which is worse than no check because its silence reads as health.
 *
 *  2  A MISSING DEPLOYED-SHA MUST NOT READ AS ZERO DRIFT. "I could not find
 *     out" and "there is nothing to report" are opposite facts, and a report
 *     that renders them identically is the false all-clear this whole card is
 *     about.
 *
 *  3  A BARE COUNT UNDERSTATES AND OVERSTATES AT ONCE (instance 5). Four of
 *     tonight's nine dormant commits were test-only — no runtime effect, so
 *     deploying them is a no-op — while one of the other five was a SAFETY
 *     precondition answering 200 to anyone who trusted it. "9 behind" tells
 *     you neither.
 *
 * Read-only by construction: it fetches nothing unless asked, writes nothing,
 * and runs from a clone. It CANNOT run git in the served export, which has no
 * .git BY DESIGN (#1008).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { driftReport } from '../tools/deploy-drift.mjs';

function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

/** A throwaway repo with a runtime commit and a test-only commit on top. */
function makeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'drift-repo-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.invalid');
  git(dir, 'config', 'user.name', 'T');
  writeFileSync(path.join(dir, 'server.js'), 'v1\n');
  mkdirSync(path.join(dir, 'tests'), { recursive: true });
  writeFileSync(path.join(dir, 'tests', 'a.test.mjs'), 'v1\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base');
  const base = git(dir, 'rev-parse', 'HEAD');

  writeFileSync(path.join(dir, 'server.js'), 'v2\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'feat: a RUNTIME change');

  writeFileSync(path.join(dir, 'tests', 'a.test.mjs'), 'v2\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'test: a TEST-ONLY change');

  return { dir, base, head: git(dir, 'rev-parse', 'HEAD') };
}

function makeServed(sha) {
  const dir = mkdtempSync(path.join(tmpdir(), 'drift-serve-'));
  if (sha !== null) writeFileSync(path.join(dir, 'DEPLOYED-SHA'), sha + '\n');
  return dir;
}

test('#606 reports the drift, and SPLITS runtime from test-only', async () => {
  const repo = makeRepo();
  const served = makeServed(repo.base);
  try {
    const r = driftReport({ repoDir: repo.dir, servedDir: served, ref: 'HEAD' });
    assert.equal(r.ok, true, `expected a usable report: ${JSON.stringify(r)}`);
    assert.equal(r.total, 2, 'two commits between the served sha and HEAD');
    assert.equal(r.runtime.length, 1, 'exactly one touches runtime');
    assert.equal(r.testOnly.length, 1, 'exactly one is test-only');
    assert.match(r.runtime[0].subject, /RUNTIME/);
    assert.match(r.testOnly[0].subject, /TEST-ONLY/);
  } finally { rmSync(repo.dir, { recursive: true, force: true }); rmSync(served, { recursive: true, force: true }); }
});

test('#606 ⭐ names the dormant commits — a bare COUNT cannot show a dormant SAFETY feature', async () => {
  // Instance 5: "5 behind" does not say "and one of those five is a precondition
  // that currently answers 200 to anyone who trusts it."
  const repo = makeRepo();
  const served = makeServed(repo.base);
  try {
    const r = driftReport({ repoDir: repo.dir, servedDir: served, ref: 'HEAD' });
    const text = r.lines.join('\n');
    assert.match(text, /RUNTIME change/, 'the report must name what is dormant, not just count it');
    assert.ok(r.lines.length >= 2, 'one line per dormant commit');
  } finally { rmSync(repo.dir, { recursive: true, force: true }); rmSync(served, { recursive: true, force: true }); }
});

test('#606 ⛔ a MISSING DEPLOYED-SHA is UNKNOWN, never "0 behind"', async () => {
  // ⭐ THE LOAD-BEARING TEST. "I could not find out" and "there is nothing to
  // report" are opposite facts. A report that renders them identically is the
  // false all-clear this entire card is about.
  const repo = makeRepo();
  const served = makeServed(null);   // no DEPLOYED-SHA at all
  try {
    const r = driftReport({ repoDir: repo.dir, servedDir: served, ref: 'HEAD' });
    assert.equal(r.ok, false, 'a report with no served sha must NOT be usable');
    assert.equal(r.total, null, 'and must NOT present a count — least of all zero');
    assert.match(r.error, /DEPLOYED-SHA/, 'and must say what it could not find');
  } finally { rmSync(repo.dir, { recursive: true, force: true }); rmSync(served, { recursive: true, force: true }); }
});

test('#606 ⛔ an UNKNOWN served sha is UNKNOWN, never "0 behind"', async () => {
  // The other half: the file exists and names a commit this clone has never
  // seen. Same rule — refuse to compute rather than compute against nothing.
  const repo = makeRepo();
  const served = makeServed('0'.repeat(40));
  try {
    const r = driftReport({ repoDir: repo.dir, servedDir: served, ref: 'HEAD' });
    assert.equal(r.ok, false, 'an unresolvable served sha must not yield a count');
    assert.equal(r.total, null);
    assert.match(r.error, /unknown|not.*found|resolve/i);
  } finally { rmSync(repo.dir, { recursive: true, force: true }); rmSync(served, { recursive: true, force: true }); }
});

test('#606 ⭐⭐ the report DISCLOSES how stale its comparison ref is', async () => {
  // ⭐⭐⭐ Instance 3, encoded. `origin/main` is a LOCAL ref that only moves when
  // someone fetches, so a drift check comparing against it reports "0 behind"
  // from a six-hour-old idea of the remote, and NOTHING IN THE OUTPUT SAYS SO.
  // This card's own proposed fix contained that defect. The remedy is not more
  // checking — it is that the instrument states the age of its own comparand.
  const repo = makeRepo();
  const served = makeServed(repo.base);
  try {
    const r = driftReport({ repoDir: repo.dir, servedDir: served, ref: 'HEAD' });
    assert.ok('refAge' in r, 'the report must carry the age of its comparison ref');
    const text = r.lines.concat(r.header || []).join('\n');
    assert.match(text, /fetch|local ref|never fetched|as of/i,
      'and must SAY it in the output — a staleness a reader has to infer is one '
      + 'they will not infer. This is the defect that made #606 instance 3.');
  } finally { rmSync(repo.dir, { recursive: true, force: true }); rmSync(served, { recursive: true, force: true }); }
});

test('#606 zero drift reports ZERO EXPLICITLY, not silence', async () => {
  // #726: a count needs no threshold and cannot be miscalibrated — but only if
  // it is always printed. A line that appears only on trouble is an alarm with
  // extra steps, and its absence is unreadable.
  const repo = makeRepo();
  const served = makeServed(repo.head);
  try {
    const r = driftReport({ repoDir: repo.dir, servedDir: served, ref: 'HEAD' });
    assert.equal(r.ok, true);
    assert.equal(r.total, 0);
    assert.match(r.summary, /0|up to date|current/i, 'zero must be SAID, not implied by silence');
  } finally { rmSync(repo.dir, { recursive: true, force: true }); rmSync(served, { recursive: true, force: true }); }
});

test('#606 ⭐⭐ the SUMMARY LINE ITSELF carries the ref freshness — it must not be separable', async () => {
  // ⛔⛔ SIXTH INSTANCE OF THIS CARD, found in this card's own remedy.
  //
  // The report emitted the freshness caveat as its own line and the count as
  // another. A downstream consumer (the healthcheck wiring) selected the count
  // with `sed -n 's/^deploy drift: /…/p'` and the caveat — which does not match
  // that pattern — was silently discarded. The stamp then asserted "production
  // is up to date with origin/main" while the ref behind that claim was 23
  // minutes old, and at six hours it would read IDENTICALLY.
  //
  // ⇒ That is instance 3 of #606 (origin/main is a LOCAL ref) arriving through
  // the instrument built to detect instance 3. The confession existed; the
  // transport dropped it.
  //
  // ⭐ So the caveat is folded INTO the summary rather than printed beside it.
  // A separable warning WILL be separated — #216's lesson, third instance
  // tonight: a warning on a different surface from the instrument is not a
  // mitigation. This test exists so the two cannot be split again.
  const repo = makeRepo();
  const served = makeServed(repo.base);
  try {
    const r = driftReport({ repoDir: repo.dir, servedDir: served, ref: 'HEAD' });
    assert.match(r.summary, /fetch|local ref|never fetched|as of/i,
      'the SUMMARY must state what its comparand is, on its own line, because '
      + 'that is the only line a consumer is guaranteed to keep');

    // ⭐ ANTI-VACUITY: a consumer selecting ONLY the summary line must still
    // receive the freshness. This is the exact pipeline that lost it.
    const selected = r.summary.split('\n')
      .filter((l) => /^deploy drift: /.test(l)).join('\n');
    assert.ok(selected.length > 0, 'the summary must still match the consumer pattern');
    assert.match(selected, /fetch|local ref|never fetched|as of/i,
      'and the SELECTED line must carry the caveat — otherwise the pipe drops it again');
  } finally { rmSync(repo.dir, { recursive: true, force: true }); rmSync(served, { recursive: true, force: true }); }
});

// ══════════════════════════════════════════════════════════════════════════
// INSTANCE 6 — a STALE comparand fabricates the zero.
//
// Measured live 2026-08-24T04:30Z: the local `origin/main` was 73 minutes old,
// the served sha equalled it, and the stamp read "drift: 0 — production is up
// to date with origin/main". Production was in fact behind by a real commit
// that the local ref had never heard of.
//
// ⇒ This card's founding sentence, occurring inside this card's own remedy.
//
// ⭐ AND THE ASYMMETRY THAT SHAPES THE FIX: a stale ref can only ever
// UNDERSTATE drift — it cannot invent commits, only miss them. So a NON-ZERO
// count from a stale ref is still true as a LOWER BOUND and stays useful.
// Zero is the single value staleness manufactures out of nothing.
//
// ⇒ So this is not "stale ⇒ refuse to answer". It is "stale ⇒ the ZERO is the
// one answer you cannot give", which keeps the instrument useful in the case
// where it still knows something. Blanket-UNKNOWN would be the alarm-fatigue
// trade this room has made three times tonight.
// ══════════════════════════════════════════════════════════════════════════

/** A repo carrying a remote-tracking ref plus a FETCH_HEAD of a chosen age. */
function makeRepoWithRemoteRef(ageMinutes, { atSha } = {}) {
  const repo = makeRepo();
  const target = atSha === 'base' ? repo.base : repo.head;
  git(repo.dir, 'update-ref', 'refs/remotes/origin/main', target);
  const fh = path.join(repo.dir, '.git', 'FETCH_HEAD');
  writeFileSync(fh, `${target}\t\tbranch 'main' of example.invalid\n`);
  const when = new Date(Date.now() - ageMinutes * 60000);
  utimesSync(fh, when, when);
  return repo;
}

test('#606 ⛔⛔ INSTANCE 6 — a STALE ref must not report "0, up to date". That zero is fabricated.', async () => {
  // 73 minutes, the measured age of the live instance.
  const repo = makeRepoWithRemoteRef(73);
  const served = makeServed(repo.head);   // served == the stale ref ⇒ naive count is 0
  try {
    const r = driftReport({ repoDir: repo.dir, servedDir: served, ref: 'origin/main' });

    assert.equal(r.total, null,
      'a zero derived from a stale comparand is not a measurement — it must not be presented as one');
    assert.doesNotMatch(r.summary, /up to date/,
      `"up to date" is the exact false all-clear of instance 6. Got: ${r.summary}`);
    assert.match(r.summary, /UNKNOWN/,
      `the verdict must be UNKNOWN, not a number. Got: ${r.summary}`);
    // #606's own rule: the caveat must ride the SUMMARY, because a consumer
    // selects one line with sed and a separable warning WILL be separated.
    assert.match(r.summary, /73m|stale/,
      `the summary itself must say WHY it cannot answer. Got: ${r.summary}`);
  } finally { rmSync(repo.dir, { recursive: true, force: true }); rmSync(served, { recursive: true, force: true }); }
});

test('#606 ⭐ NEGATIVE CONTROL — a stale ref with REAL drift still reports the count, as a lower bound', async () => {
  // ⛔ THE OVER-REFUSAL THIS GUARDS. If staleness blanket-refuses, the instrument
  // goes quiet in exactly the situation it exists for: production genuinely
  // behind. A stale ref cannot invent commits, so the ones it DID find are real.
  const repo = makeRepoWithRemoteRef(73);
  const served = makeServed(repo.base);   // two real commits behind
  try {
    const r = driftReport({ repoDir: repo.dir, servedDir: served, ref: 'origin/main' });

    assert.equal(r.ok, true, 'a stale ref that still found real drift produced a usable report');
    assert.equal(r.total, 2, 'the commits it DID find are real — staleness understates, it does not invent');
    assert.match(r.summary, /at least|behind/,
      `the count must survive, framed as the lower bound it is. Got: ${r.summary}`);
    assert.match(r.summary, /73m|stale/, 'and must still disclose the staleness');
  } finally { rmSync(repo.dir, { recursive: true, force: true }); rmSync(served, { recursive: true, force: true }); }
});

test('#606 ⭐ NEGATIVE CONTROL — a FRESH ref with no drift still reports 0 EXPLICITLY', async () => {
  // ⛔ The other over-refusal: if every zero became UNKNOWN, the report could
  // never say "you are current", and #726's rule (the count is ALWAYS stated,
  // including zero) would be dead. A fresh zero is a real measurement.
  const repo = makeRepoWithRemoteRef(1);
  const served = makeServed(repo.head);
  try {
    const r = driftReport({ repoDir: repo.dir, servedDir: served, ref: 'origin/main' });

    assert.equal(r.ok, true, 'a fresh comparison is usable');
    assert.equal(r.total, 0, 'and zero is a genuine answer when the ref is fresh');
    assert.match(r.summary, /up to date/, `a fresh zero must still say so plainly. Got: ${r.summary}`);
    assert.doesNotMatch(r.summary, /UNKNOWN/, `a fresh zero is NOT unknown. Got: ${r.summary}`);
  } finally { rmSync(repo.dir, { recursive: true, force: true }); rmSync(served, { recursive: true, force: true }); }
});

test('#606 ⛔ a NEVER-FETCHED ref cannot report zero either — it is arbitrarily stale', async () => {
  const repo = makeRepo();                       // no FETCH_HEAD at all
  git(repo.dir, 'update-ref', 'refs/remotes/origin/main', repo.head);
  const served = makeServed(repo.head);
  try {
    const r = driftReport({ repoDir: repo.dir, servedDir: served, ref: 'origin/main' });
    assert.equal(r.total, null, 'never-fetched is the most stale a ref can be');
    assert.doesNotMatch(r.summary, /up to date/, `Got: ${r.summary}`);
    assert.match(r.summary, /UNKNOWN/, `Got: ${r.summary}`);
  } finally { rmSync(repo.dir, { recursive: true, force: true }); rmSync(served, { recursive: true, force: true }); }
});
