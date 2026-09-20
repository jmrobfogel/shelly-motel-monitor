// Shelly motel door monitor - Cloudflare Worker + D1
//
//   POST /event     door event from the Plug (kind: change | heartbeat) or a gateway heartbeat (kind: gateway)
//   GET  /events    recent door events (JSON)   ?limit=50&room=101&since=24&kind=change
//   GET  /rooms     one row per sensor/room     ?since=24   (hours)
//   GET  /gateways  is each Plug alive? last heartbeat, uptime, reboots, per-sensor "last heard"
//   GET  /health    no auth, for uptime checks
//   GET  /          tiny live page for demos: open  /?key=YOUR_API_KEY
//
// Auth: every route except / (the static page) and /health needs the API key,
// either as header  x-api-key: <key>  or query string  ?key=<key>.

const DEFAULT_GATEWAY_STALE_SECONDS = 180; // 3 missed one-minute heartbeats = considered offline

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
      if (path === "/gateways" && request.method === "GET") return listGateways(env);

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
  if (body && body.kind === "gateway") return ingestGateway(body, env);

  const deviceId = String(body.device_id || "").trim().toUpperCase();
  const state = String(body.state || "").trim().toLowerCase();
  if (!deviceId) return json({ error: "device_id is required" }, 400);
  if (state !== "open" && state !== "closed") {
    return json({ error: "state must be 'open' or 'closed'" }, 400);
  }
  const requestedKind = body.kind === "heartbeat" ? "heartbeat" : "change";

  // Event time: prefer the gateway's clock (accurate even if the POST was retried later).
  // Fall back to the Worker's clock if the gateway has no valid time (unsynced clocks report tiny values).
  const now = Date.now();
  const { ms: eventTs, source: tsSource } = resolveTime(body.ts, now);

  let kind = requestedKind;
  let prevState = null;
  let secondsSincePrev = null;
  let lateDetect = 0;
  let gapFromTs = null;

  if (requestedKind === "change") {
    // Previous recorded door change for this sensor (before this event) -> time between changes.
    const prev = await env.DB.prepare(
      `SELECT state, event_ts FROM door_events
        WHERE device_id = ?1 AND kind = 'change' AND event_ts <= ?2
        ORDER BY event_ts DESC, id DESC LIMIT 1`
    ).bind(deviceId, eventTs).first();
    if (prev) {
      prevState = prev.state;
      secondsSincePrev = Math.round((eventTs - prev.event_ts) / 1000);
    }
  } else {
    // A heartbeat/baseline row. If the door is now in a different state than the last thing we recorded,
    // a change happened that we did not see (Plug was off or offline, or a radio packet was missed).
    // Record it as a change so it counts as room access, flagged late_detect with the window it happened in.
    const last = await env.DB.prepare(
      `SELECT state, event_ts FROM door_events
        WHERE device_id = ?1 AND event_ts <= ?2
        ORDER BY event_ts DESC, id DESC LIMIT 1`
    ).bind(deviceId, eventTs).first();
    if (last && last.state !== state) {
      kind = "change";
      prevState = last.state;
      lateDetect = 1;
      gapFromTs = last.event_ts;
      // seconds_since_prev stays null: the true moment of the change is unknown.
    }
  }

  const tz = env.TIMEZONE || "America/New_York";
  const room = body.room ? String(body.room).slice(0, 64) : null;
  const pid = intOrNull(body.pid);

  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO door_events
       (received_at, event_ts, event_time_utc, event_time_local, device_id, room, kind, state,
        prev_state, seconds_since_prev, pid, battery, rssi, gateway, ts_source, raw, late_detect, gap_from_ts)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)`
  ).bind(
    now, eventTs, new Date(eventTs).toISOString(), localTime(eventTs, tz),
    deviceId, room, kind, state,
    prevState, secondsSincePrev, pid,
    intOrNull(body.battery), intOrNull(body.rssi),
    body.gateway ? String(body.gateway).slice(0, 64) : null,
    tsSource, JSON.stringify(body).slice(0, 2000), lateDetect, gapFromTs
  ).run();

  const stored = (result.meta && result.meta.changes) > 0;
  if (!stored) { prevState = null; secondsSincePrev = null; lateDetect = 0; } // a duplicate is not a new change

  // One JSON line per event -> visible in Workers Logs / live tail.
  console.log(JSON.stringify({
    level: "info", msg: stored ? "door_event" : "duplicate_ignored",
    room, device_id: deviceId, kind, state, prev_state: prevState,
    seconds_since_prev: secondsSincePrev, late_detect: lateDetect, pid, battery: intOrNull(body.battery),
    ts_source: tsSource, lag_s: Math.round((now - eventTs) / 1000),
  }));

  return json({
    ok: true, stored, duplicate: !stored,
    room, device_id: deviceId, kind, state,
    prev_state: prevState, seconds_since_prev: secondsSincePrev,
    late_detect: lateDetect === 1,
    event_time_local: localTime(eventTs, tz),
  }, stored ? 201 : 200);
}

async function ingestGateway(body, env) {
  const gateway = String(body.gateway || "").trim().slice(0, 64);
  if (!gateway) return json({ error: "gateway is required" }, 400);

  const now = Date.now();
  const { ms: eventTs } = resolveTime(body.ts, now);
  const tz = env.TIMEZONE || "America/New_York";
  const uptime = intOrNull(body.uptime_s);

  // Gap since the previous heartbeat, and whether the Plug rebooted in between.
  // If it stayed powered, its uptime counter grew by about the length of the gap. If the counter is much
  // smaller than that, it lost power or restarted (this also catches a short uptime after a long outage).
  const prev = await env.DB.prepare(
    `SELECT event_ts, uptime_s FROM gateway_heartbeats
      WHERE gateway = ?1 AND event_ts <= ?2
      ORDER BY event_ts DESC, id DESC LIMIT 1`
  ).bind(gateway, eventTs).first();
  let secondsSincePrev = null;
  let rebooted = 0;
  if (prev) {
    secondsSincePrev = Math.round((eventTs - prev.event_ts) / 1000);
    if (uptime !== null && prev.uptime_s !== null && secondsSincePrev >= 0 &&
        uptime + 30 < prev.uptime_s + secondsSincePrev) rebooted = 1;
  }

  const sensors = body.sensors && typeof body.sensors === "object" ? JSON.stringify(body.sensors).slice(0, 1000) : null;

  await env.DB.prepare(
    `INSERT INTO gateway_heartbeats
       (received_at, event_ts, event_time_local, gateway, uptime_s, queue_len, wifi_rssi, free_ram,
        sensors_json, seconds_since_prev, rebooted)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`
  ).bind(
    now, eventTs, localTime(eventTs, tz), gateway, uptime,
    intOrNull(body.queue_len), intOrNull(body.wifi_rssi), intOrNull(body.free_ram),
    sensors, secondsSincePrev, rebooted
  ).run();

  if (rebooted) {
    console.log(JSON.stringify({ level: "warn", msg: "gateway_rebooted", gateway, uptime_s: uptime, gap_s: secondsSincePrev }));
  }

  return json({ ok: true, gateway, seconds_since_prev: secondsSincePrev, rebooted: rebooted === 1 }, 201);
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
            seconds_since_prev, late_detect, gap_from_ts, battery, rssi, gateway, ts_source, received_at, event_ts
       FROM door_events
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY event_ts DESC, id DESC LIMIT ${limit}`;
  const { results } = await env.DB.prepare(sql).bind(...args).all();
  const tz = env.TIMEZONE || "America/New_York";
  const events = results.map((e) => ({
    ...e,
    late_detect: e.late_detect === 1,
    gap_from_local: e.gap_from_ts ? localTime(e.gap_from_ts, tz) : null,
  }));
  return json({ count: events.length, events });
}

async function listRooms(url, env) {
  const since = parseFloat(url.searchParams.get("since") || "24");
  const hours = Number.isFinite(since) ? since : 24;
  const cutoff = Date.now() - hours * 3600 * 1000;
  const { results } = await env.DB.prepare(
    `SELECT e.room, e.device_id,
            COUNT(*)                          AS changes,
            SUM(e.state = 'open')             AS opens,
            SUM(e.late_detect)                AS late_detected,
            MIN(e.event_ts)                   AS first_change_ts,
            MAX(e.event_ts)                   AS last_change_ts,
            (SELECT l.state FROM door_events l
               WHERE l.device_id = e.device_id
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

async function listGateways(env) {
  const stale = Number(env.GATEWAY_STALE_SECONDS) > 0 ? Number(env.GATEWAY_STALE_SECONDS) : DEFAULT_GATEWAY_STALE_SECONDS;
  const now = Date.now();
  const tz = env.TIMEZONE || "America/New_York";
  const { results: names } = await env.DB.prepare(
    `SELECT gateway, MAX(event_ts) AS last_ts FROM gateway_heartbeats GROUP BY gateway ORDER BY gateway`
  ).all();

  const gateways = [];
  for (const n of names) {
    const last = await env.DB.prepare(
      `SELECT * FROM gateway_heartbeats WHERE gateway = ?1 AND event_ts = ?2 ORDER BY id DESC LIMIT 1`
    ).bind(n.gateway, n.last_ts).first();
    const day = await env.DB.prepare(
      `SELECT COALESCE(SUM(rebooted), 0) AS reboots, COALESCE(MAX(seconds_since_prev), 0) AS longest_gap_s
         FROM gateway_heartbeats WHERE gateway = ?1 AND event_ts >= ?2`
    ).bind(n.gateway, now - 24 * 3600 * 1000).first();
    let sensors = null;
    try { sensors = last.sensors_json ? JSON.parse(last.sensors_json) : null; } catch { sensors = null; }
    const since = Math.max(0, Math.round((now - n.last_ts) / 1000));
    gateways.push({
      gateway: n.gateway,
      online: since <= stale,
      seconds_since_heartbeat: since,
      last_heartbeat_local: localTime(n.last_ts, tz),
      uptime_s: last.uptime_s,
      queue_len: last.queue_len,
      wifi_rssi: last.wifi_rssi,
      free_ram: last.free_ram,
      sensors_heard_seconds_ago: sensors,
      reboots_24h: day.reboots,
      longest_gap_24h_s: day.longest_gap_s,
    });
  }
  return json({ stale_after_seconds: stale, count: gateways.length, gateways });
}

// ---------------------------------------------------------------- helpers

function resolveTime(t, now) {
  const n = Number(t);
  if (Number.isFinite(n) && n > 1.5e9) {
    const ms = n < 1e12 ? n * 1000 : n; // accept seconds or milliseconds
    if (Math.abs(ms - now) < 7 * 24 * 3600 * 1000) return { ms: Math.round(ms), source: "device" };
  }
  return { ms: now, source: "server" };
}

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
// NOTE: this is one big template string, so the script inside must not use backticks or dollar-brace.
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
  .hb{color:#999} .late td{background:#fff4d6} #msg{color:#b3261e}
  #gw{margin:0 0 16px}
  .gw{padding:10px 14px;border-radius:6px;margin:0 0 8px;font-weight:600}
  .gw small{display:block;font-weight:400;margin-top:2px}
  .gw.ok{background:#e6f4ea;color:#14532d} .gw.bad{background:#fde7e9;color:#8a1c1c} .gw.idle{background:#eee;color:#555}
</style></head><body>
<h1>Door events</h1>
<p>Newest first. Refreshes every 3 seconds. <span id="msg"></span></p>
<div id="gw"></div>
<table><thead><tr><th>Local time</th><th>Room</th><th>State</th><th>Was</th><th>Seconds since previous change</th><th>Battery</th><th>Type</th><th>Note</th></tr></thead>
<tbody id="rows"></tbody></table>
<script>
const key = new URLSearchParams(location.search).get("key") || "";
const rows = document.getElementById("rows"), msg = document.getElementById("msg"), gw = document.getElementById("gw");
function cell(tr, text, cls){ const td = document.createElement("td"); td.textContent = text; if(cls) td.className = cls; tr.appendChild(td); }
function fmt(s){
  if(s == null) return "?";
  if(s < 60) return s + "s";
  if(s < 3600) return Math.floor(s/60) + "m " + (s%60) + "s";
  return Math.floor(s/3600) + "h " + Math.floor((s%3600)/60) + "m";
}
async function loadEvents(){
  try{
    const r = await fetch("/events?limit=100&key=" + encodeURIComponent(key));
    if(!r.ok){ msg.textContent = "Error " + r.status + " (check ?key=)"; return; }
    const d = await r.json(); msg.textContent = ""; rows.textContent = "";
    for(const e of d.events){
      const tr = document.createElement("tr");
      if(e.kind === "heartbeat") tr.className = "hb";
      if(e.late_detect) tr.className = "late";
      cell(tr, e.event_time_local); cell(tr, e.room || e.device_id);
      cell(tr, e.state.toUpperCase(), e.kind === "change" ? e.state : ""); cell(tr, e.prev_state || "");
      cell(tr, e.seconds_since_prev == null ? "" : e.seconds_since_prev);
      cell(tr, e.battery == null ? "" : e.battery + "%"); cell(tr, e.kind);
      cell(tr, e.late_detect ? "Changed while not watching, between " + (e.gap_from_local || "?").slice(11) + " and " + e.event_time_local.slice(11) : "");
      rows.appendChild(tr);
    }
  }catch(err){ msg.textContent = "Network error"; }
}
async function loadGateways(){
  try{
    const r = await fetch("/gateways?key=" + encodeURIComponent(key));
    if(!r.ok) return;
    const d = await r.json(); gw.textContent = "";
    if(!d.gateways.length){
      const idle = document.createElement("div"); idle.className = "gw idle";
      idle.textContent = "No gateway heartbeats received yet."; gw.appendChild(idle); return;
    }
    for(const g of d.gateways){
      const div = document.createElement("div"); div.className = "gw " + (g.online ? "ok" : "bad");
      div.textContent = g.online
        ? g.gateway + " is ONLINE (last heartbeat " + fmt(g.seconds_since_heartbeat) + " ago, up " + fmt(g.uptime_s) + ")"
        : g.gateway + " is OFFLINE: nothing heard for " + fmt(g.seconds_since_heartbeat) + " (Plug has no power or no internet)";
      const small = document.createElement("small");
      const parts = [];
      if(g.sensors_heard_seconds_ago){
        for(const name of Object.keys(g.sensors_heard_seconds_ago)){
          const s = g.sensors_heard_seconds_ago[name];
          parts.push(name + ": " + (s < 0 ? "not heard yet" : "heard " + fmt(s) + " ago"));
        }
      }
      parts.push("queued events: " + (g.queue_len == null ? "?" : g.queue_len));
      parts.push("reboots in 24h: " + g.reboots_24h);
      small.textContent = parts.join("  |  ");
      div.appendChild(small); gw.appendChild(div);
    }
  }catch(err){}
}
function loadAll(){ loadEvents(); loadGateways(); }
loadAll(); setInterval(loadAll, 3000);
</script></body></html>`;
