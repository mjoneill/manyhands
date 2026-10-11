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
 * ⛔ SECRETS. Reading another process's environment means reading whatever credentials it holds. The `ps` output is
 * parsed here, in memory, for exactly one thing (this run's token, or this folder's path) and then dropped. It is never
 * printed, logged or written. Diagnostics name a process by pid and executable name only; never its argv, never its
 * environment.
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

export const TOKEN_VAR = 'MANYHANDS_SUITE_RUN';
const SETTLE_MS = 5000;

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/** pid → executable name, for diagnostics. Never the argv. */
function exeName(pid) {
  try { return path.basename(execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' }).trim()) || '?'; } catch { return '?'; }
}

/**
 * Every process of ours, as [pid, text] where text is argv (+ the environment when `withEnv`). The text never leaves
 * this module: callers get back pids only.
 */
function processTable(withEnv) {
  // Linux (CI): /proc is exact — argv and environment are NUL-separated and readable for our own processes.
  if (process.platform === 'linux') {
    const rows = [];
    let pids = [];
    try { pids = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)); } catch { return []; }
    for (const p of pids) {
      let text = '';
      try { text = fs.readFileSync(`/proc/${p}/cmdline`, 'latin1').replace(/\0/g, ' '); } catch { continue; }
      if (withEnv) { try { text += ' ' + fs.readFileSync(`/proc/${p}/environ`, 'latin1').replace(/\0/g, ' '); } catch { /* not ours to read */ } }
      rows.push([Number(p), text]);
    }
    return rows;
  }
  // macOS: `-E` appends the environment (`-e` does not, there). Measured 2026-10-11 with a marker child.
  let raw = '';
  try {
    raw = execFileSync('ps', withEnv ? ['-axww', '-E', '-o', 'pid=,command='] : ['-axww', '-o', 'pid=,command='],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return []; }
  const rows = [];
  for (const line of raw.split('\n')) {
    const m = /^\s*(\d+)\s(.*)$/.exec(line);
    if (m) rows.push([Number(m[1]), m[2]]);
  }
  return rows;
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
  let list = [];
  try { list = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { list = []; }
  return new Set((Array.isArray(list) ? list : []).map((f) => path.resolve(root, f)));
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

  // 1. OURS: every process whose own environment carries this run's token. Report, kill, wait.
  const owned = new Set(processTable(true).filter(([pid, text]) => pid !== self && text.includes(marker)).map(([pid]) => pid));
  for (const pid of owned) {
    lines.push(`# tmp: owned process pid ${pid} (${exeName(pid)}) outlived its test file: a leak; killing it`);
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  for (let t = 0; t < SETTLE_MS && [...owned].some(alive); t += 100) sleepSync(100);
  const stubborn = [...owned].filter(alive);
  for (const pid of stubborn) lines.push(`# tmp: ⛔ owned process pid ${pid} (${exeName(pid)}) did not exit within ${SETTLE_MS} ms`);

  // 2. NOT OURS: a process that names the folder but carries no token. Never killed.
  let real = suite.dir;
  try { real = fs.realpathSync(suite.dir); } catch { /* keep the given path */ }
  const strangers = processTable(false)
    .filter(([pid, text]) => pid !== self && !owned.has(pid) && (text.includes(suite.dir) || text.includes(real)))
    .map(([pid]) => pid);
  for (const pid of strangers) lines.push(`# tmp: ⛔ process pid ${pid} (${exeName(pid)}) is not this run's but uses its folder: NOT killed`);

  // 3. COUNT, per file, then the ratchet.
  const baseline = loadBaseline(root);
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
  if (strangers.length || stubborn.length) {
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
