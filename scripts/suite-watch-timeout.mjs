/**
 * #1778 — what a suite-watch TIMEOUT says. The whole-run deadline is a runaway backstop; it is not a hang detector. A single
 * hung file is the runner's job: scripts/run-test-files.mjs kills a file past its per-file bound and prints
 * `# ⛔ HUNG: tests/<file> exceeded <ms>ms and was killed with its process group.` So on a timeout the watch reports the
 * runner's own evidence instead of calling every timeout a hang (10-26: 682 of 684 files completed, the runner killed none,
 * and the alarm said "This is a HANG"):
 *   - hung files named   when the runner killed any as HUNG
 *   - a growth reading   when it killed none: "no per-file hang was DETECTED" (a file that started within its per-file bound
 *                        of the deadline was never judged, so this is evidence for growth, not proof of it)
 * Pure: no I/O, so its rows can import it (scripts/suite-watch.mjs runs on import).
 */

/** The files the runner killed as HUNG, by basename, sorted and unique, from its accumulated output. */
export function hungFilesIn(out) {
  return [...new Set([...String(out).matchAll(/HUNG: tests\/(\S+?\.test\.mjs) exceeded/g)].map((m) => m[1]))].sort();
}

/** The sentence a timeout alarm carries about WHY the run did not finish. */
export function timeoutReading({ hungFiles, completedCount, incompleteFiles }) {
  if (hungFiles.length) return `The runner killed ${hungFiles.length} file(s) as HUNG (each past its per-file bound): ${hungFiles.join(', ')}. `;
  const total = completedCount + incompleteFiles.length;
  return `No per-file hang was detected (the runner killed no file as HUNG): ${completedCount} of ${total} files completed before the `
    + 'whole-run deadline, which points to the suite OUTGROWING its cap rather than a hang (a file started within its per-file bound '
    + 'of the deadline could not be judged). Run the files below alone before chasing them as hangs. ';
}
