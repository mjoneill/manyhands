/**
 * #1778 — what a suite-watch TIMEOUT says. On 10-26 the whole-run deadline killed a suite in which 682 of 684 files had
 * completed and the runner had killed none as hung, and the alarm read "This is a HANG". These rows pin the reading the watch
 * now gives (scripts/suite-watch-timeout.mjs): the runner's own HUNG kills are named when there are any; with none, the alarm
 * says that no per-file hang was DETECTED and that the counts point to growth, and it never claims a hang it did not see.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hungFilesIn, timeoutReading } from '../scripts/suite-watch-timeout.mjs';

// the runner's real kill line (scripts/run-test-files.mjs), and the runner's own TEST NAME that quotes it (from the 10-26 TAP)
const KILL = (f) => `# ⛔ HUNG: tests/${f} exceeded 300000ms and was killed with its process group.`;
const T16_NAME = '# Subtest: T16 A HUNG REQUIRED FILE is both RED and INCOMPLETE (reviewer ruling 14:08:08Z): the runner\'s `\\# ⛔ HUNG:` line makes it a failing file';

test('#1778 (T1) the runner\'s HUNG kill lines are read by file, deduplicated and sorted; a test NAME quoting the marker is not a kill', () => {
  const out = [KILL('b-slow.test.mjs'), 'ok 1 - something', KILL('a-hang.test.mjs'), KILL('b-slow.test.mjs'), T16_NAME].join('\n');
  assert.deepEqual(hungFilesIn(out), ['a-hang.test.mjs', 'b-slow.test.mjs']);
  assert.deepEqual(hungFilesIn(T16_NAME), [], 'the runner\'s own row that QUOTES the marker is not a kill');
  assert.deepEqual(hungFilesIn(''), [], 'no output, no kills');
});

test('#1778 (T2) a timeout WITH runner kills names them as hung, and claims no growth', () => {
  const s = timeoutReading({ hungFiles: ['a-hang.test.mjs'], completedCount: 600, incompleteFiles: ['a-hang.test.mjs', 'c.test.mjs'] });
  assert.match(s, /killed 1 file\(s\) as HUNG/);
  assert.match(s, /a-hang\.test\.mjs/);
  assert.doesNotMatch(s, /OUTGROW|No per-file hang/i, 'a detected hang is never read as growth');
});

test('#1778 (T3) a timeout with NO runner kill says no per-file hang was DETECTED, gives the counts, and never says "This is a HANG"', () => {
  const s = timeoutReading({ hungFiles: [], completedCount: 682, incompleteFiles: ['tmpstore-leak-1672.test.mjs', 'upload-held-save-1648.test.mjs'] });
  assert.match(s, /No per-file hang was detected/);
  assert.match(s, /682 of 684 files completed/);
  assert.match(s, /OUTGROWING its cap/);
  assert.match(s, /could not be judged/, 'it states its own limit: a late-started file was never judged by its per-file bound');
  assert.doesNotMatch(s, /This is a HANG/, 'the 10-26 misreading');
});
