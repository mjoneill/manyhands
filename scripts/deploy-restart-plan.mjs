#!/usr/bin/env node
/**
 * #1138 — which services does THIS deploy actually have to restart?
 *
 * deploy.sh used to kickstart both com.scrumboard.rest and com.scrumboard.mcp
 * on every run. A Claude Code MCP session bound to :3001 does not reconnect
 * after the server it is bound to restarts (#697), so every bounce muted every
 * Claude Code seat in the room — including bounces that deployed only tests.
 * Measured 2026-09-02: four deploys, two of them zero runtime change, and a
 * seat went silent at the second one.
 *
 * The decision here is COMPUTED, not hand-listed: each service's inputs are
 * the transitive closure of the relative `import` statements from its entry
 * file, plus the package manifests. A hand-written list of "MCP files" is the
 * greppable-proxy trap — it reads as the answer and drifts the first time a
 * new module is added. The closure is read from the tree being deployed.
 *
 * Static client files (index.html, commons.html, core/*.css, the browser-side
 * .mjs the pages import) are served per request by REST (#697's own
 * measurement: readFileSync inside the handler) and need no restart. They are
 * in the closure only if a server entry file imports them, which none does.
 *
 * ⛔ UNKNOWN IS NOT "NOTHING CHANGED". With no previous sha (first deploy, or
 * a serve dir whose DEPLOYED-SHA is missing) the plan restarts BOTH: a decision
 * that cannot see its inputs must not read as an all-clear.
 *
 * CLI:   node scripts/deploy-restart-plan.mjs <repo-dir> <prev-sha|-> <new-sha>
 * Print: rest=0|1 mcp=0|1 reason.rest=<path|-> reason.mcp=<path|-> prev=<sha|unknown>
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const SERVICES = {
  rest: { entry: 'server.js' },
  mcp: { entry: 'mcp-server.mjs' },
};
// Changing either of these can change what a service loads, closure or not.
export const MANIFESTS = new Set(['package.json', 'package-lock.json']);

const IMPORT_RE = /(?:^|\n)\s*import\s+(?:[^'"]*?\s+from\s+)?['"](\.{1,2}\/[^'"]+)['"]/g;
const DYNAMIC_RE = /import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;

/**
 * The set of repo-relative paths a service loads: its entry plus every module
 * reachable through relative static or dynamic imports. `readFile(relPath)`
 * returns source text or null (so the walker works on a git tree or a
 * fixture without touching disk layout).
 */
export function importClosure(entry, readFile) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const rel = stack.pop();
    if (seen.has(rel)) continue;
    const src = readFile(rel);
    if (src == null) continue;          // an import of something that is not a file in this tree
    seen.add(rel);
    for (const re of [IMPORT_RE, DYNAMIC_RE]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src))) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1]));
        stack.push(target);
      }
    }
  }
  return seen;
}

/**
 * The plan. `changed` is the list of repo-relative paths that differ between
 * the served sha and the new one, or null when that cannot be known.
 */
export function restartPlan({ changed, readFile }) {
  if (changed == null) {
    return { rest: true, mcp: true, reason: { rest: 'previous sha unknown', mcp: 'previous sha unknown' }, unknown: true };
  }
  const plan = { rest: false, mcp: false, reason: { rest: null, mcp: null }, unknown: false };
  for (const [name, { entry }] of Object.entries(SERVICES)) {
    const inputs = importClosure(entry, readFile);
    for (const p of changed) {
      if (inputs.has(p) || MANIFESTS.has(p)) { plan[name] = true; plan.reason[name] = p; break; }
    }
  }
  return plan;
}

/** git-backed readers: changed paths between two shas, and file text at a sha. */
export function gitChanged(repo, prev, next) {
  const out = execFileSync('git', ['-C', repo, 'diff', '--name-only', `${prev}..${next}`], { encoding: 'utf8' });
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}
export function gitReader(repo, sha) {
  return (rel) => {
    try { return execFileSync('git', ['-C', repo, 'show', `${sha}:${rel}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { return null; }
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [repo, prev, next] = process.argv.slice(2);
  if (!repo || !prev || !next) {
    console.error('usage: deploy-restart-plan.mjs <repo-dir> <prev-sha|-> <new-sha>');
    process.exit(2);
  }
  let changed = null;
  if (prev !== '-') {
    try { execFileSync('git', ['-C', repo, 'cat-file', '-e', `${prev}^{commit}`], { stdio: 'ignore' }); changed = gitChanged(repo, prev, next); }
    catch { changed = null; }   // an unresolvable previous sha is UNKNOWN, not empty
  }
  const plan = restartPlan({ changed, readFile: gitReader(repo, next) });
  const r = (x) => (x == null ? '-' : x);
  process.stdout.write(`rest=${plan.rest ? 1 : 0} mcp=${plan.mcp ? 1 : 0} reason.rest=${r(plan.reason.rest)} reason.mcp=${r(plan.reason.mcp)} prev=${plan.unknown ? 'unknown' : prev} changed=${changed ? changed.length : '-'}\n`);
}
