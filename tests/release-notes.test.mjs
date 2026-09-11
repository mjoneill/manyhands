/**
 * #1026 — release notes per deploy: a tag for the handle, generated notes for
 * the "what changed", published where a downstream reader looks.
 *
 * Shape A+B from the card's ruling. The generator is NOT a second commit-walker:
 * `commitsBetween` is the drift tool's own listing, extracted so both callers
 * share one idea of "the commits in a range" (#1042 is why).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { renderReleaseNotes, nextTagName, groupCommits } from '../tools/release-notes.mjs';
import { commitsBetween } from '../tools/deploy-drift.mjs';

const c = (short, subject, isRuntime = true) => ({ sha: short.padEnd(40, '0'), short, subject, files: [], runtimeFiles: isRuntime ? ['server.js'] : [], isRuntime });

test('#1026 A — notes group by conventional prefix, name every commit, and keep the card number readable', () => {
  const commits = [
    c('aaaaaaa', 'feat(#1331): one export service with a mode argument'),
    c('bbbbbbb', 'fix(#1338): refuse any request whose Host does not name this server'),
    c('ccccccc', 'test(#1331): specimens must be shapes, never people', false),
    c('ddddddd', 'docs: SECURITY.md names DNS rebinding', false),
  ];
  const md = renderReleaseNotes({ tag: 'v2026.09.10', from: '1111111', to: '2222222', commits });
  assert.match(md, /## Features/);
  assert.match(md, /## Fixes/);
  assert.match(md, /one export service with a mode argument.*\(aaaaaaa\)/);
  assert.match(md, /refuse any request whose Host.*\(bbbbbbb\)/);
  assert.match(md, /#1338/, 'the card number stays in the line — it is the reader\'s handle back to the board');
  assert.match(md, /Tests and tooling only/, 'test-only commits are named but set apart: deploying them changed nothing running');
  assert.match(md, /1111111\.\.2222222/, 'the range is stated so the notes say what they cover');
});

test('#1026 B — a date-based tag, and a same-day second deploy gets a suffix rather than a collision', () => {
  assert.equal(nextTagName(new Date('2026-09-10T23:07:13Z'), []), 'v2026.09.10');
  assert.equal(nextTagName(new Date('2026-09-10T23:07:13Z'), ['v2026.09.10']), 'v2026.09.10.2');
  assert.equal(nextTagName(new Date('2026-09-10T23:07:13Z'), ['v2026.09.10', 'v2026.09.10.2']), 'v2026.09.10.3');
  assert.equal(nextTagName(new Date('2026-09-11T00:00:01Z'), ['v2026.09.10', 'v2026.09.10.2']), 'v2026.09.11', 'a new day starts clean');
  // Not semver, on purpose: nothing here has a compatibility contract, and a
  // number that implies one would be a lie (the card's ruling). A date reads
  // as a date.
  assert.match(nextTagName(new Date('2026-09-10T00:00:00Z'), []), /^v20\d\d\.\d\d\.\d\d$/);
});

test('#1026 NEGATIVE CONTROL — poor subjects degrade VISIBLY: the notes say how many lines are unreadable, never render them as if they were fine', () => {
  const commits = [
    c('aaaaaaa', 'feat(#1331): one export service with a mode argument'),
    c('bbbbbbb', 'wip'),
    c('ccccccc', 'fix stuff'),
    c('ddddddd', 'Merge branch card/x into main'),
  ];
  const md = renderReleaseNotes({ tag: 'v2026.09.10', from: '1', to: '2', commits });
  assert.match(md, /3 of 4 commits? (have|has) no readable subject/i, 'the thinness is stated as a number');
  assert.match(md, /## Other/, 'and the unreadable ones are set apart, not mixed into Features');
  assert.match(md, /\(bbbbbbb\)/, 'but still named — a reader can go look');
  assert.doesNotMatch(md.split('## Other')[0], /wip|fix stuff/, 'nothing unreadable is presented under a confident heading');
});

test('#1026 NEGATIVE CONTROL — the notes say which HALF of the question they answer', () => {
  const md = renderReleaseNotes({ tag: 'v2026.09.10', from: '1', to: '2', commits: [c('aaaaaaa', 'feat: x')] });
  // The card's discriminator: A+B answer "what changed" completely and
  // "understand the evolution over time" not at all. A note that let a reader
  // believe otherwise is the overclaim the card exists to prevent.
  assert.match(md, /what changed between two deploys/i);
  assert.match(md, /not .*evolution/i);
});

test('#1026 an EMPTY range renders as empty, stated — not as a blank page and not as an error', () => {
  const md = renderReleaseNotes({ tag: 'v2026.09.10', from: '1', to: '1', commits: [] });
  assert.match(md, /no commits/i);
});

test('#1026 commitsBetween is the drift tool\'s listing — one walker, two callers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relnotes-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t.test', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t.test' } }).trim();
  g('init', '-q');
  fs.writeFileSync(path.join(dir, 'server.js'), '1'); g('add', '.'); g('commit', '-qm', 'feat: first');
  const base = g('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(dir, 'server.js'), '2'); g('add', '.'); g('commit', '-qm', 'fix(#1): runtime change');
  fs.mkdirSync(path.join(dir, 'tests')); fs.writeFileSync(path.join(dir, 'tests', 'a.test.mjs'), '1'); g('add', '.'); g('commit', '-qm', 'test(#1): test only');
  const head = g('rev-parse', 'HEAD');
  const commits = commitsBetween(dir, base, head);
  assert.equal(commits.length, 2);
  assert.deepEqual(commits.map((x) => [x.subject, x.isRuntime]), [['fix(#1): runtime change', true], ['test(#1): test only', false]]);
  assert.equal(commits[1].sha, head);
  fs.rmSync(dir, { recursive: true, force: true });
});
