/**
 * #745 — the group kill must never be able to signal the runner itself, and the
 * mechanism must be pinned rather than merely effective.
 *
 * WHY GUARDS. `kill()` sends `process.kill(-pgid, 'SIGKILL')` for every captured
 * process group. Nothing stopped `captured.groups` from containing the RUNNER's
 * own group. It was safe only because `spawn(..., { detached: true })` gives the
 * child a fresh group that its descendants inherit — safety held by an assumption
 * elsewhere in the file. Drop or forget `detached` in a later refactor and the
 * runner signals itself mid-run, with nothing to notice. A pgid of 1 is the same
 * shape with a larger blast radius: `kill(-1, ...)` signals every process the
 * user can signal. I could not construct that case and do not believe it is
 * reachable; the guard is one comparison and the failure is unbounded.
 *
 * WHY A SPY, measured during #735 review:
 *
 *   group kill removed, pid kill kept   → 17/17 PASS
 *   pid kill removed, group kill kept   → 17/17 PASS
 *
 * Both paths are behaviourally redundant for the existing fixture, so the suite
 * cannot tell which is working and deleting either would go green. That is not
 * automatically a test hole — a surviving mutant is only a hole once the mutation
 * is shown to change behaviour, and there it did not. But the group kill exists
 * for the case the fixture does not build: a process that appears BETWEEN `ps`
 * scans, inside the group, never captured in the pid list. That is the real-Chrome
 * case, and it is the half whose deletion nothing would notice.
 *
 * ⇒ Outcome assertions prove the result; a spy pins the mechanism; you need the
 *   spy only for the mechanism whose absence is invisible.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupsToSignal, signalGroups } from '../scripts/run-process-tree.mjs';

/** ps-style rows: the group is live and contains a captured pid. */
const rows = (...pgids) => pgids.map((pgid, i) => ({ pid: 1000 + i, ppid: 1, pgid }));
const captured = (pids, groups) => ({ pids: new Set(pids), groups: new Set(groups) });

test('#745 a live captured group IS signalled — the guard must not disarm the mechanism', () => {
  const cur = rows(4242);
  const out = groupsToSignal(captured([1000], [4242]), cur, 9999);
  assert.deepEqual(out, [4242],
    'if this fails the guards have broken termination, which is worse than the hazard');
});

test('#745 the runner\'s OWN process group is never signalled', () => {
  const SELF = 5150;
  const cur = [{ pid: 1000, ppid: 1, pgid: SELF }];
  const out = groupsToSignal(captured([1000], [SELF]), cur, SELF);
  assert.deepEqual(out, [],
    'the runner would have SIGKILLed itself mid-run — today prevented only by detached:true');
});

test('#745 pgid <= 1 is never signalled — kill(-1) hits every process the user owns', () => {
  const cur = [{ pid: 1000, ppid: 1, pgid: 1 }, { pid: 1001, ppid: 1, pgid: 0 }];
  const out = groupsToSignal(captured([1000, 1001], [1, 0]), cur, 9999);
  assert.deepEqual(out, [], 'a floor costs one comparison; the failure is unbounded');
});

test('#745 a group with no captured member still is not signalled', () => {
  // Pre-existing behaviour, kept: only groups that still hold one of OUR pids.
  const out = groupsToSignal(captured([1000], [4242]), rows(7777), 9999);
  assert.deepEqual(out, [], 'never signal a group we did not put a process into');
});

test('#745 SPY: the signal is sent to the NEGATIVE pgid, not the bare pgid', () => {
  // THE mechanism test. A bare pid kills one process and leaves the tree; the
  // whole point of the group path is the minus sign, and an outcome assertion
  // over the existing fixture cannot see it because the pid loop covers the same
  // ground.
  const calls = [];
  signalGroups([4242, 777], (target, sig) => calls.push([target, sig]));
  assert.deepEqual(calls, [[-4242, 'SIGKILL'], [-777, 'SIGKILL']],
    'a positive target here means the group mechanism has silently become a pid kill');
});

test('#745 a kill that throws does not stop the remaining groups', () => {
  // Re-derived after the floor moved INSIDE signalGroups: 1 is now rejected, so
  // this case uses pgids that are all valid. Its intent is unchanged — a throw
  // must not abandon the groups after it — and the expectation was recomputed
  // from that intent rather than adjusted until it went green.
  const calls = [];
  signalGroups([2, 3, 4], (target, sig) => {
    calls.push(target);
    if (target === -3) throw new Error('ESRCH — already gone');
  });
  assert.deepEqual(calls, [-2, -3, -4],
    'one already-dead group must not abandon the others still running');
});

test('#745 ANTI-VACUITY: the spy records, so the assertions above are not empty', () => {
  const calls = [];
  signalGroups([9], (t, s) => calls.push([t, s]));
  assert.equal(calls.length, 1, 'if this fails every deepEqual above passes on nothing');
});

/**
 * #745 review round 2 — both guards must FAIL CLOSED at the destructive boundary.
 *
 * Round 1 failed open in two ways, found in review:
 *
 *   1. `SELF_PGID` was NaN when its ps lookup failed, and `pgid !== NaN` is
 *      always true — so an unreadable pgid DISABLED the self guard instead of
 *      engaging it. My own comment described this as "simply never matches",
 *      which is true and is exactly the problem.
 *   2. `signalGroups` did not revalidate. Production composition filtered pgid<=1
 *      upstream, but the exported primitive would still issue kill(-1, ...) —
 *      safety by caller invariant, which is the shape #745 exists to remove.
 */
test('#745 an UNKNOWN self pgid signals NOTHING — the guard fails closed', () => {
  const cur = [{ pid: 1000, ppid: 1, pgid: 4242 }];
  for (const unknown of [NaN, null, undefined, '4242', 1.5]) {
    assert.deepEqual(
      groupsToSignal(captured([1000], [4242]), cur, unknown), [],
      `selfPgid=${String(unknown)} must suppress ALL group kills; a guard that ` +
      'cannot identify what to protect must not fire at the thing it protects');
  }
});

test('#745 signalGroups REVALIDATES — 1, 0, negatives and non-integers never reach the killer', () => {
  const calls = [];
  signalGroups([1, 0, -5, 1.5, NaN, '7', null, 4242], (t, s) => calls.push([t, s]));
  assert.deepEqual(calls, [[-4242, 'SIGKILL']],
    'the exported primitive must be safe on its own, not safe because of who calls it');
});
