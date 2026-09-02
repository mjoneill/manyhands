#!/bin/sh
# #877 — the ONE way to make, list and retire a build worktree.
#
# Every seat builds in her own worktree; the shared dev checkout stays on main
# and refuses seat commits (.githooks/pre-commit). Worktrees live in exactly
# one place, BESIDE the repo and named for it, so no tree-walker inside the
# repo ever sees them and nobody has to remember where to look:
#
#     ~/PublicProjects/manyhands.worktrees/<card>-<slug>/
#
# `list` answers "what is this directory and what is it for" from git and the
# board — card, title, holder, branch, age, dirty — never from memory. A
# worktree whose card has no claim is either abandoned or undeclared, and the
# deploy script flags it daily (scripts/deploy.sh, #877).
#
#   scripts/worktree.sh new  <card> [slug]   create <home>/<card>-<slug> on branch card/<card>-<slug>
#   scripts/worktree.sh done <card>          remove it and prune the registry (refuses if dirty)
#   scripts/worktree.sh adopt <path> <card> [slug]   move a worktree from OUTSIDE the home into it, re-linking node_modules
#   scripts/worktree.sh list                 every worktree on this machine, explained
#   scripts/worktree.sh home                 print the home directory
set -eu
REPO=$(cd "$(dirname "$0")/.." && git rev-parse --path-format=absolute --git-common-dir | sed 's|/\.git$||')
HOME_DIR="${MANYHANDS_WORKTREES:-$(dirname "$REPO")/$(basename "$REPO").worktrees}"
BOARD="${SCRUM_BOARD_URL:-http://localhost:3141}"
say() { printf '%s\n' "$*"; }
die() { printf '⛔ %s\n' "$*" >&2; exit 1; }

card_line() {   # <shortId> → "title · column · holder" from the board; says so when it cannot
  json=$(curl -fsS --max-time 3 "$BOARD/api/cards/$1" 2>/dev/null) || { echo "(board unreachable)"; return 0; }
  printf '%s' "$json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const c=JSON.parse(s);console.log(`${(c.title||"").slice(0,60)} · ${c.column||"?"} · ${c.claimedBy?("held by "+c.claimedBy):"UNCLAIMED"}`)}catch{console.log("(no such card)")}})'
}

case "${1:-}" in
  home) say "$HOME_DIR" ;;
  new)
    card="${2:-}"; [ -n "$card" ] || die "usage: worktree.sh new <card> [slug]"
    case "$card" in ''|*[!0-9]*) die "card must be a number: got '$card'" ;; esac
    slug="${3:-work}"; slug=$(printf '%s' "$slug" | tr -c 'A-Za-z0-9-\n' '-' | tr -s '-' | sed 's/^-//;s/-$//')
    name="$card-$slug"; dest="$HOME_DIR/$name"; branch="card/$name"
    [ ! -e "$dest" ] || die "$dest already exists — 'worktree.sh list' to see it, 'worktree.sh done $card' to retire it"
    mkdir -p "$HOME_DIR"
    if git -C "$REPO" show-ref --verify --quiet "refs/heads/$branch"; then
      git -C "$REPO" worktree add "$dest" "$branch"
    else
      git -C "$REPO" worktree add -b "$branch" "$dest" main
    fi
    [ -d "$REPO/node_modules" ] && ln -s "$REPO/node_modules" "$dest/node_modules"
    say "✓ $dest  on $branch  (from main @ $(git -C "$REPO" rev-parse --short main))"
    say "  card: $(card_line "$card")"
    # The push gate clones by BRANCH NAME to build its snapshot, so `HEAD:main`
    # is refused with "Remote branch HEAD not found" — name the branch.
    say "  build here; push with: git -C $dest push origin $branch:main   (after CI, through the gate)"
    say "  retire with: scripts/worktree.sh done $card" ;;
  done)
    card="${2:-}"; [ -n "$card" ] || die "usage: worktree.sh done <card>"
    found=""
    for d in "$HOME_DIR"/"$card"-*; do [ -d "$d" ] && found="$d" && break; done
    [ -n "$found" ] || die "no worktree for card $card under $HOME_DIR"
    dirty=$(git -C "$found" status --porcelain 2>/dev/null | grep -v '^?? node_modules' || true)
    if [ -n "$dirty" ]; then
      say "⛔ $found has uncommitted work — not removing:"; printf '%s\n' "$dirty" | sed 's/^/     /'
      say "   commit it, or save it: git -C $found diff > ~/wip-$card-$(date -u +%Y%m%dT%H%M%SZ).patch"; exit 1
    fi
    rm -f "$found/node_modules"
    git -C "$REPO" worktree remove "$found"
    git -C "$REPO" worktree prune
    say "✓ removed $found (branch kept: $(git -C "$REPO" branch --list "card/$card-*" | tr -d ' *'))" ;;
  adopt)
    src="${2:-}"; card="${3:-}"; [ -n "$src" ] && [ -n "$card" ] || die "usage: worktree.sh adopt <path> <card> [slug]"
    case "$card" in ''|*[!0-9]*) die "card must be a number: got '$card'" ;; esac
    src=$(cd "$src" 2>/dev/null && pwd -P) || die "no such directory: $2"
    git -C "$REPO" worktree list --porcelain | grep -qx "worktree $src" || die "$src is not a registered worktree of $REPO"
    slug="${4:-work}"; slug=$(printf '%s' "$slug" | tr -c 'A-Za-z0-9-\n' '-' | tr -s '-' | sed 's/^-//;s/-$//')
    dest="$HOME_DIR/$card-$slug"
    [ ! -e "$dest" ] || die "$dest already exists"
    mkdir -p "$HOME_DIR"
    # A RELATIVE node_modules link breaks the moment the tree changes depth
    # (../manyhands/node_modules resolved at sibling depth, not one level down);
    # the symptom is a suite that ERRORS on every import and reads as failing.
    # Drop it before the move and re-link absolute after.
    [ -L "$src/node_modules" ] && rm -f "$src/node_modules"
    git -C "$REPO" worktree move "$src" "$dest"
    [ -d "$REPO/node_modules" ] && ln -s "$REPO/node_modules" "$dest/node_modules"
    say "✓ moved $src → $dest  [$(git -C "$dest" branch --show-current)]"
    say "  node_modules → $(readlink "$dest/node_modules")" ;;
  list)
    now=$(date +%s)
    git -C "$REPO" worktree list --porcelain | awk '/^worktree /{print substr($0,10)}' | while read -r wt; do
      [ "$wt" = "$REPO" ] && { say "PRIMARY  $wt  [$(git -C "$wt" branch --show-current)]  (the shared dev checkout — seats do not commit here)"; continue; }
      br=$(git -C "$wt" branch --show-current 2>/dev/null || echo '(detached)')
      card=$(printf '%s' "$br" | sed -n 's|^card/\([0-9][0-9]*\)-.*|\1|p')
      age=$(( (now - $(stat -f %m "$wt" 2>/dev/null || echo "$now")) / 86400 ))
      dirty=$(git -C "$wt" status --porcelain 2>/dev/null | grep -vc '^?? node_modules' || true)
      case "$wt" in "$HOME_DIR"/*) where="home" ;; *) where="⚠️ OUTSIDE HOME" ;; esac
      # -e follows the link: a dangling symlink (or no node_modules at all) means
      # every import errors and the suite reads as FAILING for a reason that has
      # nothing to do with the code.
      nm=""; [ -e "$wt/node_modules" ] || nm="  ⚠️ node_modules does not resolve (suite would ERROR, not fail)"
      info=$([ -n "$card" ] && card_line "$card" || echo "⚠️ NO CARD in branch name")
      say "$where  $wt  [$br]  ${age}d  dirty:$dirty  #$card $info$nm"
    done ;;
  *) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
