#!/usr/bin/env node
/**
 * #746 — read the verdict ledger. `npm run test:ledger`
 *
 * Read-only, and deliberately dumb: it counts and prints. Every judgement about
 * what a count MEANS — is this flaky, is it getting worse, should anyone be told
 * — is left to the reader, because there is no dataset yet from which to design
 * a threshold that would not be a guess.
 *
 * ⚠️ THE DENOMINATOR IS THE POINT, and it took four narrowings to state
 * honestly. Every count here is out of RECORDED CLEAN COMPLETED server-suite
 * runs, which is a much smaller world than "runs":
 *
 *   recorded  a bare `node --test tests/*.test.mjs` is not instrumented and
 *             never appears; `npm run test:browser` is a different suite and is
 *             not covered either. Known boundaries, not oversights.
 *   clean     a run over a dirty tree, or one whose tree moved under it, is
 *             recorded but never counted — it describes a state that never
 *             shipped, and averaging it with clean runs describes neither.
 *   completed a TIMED-OUT run produces no event at all: the process tree is
 *             killed before the runner can write one. #735's alarm owns that
 *             case — it posts, names the incomplete files, and terminates the
 *             tree. ⚠️ THE SEAM: if that alarm ever regresses, timeouts go
 *             invisible in BOTH instruments at once and nothing here will say
 *             so. Written down because a true dependency left unwritten is
 *             indistinguishable from coverage.
 *   subsets   are not verdicts about the suite and are not counted.
 *
 * Saying "2 of 47 runs" would invite the reading that 47 runs happened. On the
 * day this was written that would have been wrong by most of them. It is the
 * same defect as reporting a subset-green as a suite-green: a true number about
 * a smaller world than the reader assumes.
 */

import { ledgerPath, readLedger, summarize } from './verdict-ledger.mjs';

const {
  entries, malformed, missing, readError,
} = readLedger();
const {
  recordedRuns, unattributableRuns, unattributableRedRuns, redRuns, files,
} = summarize(entries);

console.log(`ledger: ${ledgerPath()}`);
console.log('scope : COMPLETED tests/*.test.mjs server-suite runs — via `npm run test:server`,');
console.log('        the server phase of `npm test`, or the suite watch.');
console.log('        NOT covered: bare `node --test`, `npm run test:browser`, and');
console.log('        TIMED-OUT runs (no event is written; #735\'s alarm owns those).');
console.log('');

// ⚠️ Unreadable is its own fact. Reported before anything else, and it never
// borrows the words "missing" or "empty": the path exists, and the reader must
// not send someone to check whether the hook fires when the real answer is that
// the file cannot be opened.
if (readError) {
  console.log(`⚠️ The ledger could not be READ (${readError}). This is not "no runs" and not "no file" —`);
  console.log('   the path exists and could not be opened, so nothing below can be counted.');
  process.exit(0);
}

// ⚠️ Damage is reported before any count, so a number is never read against a
// file that was partly unreadable without the reader knowing.
if (malformed) {
  console.log(`⚠️ ${malformed} line(s) in the ledger could not be parsed and are NOT counted below.`);
  console.log('   The valid lines are still being read. A count taken against a damaged file');
  console.log('   is a lower bound, not a measurement.');
  console.log('');
}

// Gate on what the file HOLDS — including what could not be parsed. Written the
// other way round, this printed "No recorded server-suite runs yet" while
// sitting on real events, and would have sent the first reader hunting a hook
// that works.
if (!entries.length && !malformed) {
  console.log(missing ? 'No ledger file yet — nothing has been recorded.' : 'The ledger is empty.');
  console.log('⚠️ That is not evidence the suite has not been run — only that it has');
  console.log('   not been run to completion through an instrumented path.');
  process.exit(0);
}

const first = entries[0]?.at ?? '?';
console.log(`${recordedRuns} recorded CLEAN COMPLETED server-suite run(s) since ${first} — ${redRuns} red.`);
if (unattributableRuns) {
  // ⚠️ The RED COUNT belongs on this line. Without it the reader reported the
  // exclusion's reason but not its contents, so a person asking "have we had any
  // reds?" saw `0 red`, a bucket explained entirely by tree-state, and "No file
  // has failed" — every sentence true, the composite false, at a moment when
  // every red on record was inside that bucket. Stated in both directions, so
  // the line is informative when the answer is reassuring too.
  const reds = unattributableRedRuns ? `${unattributableRedRuns} of them RED` : 'none of them red';
  console.log(`⚠️ ${unattributableRuns} further completed run(s) recorded but NOT counted — ${reds}.`);
  console.log('   Excluded because the tree was dirty at a boundary, moved during the run,');
  console.log('   or was not a git checkout. Excluded from the count, not from the record.');
}
console.log('');

if (!recordedRuns) {
  console.log('No CLEAN run has been recorded yet, so there is no denominator to count against.');
  console.log('Anything above is on record and readable, but a rate built from it would');
  console.log('describe no particular tree.');
} else if (!files.length) {
  console.log('No file has failed in any recorded clean completed run.');
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

const isolations = entries.filter((e) => e.scope === 'isolation');
if (isolations.length) {
  console.log('');
  console.log(`${isolations.length} isolation rerun(s) recorded (the watch's flake triage):`);
  for (const iso of isolations.slice(-10)) {
    const verdict = iso.verdict === 'green' ? 'green alone ⇒ flake' : 'red alone ⇒ real';
    console.log(`  ${iso.at}  parent=${iso.parentRunId ?? '?'}  ${verdict}  [${(iso.failed || []).join(', ') || '—'}]`);
  }
}
