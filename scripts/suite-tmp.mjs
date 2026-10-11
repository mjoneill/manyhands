/**
 * #1672 — the suite owns its temp space. `scripts/run-test-files.mjs` creates ONE folder per run under the outer
 * TMPDIR (`manyhands-suite.<pid>.XXXXXX`), gives every test file its own sub-folder as that file's TMPDIR, and marks
 * every process it starts with a per-run token (MANYHANDS_SUITE_RUN). When the run ends, or is stopped by a signal,
 * `teardown()` settles the process tree BEFORE anything is removed, then counts and reports what each file left, then
 * removes the folder.
 *
 * Ownership is the token, nothing else: a detached descendant is reparented, so its ancestry proves nothing, but it
 * keeps its environment. A process whose own environment carries this run's token is ours: it is reported, killed and
 * waited for. A process that names the folder in its argv WITHOUT the token is not ours: it is never killed, the run
 * fails, and the folder is kept for a person to look at.
 *
 * ⛔ SECRETS. Reading another process's environment means reading whatever credentials it holds. It is read for exactly
 * one thing, whether this run's token is one of its entries (/proc on Linux; scripts/proc-env-owned.py, which returns
 * pids only, on macOS), and argv only for this folder's path. Nothing read is ever printed, logged or written.
 * Diagnostics name a process by pid, executable name and parent pid, and, for a process that is not ours, the test file
 * whose own folder it uses, found by testing the runner's own list of folders against it; never its argv, never its
 * environment, never text cut out of either.
 *
 * Limits, stated: a process that holds the folder open without naming it in its argv is not seen (no lsof); a runner
 * killed with SIGKILL runs none of this and leaves one identifiable `manyhands-suite.<pid>.*` folder; paths outside
 * TMPDIR are not covered.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const TOKEN_VAR = 'MANYHANDS_SUITE_RUN';
const SETTLE_MS = 5000;

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// A ZOMBIE answers kill(pid, 0) as if alive, but it has exited: it holds no open files, cannot be killed, and waits
// only for its parent to reap it. Counting it as alive COULD stall the settle loop for its whole bound, a possible
// mechanism for RN2's red on Linux CI at 8a3bb80 (#1672), not established. So it counts as gone here.
// Measured on macOS 2026-10-11: kill -0 → alive, ps stat → Z.
function isZombie(pid) {
  if (process.platform === 'linux') {
    try { const st = fs.readFileSync(`/proc/${pid}/stat`, 'latin1'); return /^[ZX]/.test(st.slice(st.lastIndexOf(')') + 2)); } catch { return false; }
  }
  try { return /^Z/.test(execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()); } catch { return false; }
}
const alive = (pid) => {
  try { process.kill(pid, 0); } catch (e) { if (e.code !== 'EPERM') return false; }
  return !isZombie(pid);
};

/** pid → executable name, for diagnostics. Never the argv. */
function exeName(pid) {
  try { return path.basename(execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' }).trim()) || '?'; } catch { return '?'; }
}

/** pid → parent pid, for diagnostics; '?' when it cannot be read. */
function parentOf(pid) {
  try { return execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || '?'; } catch { return '?'; }
}

/**
 * The process table, for one decision only: which pids are OURS (their ENVIRONMENT holds `marker` as one exact entry,
 * never their argv) and which name the folder in their argv. Returns { argv: Map<pid, string>, owned: Set<pid> }, or
 * null when it could not be read: a table we could not read authorises nothing (the caller fails and keeps the folder).
 *   Linux: /proc/<pid>/environ split on NUL, compared entry by entry.
 *   macOS: scripts/proc-env-owned.py reads the kernel's KERN_PROCARGS2 record (argv and environment as separate
 *          NUL-terminated strings, the record ps itself reads) — `ps -E` joins them with spaces, so a variable whose
 *          VALUE merely contained the token text would have read as owning it.
 * ⛔ The text never leaves this module and is never printed, logged or written: callers get pids only.
 */
function inspectProcesses(marker) {
  const argv = new Map();
  const owned = new Set();
  const undecidable = new Set();   // macOS: a record whose layout we do not recognise — never killed, and the run fails
  if (process.platform === 'linux') {
    let pids;
    try { pids = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)); } catch { return null; }
    for (const p of pids) {
      try { argv.set(Number(p), fs.readFileSync(`/proc/${p}/cmdline`, 'latin1').replace(/\0/g, ' ')); } catch { continue; }
      try { if (fs.readFileSync(`/proc/${p}/environ`, 'latin1').split('\0').includes(marker)) owned.add(Number(p)); } catch { /* not ours to read */ }
    }
    return { argv, owned, undecidable };
  }
  try {
    const raw = execFileSync('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    for (const line of raw.split('\n')) { const r = /^\s*(\d+)\s(.*)$/.exec(line); if (r) argv.set(Number(r[1]), r[2]); }
    // the marker goes in on stdin, never on the helper's argv (that would make the helper an argv holder of the token)
    const out = execFileSync('/usr/bin/python3', [path.join(path.dirname(fileURLToPath(import.meta.url)), 'proc-env-owned.py')],
      { input: `${marker}\n${[...argv.keys()].join('\n')}\n`, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    for (const line of out.split('\n')) {
      if (/^\d+$/.test(line)) owned.add(Number(line));
      else if (/^\?\d+$/.test(line)) undecidable.add(Number(line.slice(1)));
    }
  } catch { return null; }
  return { argv, owned, undecidable };
}

/** Bytes under `p`, not following links. */
function bytesUnder(p) {
  let st;
  try { st = fs.lstatSync(p); } catch { return 0; }
  if (!st.isDirectory()) return st.size;
  let n = 0;
  let names = [];
  try { names = fs.readdirSync(p); } catch { return 0; }
  for (const name of names) n += bytesUnder(path.join(p, name));
  return n;
}

/** What a folder holds at its top level: { entries, bytes }. */
export function measure(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return { entries: 0, bytes: 0 }; }
  let bytes = 0;
  for (const name of names) bytes += bytesUnder(path.join(dir, name));
  return { entries: names.length, bytes };
}

/** The set of test files a run tolerates leaking: the JSON array at TMP_LEAK_BASELINE, else the checked-in one. */
export function loadBaseline(root) {
  const file = process.env.TMP_LEAK_BASELINE || path.join(root, 'scripts', 'tmp-leak-baseline.json');
  let list;
  let problem = null;
  try { list = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { problem = e.code === 'ENOENT' ? 'missing' : 'unreadable'; }
  if (!problem && !Array.isArray(list)) problem = 'not a JSON array';
  // Fail-closed: an unusable baseline is treated as EMPTY, so every leaker reads as new and fails by name. The report
  // says why, so that reads as "the baseline is broken", not as forty new leaks.
  const set = new Set((problem ? [] : list).map((f) => path.resolve(root, f)));
  set.problem = problem ? `${path.relative(root, file) || file}: ${problem}` : null;
  return set;
}

/** Create this run's folder under the outer TMPDIR and its token. */
export function createSuiteTmp() {
  const outer = os.tmpdir();
  const dir = fs.mkdtempSync(path.join(outer, `manyhands-suite.${process.pid}.`));
  return { dir, token: randomUUID(), files: new Map(), index: 0 };
}

/** A fresh TMPDIR for one test file, inside the run's folder. */
export function fileTmp(suite, file) {
  const d = fs.mkdtempSync(path.join(suite.dir, `f${suite.index++}-`));
  suite.files.set(file, d);
  return d;
}

/**
 * Settle the process tree, then report and remove. Synchronous, so the same routine serves a normal finish and a
 * signal. Returns { failed: boolean, lines: string[] } — the caller prints the lines and folds `failed` into the verdict.
 */
export function teardown(suite, { root }) {
  const lines = [];
  let failed = false;
  const self = process.pid;
  const marker = `${TOKEN_VAR}=${suite.token}`;

  // 0. INSPECT. A table we could not read authorises nothing: the run fails and the folder is kept.
  const table = inspectProcesses(marker);
  if (table === null) {
    lines.push(`# tmp: ⛔ could not inspect processes (ps / /proc unreadable): nothing killed, folder RETAINED: ${suite.dir}`);
    return { failed: true, lines };
  }

  // 1. OURS, to a FIXED POINT: kill every process whose own ENVIRONMENT (never its argv) holds this run's exact token
  // entry, wait, and look again — a descendant can spawn another between two looks, and the folder must not be removed
  // under one. Repeat until a look finds no owned process left, within SETTLE_MS overall; anything still owned then is
  // reported, and the run fails and keeps the folder.
  const killed = new Set();
  let view = table;
  const deadline = Date.now() + SETTLE_MS;
  for (;;) {
    const owned = [...view.owned].filter((pid) => pid !== self && alive(pid));
    if (owned.length === 0) break;
    for (const pid of owned) {
      if (!killed.has(pid)) lines.push(`# tmp: owned process pid ${pid} (${exeName(pid)}) outlived its test file: a leak; killing it`);
      killed.add(pid);
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    while (Date.now() < deadline && owned.some(alive)) sleepSync(100);
    view = inspectProcesses(marker);
    if (view === null) {
      lines.push(`# tmp: ⛔ could not re-inspect processes after the kill: nothing more killed, folder RETAINED: ${suite.dir}`);
      return { failed: true, lines };
    }
    if (Date.now() >= deadline) break;
  }
  const stubborn = [...view.owned].filter((pid) => pid !== self && alive(pid));
  // a process whose ownership could not be decided is never killed, and the folder is not removed while it lives
  const undecided = [...view.undecidable].filter((pid) => pid !== self && alive(pid));
  for (const pid of undecided) lines.push(`# tmp: ⛔ process pid ${pid} (${exeName(pid)}): ownership could not be decided from its record: NOT killed`);
  for (const pid of stubborn) lines.push(`# tmp: ⛔ owned process pid ${pid} (${exeName(pid)}) still alive after ${SETTLE_MS} ms of kills`);

  // 2. NOT OURS: a process that names the folder in its argv but holds no token in its environment. Never killed and
  // never claimed. One may still be exiting when first seen (a test that kills its own processes without waiting for
  // them), so look again until each is gone or SETTLE_MS passes. One that leaves is still REPORTED, as observed then
  // exited; one still there, or a look that could not be taken, fails the run and keeps the folder.
  let real = suite.dir;
  try { real = fs.realpathSync(suite.dir); } catch { /* keep the given path */ }
  const usesFolder = (text) => text.includes(suite.dir) || text.includes(real);
  // which file's folder a process uses: the runner's own folders tested against it, never a path read out of its argv
  const whose = (text) => {
    for (const [file, dir] of suite.files) {
      let r = dir;
      try { r = fs.realpathSync(dir); } catch { /* keep the given path */ }
      if (text.includes(dir + path.sep) || text.includes(r + path.sep) || text.endsWith(dir) || text.endsWith(r)) return `${file}'s folder`;
    }
    return 'the suite folder';
  };
  const seen = new Map();
  const strangersIn = (v) => {
    const now = [];
    for (const [pid, text] of v.argv) {
      if (pid === self || v.owned.has(pid) || !usesFolder(text) || !alive(pid)) continue;
      if (!seen.has(pid)) seen.set(pid, { exe: exeName(pid), ppid: parentOf(pid), where: whose(text), at: Date.now() });
      now.push(pid);
    }
    return now;
  };
  let strangers = strangersIn(view);
  let lookFailed = false;
  // every fresh look is judged WHOLE: one taken during this wait can show an owned or undecidable process that the
  // settle step above never saw. Those are not killed here (the settle step is over); they keep the folder and fail.
  const lateOwned = new Set();
  const lateUndecided = new Set();
  const recheckUntil = Date.now() + SETTLE_MS;
  while (strangers.length && Date.now() < recheckUntil) {
    sleepSync(100);
    const v = inspectProcesses(marker);
    if (v === null) { lookFailed = true; break; }
    strangers = strangersIn(v);
    for (const pid of v.owned) if (pid !== self && !stubborn.includes(pid) && alive(pid)) lateOwned.add(pid);
    for (const pid of v.undecidable) if (pid !== self && !undecided.includes(pid) && alive(pid)) lateUndecided.add(pid);
  }
  const late = [...lateOwned].filter(alive).concat([...lateUndecided].filter(alive));
  for (const pid of lateOwned) if (alive(pid)) lines.push(`# tmp: ⛔ owned process pid ${pid} (${exeName(pid)}) appeared while waiting on a process that is not this run's: NOT killed, the folder is kept`);
  for (const pid of lateUndecided) if (alive(pid)) lines.push(`# tmp: ⛔ process pid ${pid} (${exeName(pid)}) appeared while waiting, and its ownership could not be decided: NOT killed`);
  for (const [pid, s] of seen) {
    if (strangers.includes(pid)) lines.push(`# tmp: ⛔ process pid ${pid} (${s.exe}, parent ${s.ppid}) is not this run's but uses ${s.where}: NOT killed`);
    else lines.push(`# tmp: process pid ${pid} (${s.exe}, parent ${s.ppid}) was not this run's and used ${s.where}: observed, then exited (not killed)`);
  }
  if (lookFailed) lines.push(`# tmp: ⛔ could not re-inspect processes while ${strangers.length} not this run's still used the folder`);

  // 3. COUNT, per file, then the ratchet.
  const baseline = loadBaseline(root);
  if (baseline.problem) lines.push(`# tmp: ⛔ the leak baseline is ${baseline.problem}: treated as empty, so every leaking file below reads as new`);
  let entries = 0;
  let bytes = 0;
  for (const [file, dir] of suite.files) {
    const m = measure(dir);
    entries += m.entries;
    bytes += m.bytes;
    const listed = baseline.has(path.resolve(root, file));
    if (m.entries > 0 && !listed) {
      failed = true;
      lines.push(`# tmp: ⛔ ${file} left ${m.entries} entries, ${m.bytes} bytes: a NEW leak (not on the baseline) — fails the run`);
    } else if (m.entries > 0) {
      lines.push(`# tmp: ${file} left ${m.entries} entries, ${m.bytes} bytes (on the baseline: a known leak)`);
    } else if (listed) {
      lines.push(`# tmp: ${file} left 0 entries: a candidate for removal from the baseline`);
    }
  }

  // 4. REMOVE — only when nothing we cannot account for still holds the folder.
  if (strangers.length || lookFailed || late.length || stubborn.length || undecided.length) {
    failed = true;
    lines.push(`# tmp: ⛔ folder RETAINED, not removed: ${suite.dir} (${entries} entries, ${bytes} bytes inside the file folders)`);
  } else {
    try { fs.rmSync(suite.dir, { recursive: true, force: true }); } catch (e) { failed = true; lines.push(`# tmp: ⛔ could not remove ${suite.dir}: ${e.code || e.message}`); }
    lines.push(`# tmp: removed ${entries} entries, ${bytes} bytes left by test files (suite folder ${path.basename(suite.dir)})`);
  }
  // An owned survivor is REPORTED (above) and killed, not failed: the spec makes the per-file entry count the
  // assertion; a process verdict would need its own measured baseline first.
  return { failed, lines };
}
