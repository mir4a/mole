import { Tracker, createFeeder, packSample, unpackSample, stillStats, detectPlatform } from './tracker.js';
import { requestMotionPermission, startMotion, keepAwake, motionSupported, startGeo } from './sensors.js';
import { TunnelScene } from './scene.js';
import { simulateRide } from './sim.js';
import { VEHICLES, vehicleOf, vehicleId } from './vehicles.js';
import { gpsReference, gpsDistance, gpsSpeed } from './gps.js';
import { analyzeSensorCheck, poseOf } from './sensorcheck.js';
import { loadNetwork, RouteMatcher } from './stations.js';
import * as store from './store.js';

const $ = (id) => document.getElementById(id);
const CALIB_SEC = 3, RECAL_SEC = 2.5, DEMO_SPEED = 25;
// iPhone Safari flips the accelerometer's sign (see tracker.js)
const PLATFORM = detectPlatform(navigator.userAgent, navigator.maxTouchPoints > 1);

const ui = {
  setup: $('setup'), ride: $('ride'),
  offline: $('offline-status'), sensorStatus: $('sensor-status'), calibStatus: $('calib-status'),
  meterFill: $('meter-fill'), meterLabel: $('meter-label'), meterValue: $('meter-value'),
  ring: $('ring-fg'), start: $('btn-start'),
  speed: $('hud-speed'), accel: $('hud-accel'), dist: $('hud-dist'), stops: $('hud-stops'), state: $('hud-state'),
  play: $('hud-play'), playtime: $('hud-playtime'),
  toasts: $('toasts'), debug: $('debug'), done: $('done'), bar: $('ride-bar'),
};

// ---------------- state ----------------
let motion = null;          // sensor listener
let wake = null;            // wake lock
let scene = null;
let tracker = null;
let mode = 'idle';          // idle | calibrating | live | replay | done
let meterWin = [];          // last second of samples for the stability meter
let calibBuf = [];
let recal = null;           // { buf, fromRow }
let resuming = null;        // { buf, fromRow } while calibrating on the next vehicle
let rec = null;             // current recording { meta, rows, marks }
let feeder = null, playT = 0;
let flushTimer = null, flushedRows = 0, chunkIdx = 0;
let lastFrame = performance.now();
let vehicle = 'metro';      // id in VEHICLES (js/vehicles.js)
let geo = null;             // GPS watch (bus mode)
let gpsFixes = [];          // [t_ms, lat, lon, acc, speed, heading]
let gpsRef = null;          // GPS track in the tracker's frame
let gpsCheckedAt = 0, calibT = 0;

// ---------------- formatting ----------------
const nf1 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const fmtDist = (m) => (m < 1000 ? `${Math.round(m)} m` : `${nf2.format(m / 1000)} km`);
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ---------------- vehicle ----------------
// The switch and the setup copy come from the vehicle registry.
for (const [id, v] of Object.entries(VEHICLES)) {
  const b = document.createElement('button');
  b.type = 'button'; b.setAttribute('role', 'radio'); b.dataset.vehicle = id; b.textContent = v.label;
  b.addEventListener('click', () => setVehicle(id));
  $('veh-switch').appendChild(b);
}
function setVehicle(v) {
  vehicle = vehicleId(v);
  try { localStorage.setItem('mole.vehicle', vehicle); } catch {}
  for (const b of $('veh-switch').children) b.setAttribute('aria-checked', String(b.dataset.vehicle === vehicle));
  $('start-row').hidden = !vehicleOf(vehicle).network;
  if (vehicleOf(vehicle).network) setupStations(vehicleOf(vehicle).network);
  const copy = vehicleOf(vehicle).copy;
  for (const el of document.querySelectorAll('[data-copy]')) el.textContent = copy[el.dataset.copy] ?? VEHICLES.metro.copy[el.dataset.copy];
}
try { setVehicle(localStorage.getItem('mole.vehicle') || 'metro'); } catch { setVehicle('metro'); }

// ---------------- step 1: offline ----------------
(async function offline() {
  if (!window.isSecureContext) {
    setStatus(ui.offline, 'This page is not on HTTPS, so the sensors and offline mode will not work.', 'bad');
    return;
  }
  if (!('serviceWorker' in navigator)) {
    setStatus(ui.offline, "This browser can't work offline. Keep the tab open until the ride ends.", 'bad');
    return;
  }
  try {
    await navigator.serviceWorker.register('sw.js');
    await navigator.serviceWorker.ready;
    const ok = await caches.match('vendor/three.module.min.js', { ignoreSearch: true });
    if (!ok) await new Promise((r) => setTimeout(r, 1500));
    setStatus(ui.offline, 'Ready: the page works without a network.', 'ok');
    $('st-offline').classList.add('done');
  } catch {
    setStatus(ui.offline, "Couldn't save the page for offline use. Keep the tab open until the ride ends.", 'bad');
  }
})();

// ---------------- step 2: sensors ----------------
$('btn-sensors').addEventListener('click', async () => {
  if (!motionSupported()) {
    setStatus(ui.sensorStatus, "This browser doesn't give access to motion sensors.", 'bad');
    return;
  }
  const res = await requestMotionPermission();
  // Some browsers expose requestPermission but still deliver events, so judge by the data.
  if (!motion) motion = startMotion(onSample);
  setStatus(ui.sensorStatus, 'Waiting for sensor data…');
  if (vehicleOf(vehicle).gps || vehicleOf(vehicle).network) askLocation();
  setTimeout(() => checkSensors(res), 1500);
});

function checkSensors(permission) {
  const s = motion.stats;
  if (!s.hasAccel) {
    setStatus(ui.sensorStatus, permission === 'granted'
      ? 'No sensor data. Use a phone (not a computer) and open the page over HTTPS.'
      : 'Sensor access was denied. On iPhone: Settings → Apps → Safari → Motion & Orientation Access, then reload the page.', 'bad');
    return;
  }
  const gyro = s.hasGyro ? 'gyroscope ✓' : 'no gyroscope: turns will not be drawn';
  const loc = vehicleOf(vehicle).gps && locationNote ? ` · ${locationNote}` : '';
  setStatus(ui.sensorStatus, `Accelerometer ✓ · ${gyro} · ${s.hz} Hz${loc}`, s.hasGyro && !/blocked/.test(loc) ? 'ok' : 'bad');
  $('st-sensors').classList.add('done');
  $('btn-sensors').hidden = true;
  ui.start.disabled = false;
  $('btn-check').disabled = !s.hasGyro;
}

// Above ground the GPS is the reference; ask for it early so a refusal shows
// before the ride rather than as a silently empty comparison afterwards.
let locationNote = '';
function askLocation() {
  if (!('geolocation' in navigator)) { locationNote = 'no GPS in this browser'; return; }
  locationNote = 'asking for location…';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      locationNote = 'location ✓';
      lastFix = { lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy, at: Date.now() };
      updateStartFromFix();
      refreshSensorLine();
    },
    (e) => {
      locationNote = e.code === 1
        ? 'location blocked: Settings → Privacy & Security → Location Services → Safari Websites → While Using'
        : 'no GPS fix yet';
      refreshSensorLine();
    },
    { enableHighAccuracy: true, timeout: 15000 },
  );
}
// ---------------- stations (metro): which stop is which ----------------
let network = null;         // station data for the current vehicle
let lastFix = null;         // last GPS fix above ground { lat, lon, acc, at }
let autoStart = null;       // nearest station found from lastFix
let matcher = null;         // RouteMatcher for the ride on screen
let stopNames = new Map();  // stop number -> { name, line } | 'tunnel'

async function setupStations(url) {
  network = await loadNetwork(url);
  const sel = $('start-station');
  if (!network || sel.options.length > 1) return;
  for (const [line, list] of Object.entries(network.lines)) {
    const g = document.createElement('optgroup');
    g.label = `Line ${line}`;
    list.forEach((st, i) => { const o = document.createElement('option'); o.value = `${line}:${i}`; o.textContent = `${st.name} (${line})`; g.appendChild(o); });
    sel.appendChild(g);
  }
  updateStartFromFix();
}

function updateStartFromFix() {
  if (!network) return;
  if (!lastFix) { setStatus($('start-status'), 'No location yet: pick the station, or turn on the sensors above ground.'); return; }
  const near = network.near(lastFix.lat, lastFix.lon, 1000);
  autoStart = near[0] || null;
  setStatus($('start-status'), autoStart
    ? `Nearest: ${autoStart.name}, ${Math.round(autoStart.dist)} m away.`
    : 'No metro station within 1 km of your last location: pick it here.', autoStart ? 'ok' : 'bad');
}

/** Start candidates for a ride: a station picked by hand, or the nearest one (all its lines). */
function startCandidates() {
  if (!network) return null;
  const v = $('start-station').value;
  if (v && v !== 'auto') {
    const [line, i] = v.split(':');
    return { name: network.station(line, +i).name, line, list: [{ line, index: +i }] };
  }
  if (autoStart) return { name: autoStart.name, list: network.byName(autoStart.name) };
  return null;
}

function makeMatcher(start) {
  if (!network || !start) return null;
  const list = start.line ? network.byName(start.name).filter((x) => x.line === start.line) : network.byName(start.name);
  return list.length ? new RouteMatcher(network, list) : null;
}

/** Names a stop that just happened; returns the label for its marker. */
function nameStop(stop) {
  if (!matcher) return undefined;
  const r = matcher.onStop(stop.dist ?? 0);
  if (r.kind === 'station') { stopNames.set(stop.n, { name: r.name, line: r.line }); return r.name; }
  if (r.kind === 'tunnel') { stopNames.set(stop.n, 'tunnel'); return null; }
  return undefined;
}

function refreshSensorLine() {
  if (!motion?.stats.hasAccel) return;
  checkSensors('granted');
}

function setStatus(el, text, cls = '') { el.textContent = text; el.className = 'status ' + cls; }

// ---------------- sample pipeline ----------------
function onSample({ tMs, a, r }) {
  // stability meter (setup screen)
  meterWin.push({ t: tMs / 1000, a, r });
  while (meterWin.length && tMs / 1000 - meterWin[0].t > 1) meterWin.shift();

  if (check) checkStep({ t: tMs / 1000, a, r });
  if (mode === 'calibrating') return calibrateStep(tMs, a, r);
  if (mode !== 'live') return;

  const row = packSample(tMs, a, r);
  rec.rows.push(row);
  if (recal) {
    recal.buf.push(unpackSample(row));
    if (recal.buf.at(-1).t - recal.buf[0].t >= RECAL_SEC) finishRecal();
    return;
  }
  if (resuming) return resumeStep(row);
  tracker.push(unpackSample(row));
}

function updateMeter() {
  if (mode !== 'idle' && mode !== 'calibrating') return;
  if (meterWin.length < 5) return;
  const st = stillStats(meterWin).stdA;
  const gyroMax = Math.max(0, ...meterWin.map((s) => (s.r ? Math.hypot(...s.r) : 0)));
  let label, color, still = false;
  if (st < 0.05 && gyroMax < 5) { label = 'Still'; color = 'var(--go)'; still = true; }
  else if (st < 0.15 && gyroMax < 15) { label = 'Almost still'; color = 'var(--amber)'; }
  else { label = 'Moving'; color = 'var(--halt)'; }
  ui.meterFill.style.width = `${Math.min(100, 8 + (st / 0.4) * 92)}%`;
  ui.meterFill.style.background = color;
  ui.meterLabel.textContent = label;
  ui.meterValue.textContent = `vibration ${nf2.format(st)} m/s²`;
  if (still) $('st-mount').classList.add('done');
}

// ---------------- sensor check (once per phone) ----------------
let check = null;           // { stage, buf, moved, started }
let savedCheck = null;      // result kept in this browser
try {
  const c = JSON.parse(localStorage.getItem('mole.sensorCheck') || 'null');
  if (c?.ok && c.ua === navigator.userAgent) savedCheck = c;
} catch {}
if (savedCheck) {
  setStatus($('check-status'), savedCheck.message, 'ok');
  $('st-check').classList.add('done');
  $('btn-check').textContent = 'Check again';
}

const CHECK_SAY = {
  upright: 'Hold the phone upright in front of you, screen facing you, and keep it still.',
  tilt: 'Now slowly lay it flat on your palm, screen up, and hold it still.',
};

$('btn-check').addEventListener('click', () => {
  check = { stage: 'upright', buf: [], moved: false, started: performance.now() / 1000 };
  $('check-box').hidden = false;
  $('check-say').textContent = CHECK_SAY.upright;
  $('pic-upright').setAttribute('fill', 'var(--amber)');
  $('pic-flat').setAttribute('fill', 'var(--line)');
  setStatus($('check-status'), '');
  $('btn-check').disabled = true;
});

/** The last `sec` of the buffer is still, and its gravity matches `pose`. */
function stillIn(buf, sec, pose) {
  const tEnd = buf.at(-1).t;
  const w = buf.filter((x) => x.t >= tEnd - sec);
  if (w.length < sec * 30 || tEnd - buf[0].t < sec) return false;
  if (w.some((x) => !x.r || Math.hypot(...x.r) > 8)) return false;
  if (stillStats(w).stdA > 0.25) return false;
  return poseOf(stillStats(w).meanA)?.pose === pose;
}

function checkStep(sample) {
  const c = check;
  c.buf.push(sample);
  if (sample.t - c.started > 25) return endCheck(null, "Didn't see the full move. Tap Check again and follow the two steps.");
  if (c.stage === 'upright') {
    c.buf = c.buf.filter((x) => x.t >= sample.t - 0.8);
    if (stillIn(c.buf, 0.6, 'upright')) {
      c.stage = 'tilt';
      c.buf = c.buf.filter((x) => x.t >= sample.t - 0.6);
      $('check-say').textContent = CHECK_SAY.tilt;
      $('pic-upright').setAttribute('fill', 'var(--line)');
      $('pic-flat').setAttribute('fill', 'var(--amber)');
    }
    return;
  }
  if (sample.r && Math.hypot(...sample.r) > 25) c.moved = true;
  if (c.moved && stillIn(c.buf, 0.6, 'flat')) {
    const res = analyzeSensorCheck(c.buf, 0.5);
    endCheck(res.ok ? res : null, res.message);
  }
}

function endCheck(res, message) {
  check = null;
  $('check-box').hidden = true;
  $('btn-check').disabled = false;
  if (!res) { setStatus($('check-status'), message, 'bad'); return; }
  const { results, ...keep } = res;
  savedCheck = { ...keep, ua: navigator.userAgent, at: new Date().toISOString() };
  try { localStorage.setItem('mole.sensorCheck', JSON.stringify(savedCheck)); } catch {}
  setStatus($('check-status'), message, 'ok');
  $('st-check').classList.add('done');
  $('btn-check').textContent = 'Check again';
}

// ---------------- step 4: calibration ----------------
ui.start.addEventListener('click', () => {
  wake = keepAwake();
  mode = 'calibrating';
  calibBuf = [];
  ui.start.disabled = true;
  setStatus(ui.calibStatus, "Don't touch the phone…");
  gpsFixes = []; gpsRef = null;
  if (vehicleOf(vehicle).gps && !geo) { // above ground: GPS as a reference
    geo = startGeo((fix) => gpsFixes.push(fix), (err) => {
      geo = null;
      toast(err === 'denied' ? 'No location access: the GPS comparison is off.' : 'GPS is unavailable: the comparison is off.', 'warn');
    });
  }
});

function calibrateStep(tMs, a, r) {
  calibBuf.push({ tMs, a, r });
  const samples = calibBuf.map((x) => ({ t: x.tMs / 1000, a: x.a, r: x.r }));
  const span = samples.at(-1).t - samples[0].t;
  const shaky = samples.length > 10 && (stillStats(samples).stdA > 0.18 || samples.some((s) => s.r && Math.hypot(...s.r) > 12));
  if (shaky) {
    calibBuf = [];
    setStatus(ui.calibStatus, 'The phone or the train is moving. Restarting the countdown…', 'bad');
    ui.ring.style.strokeDashoffset = 144.5;
    return;
  }
  ui.ring.style.strokeDashoffset = 144.5 * (1 - Math.min(span / CALIB_SEC, 1));
  if (span < CALIB_SEC) return;

  // calibrated: start the live ride
  tracker = new Tracker({ profile: vehicle, platform: PLATFORM, sensorCheck: savedCheck });
  const rows = calibBuf.map((x) => packSample(x.tMs, x.a, x.r));
  calibT = rows.at(-1)[0] / 1000;
  tracker.calibrate(rows.map(unpackSample));
  rec = {
    rows, marks: [], gps: gpsFixes,
    meta: {
      id: Date.now(), version: 1, kind: 'live', profile: vehicle, platform: PLATFORM, sensorCheck: savedCheck || undefined,
      startedAt: new Date().toISOString(),
      userAgent: navigator.userAgent, hz: motion.stats.hz, calibrationCount: rows.length,
    },
  };
  const start = vehicleOf(vehicle).network ? startCandidates() : null;
  if (start) rec.meta.start = { name: start.name, line: start.line };
  flushedRows = 0; chunkIdx = 0;
  store.saveRideMeta({ ...rec.meta, marks: rec.marks, sampleCount: 0 });
  flushTimer = setInterval(flush, 5000);
  mode = 'live';
  enterRide(false);
  beginStations(rec.meta.start);
  toast(`Calibrated. Waiting for the ${vehicleOf(vehicle).noun} to pull away.`);
}

async function flush() {
  if (!rec?.meta || rec.meta.kind !== 'live') return;
  const rows = rec.rows.slice(flushedRows);
  if (!rows.length) return;
  flushedRows += rows.length;
  await store.appendChunk(rec.meta.id, chunkIdx++, rows);
  await store.saveRideMeta({
    ...rec.meta, marks: rec.marks, gps: rec.gps, sampleCount: flushedRows,
    stops: tracker ? tracker.stops.length - 1 : 0, dist: tracker ? tracker.totalDist : 0,
  });
}

// ---------------- re-calibration (phone was moved) ----------------
$('btn-recal').addEventListener('click', () => {
  if (mode !== 'live' || tracker.state !== 'stopped') return;
  recal = { buf: [], fromRow: rec.rows.length };
  $('btn-recal').disabled = true;
  toast("Recalibrating: don't touch the phone for 3 seconds.");
});

function finishRecal() {
  tracker.calibrate(recal.buf);
  rec.marks.push({ type: 'recal', from: recal.fromRow, to: rec.rows.length });
  recal = null;
  $('btn-recal').disabled = false;
  $('btn-recal').hidden = true;
  toast('Done. The forward direction will be found on the next departure.', 'good');
}

// ---------------- pause for a transfer ----------------
$('btn-pause').addEventListener('click', () => {
  if (mode !== 'live') return;
  if (tracker.state !== 'paused') {
    tracker.pause();
    rec.marks.push({ type: 'pause', at: rec.rows.length });
    showPauseCard('Paused', `Walk to the next ${vehicleOf(rideKind).noun} with this page open and the screen on: the gyro carries the direction across. Then fix the phone and tap Resume while it stands.`);
    $('btn-pause').textContent = 'Resume';
  } else if (!resuming) {
    resuming = { buf: [], fromRow: rec.rows.length };
    showPauseCard('Resuming', "Don't touch the phone for 3 seconds…");
    $('btn-pause').disabled = true;
  }
});

function showPauseCard(title, text) {
  $('pause-card').hidden = false;
  $('pause-title').textContent = title;
  $('pause-text').textContent = text;
}

/** Collects a still 3 s on the new vehicle, then resumes the tracker. */
function resumeStep(row) {
  const s = unpackSample(row);
  resuming.buf.push(s);
  const buf = resuming.buf;
  const shaky = buf.length > 10 && (stillStats(buf).stdA > 0.18 || buf.some((x) => x.r && Math.hypot(...x.r) > 12));
  if (shaky) {
    resuming = { buf: [], fromRow: rec.rows.length };
    showPauseCard('Resuming', 'The phone or the vehicle is moving. Starting the 3 seconds again…');
    return;
  }
  if (buf.at(-1).t - buf[0].t < CALIB_SEC) return;
  tracker.resume(buf);
  rec.marks.push({ type: 'resume', from: resuming.fromRow, to: rec.rows.length });
  resuming = null;
  $('pause-card').hidden = true;
  $('btn-pause').textContent = 'Pause';
  $('btn-pause').disabled = false;
}

// ---------------- ride screen ----------------
/** Shows the bar buttons that belong to the current phase (data-in="ride done"). */
function setBarPhase(phase) {
  for (const b of ui.bar.querySelectorAll('[data-in]')) b.hidden = !b.dataset.in.split(' ').includes(phase);
  if (phase !== 'ride') $('btn-recal').hidden = true;
}

let rideKind = 'metro';      // vehicle of the ride on screen (live or replay)
const rideVehicle = () => vehicleOf(rideKind);
const confirmMode = () => rideVehicle().stops === 'confirm';
let confirmed = new Set();  // halts the rider marked as real stops (confirm mode)

function enterRide(isReplay, kind = vehicle) {
  rideKind = vehicleId(kind);
  confirmed = new Set();
  matcher = null;
  stopNames = new Map();
  $('hud-station').hidden = true;
  $('hud-stops-label').textContent = confirmMode() ? 'halts' : 'stops';
  ui.setup.hidden = true;
  ui.ride.hidden = false;
  ui.done.hidden = true;
  ui.play.hidden = !isReplay;
  setBarPhase('ride');
  $('btn-pause').hidden = isReplay;
  $('btn-pause').textContent = 'Pause';
  $('btn-pause').disabled = false;
  $('pause-card').hidden = true;
  resuming = null;
  $('btn-recal').hidden = true;
  if (!scene) {
    scene = new TunnelScene($('view'));
    scene.onModeChange = (m) => { $('btn-view').textContent = m === 'follow' ? 'View: overview' : 'View: follow'; };
  } else {
    scene.clear();
    scene.setMode('follow');
  }
  scene.numberStops = !confirmMode();
  scene.resize();
}

$('btn-view').addEventListener('click', () => scene.setMode(scene.mode === 'follow' ? 'overview' : 'follow'));
const VEX = [1, 5, 20];
$('btn-vex').addEventListener('click', () => {
  const v = VEX[(VEX.indexOf(scene.vex) + 1) % VEX.length];
  scene.setVex(v);
  if (mode === 'done') scene.fitAll();
  $('btn-vex').textContent = `Height ×${v}`;
});
$('btn-debug').addEventListener('click', () => { ui.debug.hidden = !ui.debug.hidden; });
$('btn-finish').addEventListener('click', finishRide);
$('btn-fit').addEventListener('click', () => scene.fitAll());
$('btn-hide-summary').addEventListener('click', () => { ui.done.hidden = true; $('btn-summary').hidden = false; });
$('btn-summary').addEventListener('click', () => { ui.done.hidden = false; $('btn-summary').hidden = true; });
$('btn-new').addEventListener('click', () => {
  ui.ride.hidden = true;
  ui.setup.hidden = false;
  mode = 'idle';
  tracker = null; feeder = null; rec = null; gpsFixes = []; gpsRef = null;
  scene.setAutoRotate(false);
  ui.start.disabled = !motion?.stats.hasAccel;
  ui.ring.style.strokeDashoffset = 144.5;
  setStatus(ui.calibStatus, '');
  refreshSaved();
});

async function finishRide() {
  if (mode === 'live') {
    clearInterval(flushTimer);
    await flush();
    wake?.release(); wake = null;
    geo?.stop(); geo = null;
  }
  mode = 'done';
  ui.debug.hidden = true;
  confirmed = new Set(rec?.meta?.confirmedStops || (rec ? [] : tracker.stops.map((_, k) => k).slice(1)));
  const last = tracker.finish();
  if (last) {
    scene.addSegment(last.points, { open: !last.arrived });
    if (last.arrived) scene.addStop(last.stop.p, last.stop.n, tracker.psi, nameStop(last.stop));
  }
  scene.setLive([]);
  updateGps(true);
  scene.setMode('overview');
  scene.setAutoRotate(true);
  setBarPhase('done');
  $('btn-summary').hidden = true;
  showSummary();
  toast('Drag to rotate · pinch to zoom · two fingers to pan', '', 6000);
}

function showSummary() {
  const tr = tracker;
  const segs = tr.segments;
  const open = segs.find((s) => s.open);
  const total = tr.totalDist;
  const dur = segs.reduce((s, x) => s + x.dur, 0);
  const gps = gpsRef?.aligned ? gpsRef.local : null;
  const pct = (est, ref) => `${est >= ref ? '+' : '−'}${Math.round(Math.abs(est / ref - 1) * 100)}%`;
  const gpsLen = (list) => (gps ? list.reduce((s, x) => s + gpsDistance(gps, x.t0, x.t1), 0) : 0);
  const gpsTotal = gpsLen(segs);
  const gpsLine = gps && gpsTotal > 50
    ? `<p class="num"><span class="gps-dot"></span>GPS ${fmtDist(gpsTotal)}: sensors are ${pct(total, gpsTotal)} off</p>`
    : '';
  const openNote = open
    ? '<p class="note">The last segment (grey) has no closing stop, so its speed drift was not corrected.</p>'
    : '';
  const halts = tr.stops.length - 1; // stops[k] ends segments[k-1]
  const confirm = confirmMode();

  // Segments as the rider sees them: in confirm mode, between confirmed stops only.
  const isBreak = (k) => (confirm ? confirmed.has(k) : stopNames.get(k) !== 'tunnel');
  const nameOf = (k) => stopNames.get(k)?.name;
  const groups = [];
  let cur = null, from = nameOf(0) || '0', num = 0;
  segs.forEach((s, i) => {
    if (!cur) cur = { dist: 0, dur: 0, vmax: 0, list: [], from };
    cur.dist += s.dist; cur.dur += s.dur; cur.vmax = Math.max(cur.vmax, s.vmax); cur.list.push(s);
    const stopNo = s.open ? null : i + 1;
    if (s.open || i === segs.length - 1 || isBreak(stopNo)) {
      const to = s.open ? 'no stop' : isBreak(stopNo) ? nameOf(stopNo) || String(++num) : 'finish';
      groups.push({ ...cur, label: `${cur.from} → ${to}` });
      from = to; cur = null;
    }
  });

  const head = segs.length
    ? confirm
      ? `<p class="num">${fmtDist(total)} · ${fmtTime(dur)} in motion · ${plural(halts, 'halt', 'halts')}, ${confirmed.size} marked as stops</p>`
      : `<p class="num">${plural(segs.length, 'segment', 'segments')} · ${fmtDist(total)} · ${fmtTime(dur)} in motion</p>`
    : '';
  const haltList = confirm && halts
    ? `<div class="halts-head"><h3>Halts</h3><p class="note">Every halt, traffic lights included, resets the speed drift. Mark the ones that were real stops to split the route there.</p></div><ul class="halts">` +
      tr.stops.slice(1).map((st, j) => {
        const k = j + 1, on = confirmed.has(k);
        const when = fmtTime(st.t - tr.stops[0].t);
        const stood = st.transfer ? ' · transfer' : st.dwell >= 1 ? ` · stood ${Math.round(st.dwell)} s` : '';
        return `<li><span class="num">${when} into the ride${stood} · ${fmtDist(st.dist ?? 0)} since the last halt</span>` +
          `<button type="button" data-halt="${k}" aria-pressed="${on}">${on ? 'Stop ✓' : 'Stop?'}</button></li>`;
      }).join('') + '</ul>'
    : '';
  $('done-summary').innerHTML = segs.length
    ? head + gpsLine + openNote + haltList
    : '<p class="note">No segments recorded. The vehicle has to pull away and stop again.</p>';
  const row = (g) => {
    const gl = gpsLen(g.list);
    const gpsCells = gps ? `<td>${gl > 20 ? fmtDist(gl) : '—'}</td><td>${gl > 20 ? pct(g.dist, gl) : '—'}</td>` : '';
    return `<tr class="num"><td>${g.label}</td><td>${fmtDist(g.dist)}</td>${gpsCells}<td>${fmtTime(g.dur)}</td><td>${Math.round(g.vmax * 3.6)} km/h</td></tr>`;
  };
  $('done-table').innerHTML = groups.length
    ? `<tr><th>${confirm ? 'Between stops' : 'Segment'}</th><th>Length</th>${gps ? '<th>GPS</th><th>Error</th>' : ''}<th>Time</th><th>Top speed</th></tr>` +
      groups.map(row).join('')
    : '';
  if (confirm) {
    let n = 0;
    scene.setStopLabels(tr.stops.map((st, k) => (k === 0 ? 'start' : st.transfer ? 'transfer' : confirmed.has(k) ? String(++n) : null)));
  }
  $('done-profile').innerHTML = elevationProfile(tr);
  $('share-note').textContent = rec
    ? 'The recording keeps the raw sensor data: you can open it here again or send it over to tune the algorithm.'
    : '';
  $('btn-share').hidden = !rec;
  ui.done.hidden = false;
}

/**
 * Elevation along the ride (relative to the start, from the gyro attitude
 * anchored to gravity at every stop) as a small SVG chart with the stops marked.
 */
function elevationProfile(tr) {
  const P = tr.path;
  if (P.length < 3) return '';
  const xs = [0];
  for (let i = 1; i < P.length; i++) xs.push(xs[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1], P[i][2] - P[i - 1][2]));
  const zs = P.map((p) => p[2]);
  const zMin = Math.min(...zs), zMax = Math.max(...zs), span = Math.max(zMax - zMin, 5);
  const W = 600, H = 150, padL = 44, padR = 8, padT = 10, padB = 18;
  const X = (d) => padL + (d / xs.at(-1)) * (W - padL - padR);
  const Y = (z) => padT + ((zMax + span * 0.05 - z) / (span * 1.1)) * (H - padT - padB);
  const line = P.map((p, i) => `${X(xs[i]).toFixed(1)},${Y(p[2]).toFixed(1)}`).join(' ');
  const stopDots = tr.stops.map((st) => {
    const i = P.findIndex((p) => Math.hypot(p[0] - st.p[0], p[1] - st.p[1], p[2] - st.p[2]) < 0.01);
    return i < 0 ? '' : `<circle cx="${X(xs[i]).toFixed(1)}" cy="${Y(P[i][2]).toFixed(1)}" r="4" fill="var(--go)"/>`;
  }).join('');
  const ticks = [zMax, (zMax + zMin) / 2, zMin].map((z) =>
    `<line x1="${padL}" x2="${W - padR}" y1="${Y(z).toFixed(1)}" y2="${Y(z).toFixed(1)}" stroke="var(--line)"/>` +
    `<text x="${padL - 6}" y="${(Y(z) + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="var(--muted)">${Math.round(z)} m</text>`).join('');
  return `<div class="profile"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Elevation profile, from ${Math.round(zMax)} to ${Math.round(zMin)} metres relative to the start">${ticks}` +
    `<polyline points="${line}" fill="none" stroke="var(--amber)" stroke-width="2.5" stroke-linejoin="round"/>${stopDots}</svg>` +
    `<div class="profile-cap"><span>Elevation relative to the start · green dots are stops</span><span>${fmtDist(xs.at(-1))}</span></div></div>`;
}

// Marking a halt as a real stop (confirm mode): saved with the ride.
$('done-summary').addEventListener('click', (e) => {
  const k = +e.target.dataset?.halt;
  if (!k) return;
  if (confirmed.has(k)) confirmed.delete(k); else confirmed.add(k);
  const list = [...confirmed].sort((a, b) => a - b);
  if (rec?.meta) {
    rec.meta.confirmedStops = list;
    if (rec.meta.id) store.updateRideMeta(rec.meta.id, { confirmedStops: list });
  }
  showSummary();
});

$('btn-share').addEventListener('click', () => exportRecording(buildRecording()));

function buildRecording() {
  return { ...rec.meta, marks: rec.marks, gps: rec.gps?.length ? rec.gps : undefined, samples: rec.rows };
}

async function exportRecording(r) {
  const d = new Date(r.startedAt || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  const name = `mole-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
  const blob = new Blob([JSON.stringify(r)], { type: 'application/json' });
  const file = new File([blob], name, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// ---------------- replay / demo ----------------
$('btn-demo').addEventListener('click', () => {
  const seed = Math.floor(Math.random() * 1000);
  const v = vehicleOf(vehicle);
  const { recording } = simulateRide({ ...v.demo, gps: v.gps, seed });
  startReplay(recording, DEMO_SPEED);
});
$('btn-open').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try { startReplay(JSON.parse(await f.text()), 20); }
  catch { setStatus($('open-status'), "Couldn't read this file. Pick a .json saved by this page.", 'bad'); }
});

function startReplay(recording, speed) {
  feeder = createFeeder(recording);
  feeder.speed = speed;
  tracker = feeder.tracker;
  rec = recording.kind === 'synthetic' ? null : { meta: { ...recording, samples: undefined, gps: undefined }, rows: recording.samples, marks: recording.marks || [], gps: recording.gps || [] };
  gpsFixes = recording.gps || [];
  gpsRef = null;
  const calN = Math.min(Math.max(recording.calibrationCount || 0, 30), recording.samples.length);
  calibT = recording.samples[calN - 1][0] / 1000;
  playT = 0;
  mode = 'replay';
  enterRide(true, recording.profile || 'metro');
  // older recordings have no start station: use one picked by hand on the setup screen
  const picked = $('start-station').value !== 'auto' ? startCandidates() : null;
  beginStations(recording.start || (picked && { name: picked.name, line: picked.line }));
  toast(recording.kind === 'synthetic' ? `Demo: synthetic ride, ×${speed}` : `Replaying recording, ×${speed}`);
}

// ---------------- saved rides ----------------
async function refreshSaved() {
  const rides = (await store.listRides()).filter((r) => r.sampleCount > 0);
  $('saved-section').hidden = !rides.length;
  const ul = $('saved-list');
  ul.innerHTML = '';
  for (const r of rides) {
    const li = document.createElement('li');
    const d = new Date(r.startedAt);
    const label = `${vehicleOf(r.profile).label} · ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}, ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} · ${plural(r.stops ?? 0, 'stop', 'stops')} · ${fmtDist(r.dist ?? 0)}`;
    li.innerHTML = '<span class="num"></span><div class="acts"><button data-a="play">View</button><button data-a="file">File</button><button data-a="del">Delete</button></div>';
    li.querySelector('span').textContent = label;
    li.addEventListener('click', async (e) => {
      const act = e.target.dataset?.a;
      if (!act) return;
      if (act === 'del') {
        if (e.target.dataset.armed) { await store.deleteRide(r.id); refreshSaved(); }
        else { e.target.dataset.armed = '1'; e.target.textContent = 'Sure?'; }
        return;
      }
      const full = await store.loadRide(r.id);
      if (act === 'play') startReplay(full, 20);
      else exportRecording(full);
    });
    ul.appendChild(li);
  }
}
refreshSaved();

// ---------------- toasts ----------------
function toast(text, kind = '', ms = 5000) {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = text;
  ui.toasts.appendChild(el);
  while (ui.toasts.children.length > 3) ui.toasts.firstChild.remove();
  setTimeout(() => el.remove(), ms);
}

function handleEvents() {
  for (const ev of tracker.events.splice(0)) {
    switch (ev.type) {
      case 'depart':
        toast(tracker.F ? 'Departing' : 'Departing. Finding the forward direction…');
        break;
      case 'axis':
        toast('Forward direction found', 'good');
        break;
      case 'stop': {
        scene.addSegment(ev.points);
        const s = ev.stop;
        const label = nameStop(s);
        scene.addStop(s.p, s.n, tracker.psi, label);
        scene.setLive([]);
        const how = `${fmtDist(s.dist)} in ${fmtTime(s.dur)}, top ${Math.round(s.vmax * 3.6)} km/h`;
        toast(confirmMode() ? `Halted after ${fmtDist(s.dist)} (${fmtTime(s.dur)}, top ${Math.round(s.vmax * 3.6)} km/h)`
          : label ? `${label}: ${how}` : label === null ? `Stopped in the tunnel after ${fmtDist(s.dist)}` : `Stop ${s.n}: ${how}`, 'good', 7000);
        break;
      }
      case 'handled':
        toast('The phone was picked up, so that last stretch was dropped.');
        break;
      case 'cancel':
        toast('That was a jolt, not a departure. The path is unchanged.');
        scene.setLive([]);
        break;
      case 'pause': {
        if (ev.closed) scene.addSegment(ev.closed.points, { open: !ev.closed.arrived });
        scene.setLive([]);
        if (ev.closed?.arrived) nameStop(ev.closed.stop);
        const here = stopNames.get(ev.stop.n);
        scene.setStopLabel(ev.stop.n, here?.name ? `${here.name} · transfer` : 'transfer', ev.stop.p, tracker.psi);
        if (mode === 'replay') toast('Paused for a transfer');
        break;
      }
      case 'resume': {
        const t = matcher?.transfer();
        if (t) {
          const before = tracker.pos.slice();
          if (t.dz != null) { tracker.shiftElevation(t.dz); scene.addLink(before, tracker.pos.slice()); }
          const h = t.dz == null ? 'height unknown' : `${Math.abs(t.dz).toFixed(0)} m ${t.dz >= 0 ? 'up' : 'down'}`;
          toast(`Transfer at ${t.from.station.name}: line ${t.from.line} → ${t.to.line}, ${h}`, 'good', 9000);
        } else if (matcher) {
          toast("Couldn't tell which line you changed to, so the height is kept.", 'warn', 8000);
        }
        toast(ev.headingKept
          ? `Resumed after ${fmtTime(ev.walkSec)}. The direction was carried across; the new forward axis comes with the first departure.`
          : "Resumed, but the screen was off during the walk: the new line's direction is a guess.", ev.headingKept ? 'good' : 'warn', 8000);
        $('pause-card').hidden = true;
        break;
      }
      case 'moved':
        if (tracker.state === 'paused') break; // walking with the phone is expected
        toast('The phone was moved. At the next stop, tap Recalibrate.', 'warn', 9000);
        if (mode === 'live') $('btn-recal').hidden = false;
        break;
    }
  }
}

// ---------------- frame loop ----------------
function frame(now) {
  const dt = Math.min((now - lastFrame) / 1000, 0.25);
  lastFrame = now;
  updateMeter();

  if (mode === 'replay' && feeder) {
    playT += dt * feeder.speed;
    const finished = feeder.feedUntil(playT);
    ui.playtime.textContent = `${fmtTime(feeder.time)} / ${fmtTime(feeder.duration)}`;
    if (finished) { handleEvents(); finishRide(); }
  }

  if (tracker && scene && (mode === 'live' || mode === 'replay' || mode === 'done')) {
    if (mode !== 'done') handleEvents();
    updateHud();
    if (tracker.state === 'moving' && mode !== 'done') scene.setLive(tracker.live);
    if (mode !== 'done') updateGps();
    updateStationHud();
    scene.setTrain(tracker.pos, tracker.psi);
    scene.render();
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/** Sets up station naming for the ride on screen from its start station. */
async function beginStations(start) {
  const url = rideVehicle().network;
  if (!url || !start) return;
  network = await loadNetwork(url);
  matcher = makeMatcher(start);
  if (!matcher) return;
  stopNames.set(0, { name: start.name, line: start.line });
  scene.setStopLabel(0, start.name);
}

/** "next Anděl" while moving, "at Radlická" while standing. */
function updateStationHud() {
  const cur = matcher?.current;
  const el = $('hud-station');
  if (!cur || mode === 'done') { el.hidden = true; return; }
  const moving = tracker.state === 'moving';
  const next = cur.dir != null ? network.station(cur.line, cur.index + cur.dir) : null;
  el.hidden = false;
  $('hud-station-label').textContent = moving && next ? 'next' : 'at';
  $('hud-station-name').textContent = moving && next ? next.name : cur.station.name;
}

/** Redraws the GPS reference track (at most once a second, or when forced). */
function updateGps(force = false) {
  const hud = $('hud-gps');
  if (!tracker || mode === 'done' || !rideVehicle().gps) { hud.hidden = true; if (!force) return; }
  if (!tracker) return;
  if (!gpsFixes.length) {
    hud.hidden = mode === 'done' || !rideVehicle().gps;
    $('hud-gps-speed').textContent = mode === 'live' ? (geo ? 'waiting' : 'off') : 'none';
    return;
  }
  const now = performance.now();
  if (!force && now - gpsCheckedAt < 1000) return;
  gpsCheckedAt = now;
  const upTo = (tracker.lastT ?? 0) + 0.5;
  const fixes = gpsFixes.filter((f) => f[0] / 1000 <= upTo);
  gpsRef = gpsReference(fixes, tracker, calibT);
  scene.setGps(gpsRef?.aligned ? gpsRef.points : []);
  const v = gpsRef ? gpsSpeed(gpsRef.local, upTo) : null;
  hud.hidden = mode === 'done';
  $('hud-gps-speed').textContent = v == null ? '—' : `${Math.round(v * 3.6)} km/h`;
}

function updateHud() {
  const tr = tracker;
  const moving = tr.state === 'moving';
  ui.speed.textContent = Math.round(tr.speed * 3.6);
  const a = moving && tr.F ? Math.max(-1.5, Math.min(1.5, tr.aF || 0)) : 0;
  ui.accel.style.left = a >= 0 ? '50%' : `${50 + (a / 1.5) * 50}%`;
  ui.accel.style.width = `${(Math.abs(a) / 1.5) * 50}%`;
  ui.accel.style.background = a >= 0 ? 'var(--go)' : 'var(--halt)';
  const live = moving && tr.seg ? tr.seg.liveDist : 0;
  ui.dist.textContent = fmtDist(tr.totalDist + live);
  ui.stops.textContent = tr.stops.length - 1;
  const st = mode === 'done' ? ['Finished', 'stopped'] : recal || resuming ? ['Calibrating', 'seeking'] : tr.state === 'paused' ? ['Paused', 'seeking'] : !moving ? ['Stopped', 'stopped'] : tr.F ? ['Moving', 'moving'] : ['Finding forward', 'seeking'];
  ui.state.textContent = st[0];
  ui.state.className = 'chip ' + st[1];
  if (mode === 'live' && tr.movedAlert && !moving) $('btn-recal').hidden = false;

  if (!ui.debug.hidden) {
    const deg = (x) => nf1.format((x * 180) / Math.PI);
    ui.debug.textContent = [
      `sensors   ${motion && mode === 'live' ? motion.stats.hz + ' Hz, gyroscope ' + (motion.stats.hasGyro ? 'yes' : 'no') : 'replay'}`,
      `vibration ${nf2.format(tr.winStd || 0)} m/s², still threshold ${nf2.format(tr.stillThreshold)}`,
      `horizontal accel ${nf2.format(tr.hMag || 0)} m/s²`,
      `gyro axes ${tr.gyroMap}, forward ${tr.F ? 'found' : 'searching'}`,
      `heading ${deg(tr.psi)}°, pitch ${deg(tr.theta)}°`,
      `raw speed ${nf2.format(tr.v)} m/s`,
      `speed bias fixes: ${tr.segments.map((s) => nf2.format(s.bias)).join(' / ') || '—'} m/s²`,
      rec ? `recorded ${rec.rows.length} samples` : '',
    ].join('\n');
  }
}

window.addEventListener('beforeunload', (e) => {
  if (mode === 'live') { flush(); e.preventDefault(); }
});
