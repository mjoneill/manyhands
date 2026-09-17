#!/bin/sh
# #1399 — the OPERATION LOCK lives in a FILE beside the board, not on the REST
# it guards.
#
# On 2026-09-15 REST was wedged for 2h40m. Two operators restarted it 28 minutes
# apart without seeing each other: the lock was a card claim (#1282) on the
# server that was down, and the commons — where intent would have been posted —
# was on the same server. And deploy.sh never read the claim in any case.
# This file is the FIRST check in the path, and it works when nothing else does.
#
# Usage:
#   scripts/operation-lock.sh acquire <op> <holder> [note]   exit 0 = yours; 1 = held (says by whom)
#   scripts/operation-lock.sh release <op> <holder>          only the holder; absent lock = no-op
#   scripts/operation-lock.sh status                         prints the holder, or "free"
#
# Where: $DEPLOY_LOCK, or $(dirname "$DEPLOY_SHA_STAMP")/operation-lock.json —
# the stamp is already required by every documented deploy invocation, so the
# lock rides beside the board with zero new configuration. No path → UNAVAILABLE,
# said out loud and exit 1: fail-open is not fail-invisible.
#
# Atomic: `set -C` (noclobber) makes the `>` redirect an O_EXCL create — one
# syscall, no read-then-write window. Two acquires in the same instant get one
# winner and one "held by".
#
# Stale (> STALE_MIN, default 30): REPORTED with holder + note, NEVER overridden.
# A stale lock is a human's decision to clear — the note is the intent they
# could not post — and the refusal prints the exact release command.
#
# ⚠️ Before any restart by hand (launchctl kickstart …): run `status` first.
set -u

STALE_MIN="${OPERATION_LOCK_STALE_MIN:-30}"
LOCK="${DEPLOY_LOCK:-}"
if [ -z "$LOCK" ] && [ -n "${DEPLOY_SHA_STAMP:-}" ]; then
  LOCK="$(dirname "$DEPLOY_SHA_STAMP")/operation-lock.json"
fi
[ -n "$LOCK" ] || { printf '⛔ operation lock UNAVAILABLE: set DEPLOY_LOCK, or DEPLOY_SHA_STAMP (the lock lives beside the stamp)\n' >&2; exit 1; }

now_utc() { date -u +%Y-%m-%dT%H:%M:%SZ; }
# JSON field readers — one-line JSON written by this script; no jq at runtime.
field() { sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p" "$LOCK" 2>/dev/null | head -n 1; }
epoch_of() {  # ISO-8601 Z → epoch; macOS date and GNU date spell this differently
  date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$1" +%s 2>/dev/null || date -u -d "$1" +%s 2>/dev/null || echo 0
}
esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

describe() {  # prints "holder · op · note · age" for the current file
  h="$(field holder)"; o="$(field op)"; n="$(field note)"; at="$(field claimedAt)"
  age=$(( $(date -u +%s) - $(epoch_of "$at") ))
  mins=$(( age / 60 ))
  stale=""; [ "$mins" -ge "$STALE_MIN" ] && stale=" ⚠️ STALE (> ${STALE_MIN} min; a human clears it: $0 release $o $h)"
  printf '%s held by %s since %s (%s min ago) — note: %s%s\n' "$o" "$h" "$at" "$mins" "$n" "$stale"
}

cmd="${1:-status}"
case "$cmd" in
  acquire)
    op="${2:-}"; holder="${3:-}"; note="${4:-}"
    [ -n "$op" ] && [ -n "$holder" ] || { printf 'usage: %s acquire <op> <holder> [note]\n' "$0" >&2; exit 2; }
    body="$(printf '{"holder":"%s","op":"%s","note":"%s","claimedAt":"%s","pid":%s}' \
      "$(esc "$holder")" "$(esc "$op")" "$(esc "$note")" "$(now_utc)" "$$")"
    if ( set -C; printf '%s\n' "$body" > "$LOCK" ) 2>/dev/null; then
      printf '🔒 operation lock: %s held by %s — %s\n' "$op" "$holder" "$LOCK"
      exit 0
    fi
    printf '⛔ operation lock HELD — %s\n   file: %s\n   Not overriding. If the holder is gone, a human releases it by name (command above).\n' "$(describe)" "$LOCK" >&2
    exit 1 ;;
  release)
    op="${2:-}"; holder="${3:-}"
    [ -n "$op" ] && [ -n "$holder" ] || { printf 'usage: %s release <op> <holder>\n' "$0" >&2; exit 2; }
    [ -f "$LOCK" ] || exit 0                       # nothing held — every exit path may call this
    h="$(field holder)"
    if [ "$h" != "$holder" ]; then
      printf '⛔ operation lock is not yours to release — %s\n' "$(describe)" >&2; exit 1
    fi
    rm -f "$LOCK"; printf '🔓 operation lock released: %s by %s\n' "$op" "$holder"; exit 0 ;;
  status)
    if [ -f "$LOCK" ]; then printf '🔒 %s\n   file: %s\n' "$(describe)" "$LOCK"; else printf '🔓 operation lock free — %s\n' "$LOCK"; fi
    exit 0 ;;
  *) printf 'unknown command: %s (acquire|release|status)\n' "$cmd" >&2; exit 2 ;;
esac
