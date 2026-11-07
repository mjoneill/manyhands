#!/usr/bin/env node
/**
 * #1828 — is the dependency tree the deploy is about to serve the one its
 * lockfile describes?
 *
 * deploy.sh exports tracked files with `git archive` and SYMLINKS the served
 * tree's node_modules to the clone's. Nothing installs. So a deploy that ships a
 * new package-lock.json restarts the services onto whatever the clone last
 * installed — measured 2026-11-07: the lockfile said @hono/node-server 2.1.6,
 * node_modules held 2.0.12 (inside an advisory), and `npm audit` reported
 * "0 vulnerabilities" because audit reads the LOCKFILE, not the installed tree.
 *
 * This compares the two directly: every non-dev entry under `packages` in
 * package-lock.json (lockfileVersion 2/3) against the `version` in that path's
 * installed package.json. Dev-only entries are skipped (production never loads
 * them); an OPTIONAL entry that is absent is skipped (npm legitimately omits
 * optional packages for another platform). Anything else absent, or at another
 * version, is a mismatch.
 *
 * ⛔ An unreadable or versionless lockfile is an ERROR, never an empty list of
 * mismatches: a check that cannot see its inputs must not read as an all-clear.
 *
 * The deploy REFUSES on a mismatch rather than running `npm ci` itself: the
 * live services load from that same node_modules (it is symlinked), and `npm ci`
 * deletes it first — an install inside the deploy would pull modules out from
 * under the running processes, and put a network fetch inside the deploy.
 *
 * CLI:   node scripts/deploy-deps-check.mjs <repo-dir> [--lockfile <path>] [package ...]
 *        (<repo-dir> holds node_modules; --lockfile defaults to <repo-dir>/package-lock.json)
 *        exit 0: in step (prints `deps: N packages match the lockfile`, then one
 *                `installed <name>@<version>` line per named package)
 *        exit 1: mismatch (one `MISMATCH <name>: lockfile <v>, installed <v|absent>` per package)
 *        exit 2: cannot check (the reason)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

/**
 * Returns { checked, mismatches: [{name, path, want, have}] }. Throws when the lockfile cannot be read.
 * `lockPath` defaults to repoDir's own lockfile. deploy.sh passes the EXPORTED one: the clone's working
 * tree can hold an uncommitted lockfile that matches node_modules while the commit being served does not.
 */
export function checkInstalled(repoDir, lockPath = path.join(repoDir, 'package-lock.json')) {
  let lock;
  try { lock = readJson(lockPath); } catch (e) { throw new Error(`cannot read ${lockPath}: ${e.message}`); }
  if (!lock || typeof lock.packages !== 'object' || lock.packages === null) {
    throw new Error(`${lockPath} has no "packages" map (lockfileVersion ${lock?.lockfileVersion ?? 'unknown'}; v2 or v3 is required)`);
  }
  let checked = 0;
  const mismatches = [];
  for (const [rel, entry] of Object.entries(lock.packages)) {
    if (!rel.startsWith('node_modules/') || !entry || entry.dev || entry.link) continue;
    const name = rel.slice(rel.lastIndexOf('node_modules/') + 'node_modules/'.length);
    let have = null;
    try { have = readJson(path.join(repoDir, rel, 'package.json')).version ?? null; } catch { have = null; }
    if (have === null && entry.optional) continue;
    checked += 1;
    if (have !== entry.version) mismatches.push({ name, path: rel, want: entry.version ?? null, have });
  }
  if (checked === 0 && mismatches.length === 0 && Object.keys(lock.packages).some((k) => k.startsWith('node_modules/') && !lock.packages[k]?.dev)) {
    throw new Error('the lockfile lists production packages but none could be checked');
  }
  return { checked, mismatches };
}

/** Installed version of a top-level package, or null. */
export function installedVersion(repoDir, name) {
  try { return readJson(path.join(repoDir, 'node_modules', name, 'package.json')).version ?? null; } catch { return null; }
}

// Compare REAL paths: on macOS the temp dir is /var → /private/var, and a plain
// path compare made the CLI do nothing and exit 0 — an all-clear from a check
// that never ran. deploy.sh also requires the positive line below, so a silent
// exit cannot pass there either.
const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  let lockArg;
  const li = args.indexOf('--lockfile');
  if (li !== -1) { lockArg = args[li + 1]; args.splice(li, 2); if (!lockArg) { console.error('--lockfile needs a path'); process.exit(2); } }
  const [repoDir, ...names] = args;
  if (!repoDir) { console.error('usage: deploy-deps-check.mjs <repo-dir> [--lockfile <path>] [package ...]'); process.exit(2); }
  let r;
  try { r = checkInstalled(repoDir, lockArg); } catch (e) { console.error(`deps: CANNOT CHECK — ${e.message}`); process.exit(2); }
  if (r.mismatches.length) {
    for (const m of r.mismatches) console.log(`MISMATCH ${m.path.replace(/^node_modules\//, '')}: lockfile ${m.want}, installed ${m.have ?? 'absent'}`);
    process.exit(1);
  }
  console.log(`deps: ${r.checked} packages match the lockfile`);
  for (const n of names) console.log(`installed ${n}@${installedVersion(repoDir, n) ?? 'absent'}`);
}
