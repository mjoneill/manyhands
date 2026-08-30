/**
 * #837 2b — deploy.sh refuses to serve a sha whose CI run is not green, and
 * refuses when it cannot ask.
 *
 * Measured 2026-08-30, twice: CI RED on cd919c4 at 04:22Z, served at 04:31Z;
 * CI RED on 7a9a12e at 12:04Z, served at 12:07Z. CI reported; nothing asked.
 *
 * Two halves:
 *   · the pure verdict over `gh run list` JSON — every outcome is its own exit
 *     code, because "cannot tell" rendered like "green" is the false all-clear
 *     this whole card is about (RC1: a config that exists and does not refuse
 *     is the same failure class).
 *   · deploy.sh end-to-end in a sandbox (bare origin + clone + serve dir,
 *     --no-restart so launchctl is never touched) with a FAKE `gh` on
 *     CI_VERDICT_GH: red ⇒ the export does not happen; green ⇒ it does.
 *     The negative control is what keeps the gate from passing by refusing
 *     everything.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verdict, askGh, EXIT } from '../tools/ci-verdict.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SCRATCH = process.env.SCRATCHPAD || path.join(ROOT, '.scratch-tests');

const run = (status, conclusion, extra = {}) => ({ databaseId: 1, status, conclusion, workflowName: 'CI', url: 'https://example.invalid/run/1', ...extra });

// ── the pure half ──────────────────────────────────────────────────────────

test('#837 GREEN only when every completed run concluded success', () => {
  assert.equal(verdict([run('completed', 'success')]).code, EXIT.GREEN);
  assert.equal(verdict([run('completed', 'success'), run('completed', 'success', { workflowName: 'other' })]).code, EXIT.GREEN);
});

test('#837 ⛔ RED on failure, and a second GREEN run does not launder it', () => {
  assert.equal(verdict([run('completed', 'failure')]).code, EXIT.RED);
  assert.equal(verdict([run('completed', 'success'), run('completed', 'failure')]).code, EXIT.RED);
  assert.equal(verdict([run('completed', 'timed_out')]).code, EXIT.RED);
});

test('#1108 ⛔ CANCELLED is its own outcome — a DESTROYED verdict, not a failed one — and still refuses', () => {
  // ci.yml's cancel-in-progress is keyed on the REF, so any push to main cancels
  // a re-run of any OLDER sha, and a re-run OVERWRITES that sha's conclusion.
  // Composed with a gate that reads cancelled as RED, "re-run a green sha to
  // count flakes" + "anyone pushes" = that sha is undeployable with no override.
  // The code never changed; the RECORD did. Different fact, different remedy.
  const v = verdict([run('completed', 'cancelled')]);
  assert.equal(v.code, EXIT.CANCELLED);
  assert.notEqual(v.code, EXIT.GREEN, 'a destroyed verdict is still not a pass');
  assert.match(v.why, /re-run/i, 'the remedy is to re-run, not to fix tests');
  // a real red beside a cancelled one is still RED — cancellation does not launder failure
  assert.equal(verdict([run('completed', 'cancelled'), run('completed', 'failure')]).code, EXIT.RED);
});

test('#837 ⛔ PENDING is not GREEN — an unfinished run is refused with its own code', () => {
  assert.equal(verdict([run('in_progress', null)]).code, EXIT.PENDING);
  assert.equal(verdict([run('queued', null)]).code, EXIT.PENDING);
  // a finished red beside a pending one: still not green, and pending is reported first (wait, then judge)
  assert.equal(verdict([run('in_progress', null), run('completed', 'failure')]).code, EXIT.PENDING);
});

test('#837 ⛔ NO RUN and UNKNOWN are distinct from each other and from RED', () => {
  assert.equal(verdict([]).code, EXIT.NO_RUN);
  assert.equal(verdict(null).code, EXIT.UNKNOWN);
  assert.equal(verdict('nope').code, EXIT.UNKNOWN);
  const codes = new Set([EXIT.GREEN, EXIT.RED, EXIT.UNKNOWN, EXIT.NO_RUN, EXIT.PENDING, EXIT.CANCELLED]);
  assert.equal(codes.size, 6, 'six outcomes, six codes — none may collapse into another');
});

test('#837 ⛔ askGh is fail-closed: a missing binary, a non-zero exit, non-JSON, or a short sha are all UNKNOWN', () => {
  const sha = 'a'.repeat(40);
  assert.equal(askGh(sha, { gh: path.join(SCRATCH, 'definitely-not-a-binary') }).code, EXIT.UNKNOWN);
  assert.equal(askGh('abc1234').code, EXIT.UNKNOWN, 'gh matches the FULL sha only; a short one would silently return no runs');
  const fake = fakeGh({ exit: 1, stderr: 'gh: not logged in' });
  assert.equal(askGh(sha, { gh: fake }).code, EXIT.UNKNOWN);
  const junk = fakeGh({ stdout: 'not json' });
  assert.equal(askGh(sha, { gh: junk }).code, EXIT.UNKNOWN);
});

test('#837 askGh passes the sha through and reads the verdict from what gh returns', () => {
  const sha = 'b'.repeat(40);
  const green = fakeGh({ stdout: JSON.stringify([run('completed', 'success')]), record: true });
  assert.equal(askGh(sha, { gh: green }).code, EXIT.GREEN);
  const argv = fs.readFileSync(green + '.argv', 'utf8');
  assert.match(argv, new RegExp(`--commit ${sha}`), 'the exact sha must reach gh');
  const red = fakeGh({ stdout: JSON.stringify([run('completed', 'failure')]) });
  assert.equal(askGh(sha, { gh: red }).code, EXIT.RED);
});

// ── deploy.sh end to end, in a sandbox ─────────────────────────────────────

/** A fake `gh` executable. Records its argv beside itself when asked. */
function fakeGh({ stdout = '', stderr = '', exit = 0, record = false } = {}) {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const p = fs.mkdtempSync(path.join(SCRATCH, 'fakegh-')) + '/gh';
  const rec = record ? `printf '%s ' "$@" > "$0.argv"\n` : '';
  fs.writeFileSync(p, `#!/bin/sh\n${rec}printf '%s' ${shq(stdout)}\nprintf '%s' ${shq(stderr)} >&2\nexit ${exit}\n`, { mode: 0o755 });
  return p;
}
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** bare origin ← clone (with node_modules dir and tools/) ; an empty serve path. */
function sandbox() {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const dir = fs.mkdtempSync(path.join(SCRATCH, 'deploy-'));
  const origin = path.join(dir, 'origin.git');
  const clone = path.join(dir, 'clone');
  const serve = path.join(dir, 'serve');
  const g = (...a) => { const r = spawnSync('git', a, { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  g('init', '-q', '--bare', origin);
  g('init', '-q', '-b', 'main', clone);
  g('-C', clone, 'config', 'user.email', 't@example.invalid'); g('-C', clone, 'config', 'user.name', 'T');
  fs.mkdirSync(path.join(clone, 'tools'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'tools', 'ci-verdict.mjs'), path.join(clone, 'tools', 'ci-verdict.mjs'));
  fs.mkdirSync(path.join(clone, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'scripts', 'deploy.sh'), path.join(clone, 'scripts', 'deploy.sh'));
  fs.writeFileSync(path.join(clone, 'server.js'), 'v1\n');
  g('-C', clone, 'add', '-A'); g('-C', clone, 'commit', '-qm', 'base');
  g('-C', clone, 'remote', 'add', 'origin', origin); g('-C', clone, 'push', '-q', 'origin', 'main');
  fs.mkdirSync(path.join(clone, 'node_modules'), { recursive: true });
  const sha = g('-C', clone, 'rev-parse', 'HEAD');
  return { clone, serve, sha };
}

function deploy(sb, gh) {
  return spawnSync('sh', [path.join(sb.clone, 'scripts', 'deploy.sh'), '--no-restart'], {
    encoding: 'utf8',
    env: { ...process.env, DEPLOY_CLONE: sb.clone, DEPLOY_SERVE: sb.serve, CI_VERDICT_GH: gh },
  });
}

test('#837 ⛔ RC1 — deploy.sh REFUSES to export a sha whose CI run is RED, and production is untouched', () => {
  const sb = sandbox();
  const r = deploy(sb, fakeGh({ stdout: JSON.stringify([run('completed', 'failure')]) }));
  assert.notEqual(r.status, 0, `expected a refusal, got exit 0:\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout + r.stderr, /RED/);
  assert.equal(fs.existsSync(sb.serve), false, 'a refused deploy must not have exported anything');
});

test('#837 ⛔ deploy.sh REFUSES when it CANNOT ASK (gh broken) — fail-closed, and says UNKNOWN not RED', () => {
  const sb = sandbox();
  const r = deploy(sb, fakeGh({ exit: 1, stderr: 'gh: not logged in' }));
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /UNKNOWN/);
  assert.doesNotMatch(r.stdout + r.stderr, /ci RED/);
  assert.equal(fs.existsSync(sb.serve), false);
});

test('#837 ⛔ deploy.sh REFUSES a sha whose run is still PENDING — it waits for a verdict rather than guessing one', () => {
  const sb = sandbox();
  const r = deploy(sb, fakeGh({ stdout: JSON.stringify([run('in_progress', null)]) }));
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /PENDING/);
  assert.equal(fs.existsSync(sb.serve), false);
});

test('#1108 ⛔ deploy.sh REFUSES a CANCELLED sha and says the verdict was DESTROYED, with the re-run remedy', () => {
  const sb = sandbox();
  const r = deploy(sb, fakeGh({ stdout: JSON.stringify([run('completed', 'cancelled')]) }));
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /CANCELLED/);
  assert.match(r.stdout + r.stderr, /re-run/i);
  assert.doesNotMatch(r.stdout + r.stderr, /CI is RED/, 'a destroyed verdict must not be reported as a failed one');
  assert.equal(fs.existsSync(sb.serve), false);
});

test('#837 ⭐ NEGATIVE CONTROL — a GREEN sha still deploys: the gate discriminates, it does not just refuse', () => {
  const sb = sandbox();
  const r = deploy(sb, fakeGh({ stdout: JSON.stringify([run('completed', 'success')]) }));
  assert.equal(r.status, 0, `a green sha must deploy:\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /GREEN/);
  assert.equal(fs.readFileSync(path.join(sb.serve, 'DEPLOYED-SHA'), 'utf8').trim(), sb.sha, 'the export carries the sha the gate approved');
});

test('#837 the gate asks about the sha the clone is AT AFTER the pull, not before', () => {
  const sb = sandbox();
  const gh = fakeGh({ stdout: JSON.stringify([run('completed', 'success')]), record: true });
  assert.equal(deploy(sb, gh).status, 0);
  assert.match(fs.readFileSync(gh + '.argv', 'utf8'), new RegExp(sb.sha), 'the full HEAD sha must be what gh is asked about');
});
