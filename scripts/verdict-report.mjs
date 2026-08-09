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
const {
  recordedRuns, unattributableRuns, redRuns, files,
} = summarize(entries);
const isolations = entries.filter((e) => e.scope === 'isolation');

console.log(`ledger: ${ledgerPath()}`);
console.log('scope : tests/*.test.mjs server suite — via `npm run test:server`,');
console.log('        the server phase of `npm test`, or the suite watch.');
console.log('        NOT covered: bare `node --test`, and `npm run test:browser`.');
console.log('');

// ⚠️ Gate on what the ledger HOLDS, not on what survived the attributability
// filter. Written the other way round, this printed "No recorded server-suite
// runs yet" while sitting on three real events — the reader would have hidden
// the exact record it exists to surface, and the first person to read it would
// have concluded the hook was not firing. Caught by running it against the live
// file rather than a fixture.
if (!recordedRuns && !unattributableRuns) {
  console.log('No recorded server-suite runs yet.');
  console.log('⚠️ That is not evidence the suite has not been run — only that it has');
  console.log('   not been run through an instrumented path since the ledger began.');
  process.exit(0);
}

const first = entries[0]?.at ?? '?';
console.log(`${recordedRuns} recorded CLEAN server-suite run(s) since ${first} — ${redRuns} red.`);
if (unattributableRuns) {
  console.log(`⚠️ ${unattributableRuns} further run(s) recorded but NOT counted: the tree was dirty at a`);
  console.log('   boundary, moved during the run, or was not a git checkout. A verdict over');
  console.log('   uncommitted work describes a state that never shipped, and averaging it with');
  console.log('   clean runs produces a number that describes neither.');
}
console.log('');

if (!recordedRuns) {
  console.log('No CLEAN run has been recorded yet, so there is no denominator to count against.');
  console.log('The unattributable runs above are on record and readable, but a rate built');
  console.log('from them would describe no particular tree.');
} else if (!files.length) {
  console.log('No file has failed in any recorded clean run.');
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
