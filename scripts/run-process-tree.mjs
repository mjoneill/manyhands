import { execFileSync, spawn } from 'node:child_process';

/**
 * #752 — THE PINNED INSTRUMENT.
 *
 * Absolute path so a directory on PATH cannot redefine what "the process table"
 * means, and the exact unscoped argv so COMPLETENESS IS CARRIED BY THE REQUEST
 * rather than inferred from the answer.
 *
 * Rounds 1-3 all tried to infer it: ps-exception, then exit code, then parse,
 * then a self row, then self + init. Each closed the mutant in front of it and
 * left the class open, because no predicate over returned rows can tell a
 * complete table from a scoped one that satisfies the predicate — `ps -p 1,<self>`
 * defeats every witness anyone proposed while hiding a live child.
 */
const PS_BIN = '/bin/ps';
const PS_ARGS = ['-axo', 'pid=,ppid=,pgid='];

/**
 * The process table, and whether we actually observed it.
 *
 * `exec` is injectable so the pinned invocation can be SPIED — the executable and
 * argv are asserted the same way #745 pins the group kill's negative pgid, because
 * a mechanism nothing observes is a mechanism a refactor can silently remove.
 */
export function readTable(exec = execFileSync, selfPid = process.pid) {
  let out;
  try {
    out = String(exec(PS_BIN, PS_ARGS));
  } catch {
    // Ruling B: no discovery, no PATH fallback — but say WHICH instrument is
    // missing. /bin/ps is absent on NixOS and some minimal containers, and the
    // repo declares no platform, so an anonymous failure there reads as a broken
    // verifier rather than an unmet precondition.
    return { ok: false, rows: [], reason: `process-table reader unavailable: ${PS_BIN}` };
  }

  const rows = [];
  for (const line of out.split('\n')) {
    const text = line.trim();
    if (text === '') continue;
    const parts = text.split(/\s+/);
    // ⚠️ ANY unparsable row invalidates the WHOLE observation. The previous
    // version FILTERED them, which is how "some of this is unreadable" becomes
    // "this is what there is" — the same act as discarding a failed read, one
    // line up from where five rounds of review were looking.
    if (parts.length !== 3) {
      return { ok: false, rows: [], reason: `unparsable process-table row: ${JSON.stringify(text)}` };
    }
    const [pid, ppid, pgid] = parts.map(Number);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isInteger(pgid)) {
      return { ok: false, rows: [], reason: `unparsable process-table row: ${JSON.stringify(text)}` };
    }
    rows.push({ pid, ppid, pgid });
  }

  // Self is ANTI-VACUITY, not proof of completeness: it catches an instrument
  // that returned something unrelated, and claims nothing about scope. Scope is
  // held by PS_ARGS above.
  if (!rows.some((r) => r.pid === selfPid)) {
    return { ok: false, rows, reason: `reader (pid ${selfPid}) absent from its own process table` };
  }
  return { ok: true, rows };
}

/**
 * Rows only, for callers whose failure behaviour is already safe: `descendants`
 * finds fewer processes to kill (the pid loop still runs), and `groupsToSignal`
 * fails closed on an unknown self-pgid. Neither converts an empty table into a
 * CLAIM, which is what made verifyStopped different.
 */
function table() {
  return readTable().rows;
}

function descendants(rootPid) {
  const rows = table();
  const pids = new Set([rootPid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const { pid, ppid } of rows) {
      if (pids.has(ppid) && !pids.has(pid)) {
        pids.add(pid);
        changed = true;
      }
    }
  }
  return rows.filter(({ pid }) => pids.has(pid));
}

function merge(captured, rows) {
  for (const { pid, pgid } of rows) {
    captured.pids.add(pid);
    captured.groups.add(pgid);
  }
}

/**
 * #745 — our own process group, taken from a ps snapshot the caller already has.
 * Node exposes no `process.pgid`.
 *
 * Returns `null` when our row is absent, and the caller MUST treat that as
 * "cannot protect ⇒ signal nothing". Round one returned NaN and compared with
 * `!==`, which is always true, so an unreadable value disabled the guard rather
 * than engaging it. Re-reading from the current table is robustness; FAILING
 * CLOSED is the safety property, and it lives in the consumer.
 */
function selfGroup(rows) {
  const row = rows.find((r) => r.pid === process.pid);
  return row ? row.pgid : null;
}

/**
 * #747 — the production composition, exported so it can be WITNESSED.
 *
 * #745 proved the consumer fails closed given a bad value. It did not prove a
 * good value is ever produced, because this line was unexported and unasserted.
 * That gap is load-bearing precisely BECAUSE the guard fails closed: if this
 * returns null the group kill switches off silently, the per-pid loop still runs,
 * and the run still looks terminated — until a process appears between ps scans
 * inside the group, which is the only case the group path exists for.
 *
 * The ordinary input that breaks it: any edit to `table()`'s parse or filter that
 * drops the caller's own row.
 */
export function currentSelfGroup() {
  return selfGroup(table());
}

/**
 * #745 — which captured groups may be signalled.
 *
 * Pure and exported so the guards are pinned by assertion rather than by the
 * `detached: true` assumption twenty lines away. Two rules beyond the original
 * liveness check:
 *
 *   pgid <= 1        `kill(-1, ...)` signals every process the user can signal.
 *   pgid === SELF    the runner would SIGKILL itself mid-run. Safe today ONLY
 *                    because the child is spawned detached and descendants
 *                    inherit that fresh group — a property held elsewhere in the
 *                    file, which a refactor can remove without failing anything.
 */
export function groupsToSignal(captured, current, selfPgid) {
  // ⚠️ FAIL CLOSED. Round one used NaN for "unknown" with `!==`, which is ALWAYS
  // true — an unreadable pgid DISABLED the protection instead of engaging it.
  // Found by two reviewers, reproduced against our own live group. A guard that
  // cannot identify what it protects must not fire; the per-pid cleanup in
  // kill() still runs, so nothing leaks.
  if (!Number.isInteger(selfPgid) || selfPgid <= 1) return [];
  return [...captured.groups].filter((pgid) => (
    Number.isInteger(pgid)
    && pgid > 1
    && pgid !== selfPgid
    && current.some((row) => row.pgid === pgid && captured.pids.has(row.pid))
  ));
}

/**
 * #745 — send SIGKILL to each group. Exported with an injectable killer because
 * the MINUS SIGN is the entire mechanism and an outcome assertion cannot see it:
 * the pid loop below covers the same processes for the current fixture, so
 * deleting the group path leaves the suite green. A spy pins what redundancy
 * hides.
 */
export function signalGroups(pgids, killFn = process.kill) {
  for (const pgid of pgids) {
    // ⚠️ Revalidated HERE, not only upstream. Reachable inputs and what they did:
    //     1   → kill(-1)  every process the user owns
    //     0   → kill(0)   our own group, by another name
    //    -5   → kill(5)   ⚠️ a BARE POSITIVE PID — the group kill degraded into
    //                     the single-pid kill the spy exists to catch, through
    //                     ordinary input rather than a future refactor
    if (!Number.isInteger(pgid) || pgid <= 1) continue;
    try { killFn(-pgid, 'SIGKILL'); } catch { /* already stopped */ }
  }
}

function kill(captured) {
  // One snapshot for both the liveness check and our own group. If our row is
  // missing, selfGroup returns null and groupsToSignal signals nothing.
  const current = table();
  signalGroups(groupsToSignal(captured, current, selfGroup(current)));
  for (const pid of captured.pids) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already stopped */ }
  }
}

/**
 * #752 — "terminated" may be asserted ONLY after a successful read observes every
 * captured pid absent. A failed read is not evidence of anything; we keep polling,
 * and if every observation through the deadline was unavailable we return false so
 * the alarm says "cleanup could not be verified" rather than manufacturing comfort.
 *
 * Exported with an injectable observer because the previous version could be READ
 * but not MEASURED — the defect was confirmed by eye and could not be driven
 * without replicating it, and a replica tests the reading rather than the code.
 * Same unexported-therefore-unwitnessed shape as #747, one function along.
 */
export async function verifyStopped(captured, timeout = 2000, observe = readTable) {
  const deadline = Date.now() + timeout;
  do {
    const { ok, rows } = observe();
    if (ok && !rows.some(({ pid }) => captured.pids.has(pid))) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  return false;
}

/**
 * Runs one suite command in its own group. The tree is sampled while it runs so
 * a descendant that starts its own session remains an explicit kill target.
 */
export function runBoundedProcessTree({ file, args, cwd, timeout }) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let terminating = false;
    const captured = { pids: new Set([child.pid]), groups: new Set([child.pid]) };
    const sample = () => merge(captured, descendants(child.pid));
    const sampler = setInterval(sample, 25);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearInterval(sampler);
      clearTimeout(deadline);
      resolve({ stdout, stderr, timedOut, ...result });
    };
    const deadline = setTimeout(async () => {
      if (settled) return;
      timedOut = true;
      terminating = true;
      sample();
      kill(captured);
      finish({ code: null, terminationVerified: await verifyStopped(captured) });
    }, timeout);

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => { if (!terminating) finish({ code, terminationVerified: true }); });
    child.on('error', () => { if (!terminating) finish({ code: 1, terminationVerified: true }); });
  });
}
