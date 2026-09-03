#!/usr/bin/env node
/**
 * tools/ci-verdict.mjs — #837 2b: "is this sha GREEN in CI?", fail-closed.
 *
 * The hole, measured twice on 2026-08-30: CI ran RED on cd919c4 at 04:22Z and
 * deploy.sh served it at 04:31Z; CI ran RED on 7a9a12e at 12:04Z and deploy.sh
 * served it at 12:07Z — the second time by the seat building the fix. CI
 * REPORTS; nothing ASKED. This is the asking.
 *
 * ⛔ FAIL-CLOSED, and every non-green outcome is a DIFFERENT exit code with a
 * different remedy, because "cannot tell" and "red" and "not finished" are
 * opposite facts and a gate that renders them alike trains the bypass:
 *
 *     0  GREEN     every completed run for the sha concluded success
 *     1  RED       a completed run concluded failure/cancelled/timed_out
 *     2  UNKNOWN   `gh` missing, not authenticated, or the API errored —
 *                  the gate could not ask. Not "no news is good news".
 *     3  NO RUN    CI has no run for this sha (not pushed? workflow off?)
 *     4  PENDING   a run exists and has not completed — wait, don't guess
 *     5  CANCELLED the verdict was DESTROYED, not earned: ci.yml's
 *                  cancel-in-progress is keyed on the REF, so any push to
 *                  main cancels a re-run of any OLDER sha, and a re-run
 *                  OVERWRITES that sha's conclusion (#1108). The code did not
 *                  change; the record did. Remedy: re-run, then deploy.
 *                  (The original attempt survives: gh run view --attempt 1.)
 *
 * There is deliberately NO override flag. The 2026-08-30 history (#1085) is
 * what an override does within twelve hours of existing. If CI is down, the
 * remedy is to wait for CI, or to fix CI — printed, not hidden.
 *
 * Pure half exported for tests: `verdict(runs)` over the JSON `gh run list`
 * returns. The shell half is `gh run list --commit <sha> --json …`; the binary
 * is overridable (CI_VERDICT_GH) so a test can stand in a fake.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXIT = { GREEN: 0, RED: 1, UNKNOWN: 2, NO_RUN: 3, PENDING: 4, CANCELLED: 5 };

/** Decide from the runs `gh run list --commit <sha>` returned. */
export function verdict(runs) {
  if (!Array.isArray(runs)) return { code: EXIT.UNKNOWN, why: 'gh returned something that is not a run list' };
  if (runs.length === 0) return { code: EXIT.NO_RUN, why: 'CI has no run for this sha — was it pushed? is the workflow enabled?' };
  const pending = runs.filter((r) => r.status !== 'completed');
  if (pending.length) {
    return { code: EXIT.PENDING, why: `${pending.length} run(s) not finished (${pending.map((r) => r.status).join(', ')}) — wait for the verdict`, runs: pending };
  }
  const red = runs.filter((r) => r.conclusion !== 'success' && r.conclusion !== 'cancelled');
  if (red.length) {
    return { code: EXIT.RED, why: `${red.length} run(s) concluded ${[...new Set(red.map((r) => r.conclusion))].join('/')}`, runs: red };
  }
  const cancelled = runs.filter((r) => r.conclusion === 'cancelled');
  if (cancelled.length) {
    return { code: EXIT.CANCELLED, why: `${cancelled.length} run(s) CANCELLED — the verdict was destroyed, not earned (a later push to the same ref cancels re-runs of older shas, #1108). Re-run it: gh run rerun ${cancelled[0].databaseId ?? '<id>'}`, runs: cancelled };
  }
  return { code: EXIT.GREEN, why: `${runs.length} run(s), all success`, runs };
}

// #1141 — gh resolves the REPOSITORY from its working directory, and deploy.sh
// invoked this tool from wherever the operator stood. From any other checkout
// gh answered "no git remotes found" and the deploy refused: a correct refusal
// to the wrong question. So the question is asked from the repository this
// tool lives in — tools/.. — never from the caller's cwd.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Ask gh, from the repository root. Any failure to ask is UNKNOWN, never a pass. */
export function askGh(sha, { gh = process.env.CI_VERDICT_GH || 'gh', cwd = REPO_ROOT } = {}) {
  if (!/^[0-9a-f]{40}$/.test(sha)) return { code: EXIT.UNKNOWN, why: `not a full 40-char sha: ${JSON.stringify(sha)} — gh matches on the full sha only` };
  const r = spawnSync(gh, ['run', 'list', '--commit', sha, '--limit', '10', '--json', 'databaseId,status,conclusion,workflowName,url'], { encoding: 'utf8', cwd });
  if (r.error) return { code: EXIT.UNKNOWN, why: `could not run ${gh}: ${r.error.message}` };
  if (r.status !== 0) return { code: EXIT.UNKNOWN, why: `${gh} exited ${r.status}: ${(r.stderr || '').trim().split('\n')[0] || '(no stderr)'}` };
  let runs;
  try { runs = JSON.parse(r.stdout); } catch (e) { return { code: EXIT.UNKNOWN, why: `${gh} output was not JSON: ${e.message}` }; }
  return verdict(runs);
}

const NAME = { 0: 'GREEN', 1: 'RED', 2: 'UNKNOWN', 3: 'NO RUN', 4: 'PENDING', 5: 'CANCELLED' };

function main(argv) {
  const sha = argv[2];
  if (!sha) { process.stderr.write('usage: ci-verdict.mjs <full-sha>\n'); return EXIT.UNKNOWN; }
  const v = askGh(sha);
  const lines = [`   ci ${NAME[v.code]} — ${v.why}`];
  for (const run of v.runs || []) lines.push(`      ${run.workflowName || 'run'} ${run.status}/${run.conclusion || '—'} ${run.url || ''}`);
  process.stdout.write(lines.join('\n') + '\n');
  return v.code;
}

import { realpathSync } from 'node:fs';
const isMain = (() => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) process.exit(main(process.argv));
