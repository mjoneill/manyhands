/**
 * #1851 — scripts/link-run.mjs, the operator's door to one linking run (re-link an existing extraction Run, or read a dry run
 * first). It refuses to START without what it needs, naming the variable or flag and never a value, before any network.
 *
 *   C1  no SCRUM_SEAT_TOKEN_FILE ⇒ exit 2, stderr names it, nothing else printed
 *   C2  no --run ⇒ exit 2 naming --run
 *   C3  no --min-score ⇒ exit 2 naming --min-score: the threshold is config, never a hidden default
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PROJECT_DIR } from './helpers/harness.mjs';

const SCRIPT = path.join(PROJECT_DIR, 'scripts', 'link-run.mjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkrun-1851-'));
const tok = path.join(dir, 'tok'); fs.writeFileSync(tok, 'not-a-real-token\n');
process.once('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
// a CLOSED port: if the script ever reached the network before refusing, it would fail differently, not exit 2
const BASE = { SCRUM_BOARD_URL: 'http://127.0.0.1:9', SCRUM_GRAPH_EXECUTOR_URL: 'http://127.0.0.1:9', SCRUM_GRAPH_DATASET_ID: 'x', SCRUM_SEAT_TOKEN_FILE: tok };
const run = (env, args) => {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('SCRUM_')));
  return spawnSync(process.execPath, [SCRIPT, ...args], { env: { ...clean, ...env }, encoding: 'utf8', timeout: 30000 });
};

test('C1 no SCRUM_SEAT_TOKEN_FILE: exit 2 naming it', () => {
  const { SCRUM_SEAT_TOKEN_FILE, ...env } = BASE;
  const r = run(env, ['--run', 'https://scrumboard.local/activity/run-x', '--min-score', '0.62']);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /SCRUM_SEAT_TOKEN_FILE/);
  assert.equal(r.stdout, '');
  void SCRUM_SEAT_TOKEN_FILE;
});

test('C2 no --run: exit 2 naming --run', () => {
  const r = run(BASE, ['--min-score', '0.62']);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--run/);
});

test('C3 no --min-score: exit 2 naming it (the threshold is config, never a hidden default)', () => {
  const r = run(BASE, ['--run', 'https://scrumboard.local/activity/run-x']);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--min-score/);
  assert.doesNotMatch(r.stderr + r.stdout, /not-a-real-token/, 'the token value is never printed');
});
