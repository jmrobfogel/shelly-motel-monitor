// Shelly Plug US Gen4 script: listens for Shelly BLU Door/Window sensors (BTHome over Bluetooth)
// and POSTs every door state change to the Cloudflare Worker.
//
// Setup: Plug web UI -> Scripts -> Create script -> paste this -> edit CONFIG -> Save -> Start (+ "Run on startup").
// Bluetooth must be enabled on the Plug (Settings -> Bluetooth). Run only ONE BLE-scanning script at a time.
//
// Design goals for the POC:
//   * Post only when the door state actually CHANGES (plus a slow "heartbeat" so you can see a sensor is alive).
//   * Never lose an event on a network blip: events go into a queue and are retried with back-off until the
//     Worker acknowledges them. The Worker ignores duplicates, so retries are safe.
//   * Send the gateway's own clock time with each event so retried events still carry the true time.

let CONFIG = {
  URL: "https://shelly-door-monitor.jmrobfogel.workers.dev/event",
  API_KEY: "CHANGE_ME",          // must match the Worker's API_KEY secret
  GATEWAY: "plug-gen4-1",        // any label for this Plug

  // sensor Bluetooth address (lowercase, as printed in the log) -> room label
  // Turn DISCOVER on to print addresses of nearby BTHome door sensors, then copy them here.
  SENSORS: {
    "aa:bb:cc:dd:ee:ff": "Room 101"
  },

  HEARTBEAT_SEC: 600,            // how often to also record "still alive, current state"
  MAX_QUEUE: 200,                // oldest events are dropped only if the Worker is unreachable for very long
  DISCOVER: true,                // log unknown BTHome door sensors so you can find their addresses
  DEBUG: true                    // log every decoded packet (turn off once everything works)
};

let BTHOME_UUID = "fcd2";

// bytes per BTHome v2 object id (objects are sorted by id; we must know a length to skip it)
let OBJ_LEN = {
  0x00: 1,  // packet id
  0x01: 1,  // battery %
  0x02: 2,  // temperature
  0x03: 2,  // humidity
  0x05: 3,  // illuminance
  0x0c: 2,  // voltage
  0x2d: 1,  // window: 0 closed, 1 open
  0x3a: 1,  // button event
  0x3f: 2   // rotation (tilt) 0.1 degree
};

let last = {};      // addr -> { pid, state, hbTs }
let queue = [];     // pending payloads, oldest first
let busy = false;
let retryMs = 2000;

function decode(buf) {
  if (typeof buf !== "string" || buf.length < 2) return null;
  if (buf.at(0) & 1) return null;                 // encrypted BTHome, not supported here
  let out = {};
  let i = 1;
  while (i < buf.length) {
    let id = buf.at(i);
    i++;
    let len = OBJ_LEN[id];
    if (len === undefined) break;                 // unknown object: stop, keep what we have
    if (id === 0x00) out.pid = buf.at(i);
    else if (id === 0x01) out.battery = buf.at(i);
    else if (id === 0x2d) out.window = buf.at(i);
    else if (id === 0x3a) out.button = buf.at(i);
    i += len;
  }
  return out;
}

function nowSec() {
  let sys = Shelly.getComponentStatus("sys");
  if (sys && sys.unixtime) return sys.unixtime;
  return 0;                                       // clock not synced yet: Worker falls back to its own time
}

function enqueue(p) {
  queue.push(p);
  if (queue.length > CONFIG.MAX_QUEUE) queue.splice(0, 1);
  pump();
}

function pump() {
  if (busy || queue.length === 0) return;
  busy = true;
  let p = queue[0];
  Shelly.call("HTTP.Request", {
    method: "POST",
    url: CONFIG.URL,
    headers: { "Content-Type": "application/json", "x-api-key": CONFIG.API_KEY },
    body: JSON.stringify(p),
    timeout: 10,
    ssl_ca: "*"          // POC: skip certificate validation. Remove or set a CA bundle for production.
  }, function (res, err) {
    busy = false;
    let code = res ? res.code : 0;
    if (err === 0 && code >= 200 && code < 300) {
      print("SENT", p.room, p.kind, p.state, "queue left:", queue.length - 1);
      queue.splice(0, 1);
      retryMs = 2000;
      pump();
    } else if (err === 0 && code >= 400 && code < 500 && code !== 408 && code !== 429) {
      print("REJECTED by Worker (HTTP " + code + "), dropping:", JSON.stringify(p));
      queue.splice(0, 1);
      pump();
    } else {
      print("SEND FAILED (err " + err + ", http " + code + "), retry in " + retryMs + " ms, queued: " + queue.length);
      Timer.set(retryMs, false, pump);
      retryMs = retryMs * 2;
      if (retryMs > 60000) retryMs = 60000;
    }
  });
}

function onScan(ev, res) {
  if (ev !== BLE.Scanner.SCAN_RESULT) return;
  let sd = res.service_data;
  if (!sd || !sd[BTHOME_UUID]) return;

  let d = decode(sd[BTHOME_UUID]);
  if (!d || d.window === undefined) return;       // not a door/window packet

  let addr = res.addr;
  let room = CONFIG.SENSORS[addr];
  if (room === undefined) {
    if (CONFIG.DISCOVER) print("DISCOVER: door sensor", addr, "window=" + d.window, "rssi=" + res.rssi, "(add to CONFIG.SENSORS)");
    return;
  }

  let st = last[addr];
  if (st && d.pid !== undefined && st.pid === d.pid) return;   // same packet heard again, ignore

  let state = d.window === 1 ? "open" : "closed";
  let ts = nowSec();
  if (CONFIG.DEBUG) print("PKT", room, state, "pid=" + d.pid, "batt=" + d.battery, "rssi=" + res.rssi);

  let kind = null;
  if (!st) {
    kind = "heartbeat";                           // first time we hear this sensor since script start = baseline
  } else if (st.state !== state) {
    kind = "change";
  } else if (ts - st.hbTs >= CONFIG.HEARTBEAT_SEC) {
    kind = "heartbeat";
  }

  if (!st) st = { hbTs: 0 };
  st.pid = d.pid;
  st.state = state;

  if (kind === null) { last[addr] = st; return; }
  if (kind === "heartbeat") st.hbTs = ts;
  if (kind === "change") st.hbTs = ts;
  last[addr] = st;

  enqueue({
    device_id: addr,
    room: room,
    kind: kind,
    state: state,
    pid: d.pid,
    ts: ts,
    battery: d.battery,
    rssi: res.rssi,
    gateway: CONFIG.GATEWAY
  });
}

let bleCfg = Shelly.getComponentConfig("ble");
if (!bleCfg || !bleCfg.enable) {
  print("ERROR: Bluetooth is disabled on this device. Enable it in Settings -> Bluetooth.");
} else {
  let ok = BLE.Scanner.Start({ duration_ms: BLE.Scanner.INFINITE_SCAN, active: false }, onScan);
  if (ok === false) {
    print("ERROR: could not start BLE scan (is another script already scanning?)");
  } else {
    print("Door monitor running. Sensors:", JSON.stringify(CONFIG.SENSORS));
  }
}
