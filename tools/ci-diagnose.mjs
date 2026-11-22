/**
 * tools/ci-diagnose.mjs — #2025: WHY is this sha red? The half of `ci-verdict.mjs` that reads the failed log.
 *
 * ci-verdict.mjs answers "is this sha green?" and gates deploys on its exit code. This module never changes that
 * answer. It reads what a red run shows and says what each failure is, keeping OBSERVATIONS (the named rows, their
 * files, whether the diff touched each file, new temp leaks, files that exited, other runs on the same sha) apart
 * from the CAUSE, which it labels only where the evidence supports one:
 *
 *   in-diff         the failing test file is one the diff changed.
 *   caused-by-diff  the file is NOT in the diff, but the failure message names something the diff introduced: an
 *                   identifier no file had before the diff, or a file the diff changed. On 2026-11-21 four registry
 *                   guards failed this way in files the change never touched. File overlap alone calls them flakes.
 *   temp-leak       the runner's `# tmp: ⛔ … NEW leak` line: a test file left temp entries that are not on the
 *                   baseline. It fails the run with `# fail 0`.
 *   probable-flake  not in the diff, names nothing the diff introduced, and the SAME sha passed in another run.
 *   unknown         none of the above holds. UNKNOWN is a verdict, never a gap to fill: it carries the excerpt.
 *
 * ⛔ It never reports GREEN for a run that failed. GREEN comes only from the runs (ci-verdict's verdict()), and a
 * failed run whose log names nothing is UNKNOWN.
 *
 * Pure: the caller gathers the inputs (gh and git live in ci-verdict.mjs), so every rule here is testable from a
 * saved log. Fixtures: tests/fixtures/ci-verdict-2025/.
 */
import { verdict as runsVerdict, EXIT } from './ci-verdict.mjs';

export const PARSER_VERSION = 'ci-diagnose/1';

const TS = /^﻿?\d{4}-\d\d-\d\dT[\d:.]+Z ?/;
const TOKEN = /[A-Za-z_][A-Za-z0-9_]*(?:[-.][A-Za-z0-9_]+)*/g;
const EXCERPT_LINES = 12;

/** Identifiers of 4+ characters in a text: the unit "the diff introduced X" is measured in. */
export function tokens(text) {
  return new Set((String(text).match(TOKEN) || []).filter((t) => t.length >= 4));
}

/** gh prints `job<TAB>step<TAB>timestamp message`; a saved log may be bare. Returns the message. */
function messageOf(line) {
  const parts = line.split('\t');
  const msg = parts.length >= 3 ? parts.slice(2).join('\t') : line;
  return msg.replace(TS, '').replace(/^﻿/, '');
}

/** A runner path (`/home/runner/work/<repo>/<repo>/tests/x.mjs`) as a repo path, matched against the files that exited. */
function repoPath(abs, known) {
  const hit = known.find((k) => abs === k || abs.endsWith(`/${k}`));
  if (hit) return hit;
  const m = abs.match(/\/work\/[^/]+\/[^/]+\/(.+)$/);
  return m ? m[1] : abs;
}

/** Read the failed-step log of ONE run. Nothing here decides a cause. */
export function parseFailedLog(text) {
  const lines = String(text || '').split('\n').map(messageOf);
  const tap = {};
  const fileExited = [];
  const newLeaks = [];
  const runnerErrors = [];
  const blocks = [];
  let cur = null;
  for (const msg of lines) {
    if (cur) {
      if (msg === '  ...') { blocks.push(cur); cur = null; } else cur.body.push(msg);
      continue;
    }
    let m;
    if ((m = msg.match(/^not ok \d+ - (.*)$/))) {
      if (/#\s*(TODO|SKIP)\b/i.test(m[1])) continue;
      cur = { name: m[1].replace(/\\#/g, '#'), body: [] };
    } else if ((m = msg.match(/^# (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)$/))) {
      tap[m[1]] = Number(m[2]);
    } else if ((m = msg.match(/^# ⛔ FILE EXITED with code (\d+): (\S+)/))) {
      if (!fileExited.some((f) => f.file === m[2])) fileExited.push({ file: m[2], code: Number(m[1]) });
    } else if ((m = msg.match(/^# tmp: ⛔ (\S+) left (\d+) entries, (\d+) bytes: a NEW leak/))) {
      newLeaks.push({ file: m[1], entries: Number(m[2]), bytes: Number(m[3]) });
    } else if (/^⛔ /.test(msg) && !/^⛔ test failed:/.test(msg)) {
      runnerErrors.push(msg);
    }
  }
  if (cur) blocks.push(cur);
  const known = fileExited.map((f) => f.file);
  const failures = blocks.map((b) => {
    const loc = b.body.map((l) => l.match(/^ {2}location: '(.+?):\d+:\d+'$/)).find(Boolean);
    const i = b.body.findIndex((l) => /^ {2}error:/.test(l));
    let excerpt = '';
    if (i >= 0) {
      const first = b.body[i].replace(/^ {2}error: ?/, '');
      const rest = [];
      if (/^\|-?$/.test(first)) {
        for (let k = i + 1; k < b.body.length && /^ {4}/.test(b.body[k]); k += 1) rest.push(b.body[k].slice(4));
      } else rest.push(first.replace(/^'(.*)'$/, '$1'));
      excerpt = rest.join('\n').trim();
    }
    return { name: b.name, file: loc ? repoPath(loc[1], known) : null, excerpt };
  });
  return { tap: Object.keys(tap).length ? tap : null, failures, fileExited, newLeaks, runnerErrors };
}

const clip = (s) => String(s || '').split('\n').slice(0, EXCERPT_LINES).join('\n');

/**
 * input: { sha, base?, runs, failedLogs: [{ runId, attempt, text }], diffFiles: [path], newTokens: [identifier] }
 * `runs` are every run CI reported for the sha (ci-verdict's shape); `newTokens` are identifiers the diff's added
 * lines contain that the base tree never had. Without a diff (no base known) pass empty lists: nothing can then be
 * attributed to the diff, so failures come out UNKNOWN or, with a same-sha pass, probable flakes.
 */
export function diagnose(input) {
  const { sha, base = null, runs = [], failedLogs = [], diffFiles = [], newTokens = [] } = input || {};
  // #2025 — `runs` may hold several ATTEMPTS of one run (same databaseId). The verdict is the gate's, from each run's
  // LATEST attempt only; the earlier attempts are history, read for evidence and never for the verdict.
  const latestOf = new Map();
  for (const r of Array.isArray(runs) ? runs : []) {
    const k = r.databaseId; const cur = latestOf.get(k);
    if (!cur || (r.attempt ?? 1) > (cur.attempt ?? 1)) latestOf.set(k, r);
  }
  const rv = runsVerdict(Array.isArray(runs) ? [...latestOf.values()] : runs);
  const provenance = { sha, base, parser: PARSER_VERSION, runs: failedLogs.map((l) => ({ runId: l.runId, attempt: l.attempt })) };
  const named = { [EXIT.GREEN]: 'GREEN', [EXIT.PENDING]: 'PENDING', [EXIT.NO_RUN]: 'NO RUN', [EXIT.CANCELLED]: 'CANCELLED', [EXIT.UNKNOWN]: 'UNKNOWN' };
  // GREEN after a rerun still reports what the red attempt showed: forgetting it is how a flake stays invisible.
  const greenWithHistory = rv.code === EXIT.GREEN && failedLogs.length > 0;
  if (rv.code !== EXIT.RED && !greenWithHistory) return { verdict: named[rv.code], why: rv.why, findings: [], observations: { runs: rv.why }, provenance, advice: '' };

  const inDiff = (f) => !!f && diffFiles.includes(f);
  const fresh = new Set(newTokens);
  const evidenceFor = (text) => {
    // A short plain word ("code", "table") is prose that any diff may happen to add; it is not evidence. A token
    // counts when it has an identifier's shape (a capital, digit, _ . or -) or is 8+ characters long.
    const hit = [...tokens(text)].filter((t) => fresh.has(t) && (/[A-Z0-9_.-]/.test(t) || t.length >= 8));
    for (const f of diffFiles) if (text.includes(f) && !hit.includes(f)) hit.push(f);
    return hit.sort().slice(0, 6);
  };
  const findings = [];
  const observations = { tap: null, fileExited: [], newLeaks: [], runnerErrors: [] };
  for (const log of failedLogs) {
    const p = parseFailedLog(log.text);
    observations.tap = p.tap || observations.tap;
    observations.fileExited.push(...p.fileExited);
    observations.newLeaks.push(...p.newLeaks);
    observations.runnerErrors.push(...p.runnerErrors);
    // A pass of the same sha in ANOTHER run, or in another ATTEMPT of this run (a rerun), is the flake evidence.
    const passedElsewhere = runs.filter((r) => r.status === 'completed' && r.conclusion === 'success'
      && !(r.databaseId === log.runId && (r.attempt ?? 1) === (log.attempt ?? 1)))
      .map((r) => (r.databaseId === log.runId ? `${r.databaseId} attempt ${r.attempt}` : r.databaseId));
    for (const f of p.failures) {
      const evidence = evidenceFor(`${f.name}\n${f.excerpt}`);
      const cls = inDiff(f.file) ? 'in-diff' : evidence.length ? 'caused-by-diff' : passedElsewhere.length ? 'probable-flake' : 'unknown';
      findings.push({ class: cls, test: f.name, file: f.file, inDiff: inDiff(f.file), evidence, passedElsewhere: cls === 'probable-flake' ? passedElsewhere : [], excerpt: clip(f.excerpt), runId: log.runId });
    }
    for (const l of p.newLeaks) findings.push({ class: 'temp-leak', test: null, file: l.file, inDiff: inDiff(l.file), entries: l.entries, bytes: l.bytes, evidence: [], passedElsewhere: [], excerpt: '', runId: log.runId });
    const explained = new Set(findings.map((x) => x.file));
    for (const e of p.fileExited) {
      if (!explained.has(e.file)) findings.push({ class: 'unknown', test: null, file: e.file, inDiff: inDiff(e.file), evidence: [], passedElsewhere: [], excerpt: `the file exited with code ${e.code} and no failing row names it`, runId: log.runId });
    }
    if (!p.failures.length && !p.newLeaks.length && !p.fileExited.length) {
      findings.push({ class: 'unknown', test: null, file: null, inDiff: false, evidence: [], passedElsewhere: [], excerpt: clip(p.runnerErrors.join('\n') || 'the run failed, and its log names no failing row, leak or exited file'), runId: log.runId });
    }
  }
  if (!failedLogs.length) findings.push({ class: 'unknown', test: null, file: null, inDiff: false, evidence: [], passedElsewhere: [], excerpt: 'the run failed, and no log was read', runId: null });

  const classes = new Set(findings.map((f) => f.class));
  if (greenWithHistory) {
    const flaky = [...classes].every((c) => c === 'probable-flake');
    return { verdict: 'GREEN', why: rv.why, history: true, findings, observations, provenance,
      advice: flaky ? 'Safe to land. An earlier attempt failed out of the diff and a rerun passed: a probable flake. If the same row fails again on another run, file a card for it.'
        : 'Safe to land by the gate, but an earlier attempt failed in a way a rerun does not explain: read it before you trust the green.' };
  }
  const verdict = classes.has('unknown') ? 'UNKNOWN' : 'RED';
  const advice = classes.has('unknown') ? 'A seat should read the excerpt below: the cause is not established.'
    : [...classes].every((c) => c === 'probable-flake') ? 'Rerun once (#1719). If it fails again on the same row, it is a real flake: file a card for it.'
      : 'Fix it on the branch: the change caused this.';
  return { verdict, why: rv.why, findings, observations, provenance, advice };
}

const PHRASE = { 'in-diff': 'in a file the diff changed', 'caused-by-diff': 'caused by the diff', 'temp-leak': 'temp leak', 'probable-flake': 'probable flake', unknown: 'UNKNOWN' };

/** The commons post. Plain words first, then one line per finding, excerpts only where a seat must read them. */
export function formatDiagnosis(d) {
  const p = d.provenance || {};
  const runs = (p.runs || []).map((r) => `run ${r.runId}, attempt ${r.attempt}`).join('; ') || 'no failed log read';
  let out;
  if (d.history) {
    // #2025 — green on the latest attempt, red on an earlier one: say both, the green first
    const reds = (p.runs || []).map((r) => `Attempt ${r.attempt} of run ${r.runId}`).join('; ');
    out = [`CI verdict for ${String(p.sha || '').slice(0, 7)} (parser ${p.parser}): **GREEN**. ${d.why}.`, `${reds} was red:`];
  } else {
    const head = `CI verdict for ${String(p.sha || '').slice(0, 7)} (${runs}; parser ${p.parser}): **${d.verdict === 'UNKNOWN' ? 'RED, cause UNKNOWN' : d.verdict}**`;
    if (d.verdict !== 'RED' && d.verdict !== 'UNKNOWN') return `${head}. ${d.why}`;
    out = [head];
  }
  if (d.observations?.tap) out.push(`TAP: fail ${d.observations.tap.fail ?? '?'}, pass ${d.observations.tap.pass ?? '?'}.`);
  for (const f of d.findings) {
    const where = f.file ? `\`${f.file}\` (${f.inDiff ? 'in the diff' : 'not in the diff'})` : 'no file named';
    let line = `- ${f.test ? `\`${f.test}\` in ` : ''}${where}: **${PHRASE[f.class]}**`;
    if (f.class === 'temp-leak') line += `, ${f.entries} entries left behind`;
    if (f.evidence.length) line += `. It names ${f.evidence.map((e) => `\`${e}\``).join(', ')}, which this diff introduced or changed`;
    if (f.passedElsewhere.length) line += `. The same sha passed in run ${f.passedElsewhere.join(', ')}`;
    out.push(line + '.');
    if (f.class === 'unknown' && f.excerpt) out.push('```', f.excerpt, '```');
  }
  out.push(d.advice);
  return out.join('\n');
}
