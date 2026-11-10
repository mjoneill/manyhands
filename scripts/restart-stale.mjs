#!/usr/bin/env node
/**
 * #1847 slice 2 — RESTART THE SERVICES A DEPLOY LEFT ON THE OLD FOLDER, in a safe order, under the operation lock.
 *
 *   node scripts/restart-stale.mjs --serve <dir> --holder <who> [--ask <postId>] [--note <text>]
 *   node scripts/restart-stale.mjs --serve <dir> --under-lock <op> --holder <who>     (inside a deploy that holds it)
 *
 * The swap renames the serve folder to `.previous`; every job deploy.sh did not restart keeps its cwd there, runs the
 * old code, and makes the NEXT deploy refuse (#1831). Slice 1 made the deploy SAY which jobs those are. This restarts
 * them. In order, each step gated on the one before:
 *
 *   0. THE LOCK. Standalone, it ACQUIRES the operation lock itself (op `restart`, with the ask and note) and refuses
 *      to act if anyone holds it: on 2026-11-09 at 19:04Z four services were restarted unlocked because the acquire's
 *      `|| exit 1` sat after a pipe. Inside a deploy it proves the DEPLOY holds the lock (`operation-lock.sh holds`);
 *      a free lock is a refusal there too. There is no unlocked path.
 *   1. THE BASELINE. `launchctl list` pids and serve-cwd-check's table, BEFORE anything is touched. If the check
 *      cannot classify every running job (exit 2), nothing is restarted: an action without a before-state cannot be
 *      diffed, so nobody can tell afterwards what it did.
 *   2. graph-executor, if stale: a VERIFIED BACKUP first (the backup tick's own command, read from its plist, or
 *      RESTART_BACKUP_CMD); a failed backup stops everything. Then kickstart, then readiness: a new pid AND
 *      /health status OK. Not ready → stop. Then REST's readGate.lost: above 0, REST is restarted too (a lost slot
 *      is held until both have restarted, core/read-admission.mjs).
 *   3. rest, if stale (or lost > 0): a MAINTENANCE post first (#1273), kickstart, wait for graph.ready.
 *   4. activity-projector, if stale: kickstart, wait for a new pid. ⚠️ Its real readiness proof is "projected N
 *      item(s)" after a write; this does not make a write, and says so.
 *   5. mcp: NEVER. A kick deafens every Claude Code seat until a human types /mcp reconnect. It is NAMED, with the
 *      command, and the exit is non-zero. Any other stale job is named and left too: nobody has written down how
 *      to tell it is ready.
 *   6. THE DIFF. The same two reads again; every job whose pid or folder changed, and every job still stale, goes
 *      to the room in ONE post. REST down → the post is skipped and that is said; the lock file still carried the
 *      claim and note while it acted.
 *
 * Exit: 0 nothing left stale · 1 something left stale or a step failed · 2 no baseline · 3 the lock refused.
 *
 * Environment (names only): DEPLOY_LOCK or DEPLOY_SHA_STAMP (the lock's file, as operation-lock.sh),
 *   DEPLOY_BOARD_API (room posts; default RESTART_REST_URL), RESTART_REST_URL (default http://127.0.0.1:3141),
 *   RESTART_EXECUTOR_URL (default http://127.0.0.1:3143), RESTART_BACKUP_CMD (a command to run instead of the backup
 *   tick's), RESTART_READY_TIMEOUT_MS (default 90000), RESTART_POLL_MS (default 2000).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseLaunchctl } from './serve-cwd-check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOCK_SCRIPT = path.join(HERE, 'operation-lock.sh');
const CHECK = path.join(HERE, 'serve-cwd-check.mjs');
const P = 'com.scrumboard.';
const short = (label) => label.replace(P, '');

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const serve = opt('--serve'); const holder = opt('--holder'); const underLock = opt('--under-lock');
const ask = opt('--ask') ?? ''; const note = opt('--note') ?? '';
if (!serve || !holder) { console.error('usage: restart-stale.mjs --serve <dir> --holder <who> [--ask <postId>] [--note <text>] | --under-lock <op>'); process.exit(2); }

const REST = (process.env.RESTART_REST_URL || 'http://127.0.0.1:3141').replace(/\/$/, '');
const EXEC = (process.env.RESTART_EXECUTOR_URL || 'http://127.0.0.1:3143').replace(/\/$/, '');
const BOARD = (process.env.DEPLOY_BOARD_API || REST).replace(/\/$/, '');
const READY_MS = Number(process.env.RESTART_READY_TIMEOUT_MS || 90000);
const POLL_MS = Number(process.env.RESTART_POLL_MS || 2000);
const uid = process.getuid();
const say = (s) => console.log(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const lock = (...a) => spawnSync('sh', [LOCK_SCRIPT, ...a], { encoding: 'utf8' });

async function getJson(url) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(3000) }); return r.ok ? await r.json() : null; } catch { return null; }
}
async function post(body) {
  try {
    const r = await fetch(`${BOARD}/api/conversations`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: 'board', body }), signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch { return false; }
}

/** One read of the world: pid per label (launchctl) and folder class per label (serve-cwd-check). */
function snapshot() {
  const pids = {};
  try { for (const j of parseLaunchctl(execFileSync('launchctl', ['list'], { encoding: 'utf8' }))) pids[j.label] = j.pid; }
  catch (e) { return { ok: false, why: `launchctl list failed: ${e.message}` }; }
  const r = spawnSync(process.execPath, [CHECK, '--serve', serve], { encoding: 'utf8' });
  if (r.status !== 0 && r.status !== 1) return { ok: false, why: `serve-cwd-check exited ${r.status}: ${(r.stdout + r.stderr).trim()}` };
  const cls = {};
  for (const line of r.stdout.split('\n')) {
    const m = /^(\S+) (com\.scrumboard\.\S+) pid=/.exec(line);
    if (m) cls[m[2]] = m[1];
  }
  return { ok: true, pids, cls, table: r.stdout.trim() };
}
const isStale = (c) => c === 'previous' || c === 'GONE';

function kickstart(label) {
  const r = spawnSync('launchctl', ['kickstart', '-k', `gui/${uid}/${label}`], { encoding: 'utf8' });
  return r.status === 0;
}
const pidOf = (label) => { try { return parseLaunchctl(execFileSync('launchctl', ['list'], { encoding: 'utf8' })).find((j) => j.label === label)?.pid ?? null; } catch { return null; } };

/** Wait until the label runs under a NEW pid and `ready()` (if given) says yes. */
async function waitReady(label, oldPid, ready) {
  const until = Date.now() + READY_MS;
  let last = 'no new pid';
  while (Date.now() < until) {
    const pid = pidOf(label);
    if (pid && pid !== oldPid) {
      if (!ready) return { ok: true, pid };
      const v = await ready();
      if (v === true) return { ok: true, pid };
      last = v || 'not ready';
    }
    await sleep(POLL_MS);
  }
  return { ok: false, why: last };
}

function backupCommand() {
  if (process.env.RESTART_BACKUP_CMD) return { cmd: 'sh', argv: ['-c', process.env.RESTART_BACKUP_CMD], from: 'RESTART_BACKUP_CMD' };
  const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${P}graph-store-backup-tick.plist`);
  try {
    const argv = JSON.parse(execFileSync('plutil', ['-extract', 'ProgramArguments', 'json', '-o', '-', plist], { encoding: 'utf8' }));
    if (Array.isArray(argv) && argv.length) return { cmd: argv[0], argv: argv.slice(1), from: `${P}graph-store-backup-tick's ProgramArguments` };
  } catch { /* fall through */ }
  return null;
}

let acquired = false;
const release = () => { if (acquired) { lock('release', 'restart', holder); acquired = false; } };

async function main() {
  // 0. THE LOCK — before the baseline, so the before-state is not read while someone else is changing it
  if (underLock) {
    if (lock('holds', underLock, holder).status !== 0) {
      say(`⛔ restart-stale: told it runs inside "${underLock}" held by ${holder}, but the lock does not say so — restarting nothing`);
      say(lock('status').stdout.trim());
      return 3;
    }
  } else {
    const a = lock('acquire', 'restart', holder, '--ask', ask, '--note', note || `restart-stale.mjs --serve ${serve}`);
    if (a.status !== 0) { say(`⛔ restart-stale: the operation lock refused — restarting nothing\n${(a.stdout + a.stderr).trim()}`); return 3; }
    acquired = true;
    say(a.stdout.trim());
  }

  // 1. THE BASELINE
  const before = snapshot();
  if (!before.ok) { say(`⛔ restart-stale: no baseline (${before.why}) — an action with no before-state cannot be diffed; restarting nothing`); return 2; }
  const stale = Object.keys(before.cls).filter((l) => isStale(before.cls[l]));
  if (!stale.length) { say('✓ restart-stale: every running job is on the served tree — nothing to restart'); return 0; }
  say(`↻ restart-stale: before —\n${before.table.split('\n').map((l) => `   ${l}`).join('\n')}`);

  const notes = {};   // label → why, for the diff
  let failed = null;
  let restartRest = stale.includes(`${P}rest`);

  // 2. graph-executor: backup → kickstart → readiness → readGate.lost
  const EX = `${P}graph-executor`;
  if (stale.includes(EX)) {
    const b = backupCommand();
    if (!b) failed = 'no backup command (no RESTART_BACKUP_CMD, no readable backup-tick plist) — the executor is not restarted without one';
    else {
      say(`⇣ backup first (${b.from})`);
      const r = spawnSync(b.cmd, b.argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      if (r.status !== 0) failed = `the backup exited ${r.status} — the executor is NOT restarted\n${(r.stdout + r.stderr).trim().split('\n').slice(-5).join('\n')}`;
    }
    if (!failed) {
      const h0 = await getJson(`${EXEC}/health`);
      if (!kickstart(EX)) failed = 'kickstart graph-executor failed';
      else {
        const w = await waitReady(EX, before.pids[EX], async () => { const h = await getJson(`${EXEC}/health`); return h?.status === 'OK' ? true : `status ${h?.status ?? 'unreachable'}`; });
        if (!w.ok) failed = `graph-executor not ready within ${READY_MS} ms (${w.why}) — stopping here`;
        else {
          const h1 = await getJson(`${EXEC}/health`);
          notes[EX] = `epoch ${h0?.epoch ?? '?'} → ${h1?.epoch ?? '?'}, commitSeq ${h0?.commitSeq ?? '?'} → ${h1?.commitSeq ?? '?'}`;
          const lost = (await getJson(`${REST}/api/health`))?.readGate?.lost;
          if (typeof lost !== 'number') say('⚠️ readGate.lost UNREADABLE after the executor restart — REST is not restarted for it; look: curl -s ' + `${REST}/api/health`);
          else if (lost > 0) { restartRest = true; notes[`${P}rest`] = `readGate lost ${lost}`; }
        }
      }
    }
  }

  // 3. rest
  const RS = `${P}rest`;
  if (!failed && restartRest) {
    if (!(await post('MAINTENANCE: restart-stale restarting com.scrumboard.rest — streams will drop and recover. (#1273, #1847)'))) say('   (maintenance notice not posted — REST unreachable)');
    if (!kickstart(RS)) failed = 'kickstart rest failed';
    else {
      const w = await waitReady(RS, before.pids[RS], async () => ((await getJson(`${REST}/api/health`))?.graph?.ready === true ? true : 'graph not ready'));
      if (!w.ok) failed = `rest not ready within ${READY_MS} ms (${w.why})`;
      notes[RS] = [notes[RS], before.cls[RS] && isStale(before.cls[RS]) ? 'was stale' : null].filter(Boolean).join(', ');
    }
  }

  // 4. activity-projector
  const PJ = `${P}activity-projector`;
  if (!failed && stale.includes(PJ)) {
    if (!kickstart(PJ)) failed = 'kickstart activity-projector failed';
    else {
      const w = await waitReady(PJ, before.pids[PJ]);
      if (!w.ok) failed = `activity-projector did not come back within ${READY_MS} ms`;
      else notes[PJ] = 'new pid; projection not proven (that needs a write)';
    }
  }

  // 6. THE DIFF
  const afterSnap = snapshot();
  const after = afterSnap.ok ? afterSnap : { pids: {}, cls: {} };
  const lines = [];
  for (const label of Object.keys(before.cls)) {
    const p0 = before.pids[label]; const p1 = after.pids[label];
    const c0 = before.cls[label]; const c1 = after.cls[label] ?? '?';
    if (p0 === p1 && c0 === c1) continue;
    lines.push(`${short(label)}: pid ${p0} → ${p1 ?? 'none'} (${c0} → ${c1})${notes[label] ? ` — ${notes[label]}` : ''}`);
  }
  const left = Object.keys(after.cls).filter((l) => isStale(after.cls[l]));
  const leftLines = left.map((l) => (l === `${P}mcp`
    ? `mcp — a restart deafens every Claude Code seat until a human runs /mcp reconnect scrum-board. By hand: launchctl kickstart -k gui/${uid}/${P}mcp, then reconnect`
    : `${short(l)} — no readiness check is written down for it; restart it by hand and confirm it`));
  const head = failed ? `⛔ restart-stale STOPPED: ${failed.split('\n')[0]}` : '↻ restart-stale (#1847)';
  const body = [head, ...lines, ...(left.length ? ['NOT restarted (still on an older tree):', ...leftLines.map((l) => `- ${l}`)] : []),
    ...(afterSnap.ok ? [] : [`⚠️ after-state UNMEASURED (${afterSnap.why})`])].join('\n');
  say(body);
  if (failed && failed.includes('\n')) say(failed);
  if (lines.length || left.length || failed) {
    if (!(await post(body))) say('   (not posted to the commons — REST unreachable; tell the room by hand)');
  }
  return failed || left.length || !afterSnap.ok ? 1 : 0;
}

let code = 1;
try { code = await main(); } catch (e) { console.error(`restart-stale: ${e?.message ?? e}`); code = 1; } finally { release(); }
process.exit(code);
