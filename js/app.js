import { Tracker, createFeeder, packSample, unpackSample, stillStats, detectPlatform } from './tracker.js';
import { requestMotionPermission, startMotion, keepAwake, motionSupported, startGeo } from './sensors.js';
import { TunnelScene } from './scene.js';
import { simulateRide, BUS_OPTS, TRAM_OPTS } from './sim.js';
import { gpsReference, gpsDistance, gpsSpeed } from './gps.js';
import { analyzeSensorCheck, poseOf } from './sensorcheck.js';
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
let rec = null;             // current recording { meta, rows, marks }
let feeder = null, playT = 0;
let flushTimer = null, flushedRows = 0, chunkIdx = 0;
let lastFrame = performance.now();
let vehicle = 'metro';      // metro | bus (tracker profile)
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
function setVehicle(v) {
  vehicle = ['bus', 'tram'].includes(v) ? v : 'metro';
  try { localStorage.setItem('mole.vehicle', vehicle); } catch {}
  $('veh-metro').setAttribute('aria-checked', String(vehicle === 'metro'));
  $('veh-bus').setAttribute('aria-checked', String(vehicle === 'bus'));
  $('veh-tram').setAttribute('aria-checked', String(vehicle === 'tram'));
  for (const el of document.querySelectorAll('[data-bus], [data-tram]')) {
    if (!el.dataset.metro) el.dataset.metro = el.textContent;
    el.textContent = el.dataset[vehicle] || el.dataset.metro;
  }
}
$('veh-metro').addEventListener('click', () => setVehicle('metro'));
$('veh-bus').addEventListener('click', () => setVehicle('bus'));
$('veh-tram').addEventListener('click', () => setVehicle('tram'));
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
  setStatus(ui.sensorStatus, `Accelerometer ✓ · ${gyro} · ${s.hz} Hz`, s.hasGyro ? 'ok' : 'bad');
  $('st-sensors').classList.add('done');
  $('btn-sensors').hidden = true;
  ui.start.disabled = false;
  $('btn-check').disabled = !s.hasGyro;
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
  if (vehicle !== 'metro' && !geo) { // above ground: GPS as a reference
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
  flushedRows = 0; chunkIdx = 0;
  store.saveRideMeta({ ...rec.meta, marks: rec.marks, sampleCount: 0 });
  flushTimer = setInterval(flush, 5000);
  mode = 'live';
  enterRide(false);
  toast(`Calibrated. Waiting for the ${vehicle === 'metro' ? 'train' : vehicle} to pull away.`);
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

// ---------------- ride screen ----------------
/** Shows the bar buttons that belong to the current phase (data-in="ride done"). */
function setBarPhase(phase) {
  for (const b of ui.bar.querySelectorAll('[data-in]')) b.hidden = !b.dataset.in.split(' ').includes(phase);
  if (phase !== 'ride') $('btn-recal').hidden = true;
}

function enterRide(isReplay) {
  ui.setup.hidden = true;
  ui.ride.hidden = false;
  ui.done.hidden = true;
  ui.play.hidden = !isReplay;
  setBarPhase('ride');
  $('btn-recal').hidden = true;
  if (!scene) {
    scene = new TunnelScene($('view'));
    scene.onModeChange = (m) => { $('btn-view').textContent = m === 'follow' ? 'View: overview' : 'View: follow'; };
  } else {
    scene.clear();
    scene.setMode('follow');
  }
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
  const last = tracker.finish();
  if (last) {
    scene.addSegment(last.points, { open: !last.arrived });
    if (last.arrived) scene.addStop(last.stop.p, last.stop.n, tracker.psi);
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
  const n = segs.length;
  const gps = gpsRef?.aligned ? gpsRef.local : null;
  const pct = (est, ref) => `${est >= ref ? '+' : '−'}${Math.round(Math.abs(est / ref - 1) * 100)}%`;
  const gpsTotal = gps ? segs.reduce((s, x) => s + gpsDistance(gps, x.t0, x.t1), 0) : 0;
  const gpsLine = gps && gpsTotal > 50
    ? `<p class="num"><span class="gps-dot"></span>GPS ${fmtDist(gpsTotal)}: sensors are ${pct(total, gpsTotal)} off</p>`
    : '';
  const openNote = open
    ? '<p class="note">The last segment (grey) has no closing stop, so its speed drift was not corrected.</p>'
    : '';
  $('done-summary').innerHTML = n
    ? `<p class="num">${plural(n, 'segment', 'segments')} · ${fmtDist(total)} · ${fmtTime(dur)} in motion</p>${gpsLine}${openNote}`
    : '<p class="note">No segments recorded. The vehicle has to pull away and stop again.</p>';
  const row = (label, s) => {
    const g = gps ? gpsDistance(gps, s.t0, s.t1) : 0;
    const gpsCells = gps ? `<td>${g > 20 ? fmtDist(g) : '—'}</td><td>${g > 20 ? pct(s.dist, g) : '—'}</td>` : '';
    return `<tr class="num"><td>${label}</td><td>${fmtDist(s.dist)}</td>${gpsCells}<td>${fmtTime(s.dur)}</td><td>${Math.round(s.vmax * 3.6)} km/h</td></tr>`;
  };
  $('done-table').innerHTML = n
    ? `<tr><th>Segment</th><th>Length</th>${gps ? '<th>GPS</th><th>Error</th>' : ''}<th>Time</th><th>Top speed</th></tr>` +
      segs.map((s, i) => row(s.open ? `${i} → no stop` : `${i} → ${i + 1}`, s)).join('')
    : '';
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
  const opts = { bus: BUS_OPTS, tram: TRAM_OPTS }[vehicle];
  const { recording } = simulateRide(opts ? { ...opts, gps: true, seed } : { seed });
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
  enterRide(true);
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
    const label = `${{ bus: 'Bus', tram: 'Tram' }[r.profile] || 'Metro'} · ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}, ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} · ${plural(r.stops ?? 0, 'stop', 'stops')} · ${fmtDist(r.dist ?? 0)}`;
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
        scene.addStop(ev.stop.p, ev.stop.n, tracker.psi);
        scene.setLive([]);
        const s = ev.stop;
        toast(`Stop ${s.n}: ${fmtDist(s.dist)} in ${fmtTime(s.dur)}, top ${Math.round(s.vmax * 3.6)} km/h`, 'good', 7000);
        break;
      }
      case 'handled':
        toast('The phone was picked up, so that last stretch was dropped.');
        break;
      case 'cancel':
        toast('That was a jolt, not a departure. The path is unchanged.');
        scene.setLive([]);
        break;
      case 'moved':
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
    scene.setTrain(tracker.pos, tracker.psi);
    scene.render();
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/** Redraws the GPS reference track (at most once a second, or when forced). */
function updateGps(force = false) {
  const hud = $('hud-gps');
  if (!gpsFixes.length || !tracker || mode === 'done') { hud.hidden = true; if (!force) return; }
  if (!gpsFixes.length || !tracker) return;
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
  const st = mode === 'done' ? ['Finished', 'stopped'] : recal ? ['Calibrating', 'seeking'] : !moving ? ['Stopped', 'stopped'] : tr.F ? ['Moving', 'moving'] : ['Finding forward', 'seeking'];
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
