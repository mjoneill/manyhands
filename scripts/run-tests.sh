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

out=$(mktemp "${TMPDIR:-/tmp}/run-tests.XXXXXX")
node --test "$@" >"$out" 2>&1
rc=$?

echo "── $scope ──"
grep -E "^(not ok|# (tests|pass|fail|cancelled))" "$out" | tail -20
if [ "$rc" -ne 0 ]; then
  echo "── FAILURES ──"
  grep -B1 -A12 "^not ok" "$out" | head -80
fi
rm -f "$out"

if [ "$#" -ne "$total" ] && [ "$rc" -eq 0 ]; then
  echo "── subset green ≠ suite green: run with no args before reporting green ──"
fi
exit $rc
