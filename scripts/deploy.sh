#!/bin/sh
# #586 — THE DEPLOY PATH. The served directory is not a git repository, and this
# script is the only thing that writes to it.
#
# ⛔ THE DEFECT. The live board serves out of an ordinary writable git clone, so
# BOTH of these are deploys and neither announces itself:
#
#     git checkout   in the served tree   → IS the deploy, one restart later
#     editing a file in the served tree   → IS the deploy, with NO git event at
#                                            all: no reflog, no ref change,
#                                            nothing any instrument can see
#
# Measured 2026-08-19: a seat built a feature by editing the served tree; the
# restart that loaded it stranded six sessions; two other seats' finished work
# sat undeployable for an hour because the tree was dirty; and a `git pull
# --ff-only` was one keystroke from destroying 59 uncommitted lines, stopped by
# the dirty tree rather than by anyone's judgement.
#
# ── ⛔ WHY NOT JUST LOCK THE CLONE READ-ONLY ─────────────────────────────────
#
# Tried first, because it needs no launchd change and reverts in one command.
# REFUTED in a sandbox, and it is worse than doing nothing:
#
#     git does not write through a file handle. It UNLINKS the old file and
#     creates a new one — which needs write on the DIRECTORY, not the file. So
#     locking files is transparent to `git checkout`. Locking directories too:
#
#         error: unable to unlink old 'server.js': Permission denied
#         HEAD is now at 53988d4      ← HEAD MOVED ANYWAY
#         EXIT=0                      ← AND IT REPORTED SUCCESS
#
# ⇒ The lock turns a COHERENT deploy into an INCOHERENT one: HEAD says one
# commit, the files are a mixture of two, and every script that checks an exit
# code believes it worked.
#
# ⇒ ***A SERVED DIRECTORY THAT IS A GIT REPOSITORY CAN ALWAYS BE CHECKED OUT.***
# The only question is whether the result is consistent. So the serve directory
# is not one: `git archive` into a plain directory. `git checkout` there fails
# with "not a git repository" — a refusal that NAMES the problem for free.
#
# Usage:
#   scripts/deploy.sh                pull, re-export, restart, verify
#   scripts/deploy.sh --no-restart   pull + re-export only
#   scripts/deploy.sh export         re-export from the current clone HEAD
#   scripts/deploy.sh unlock         open the serve dir — the escape hatch
#   scripts/deploy.sh status         report without changing anything
set -eu

# ⚠️ NO DEFAULT PATHS, and that is deliberate twice over. The publication gate
# refused the first version for carrying an operator's home layout into a public
# repo — correctly. And a deploy script that knows one machine's directories is
# a deploy script that silently targets the wrong tree on any other.
#
#   DEPLOY_CLONE=/path/to/clone  DEPLOY_SERVE=/path/to/serve  scripts/deploy.sh
CLONE="${DEPLOY_CLONE:-}"
SERVE="${DEPLOY_SERVE:-}"
RESTART="${DEPLOY_RESTART:-1}"

die() { printf '⛔ %s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }

[ -n "$CLONE" ] || die "set DEPLOY_CLONE to the git clone this deploys FROM"
[ -n "$SERVE" ] || die "set DEPLOY_SERVE to the directory the services run FROM"
[ "$CLONE" = "$SERVE" ] && die "DEPLOY_CLONE and DEPLOY_SERVE must differ — the whole point is that the served directory is not a clone"
[ -d "$CLONE/.git" ] || die "not a git clone: $CLONE"

lock()   { [ -d "$SERVE" ] && chmod -R a-w "$SERVE" 2>/dev/null || true; }
unlock() { [ -d "$SERVE" ] && chmod -R u+w "$SERVE" 2>/dev/null || true; }

# ⚠️ EXPORT IS ATOMIC-BY-RENAME, and that is acceptance 5. Writing into the live
# directory means a failed export leaves production half-updated — the exact
# incoherent state that refuted the read-only approach. Build beside it, then
# swap in one syscall.
export_tree() {
  sha="$(git -C "$CLONE" rev-parse HEAD)"
  staging="${SERVE}.staging.$$"
  previous="${SERVE}.previous"
  rm -rf "$staging"
  mkdir -p "$staging"
  git -C "$CLONE" archive --format=tar HEAD | tar -x -C "$staging" \
    || { rm -rf "$staging"; die "export failed — production untouched"; }
  printf '%s\n' "$sha" > "$staging/DEPLOYED-SHA"
  write_marker "$staging"

  # ⛔ `git archive` EXPORTS TRACKED FILES ONLY, so the export has no
  # node_modules and does not run. Found in the sandbox: mcp-server.mjs imports
  # @modelcontextprotocol/sdk and zod, and both live there.
  #
  # ⇒ SYMLINK rather than copy: 212 packages, and they are the same bytes the
  # clone already validated. A copy would double the disk and make every deploy
  # slower for nothing.
  #
  # ⚠️ `chmod -R` does NOT follow symlinks on macOS, so the lock below stops at
  # the link and never recurses into the shared tree — which is what we want:
  # locking node_modules would break the next `npm ci` in the clone.
  [ -d "$CLONE/node_modules" ] || die "clone has no node_modules — run npm ci in $CLONE first"
  ln -s "$CLONE/node_modules" "$staging/node_modules"

  if [ -d "$SERVE" ]; then
    chmod -R u+w "$SERVE" 2>/dev/null || true
    rm -rf "$previous"
    mv "$SERVE" "$previous"
  fi
  mv "$staging" "$SERVE"
  chmod -R a-w "$SERVE" 2>/dev/null || true
  say "   exported $(printf '%s' "$sha" | cut -c1-7) → $SERVE"
}

# ⇒ ACCEPTANCE 2: the refusal must NAME where the edit should go. A permission
# error carries no message, so the signpost sits where anyone who just got EACCES
# looks next — the top of an `ls`. Deliberately not dot-prefixed.
write_marker() {
  cat > "$1/DO-NOT-EDIT-HERE.md" <<'MD'
# ⛔ THIS IS PRODUCTION, AND IT IS NOT A GIT REPOSITORY.

You are in the directory the live board **serves from**. It is a plain export,
locked read-only. If you got "Permission denied" or "not a git repository",
the rail is working (#586).

## Where the edit goes

    the DEV clone                  ← edit HERE. Commit, push.

## How to deploy

    scripts/deploy.sh              pulls into the clone, re-exports here,
                                   restarts, and verifies at the RUNNING service

## Why this is not a clone

Editing a file in a served tree IS a deploy — it takes effect on the next
restart and produces no git event at all. And a served tree that IS a git repo
can always be checked out; making it read-only does not prevent that, it only
makes the result INCONSISTENT (HEAD moves, files partly change, git exits 0).
Measured 2026-08-19. So there is no git here to check out.

## Escape hatch

    scripts/deploy.sh unlock       one command, not hidden. Use it if this rail
                                   is ever in your way.
MD
}

case "${1:-deploy}" in
  status)
    if [ -d "$SERVE" ]; then
      say "serve   $SERVE"
      say "  sha     $(cat "$SERVE/DEPLOYED-SHA" 2>/dev/null || echo '(none)')"
      say "  git?    $([ -d "$SERVE/.git" ] && echo '⛔ IS a git repo' || echo '✅ not a git repo')"
      say "  locked? $([ -w "$SERVE/DO-NOT-EDIT-HERE.md" ] && echo 'UNLOCKED' || echo 'LOCKED')"
    else say "serve   $SERVE  (does not exist yet)"; fi
    say "clone   $CLONE @ $(git -C "$CLONE" rev-parse --short HEAD)"
    exit 0 ;;
  unlock)
    unlock; say "🔓 UNLOCKED $SERVE"; say "   re-lock with: scripts/deploy.sh export"; exit 0 ;;
  export)
    export_tree; exit 0 ;;
  --no-restart) RESTART=0 ;;
  deploy) : ;;
  *) die "unknown command: $1" ;;
esac

# ⚠️ REFUSE TO PULL OVER SOMEONE'S UNCOMMITTED WORK. The clone is writable by
# design now, so this is where the 2026-08-19 near-loss would be caught: 59
# uncommitted lines, and a --ff-only pull one keystroke away. git would have
# refused only by luck of the overlap; a pull touching different files would have
# succeeded and left the edit stranded and invisible.
dirty="$(git -C "$CLONE" status --porcelain || true)"
if [ -n "$dirty" ]; then
  say ""
  say "⛔ the clone has uncommitted changes. NOT pulling over them:"
  printf '%s\n' "$dirty" | sed 's/^/     /'
  say ""
  say "   Save it before it can be lost:"
  say "     git -C $CLONE diff > ~/prod-wip-\$(date -u +%Y%m%dT%H%M%SZ).patch"
  say "   Then decide with its author whether it is committed or dropped."
  exit 1
fi

say "⇣ pulling main into the clone"
git -C "$CLONE" pull --ff-only origin main
say "   clone now at $(git -C "$CLONE" rev-parse --short HEAD)"

say "⇢ exporting to the serve directory"
export_tree

[ "$RESTART" = "0" ] && exit 0

say "↻ restarting services"
uid="$(id -u)"
launchctl kickstart -k "gui/$uid/com.scrumboard.rest" || die "rest restart failed"
launchctl kickstart -k "gui/$uid/com.scrumboard.mcp"  || die "mcp restart failed"

# ⇒ ACCEPTANCE 4: verified AT THE RUNNING SERVICE, not at the tree. A deploy is
# not a pull — this room has twice reported a deploy done while the process was
# still running the previous code.
say "✓ verifying at the running service"
i=0
until curl -fsS --max-time 3 http://127.0.0.1:3001/health >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -gt 40 ] && die "mcp did not return within 80s"; sleep 2
done
curl -fsS --max-time 8 http://127.0.0.1:3141/api/board >/dev/null || die "rest did not return"
say "   mcp 200 · rest 200 · serving $(cat "$SERVE/DEPLOYED-SHA" | cut -c1-7)"
