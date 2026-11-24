/**
 * #2025 — the CI verdict reader says WHY a run is red, from what the run shows, and never guesses green.
 *
 * Fixtures are three real red runs from 2026-11-21 (tests/fixtures/ci-verdict-2025/README.md). Each must reproduce
 * the hand verdict a seat reached by reading a 43k-line log:
 *
 *   D1  CAUSED BY THE DIFF, IN FILES IT NEVER TOUCHED: four guard tests fail outside the diff, and each failure
 *       message names something the diff added. Not a flake — the file-overlap heuristic gets this one wrong.
 *       The same run ALSO carried the reactions-449 temp leak. The hand read missed it, which cost a second red
 *       CI round (9231d64); the tool must name it here.
 *   D2  TEMP LEAK: `# fail 0`, the run still fails, and the reason is a NEW leak in a file the diff added.
 *   D3  PROBABLE FLAKE: one failure outside the diff, naming nothing the diff added, and the SAME sha passed in
 *       another run. Recommend one rerun.
 *   D4  UNKNOWN IS A VERDICT: the same failure with no same-sha pass is UNKNOWN, with the excerpt, not a flake.
 *   D5  NEVER A FALSE GREEN: a failed run whose log names nothing is UNKNOWN, never GREEN.
 *   D6  OUT OF DIFF IS NOT A FLAKE: D1's failures without the diff's new tokens are UNKNOWN, not flakes.
 *   D7  PROVENANCE: every verdict carries the sha, run id, attempt and parser version.
 *   D8  THE POST: names each failing row, its file, whether the diff touched it, the class and the evidence,
 *       and keeps excerpts short.
 *   D9  GREEN comes only from the runs, all completed and successful.
 *   D10 A RERUN IS EVIDENCE: attempt 1 red, attempt 2 of the SAME run green. The verdict follows the latest attempt
 *       (GREEN, the gate's code is unchanged), and the red attempt is still reported, its out-of-diff failure a probable
 *       flake citing the passing attempt. Before #2025's fix this rerun pass was invisible: same run id, so never
 *       "elsewhere", and the red was simply forgotten.
 *   D11 A RED RERUN IS NOT EVIDENCE: attempt 2 failing again keeps the failure UNKNOWN; an earlier failed attempt is
 *       never counted as a pass.
 *   D12 A ROWS MODULE EXPLAINS THE FILE THAT RUNS IT (#1760 split files): the failing row's location is
 *       `x.rows.mjs`, the FILE EXITED line names `x-part2.test.mjs`, which imports it. That exit is explained, not
 *       UNKNOWN. Real case: run 45050133125 attempt 2, #1744 E7, where the false UNKNOWN sent a seat into the log.
 *       Control: without the import known, the exit stays UNKNOWN. Nothing is explained by a name's resemblance.
 *   D13 AMBIGUOUS IMPORTERS EXPLAIN NOTHING: two files that exited both import the module, and one row failed. The row
 *       cannot say which file it ran in, so neither exit is explained by it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFailedLog, diagnose, formatDiagnosis, PARSER_VERSION } from '../tools/ci-diagnose.mjs';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ci-verdict-2025');
function load(name) {
  const meta = JSON.parse(fs.readFileSync(path.join(FIX, name, 'meta.json'), 'utf8'));
  const text = fs.readFileSync(path.join(FIX, name, 'failed.log'), 'utf8');
  const run = { databaseId: meta.runId, attempt: meta.attempt, event: meta.event, status: 'completed', conclusion: meta.conclusion };
  return { meta, input: { sha: meta.sha, base: meta.base, runs: [run, ...meta.otherRunsSameSha], failedLogs: [{ runId: meta.runId, attempt: meta.attempt, text }], diffFiles: meta.diffFiles, newTokens: meta.newTokens } };
}
const byClass = (d) => d.findings.map((f) => [f.file, f.class]);

test('D1 CAUSED BY THE DIFF, IN FILES IT NEVER TOUCHED: four guard failures, none a flake', () => {
  const { input } = load('05ed720-pr');
  const d = diagnose(input);
  assert.equal(d.verdict, 'RED');
  assert.deepEqual(byClass(d), [
    ['tests/refusal-record-1762.test.mjs', 'caused-by-diff'],
    ['tests/refusal-record-1762.test.mjs', 'caused-by-diff'],
    ['tests/suite-watch-three-state-1637.test.mjs', 'caused-by-diff'],
    ['tests/write-tool-reach.test.mjs', 'caused-by-diff'],
    ['tests/reactions-449.test.mjs', 'temp-leak'],
  ]);
  assert.ok(d.findings.slice(0, 4).every((f) => f.inDiff === false), 'none of the four failing test files is in the diff');
  assert.equal(d.findings[4].inDiff, true, 'the leaking file is one the diff added');
  assert.ok(d.findings[0].evidence.includes('INVALID_EMOJI'), `G1 names a code the diff added: ${d.findings[0].evidence}`);
  assert.ok(d.findings.slice(0, 4).every((f) => f.evidence.length > 0), 'each failure names what the diff added');
  assert.equal(d.observations.tap.fail, 4);
});

test('D2 TEMP LEAK: fail 0, a new leak in a file the diff added', () => {
  const { input } = load('9231d64-pr');
  const d = diagnose(input);
  assert.equal(d.verdict, 'RED');
  assert.equal(d.observations.tap.fail, 0);
  assert.deepEqual(byClass(d), [['tests/reactions-449.test.mjs', 'temp-leak']]);
  assert.equal(d.findings[0].inDiff, true);
  assert.equal(d.findings[0].entries, 11);
});

test('D3 PROBABLE FLAKE: out of the diff, names nothing it added, and the same sha passed elsewhere', () => {
  const { input } = load('29871cc-main-a1');
  const d = diagnose(input);
  assert.equal(d.verdict, 'RED');
  assert.deepEqual(byClass(d), [['tests/whisper-enable-flag.test.mjs', 'probable-flake']]);
  assert.equal(d.findings[0].inDiff, false);
  assert.deepEqual(d.findings[0].evidence, []);
  assert.deepEqual(d.findings[0].passedElsewhere, [44945625627]);
  assert.match(d.advice, /rerun once/i);
});

test('D4 UNKNOWN IS A VERDICT: the same failure with no same-sha pass is UNKNOWN, with its excerpt', () => {
  const { input } = load('29871cc-main-a1');
  const d = diagnose({ ...input, runs: input.runs.slice(0, 1) });
  assert.deepEqual(byClass(d), [['tests/whisper-enable-flag.test.mjs', 'unknown']]);
  assert.match(d.findings[0].excerpt, /fetch failed/);
});

test('D5 NEVER A FALSE GREEN: a failed run whose log names nothing is UNKNOWN', () => {
  for (const text of ['', 'server suite\tRun the server suite\t2026-11-21T00:00:00.0Z ##[error]Process completed with exit code 1.\n']) {
    const d = diagnose({ sha: 'a'.repeat(40), runs: [{ databaseId: 1, attempt: 1, status: 'completed', conclusion: 'failure' }], failedLogs: [{ runId: 1, attempt: 1, text }], diffFiles: [], newTokens: [] });
    assert.notEqual(d.verdict, 'GREEN');
    assert.equal(d.verdict, 'UNKNOWN');
    assert.deepEqual(byClass(d), [[null, 'unknown']]);
  }
});

test('D6 OUT OF DIFF IS NOT A FLAKE: with no diff known and no same-sha pass, every failure is UNKNOWN', () => {
  const { input } = load('05ed720-pr');
  const d = diagnose({ ...input, newTokens: [], diffFiles: [] });
  const failures = d.findings.filter((f) => f.class !== 'temp-leak');
  assert.ok(failures.length === 4 && failures.every((f) => f.class === 'unknown'), JSON.stringify(byClass(d)));
  assert.equal(d.verdict, 'UNKNOWN');
});

test('D7 PROVENANCE: sha, run id, attempt and parser version on every verdict', () => {
  const { input, meta } = load('9231d64-pr');
  const d = diagnose(input);
  assert.equal(d.provenance.sha, meta.sha);
  assert.deepEqual(d.provenance.runs, [{ runId: meta.runId, attempt: 1 }]);
  assert.equal(d.provenance.parser, PARSER_VERSION);
  assert.match(formatDiagnosis(d), new RegExp(`${meta.sha.slice(0, 7)}.*${meta.runId}.*attempt 1.*${PARSER_VERSION}`, 's'));
});

test('D8 THE POST: rows, files, in-diff, class and evidence, with short excerpts', () => {
  const t = formatDiagnosis(diagnose(load('05ed720-pr').input));
  for (const s of ['#1762 G1', 'T14', '#1163', 'tests/write-tool-reach.test.mjs', 'not in the diff', 'caused by the diff', 'INVALID_EMOJI']) assert.ok(t.includes(s), `post says ${s}`);
  const flake = formatDiagnosis(diagnose(load('29871cc-main-a1').input));
  assert.match(flake, /probable flake/);
  assert.match(flake, /44945625627/);
  const unknown = formatDiagnosis(diagnose({ ...load('29871cc-main-a1').input, runs: load('29871cc-main-a1').input.runs.slice(0, 1) }));
  assert.match(unknown, /UNKNOWN/);
  assert.match(unknown, /fetch failed/);
  for (const block of unknown.split('```').filter((_, i) => i % 2 === 1)) assert.ok(block.trim().split('\n').length <= 12, 'an excerpt is at most 12 lines');
});

test('D9 GREEN comes only from the runs: all completed and successful', () => {
  const ok = diagnose({ sha: 'b'.repeat(40), runs: [{ databaseId: 2, attempt: 1, status: 'completed', conclusion: 'success' }, { databaseId: 3, attempt: 2, status: 'completed', conclusion: 'success' }], failedLogs: [], diffFiles: [], newTokens: [] });
  assert.equal(ok.verdict, 'GREEN');
  assert.deepEqual(ok.findings, []);
  const pending = diagnose({ sha: 'b'.repeat(40), runs: [{ databaseId: 2, attempt: 1, status: 'in_progress', conclusion: null }], failedLogs: [], diffFiles: [], newTokens: [] });
  assert.equal(pending.verdict, 'PENDING');
});

test('parseFailedLog reads gh\'s job<TAB>step<TAB>timestamp shape, BOM included, and skips TODO rows', () => {
  const p = parseFailedLog('﻿job\tstep\t2026-11-21T00:00:00.0Z not ok 1 - x # TODO later\njob\tstep\t2026-11-21T00:00:00.0Z # fail 0\n');
  assert.deepEqual(p.failures, []);
  assert.equal(p.tap.fail, 0);
});

test('D10 A RERUN IS EVIDENCE: attempt 1 red, attempt 2 of the same run green — GREEN, and the red attempt is a probable flake citing attempt 2', () => {
  const { meta, input } = load('29871cc-main-a1');
  const a1 = { databaseId: meta.runId, attempt: 1, event: meta.event, status: 'completed', conclusion: 'failure' };
  const a2 = { ...a1, attempt: 2, conclusion: 'success' };
  const d = diagnose({ ...input, runs: [a2, a1] });
  assert.equal(d.verdict, 'GREEN', 'the verdict follows the latest attempt');
  assert.deepEqual(byClass(d), [['tests/whisper-enable-flag.test.mjs', 'probable-flake']], 'the red attempt is still reported');
  assert.deepEqual(d.findings[0].passedElsewhere, [`${meta.runId} attempt 2`]);
  const text = formatDiagnosis(d);
  assert.match(text, /\*\*GREEN\*\*/);
  assert.match(text, /attempt 1 .*red/i, 'the post says an earlier attempt was red');
  assert.match(text, /probable flake/i);
});

test('D11 A RED RERUN IS NOT EVIDENCE: attempt 2 fails again — RED, and the failure stays UNKNOWN', () => {
  const { meta, input } = load('29871cc-main-a1');
  const a1 = { databaseId: meta.runId, attempt: 1, event: meta.event, status: 'completed', conclusion: 'failure' };
  const a2 = { ...a1, attempt: 2 };
  const d = diagnose({ ...input, runs: [a2, a1], failedLogs: [{ ...input.failedLogs[0], attempt: 2 }] });
  assert.equal(d.verdict, 'UNKNOWN', 'red, cause unknown');
  assert.deepEqual(byClass(d), [['tests/whisper-enable-flag.test.mjs', 'unknown']]);
  assert.deepEqual(d.findings[0].passedElsewhere, []);
});

const SPLIT_LOG = (exited) => [
  'not ok 4992 - #1744 (E7) a sibling whose version was NOT bumped is REFUSED',
  '  ---',
  "  location: '/build/work/r/r/tests/x.rows.mjs:56:75'",
  "  error: 'a sibling whose version was NOT bumped: no effect'",
  '  ...',
  '# fail 1',
  ...exited.map((f) => `# ⛔ FILE EXITED with code 1: ${f}`),
].join('\n');
const SPLIT_RUNS = [
  { databaseId: 7, attempt: 2, status: 'completed', conclusion: 'failure' },
  { databaseId: 8, attempt: 1, status: 'completed', conclusion: 'success' },
];

test('D12 A ROWS MODULE EXPLAINS THE FILE THAT RUNS IT: the importer\'s exit is not UNKNOWN; without the import known, it is', () => {
  const input = { sha: 'a'.repeat(40), runs: SPLIT_RUNS, failedLogs: [{ runId: 7, attempt: 2, text: SPLIT_LOG(['tests/x-part2.test.mjs']) }] };
  const d = diagnose({ ...input, importsOf: { 'tests/x-part2.test.mjs': ['tests/x.rows.mjs'] } });
  assert.deepEqual(byClass(d), [['tests/x.rows.mjs', 'probable-flake']]);
  assert.equal(d.verdict, 'RED', 'every finding is a probable flake: red, rerun once');
  const control = diagnose(input);
  assert.deepEqual(byClass(control), [['tests/x.rows.mjs', 'probable-flake'], ['tests/x-part2.test.mjs', 'unknown']], 'no import known, no explanation');
});

test('D13 AMBIGUOUS IMPORTERS EXPLAIN NOTHING: two exited files import the module, one row failed — both stay UNKNOWN', () => {
  const d = diagnose({
    sha: 'a'.repeat(40), runs: SPLIT_RUNS,
    failedLogs: [{ runId: 7, attempt: 2, text: SPLIT_LOG(['tests/x-part1.test.mjs', 'tests/x-part2.test.mjs']) }],
    importsOf: { 'tests/x-part1.test.mjs': ['tests/x.rows.mjs'], 'tests/x-part2.test.mjs': ['tests/x.rows.mjs'] },
  });
  assert.deepEqual(byClass(d).filter(([, c]) => c === 'unknown').map(([f]) => f), ['tests/x-part1.test.mjs', 'tests/x-part2.test.mjs']);
});

test('D14 #2073 AN UNREAD DIFF IS NOT "NOT IN THE DIFF": with the diff unavailable, each file says "diff unavailable"', () => {
  const { input } = load('29871cc-main-a1');
  const d = diagnose({ ...input, diffFiles: [], newTokens: [], diffRead: false });
  assert.equal(d.findings[0].inDiff, null, 'unknown, not false');
  const t = formatDiagnosis(d);
  assert.match(t, /`tests\/whisper-enable-flag\.test\.mjs` \(diff unavailable\)/);
  assert.doesNotMatch(t, /not in the diff/);
  // control: the same input with the diff READ and empty still says "not in the diff"
  const read = formatDiagnosis(diagnose({ ...input, diffFiles: [], newTokens: [] }));
  assert.match(read, /\(not in the diff\)/);
});
