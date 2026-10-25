#!/usr/bin/env node
/**
 * #1690 — the CI leg of the platform-split landing gate (decision 45a5d8e4).
 *
 *   node scripts/check-platform-skips.mjs <tap-file> --manifest <path> --root <checkout> --sha <40-hex>
 *                                         --suite-exit <n> --l1-tap <file> --l1-exit <n> [--receipt <path>]
 *
 * A CI leg is clean only if the suite itself finished clean AND its skips are exactly the platform-only ones:
 *   · the suite's exit status (--suite-exit, required) is 0, no test line fails (TODO rows excepted), and no
 *     `# fail N` summary is above zero — skip compliance alone is not a green run (review of the first build)
 *   · the manifest equals the UNAVAILABLE skip set: a listed test that RAN or is absent, an UNAVAILABLE skip that is
 *     not listed, and a skip for ANY other reason (a bare `# SKIP` included) are refused and named
 *   · the commit is verified, not declared: --root must be a git checkout whose HEAD is --sha with no modified
 *     tracked file; the receipt carries that HEAD's tree
 *   · #1693: the L1 latency test, which runs in its own step outside the suite, passed: the step exited 0
 *     (--l1-exit), its TAP (--l1-tap) has the L1 LATENCY test as a plain `ok` (not skipped, not TODO), and both
 *     phases printed a result. The receipt carries this as `l1Ok`, and a false one makes the leg not clean.
 *
 * Whenever it reaches a verdict (exit 0 or 1) it prints the receipt as one line, `PLATFORM-RECEIPT <json>`; when it
 * cannot check (exit 2) it prints none.
 *
 * Exit 0 clean · 1 mismatch, naming each test or the exit · 2 could not check (empty, missing or test-less TAP; a
 * missing, empty or malformed manifest; a missing or non-numeric suite exit; a missing --l1-tap, a missing, empty or
 * test-less L1 TAP, or a missing or non-numeric --l1-exit; a sha that is not the checkout).
 */
import fs from 'node:fs';
import { EXIT, CannotCheck, parseArgs, readManifest, parseTap, isPlatformSkip, writeReceipt, verifyCheckout, RECEIPT_MARKER, MAX_PROBLEM } from './platform-gate-lib.mjs';

// A problem names a test, and a test name has no length limit; the printed receipt does.
// The cut never splits a surrogate pair.
const clip = (p) => (p.length <= MAX_PROBLEM ? p : `${p.slice(0, MAX_PROBLEM - 1).replace(/[\uD800-\uDBFF]$/, '')}…`);
const L1_PREFIX = 'L1 LATENCY';

function main(argv) {
  const { flags, positional } = parseArgs(argv);
  const tapFile = positional[0];
  if (!tapFile) throw new CannotCheck('no TAP file given');
  if (flags['suite-exit'] === undefined || !/^\d+$/.test(flags['suite-exit'])) {
    throw new CannotCheck(`--suite-exit must be the suite's numeric exit status, got ${flags['suite-exit'] === undefined ? 'nothing' : `"${flags['suite-exit']}"`}`);
  }
  const suiteExit = Number(flags['suite-exit']);
  if (!flags['l1-tap']) throw new CannotCheck('no --l1-tap given (the L1 step\'s TAP)');
  if (flags['l1-exit'] === undefined || !/^\d+$/.test(flags['l1-exit'])) {
    throw new CannotCheck(`--l1-exit must be the L1 step's numeric exit status, got ${flags['l1-exit'] === undefined ? 'nothing' : `"${flags['l1-exit']}"`}`);
  }
  const l1Exit = Number(flags['l1-exit']);
  const { sha, tree } = verifyCheckout(flags.root, flags.sha);
  const manifest = readManifest(flags.manifest);

  let text;
  try { text = fs.readFileSync(tapFile, 'utf8'); } catch (e) { throw new CannotCheck(`cannot read TAP ${tapFile}: ${e.code ?? e.message}`); }
  const tests = parseTap(text);
  if (tests.length === 0) throw new CannotCheck(`TAP ${tapFile} has no test lines`);

  let l1Text;
  try { l1Text = fs.readFileSync(flags['l1-tap'], 'utf8'); } catch (e) { throw new CannotCheck(`cannot read L1 TAP ${flags['l1-tap']}: ${e.code ?? e.message}`); }
  const l1Tests = parseTap(l1Text);
  if (l1Tests.length === 0) throw new CannotCheck(`L1 TAP ${flags['l1-tap']} has no test lines`);

  const problems = [];

  // ── the suite finished clean
  if (suiteExit !== 0) problems.push(`the suite exited ${suiteExit}, not 0`);
  const failSummaries = [...text.matchAll(/^# fail (\d+)\s*$/gm)].map((m) => Number(m[1])).filter((n) => n > 0);
  if (failSummaries.length) problems.push(`the TAP reports failures: # fail ${Math.max(...failSummaries)}`);
  const failed = new Set(tests.filter((t) => !t.ok && t.directive !== 'TODO').map((t) => t.name));
  for (const name of failed) problems.push(`test failed: ${name}`);
  // #1766 — a file the runner KILLED at its per-file bound never ran its remaining rows, and its rows that did run can
  // all pass: "no test failed" is then not "every test ran". Each kill is a named problem, never a quiet pass. Its
  // shadow, the temp leak a SIGKILL leaves (no finally, after() or exit handler runs), is named too.
  for (const m of text.matchAll(/^# ⛔ HUNG: (\S+) exceeded (\d+)ms/gm)) {
    problems.push(`HUNG: ${m[1]} was killed at ${m[2]} ms; its remaining tests never ran (a red, incomplete file)`);
  }
  for (const m of text.matchAll(/^# tmp: ⛔ (\S+) left (\d+) entries, (\d+) bytes: a NEW leak/gm)) {
    problems.push(`temp leak: ${m[1]} left ${m[2]} entries (${m[3]} bytes), not on the baseline`);
  }

  // ── the skips are exactly the manifest. The runner reprints failing rows in a FAILURES section, so a name can
  // appear twice; judge each name once, and a name that skipped as UNAVAILABLE anywhere counts as skipped.
  const listed = new Set(manifest.entries.map((e) => e.name));
  const byName = new Map();
  for (const t of tests) {
    const prev = byName.get(t.name);
    if (!prev || (isPlatformSkip(t) && !isPlatformSkip(prev))) byName.set(t.name, t);
  }
  for (const name of listed) {
    const t = byName.get(name);
    if (!t) problems.push(`manifest test did not appear in the run: ${name}`);
    else if (!isPlatformSkip(t)) problems.push(`manifest test was not skipped as UNAVAILABLE (${t.directive ?? (t.ok ? 'ran' : 'failed')}): ${name}`);
  }
  for (const t of byName.values()) {
    if (t.directive !== 'SKIP') continue;
    if (!isPlatformSkip(t)) problems.push(`skipped for a reason that is not a platform skip (${t.reason || 'no reason given'}): ${t.name}`);
    else if (!listed.has(t.name)) problems.push(`UNAVAILABLE skip not listed in the manifest: ${t.name}`);
  }

  // ── #1693: the L1 latency step ran clean. It runs alone, outside the suite, so nothing above can see it.
  const l1Problems = [];
  if (l1Exit !== 0) l1Problems.push(`the L1 step exited ${l1Exit}, not 0`);
  const l1 = l1Tests.find((t) => t.name.startsWith(L1_PREFIX));
  if (!l1) l1Problems.push(`the ${L1_PREFIX} test did not appear in the L1 step`);
  else if (l1.directive === 'SKIP') l1Problems.push(`the ${L1_PREFIX} test was skipped (${l1.reason || 'no reason given'})`);
  else if (l1.directive === 'TODO') l1Problems.push(`the ${L1_PREFIX} test is marked TODO, which is not a pass`);
  else if (!l1.ok) l1Problems.push(`the ${L1_PREFIX} test failed`);
  // A pass with a phase missing is half a measurement: the test prints one line per phase.
  for (const [phase, re] of [['idle', /^\s*#\s*L1 idle:/m], ['loaded', /^\s*#\s*L1 loaded\b/m]]) {
    if (!re.test(l1Text)) l1Problems.push(`the L1 ${phase} phase did not report a result`);
  }
  const l1Ok = l1Problems.length === 0;
  problems.push(...l1Problems);

  const ok = problems.length === 0;
  const receipt = {
    leg: 'ci', sha, tree, manifestSha256: manifest.sha256, suiteExit, ok,
    matched: ok ? listed.size : null, l1Ok, problems: problems.map(clip), at: new Date().toISOString(),
  };
  writeReceipt(flags.receipt, receipt);
  // #837: the receipt file never leaves the runner, so the verdict is also printed as one marked line that a landing
  // recovers from this step's log (scripts/extract-ci-receipt.mjs). It holds only the allowlisted receipt fields.
  console.log(`${RECEIPT_MARKER} ${JSON.stringify(receipt)}`);
  if (ok) {
    console.log(`CI leg clean: suite exit 0, no failures, and ${listed.size} of ${listed.size} manifest tests skipped as UNAVAILABLE with no other skips (sha ${sha}, tree ${tree}, manifest ${manifest.sha256})`);
    return EXIT.CLEAN;
  }
  for (const p of problems) console.log(`⛔ ${p}`);
  console.log(`CI leg not clean: ${problems.length} problem(s) (sha ${sha})`);
  return EXIT.MISMATCH;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  console.error(`⛔ could not check the CI leg: ${e.message}`);
  // Any failure to finish the check, expected or not, fails closed.
  process.exitCode = EXIT.CANNOT_CHECK;
}
