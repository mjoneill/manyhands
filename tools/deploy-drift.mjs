/**
 * tools/deploy-drift.mjs — #606. What is PUBLISHED that production is not RUNNING?
 *
 * Five instances of "no git-side signal is a deploy" and the remedy this card
 * specified has never existed. This is the read-only half: it fetches nothing
 * unless asked, writes nothing, and answers the one question no watch on this
 * machine answers — the gap between published and running.
 *
 * ⛔ THREE WAYS A DRIFT CHECK LIES, each taken from #606's own history:
 *
 *  1  `origin/main` IS A LOCAL REF (instance 3). It moves only when someone
 *     fetches. A check comparing against it reports "0 behind" from a six-hour
 *     -old idea of the remote and nothing in the output says the comparison is
 *     stale — a check that CANNOT FAIL, whose silence reads as health. This
 *     card's own proposed fix contained that defect for two weeks.
 *     ⇒ So this report STATES THE AGE OF ITS OWN COMPARAND, always, in the
 *       output. The fix is not more checking; it is the instrument disclosing
 *       what it is comparing against.
 *
 *  2  A MISSING SERVED SHA MUST NOT READ AS ZERO. "I could not find out" and
 *     "there is nothing to report" are opposite facts, and rendering them
 *     identically is the false all-clear this card is about. ⇒ ok:false and
 *     total:null, never 0.
 *
 *  3  A BARE COUNT UNDERSTATES AND OVERSTATES AT ONCE (instance 5). Of nine
 *     dormant commits one night, four were test-only — deploying them is a
 *     no-op — while one of the other five was a SAFETY precondition answering
 *     200 to anyone who trusted it. "9 behind" tells you neither. ⇒ split
 *     runtime from test-only, and NAME the commits.
 *
 * ⚠️ It must run from a CLONE. The served export has no `.git` BY DESIGN
 * (#1008), so the served sha is read from the DEPLOYED-SHA file the export
 * writes — never from git in production.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Paths that cannot change what the running server DOES. Deploying a commit
// touching only these is a no-op, so counting them as "dormant" overstates the
// gap — measured on 2026-08-24, where 4 of 9 were test-only.
const NON_RUNTIME = [/^tests\//, /^tools\//];

function git(repoDir, args) {
  return execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8' }).trim();
}

// #606 instance 6 — beyond this age the local ref is not evidence about the
// remote. 15 minutes because that is already the age at which this tool warned;
// the warning and the refusal now share one threshold rather than drifting apart.
const STALE_REF_MINUTES = 15;

/** How stale is the ref we are comparing against? Never inferred by the reader. */
/**
 * ⭐ `short` is what rides the SUMMARY LINE. #606 instance 6: the freshness was
 * emitted as its own line, a consumer selected only the count line with a `sed`
 * pattern the caveat did not match, and the stamp then asserted "up to date
 * with origin/main" against a 23-minute-old ref — identical in appearance to a
 * six-hour-old one. A separable warning WILL be separated. So it is not beside
 * the verdict; it is INSIDE it.
 */
function refFreshness(repoDir, ref) {
  if (!/^origin\//.test(ref)) {
    return { kind: 'local', stale: false, short: `${ref} is a local ref`, text: `comparing against ${ref} (a local ref in this clone, not the remote)` };
  }
  const fetchHead = path.join(repoDir, '.git', 'FETCH_HEAD');
  if (!existsSync(fetchHead)) {
    return { kind: 'never-fetched', stale: true, short: `⚠️ ${ref} NEVER fetched`, text: `⚠️ ${ref} has NEVER been fetched in this clone — it may be arbitrarily stale` };
  }
  const ageMs = Date.now() - statSync(fetchHead).mtimeMs;
  const mins = Math.round(ageMs / 60000);
  // ⭐ ONE predicate, not a constant repeated at two sites (#890: sharing a
  // constant is not sharing a rule). The glyph the reader sees and the verdict
  // the tool reaches are the SAME judgement about the same ref.
  const stale = mins > STALE_REF_MINUTES;
  const warn = stale ? '⚠️ ' : '';
  return { kind: 'fetched', ageMinutes: mins, stale, short: `${warn}ref fetched ${mins}m ago`, text: `${warn}${ref} last fetched ${mins} min ago — this comparison is only as fresh as that` };
}

/**
 * @returns {{ok:boolean,total:number|null,runtime:Array,testOnly:Array,lines:string[],header:string[],summary:string,refAge:object,error?:string}}
 */
export function driftReport({ repoDir, servedDir, ref = 'origin/main' } = {}) {
  const refAge = refFreshness(repoDir, ref);
  const header = [refAge.text];
  const fail = (error) => ({
    ok: false, total: null, runtime: [], testOnly: [], lines: [], header,
    summary: `deploy drift: UNKNOWN — ${error} [${refAge.short}]`, refAge, error,
  });

  const shaFile = path.join(servedDir, 'DEPLOYED-SHA');
  if (!existsSync(shaFile)) {
    // ⛔ NOT zero. The whole point: unknown and none are different facts.
    return fail(`no DEPLOYED-SHA in ${servedDir} — cannot tell what is running`);
  }
  const served = readFileSync(shaFile, 'utf8').trim();
  if (!/^[0-9a-f]{40}$/.test(served)) {
    return fail(`DEPLOYED-SHA is not a 40-char sha (${JSON.stringify(served.slice(0, 60))})`);
  }
  try {
    git(repoDir, ['cat-file', '-e', `${served}^{commit}`]);
  } catch {
    return fail(`served sha ${served.slice(0, 7)} is unknown to this clone — cannot resolve it, so no count is possible`);
  }

  let raw;
  try {
    raw = git(repoDir, ['log', '--reverse', '--format=%H%x00%s', `${served}..${ref}`]);
  } catch (e) {
    return fail(`could not compare ${served.slice(0, 7)}..${ref}: ${e.message.split('\n')[0]}`);
  }

  const commits = raw ? raw.split('\n').map((l) => {
    const [sha, subject] = l.split('\0');
    const files = git(repoDir, ['show', '--name-only', '--format=', sha])
      .split('\n').map((s) => s.trim()).filter(Boolean);
    const runtimeFiles = files.filter((f) => !NON_RUNTIME.some((re) => re.test(f)));
    return { sha, short: sha.slice(0, 7), subject, files, runtimeFiles, isRuntime: runtimeFiles.length > 0 };
  }) : [];

  const runtime = commits.filter((c) => c.isRuntime);
  const testOnly = commits.filter((c) => !c.isRuntime);

  // ⭐ Named, not merely counted — a count cannot show that one dormant commit
  // is a safety precondition currently answering 200 to anyone who trusts it.
  const lines = commits.map((c) => `  ${c.isRuntime ? 'RUNTIME  ' : 'test-only'} ${c.short}  ${c.subject}`);

  // #726 — the count is ALWAYS stated, including zero. A line that appears only
  // on trouble is an alarm with extra steps, and its absence is unreadable.
  // ⇒ The freshness rides the SUMMARY, not a neighbouring line. See refFreshness().
  // ⛔⛔ INSTANCE 6, and it is this card's founding sentence occurring inside
  // this card's own remedy. Measured live 2026-08-24T04:30Z: a 73-minute-old
  // local ref, served == that ref, and the stamp read "0 — production is up to
  // date" while production was behind by a commit the ref had never heard of.
  //
  // ⭐ THE ASYMMETRY THAT SHAPES THIS: a stale ref cannot INVENT commits, only
  // MISS them. So staleness can only ever UNDERSTATE drift.
  //
  //   commits > 0 + stale ⇒ the ones found are REAL. Report them as a LOWER
  //                         BOUND. The instrument still knows something, and
  //                         going quiet here would mute it in precisely the
  //                         situation it exists for.
  //   commits = 0 + stale ⇒ ⛔ UNSAYABLE. Zero is the single value that
  //                         staleness manufactures out of nothing, and it is
  //                         the one that reads as health.
  //
  // ⇒ This is NOT "stale ⇒ refuse". A blanket refusal would be the alarm-fatigue
  // trade — a report that cries UNKNOWN on a routine condition stops being read.
  if (commits.length === 0 && refAge.stale) {
    return {
      ok: false, total: null, runtime: [], testOnly: [], lines: [], header, refAge, served,
      error: `the comparison ref is too stale to distinguish "no drift" from "not looked recently"`,
      // ⚠️ The wording avoids the phrase "up to date" DELIBERATELY, and a test
      // enforces it. A consumer greps this stamp for reassurance; a refusal
      // that contains the reassuring phrase inside its own explanation would
      // match that grep. The all-clear must not be quotable from the refusal.
      summary: `deploy drift: UNKNOWN — a stale ref cannot tell "no drift" from `
        + `"not looked recently"; fetch ${ref} and re-run [${refAge.short}]`,
    };
  }

  const summary = (commits.length === 0
    ? `deploy drift: 0 — production is up to date with ${ref}`
    : `deploy drift: ${refAge.stale ? 'at least ' : ''}${commits.length} commit(s) behind ${ref} — `
      + `${runtime.length} runtime-affecting, ${testOnly.length} test-only`)
    + ` [${refAge.short}]`;

  return { ok: true, total: commits.length, runtime, testOnly, lines, header, summary, refAge, served };
}

// ── CLI ────────────────────────────────────────────────────────────────────
// Read-only. Exits 0 whether or not there is drift: this REPORTS, it does not
// gate. A report that fails the caller teaches the caller to stop calling it.
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name, dflt) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
  };
  // ⚠️ NO DEFAULT for the served directory, and that is deliberate twice over.
  // `scripts/deploy.sh` already requires DEPLOY_SERVE with no default — "set
  // DEPLOY_SERVE to the directory the services run FROM" — so this shares that
  // CONTRACT rather than inventing a second one beside it (#890: sharing a
  // constant is not sharing a rule).
  //
  // And a baked-in default would be a guess about someone's machine layout
  // that reads as authoritative: the wrong directory yields "no DEPLOYED-SHA",
  // which this tool correctly reports as UNKNOWN — but a reader would have no
  // idea it had been pointed somewhere fictional.
  const servedDir = arg('served', process.env.DEPLOY_SERVE || '');
  if (!servedDir) {
    console.error('deploy drift: UNKNOWN — set DEPLOY_SERVE (or pass --served) to the '
      + 'directory the services run FROM. There is no default: guessing it would report '
      + '"nothing deployed" for a path that was never checked.');
    process.exit(2);
  }
  const r = driftReport({
    repoDir: arg('repo', process.cwd()),
    servedDir,
    ref: arg('ref', 'origin/main'),
  });
  for (const h of r.header) console.log(h);
  console.log(r.summary);
  for (const l of r.lines) console.log(l);
  process.exit(0);
}
