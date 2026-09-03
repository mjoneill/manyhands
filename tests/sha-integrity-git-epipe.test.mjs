/**
 * #1154 — gitRootResolver must survive git exiting BEFORE the sha list is
 * written to its stdin.
 *
 * Seen twice in CI on 2026-09-03 (runs 33757959583, 33768400626): the stamper
 * process died with `write EPIPE` as an UNHANDLED 'error' event, raised on
 * `child.stdin` — which had no error listener — when `git cat-file
 * --batch-check` exited before reading a list larger than the pipe buffer.
 * The Promise never settled; the test runner's process threw. On a real
 * deploy that is a stamp that never lands. The right outcome is the one the
 * exec callback already produces: a REJECTION carrying git's own stderr, so
 * the root reads as unreadable (#1008's fail-closed shape), not a crash.
 *
 * The fake git exits WITHOUT reading stdin, and the list is larger than any
 * pipe buffer (macOS 64 KiB, Linux 64 KiB), so the write genuinely blocks
 * and EPIPEs — a short list is fully buffered before git exits and never
 * reproduces the defect.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitRootResolver } from '../core/sha-integrity.mjs';

function fakeGitOnPath(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-git-'));
  const bin = path.join(dir, 'git');
  fs.writeFileSync(bin, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return { dir, restore: ((prev) => () => { process.env.PATH = prev; fs.rmSync(dir, { recursive: true, force: true }); })(process.env.PATH) };
}
const BIG = Array.from({ length: 4000 }, (_, i) => (i.toString(16).padStart(40, '0')));   // ~164 KB, > any pipe buffer

test('#1154 git exiting before it reads stdin ⇒ the resolver REJECTS with git\'s words; the process does not die', async () => {
  const { dir, restore } = fakeGitOnPath('echo "fatal: not a git repository (or any of the parent directories): .git" >&2; exit 128');
  process.env.PATH = `${dir}:${process.env.PATH}`;
  let unhandled = null;
  const onErr = (e) => { unhandled = e; };
  process.on('uncaughtException', onErr);
  try {
    const r = gitRootResolver(os.tmpdir());
    await assert.rejects(r.resolve(BIG), /not a git repository/, 'the verdict is git\'s stderr, not EPIPE');
    await new Promise((res) => setTimeout(res, 100));   // give a stray 'error' event its chance to fire
    assert.equal(unhandled, null, `no process-level throw: ${unhandled}`);
  } finally { process.off('uncaughtException', onErr); restore(); }
});

test('#1154 NEGATIVE CONTROL — a git that reads its input still resolves; the handler must not swallow a working root', async () => {
  const { dir, restore } = fakeGitOnPath('while read sha; do echo "$sha commit 1"; done');
  process.env.PATH = `${dir}:${process.env.PATH}`;
  try {
    const live = await gitRootResolver(os.tmpdir()).resolve(BIG.slice(0, 3));
    assert.deepEqual([...live].sort(), BIG.slice(0, 3).sort());
  } finally { restore(); }
});
