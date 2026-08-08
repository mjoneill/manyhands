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

cd "$(dirname "$0")/.." || exit 2

total=$(ls tests/*.test.mjs 2>/dev/null | wc -l | tr -d ' ')
if [ "$#" -eq 0 ]; then
  scope="FULL SUITE ($total files)"
  set -- tests/*.test.mjs
else
  scope="SUBSET: $# of $total files — NOT a full-suite verdict"
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
# `tee` puts the same bytes on stdout as they are produced, so a killed run has
# already said what it knew. The temp file is still written for the greps below.
#
# ⚠️ The exit code is the point of this whole script (see pipe-masks-exit-code
# in the header). In a pipeline `$?` is TEE's status, not node's, and `pipefail`
# is not POSIX. So node's own code is carried out of the pipeline through a
# file — portable, and it keeps the verdict the runner's own.
out=$(mktemp "${TMPDIR:-/tmp}/run-tests.XXXXXX")
rcfile=$(mktemp "${TMPDIR:-/tmp}/run-tests-rc.XXXXXX")
{ node --test "$@" 2>&1; echo $? >"$rcfile"; } | tee "$out"
rc=$(cat "$rcfile" 2>/dev/null || echo 1)
rm -f "$rcfile"

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
