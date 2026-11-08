/**
 * #539, process-path leg: serve-cwd-check says where each running board service's cwd is, by INODE.
 *
 * The specimen (2026-11-07/08): two services ran for a week from folders an earlier deploy had deleted, while lsof
 * still printed a path that EXISTED, holding a different folder. A path compare reads that as fine, so these rows
 * pin that the verdict is decided by inode and that "could not check" never reads as a pass.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLaunchctl, parseLsofCwd, classify, exitCodeFor } from '../scripts/serve-cwd-check.mjs';

const TREES = { serveInode: 1000, previousInode: 900 };

test('parseLaunchctl keeps only com.scrumboard.* jobs, with a pid only when running', () => {
  const jobs = parseLaunchctl([
    'PID\tStatus\tLabel',
    '59610\t0\tcom.scrumboard.rest',
    '-\t1\tcom.scrumboard.announce-publisher',
    '4242\t0\tcom.example.other',
  ].join('\n'));
  assert.deepEqual(jobs, [
    { label: 'com.scrumboard.rest', pid: 59610 },
    { label: 'com.scrumboard.announce-publisher', pid: null },
  ]);
});

test('parseLsofCwd reads the inode and the (cached) name from -Fin output', () => {
  assert.deepEqual(parseLsofCwd('p1756\nfcwd\ni218234870\nn/srv/app.previous/graph-executor\n'),
    { inode: 218234870, name: '/srv/app.previous/graph-executor' });
  assert.deepEqual(parseLsofCwd(''), { inode: null, name: null });
});

test('serve and previous are decided by inode', () => {
  assert.equal(classify({ pid: 1, cwdInode: 1000, nameInode: 1000 }, TREES), 'serve');
  assert.equal(classify({ pid: 1, cwdInode: 900, nameInode: 900 }, TREES), 'previous');
});

test('the specimen: the cached path EXISTS but holds another folder, so the cwd is GONE', () => {
  // graph-executor: lsof named `.previous/graph-executor`, which exists now with a different inode
  assert.equal(classify({ pid: 1756, cwdInode: 218234870, nameInode: 231120318 }, TREES), 'GONE');
  // activity-projector: lsof named `.previous` itself; that path is the LIVE .previous (900), not its cwd
  assert.equal(classify({ pid: 1770, cwdInode: 218234695, nameInode: 900 }, TREES), 'GONE');
  // and a path that no longer exists at all
  assert.equal(classify({ pid: 7, cwdInode: 55, nameInode: null }, TREES), 'GONE');
});

// Found in review: matching the two folders by their OWN inode missed a cwd that is a SUBFOLDER of them.
const REAL = { ...TREES, serveReal: '/srv/app', previousReal: '/srv/app.previous' };

test('a SUBFOLDER of .previous whose name is true is `previous` (the day the executor problem began), exit 1', () => {
  const v = classify({ pid: 1756, cwdInode: 77, nameInode: 77, nameReal: '/srv/app.previous/graph-executor' }, REAL);
  assert.equal(v, 'previous', 'running from a folder the next deploy deletes must not read as fine');
  assert.equal(exitCodeFor([v]), 1);
});

test('a SUBFOLDER of serve whose name is true is `serve` (a healthy executor after the restart)', () => {
  assert.equal(classify({ pid: 1756, cwdInode: 88, nameInode: 88, nameReal: '/srv/app/graph-executor' }, REAL), 'serve');
});

test('the prefix match is by folder: `/srv/app2` is not under `/srv/app`, and a STALE name still reads GONE', () => {
  assert.equal(classify({ pid: 3, cwdInode: 99, nameInode: 99, nameReal: '/srv/app2/x' }, REAL), 'other');
  // the name points into .previous, but that path now holds another inode: the name proves nothing
  assert.equal(classify({ pid: 4, cwdInode: 66, nameInode: 67, nameReal: '/srv/app.previous/graph-executor' }, REAL), 'GONE');
});

test('a cwd outside serve that still exists is `other`, not GONE (a job that runs from `/`)', () => {
  assert.equal(classify({ pid: 1768, cwdInode: 2, nameInode: 2 }, TREES), 'other');
});

test('no pid is not-running; a pid with an unreadable cwd is `unknown`, never a pass', () => {
  assert.equal(classify({ pid: null, cwdInode: null, nameInode: null }, TREES), 'not-running');
  assert.equal(classify({ pid: 5, cwdInode: null, nameInode: null }, TREES), 'unknown');
});

test('exit code: unknown (2) beats GONE/previous (1) beats all-clear (0)', () => {
  assert.equal(exitCodeFor(['serve', 'other', 'not-running']), 0);
  assert.equal(exitCodeFor(['serve', 'previous']), 1);
  assert.equal(exitCodeFor(['serve', 'GONE']), 1);
  assert.equal(exitCodeFor(['GONE', 'unknown']), 2);
});
