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

/**
 * #2025 — `--explain`: say WHY a sha is red, from its failed logs and its diff (tools/ci-diagnose.mjs).
 * The exit code is still the gate's, from the runs alone: explaining never turns a red into anything else.
 * Read-only: gh run list / run view / api GET, and git diff / grep. It never pushes, reruns or deploys.
 * The diff base is `base` if given, else the base of the PR that carries the sha; with neither, nothing is
 * attributed to the diff, and the explanation says so.
 */
export async function explain(sha, { gh = process.env.CI_VERDICT_GH || 'gh', git = process.env.CI_VERDICT_GIT || 'git', cwd = REPO_ROOT, base = null } = {}) {
  const { diagnose, formatDiagnosis, tokens } = await import('./ci-diagnose.mjs');
  const run = (bin, args) => spawnSync(bin, args, { encoding: 'utf8', cwd, maxBuffer: 256 * 1024 * 1024 });
  const notes = [];
  if (!/^[0-9a-f]{40}$/.test(sha)) return { code: EXIT.UNKNOWN, text: `not a full 40-char sha: ${JSON.stringify(sha)}` };
  const r = run(gh, ['run', 'list', '--commit', sha, '--limit', '10', '--json', 'databaseId,status,conclusion,workflowName,url,attempt,event']);
  if (r.error || r.status !== 0) return { code: EXIT.UNKNOWN, text: `could not ask ${gh}: ${r.error?.message || (r.stderr || '').trim().split('\n')[0]}` };
  let runs;
  try { runs = JSON.parse(r.stdout); } catch (e) { return { code: EXIT.UNKNOWN, text: `${gh} output was not JSON: ${e.message}` }; }
  const gate = verdict(runs);
  const failedLogs = [];
  let diffFiles = [];
  let newTokens = [];
  // #2025 — `run list` shows only each run's LATEST attempt. A rerun that passed hides the red attempt before it, and
  // that red-then-green is the commonest flake signal there is. So the earlier attempts are asked for by number.
  const history = [];
  if (gate.code === EXIT.RED || gate.code === EXIT.GREEN) {
    for (const x of runs) {
      for (let n = 1; n < (x.attempt ?? 1); n++) {
        const v = run(gh, ['run', 'view', String(x.databaseId), '--attempt', String(n), '--json', 'status,conclusion,attempt']);
        let at = null;
        try { at = v.status === 0 ? JSON.parse(v.stdout) : null; } catch { at = null; }
        if (!at) { notes.push(`could not read attempt ${n} of run ${x.databaseId}`); continue; }
        history.push({ ...x, attempt: n, status: at.status, conclusion: at.conclusion });
        if (at.status === 'completed' && at.conclusion === 'failure') {
          const l = run(gh, ['run', 'view', String(x.databaseId), '--attempt', String(n), '--log-failed']);
          if (l.status === 0) failedLogs.push({ runId: x.databaseId, attempt: n, text: l.stdout });
          else notes.push(`could not read the failed log of run ${x.databaseId} attempt ${n}`);
        }
      }
    }
  }
  if (gate.code === EXIT.RED || failedLogs.length) {
    if (gate.code === EXIT.RED) for (const x of gate.runs) {
      const l = run(gh, ['run', 'view', String(x.databaseId), '--log-failed']);
      if (l.status === 0) failedLogs.push({ runId: x.databaseId, attempt: x.attempt ?? null, text: l.stdout });
      else notes.push(`could not read the failed log of run ${x.databaseId}`);
    }
    if (!base) {
      const p = run(gh, ['api', `repos/{owner}/{repo}/commits/${sha}/pulls`, '--jq', '.[0].base.sha // empty']);
      base = p.status === 0 && /^[0-9a-f]{40}$/.test(p.stdout.trim()) ? p.stdout.trim() : null;
    }
    if (base) {
      const names = run(git, ['diff', '--name-only', base, sha]);
      const diff = run(git, ['diff', '-U0', base, sha]);
      const tree = run(git, ['grep', '-h', '-I', '-e', '', base]);
      if (names.status === 0 && diff.status === 0 && tree.status <= 1) {
        diffFiles = names.stdout.split('\n').filter(Boolean);
        const added = diff.stdout.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1)).join('\n');
        const had = tokens(tree.stdout);
        newTokens = [...tokens(added)].filter((t) => !had.has(t));
      } else notes.push(`git could not diff ${base.slice(0, 7)}..${sha.slice(0, 7)} here (fetch both?), so nothing is attributed to the diff`);
    } else notes.push('no PR carries this sha and no --base was given, so nothing is attributed to the diff');
  }
  const d = diagnose({ sha, base, runs: [...runs, ...history], failedLogs, diffFiles, newTokens });
  return { code: gate.code, diagnosis: d, text: [formatDiagnosis(d), ...notes.map((n) => `(${n})`)].join('\n') };
}

function main(argv) {
  const sha = argv[2];
  if (!sha) { process.stderr.write('usage: ci-verdict.mjs <full-sha> [--explain [--base <sha>]]\n'); return EXIT.UNKNOWN; }
  if (argv.includes('--explain')) {
    const i = argv.indexOf('--base');
    return explain(sha, { base: i > 0 ? argv[i + 1] : null }).then((x) => { process.stdout.write(x.text + '\n'); return x.code; });
  }
  const v = askGh(sha);
  const lines = [`   ci ${NAME[v.code]} — ${v.why}`];
  for (const run of v.runs || []) lines.push(`      ${run.workflowName || 'run'} ${run.status}/${run.conclusion || '—'} ${run.url || ''}`);
  process.stdout.write(lines.join('\n') + '\n');
  return v.code;
}

import { realpathSync } from 'node:fs';
const isMain = (() => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) Promise.resolve(main(process.argv)).then((code) => process.exit(code));
