#!/usr/bin/env node
/**
 * #539 (process-path leg only): is each running board service where we think it is?
 *
 * Measured 2026-11-07/08: the graph executor and the activity projector had run for about a week from CODE FOLDERS
 * AN EARLIER DEPLOY HAD DELETED. Every health surface read green, and the state was found by accident (#1831, #1832).
 * `lsof` still printed `.../manyhands-serve.previous/graph-executor` for one of them, because that path is a cached
 * NAME: a different folder now lives there, with another inode. A path compare reads "fine"; only the inode tells.
 *
 * So, for every running `com.scrumboard.*` launchd job: the inode of the process's cwd, compared with
 *   - the live serve folder            → serve
 *   - the live `.previous` folder      → previous   (the next deploy deletes it: #1831's guard refuses then)
 *   - what its cached path holds now   → other      (the folder still exists, outside serve, e.g. `/`)
 *   - none of those                    → GONE       (it runs from a deleted folder; a restart is the only fix: #1832)
 * A job with no pid is `not-running`. A pid whose cwd could not be read is `unknown`: that is "could not check",
 * never a pass.
 *
 * Read-only: it reads launchctl, lsof and stat. It restarts and changes nothing.
 *
 * CLI:   node scripts/serve-cwd-check.mjs --serve <dir>   (the live serve folder; there is no default, so this
 *        public tree names no install path)
 *        one line per job: `<verdict> <label> pid=<pid> cwd=<path> (inode <n>)`, then a summary line
 *        exit 0: every running job is in serve or elsewhere-and-existing
 *        exit 1: any job is `previous` or GONE
 *        exit 2: any job is `unknown`, or the serve folder itself cannot be read
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** `launchctl list` text → [{ label, pid }] for com.scrumboard.* jobs; pid is null when not running. */
export function parseLaunchctl(text) {
  const jobs = [];
  for (const line of String(text).split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 3 || !cols[2].startsWith('com.scrumboard.')) continue;
    const pid = /^\d+$/.test(cols[0]) ? Number(cols[0]) : null;
    jobs.push({ label: cols[2], pid });
  }
  return jobs;
}

/** `lsof -a -p <pid> -d cwd -Fin` text → { inode, name } (either may be null). */
export function parseLsofCwd(text) {
  let inode = null;
  let name = null;
  for (const line of String(text).split('\n')) {
    if (line.startsWith('i') && /^i\d+$/.test(line)) inode = Number(line.slice(1));
    else if (line.startsWith('n')) name = line.slice(1);
  }
  return { inode, name };
}

/** True when `p` is `dir` itself or lies under it. Both are real paths; the trailing slash stops `serve2/` matching. */
const within = (p, dir) => !!p && !!dir && (p === dir || p.startsWith(dir.endsWith('/') ? dir : `${dir}/`));

/**
 * The verdict for one job. `nameInode` is what the cached path holds NOW (null if the path does not exist), and
 * `nameReal` is that path's realpath.
 * - The serve and .previous folders THEMSELVES are matched by inode alone.
 * - A SUBFOLDER of either (the executor runs from `<serve>/graph-executor`) is matched by the realpath prefix, but
 *   only once the name is proven TRUE, i.e. the path holds the cwd's own inode. A stale name proves nothing, so it
 *   falls through to GONE.
 * Found in review: matching by folder inode alone called `<.previous>/graph-executor` `other` (exit 0). That was
 * the executor's real state on the day it began running from a folder the next deploy deletes.
 */
export function classify({ pid, cwdInode, nameInode, nameReal = null },
  { serveInode, previousInode, serveReal = null, previousReal = null }) {
  if (pid === null || pid === undefined) return 'not-running';
  if (cwdInode === null || cwdInode === undefined) return 'unknown';
  if (cwdInode === serveInode) return 'serve';
  if (previousInode !== null && cwdInode === previousInode) return 'previous';
  if (nameInode !== null && nameInode === cwdInode) {
    if (within(nameReal, serveReal)) return 'serve';
    if (within(nameReal, previousReal)) return 'previous';
    return 'other';
  }
  return 'GONE';
}

/** Exit code for a set of verdicts: 2 beats 1 beats 0, because "could not check" must never read as a pass. */
export function exitCodeFor(verdicts) {
  if (verdicts.includes('unknown')) return 2;
  if (verdicts.includes('GONE') || verdicts.includes('previous')) return 1;
  return 0;
}

const inodeOf = (p) => { try { return fs.statSync(p).ino; } catch { return null; } };
const realOrNull = (p) => { try { return fs.realpathSync(p); } catch { return null; } };

const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const si = args.indexOf('--serve');
  const serve = si !== -1 ? args[si + 1] : undefined;
  if (!serve) { console.error('usage: serve-cwd-check.mjs --serve <dir>'); process.exit(2); }
  const serveInode = inodeOf(serve);
  if (serveInode === null) { console.error(`serve-cwd: CANNOT CHECK — cannot stat the serve folder ${serve}`); process.exit(2); }
  const previousInode = inodeOf(`${serve}.previous`);
  let listing;
  try { listing = execFileSync('launchctl', ['list'], { encoding: 'utf8' }); } catch (e) {
    console.error(`serve-cwd: CANNOT CHECK — launchctl list failed: ${e.message}`); process.exit(2);
  }
  const verdicts = [];
  for (const job of parseLaunchctl(listing)) {
    let cwd = { inode: null, name: null };
    if (job.pid !== null) {
      // lsof exits 1 on macOS even when it prints the answer, so read the output, not the exit code (see #1831).
      try { cwd = parseLsofCwd(execFileSync('lsof', ['-a', '-p', String(job.pid), '-d', 'cwd', '-Fin'], { encoding: 'utf8' })); }
      catch (e) { cwd = parseLsofCwd(String(e.stdout ?? '')); }
    }
    const verdict = classify(
      { pid: job.pid, cwdInode: cwd.inode, nameInode: cwd.name ? inodeOf(cwd.name) : null, nameReal: cwd.name ? realOrNull(cwd.name) : null },
      { serveInode, previousInode, serveReal: realOrNull(serve), previousReal: realOrNull(`${serve}.previous`) });
    verdicts.push(verdict);
    if (verdict === 'not-running') continue;
    console.log(`${verdict} ${job.label} pid=${job.pid} cwd=${cwd.name ?? '?'} (inode ${cwd.inode ?? '?'})`);
  }
  const code = exitCodeFor(verdicts);
  const running = verdicts.filter((v) => v !== 'not-running').length;
  console.log(`serve-cwd: ${running} running jobs checked against serve inode ${serveInode}` +
    `${previousInode !== null ? ` and .previous ${previousInode}` : ''}; exit ${code}`);
  process.exit(code);
}
