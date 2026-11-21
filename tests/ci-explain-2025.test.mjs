/**
 * #2025 — `ci-verdict.mjs <sha> --explain`, end to end, with a FAKE gh (CI_VERDICT_GH) and a real throwaway git repo:
 *
 *   E1  THE DIFF IS ASKED FOR: the base comes from the PR that carries the sha, git diffs it, and a failure that names
 *       an identifier only the diff introduced is "caused by the diff", although its file is not in the diff.
 *   E2  NO PR, NO ATTRIBUTION: without a base nothing is blamed on the diff, the output says so, and a failure on a
 *       sha that passed in another run is a probable flake.
 *   E3  THE GATE IS UNCHANGED: --explain exits with the gate's code (RED 1, GREEN 0), whatever it explains.
 *   E4  READ-ONLY: the only gh verbs it uses are `run list`, `run view` and `api` (a GET); never rerun, never push.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-explain-2025-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const git = (...a) => { const r = spawnSync('git', a, { cwd: REPO, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
const REPO = path.join(TMP, 'repo');
fs.mkdirSync(REPO);
git('init', '-q');
git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'root');
fs.writeFileSync(path.join(REPO, 'old.mjs'), 'export const ALREADY_THERE = 1;\n');
git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'base');
const BASE = git('rev-parse', 'HEAD');
fs.writeFileSync(path.join(REPO, 'feature.mjs'), "export const code = 'BRAND_NEW_CODE';\n");
git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'head');
const HEAD = git('rev-parse', 'HEAD');

const LOG = (error) => [
  `server suite\tRun the server suite\t2026-11-21T00:00:00.0Z not ok 7 - G1 every code is registered`,
  `server suite\tRun the server suite\t2026-11-21T00:00:00.0Z   ---`,
  `server suite\tRun the server suite\t2026-11-21T00:00:00.0Z   location: '/home/runner/work/r/r/tests/guard.test.mjs:1:1'`,
  `server suite\tRun the server suite\t2026-11-21T00:00:00.0Z   error: '${error}'`,
  `server suite\tRun the server suite\t2026-11-21T00:00:00.0Z   ...`,
  `server suite\tRun the server suite\t2026-11-21T00:00:00.0Z # fail 1`,
  `server suite\tRun the server suite\t2026-11-21T00:00:00.0Z # ⛔ FILE EXITED with code 1: tests/guard.test.mjs`,
].join('\n');

/** A fake gh that answers from a JSON plan and records every call. */
function fakeGh(name, plan) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(plan));
  const bin = path.join(dir, 'gh');
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const plan = JSON.parse(fs.readFileSync(path.join(${JSON.stringify(dir)}, 'plan.json'), 'utf8'));
const a = process.argv.slice(2);
fs.appendFileSync(path.join(${JSON.stringify(dir)}, 'calls.log'), a.join(' ') + '\\n');
if (a[0] === 'run' && a[1] === 'list') { process.stdout.write(JSON.stringify(plan.runs)); process.exit(0); }
if (a[0] === 'run' && a[1] === 'view') { process.stdout.write(plan.logs[a[2]] || ''); process.exit(plan.logs[a[2]] ? 0 : 1); }
if (a[0] === 'api') { process.stdout.write(plan.base || ''); process.exit(0); }
process.stderr.write('fake gh: unexpected ' + a.join(' ')); process.exit(9);
`);
  fs.chmodSync(bin, 0o755);
  return { bin, calls: () => fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').trim().split('\n') };
}
function cli(gh, ...extra) {
  return spawnSync(process.execPath, [path.join(ROOT, 'tools', 'ci-verdict.mjs'), HEAD, '--explain', ...extra], { encoding: 'utf8', cwd: REPO, env: { ...process.env, CI_VERDICT_GH: gh } });
}
const RED = { databaseId: 11, attempt: 1, event: 'pull_request', status: 'completed', conclusion: 'failure', workflowName: 'CI', url: 'u' };
const GREEN = { databaseId: 12, attempt: 1, event: 'push', status: 'completed', conclusion: 'success', workflowName: 'CI', url: 'u' };

// explain() diffs inside the tool's own repo by default; these tests point it at the throwaway repo.
const { explain } = await import('../tools/ci-verdict.mjs');

test('E1 THE DIFF IS ASKED FOR: a failure naming what only the diff added is caused by the diff', async () => {
  const gh = fakeGh('e1', { runs: [RED], logs: { 11: LOG('register BRAND_NEW_CODE in the table') }, base: BASE });
  const x = await explain(HEAD, { gh: gh.bin, cwd: REPO });
  assert.equal(x.code, 1);
  assert.deepEqual(x.diagnosis.findings.map((f) => [f.file, f.class, f.inDiff]), [['tests/guard.test.mjs', 'caused-by-diff', false]]);
  assert.ok(x.diagnosis.findings[0].evidence.includes('BRAND_NEW_CODE'));
  assert.ok(!x.diagnosis.findings[0].evidence.includes('ALREADY_THERE'));
  const control = fakeGh('e1c', { runs: [RED], logs: { 11: LOG('register ALREADY_THERE in the table') }, base: BASE });
  const c = await explain(HEAD, { gh: control.bin, cwd: REPO });
  assert.equal(c.diagnosis.findings[0].class, 'unknown', 'a name the base already had is not evidence');
});

test('E2 NO PR, NO ATTRIBUTION: nothing is blamed on the diff, it says so, and a same-sha pass makes a probable flake', async () => {
  const gh = fakeGh('e2', { runs: [RED, GREEN], logs: { 11: LOG('register BRAND_NEW_CODE in the table') }, base: '' });
  const x = await explain(HEAD, { gh: gh.bin, cwd: REPO });
  assert.equal(x.diagnosis.findings[0].class, 'probable-flake');
  assert.match(x.text, /no PR carries this sha/);
  const given = await explain(HEAD, { gh: gh.bin, cwd: REPO, base: BASE });
  assert.equal(given.diagnosis.findings[0].class, 'caused-by-diff', 'an explicit base restores attribution');
});

test('E3 THE GATE IS UNCHANGED: the CLI exits with the gate\'s code', () => {
  const red = fakeGh('e3r', { runs: [RED], logs: { 11: LOG('x') }, base: BASE });
  const r = cli(red.bin);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /CI verdict for/);
  const green = fakeGh('e3g', { runs: [GREEN], logs: {}, base: BASE });
  const g = cli(green.bin);
  assert.equal(g.status, 0, g.stderr);
  assert.match(g.stdout, /GREEN/);
});

test('E4 READ-ONLY: only run list, run view and api are asked', async () => {
  const gh = fakeGh('e4', { runs: [RED, GREEN], logs: { 11: LOG('x') }, base: BASE });
  await explain(HEAD, { gh: gh.bin, cwd: REPO });
  const verbs = gh.calls().map((c) => c.split(' ').slice(0, c.startsWith('api') ? 1 : 2).join(' '));
  assert.deepEqual([...new Set(verbs)].sort(), ['api', 'run list', 'run view']);
  assert.ok(gh.calls().every((c) => !/\b(rerun|push|merge|cancel|-X|--method)\b/.test(c)), gh.calls().join('\n'));
});
