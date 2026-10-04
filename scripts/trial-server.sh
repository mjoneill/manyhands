#!/bin/sh
# #1567 — start an ISOLATED trial board (fabricated data only) with the graph
# slice on, every data path inside ONE directory, and a write fence that makes
# any escape a loud crash.
#
#   scripts/trial-server.sh start [TRIAL_DIR] [DATASET_ID]   → prints the manifest (JSON)
#   scripts/trial-server.sh stop  TRIAL_DIR
#
# How the isolation is built (each layer can be checked on its own):
#   1. CODE: only git-TRACKED files are copied into TRIAL_DIR/code, so the
#      defaults the server derives from its own directory (board file, roster,
#      attachments, tending files, …) land inside the fence. Untracked data
#      (board-data.json, rosters, logs) never comes along. A dirty tree is
#      refused, so the trial runs one commit, recorded in the manifest.
#   2. ENV: the process starts from an EMPTY environment (env -i) plus an
#      explicit list, every path in it under TRIAL_DIR; HOME and TMPDIR too.
#      The launcher checks every path value before starting.
#   3. FENCE: scripts/trial-fs-guard.mjs is preloaded; a write outside TRIAL_DIR
#      throws and prints "TRIAL-FS-GUARD REFUSED". The launcher proves the fence
#      bites (a must-fail write) before it starts the server.
#   4. NO REACH: the MCP notify target is disabled, so nothing is pushed to a
#      live room.
set -eu

cmd=${1:-}
SRC=$(cd "$(dirname "$0")/.." && pwd -P)

if [ "$cmd" = "stop" ]; then
  D=${2:?usage: trial-server.sh stop TRIAL_DIR}
  [ -f "$D/server.pid" ] && kill "$(cat "$D/server.pid")" 2>/dev/null || true
  echo "stopped $(cat "$D/server.pid" 2>/dev/null || echo '?')"
  exit 0
fi
[ "$cmd" = "start" ] || { echo "usage: trial-server.sh start [TRIAL_DIR] [DATASET_ID] | stop TRIAL_DIR" >&2; exit 2; }

if [ -n "$(git -C "$SRC" status --porcelain --untracked-files=no)" ]; then
  echo "REFUSED: $SRC has uncommitted changes; a trial runs one recorded commit" >&2; exit 4
fi
SHA=$(git -C "$SRC" rev-parse HEAD)

TRIAL_DIR=${2:-$(mktemp -d "${TMPDIR:-/tmp}/manyhands-trial.XXXXXX")}
mkdir -p "$TRIAL_DIR"
TRIAL_DIR=$(cd "$TRIAL_DIR" && pwd -P)
DATASET_ID=${3:-trial-$(basename "$TRIAL_DIR")}
CODE=$TRIAL_DIR/code
DATA=$TRIAL_DIR/data
[ -e "$CODE" ] && { echo "REFUSED: $CODE exists; use a fresh TRIAL_DIR" >&2; exit 5; }
mkdir -p "$CODE" "$DATA/events" "$DATA/attachments" "$DATA/home" "$DATA/tmp" "$DATA/export" "$DATA/graph-store"

# 1. tracked code only (node_modules and the executor venv are linked, read-only use)
(cd "$SRC" && git ls-files -z | rsync -a --from0 --files-from=- ./ "$CODE/")
ln -s "$SRC/node_modules" "$CODE/node_modules"
ln -s "$SRC/graph-executor/.venv" "$CODE/graph-executor/.venv"

PY=$CODE/graph-executor/.venv/bin/python
PORT=$(node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")
EPORT=$(node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")

# the trial store's dataset marker, written once
"$PY" - "$DATA/graph-store" "$DATASET_ID" <<'EOF'
import sys, pyoxigraph as px, json
s = px.Store(sys.argv[1])
s.update('INSERT DATA { <urn:ex:dataset> <urn:ex:datasetId> %s ; <urn:ex:epoch> 1 ; <urn:ex:commitSeq> 0 }' % json.dumps(sys.argv[2]))
s.flush()
EOF

# 2. the whole environment, explicitly
cat > "$TRIAL_DIR/server.env" <<EOF
TRIAL_DIR=$TRIAL_DIR
HOME=$DATA/home
TMPDIR=$DATA/tmp
SCRUM_PORT=$PORT
SCRUM_INSTANCE_ID=trial-$(basename "$TRIAL_DIR")
SCRUM_BOARD_FILE=$DATA/board-data.json
SCRUM_EVENT_LOG_DIR=$DATA/events
SCRUM_SEAT_TOKENS=$DATA/seat-tokens.json
SCRUM_ROSTER_FILE=$DATA/roster.json
SCRUM_ATTACHMENTS_DIR=$DATA/attachments
SCRUM_WORK_STORE=$DATA/work-objects.jsonl
SCRUM_WHISPER_STATE_FILE=$DATA/whisper-state.json
SCRUM_WHISPER_POOL_FILE=$DATA/whisper-pool.json
SCRUM_UNREGISTERED_STATE_FILE=$DATA/unregistered-state.json
SCRUM_TENDING_PROVENANCE_FILE=$DATA/tending-provenance.json
SCRUM_TENDING_CONFIG_FILE=$DATA/tending-config.json
SCRUM_STALE_CLAIM_STATE_FILE=$DATA/stale-claim-state.json
SCRUM_SHA_INTEGRITY_FILE=$DATA/sha-integrity.json
SCRUM_DIGEST_STATE_FILE=$DATA/digest-state.json
SCRUM_CHANNEL_CONFIG_FILE=$DATA/channel-config.json
SCRUM_MODEL_LEDGER_FILE=$DATA/model-ledger.jsonl
SCRUM_EXPORT_ROOT=$DATA/export
SCRUM_STATIC_DIR=$CODE
SCRUM_MCP_NOTIFY_URL=
SCRUM_MCP_STATUS_URL=http://127.0.0.1:1/
SCRUM_GRAPH_EXECUTOR_URL=http://127.0.0.1:$EPORT
SCRUM_GRAPH_DATASET_ID=$DATASET_ID
SCRUM_TRIAL_EXECUTOR_STORE=$DATA/graph-store
SCRUM_TRIAL_EXECUTOR_LOG=$DATA/executor.log
GRAPH_EXECUTOR_PYTHON=$PY
SCRUM_GRAPH_TRIAL_UNBOUND_ACTORS=1
EOF

# every value that looks like a path must sit under TRIAL_DIR (the python and the static dir are inside CODE)
bad=$(grep -E '=/' "$TRIAL_DIR/server.env" | grep -v "=$TRIAL_DIR" || true)
[ -z "$bad" ] || { echo "REFUSED: path outside $TRIAL_DIR:" >&2; echo "$bad" >&2; exit 6; }

GUARD=$CODE/scripts/trial-fs-guard.mjs
# 3. the fence must BITE before it is trusted: a write outside TRIAL_DIR must fail
if env -i PATH="$PATH" TRIAL_DIR="$TRIAL_DIR" HOME="$DATA/home" node --import "$GUARD" \
     -e "require('fs').writeFileSync(require('path').join(require('os').tmpdir() === '$DATA/tmp' ? '/tmp' : '/tmp', 'trial-fence-control-$$'), 'x')" 2>/dev/null; then
  rm -f "/tmp/trial-fence-control-$$"
  echo "REFUSED: the write fence did not refuse a write outside $TRIAL_DIR" >&2; exit 7
fi

# start the server from the CODE copy, empty env + the list, fence preloaded
# exec: the recorded pid IS the server, and no wrapper shell keeps this script's
# stdout open after it exits (a caller piping our output would otherwise hang)
( cd "$CODE" && exec env -i PATH="$PATH" $(grep -v '^$' "$TRIAL_DIR/server.env" | tr '\n' ' ') \
   node --import "$GUARD" server.js ) < /dev/null > "$TRIAL_DIR/server.log" 2>&1 &
echo $! > "$TRIAL_DIR/server.pid"

URL=http://127.0.0.1:$PORT
i=0
until curl -sf "$URL/api/trial/counters" > "$TRIAL_DIR/counters-at-start.json" 2>/dev/null && grep -q '"executor":{' "$TRIAL_DIR/counters-at-start.json"; do
  i=$((i+1)); [ $i -gt 200 ] && { echo "REFUSED: trial server did not come up; see $TRIAL_DIR/server.log" >&2; exit 8; }
  sleep 0.1
done

# guest-once runs from the same code copy, fenced the same way
cat > "$TRIAL_DIR/guest.env" <<EOF
TRIAL_DIR=$TRIAL_DIR
HOME=$DATA/home
TMPDIR=$DATA/tmp
SCRUM_BOARD_URL=$URL
SCRUM_GUEST_STATE_FILE=$DATA/guest-state.json
SCRUM_MODEL_LEDGER_FILE=$DATA/guest-ledger.jsonl
SCRUM_HANDED_DUMP=$DATA/handed.jsonl
NODE_OPTIONS=--import $GUARD
EOF

cat > "$TRIAL_DIR/manifest.json" <<EOF
{ "commit": "$SHA", "trialDir": "$TRIAL_DIR", "url": "$URL", "pid": $(cat "$TRIAL_DIR/server.pid"),
  "executorUrl": "http://127.0.0.1:$EPORT", "datasetId": "$DATASET_ID",
  "code": "$CODE", "serverEnv": "$TRIAL_DIR/server.env", "guestEnv": "$TRIAL_DIR/guest.env",
  "guestRun": "cd $CODE && env \$(cat $TRIAL_DIR/guest.env | tr '\\\\n' ' ') <MODEL_KEY_VAR>=… node scripts/guest-once.mjs --seat <seat>" }
EOF
cat "$TRIAL_DIR/manifest.json"
