#!/bin/sh
# #1237 — the resident wakes on its own.
#
# Installs (or verifies) a launchd tick that runs the SERVE copy of
# scripts/guest-once.mjs for one seat every INTERVAL seconds, so a human who
# @mentions the seat from the UI gets an answer with nobody running a script.
# Same shape as com.scrumboard.fanoutwatch: StartInterval, RunAtLoad, the serve
# dir, a state file and a log under ~/.claude. launchd never starts a second
# instance of a job that is still running, and the runner holds a lock beside
# its state file for the hand-run case, so one mention gets one answer.
#
#   DEPLOY_SERVE=<serve dir> sh scripts/install-guest-wake.sh [--seat guest] [--interval 60] [--serve DIR] [--verify]
#
# The serve dir is the one deploy.sh writes (DEPLOY_SERVE); there is no default.
#
# --verify prints what is installed and whether it matches the render; it
# changes nothing. An install backs up an existing plist first (a reinstall
# from a template has overwritten hand patches before — #1230).
set -eu

SEAT=guest; INTERVAL=60; SERVE="${DEPLOY_SERVE:-}"; VERIFY=0; KEYREF=''
while [ $# -gt 0 ]; do
  case "$1" in
    --seat) SEAT="$2"; shift 2 ;;
    --interval) INTERVAL="$2"; shift 2 ;;
    --serve) SERVE="$2"; shift 2 ;;
    --verify) VERIFY=1; shift ;;
    # #1196 — a HOSTED seat needs a credential, and the credential must never
    # land in this plist. --key-ref names a Keychain item; the rendered job
    # reads it AT RUN TIME into one process env and nothing else. Verified on
    # this host: a detached, non-interactive read succeeds without prompting.
    --key-ref) KEYREF="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

[ -n "$SERVE" ] || { echo "serve dir unknown: pass --serve DIR or set DEPLOY_SERVE (the dir deploy.sh serves from)" >&2; exit 2; }
NODE="$(command -v node)"; [ -x /opt/homebrew/opt/node@22/bin/node ] && NODE=/opt/homebrew/opt/node@22/bin/node
LABEL="com.scrumboard.guestwake-$SEAT"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
STATE="$HOME/.claude/scrum-guest-wake-$SEAT.state.json"
LOG="$HOME/.claude/scrum-guest-wake-$SEAT.log"
SCRIPT="$SERVE/scripts/guest-once.mjs"

render() {
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
$(if [ -n "$KEYREF" ]; then
cat <<INNER
    <string>/bin/sh</string>
    <string>-c</string>
    <string>$KEYREF="\$(security find-generic-password -s $KEYREF -w)" exec "$NODE" "$SCRIPT" --seat $SEAT</string>
INNER
else
cat <<INNER
    <string>$NODE</string>
    <string>$SCRIPT</string>
    <string>--seat</string>
    <string>$SEAT</string>
INNER
fi)
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>SCRUM_GUEST_STATE_FILE</key><string>$STATE</string>
    <key>SCRUM_BOARD_URL</key><string>http://127.0.0.1:3141</string>
  </dict>
  <key>WorkingDirectory</key><string>$SERVE</string>
  <key>StartInterval</key><integer>$INTERVAL</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF
}

if [ "$VERIFY" = 1 ]; then
  if [ ! -f "$PLIST" ]; then echo "NOT INSTALLED: $PLIST"; exit 1; fi
  if render | diff -q - "$PLIST" >/dev/null; then echo "MATCHES render: $PLIST"; else echo "DIFFERS from render: $PLIST"; render | diff - "$PLIST" || true; fi
  launchctl list | grep -F "$LABEL" || echo "NOT LOADED: $LABEL"
  [ -f "$STATE" ] && { echo "state:"; cat "$STATE"; echo; } || echo "no state file yet: $STATE"
  [ -f "$LOG" ] && { echo "log tail:"; tail -n 3 "$LOG"; } || echo "no log yet: $LOG"
  exit 0
fi

[ -f "$SCRIPT" ] || { echo "no runner at $SCRIPT — deploy first" >&2; exit 1; }
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.claude"
if [ -f "$PLIST" ]; then
  BAK="$PLIST.bak-$(date -u +%Y%m%dT%H%M%SZ)"; cp "$PLIST" "$BAK"; echo "backed up existing plist → $BAK"
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
fi
# Seed the cursor at install time when there is no state: the first tick must
# not replay every old mention in the room one per minute.
if [ ! -f "$STATE" ]; then
  printf '{\n  "lastAnsweredAt": "%s",\n  "seededBy": "install-guest-wake.sh"\n}\n' "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" > "$STATE"
  echo "seeded cursor: $STATE"
fi
render > "$PLIST"
plutil -lint "$PLIST" >/dev/null
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "installed $LABEL: every ${INTERVAL}s, runner $SCRIPT, state $STATE, log $LOG${KEYREF:+, credential $KEYREF read from Keychain at run time (never stored here)}"
launchctl list | grep -F "$LABEL" || { echo "⛔ loaded but not listed — check: launchctl print gui/$(id -u)/$LABEL" >&2; exit 1; }
