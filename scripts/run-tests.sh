#!/bin/sh
# run-tests.sh — the verdict pipeline, owned by the toolkit (#670).
#
# Two incident classes from one morning motivated this:
#   pipe-masks-exit-code    3 hits: `test | filter && act` puts a filter between
#                           the verdict and the decision; `fail 1` sailed into
#                           two deploys and one confident wrong table.
#   subset-reported-as-suite 4+ hits: 13/13, 25/25, 9/9, 5/5 — all true, all
#                           subset-greens delivered with full-green confidence,
#                           while the full suite sat red for a day.
#
# Contract:
#   - DEFAULT is the FULL suite (tests/*.test.mjs). Narrowing requires naming
#     files, and the output then carries an exclusion banner — a subset-green
#     cannot be read as a suite-green.
#   - The exit code is the runner's own, captured directly. Safe to `&&`-chain
#     BECAUSE the verdict is the exit code, not the stdout.
#   - The summary tail prints unconditionally, pass or fail.
#
# Usage:
#   scripts/run-tests.sh                    # full suite — the only invocation
#                                           # that may be reported as "green"
#   scripts/run-tests.sh tests/foo.test.mjs # subset — banner names the narrowing

# #1672 — the signal traps go in FIRST, before anything is created: a TERM/INT that lands while the script is still
# listing tests or making its temp files would otherwise kill the shell by its default action and leave those files
# (RJ: the runner's own run-tests.* files left in 7 of 300 driver runs, SIGTERM at 10-29 ms, at cee194d). The traps
# only record the signal; every check of `got` below acts on it.
got=''
trap 'got=143' TERM
trap 'got=130' INT

cd "$(dirname "$0")/.." || exit 2

total=$(ls tests/*.test.mjs 2>/dev/null | wc -l | tr -d ' ')
if [ "$#" -eq 0 ]; then
  scope="FULL SUITE ($total files)"
  set -- tests/*.test.mjs
  # #746 — record the first verdict. Opt-IN, and only here: a subset is not a
  # verdict about the suite, which is what the banner below already says.
  RUN_TESTS_LEDGER=full
  export RUN_TESTS_LEDGER
else
  scope="SUBSET: $# of $total files — NOT a full-suite verdict"
  # ⚠️ UNSET, not merely "don't set". `run-tests-helper.test.mjs` runs this
  # script inside the suite, so a full run's environment is INHERITED by the
  # fixture runs — and those fixtures are deliberately red. Without this line a
  # full suite would record `deliberate-red.test.mjs` as a failing file every
  # time the harness tested itself, and the ledger would libel a file that is
  # doing its job. Found in review before it was written, not after.
  unset RUN_TESTS_LEDGER
  unset RUN_TESTS_RUN_ID
  unset RUN_TESTS_PARENT_RUN_ID
fi

# #735 — EMIT AS WE GO, don't buffer to the end.
#
# This used to be `node --test "$@" >"$out" 2>&1`, with every echo below running
# only after node returned. So a run killed by the suite watch's deadline
# emitted NOTHING: the watcher captured 0 bytes, found nothing to parse, and
# posted `RED (summary unparsed)` — which reads as "the output was garbled" and
# sends the reader hunting a broken parser. Measured on the 08-08 09:45Z
# incident: 0 bytes captured, 158,338 bytes of real TAP sitting in $out, where
# `rm -f` had not run either. The diagnosis was on disk the whole time and
# nothing referenced it.
#
# The per-file launcher keeps independent files parallel and puts each completed
# file's TAP on stdout immediately. The temp file is still written for greps.
#
# ⚠️ The exit code is the point of this whole script (see pipe-masks-exit-code
# in the header). In a pipeline `$?` is TEE's status, not node's, and `pipefail`
# is not POSIX. So node's own code is carried out of the pipeline through a
# file — portable, and it keeps the verdict the runner's own.
out=$(mktemp "${TMPDIR:-/tmp}/run-tests.XXXXXX")
rcfile=$(mktemp "${TMPDIR:-/tmp}/run-tests-rc.XXXXXX")
# #1672 — node's pid, written by run-test-files.mjs, so a signal to THIS shell reaches it. A shell does not forward
# signals, and it defers a trap until its FOREGROUND job ends; so the pipeline runs in the background and the shell
# waits on it, which a trap can interrupt. On TERM/INT node runs the same ordered teardown as a normal finish (settle
# the process tree, report, remove the suite folder), and this shell then removes its own temp files.
pidfile=$(mktemp "${TMPDIR:-/tmp}/run-tests-pid.XXXXXX")
RUN_TESTS_PIDFILE=$pidfile
export RUN_TESTS_PIDFILE
# The trap only RECORDS the signal. All the work (wait for node's pid, forward, wait, clean up) runs in the main flow,
# outside the trap: a handler that ran commands could fire before `pipeline=$!` was assigned, and in that window the
# shell was seen to stall inside the handler (#1672 RJ: SIGTERM 30 ms after start hung the run in 2 of 80 tries). With a
# flag, a signal that lands at any point, before the pipeline exists or during `wait`, is seen by the check below.
# a signal that arrived while the temp files were being made: remove them and stop before anything is started
if [ -n "$got" ]; then rm -f "$out" "$rcfile" "$pidfile"; exit "$got"; fi
{ node scripts/run-test-files.mjs "$@" 2>&1; echo $? >"$rcfile"; } | tee "$out" &
pipeline=$!
while :; do
  if [ -n "$got" ]; then
    # node writes its pid within tens of ms of starting; wait for it (bounded) rather than find nothing to forward
    i=0
    while [ ! -s "$pidfile" ] && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
    if [ -s "$pidfile" ]; then kill -TERM "$(cat "$pidfile")" 2>/dev/null; fi
    # node now runs its ordered teardown; a second signal can interrupt this wait, so wait until the pipeline is gone
    while kill -0 "$pipeline" 2>/dev/null; do wait "$pipeline" 2>/dev/null; done
    rm -f "$out" "$rcfile" "$pidfile"
    exit "$got"
  fi
  # Poll for the flag instead of blocking in `wait`: a TERM that lands after the check above and before `wait` begins
  # has already run its trap, and a `wait` started after that is not woken by it, so it blocks until the pipeline
  # ends on its own (a lost wakeup; on bash 3.2, a TERM before `wait` left it waiting 6 s for its child; widened between
  # check and wait, 8 of 8 runs hung). The poll sees the flag within one interval; a normal finish is noticed up to 50 ms late.
  while kill -0 "$pipeline" 2>/dev/null && [ -z "$got" ]; do sleep 0.05; done
  [ -n "$got" ] && continue
  # the pipeline has ended: collect it
  wait "$pipeline"
  [ -n "$got" ] || break
done
trap - TERM INT
rc=$(cat "$rcfile" 2>/dev/null || echo 1)
rm -f "$rcfile" "$pidfile"

# The TAP above already carried the counts (we tee it now), so re-printing the
# summary here would DOUBLE it — and the suite watch builds its summary by
# matching every `# tests|pass|fail N` in the output, so a duplicate reads as
# "# tests 749 · # pass 749 · # fail 0 · # tests 749 · ...". Banner only.
echo "── $scope ──"
if [ "$rc" -ne 0 ]; then
  echo "── FAILURES ──"
  grep -B1 -A12 "^not ok" "$out" | head -80
fi
rm -f "$out"

if [ "$#" -ne "$total" ] && [ "$rc" -eq 0 ]; then
  echo "── subset green ≠ suite green: run with no args before reporting green ──"
fi
exit $rc
