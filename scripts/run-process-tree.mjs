import { execFileSync, spawn } from 'node:child_process';

function table() {
  try {
    return String(execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=']))
      .split('\n')
      .map((line) => line.trim().split(/\s+/).map(Number))
      .filter(([pid, ppid, pgid]) => Number.isInteger(pid) && Number.isInteger(ppid) && Number.isInteger(pgid))
      .map(([pid, ppid, pgid]) => ({ pid, ppid, pgid }));
  } catch {
    return [];
  }
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
 * #745 — our own process group, read once. Node exposes no `process.pgid`, so it
 * comes from ps. Resolved at module load rather than per call: it cannot change
 * for a running process, and a failed read must not silently become "no group to
 * protect" on every subsequent kill.
 */
const SELF_PGID = (() => {
  try {
    return Number(String(execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)])).trim());
  } catch {
    return NaN;   // unknown: the pgid comparison below simply never matches
  }
})();

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
export function groupsToSignal(captured, current, selfPgid = SELF_PGID) {
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
    try { killFn(-pgid, 'SIGKILL'); } catch { /* already stopped */ }
  }
}

function kill(captured) {
  signalGroups(groupsToSignal(captured, table()));
  for (const pid of captured.pids) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already stopped */ }
  }
}

async function verifyStopped(captured, timeout = 2000) {
  const deadline = Date.now() + timeout;
  do {
    if (!table().some(({ pid }) => captured.pids.has(pid))) return true;
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
