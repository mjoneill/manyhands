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
 */

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

  const roots = liveTrees.map((t) => String(t).replace(/\/+$/, ''));
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
    kill.push(c);
  }

  return { kill, refused };
}
