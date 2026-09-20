
# Shelly motel door monitor (proof of concept)

Shelly BLU Door/Window sensor  →  Bluetooth  →  Shelly Plug US Gen4 (runs a script)  →  HTTPS POST  →  Cloudflare Worker  →  D1 database

Every time a door opens or closes, one row is written to D1 with the room, the new state, the previous state, and the
**seconds since the previous change** (for a "closed" row that is how long the door was open).

```
shelly/door-monitor.js   runs on the Plug: decodes the sensor, queues + retries, posts events
src/index.js             the Worker: validates, de-duplicates, computes durations, stores in D1
schema.sql               D1 tables + a view (door_changes) that always recomputes durations correctly
test/send-test-events.sh fake events, to test the cloud side without any hardware
wrangler.toml            Worker config (name, D1 binding, logging on)
```

## 1. Deploy the cloud side

Note: `wrangler.toml` uses the name `shelly-door-monitor`, so deploying **replaces the code of your existing Worker** of that name.

### Option A: mostly in the browser

1. Cloudflare dashboard → **Storage & Databases → D1 → Create database**, name it `motel-door-events`.
   Open it, go to the **Console** tab, paste all of `schema.sql`, and run it. Copy the database's **ID** from its overview page.
2. Paste that ID into `wrangler.toml` (`database_id = "..."`).
3. Put this folder in your GitHub repo (`shelly-motel-monitor` → *Add file → Upload files*, drag in everything; keep the `src`, `shelly`, `test` folders).
4. Cloudflare → **Workers & Pages → shelly-door-monitor → Settings → Builds → Connect** to that GitHub repo (branch `main`). Every push to GitHub now redeploys.
5. Same Worker → **Settings → Variables and Secrets → Add** a **Secret** named `API_KEY` with a long random value. Deploy once more after adding it.

### Option B: command line

```bash
npm install
npx wrangler login
npx wrangler d1 create motel-door-events        # copy the database_id it prints into wrangler.toml
npx wrangler d1 execute motel-door-events --remote --file=schema.sql
npx wrangler secret put API_KEY                 # paste a long random value
npx wrangler deploy
```

### Check it works (no hardware needed)

```bash
curl https://shelly-door-monitor.jmrobfogel.workers.dev/health
BASE_URL=https://shelly-door-monitor.jmrobfogel.workers.dev API_KEY=your-key bash test/send-test-events.sh
```

You should see four events stored, the second one reporting `prev_state: open` and about 5 seconds since the previous change, and the repeated last event
reporting `duplicate: true`. Then open `https://shelly-door-monitor.jmrobfogel.workers.dev/?key=your-key` for a live table.

## 2. Set up the Plug

1. Plug web page → **Settings → Bluetooth**: enabled.
2. **Scripts → Create script**, paste `shelly/door-monitor.js`, set `API_KEY` (same as the Worker secret), leave `DISCOVER: true`, save, start.
3. Open the door once. The script console prints `DISCOVER: door sensor aa:bb:... window=1`. Copy that address into `CONFIG.SENSORS` with a room name, save, restart the script.
4. Open/close the door. You should see `PKT ...` then `SENT ...` lines, and rows appear in D1.
5. Tick **Run on startup** so it survives a power cut.

Things to know:

- Only one script can run the Bluetooth scan at a time. Stop your earlier script while testing this one. If you would rather keep your own script, that is fine: it only needs to POST the same JSON fields (`device_id`, `room`, `state` = open/closed, `ts` in unix seconds, optional `pid`, `battery`, `rssi`).
- I could not test against real hardware. The decoder assumes the standard BTHome v2 format (object `0x2D` = window). If step 3 never prints the sensor, or `window` never changes, copy me the `PKT`/`DISCOVER` log lines and the raw service data and I will adjust the decoder.
- The ZB model also speaks Zigbee. This setup uses its Bluetooth broadcasts only.
- `ssl_ca: "*"` skips certificate checking on the Plug so the POC connects reliably. Tighten that before real deployments.
- The retry queue lives in the Plug's memory. It survives Wi-Fi/internet outages, but not a Plug reboot or power loss.
- If the Plug misses the radio packet sent at the moment of a change, the sensor's next 60-second beacon still reveals the new state and is recorded as a change with that later time.

## 3. Where to see it on the Cloudflare portal

**The table (best for the video).** Storage & Databases → D1 → `motel-door-events` → **Console**. Paste and run:

```sql
SELECT event_time_local AS time, room, state, prev_state,
       seconds_since_prev AS secs_since_prev,
       (received_at - event_ts) / 1000 AS delivery_lag_s
FROM door_events
WHERE kind = 'change'
ORDER BY event_ts DESC
LIMIT 20;
```

Re-run after each door event (or use the **Tables** tab → `door_events` and refresh).

**Live stream.** Workers & Pages → `shelly-door-monitor` → **Logs** (Observability) → turn on live/real-time logs. Each event prints one line like
`{"msg":"door_event","room":"Room 101","state":"open","prev_state":"closed","seconds_since_prev":37,...}`.

**Rooms that were accessed** (the "basic mode" list):

```sql
SELECT room,
       COUNT(*)            AS changes,
       SUM(state='open')   AS times_opened,
       MIN(event_time_local) AS first_activity,
       MAX(event_time_local) AS last_activity
FROM door_events
WHERE kind = 'change' AND event_ts > (strftime('%s','now') - 86400) * 1000
GROUP BY room
ORDER BY last_activity DESC;
```

**Recompute durations from the raw log** (use this for analysis; it is correct even if a delayed event arrives out of order):

```sql
SELECT * FROM door_changes ORDER BY event_ts DESC LIMIT 50;
```

**Reliability check** (counts should equal the number of times you actually opened and closed the door):

```sql
SELECT state, COUNT(*) FROM door_events WHERE kind='change'
  AND event_ts > (strftime('%s','now') - 900) * 1000 GROUP BY state;
```

The Worker also exposes JSON at `/events` and `/rooms` (add `?key=...`), which the future web interface can use.

## 4. Suggested video (about 2 minutes)

Record the whole screen with Windows **Win+Alt+R** (Xbox Game Bar), macOS **Cmd+Shift+5**, or OBS. Arrange three windows side by side:
the Plug's script console (left), the D1 console with the query above (middle), Workers Logs live (right). If you can, have the door itself in view of a phone camera or on a webcam, or just narrate.

1. Say what it is: door sensor → Plug → Cloudflare. Show the D1 table with no rows (or only old rows).
2. Open the door. Point at the Plug console (`PKT`, `SENT`), the live log line, then re-run the query: new row, `state = open`.
3. Wait about 10 seconds and close it. New row: `closed`, `prev_state = open`, `secs_since_prev ≈ 10`. Say "that is how long it was open."
4. Do three quick open/close cycles with different waits (say 5 s, 20 s, 3 s) to show the durations follow.
5. **Reliability proof.** Note the count from the reliability query, do 10 open/close cycles, run it again: exactly 20 more rows.
6. **Outage proof (optional, impressive).** Turn off the Plug's Wi-Fi (or unplug the router) for 30 seconds, open/close the door twice, restore it. The Plug console shows `SEND FAILED ... retry`, then the events arrive with their **original** times; `delivery_lag_s` in the query shows the delay.
7. Close on the `door_changes` view or the "rooms accessed" query.

## 5. Next steps (later)

- A `pms_occupancy` table (room, check-in, check-out) and a query joining `door_events` opens against unoccupied windows is the core of the alert.
- Decide how rooms map to sensors (a `devices` table instead of typing room names into each Plug script).
- Alerts (email/SMS/push) from the Worker when an unoccupied room opens.
- Lock down access (per-property keys) and move off `ssl_ca: "*"`.
