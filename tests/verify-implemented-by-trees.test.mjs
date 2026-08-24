/**
 * #1040 — `verify-implemented-by` resolved shas against whatever repository it
 * happened to be run from, and its false-positive is an ACCUSATION.
 *
 * ⛔ WHY THAT IS WORSE THAN A WRONG COUNT. This tool exists to answer #896's
 * question — telling a real sha from a fabricated one, after two well-formed
 * 40-character fabrications passed a shape check in a single evening. So
 * "UNRESOLVABLE" does not read as "I could not find it here." It reads as
 * "someone invented this commit."
 *
 * This room has four trees. A commit made in the private ops tree resolves
 * there and reported UNRESOLVABLE from the public repo — same sha, same
 * instant, two answers, and the output named neither tree. That is not
 * hypothetical: two sweeps of the SAME population on the same night returned
 * opposite verdicts, and the entire difference was which trees were searched.
 *
 *     one tree   ⇒ 1 unresolvable   (a real commit, in the other tree)
 *     both trees ⇒ 0 unresolvable   across 171 edges
 *
 * ⭐ SECOND GAP, SAME CALL SITE: `cat-file -e` answers "does this EXIST" and
 * never "did it LAND". A commit on an unmerged branch resolves perfectly — which
 * is how a p0 security card sat in `done` while its fix was on a branch nobody
 * had merged. Both fixes need the same new input (a list of repos), so building
 * them apart would touch one function twice.
 *
 * ⚠️ THE FAILURE MODE OF THIS VERY FIX: a tool that searches more trees is a
 * tool that says "fine" more often. The negative control below is therefore the
 * load-bearing test — assert on the DETECTION, never on a clean report.
 *
 * These tests build REAL git repositories in a temp dir. The defect is entirely
 * about git resolution, so a mocked git would assert nothing about it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveSha } from '../tools/verify-implemented-by.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

/** A real repository with one commit on the default branch. */
function makeRepo(label) {
  const dir = mkdtempSync(join(tmpdir(), `vib-${label}-`));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.name', 'Fixture');
  git(dir, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(dir, 'a.txt'), `${label}\n`);
  git(dir, 'add', 'a.txt');
  git(dir, 'commit', '-q', '-m', `${label} base`);
  return { dir, head: git(dir, 'rev-parse', 'HEAD') };
}

/** A commit that exists but is NOT an ancestor of HEAD — a branch mid-flight. */
function commitOnUnmergedBranch(dir) {
  const base = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', '-b', 'side');
  writeFileSync(join(dir, 'b.txt'), 'side\n');
  git(dir, 'add', 'b.txt');
  git(dir, 'commit', '-q', '-m', 'work on a branch');
  const sha = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', '-');
  assert.equal(git(dir, 'rev-parse', 'HEAD'), base, 'fixture must leave HEAD where it was');
  return sha;
}

const FABRICATED = 'deadbeef'.repeat(5); // 40 hex chars, well-formed, invented

test('#1040 a sha living in ANOTHER known tree resolves, and the result NAMES that tree', () => {
  const a = makeRepo('a');
  const b = makeRepo('b');
  try {
    // ⭐ ANTI-VACUITY / THE ACTUAL DEFECT, asserted first: searching only tree A
    // must report b.head unresolvable. Without this, "found it" proves nothing —
    // it could have been findable from one tree all along.
    const oneTree = resolveSha(b.head, [a.dir]);
    assert.equal(oneTree.resolved, false,
      'precondition: tree B\'s commit must NOT resolve from tree A alone — that is the bug');

    const bothTrees = resolveSha(b.head, [a.dir, b.dir]);
    assert.equal(bothTrees.resolved, true, 'searching both trees must find it');
    assert.equal(bothTrees.tree, b.dir,
      'the result must NAME the tree it resolved in — a clean run has to be auditable '
      + 'by someone who did not run it');
  } finally { rmSync(a.dir, { recursive: true, force: true }); rmSync(b.dir, { recursive: true, force: true }); }
});

test('#1040 ⛔ NEGATIVE CONTROL — a FABRICATED sha is still reported, however many trees are searched', () => {
  const a = makeRepo('a');
  const b = makeRepo('b');
  try {
    // ⛔ THE ONE THAT MATTERS. A tool that resolves against more trees is a tool
    // that says "fine" more often; the failure mode of this fix is laundering a
    // fabrication by finding it nowhere and shrugging.
    const r = resolveSha(FABRICATED, [a.dir, b.dir]);
    assert.equal(r.resolved, false, 'an invented sha must not become resolvable by widening the search');
    assert.equal(r.tree, null, 'and no tree may be named for it');
  } finally { rmSync(a.dir, { recursive: true, force: true }); rmSync(b.dir, { recursive: true, force: true }); }
});

test('#1040 a commit that EXISTS but never LANDED is resolved and reported as NOT MERGED', () => {
  const a = makeRepo('a');
  try {
    const branchSha = commitOnUnmergedBranch(a.dir);

    // ⭐ POSITIVE CONTROL FIRST: the base commit IS landed, so "landed:false"
    // below cannot be a function that always says false.
    const base = resolveSha(a.head, [a.dir]);
    assert.equal(base.resolved, true);
    assert.equal(base.landed, true, 'a commit on HEAD must read as landed');

    const side = resolveSha(branchSha, [a.dir]);
    assert.equal(side.resolved, true, '`cat-file -e` finds it — existence was never the problem');
    assert.equal(side.landed, false,
      'a commit on an unmerged branch must be reported as NOT landed — this is how a card '
      + 'sits in `done` while its fix is on a branch nobody merged');
  } finally { rmSync(a.dir, { recursive: true, force: true }); }
});

test('#1040 ⭐ NOT-MERGED IS NOT A FAILURE — only unresolvable-anywhere is', () => {
  const a = makeRepo('a');
  try {
    const branchSha = commitOnUnmergedBranch(a.dir);
    // ⚠️ A branch mid-flight is a NORMAL state. A tool that fails its caller for
    // a normal state teaches the caller to stop calling it — the drift report's
    // own stated reason for reporting rather than gating.
    assert.equal(resolveSha(branchSha, [a.dir]).fatal, false,
      'an unmerged branch must not be a fatal finding');
    assert.equal(resolveSha(FABRICATED, [a.dir]).fatal, true,
      'a sha that resolves in NO known tree is the fatal one — that is the fabrication case');
  } finally { rmSync(a.dir, { recursive: true, force: true }); }
});
