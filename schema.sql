-- Door event log for the Shelly motel monitor.
-- Run once against your D1 database (dashboard Console, or `wrangler d1 execute`).

CREATE TABLE IF NOT EXISTS door_events (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at        INTEGER NOT NULL,          -- when the Worker got it (ms since epoch, UTC)
  event_ts           INTEGER NOT NULL,          -- when the door changed (ms since epoch, UTC)
  event_time_utc     TEXT    NOT NULL,          -- event_ts as ISO-8601 UTC, for easy reading
  event_time_local   TEXT    NOT NULL,          -- event_ts in the TIMEZONE var (default America/New_York)
  device_id          TEXT    NOT NULL,          -- sensor MAC address, upper case
  room               TEXT,                      -- room label sent by the gateway script
  kind               TEXT    NOT NULL DEFAULT 'change',  -- 'change' = door state changed, 'heartbeat' = periodic/baseline
  state              TEXT    NOT NULL,          -- 'open' or 'closed'
  prev_state         TEXT,                      -- previous recorded 'change' state for this sensor
  seconds_since_prev INTEGER,                   -- seconds since the previous 'change' for this sensor
  pid                INTEGER,                   -- BTHome packet id from the sensor (0-255, wraps)
  battery            INTEGER,                   -- sensor battery %
  rssi               INTEGER,                   -- Bluetooth signal strength seen by the gateway
  gateway            TEXT,                      -- which Plug/gateway reported it
  ts_source          TEXT    NOT NULL,          -- 'device' (gateway clock) or 'server' (Worker clock fallback)
  raw                TEXT                       -- original JSON payload, for debugging
);

-- Same sensor + same packet id + same timestamp = the same event delivered twice (retry / duplicate radio copy).
CREATE UNIQUE INDEX IF NOT EXISTS ux_door_events_dedupe
  ON door_events (device_id, pid, event_ts);

CREATE INDEX IF NOT EXISTS ix_door_events_device_time ON door_events (device_id, event_ts);
CREATE INDEX IF NOT EXISTS ix_door_events_room_time   ON door_events (room, event_ts);

-- Always-correct time-between-changes, recomputed from the raw log (safe even if a delayed event
-- arrives out of order). Use this one for analysis / the future PMS comparison.
--   SELECT * FROM door_changes ORDER BY event_ts DESC LIMIT 50;
CREATE VIEW IF NOT EXISTS door_changes AS
SELECT
  id, event_time_local, room, device_id, state,
  LAG(state)    OVER w AS prev_state,
  (event_ts - LAG(event_ts) OVER w) / 1000 AS seconds_since_prev,
  event_ts, battery, rssi
FROM door_events
WHERE kind = 'change'
WINDOW w AS (PARTITION BY device_id ORDER BY event_ts, id);
