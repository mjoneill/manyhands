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
import { execFileSync } from 'node:child_process';
import { groupsToSignal, signalGroups, currentSelfGroup } from '../scripts/run-process-tree.mjs';

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

/**
 * #747 — the missing witness: nothing proved a GOOD self-pgid is ever produced.
 *
 * Every test above passes a synthetic selfPgid (9999, 5150, SELF). They prove the
 * consumer behaves correctly GIVEN a value. `selfGroup(table())` — the thing that
 * actually supplies it in production — was unexported and unasserted.
 *
 * ⚠️ That matters precisely BECAUSE the guard fails closed. If `selfGroup` ever
 * returns null, `groupsToSignal` correctly signals nothing, the per-pid loop still
 * runs, and the run still LOOKS terminated — right up until the case the group
 * kill exists for: a process that appears between ps scans, inside the group,
 * never captured in the pid list. And nothing would catch it:
 *
 *     group kill removed, pid kill kept → 17/17 PASS
 *
 * The named input that breaks it is ordinary — any edit to `table()`'s parse or
 * filter that drops the caller's own row. So this asserts against the REAL process
 * table and an independent reading of our own group, with no fixture anywhere.
 */
test('#747 selfGroup() on the REAL table returns our actual process group', () => {
  const mine = currentSelfGroup();
  // Independent instrument: ps directly, not the module's own table parse.
  const viaPs = Number(String(
    execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)])).trim());

  assert.ok(Number.isInteger(viaPs) && viaPs > 1, `ps gave no usable pgid: ${viaPs}`);
  // Assert the production value directly, so a vanished row FAILS here loudly
  // rather than being skipped or absorbed by the equality check below.
  assert.ok(Number.isInteger(mine) && mine > 1,
    `selfGroup(table()) returned ${String(mine)} — our own row is missing from the ` +
    'process table, which silently disables the entire group-kill path');
  assert.equal(mine, viaPs,
    'the production path must produce the SAME group ps reports. If table() ever ' +
    'stops including our own row this returns null, the guard fails closed, and ' +
    'the entire group-kill path switches off while every existing test stays green');
});

test('#747 the value it produces is one the guard ACCEPTS, not one it rejects', () => {
  // A witness that only checked "returns a number" would pass while returning
  // something groupsToSignal discards — fail-closed for a bad reason, which is
  // indistinguishable from working.
  const mine = currentSelfGroup();
  const other = mine + 1;                      // a group that is NOT ours
  const cur = [{ pid: 1000, ppid: 1, pgid: other }];
  assert.deepEqual(
    groupsToSignal({ pids: new Set([1000]), groups: new Set([other]) }, cur, mine),
    [other],
    'a real self-pgid must still let OTHER live groups through — otherwise the ' +
    'guard is disarming termination rather than protecting the runner');
});

test('#747 ANTI-VACUITY: the guard would reject a broken self-pgid', () => {
  // If this passed for null too, the test above would prove nothing about the
  // value's quality — only that groupsToSignal ran.
  const cur = [{ pid: 1000, ppid: 1, pgid: 4242 }];
  const capt = { pids: new Set([1000]), groups: new Set([4242]) };
  assert.deepEqual(groupsToSignal(capt, cur, null), [], 'null must suppress');
  assert.deepEqual(groupsToSignal(capt, cur, currentSelfGroup()), [4242],
    'a real one must not');
});
