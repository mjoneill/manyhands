#!/bin/sh
# #751 phase 2 — THE SEAT LIST, named once.
#
# ONE detector enforces agent identity: `.githooks/pre-commit`, keyed on the
# env marker, refusing an agent session that commits under the tree's human
# fallback config. A second detector existed and was retired the same day — the
# tombstone below says why, and it is worth reading before anyone adds another.
#
# The list lives here rather than inside the hook so that any future rail
# consults the same definition. Two rails that CAN disagree about what a seat
# is eventually do, and the disagreement is invisible from either side: the one
# retired below had been keyed to a retired domain and was inert for months
# while a green suite reported it healthy.
#
# ⚠️ SHAPES, NOT ADDRESSES. The verified seat addresses are tagged variants of a
# real person's address; writing them into tracked public content is what the
# export gate exists to prevent. The shape carries what these rails need — is
# this a seat, or a fallback to the human? — and publishes no identity.
#
#   these hooks (public)     the identity is SEAT-SHAPED
#   the push gate (private)  the exact (name, verified address) PAIR
#
# A new seat is REFUSED until someone adds it here deliberately. That is the
# correct failure — visible, at commit time, naming its own fix — and it is the
# only moment anyone is made to look at how long this list has become.
SEAT_IDENTS='Wren <*+wren@gmail.com>
Indigo <*+indigo@gmail.com>
Minnie <*+minnie@gmail.com>'

# Is "$1" (a `Name <address>` string) one of the seats?
# Whole (name, address) PAIRS: one seat's name against another's address is a
# crossed identity — every part legitimate, the combination not — and is refused.
seat_ident_matches() {
  _who=$1
  _ok=1
  IFS='
'
  for _seat in $SEAT_IDENTS; do
    # Glob match; entries without a wildcard compare exactly.
    case "$_who" in $_seat) _ok=0 ;; esac
  done
  unset IFS
  return $_ok
}

# `git var` renders "Name <addr> <unixtime> <tz>". Strip ONLY the trailing
# metadata. Anchored on purpose: `s/> .*/>/` also works, but only because git
# guarantees an ident holds exactly one <...> group — a fact in git's source
# rather than in the line you are reading.
seat_ident_of() {
  printf '%s' "$1" | sed 's/ [0-9][0-9]* [-+][0-9][0-9]*$//'
}

# ⚰️ RETIRED 2026-08-09 — `.githooks/commit-msg`, the ARTIFACT detector.
#
# It refused "author is not a seat, but the message carries a seat trailer."
# Written for the seat whose runtime carries no env marker, so pre-commit skips
# it entirely. Retired for two measured reasons, and a future implementer should
# read both before rebuilding it here:
#
#   1. ITS INPUT IS AMBIGUOUS. `human author + seat trailer` is BOTH the defect
#      (a seat falling back to the human identity) AND correct use (the owner
#      committing his own work and crediting a seat). Three such commits exist
#      in this history and all three are legitimate. No parsing distinguishes
#      them without an external agent signal — so the rail refused the repo
#      owner in his own repo, which pre-commit prevents by construction and
#      this detector never could.
#
#   2. ITS TRIGGER IS VOLUNTARY AND UNSPECIFIED. Trailer emission measured at
#      6% for one seat and 88% for another, and it had never been specified for
#      the third at all. A rail whose trigger is improvised is not a protocol.
#
# ⚠️ It never covered the markerless seat it was written for. Retiring it
# removes a FALSE CLAIM of coverage, not coverage — that gap is carded and open,
# and nobody should describe all seats as guarded.
#
# ⚠️ It never inspected message CONTENT. Content is the #561 pre-push gate's
# job, which is untouched — that is the rail that caught a model name in six
# trailers when four diff sweeps missed it, because a trailer is not in a diff.
