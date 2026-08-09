#!/bin/sh
# #751 phase 2 — THE SEAT LIST, named once and consulted by both rails.
#
# Two detectors enforce agent identity and they must agree on what a seat IS:
#
#   .githooks/pre-commit   the ENV marker — refuses an agent session committing
#                          under the tree's human fallback config.
#   .githooks/commit-msg   the ARTIFACT — refuses an author/trailer disagreement,
#                          for the seat whose runtime carries no env marker at
#                          all and cannot introspect its own environment.
#
# ⚠️ THEY WERE KEYED TO DIFFERENT THINGS AND ONE HAD GONE INERT. commit-msg
# matched a retired domain in the TRAILER rather than asking whether the AUTHOR
# is a seat, so a human-authored commit carrying `Co-Authored-By: <Seat>
# <noreply@anthropic.com>` — the trailer style actually in use — passed straight
# through the case that rail exists to catch. Measured 2026-08-09 by driving the
# hook directly, and true for as long as those trailers have been in use. A green
# suite reported the guard healthy the whole time.
#
# ⇒ One list, one predicate, both hooks. Two rails that CAN disagree about what a
#   seat is eventually do, and the disagreement is invisible from either side.
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

# Does file "$1" carry a Co-Authored-By trailer naming one of our seats?
# By NAME, so it holds for every address a seat has ever signed with — the old
# per-seat addresses, the shared noreply, and the current tagged ones. Keying on
# an ADDRESS is what let this detector go quiet when the address style changed.
trailer_names_a_seat() {
  IFS='
'
  for _seat in $SEAT_IDENTS; do
    _name=${_seat%% <*}
    if grep -qi "^Co-Authored-By:[[:space:]]*${_name}[[:space:]]*<" "$1"; then
      unset IFS
      return 0
    fi
  done
  unset IFS
  return 1
}
