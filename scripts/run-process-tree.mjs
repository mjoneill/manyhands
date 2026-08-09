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

function kill(captured) {
  const current = table();
  for (const pgid of captured.groups) {
    if (!current.some((row) => row.pgid === pgid && captured.pids.has(row.pid))) continue;
    try { process.kill(-pgid, 'SIGKILL'); } catch { /* already stopped */ }
  }
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
