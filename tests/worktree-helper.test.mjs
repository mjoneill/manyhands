/**
 * #877 — scripts/worktree.sh: the one way to make, list and retire a build
 * worktree. Exercised against a throwaway repo with no board reachable, so
 * `list` must degrade to "(board unreachable)" rather than fail.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'worktree.sh');

function makeRepo() {
  // realpath: git resolves the temp dir's symlink (/var → /private/var on macOS)
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-877-')));
  const dir = path.join(base, 'repo');
  fs.mkdirSync(dir);
  const git = (args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString();
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Owner']); git(['config', 'user.email', 'owner@example.com']);
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.copyFileSync(SCRIPT, path.join(dir, 'scripts', 'worktree.sh'));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  git(['add', '.']); git(['commit', '-q', '-m', 'seed']);
  return { base, dir, git };
}
const run = (dir, args) => {
  const r = spawnSync('sh', [path.join(dir, 'scripts', 'worktree.sh'), ...args], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, SCRUM_BOARD_URL: 'http://127.0.0.1:9' },
  });
  return { status: r.status, out: r.stdout + r.stderr };
};

test('#877 home is BESIDE the repo, named for it; new/list/done round-trip; done refuses a dirty tree', () => {
  const { base, dir, git } = makeRepo();
  const home = run(dir, ['home']);
  assert.equal(home.status, 0);
  assert.equal(home.out.trim(), path.join(base, 'repo.worktrees'), 'home = <repo>.worktrees beside the repo');

  const made = run(dir, ['new', '42', 'Probe Thing!']);
  assert.equal(made.status, 0, made.out);
  const wt = path.join(base, 'repo.worktrees', '42-Probe-Thing');
  assert.ok(fs.existsSync(path.join(wt, 'a.txt')), 'the worktree is checked out at <home>/<card>-<slug>');
  assert.match(git(['-C', wt, 'branch', '--show-current']), /^card\/42-Probe-Thing/, 'branch card/<card>-<slug>');
  assert.match(made.out, /board unreachable/, 'no board → says so, does not fail');

  const again = run(dir, ['new', '42', 'Probe Thing!']);
  assert.equal(again.status, 1, 'a second worktree for the same card is refused');

  const list = run(dir, ['list']);
  assert.equal(list.status, 0, list.out);
  assert.match(list.out, /PRIMARY\s+\S+repo\s+\[main\]/, 'the primary is named as the shared checkout');
  assert.match(list.out, /^home\s+\S+42-Probe-Thing\s+\[card\/42-Probe-Thing\]/m, 'the worktree is listed as in the home with its card');
  assert.match(list.out, /#42 \(board unreachable\)/);

  fs.writeFileSync(path.join(wt, 'a.txt'), 'changed');
  const dirty = run(dir, ['done', '42']);
  assert.equal(dirty.status, 1, 'done refuses a dirty worktree');
  assert.match(dirty.out, /uncommitted work/);
  assert.ok(fs.existsSync(wt), 'and leaves it in place');

  execFileSync('git', ['-C', wt, 'checkout', '--', 'a.txt']);
  const done = run(dir, ['done', '42']);
  assert.equal(done.status, 0, done.out);
  assert.ok(!fs.existsSync(wt), 'removed');
  assert.match(git(['worktree', 'list']), /^(?!.*42-Probe-Thing)/m, 'registry pruned');
  assert.match(git(['branch', '--list', 'card/42-*']), /card\/42-Probe-Thing/, 'the branch is kept');
});

test('#877 list flags a worktree OUTSIDE the home and a branch naming no card', () => {
  const { base, dir, git } = makeRepo();
  const stray = path.join(base, 'stray');
  git(['worktree', 'add', '-q', '-b', 'feature/no-card', stray]);
  const list = run(dir, ['list']);
  assert.equal(list.status, 0, list.out);
  assert.match(list.out, /OUTSIDE HOME\s+\S+stray\s+\[feature\/no-card\]/, 'outside the home is flagged');
  assert.match(list.out, /NO CARD/, 'a branch naming no card is flagged');
});

test('#877 new refuses a non-numeric card', () => {
  const { dir } = makeRepo();
  const r = run(dir, ['new', 'abc']);
  assert.equal(r.status, 1);
  assert.match(r.out, /card must be a number/);
});

// The property the owner's concern reduces to, stated as a test rather than a
// list of walkers to remember: nothing under the repo root can be a worktree
// home, so no test discovery or tree walk inside the repo can ever see one.
// Test discovery is a flat glob; the home resolves OUTSIDE the root.
test('#877 the worktree home is outside the repo root, and test discovery is a flat glob — no walker can count a worktree', () => {
  const home = execFileSync('sh', [SCRIPT, 'home'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const rel = path.relative(fs.realpathSync(ROOT), fs.realpathSync(path.dirname(home)));
  assert.ok(rel === '..' || rel.startsWith('..' + path.sep) || rel === '', `home ${home} must sit beside the repo, not inside it (relative: ${rel})`);
  assert.ok(!fs.realpathSync(home + '/..').startsWith(fs.realpathSync(ROOT) + path.sep), 'home is not under the repo root');
  const runner = fs.readFileSync(path.join(ROOT, 'scripts', 'run-tests.sh'), 'utf8');
  assert.match(runner, /set -- tests\/\*\.test\.mjs/, 'discovery is the flat tests/*.test.mjs, not a recursive walk');
});

test('#877 adopt moves an OUTSIDE worktree into the home and re-links node_modules absolute; list flags a broken link first', () => {
  const { base, dir, git } = makeRepo();
  // A fake node_modules on the primary, and a worktree outside the home with a
  // RELATIVE link that is correct at sibling depth and wrong one level deeper.
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'node_modules', '.package-lock.json'), '{}');
  const stray = path.join(base, 'stray-7');
  git(['worktree', 'add', '-q', '-b', 'card/7-stray', stray]);
  fs.symlinkSync('../repo/node_modules', path.join(stray, 'node_modules'));
  assert.ok(fs.existsSync(path.join(stray, 'node_modules', '.package-lock.json')), 'precondition: the relative link works at sibling depth');

  const adopted = run(dir, ['adopt', stray, '7', 'stray']);
  assert.equal(adopted.status, 0, adopted.out);
  const dest = path.join(base, 'repo.worktrees', '7-stray');
  assert.ok(fs.existsSync(path.join(dest, 'a.txt')), 'moved into the home');
  assert.ok(!fs.existsSync(stray), 'and gone from outside');
  assert.equal(fs.readlinkSync(path.join(dest, 'node_modules')), path.join(dir, 'node_modules'), 'node_modules re-linked ABSOLUTE');
  assert.ok(fs.existsSync(path.join(dest, 'node_modules', '.package-lock.json')), 'and it resolves one level deeper');

  // A worktree whose link is broken is flagged by list, with the ERROR-not-fail warning.
  const broken = path.join(base, 'repo.worktrees', '8-broken');
  git(['worktree', 'add', '-q', '-b', 'card/8-broken', broken]);
  fs.symlinkSync('../nowhere/node_modules', path.join(broken, 'node_modules'));
  const list = run(dir, ['list']);
  assert.match(list.out, /8-broken.*node_modules does not resolve/, 'broken link flagged');
  assert.doesNotMatch(list.out, /7-stray.*does not resolve/, 'the adopted one is not flagged');
});
