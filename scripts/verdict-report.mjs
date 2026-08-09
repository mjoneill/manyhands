#!/usr/bin/env node
/**
 * #746 — read the verdict ledger. `npm run test:ledger`
 *
 * Read-only, and deliberately dumb: it counts and prints. Every judgement about
 * what a count MEANS — is this flaky, is it getting worse, should anyone be told
 * — is left to the reader, because there is no dataset yet from which to design
 * a threshold that would not be a guess.
 *
 * ⚠️ THE DENOMINATOR IS THE POINT. Every count here is out of RECORDED
 * server-suite runs, which is a smaller world than "runs":
 *
 *   - a bare `node --test tests/*.test.mjs` is not instrumented and never
 *     appears — a known boundary, not an oversight;
 *   - `npm run test:browser` (node run-tests.js) is a different suite entirely
 *     and is not covered, so a red there is invisible here BY DESIGN;
 *   - subset runs are not verdicts about the suite and are not counted.
 *
 * Saying "2 of 47 runs" would invite the reading that 47 runs happened. On the
 * day this was written that would have been wrong by most of them. It is the
 * same defect as reporting a subset-green as a suite-green: a true number about
 * a smaller world than the reader assumes.
 */

import { ledgerPath, readVerdicts, summarize } from './verdict-ledger.mjs';

const entries = readVerdicts();
const { recordedRuns, redRuns, files } = summarize(entries);
const isolations = entries.filter((e) => e.scope === 'isolation');

console.log(`ledger: ${ledgerPath()}`);
console.log('scope : tests/*.test.mjs server suite — via `npm run test:server`,');
console.log('        the server phase of `npm test`, or the suite watch.');
console.log('        NOT covered: bare `node --test`, and `npm run test:browser`.');
console.log('');

if (!recordedRuns) {
  console.log('No recorded server-suite runs yet.');
  console.log('⚠️ That is not evidence the suite has not been run — only that it has');
  console.log('   not been run through an instrumented path since the ledger began.');
  process.exit(0);
}

const first = entries[0]?.at ?? '?';
console.log(`${recordedRuns} recorded server-suite run(s) since ${first} — ${redRuns} red.`);
console.log('');

if (!files.length) {
  console.log('No file has failed in any recorded run.');
} else {
  const width = Math.max(...files.map((f) => f.file.length));
  for (const { file, count, ofRecordedRuns } of files) {
    console.log(`  ${file.padEnd(width)}  red in ${String(count).padStart(3)} of ${ofRecordedRuns} recorded runs`);
  }
  console.log('');
  console.log('⚠️ A high count is not automatically a flake and a low one is not');
  console.log('   automatically noise — a genuine regression is red in EVERY run');
  console.log('   after it lands. Compare the count against the runs since it first');
  console.log('   appeared, not against the total.');
}

if (isolations.length) {
  console.log('');
  console.log(`${isolations.length} isolation rerun(s) recorded (the watch\'s flake triage):`);
  for (const iso of isolations.slice(-10)) {
    const verdict = iso.verdict === 'green' ? 'green alone ⇒ flake' : 'red alone ⇒ real';
    console.log(`  ${iso.at}  parent=${iso.parentRunId ?? '?'}  ${verdict}  [${(iso.failed || []).join(', ') || '—'}]`);
  }
}
