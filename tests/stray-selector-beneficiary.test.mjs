/**
 * tests/stray-selector-beneficiary.test.mjs — #490 requirement F, the half the
 * BENEFICIARY writes: prove the selector spares the shapes that another
 * project's work actually takes on this machine.
 *
 * ⚠️ WHY THESE ARE NOT THE SAME AS THE EXISTING not-node PLANTS.
 *
 * The ownership suite already plants `/opt/py/bin/python3 extract.py` and
 * refuses it. That is a correct plant and it is SIMPLER THAN REALITY: a
 * lowercase, version-suffixed interpreter sitting directly on PATH.
 *
 * Observed on a real box, the shapes a long-running non-Node job actually
 * takes are different in ways that touch the regex:
 *
 *   · a framework build's argv[0] basename is `Python` — CAPITALISED, no
 *     version suffix, buried under `…/Foo.app/Contents/MacOS/Python`
 *   · a virtualenv's argv[0] basename is bare `python`, no digits
 *   · the path is long and contains many segments, any of which a substring
 *     test would happily match
 *
 * ⛔ None of these carries the token the fixture plants carry, so a regression
 *    that loosened `isNode` — say to a substring test, or to a
 *    case-insensitive one — would keep passing the existing plants while
 *    reaching a real process. These exist so that loosening has a witness.
 *
 * ⭐ AND THE POINT OF THE SHAPE, per section C: this class of job sits for
 *   minutes at high CPU holding several GB, then exits, reparented to pid 1.
 *   It looks EXACTLY like a runaway orphan by every heuristic a reaper is
 *   tempted to use, while being load-bearing every time it runs. The plants
 *   below carry that profile deliberately — heavy, old, ppid 1, no ports — so
 *   that any future duration/CPU/lineage heuristic fails here first.
 *
 * ⛔ SYNTHETIC NAMES ONLY. The shape is the lesson; the inventory is private
 *    and does not ship. See section A.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectStrays } from '../core/stray-selector.mjs';

const LIVE = ['/srv/live-tree'];
const OWNED = ['/srv/dev/manyhands'];

/** The shape a framework-build interpreter actually presents in `ps`. */
const FRAMEWORK_PY = '/opt/pkg/Cellar/pyish@3.12/3.12.13/Frameworks/Pyish.framework'
  + '/Versions/3.12/Resources/Pyish.app/Contents/MacOS/Pyish';

test('a framework-build interpreter is refused — capitalised basename, no version suffix', () => {
  const { kill, refused } = selectStrays({
    candidates: [{
      pid: 4242,
      ppid: 1,                       // reparented — looks orphaned
      cwd: '/srv/other/long-job',
      command: `${FRAMEWORK_PY} /srv/other/long-job/batch_job.py`,
      ports: [],
    }],
    liveTrees: LIVE,
    devTrees: OWNED,
  });

  assert.equal(kill.length, 0, 'another project\'s interpreter must never be eligible');
  assert.equal(refused[0].reason, 'not-node');
  // The refusal has to NAME what it saw, or the beneficiary cannot audit it.
  assert.match(refused[0].detail, /MacOS\/Pyish\b/,
    'the refusal quotes the executable it rejected, so the beneficiary can audit it');
});

test('a virtualenv interpreter is refused — bare lowercase basename, no digits', () => {
  const { kill, refused } = selectStrays({
    candidates: [{
      pid: 4243,
      ppid: 1,
      cwd: '/srv/other/long-job',
      command: '/srv/other/long-job/.venv/bin/pyish scheduler_job.py',
      ports: [],
    }],
    liveTrees: LIVE,
    devTrees: OWNED,
  });

  assert.equal(kill.length, 0);
  assert.equal(refused[0].reason, 'not-node');
});

/**
 * ⛔ THE ONE THAT MATTERS MOST, and the reason a beneficiary writes this file.
 *
 * Every prior refusal is `not-node`, so all of them would survive a regression
 * that ONLY affected the ownership marks. This one removes that escape: the
 * process is inside a tree we own — a plausible arrangement, since another
 * project's checkout can sit beside ours — and it is STILL refused, on the
 * runtime, before ownership is ever consulted.
 */
test('a non-node process INSIDE an owned tree is still refused on runtime', () => {
  const { kill, refused } = selectStrays({
    candidates: [{
      pid: 4244,
      ppid: 1,
      cwd: '/srv/dev/manyhands/vendor/other-project',   // ⇐ inside devTrees
      command: `${FRAMEWORK_PY} /srv/dev/manyhands/vendor/other-project/batch_job.py`,
      ports: [],
    }],
    liveTrees: LIVE,
    devTrees: OWNED,
  });

  assert.equal(kill.length, 0, 'ownership must not rescue a foreign runtime');
  assert.equal(refused[0].reason, 'not-node',
    'the runtime check must fire BEFORE ownership, so a shared tree cannot widen the scope');
});

/**
 * ⛔ THE SUBSTRING PLANT — and it exists because the first draft of this file
 *    CLAIMED this coverage in its header and did not have it.
 *
 * The three plants above all fail a substring test for the token `node` too,
 * so a regression from the anchored regex to `command.includes('node')` would
 * keep every one of them green. The selector's own comment names the real
 * hazard — "every path containing node_modules, which is most of them" — so
 * the witness has to be a NON-node executable whose PATH contains that token.
 * A vendored tool under `node_modules/.bin` is the ordinary way that happens.
 */
test('a non-node executable under a node_modules path is refused', () => {
  const { kill, refused } = selectStrays({
    candidates: [{
      pid: 4246,
      ppid: 1,
      cwd: '/srv/dev/manyhands',
      command: '/srv/dev/manyhands/node_modules/.bin/some-tool --watch',
      ports: [],
    }],
    liveTrees: LIVE,
    devTrees: OWNED,
  });

  assert.equal(kill.length, 0, 'a path containing "node" is not a node runtime');
  assert.equal(refused[0].reason, 'not-node',
    'the runtime test must read the basename, never the path as a substring');
});

/**
 * ⚠️ THE NEGATIVE CONTROL, so none of the above is vacuous.
 *
 * Identical situation — owned tree, ppid 1, no ports, a test mark — but a REAL
 * node runtime. If this does not come back eligible, the three refusals above
 * prove nothing: they would pass just as well against a selector that refuses
 * everything.
 */
test('control — the same shape with a node runtime IS eligible', () => {
  const { kill, refused } = selectStrays({
    candidates: [{
      pid: 4245,
      ppid: 1,
      cwd: '/srv/dev/manyhands',
      command: '/usr/local/bin/node --test /tmp/x/leaky.test.mjs',
      ports: [],
    }],
    liveTrees: LIVE,
    devTrees: OWNED,
  });

  assert.equal(refused.length, 0, 'the control must not be refused for an unrelated reason');
  assert.equal(kill.length, 1, 'a genuine owned stray must still be caught');
  assert.equal(kill[0].mark, 'node-test-runner');
});
