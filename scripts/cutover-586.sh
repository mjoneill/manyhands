#!/usr/bin/env bash
#
# #586 / #958 — REPOINT THE BOARD'S LAUNCHD JOBS AT THE READ-ONLY EXPORT,
#               AND BE ABLE TO PUT THEM BACK.
#
# ⛔ THIS SCRIPT DEFAULTS TO A SANDBOX. Nothing touches ~/Library/LaunchAgents
# without an explicit `--live`. That inversion is deliberate: the forward plan
# this belongs to was authorized, announced, and then FALSIFIED BY MEASUREMENT
# inside its own window, so the failure mode this file guards against is not
# "the operator was careless" — it is "the plan was wrong and ran anyway".
#
# ── WHY IT EXISTS ───────────────────────────────────────────────────────────
# #586 closes a real hazard: production is served from a git clone that anyone
# can mutate. The fix is to serve from `deploy.sh`'s read-only export instead.
# The agreed plan was "repoint seven jobs uniformly". That plan is WRONG:
#
#   * only FOUR of the seven jobs reference the tree at all
#   * one job needs TWO fields pointed at DIFFERENT trees
#   * `scripts/deploy.sh unlock` restores NOTHING that a rollback needs
#
# ── THE RULE, and it is per-FIELD, not per-job ──────────────────────────────
#   a field naming CODE TO RUN          → moves to the EXPORT
#   a field naming A REPO TO OPERATE ON → stays on the CLONE
#
# `suitewatch` needs both, in one plist. See the trap below.
#
# ── ⛔⛔⛔ THE TRAP ──────────────────────────────────────────────────────────
# `SUITE_WATCH_NO_CLONE=1` looks like it simplifies suitewatch. It INVERTS the
# entire point of #586. suite-watch.mjs:63 —
#
#     let suiteDir = REPO;
#     if (!NO_CLONE) { ...git clone --no-local...; suiteDir = clone/tree }
#
# ⇒ with NO_CLONE the suite runs INSIDE THE TARGET TREE, beside the running
#   server. That is the 2026-08-04 incident (a parallel-load flake reported as
#   the watch's first "red") and it is what CLAUDE.md forbids. It would also
#   simply fail: the export is read-only, so `npm ci` cannot write into it.
#   The flag's own comment names its real audience — "tests: fixture repos
#   aren't git". A flag for the suite's fixtures, not for production.
#
# ── ⚠️ EDITING A PLIST DOES NOT RELOAD IT ───────────────────────────────────
# launchd holds its own copy of a job's configuration. `launchctl kickstart -k`
# restarts the job but is NOT verified to re-read an edited file, so a rollback
# built on kickstart alone could restore the FILE while leaving the WRONG
# CONFIG RUNNING — restored on disk, unrestored in fact, and green either way.
# This script therefore always does bootout → bootstrap, which is correct
# whether or not kickstart would also have worked.
#
# ── USAGE ───────────────────────────────────────────────────────────────────
#   scripts/cutover-586.sh selftest              exercise rollback in a sandbox
#   scripts/cutover-586.sh baseline   [--live]   snapshot the 4 plists
#   scripts/cutover-586.sh verify clone|export [--live]
#   scripts/cutover-586.sh forward    --live     repoint (needs a backup first)
#   scripts/cutover-586.sh rollback <dir> --live restore from a snapshot
#   scripts/cutover-586.sh posttest              the two positive tests
#
set -euo pipefail

# ⛔⛔ NO DEFAULT PATHS. Twice over, and the second reason was measured.
#
# 1. The #561 publication gate refuses an operator's home layout in a public
#    repo. It refused `deploy.sh`'s first version for exactly this, and then
#    refused THIS FILE for the same thing after I copied that lesson into the
#    header above and gave two variables machine-specific defaults anyway.
#
# 2. THE EXPORT DID NOT EXIST when this was written (2026-08-20). `DEPLOY_SERVE`
#    was set nowhere, no serve directory was present, and `deploy.sh export` had
#    never run. The room spent a window debating WHICH FIELDS point at the export
#    without anyone checking that there WAS one. A plausible-looking default here
#    would have buried that; an unset sentinel fails loudly instead.
CLONE="${CUTOVER_CLONE:-<CUTOVER_CLONE-unset>}"
EXPORT_DIR="${CUTOVER_EXPORT:-<CUTOVER_EXPORT-unset>}"
BACKUP_ROOT="${CUTOVER_BACKUPS:-<CUTOVER_BACKUPS-unset>}"
LIVE_DIR="${CUTOVER_LAUNCHAGENTS:-$HOME/Library/LaunchAgents}"

JOBS=(com.scrumboard.rest com.scrumboard.mcp com.scrumboard.fanoutwatch com.scrumboard.suitewatch)
# ⛔ NEVER TOUCHED. Listed so "which three" is answered by the file, not by memory.
UNTOUCHED=(com.scrumboard.backup com.scrumboard.healthcheck com.scrumboard.dc-tripwire)

PB=/usr/libexec/PlistBuddy
say() { printf '%s\n' "$*"; }
die() { printf '⛔ %s\n' "$*" >&2; exit 1; }

# ── the per-FIELD map. This is the whole design, and it is data, not prose. ──
# Each row: <label> <PlistBuddy path> <clone value> <export value>
# A row whose clone and export values are IDENTICAL is a field that must NOT
# move — it is listed precisely so that "stays put" is asserted, not assumed.
field_rows() {
  cat <<ROWS
com.scrumboard.rest|:WorkingDirectory|$CLONE|$EXPORT_DIR
com.scrumboard.rest|:EnvironmentVariables:SCRUM_STATIC_DIR|$CLONE|$EXPORT_DIR
com.scrumboard.mcp|:WorkingDirectory|$CLONE|$EXPORT_DIR
com.scrumboard.fanoutwatch|:ProgramArguments:1|$CLONE/scripts/fanout-watch.mjs|$EXPORT_DIR/scripts/fanout-watch.mjs
com.scrumboard.suitewatch|:ProgramArguments:1|$CLONE/scripts/suite-watch.mjs|$EXPORT_DIR/scripts/suite-watch.mjs
com.scrumboard.suitewatch|:EnvironmentVariables:SUITE_WATCH_REPO|$CLONE|$CLONE
ROWS
}
# ⚠️ Note the last row: SUITE_WATCH_REPO is $CLONE in BOTH columns. That is the
# per-field rule made executable — `verify export` will FAIL if someone "helpfully"
# moves it, which is exactly the mistake the NO_CLONE trap invites.

# rest and mcp run RELATIVE ProgramArguments (`server.js`, `mcp-server.mjs`)
# resolved through WorkingDirectory. So for those two, WorkingDirectory is not
# merely a cwd — it selects THE CODE THAT RUNS. There is no separate script-path
# field to move, and that asymmetry with the two watchers is easy to misread.

need_dir() { [ -d "$1" ] || die "plist dir does not exist: $1"; }

resolve_dir() {  # --live → the real LaunchAgents dir; otherwise the sandbox
  if [ "${LIVE:-0}" = "1" ]; then say "$LIVE_DIR"; else say "${SANDBOX:?sandbox dir unset}"; fi
}

do_baseline() {
  local dir="$1" stamp out
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  out="$BACKUP_ROOT/$stamp"
  mkdir -p "$out"
  for j in "${JOBS[@]}"; do
    [ -f "$dir/$j.plist" ] || die "missing $j.plist in $dir"
    cp "$dir/$j.plist" "$out/$j.plist"
  done
  # A snapshot nobody can verify is a snapshot nobody should trust.
  ( cd "$out" && shasum -a 256 ./*.plist > SHA256SUMS )
  say "$out"
}

do_verify() {  # $1 = dir, $2 = clone|export ; exits 1 naming EVERY bad field
  local dir="$1" want="$2" bad=0 label path clone_v export_v expect actual
  while IFS='|' read -r label path clone_v export_v; do
    [ -n "$label" ] || continue
    [ "$want" = "clone" ] && expect="$clone_v" || expect="$export_v"
    actual="$($PB -c "Print $path" "$dir/$label.plist" 2>/dev/null || true)"
    if [ "$actual" != "$expect" ]; then
      printf '  ✗ %-28s %s\n      want: %s\n      got:  %s\n' "$label" "$path" "$expect" "${actual:-<missing>}"
      bad=1
    else
      printf '  ✓ %-28s %s\n' "$label" "$path"
    fi
  done < <(field_rows)
  # The three untouched jobs are asserted PRESENT, so "we didn't touch them"
  # is a checked claim rather than a hope.
  for j in "${UNTOUCHED[@]}"; do
    [ -f "$dir/$j.plist" ] || { printf '  ✗ %-28s MISSING — must never be touched\n' "$j"; bad=1; }
  done
  [ "$bad" = 0 ] || return 1
}

# ── #959 — THE FORWARD PATH. Same map, opposite column. ─────────────────────
# ⭐ It drives off `field_rows()`, exactly like `verify` and `rollback`. A second
# copy of the table would be a table that can disagree with itself, and the
# disagreement would surface as a half-cut-over machine.
do_apply() {  # $1 = dir, $2 = clone|export
  local dir="$1" want="$2" label path clone_v export_v val
  while IFS='|' read -r label path clone_v export_v; do
    [ -n "$label" ] || continue
    [ "$want" = "clone" ] && val="$clone_v" || val="$export_v"
    $PB -c "Set $path $val" "$dir/$label.plist" \
      || die "could not set $path in $label — STOP. The machine is now PARTIAL; roll back."
    printf '  → %-28s %s = %s\n' "$label" "$path" "$val"
  done < <(field_rows)
}

# ⛔⛔ THE PRECONDITIONS. Each one is a way this has already gone wrong, or a way
# it demonstrably could. None of them is satisfiable by a value this script
# supplies itself — a flag that defaults to "authorized" is a rail that
# authorizes itself, which is the failure it was written to prevent.
forward_preconditions() {
  # ⛔⛔ READ THIS BEFORE TRUSTING THE FLAG NAME. `--authorized-by` is an OPERATOR
  # ATTESTATION, not authenticated authorization. Any caller can type any name.
  # It does two real things — it prevents accidental invocation, and it records
  # the claim beside the change — and it CANNOT prove the window was granted.
  # Fresh authorization has to be established externally, through a channel that
  # can authenticate the person granting it.
  #
  # ⚠️ Named here because the flag reads like proof, and this file already
  # documents one flag whose helpful name concealed what it did (NO_CLONE).
  # A gate that is trusted for more than it delivers is worse than no gate.
  [ -n "${AUTH:-}" ] || die "forward requires --authorized-by \"<who authorized this, and for WHAT PLAN>\".

⛔ This is not a formality. On 2026-08-20 a cutover was authorized, announced,
and stopped inside its own window because measurement falsified the plan the
room had consented to. Consent granted for one plan must not be spent on a
different one, so the authorization is named at the point of use and appears
in the snapshot beside the change it permitted."

  case "$EXPORT_DIR" in *unset*) die "set CUTOVER_EXPORT to the export the jobs will run from";; esac
  [ -d "$EXPORT_DIR" ] || die "the export does not exist: $EXPORT_DIR
⇒ run \`deploy.sh export\` first. On 2026-08-20 DEPLOY_SERVE was set NOWHERE and
  no export had ever been created — the destination was never chosen."
  [ -r "$EXPORT_DIR/server.js" ] || die "no server.js under $EXPORT_DIR — that is not an export of this repo"

  # ⚠️ You may not move production away from a state you have not saved.
  [ -n "${BASELINE:-}" ] || die "forward requires --from-baseline <dir> — the snapshot \`baseline --live\` printed.
Without it there is nothing to roll back TO, and an unexercised rollback is a
rollback-shaped comment."
  [ -f "$BASELINE/SHA256SUMS" ] || die "no SHA256SUMS in $BASELINE — that is not a snapshot this script made"
  ( cd "$BASELINE" && shasum -a 256 -c SHA256SUMS >/dev/null ) || die "the baseline in $BASELINE is CORRUPT"
}

do_restore() {  # $1 = backup dir, $2 = target dir
  local from="$1" to="$2"
  [ -f "$from/SHA256SUMS" ] || die "no SHA256SUMS in $from — refusing to restore an unverified snapshot"
  ( cd "$from" && shasum -a 256 -c SHA256SUMS >/dev/null ) || die "snapshot in $from is CORRUPT — do not restore it"
  for j in "${JOBS[@]}"; do cp "$from/$j.plist" "$to/$j.plist"; done
}

reload_live() {  # bootout → bootstrap, per the note above. Never kickstart.
  local uid; uid="$(id -u)"
  for j in "${JOBS[@]}"; do
    launchctl bootout "gui/$uid/$j" 2>/dev/null || true
    launchctl bootstrap "gui/$uid" "$LIVE_DIR/$j.plist"
  done
  say "   reloaded ${#JOBS[@]} jobs; ${#UNTOUCHED[@]} untouched"
}

# ── SELFTEST — acceptance 4. A CONTROL THAT MUST FAIL BEFORE IT PASSES. ─────
# An untested rollback is a rollback-shaped comment. This builds a sandbox from
# the real plists, breaks it ON PURPOSE with the exact mistake the NO_CLONE trap
# invites, proves `verify` CATCHES it, rolls back, and proves byte-identity.
do_selftest() {
  case "$CLONE" in *unset*) die "set CUTOVER_CLONE to the git clone the jobs currently run from";; esac
  local bkp rc
  # ⚠️ NOT `local`: the EXIT trap fires after this function returns, and under
  # `set -u` a trap referencing an out-of-scope local aborts — turning a PASSED
  # selftest into exit 1. Caught by running it; the banner said PASSED and the
  # exit code said failed.
  SBX="$(mktemp -d "${TMPDIR:-/tmp}/cutover586-XXXX")"
  local sbx="$SBX"
  trap 'rm -rf "$SBX"' EXIT
  for j in "${JOBS[@]}" "${UNTOUCHED[@]}"; do cp "$LIVE_DIR/$j.plist" "$sbx/$j.plist"; done

  say "1. baseline (clone) must VERIFY"
  do_verify "$sbx" clone || die "the LIVE plists do not match the clone baseline — stop and investigate"

  say "2. snapshot"
  BACKUP_ROOT="$sbx/backups" bkp="$(BACKUP_ROOT="$sbx/backups" do_baseline "$sbx")"
  say "   → $bkp"

  say "3. BREAK IT — repoint SUITE_WATCH_REPO at the export (the NO_CLONE mistake)"
  $PB -c "Set :EnvironmentVariables:SUITE_WATCH_REPO $EXPORT_DIR" "$sbx/com.scrumboard.suitewatch.plist"

  say "4. verify MUST now FAIL, and must NAME that field  ← the control"
  set +e; do_verify "$sbx" clone >"$sbx/out.txt" 2>&1; rc=$?; set -e
  [ "$rc" -ne 0 ] || die "CONTROL FAILED — verify passed on a plist we deliberately broke. The checker is blind."
  grep -q "SUITE_WATCH_REPO" "$sbx/out.txt" || die "CONTROL FAILED — verify failed but did not name the broken field"
  say "   ✓ detected, and named the field"

  say "5. rollback"
  do_restore "$bkp" "$sbx"

  say "6. verify passes again AND the bytes are identical to the snapshot"
  do_verify "$sbx" clone >/dev/null || die "rollback did not restore a passing state"
  for j in "${JOBS[@]}"; do
    cmp -s "$bkp/$j.plist" "$sbx/$j.plist" || die "rollback restored $j but NOT byte-identically"
  done
  say "   ✓ all ${#JOBS[@]} byte-identical"

  # ── #959 — THE FORWARD PATH, exercised under the same discipline ──────────
  # ⭐ Two REFUSAL controls first. A gate that has never been observed refusing
  # is a gate nobody has evidence for, and both of these guard an irreversible
  # act on shared infrastructure.
  say ""
  say "7. build a stand-in export in the sandbox"
  local fake="$sbx/export"; mkdir -p "$fake/scripts"
  : > "$fake/server.js"; : > "$fake/scripts/suite-watch.mjs"; : > "$fake/scripts/fanout-watch.mjs"
  EXPORT_DIR="$fake"

  say "8. forward WITHOUT --authorized-by must REFUSE  ← control"
  set +e; ( AUTH=""; BASELINE="$bkp"; forward_preconditions ) >"$sbx/o1" 2>&1; rc=$?; set -e
  [ "$rc" -ne 0 ] || die "CONTROL FAILED — forward accepted an unauthorized run"
  grep -q "authorized-by" "$sbx/o1" || die "CONTROL FAILED — refused, but not for the authorization reason"
  say "   ✓ refused, and named what is missing"

  say "9. forward WITHOUT a baseline must REFUSE  ← control"
  set +e; ( AUTH="selftest"; BASELINE=""; forward_preconditions ) >"$sbx/o2" 2>&1; rc=$?; set -e
  [ "$rc" -ne 0 ] || die "CONTROL FAILED — forward accepted a run with nothing to roll back to"
  grep -q "from-baseline" "$sbx/o2" || die "CONTROL FAILED — refused for the wrong reason"
  say "   ✓ refused — you may not leave a state you have not saved"

  say "10. forward WITH both, then verify EXPORT"
  ( AUTH="selftest"; BASELINE="$bkp"; forward_preconditions )
  do_apply "$sbx" export >/dev/null
  do_verify "$sbx" export >/dev/null || die "forward ran but the fields do not match the export"
  say "   ✓ every field moved, and SUITE_WATCH_REPO stayed on the clone"

  say "11. and the round trip: rollback from the SAME snapshot"
  do_restore "$bkp" "$sbx"
  do_verify "$sbx" clone >/dev/null || die "rollback after a real forward did not restore"
  for j in "${JOBS[@]}"; do
    cmp -s "$bkp/$j.plist" "$sbx/$j.plist" || die "post-forward rollback restored $j but NOT byte-identically"
  done
  say "   ✓ byte-identical after a REAL cutover, not just after a broken field"

  say ""
  say "✅ SELFTEST PASSED — forward and rollback were both exercised, not asserted,"
  say "   and both refusal controls were observed refusing."
}

# ── the two positive tests. Both already exist; neither needed building. ────
# Each watcher is silent about FINDINGS and NOT silent about RUNNING. That is
# the distinction a pid check cannot make: a pid proves launchd thinks the job
# should exist; a fresh log line proves it RAN.
do_posttest() {
  # Paths are READ FROM THE PLISTS, never hardcoded — so this reports the log
  # the job actually writes rather than the one a reader assumed. #713 exists
  # because two seats mistook which state file was live.
  local fo_log fo_state sw_state
  fo_log="$($PB -c "Print :StandardOutPath" "$LIVE_DIR/com.scrumboard.fanoutwatch.plist" 2>/dev/null || true)"
  fo_state="$($PB -c "Print :EnvironmentVariables:SCRUM_FANOUT_STATE" "$LIVE_DIR/com.scrumboard.fanoutwatch.plist" 2>/dev/null || true)"
  sw_state="$($PB -c "Print :EnvironmentVariables:SUITE_WATCH_STATE" "$LIVE_DIR/com.scrumboard.suitewatch.plist" 2>/dev/null || true)"

  say "fanoutwatch — a timestamped heartbeat every 5 min, UNCONDITIONAL:"
  say "   log (from the plist): ${fo_log:-<unset>}"
  [ -n "$fo_log" ] && [ -f "$fo_log" ] && tail -2 "$fo_log" | sed 's/^/   /'
  say "   ⇒ after a cutover: wait ≤5 min, confirm a NEW timestamp appears."
  say "     Each tick also names its own state file (#713: ${fo_state:-<unset>}),"
  say "     so the line confirms the ENVIRONMENT as well as the run."
  say ""
  say "suitewatch — a full side-effect-free run of the POST-CUTOVER config:"
  say "   SUITE_WATCH_DRYRUN=1 SUITE_WATCH_REPO=\"\$CUTOVER_CLONE\" \\"
  say "     node \"\$CUTOVER_EXPORT/scripts/suite-watch.mjs\""
  say "   ⇒ its state file is written on EVERY run incl. the green/silent path:"
  say "     ${sw_state:-<unset>}"
  say "   ⚠️ Run the EXPORT's copy with the EXPORT's env. A hand-reconstructed"
  say "      approximation tests a configuration that will not exist."
  say ""
  say "⭐ Both watchers are silent about FINDINGS and NOT silent about RUNNING."
  say "   A fresh log line proves the job RAN; a pid only proves launchd thinks"
  say "   it should exist — and both of these jobs are normally pidless."
}

CMD="${1:-selftest}"; shift || true
LIVE=0; AUTH=""; BASELINE=""
POS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --live)           LIVE=1 ;;
    --authorized-by)  AUTH="${2:-}"; shift ;;
    --from-baseline)  BASELINE="${2:-}"; shift ;;
    *)                POS+=("$1") ;;
  esac
  shift
done
set -- "${POS[@]:-}"

case "$CMD" in
  selftest) do_selftest ;;
  posttest) do_posttest ;;
  baseline)
    [ "$LIVE" = 1 ] || die "baseline needs --live (there is nothing to snapshot in a sandbox)"
    need_dir "$LIVE_DIR"; say "📦 $(do_baseline "$LIVE_DIR")" ;;
  verify)
    want="${1:-clone}"
    [ "$want" = clone ] || [ "$want" = export ] || die "verify takes clone|export"
    [ "$LIVE" = 1 ] || die "verify needs --live, or use selftest"
    do_verify "$LIVE_DIR" "$want" && say "✅ all fields match: $want" ;;
  forward)
    # ⚠️ #959, conceding a review: an earlier version of this file REFUSED to
    # implement forward at all, reasoning that a path which could run the cutover
    # could launder a stale authorization. That conflated "must not run without
    # fresh consent" with "must not exist" — only the first is a safety property,
    # and the omission was not safer, merely untestable. Worse, it pushed writing
    # the risky half into a live window under time pressure, which is the exact
    # condition the rollback card existed to avoid.
    [ "$LIVE" = 1 ] || die "forward needs --live"
    forward_preconditions
    say "⇢ cutover authorized by: $AUTH"
    say "   baseline: $BASELINE"
    do_apply "$LIVE_DIR" export
    reload_live
    do_verify "$LIVE_DIR" export || die "the fields did not land — ROLL BACK NOW:
    scripts/cutover-586.sh rollback $BASELINE --live"
    say "✅ cut over, and verified."
    say ""
    say "⛔ NOT DONE YET — a plist that loaded is not a job that WORKS:"
    say "   scripts/cutover-586.sh posttest      ⇒ then wait ≤5 min for a NEW"
    say "                                          fanoutwatch heartbeat line"
    say "   rollback:  scripts/cutover-586.sh rollback $BASELINE --live" ;;
  rollback)
    from="${1:-}"
    [ -n "$from" ] || die "rollback needs the snapshot dir printed by \`baseline\`"
    [ "$LIVE" = 1 ] || die "rollback needs --live"
    do_restore "$from" "$LIVE_DIR"
    reload_live
    do_verify "$LIVE_DIR" clone && say "✅ rolled back to the clone, and verified" ;;
  *) die "unknown: $CMD — try selftest" ;;
esac
