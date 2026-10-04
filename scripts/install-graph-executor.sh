#!/bin/sh
# #1559 — the graph executor under launchd, and its supervisor tick.
#
# DEFAULT IS A DRY RUN: the plist is rendered to stdout (or to --out FILE) and
# nothing on this machine changes. Only an explicit --install writes to
# ~/Library/LaunchAgents and bootstraps the job; that is a DEPLOY, and the
# human owner should be present for it.
#
#   sh scripts/install-graph-executor.sh --store DIR --port N --dataset-id ID [--log FILE]
#        [--job executor|healthcheck] [--code DIR] [--python PY] [--checkpoint-dir DIR]
#        [--label LABEL] [--health-interval SEC] [--min-restart-sec SEC]
#        [--out FILE | --install]
#
# --job executor (default): KeepAlive true, so launchd restarts a process that
#   dies, including one whose startup self-check REFUSES a store that cannot flush
#   (that shows as a crash loop, throttled by launchd, never a quiet broken service).
#   ⛔ No --exit-on-stdin-eof: under launchd stdin is /dev/null, which is EOF at
#   once, so the executor would exit on start and loop forever. No --create: the
#   dataset marker is written once, by hand, never by a supervisor.
# --job healthcheck: scripts/graph-executor-healthcheck.mjs every --health-interval
#   seconds; it restarts a DEGRADED (latched) executor with
#   `launchctl kickstart -k gui/<uid>/<executor label>`, at most once per
#   --min-restart-sec, and leaves a dead one to KeepAlive.
#
# No secret is ever rendered: the executor binds 127.0.0.1 and needs none.
# An install backs up an existing plist first (a reinstall from a template has
# overwritten hand patches before — #1230).
set -eu

CODE=$(cd "$(dirname "$0")/.." && pwd -P)
JOB=executor; STORE=''; PORT=''; DATASET=''; REQLOG=''; PY=''; CKPT=''; LABEL=''
HEALTH_INTERVAL=60; MIN_RESTART=600; OUT=''; INSTALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --job) JOB="$2"; shift 2 ;;
    --store) STORE="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --dataset-id) DATASET="$2"; shift 2 ;;
    --log) REQLOG="$2"; shift 2 ;;
    --code) CODE="$2"; shift 2 ;;
    --python) PY="$2"; shift 2 ;;
    --checkpoint-dir) CKPT="$2"; shift 2 ;;
    --label) LABEL="$2"; shift 2 ;;
    --health-interval) HEALTH_INTERVAL="$2"; shift 2 ;;
    --min-restart-sec) MIN_RESTART="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --install) INSTALL=1; shift ;;
    --print) shift ;;   # the default, accepted for explicitness
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

die() { echo "$1" >&2; exit 2; }
abs() { case "$1" in /*) ;; *) die "$2 must be an absolute path: $1" ;; esac; }
# Values land inside XML <string>s; refuse what would need escaping instead of escaping it.
plain() { case "$1" in *[!A-Za-z0-9._/@:+-]*|'') die "$2 has characters this renderer will not put in a plist: '$1'" ;; esac; }

[ -n "$STORE" ] || die "--store DIR is required"
[ -n "$PORT" ] || die "--port N is required"
[ -n "$DATASET" ] || die "--dataset-id ID is required"
case "$PORT" in *[!0-9]*) die "--port must be a number: $PORT" ;; esac
[ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || die "--port out of range: $PORT"
case "$HEALTH_INTERVAL$MIN_RESTART" in *[!0-9]*) die "--health-interval/--min-restart-sec must be whole seconds" ;; esac
[ -n "$PY" ] || PY="$CODE/graph-executor/.venv/bin/python"
[ -n "$REQLOG" ] || REQLOG="$HOME/.claude/graph-executor-requests.log"
abs "$STORE" --store; abs "$CODE" --code; abs "$PY" --python; abs "$REQLOG" --log
plain "$STORE" --store; plain "$CODE" --code; plain "$PY" --python; plain "$REQLOG" --log; plain "$DATASET" --dataset-id
if [ -n "$CKPT" ]; then abs "$CKPT" --checkpoint-dir; plain "$CKPT" --checkpoint-dir; fi

EXEC_LABEL="com.scrumboard.graph-executor"
case "$JOB" in
  executor) [ -n "$LABEL" ] || LABEL="$EXEC_LABEL"; EXEC_LABEL="$LABEL" ;;
  healthcheck) [ -n "$LABEL" ] || LABEL="$EXEC_LABEL-health" ;;
  *) die "--job must be executor or healthcheck" ;;
esac
plain "$LABEL" --label
NODE="$(command -v node || echo /usr/local/bin/node)"; [ -x /opt/homebrew/opt/node@22/bin/node ] && NODE=/opt/homebrew/opt/node@22/bin/node
STDIO_LOG="$HOME/.claude/$LABEL.log"
HEALTH_LOG="$HOME/.claude/graph-executor-health.log"
HEALTH_STATE="$HOME/.claude/graph-executor-health.state.json"

render_executor() {
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PY</string>
    <string>$CODE/graph-executor/executor.py</string>
    <string>--store</string>
    <string>$STORE</string>
    <string>--port</string>
    <string>$PORT</string>
    <string>--dataset-id</string>
    <string>$DATASET</string>
    <string>--log</string>
    <string>$REQLOG</string>
$(if [ -n "$CKPT" ]; then printf '    <string>--checkpoint-dir</string>\n    <string>%s</string>\n' "$CKPT"; fi)
  </array>
  <key>WorkingDirectory</key><string>$CODE/graph-executor</string>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$STDIO_LOG</string>
  <key>StandardErrorPath</key><string>$STDIO_LOG</string>
</dict>
</plist>
EOF
}

render_healthcheck() {
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$CODE/scripts/graph-executor-healthcheck.mjs</string>
    <string>--url</string>
    <string>http://127.0.0.1:$PORT</string>
    <string>--log</string>
    <string>$HEALTH_LOG</string>
    <string>--state</string>
    <string>$HEALTH_STATE</string>
    <string>--label</string>
    <string>$EXEC_LABEL</string>
    <string>--min-interval-sec</string>
    <string>$MIN_RESTART</string>
  </array>
  <key>WorkingDirectory</key><string>$CODE</string>
  <key>StartInterval</key><integer>$HEALTH_INTERVAL</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$STDIO_LOG</string>
  <key>StandardErrorPath</key><string>$STDIO_LOG</string>
</dict>
</plist>
EOF
}

render() { if [ "$JOB" = executor ]; then render_executor | grep -v '^$'; else render_healthcheck; fi; }

if [ "$INSTALL" != 1 ]; then
  if [ -n "$OUT" ]; then render > "$OUT"; echo "rendered $LABEL → $OUT (dry run: nothing installed)" >&2; else render; fi
  exit 0
fi

# ── --install: a DEPLOY. Never run by the tests. ──
[ -z "$OUT" ] || die "--out and --install are exclusive"
[ -f "$CODE/graph-executor/executor.py" ] || die "no executor at $CODE/graph-executor/executor.py"
[ -x "$PY" ] || die "no python at $PY"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.claude"
if [ -f "$PLIST" ]; then
  BAK="$PLIST.bak-$(date -u +%Y%m%dT%H%M%SZ)"; cp "$PLIST" "$BAK"; echo "backed up existing plist → $BAK"
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
fi
render > "$PLIST"
plutil -lint "$PLIST" >/dev/null
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "installed $LABEL ($JOB) from $PLIST"
launchctl list | grep -F "$LABEL" || { echo "⛔ loaded but not listed — check: launchctl print gui/$(id -u)/$LABEL" >&2; exit 1; }
