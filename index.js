// Shelly motel door monitor - Cloudflare Worker + D1
//
//   POST /event   gateway -> stores one door event, computes seconds since previous change
//   GET  /events  recent events (JSON)      ?limit=50&room=101&since=24&kind=change
//   GET  /rooms   one row per sensor/room   ?since=24   (hours) - last state, opens, changes
//   GET  /health  no auth, for uptime checks
//   GET  /        tiny live table for demos: open  /?key=YOUR_API_KEY
//
// Auth: every route except / (the static page) and /health needs the API key,
// either as header  x-api-key: <key>  or query string  ?key=<key>.

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (path === "/health") return json({ ok: true, time: new Date().toISOString() });
      if (path === "/" && request.method === "GET") return html(PAGE);

      if (!env.API_KEY) return json({ error: "server has no API_KEY secret configured" }, 500);
      if (!authorized(request, url, env)) return json({ error: "unauthorized" }, 401);

      if (path === "/event" && request.method === "POST") return ingest(request, env);
      if (path === "/events" && request.method === "GET") return listEvents(url, env);
      if (path === "/rooms" && request.method === "GET") return listRooms(url, env);

      return json({ error: "not found" }, 404);
    } catch (err) {
      console.log(JSON.stringify({ level: "error", message: String((err && err.message) || err) }));
      return json({ error: "internal error", detail: String((err && err.message) || err) }, 500);
    }
  },
};

// ---------------------------------------------------------------- ingest

async function ingest(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "body must be JSON" }, 400);
  }

  const deviceId = String(body.device_id || "").trim().toUpperCase();
  const state = String(body.state || "").trim().toLowerCase();
  if (!deviceId) return json({ error: "device_id is required" }, 400);
  if (state !== "open" && state !== "closed") {
    return json({ error: "state must be 'open' or 'closed'" }, 400);
  }
  const kind = body.kind === "heartbeat" ? "heartbeat" : "change";

  // Event time: prefer the gateway's clock (accurate even if the POST was retried later).
  // Fall back to the Worker's clock if the gateway has no valid time (unsynced clocks report tiny values).
  const now = Date.now();
  let eventTs = now;
  let tsSource = "server";
  const t = Number(body.ts);
  if (Number.isFinite(t) && t > 1.5e9) {
    const ms = t < 1e12 ? t * 1000 : t; // accept seconds or milliseconds
    if (Math.abs(ms - now) < 7 * 24 * 3600 * 1000) {
      eventTs = Math.round(ms);
      tsSource = "device";
    }
  }

  // Previous recorded door change for this sensor (before this event) -> time between changes.
  let prevState = null;
  let secondsSincePrev = null;
  if (kind === "change") {
    const prev = await env.DB.prepare(
      `SELECT state, event_ts FROM door_events
        WHERE device_id = ?1 AND kind = 'change' AND event_ts <= ?2
        ORDER BY event_ts DESC, id DESC LIMIT 1`
    ).bind(deviceId, eventTs).first();
    if (prev) {
      prevState = prev.state;
      secondsSincePrev = Math.round((eventTs - prev.event_ts) / 1000);
    }
  }

  const tz = env.TIMEZONE || "America/New_York";
  const room = body.room ? String(body.room).slice(0, 64) : null;
  const pid = intOrNull(body.pid);

  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO door_events
       (received_at, event_ts, event_time_utc, event_time_local, device_id, room, kind, state,
        prev_state, seconds_since_prev, pid, battery, rssi, gateway, ts_source, raw)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)`
  ).bind(
    now, eventTs, new Date(eventTs).toISOString(), localTime(eventTs, tz),
    deviceId, room, kind, state,
    prevState, secondsSincePrev, pid,
    intOrNull(body.battery), intOrNull(body.rssi),
    body.gateway ? String(body.gateway).slice(0, 64) : null,
    tsSource, JSON.stringify(body).slice(0, 2000)
  ).run();

  const stored = (result.meta && result.meta.changes) > 0;
  if (!stored) { prevState = null; secondsSincePrev = null; } // a duplicate is not a new change
  // One JSON line per event -> visible in Workers Logs / live tail.
  console.log(JSON.stringify({
    level: "info", msg: stored ? "door_event" : "duplicate_ignored",
    room, device_id: deviceId, kind, state, prev_state: prevState,
    seconds_since_prev: secondsSincePrev, pid, battery: intOrNull(body.battery),
    ts_source: tsSource, lag_s: Math.round((now - eventTs) / 1000),
  }));

  return json({
    ok: true, stored, duplicate: !stored,
    room, device_id: deviceId, kind, state,
    prev_state: prevState, seconds_since_prev: secondsSincePrev,
    event_time_local: localTime(eventTs, tz),
  }, stored ? 201 : 200);
}

// ---------------------------------------------------------------- queries

async function listEvents(url, env) {
  const limit = clamp(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 1, 500);
  const where = [];
  const args = [];
  const room = url.searchParams.get("room");
  const device = url.searchParams.get("device_id");
  const kind = url.searchParams.get("kind");
  const since = parseFloat(url.searchParams.get("since") || "");
  if (room) { where.push(`room = ?${args.push(room)}`); }
  if (device) { where.push(`device_id = ?${args.push(device.toUpperCase())}`); }
  if (kind) { where.push(`kind = ?${args.push(kind)}`); }
  if (Number.isFinite(since)) { where.push(`event_ts >= ?${args.push(Date.now() - since * 3600 * 1000)}`); }

  const sql =
    `SELECT id, event_time_local, event_time_utc, room, device_id, kind, state, prev_state,
            seconds_since_prev, battery, rssi, gateway, ts_source, received_at, event_ts
       FROM door_events
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY event_ts DESC, id DESC LIMIT ${limit}`;
  const { results } = await env.DB.prepare(sql).bind(...args).all();
  return json({ count: results.length, events: results });
}

async function listRooms(url, env) {
  const since = parseFloat(url.searchParams.get("since") || "24");
  const hours = Number.isFinite(since) ? since : 24;
  const cutoff = Date.now() - hours * 3600 * 1000;
  const { results } = await env.DB.prepare(
    `SELECT e.room, e.device_id,
            COUNT(*)                          AS changes,
            SUM(e.state = 'open')             AS opens,
            MIN(e.event_ts)                   AS first_change_ts,
            MAX(e.event_ts)                   AS last_change_ts,
            (SELECT l.state FROM door_events l
               WHERE l.device_id = e.device_id AND l.kind = 'change'
               ORDER BY l.event_ts DESC, l.id DESC LIMIT 1) AS last_state,
            (SELECT h.battery FROM door_events h
               WHERE h.device_id = e.device_id AND h.battery IS NOT NULL
               ORDER BY h.event_ts DESC, h.id DESC LIMIT 1) AS battery
       FROM door_events e
      WHERE e.kind = 'change' AND e.event_ts >= ?1
      GROUP BY e.device_id, e.room
      ORDER BY last_change_ts DESC`
  ).bind(cutoff).all();
  const tz = env.TIMEZONE || "America/New_York";
  const rooms = results.map((r) => ({
    ...r,
    first_change_local: localTime(r.first_change_ts, tz),
    last_change_local: localTime(r.last_change_ts, tz),
  }));
  return json({ since_hours: hours, count: rooms.length, rooms });
}

// ---------------------------------------------------------------- helpers

function authorized(request, url, env) {
  const given = request.headers.get("x-api-key") || url.searchParams.get("key") || "";
  return given.length > 0 && given === env.API_KEY;
}

function intOrNull(v) {
  const n = Number(v);
  return v === null || v === undefined || v === "" || !Number.isFinite(n) ? null : Math.round(n);
}

function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

function localTime(ms, tz) {
  try {
    const p = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(ms)).reduce((o, x) => { o[x.type] = x.value; return o; }, {});
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
  } catch {
    return new Date(ms).toISOString();
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function html(body) {
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

// Minimal live view for demos. Reads the key from the page URL (?key=...), refreshes every 3 s.
const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Door events</title>
<style>
  body{font:15px system-ui,sans-serif;margin:24px;color:#1a1a1a;background:#fafafa}
  h1{font-size:20px;margin:0 0 4px} p{color:#666;margin:0 0 16px}
  table{border-collapse:collapse;width:100%;background:#fff}
  th,td{padding:8px 12px;border-bottom:1px solid #e5e5e5;text-align:left;white-space:nowrap}
  th{background:#f0f0f0;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
  .open{color:#b3261e;font-weight:600} .closed{color:#1a7f37;font-weight:600}
  .hb{color:#999} #msg{color:#b3261e}
</style></head><body>
<h1>Door events</h1>
<p>Newest first. Refreshes every 3 seconds. <span id="msg"></span></p>
<table><thead><tr><th>Local time</th><th>Room</th><th>State</th><th>Was</th><th>Seconds since previous change</th><th>Battery</th><th>Type</th></tr></thead>
<tbody id="rows"></tbody></table>
<script>
const key = new URLSearchParams(location.search).get("key") || "";
const rows = document.getElementById("rows"), msg = document.getElementById("msg");
function cell(tr, text, cls){ const td = document.createElement("td"); td.textContent = text; if(cls) td.className = cls; tr.appendChild(td); }
async function load(){
  try{
    const r = await fetch("/events?limit=100&key=" + encodeURIComponent(key));
    if(!r.ok){ msg.textContent = "Error " + r.status + " (check ?key=)"; return; }
    const d = await r.json(); msg.textContent = ""; rows.textContent = "";
    for(const e of d.events){
      const tr = document.createElement("tr"); if(e.kind === "heartbeat") tr.className = "hb";
      cell(tr, e.event_time_local); cell(tr, e.room || e.device_id);
      cell(tr, e.state.toUpperCase(), e.kind === "change" ? e.state : ""); cell(tr, e.prev_state || "");
      cell(tr, e.seconds_since_prev == null ? "" : e.seconds_since_prev);
      cell(tr, e.battery == null ? "" : e.battery + "%"); cell(tr, e.kind);
      rows.appendChild(tr);
    }
  }catch(err){ msg.textContent = "Network error"; }
}
load(); setInterval(load, 3000);
</script></body></html>`;
