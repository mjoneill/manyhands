/**
 * #1637 — THE SUITE WATCH'S VERDICT, as a pure module: parse the merged TAP once, classify it into independent states, check the required-coverage manifest and the documented exclusions.
 *
 * THE RULE (reviewer rulings, 09:49Z-13:34Z on 2026-10-08): states are independent and never merged.
 *   FAILED      a LEAF `not ok` without `# TODO`. A wrapper row whose only failure is its failing child (`failureType: 'subtestsFailed'`) is not a second failure.
 *   TODO        `# TODO` rows (passing or failing): counted and listed on their own, never failing, never a red.
 *   INCOMPLETE  missing REQUIRED coverage: any `# SKIP UNAVAILABLE:`; any skip not covered by a documented exclusion ("unclassified"); a required file with no completed run; a truncated TAP; a manifest
 *               that cannot be read. INCOMPLETE is never success.
 *   DOCUMENTED  a skip matched by an exclusion entry (exact file + exact test title + reason + scope). A skip reason alone is not a waiver; an entry never waives `UNAVAILABLE:`.
 *
 * WHY ONE PARSE: the earlier watch reverse-engineered "failing files" from a `location:` regex over every yaml block, which also matches `# TODO` rows (the 10-08 outbox-board-key-g6 false alarm), and
 * recounted nothing. The summary lines (`# fail`, `# todo`, `# skipped`) are NOT used for the counts: they are the cross-check the rows compare against.
 *
 * FILE ATTRIBUTION: scripts/run-test-files.mjs emits `# file: <checkout-relative path> complete` immediately before each completed file's rows. A row belongs to the latest such marker. A failing/TODO row's
 * `location:` is used only when no marker precedes it (plain `node --test` output): relative to the checkout when inside it, otherwise the suffix from the last `/tests/`.
 * Rows after the plan line (`1..N`) are the runner's recap of failures and are not outcomes.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROW = /^(\s*)(not )?ok (\d+)(?: - (.*))?$/;
const DIRECTIVE = /^(.*?) # (SKIP|TODO)\b ?(.*)$/;
const unescapeTitle = (t) => t.replace(/\\#/g, '#');

/** relative path for a `location:` value */
function relativeLocation(loc, suiteDir) {
  const file = loc.replace(/:\d+:\d+$/, '');
  if (suiteDir) {
    const rel = path.relative(suiteDir, file);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  }
  const i = file.lastIndexOf('/tests/');
  return i >= 0 ? file.slice(i + 1) : file;
}

/**
 * @returns {{rows: object[], completed: Set<string>, hung: Set<string>, truncated: boolean, summary: object|null}}
 * rows: { file, title, status: 'pass'|'fail'|'todo'|'skip', reason, wrapper }
 */
export function parseTap(text, { suiteDir = null } = {}) {
  const lines = text.split('\n');
  const rows = []; const completed = new Set(); const hung = new Set();
  let marker = null; let planAt = -1;
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    if (/^1\.\.\d+$/.test(L)) { planAt = i; break; }          // everything after the plan is a recap, not an outcome
    let m = /^# file: (.+) complete$/.exec(L);
    if (m) { marker = m[1]; completed.add(marker); continue; }
    m = /^# ⛔ HUNG: (\S+) exceeded/.exec(L);
    if (m) { hung.add(m[1]); continue; }
    m = ROW.exec(L);
    if (!m) continue;
    const indent = m[1]; const failed = !!m[2]; const rest = m[4] ?? '';
    // the yaml block that follows this row
    const meta = {};
    if (lines[i + 1] === `${indent}  ---`) {
      for (let j = i + 2; j < lines.length && lines[j] !== `${indent}  ...`; j++) {
        const kv = /^\s+(\w+): (.*)$/.exec(lines[j]); if (kv && !(kv[1] in meta)) meta[kv[1]] = kv[2].replace(/^'|'$/g, '');
      }
    }
    const d = DIRECTIVE.exec(rest);
    const title = unescapeTitle(d ? d[1] : rest);
    const directive = d ? d[2] : null; const reason = d ? d[3] : '';
    let file = marker;
    if (meta.location && (!marker || failed)) {
      // a failing row's own location is the more specific attribution when the two disagree only if there is no marker
      if (!marker) file = relativeLocation(meta.location, suiteDir);
    }
    const wrapper = failed && meta.failureType === 'subtestsFailed';
    let status;
    if (directive === 'SKIP') status = 'skip';
    else if (directive === 'TODO') status = 'todo';
    else status = failed ? 'fail' : 'pass';
    rows.push({ file, title, status, reason, wrapper, indent: indent.length });
  }
  const summary = {};
  if (planAt >= 0) {
    for (const k of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
      const m = new RegExp(`^# ${k} (\\d+)$`, 'm').exec(lines.slice(planAt).join('\n'));
      if (m) summary[k] = Number(m[1]);
    }
  }
  const truncated = planAt < 0 || summary.tests == null;
  return { rows, completed, hung, truncated, summary: truncated ? null : summary };
}

const isUnavailable = (reason) => /^UNAVAILABLE:/.test(reason);

/** exclusions: [{file,test,reason,scope}] all four non-empty strings. Returns {entries, problems}. A missing file is "no exclusions"; an unreadable or malformed one is a PROBLEM and none of it is honoured. */
export function loadExclusions(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return e.code === 'ENOENT' ? { entries: [], problems: [] } : { entries: [], problems: [`exclusions file ${file} unreadable: ${e.code || e.message}`] }; }
  let j; try { j = JSON.parse(raw); } catch (e) { return { entries: [], problems: [`exclusions file ${file} is malformed (not JSON): ${e.message}`] }; }
  if (!Array.isArray(j)) return { entries: [], problems: [`exclusions file ${file} is malformed: expected an array of {file,test,reason,scope}`] };
  const problems = [];
  j.forEach((e, k) => {
    for (const key of ['file', 'test', 'reason', 'scope']) if (typeof e?.[key] !== 'string' || !e[key].trim()) problems.push(`exclusions file ${file} is invalid: entry ${k} lacks a non-empty "${key}"`);
  });
  return problems.length ? { entries: [], problems } : { entries: j, problems: [] };
}

/** required coverage manifest: an array of non-empty strings (checkout-relative test files). Missing/unreadable/invalid is a PROBLEM, never an empty list; an explicit [] is allowed. */
export function loadRequired(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return { files: [], problems: [`required-coverage manifest ${file} ${e.code === 'ENOENT' ? 'is MISSING' : `is unreadable (${e.code || e.message})`}`] }; }
  let j; try { j = JSON.parse(raw); } catch (e) { return { files: [], problems: [`required-coverage manifest ${file} is invalid JSON: ${e.message}`] }; }
  if (!Array.isArray(j) || j.some((f) => typeof f !== 'string' || !f.trim())) return { files: [], problems: [`required-coverage manifest ${file} is invalid: expected an array of non-empty file paths`] };
  return { files: j, problems: [] };
}

/**
 * Classify a parsed TAP.
 * @returns the verdict: counts, file lists, per-required-file coverage, problems.
 */
export function classify(parsed, { exclusions = [], required = [], problems = [] } = {}) {
  const leafFail = parsed.rows.filter((r) => r.status === 'fail' && !r.wrapper);
  const todo = parsed.rows.filter((r) => r.status === 'todo');
  const skips = parsed.rows.filter((r) => r.status === 'skip');
  const key = (f, t) => `${f}\u0000${t}`;
  const waived = new Set(exclusions.map((e) => key(e.file, e.test)));
  const unavailable = [], unclassified = [], documented = [];
  for (const s of skips) {
    if (isUnavailable(s.reason)) unavailable.push(s);
    else if (s.file && waived.has(key(s.file, s.title))) documented.push(s);
    else unclassified.push(s);
  }
  const failingFiles = [...new Set(leafFail.map((r) => r.file).filter(Boolean))].sort();
  const todoFiles = [...new Set(todo.map((r) => r.file).filter(Boolean))].filter((f) => !failingFiles.includes(f)).sort();
  // required coverage: executed / passed / failed / skipped are SEPARATE. RAN != PASSED: a file whose tests all executed and failed ran.
  const coverage = required.map((file) => {
    const mine = parsed.rows.filter((r) => r.file === file && !r.wrapper);
    const passed = mine.filter((r) => r.status === 'pass').length, failed = mine.filter((r) => r.status === 'fail').length, skipped = mine.filter((r) => r.status === 'skip').length;
    const executed = passed + failed;
    const completedRun = parsed.completed.has(file) && !parsed.hung.has(file) && !parsed.truncated;
    const ran = completedRun && executed > 0 && skipped === 0;
    const why = ran ? null : parsed.truncated ? 'the TAP was truncated (no summary)' : parsed.hung.has(file) ? 'the file HUNG' : !parsed.completed.has(file) ? (mine.length ? 'rows present but no completed-file marker' : 'absent from the run') : skipped ? `${skipped} test(s) skipped` : 'executed nothing';
    return { file, executed, passed, failed, skipped, ran, why };
  });
  const incompleteFiles = [...new Set([...unavailable, ...unclassified].map((r) => r.file ?? '(unknown file)'))].sort();
  const requiredMissing = coverage.filter((c) => !c.ran);
  const hungFiles = [...parsed.hung].sort();
  return {
    failed: leafFail.length, todo: todo.length, unavailable: unavailable.length, unclassified: unclassified.length, documented: documented.length,
    failingFiles: [...new Set([...failingFiles, ...hungFiles])].sort(), todoFiles, incompleteFiles, coverage, requiredMissing, problems, truncated: parsed.truncated,
    required: `${coverage.filter((c) => c.ran).length}/${coverage.length}`,
    incomplete: unavailable.length > 0 || unclassified.length > 0 || requiredMissing.length > 0 || problems.length > 0 || parsed.truncated,
  };
}

/** the one VERDICT line (V1) */
export function verdictLine(v) {
  const list = (a) => `[${a.join(',')}]`;
  return `VERDICT failed=${v.failed} todo=${v.todo} unavailable=${v.unavailable} unclassified=${v.unclassified} documented=${v.documented} required=${v.required} truncated=${v.truncated ? 1 : 0} failing-files=${list(v.failingFiles)} todo-files=${list(v.todoFiles)}`;
}
