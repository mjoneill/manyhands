#!/usr/bin/env bash
# #931 — REPRODUCE THE PROJECTION RACE, AND ITS FIX, END TO END.
#
# ⛔ NOT wired into `npm test`, on purpose. It is TIMING-DEPENDENT: it needs a
# write to land inside a cold projection's yield window. A flaky red in CI is
# worse than a documented manual probe, and this room has already paid for
# instruments that cry wolf.
#
# ⚠️ Three black-box reproductions on 2026-08-19 all PASSED and the bug was
# real. They failed because nobody had the trigger. The trigger is:
#   COLD sync (whole store, seconds long) + a write timed into it.
# A warm sync is milliseconds and the window is effectively shut.
#
# MEASURED on a copy of a real board (852 cards):
#
#   without the generation compare   write CLOBBERED, invisible to the next
#                                    query. watermark: 8441/8442, current:false
#   with it                          write VISIBLE. watermark: 8442/8442, and
#                                    "a write landed mid-sync" logged once
#
# ⭐ Note the control row: #949's watermark CAUGHT #931 unaided. The two cards
# check each other, which is why they shipped together.
#
# ── USAGE ───────────────────────────────────────────────────────────────────
#   BOARD_SRC=/path/to/a/board/directory bash tests/manual/race-931-probe.sh
#
# BOARD_SRC must hold `board-data.json` and `board-data-events/`. It is COPIED
# to a temp sandbox and never written to. There is deliberately NO DEFAULT: a
# baked-in path is how a probe ends up pointed at a live board by someone who
# did not read it, and it is what the #561 publication gate refused when this
# script was first written with one.
#
# Leaves nothing behind: sandbox removed, server killed, source untouched.
set -e

if [ -z "${BOARD_SRC:-}" ]; then
  echo "BOARD_SRC is required — a directory holding board-data.json and board-data-events/." >&2
  echo "It is copied, never written. Example: BOARD_SRC=\$HOME/some/board bash \$0" >&2
  exit 2
fi
[ -f "$BOARD_SRC/board-data.json" ] || { echo "no board-data.json under BOARD_SRC" >&2; exit 2; }

PORT="${PROBE_PORT:-3198}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
SBX=$(mktemp -d /tmp/race-XXXX)
cp "$BOARD_SRC/board-data.json" "$SBX/board-data.json"
mkdir -p "$SBX/board-data-events"
cp "$BOARD_SRC"/board-data-events/*.jsonl "$SBX/board-data-events/" 2>/dev/null || true

cd "$REPO"
SCRUM_PORT="$PORT" SCRUM_BOARD_FILE="$SBX/board-data.json" \
  SCRUM_EVENT_LOG_DIR="$SBX/board-data-events" \
  SCRUM_MCP_NOTIFY_URL="http://127.0.0.1:59999/dead" node server.js > /tmp/race-server.log 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null; sleep 0.5; kill -9 $SRV 2>/dev/null; rm -rf "$SBX"' EXIT

for i in $(seq 1 40); do curl -sf "http://127.0.0.1:$PORT/api/cards" >/dev/null 2>&1 && break; sleep 0.5; done

# 1. kick a COLD graph sync (slow: whole store) in the background
curl -s -X POST "http://127.0.0.1:$PORT/api/graph" -H 'Content-Type: application/json' \
  -d '{"query":"SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o }","by":"probe"}' > /tmp/race-q1.json &
Q1=$!
# 2. write DURING that sync — this is #931's window
sleep 0.9
curl -s -X POST "http://127.0.0.1:$PORT/api/cards" -H 'Content-Type: application/json' \
  -d '{"title":"RACE-PROBE-CARD","createdBy":"ada"}' -o /tmp/race-create.json
wait $Q1
sleep 0.5
# 3. is the mid-sync write visible to the very next query?
curl -s -X POST "http://127.0.0.1:$PORT/api/graph" -H 'Content-Type: application/json' \
  -d '{"query":"SELECT ?n WHERE { ?c schema:name ?n . FILTER(CONTAINS(?n,\"RACE-PROBE-CARD\")) }","by":"probe"}' \
  -o /tmp/race-q2.json

python3 - <<'PY'
import json
q2=json.load(open('/tmp/race-q2.json'))
found=len(q2.get('rows',[]))>0
print("mid-sync write visible to next query:", "YES (fix present)" if found else "NO (clobbered — pre-#931 behaviour)")
w=q2.get('watermark',{})
print("watermark:", json.dumps({k:w.get(k) for k in ('projectedThrough','storeHead','behindBy','current')}))
PY
grep -c "landed mid-sync" /tmp/race-server.log 2>/dev/null | sed 's/^/mid-sync log lines: /' || true
