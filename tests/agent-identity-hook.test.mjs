/**
 * #596 — the agent-identity pre-commit rail.
 *
 * The rule: an agent session (CLAUDECODE or AI_AGENT in env) must commit
 * under a seat identity (*@manyhands.invalid). A human terminal carries no
 * agent marker and must NEVER be refused — that boundary is the card's
 * hard constraint, so it gets its own control here.
 *
 * Three controls (the third is the one that would embarrass us: a hook
 * that refuses everything is indistinguishable from a working hook until
 * it blocks a legitimate commit).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.githooks', 'pre-commit');

// A clean env with NO agent markers — the human-terminal baseline.
function baseEnv() {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.AI_AGENT;
  return env;
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-596-'));
  const git = (args, env) => execFileSync('git', args, { cwd: dir, env, stdio: 'pipe' });
  git(['init', '-q'], baseEnv());
  // The tree's fallback human identity, as in the real repo.
  git(['config', 'user.name', 'Default Human'], baseEnv());
  git(['config', 'user.email', 'human@example.com'], baseEnv());
  fs.mkdirSync(path.join(dir, '.githooks'));
  fs.copyFileSync(HOOK, path.join(dir, '.githooks', 'pre-commit'));
  fs.chmodSync(path.join(dir, '.githooks', 'pre-commit'), 0o755);
  // The dispatcher shim, exactly as installed in the live tree.
  fs.writeFileSync(path.join(dir, '.git', 'hooks', 'pre-commit'),
    '#!/bin/sh\nexec "$(git rev-parse --show-toplevel)/.githooks/pre-commit" "$@"\n');
  fs.chmodSync(path.join(dir, '.git', 'hooks', 'pre-commit'), 0o755);
  return { dir, git };
}

function tryCommit({ git, dir }, { env, stamp }) {
  fs.appendFileSync(path.join(dir, 'f.txt'), 'x');
  git(['add', 'f.txt'], baseEnv());
  const args = ['commit', '-q', '-m', 'probe'];
  const idArgs = stamp
    ? ['-c', `user.name=${stamp.name}`, '-c', `user.email=${stamp.email}`]
    : [];
  try {
    git([...idArgs, ...args], env);
    return { ok: true };
  } catch (e) {
    return { ok: false, stderr: String(e.stderr) };
  }
}

test('agent env + default human identity → REFUSED, naming the fix', () => {
  const repo = makeRepo();
  const r = tryCommit(repo, { env: { ...baseEnv(), CLAUDECODE: '1' } });
  assert.equal(r.ok, false, 'unstamped agent commit must refuse');
  assert.match(r.stderr, /#596/, 'refusal names the card');
  assert.match(r.stderr, /stamp your seat/, 'refusal names the fix');
});

test('AI_AGENT alone also triggers the rail (union of markers — not Claude-only)', () => {
  const repo = makeRepo();
  const r = tryCommit(repo, { env: { ...baseEnv(), AI_AGENT: '1' } });
  assert.equal(r.ok, false, 'the rail must not be blind to non-Claude toolchains');
});

test('agent env + seat identity → PASSES (a correctly stamped commit is never blocked)', () => {
  const repo = makeRepo();
  const r = tryCommit(repo, {
    env: { ...baseEnv(), CLAUDECODE: '1' },
    stamp: { name: 'Ada', email: 'ada@manyhands.invalid' },
  });
  assert.equal(r.ok, true, `stamped agent commit must pass: ${r.stderr ?? ''}`);
});

test('no agent env + any identity → PASSES (a human commit can never be refused)', () => {
  const repo = makeRepo();
  const r = tryCommit(repo, { env: baseEnv() });
  assert.equal(r.ok, true, 'the human-terminal boundary is absolute');
});
