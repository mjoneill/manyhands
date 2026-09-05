import test from 'node:test';
import assert from 'node:assert/strict';
import { selectStrays } from '../core/stray-selector.mjs';

// ⚠️ Fixture paths are deliberately NOT home-directory shaped. #837's guard
// forbids /Users/<name>/ and ~/ in tracked string literals, and it caught this
// file on the first run — the fence's SHAPE is what the selector reasons about,
// so any absolute root exercises it identically.
const LIVE = ['/srv/live/manyhands', '/srv/live/manyhands-serve'];
// #490 — the POSITIVE scope. Everything reachable by this selector must be
// inside one of these AND be node AND carry a test-ownership mark. Supplying
// it in every case below is deliberate: `devTrees` is required, so a test that
// omitted it would be asserting the fail-closed path by accident.
const DEV = ['/srv/dev/manyhands'];
const PORTS = [3141, 3001];

// The situation of 2026-08-15, reconstructed from #813's own record: the live
// board and a leaked test child, in one candidate list, with the live one OLDER.
const THE_INCIDENT = [
  { pid: 23259, cwd: '/srv/live/manyhands', ports: [3141], command: 'node server.js' },
  // ⚠️ cwd is the DEV TREE, not the tmpdir. tests/helpers/harness.mjs spawns
  // `node server.js` with `cwd: PROJECT_DIR`; only SCRUM_BOARD_FILE points at
  // the fixture. An earlier version of this fixture put the tmpdir in cwd,
  // which no real leak has ever looked like.
  {
    pid: 91002, cwd: '/srv/dev/manyhands', ports: [54771], command: 'node server.js',
    env: 'SCRUM_BOARD_FILE=/tmp/scrum-test-board-abc.json',
  },
];

test('#813 THE CONTROL — the live board is REFUSED, and the refusal names why', () => {
  // ⛔ This asserts on the REFUSAL, not on the absence of harm. "Nothing bad
  // happened" is satisfied by a no-op, by a typo in the selector, and by a
  // function that was never called — #813's acceptance says so explicitly.
  const { refused } = selectStrays({
    candidates: THE_INCIDENT, liveTrees: LIVE, devTrees: DEV, protectedPorts: PORTS,
  });
  const board = refused.find((r) => r.pid === 23259);
  assert.ok(board, 'the live board must appear in the REFUSED list');
  assert.equal(board.reason, 'live-tree');
  assert.match(board.detail, /manyhands/, 'the refusal names the tree that protected it');
});

test('#813 POSITIVE CONTROL — the leaked child IS selected, so refusing is not vacuous', () => {
  // ⭐ Without this, a selectStrays() that refused EVERYTHING would pass every
  // refusal test above and below, and the rail would be a no-op that reads safe.
  const { kill } = selectStrays({
    candidates: THE_INCIDENT, liveTrees: LIVE, devTrees: DEV, protectedPorts: PORTS,
  });
  assert.deepEqual(kill.map((c) => c.pid), [91002],
    'exactly the leaked test child, and nothing else');
});

test('#813 AGE IS NOT A SELECTOR — the OLDEST candidate is the one protected', () => {
  // The whole trap in one assertion: `-o` means "oldest", and on a machine that
  // has been up a while the oldest process in a class IS production. Order the
  // list oldest-first and the protected pid is still the protected pid.
  const { kill, refused } = selectStrays({
    candidates: THE_INCIDENT, liveTrees: LIVE, devTrees: DEV, protectedPorts: PORTS,
  });
  assert.equal(refused[0].pid, THE_INCIDENT[0].pid, 'first/oldest candidate refused');
  assert.ok(!kill.some((c) => c.pid === THE_INCIDENT[0].pid));
});

test('#813 FAIL CLOSED — an empty liveTrees list refuses to select anything at all', () => {
  // An empty fence reads as "nothing is live", which is the state in which this
  // function is most dangerous and looks most agreeable.
  assert.throws(
    () => selectStrays({ candidates: THE_INCIDENT, liveTrees: [], devTrees: DEV, protectedPorts: PORTS }),
    (e) => e.code === 'NO_FENCE',
  );
});

test('#813 FAIL CLOSED — an unreadable cwd is refused, not assumed safe', () => {
  const { kill, refused } = selectStrays({
    candidates: [{ pid: 5, cwd: null, command: 'node server.js' }],
    liveTrees: LIVE, devTrees: DEV, protectedPorts: PORTS,
  });
  assert.equal(kill.length, 0);
  assert.equal(refused[0].reason, 'unknown-cwd');
});

test('#813 a process holding a protected port is refused even from an unknown tree', () => {
  const { kill, refused } = selectStrays({
    candidates: [{ pid: 7, cwd: '/somewhere/else', ports: [3001], command: 'node --test p.test.mjs' }],
    liveTrees: LIVE, devTrees: DEV, protectedPorts: PORTS,
  });
  assert.equal(kill.length, 0);
  assert.equal(refused[0].reason, 'protected-port');
  assert.match(refused[0].detail, /3001/);
});

test('#813 the runner never signals itself or its own process group', () => {
  const { kill, refused } = selectStrays({
    candidates: [
      // ⚠️ All three are OWNED and marked — otherwise #490's positive scope
      // would refuse pid 102 for being unidentifiable and this test would pass
      // for the wrong reason, proving nothing about self-signalling.
      { pid: 100, cwd: '/srv/dev/manyhands', command: 'node --test x.test.mjs' },
      { pid: 101, cwd: '/srv/dev/manyhands', pgid: 999, command: 'node --test y.test.mjs' },
      { pid: 102, cwd: '/srv/dev/manyhands', command: 'node --test z.test.mjs' },
    ],
    liveTrees: LIVE, devTrees: DEV, protectedPorts: PORTS, selfPid: 100, selfPgid: 999,
  });
  assert.deepEqual(refused.map((r) => r.reason), ['self', 'self-group']);
  assert.deepEqual(kill.map((c) => c.pid), [102]);
});

test('#813 a trailing slash on a live tree does not open a hole', () => {
  const { kill, refused } = selectStrays({
    candidates: [{ pid: 8, cwd: '/srv/live/manyhands/core', command: 'node --test t.test.mjs' }],
    liveTrees: ['/srv/live/manyhands/'], devTrees: DEV, protectedPorts: PORTS,
  });
  assert.equal(kill.length, 0);
  assert.equal(refused[0].reason, 'live-tree');
});

test('#813 a SIBLING whose name merely prefixes a live tree is NOT protected by accident', () => {
  // `manyhands-serve` must not be shielded by a fence naming `manyhands`, and a
  // naive startsWith() would do exactly that — protecting a real stray and
  // making the rail quietly useless rather than quietly dangerous.
  const { kill } = selectStrays({
    candidates: [{ pid: 9, cwd: '/srv/live/manyhands-other', command: 'node --test s.test.mjs' }],
    liveTrees: ['/srv/live/manyhands'], devTrees: ['/srv/live/manyhands-other'], protectedPorts: PORTS,
  });
  assert.deepEqual(kill.map((c) => c.pid), [9], 'a sibling path is not inside the tree');
});
