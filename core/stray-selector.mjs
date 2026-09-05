/**
 * core/stray-selector.mjs — #813. Deciding WHAT NOT TO KILL, as a pure function.
 *
 * 2026-08-15, clearing leaked test servers:
 *
 *     pkill -f "node server.js" -o
 *
 * `-o` selects the OLDEST match. The oldest was the LIVE BOARD. Four commands
 * earlier the operator had printed, in their own output:
 *
 *     pid 23259  cwd=<HOME>/<live-tree>  ⛔ LIVE — DO NOT TOUCH
 *
 * (The real path is elided. #490 predicted this exact refusal: a reaper that
 *  ships carrying the real never-touch list publishes the machine's operational
 *  fingerprint, and "no seat names, no board signatures" means every mechanical
 *  layer waves it through — except the one that didn't. The LESSON is that the
 *  operator had already identified the live pid by hand; the PATH is not part
 *  of the lesson, and separating them costs nothing here.)
 *
 * and then wrote a selector that could reach it anyway.
 *
 * ⇒ KNOWING WHICH PID IS LIVE IS NOT THE SAME AS WRITING A COMMAND THAT CANNOT
 *   REACH IT. The knowledge was present, correct, and thirty seconds old. It
 *   simply was not expressed in the command — and only the command runs.
 *
 * So the decision lives here, as data in and data out, and the thing that sends
 * signals consumes this and cannot form a target any other way. A rail, not a
 * promise: the second failure in this class followed a written personal note,
 * and a note that depends on the actor remembering it at the moment of action
 * is a hope with formatting.
 *
 * ── WHY AGE IS NEVER A SELECTOR ───────────────────────────────────────────
 * On any machine that has been up a while, THE OLDEST PROCESS IN A CLASS IS BY
 * DEFINITION THE PRODUCTION ONE. A flag meaning "oldest" means "production" in
 * practice, and leaked test children are always the NEWEST. `-o`/`-n` are not
 * mistakes to use carefully; they are inverted by construction. Nothing here
 * reads a start time.
 *
 * ── WHY ppid IS NOT A DISCRIMINATOR ON macOS ──────────────────────────────
 * #813 proposed refusing processes "whose parent is launchd". Measured while
 * building this: launchd IS pid 1, and an ORPHANED process is reparented to
 * pid 1 too. So `ppid === 1` matches both the service we must never touch and
 * the leaked fixtures of #998 that we exist to clear. It cannot separate them
 * and is deliberately NOT used. Recorded because it is a plausible-sounding
 * guard that would have produced a rail with a hole in it.
 *
 * ── #490: A DENYLIST FENCE IS NOT OWNERSHIP ───────────────────────────────
 * Everything above answers "is this candidate PROTECTED?" — and a candidate
 * that is protected by nothing falls through to `kill`. That is a denylist,
 * and a denylist protects only what someone remembered to list.
 *
 * ⛔ MEASURED 2026-09-04: #490's PRIMARY RULE — "the reaper touches only Node
 *    processes, and only those with a cwd inside the twin" — existed in the
 *    card and NOWHERE IN CODE. The Node-only half lived entirely in the
 *    caller's `SCRUM_STRAY_PATTERN`, an operator-supplied substring whose
 *    default is the bare name match requirement 2 forbids. Point that env var
 *    at another runtime and this function returns another project's processes
 *    as eligible, having refused nothing, because they are in no live tree.
 *
 * ⇒ So `devTrees` is a POSITIVE scope and it is REQUIRED: a candidate must
 *   prove it is OURS — node, in a tree we own, carrying a test-ownership mark
 *   — before it can be signalled. Absence of protection is not ownership.
 *
 * ⚠️ It is applied LAST, so every refusal above keeps its own reason. A
 *   candidate refused as `live-tree` must not start reporting `not-owned`:
 *   the reason a thing was spared is evidence, and this layer is additive.
 *
 * ⭐ AND IT DOES NOT READ CPU, RSS OR DURATION. #490 names the trap directly:
 *   another project on the same machine runs a job that sits for minutes at
 *   high CPU holding several GB and then exits, so it looks exactly like a
 *   runaway orphan while being load-bearing every time it runs. A heuristic
 *   that would catch it is a heuristic that is wrong, and duration/CPU must
 *   never override the Node-only scope.
 *
 * ⛔ THE SHAPE IS THE LESSON; THE PROJECT'S NAME IS NOT, AND DOES NOT SHIP.
 *   An earlier cut of this comment named it. The push gate refused, correctly:
 *   a reaper that carries the real never-touch inventory publishes the
 *   machine's operational fingerprint — what runs beside this, and when. The
 *   engine is public and knows only shapes; the inventory is private.
 */

/**
 * Does this candidate carry a mark that makes it OURS to reap?
 *
 * ⛔ NOT a name match. `node server.js` describes the live board as accurately
 *    as it describes an orphan — that is requirement 2, and it is why the
 *    #813 caller's default pattern could never have been the discriminator.
 *
 * The stable marks, taken from what tests/helpers/harness.mjs actually spawns:
 *   · SCRUM_BOARD_FILE pointing at a scrum-test-board-* fixture  (spawned server)
 *   · `--test` in the command line                               (orphaned runner)
 *   · a *.test.mjs argument                                      (orphaned runner)
 *
 * ⚠️ The runner marks exist because #490's documented hole is that fixture
 *    servers carry the env var and orphaned RUNNERS carry nothing — so a
 *    selector built on the env var alone reports success with half the leak
 *    still running. The third instance of that hole was found 2026-08-24, in
 *    this project's own recommended sweep command.
 */
function ownershipMark(c) {
  const cmd = String(c.command || '');
  const env = String(c.env || '');
  if (/scrum-test-board-/.test(env) || /scrum-test-board-/.test(cmd)) return 'fixture-board-file';
  if (/(^|\s)--test(\s|$)/.test(cmd)) return 'node-test-runner';
  if (/\S+\.test\.mjs(\s|$)/.test(cmd)) return 'test-file-argument';
  return null;
}

/**
 * Is the executable node? Positive, and on the FIRST token only.
 *
 * ⛔ `cmd.includes('node')` would match a python script called `node_tool.py`
 *    and every path containing `node_modules` — which is most of them.
 */
function isNode(c) {
  const first = String(c.command || '').trim().split(/\s+/)[0] || '';
  return /(^|\/)node(\d+(\.\d+)*)?$/.test(first);
}

/** A refusal carries its reason, so a caller can print WHY rather than a count. */
const refuse = (p, reason, detail) => ({ pid: p.pid, reason, detail });

/**
 * Decide which candidates may be signalled.
 *
 * Every input is explicit — nothing is discovered in here, so a test can pose
 * any situation including the exact one that took production down.
 *
 * @param candidates      [{ pid, cwd, ports?, command? }]  cwd may be null (unreadable)
 * @param liveTrees       absolute paths that must never be signalled from
 * @param protectedPorts  listening ports that mark a process as live
 * @param selfPid/selfPgid the runner's own identity — never signal yourself
 * @returns { kill: [...candidates], refused: [{pid, reason, detail}] }
 */
export function selectStrays({
  candidates = [],
  liveTrees = [],
  devTrees = [],
  protectedPorts = [],
  selfPid = null,
  selfPgid = null,
} = {}) {
  // Fail closed on a missing fence. An empty liveTrees list would otherwise
  // read as "nothing is protected" — which is exactly the state in which this
  // function is most dangerous and looks most agreeable.
  if (!Array.isArray(liveTrees) || liveTrees.length === 0) {
    const err = new Error(
      'selectStrays: liveTrees is empty. Refusing to select ANY target.\n' +
      '  An empty protection list is indistinguishable from "nothing is live",\n' +
      '  and that is the reading under which this function kills production.',
    );
    err.code = 'NO_FENCE';
    throw err;
  }

  // ⛔ And fail closed on a missing POSITIVE scope, for the mirror-image reason.
  // An empty devTrees list reads as "we own nothing", but the code path it
  // produces is "every unprotected process on the machine is eligible" — the
  // failure is silent, agreeable, and machine-wide. A tracked default here
  // would be a fence that ships: correct on one machine, wrong on every clone.
  if (!Array.isArray(devTrees) || devTrees.length === 0) {
    const err = new Error(
      'selectStrays: devTrees is empty. Refusing to select ANY target.\n' +
      '  Ownership is what makes a process ours to signal. Without it this\n' +
      '  function selects by ABSENCE of protection, which is a denylist, and a\n' +
      '  denylist protects only what someone remembered to list.',
    );
    err.code = 'NO_SCOPE';
    throw err;
  }

  const roots = liveTrees.map((t) => String(t).replace(/\/+$/, ''));
  const owned = devTrees.map((t) => String(t).replace(/\/+$/, ''));
  const ports = new Set(protectedPorts.map(Number));

  const kill = [];
  const refused = [];

  for (const c of candidates) {
    if (selfPid != null && c.pid === selfPid) {
      refused.push(refuse(c, 'self', 'the runner does not signal itself'));
      continue;
    }
    if (selfPgid != null && c.pgid != null && c.pgid === selfPgid) {
      refused.push(refuse(c, 'self-group', `pgid ${c.pgid} is the runner's own group`));
      continue;
    }
    // Unreadable cwd ⇒ REFUSE. #752's lesson one layer over: an instrument that
    // could not read is not an instrument that read "no". Treating an unknown
    // as safe-to-kill is how a permissions blip becomes an outage.
    if (!c.cwd) {
      refused.push(refuse(c, 'unknown-cwd', 'cwd unreadable — cannot prove it is not live'));
      continue;
    }
    const cwd = String(c.cwd).replace(/\/+$/, '');
    const tree = roots.find((r) => cwd === r || cwd.startsWith(`${r}/`));
    if (tree) {
      refused.push(refuse(c, 'live-tree', `cwd ${cwd} is inside ${tree}`));
      continue;
    }
    const held = (c.ports || []).map(Number).filter((p) => ports.has(p));
    if (held.length) {
      refused.push(refuse(c, 'protected-port', `listening on ${held.join(', ')}`));
      continue;
    }
    // ── #490 POSITIVE SCOPE. Everything above asked "is it protected?"; these
    // three ask "is it OURS?" — and a candidate that cannot answer is spared.
    if (!isNode(c)) {
      const exe = String(c.command || '').trim().split(/\s+/)[0] || '(no command)';
      refused.push(refuse(c, 'not-node', `${exe} is not a node process`));
      continue;
    }
    const home = owned.find((r) => cwd === r || cwd.startsWith(`${r}/`));
    if (!home) {
      refused.push(refuse(c, 'not-owned', `cwd ${cwd} is in no tree we own`));
      continue;
    }
    const mark = ownershipMark(c);
    if (!mark) {
      refused.push(refuse(c, 'no-test-mark', 'node in our tree, but nothing marks it as a TEST process'));
      continue;
    }
    kill.push({ ...c, ownedBy: home, mark });
  }

  return { kill, refused };
}
