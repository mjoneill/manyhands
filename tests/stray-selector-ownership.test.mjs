/**
 * #490 — the POSITIVE half of the fence: prove the reaper SPARES what it must.
 *
 * ⭐ Requirement F: "A tool tested only on things it should kill has never been
 *    shown to spare anything." So the refusal plants come first here, and the
 *    positive plants exist only to stop those refusals from being vacuous.
 *
 * ⛔ WHAT WAS ACTUALLY WRONG, measured 2026-09-04: #813 shipped the DENYLIST
 *    half. `selectStrays` asked "is this candidate protected?" and anything
 *    protected by nothing fell through to `kill`. The Node-only rule — #490's
 *    stated PRIMARY rule — lived entirely in the caller's `SCRUM_STRAY_PATTERN`
 *    substring, which is an operator-supplied name match, which requirement 2
 *    forbids by name. Every test below marked ⇐ WAS ELIGIBLE describes a
 *    process this selector would have returned as killable before this change.
 *
 * ⚠️ Paths here are deliberately not home-shaped: #837's guard forbids
 *    /Users/<name>/ and ~/ in tracked literals, and the fence reasons about
 *    SHAPE, so any absolute root exercises it identically.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { selectStrays } from '../core/stray-selector.mjs';

const LIVE = ['/srv/live/manyhands', '/srv/live/manyhands-serve'];
const DEV = ['/srv/dev/manyhands'];
const PORTS = [3141, 3001];
const base = { liveTrees: LIVE, devTrees: DEV, protectedPorts: PORTS };

const only = (c) => selectStrays({ ...base, candidates: [c] });

// ─── THE REFUSAL PLANTS ──────────────────────────────────────────────────────

test('#490 REFUSAL — another project’s process is SPARED even though nothing protects it  ⇐ WAS ELIGIBLE', () => {
  // The mirror image of #813's incident. That one asked "did we protect the
  // live board?"; this asks "can we even FORM a target outside our own work?"
  //
  // ⛔ Before the positive scope, this candidate was refused by nothing — not a
  //    live tree, not a protected port, cwd readable — and landed in `kill`.
  //    The only thing standing between it and a signal was that the operator's
  //    `SCRUM_STRAY_PATTERN` happened to say "node".
  const { kill, refused } = only({
    pid: 4242,
    cwd: '/srv/other-project',
    command: '/opt/py/bin/python3 extract.py --model large',
  });
  assert.equal(kill.length, 0, 'a foreign process must never be selectable');
  assert.equal(refused[0].reason, 'not-node');
  assert.match(refused[0].detail, /python3/, 'the refusal names what it saw');
});

test('#490 REFUSAL — a heavy, short-lived, PID-1-reparented non-Node process is SPARED', () => {
  // ⭐ #490 names this trap explicitly: the extractor runs for minutes at high
  //    CPU holding gigabytes and then exits, so it looks EXACTLY like a runaway
  //    orphan while being load-bearing every time it runs.
  //
  // ⚠️ SYNTHETIC SHAPE ONLY — never the real inventory. The test proves the
  //    refusal CLASS works; the private config supplies real instances.
  //
  // ⇒ The assertion that matters is that none of ppid, CPU or RSS is even an
  //   input here. A selector that could be tempted by them is a selector that
  //   would eventually be right about the shape and wrong about the process.
  const { kill, refused } = only({
    pid: 5150,
    ppid: 1,
    cwd: '/srv/other-project',
    command: '/opt/py/bin/python3 heavy_job.py',
    cpu: 780,
    rssMb: 6800,
  });
  assert.equal(kill.length, 0);
  assert.equal(refused[0].reason, 'not-node');
});

test('#490 REFUSAL — a NODE process outside every tree we own is spared  ⇐ WAS ELIGIBLE', () => {
  // Being the right runtime is not ownership either. Someone else's node.
  const { kill, refused } = only({
    pid: 7007, cwd: '/srv/somebody-else', command: 'node --test their.test.mjs',
  });
  assert.equal(kill.length, 0);
  assert.equal(refused[0].reason, 'not-owned');
  assert.match(refused[0].detail, /somebody-else/);
});

test('#490 REFUSAL — node IN our tree with no test mark is spared (a hand-run dev server)  ⇐ WAS ELIGIBLE', () => {
  // ⛔ This is the one that would have hurt most in practice: a developer's own
  //    `node server.js` in the dev tree, holding no protected port because it
  //    was started on a spare one. Owned, right runtime, and NOT a test.
  const { kill, refused } = only({
    pid: 8008, cwd: '/srv/dev/manyhands', ports: [4000], command: 'node server.js',
  });
  assert.equal(kill.length, 0);
  assert.equal(refused[0].reason, 'no-test-mark');
});

test('#490 FAIL CLOSED — an empty devTrees refuses to select anything, and says why', () => {
  // The mirror of NO_FENCE. "We own nothing" must not compile to "everything
  // unprotected is ours" — that reading is silent, agreeable and machine-wide.
  assert.throws(
    () => selectStrays({
      candidates: [{ pid: 1, cwd: '/srv/dev/manyhands', command: 'node --test a.test.mjs' }],
      liveTrees: LIVE, devTrees: [], protectedPorts: PORTS,
    }),
    (e) => e.code === 'NO_SCOPE' && /denylist/.test(e.message),
  );
});

test('#490 a SIBLING of an owned tree is NOT owned by accident', () => {
  // Same hole #813 closed on the protection side, on the ownership side: a
  // naive startsWith() makes `manyhands-other` ours, and it is not.
  const { kill, refused } = selectStrays({
    ...base,
    devTrees: ['/srv/dev/manyhands'],
    candidates: [{ pid: 9, cwd: '/srv/dev/manyhands-other', command: 'node --test s.test.mjs' }],
  });
  assert.equal(kill.length, 0);
  assert.equal(refused[0].reason, 'not-owned');
});

test('#490 ORDER — a live-tree process keeps its OWN refusal reason, not the new one', () => {
  // ⚠️ The positive scope is applied LAST on purpose. The reason a thing was
  //    spared is evidence: if the live board started reporting `not-owned`
  //    instead of `live-tree`, #813's control would silently stop testing #813.
  const { refused } = only({
    pid: 23259, cwd: '/srv/live/manyhands', ports: [3141], command: 'node server.js',
  });
  assert.equal(refused[0].reason, 'live-tree');
});

// ─── THE POSITIVE PLANTS — so none of the above is vacuous ───────────────────

test('#490 POSITIVE — an orphaned RUNNER is selected (the half the env-var predicate misses)', () => {
  // ⭐ #490's documented too-narrow hole, third instance found 2026-08-24 in
  //    this project's own recommended sweep: fixture SERVERS carry
  //    SCRUM_BOARD_FILE, orphaned RUNNERS carry nothing. A selector built on
  //    the env var alone reports success with half the leak still running.
  const { kill } = only({
    pid: 10628, ppid: 1, cwd: '/srv/dev/manyhands',
    command: 'node --test /tmp/rt735-x/a-hang.test.mjs',
  });
  assert.deepEqual(kill.map((c) => c.pid), [10628]);
  assert.equal(kill[0].mark, 'node-test-runner');
});

test('#490 POSITIVE — an orphaned fixture SERVER is selected, and by its env not its name', () => {
  const { kill } = only({
    pid: 91002, ppid: 1, cwd: '/srv/dev/manyhands', ports: [54771],
    command: 'node server.js',
    env: 'SCRUM_BOARD_FILE=/tmp/scrum-test-board-abc.json',
  });
  assert.deepEqual(kill.map((c) => c.pid), [91002]);
  assert.equal(kill[0].mark, 'fixture-board-file');
});

test('#490 a selected candidate carries WHY it was selected, so a plan can be audited', () => {
  // A plan that prints only pids asks the operator to re-derive the selection
  // by eye — which is precisely what #813's incident was.
  const { kill } = only({
    pid: 5, cwd: '/srv/dev/manyhands/sub', command: 'node --test deep.test.mjs',
  });
  assert.equal(kill[0].ownedBy, '/srv/dev/manyhands');
  assert.equal(kill[0].mark, 'node-test-runner');
});
