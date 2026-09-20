#!/usr/bin/env bash
# Sends fake door events to the Worker so you can test it without the hardware.
#
#   BASE_URL=https://shelly-door-monitor.jmrobfogel.workers.dev API_KEY=yourkey bash test/send-test-events.sh
#   BASE_URL=http://127.0.0.1:8787 API_KEY=testkey bash test/send-test-events.sh      # against `wrangler dev`
#
# It sends: open, closed (5 s later), open (3 s later), closed (8 s later), then repeats the last event to
# prove duplicates are ignored. Room name and device id can be overridden with ROOM and DEVICE.

set -euo pipefail
BASE_URL="${BASE_URL:-http://127.0.0.1:8787}"
API_KEY="${API_KEY:-testkey}"
ROOM="${ROOM:-TEST Room 999}"
DEVICE="${DEVICE:-TE:ST:00:00:09:99}"

pid=$(( RANDOM % 200 ))

send() {  # state pid ts
  curl -sS -X POST "$BASE_URL/event" \
    -H "content-type: application/json" -H "x-api-key: $API_KEY" \
    -d "{\"device_id\":\"$DEVICE\",\"room\":\"$ROOM\",\"kind\":\"change\",\"state\":\"$1\",\"pid\":$2,\"ts\":$3,\"battery\":97,\"rssi\":-61,\"gateway\":\"curl-test\"}"
  echo
}

ts=$(date +%s); send open   $((pid+1)) "$ts"
sleep 5;        ts=$(date +%s); send closed $((pid+2)) "$ts"
sleep 3;        ts=$(date +%s); send open   $((pid+3)) "$ts"
sleep 8;        ts=$(date +%s); dup_ts=$ts; send closed $((pid+4)) "$ts"
echo "--- resending the last event (should say duplicate: true) ---"
send closed $((pid+4)) "$dup_ts"
