// Dead reckoning for a rail vehicle from a phone rigidly fixed inside it.
//
// Assumptions (the "heavy vehicle" prior):
//   * the car only moves along its own longitudinal axis (no sideslip),
//   * motion is smooth and low-frequency, accelerations stay below ~1.5 m/s²,
//   * grades are small (|pitch| < ~4°),
//   * every stop is a zero-velocity update (ZUPT): speed there is exactly 0.
//
// Pipeline per sample:
//   accelerometer (incl. gravity) + gyro  ->  forward accel, yaw rate, pitch rate
//   -> speed -> position.  Between two stops the speed drift is removed by
//   forcing v=0 at the stop (constant accelerometer-bias model) and pitch drift
//   by matching the pitch measured from gravity at the stop.
//
// Sample format: { t: seconds, a: [x,y,z] m/s² incl. gravity (device frame),
//                  r: [alpha, beta, gamma] deg/s from DeviceMotionEvent.rotationRate or null }

export const DEG = Math.PI / 180;

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.sqrt(dot(a, a));
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const normalize = (a) => scale(a, 1 / (len(a) || 1));
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// The spec says alpha=z, beta=x, gamma=y, but implementations have disagreed
// over the years. Both candidates are tried; the one whose rotation lines up
// with the vertical while the train turns wins.
export const GYRO_MAPS = {
  spec: (r) => [r[1], r[2], r[0]],
  xyz: (r) => [r[0], r[1], r[2]],
};

const DEFAULTS = {
  winSec: 1.0,        // vibration window
  departAcc: 0.18,    // m/s², low-passed horizontal accel that means "we started"
  departHold: 0.4,    // s it must persist
  minStillSec: 1.5,   // s of quiet + no acceleration before calling it a stop
  stopAcc: 0.2,       // m/s², horizontal accel allowed at a (level) stop
  slopeAcc: 0.45,     // m/s², allowed when standing on a grade (~4.5 %) ...
  slopeStillSec: 6,   // ... if it lasts this long
  lockSec: 1.5,       // s of strong accel needed to lock the forward axis
  maxPitch: 4.5 * DEG,
  moveRate: 0.6,      // rad/s; faster rotation means the phone itself was moved
  minSegDist: 15,     // m; shorter "rides" are treated as false departures
  pointStep: 2,       // m between stored path points
};

export class Tracker {
  constructor(opts = {}) {
    this.o = { ...DEFAULTS, ...opts };
    this.calibrated = false;
    this.events = [];
  }

  // ---------- calibration ----------

  /** Initial calibration from a few seconds of samples with the train standing still. */
  calibrate(samples) {
    const st = stillStats(samples);
    this.gMag = len(st.meanA);
    this.U0 = normalize(st.meanA);          // "up" in device coordinates
    this.g0 = st.meanA;                     // current gravity estimate (updated at stops)
    this.rBias = st.meanR;                  // raw gyro bias (deg/s, alpha/beta/gamma)
    const helper = Math.abs(this.U0[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    this.E1 = normalize(cross(this.U0, helper));
    this.E2 = cross(this.U0, this.E1);
    this.F = null; this.L = null;           // forward / left axes, learned at first departure
    this.fStats = newFStats();
    this.quietStd = Math.max(st.stdA, 0.005);
    this.moveStd = null;
    this.gyroMap = this.gyroMap || 'spec';
    this.mapEnergy = this.mapEnergy || { spec: [0, 0], xyz: [0, 0] };

    if (!this.calibrated) {
      this.pos = [0, 0, 0];
      this.psi = 0;            // heading, rad (0 = initial direction of travel)
      this.path = [[0, 0, 0]]; // finalized polyline, world frame x fwd, y left, z up
      this.stops = [{ p: [0, 0, 0], t: samples.at(-1)?.t ?? 0, dwell: 0, n: 0 }];
      this.segments = [];
      this.totalDist = 0;
    }
    this.theta = 0;
    this.thetaStation = 0;
    this.v = 0;
    this.state = 'stopped';
    this.win = [];
    this.lpA = st.meanA.slice();
    this.lpR = [0, 0, 0];
    this.lastT = samples.at(-1)?.t ?? null;
    this.departT = 0; this.loudT = 0; this.quietT = 0; this.stillT = 0; this.slopeT = 0;
    this.seg = null;
    this.live = [];
    this.calibrated = true;
    this.movedAlert = false;
  }

  get stillThreshold() {
    const q = this.quietStd;
    if (this.moveStd && this.moveStd > q * 2) return clamp(Math.sqrt(q * this.moveStd), q * 1.8, 0.4);
    return clamp(q * 4, 0.05, 0.3);
  }

  // ---------- streaming ----------

  push(s) {
    if (!this.calibrated) return;
    const o = this.o;
    const dt = this.lastT == null ? 0 : clamp(s.t - this.lastT, 0, 0.1);
    this.lastT = s.t;

    // vibration window
    this.win.push(s);
    while (this.win.length && s.t - this.win[0].t > o.winSec) this.win.shift();
    this.winStd = stdA(this.win);

    // low-pass (~1 Hz) for direction / departure detection
    const k = 1 - Math.exp(-dt * 2 * Math.PI * 1.0);
    for (let i = 0; i < 3; i++) this.lpA[i] += (s.a[i] - this.lpA[i]) * k;
    const rRaw = s.r ? sub(s.r, this.rBias) : [0, 0, 0];
    const kr = 1 - Math.exp(-dt * 2 * Math.PI * 0.3);
    for (let i = 0; i < 3; i++) this.lpR[i] += (rRaw[i] - this.lpR[i]) * kr;

    const hv = sub(this.lpA, this.g0);
    const hUp = dot(hv, this.U0);
    const h = sub(hv, scale(this.U0, hUp));
    this.hMag = len(h);

    const w = scale(GYRO_MAPS[this.gyroMap](rRaw), DEG);
    if (len(w) > o.moveRate && this.seg) this.seg.handled = true; // a train never turns this fast
    if (len(w) > o.moveRate && !this.movedAlert) {
      this.movedAlert = true;
      this.events.push({ type: 'moved', t: s.t });
    }

    const thr = this.stillThreshold;
    const quiet = this.winStd < thr;
    this.quietT = quiet ? this.quietT + dt : 0;
    // Smooth acceleration and braking are quiet too, so a stop also needs
    // the horizontal acceleration to be gone (measured on a real ride).
    this.stillT = quiet && this.hMag < o.stopAcc ? this.stillT + dt : 0;
    this.slopeT = quiet && this.hMag < o.slopeAcc ? this.slopeT + dt : 0;

    if (this.state === 'stopped') {
      if (quiet) {
        const kq = 1 - Math.exp(-dt / 8);
        for (let i = 0; i < 3; i++) this.g0[i] += (s.a[i] - this.g0[i]) * kq;
        if (s.r) for (let i = 0; i < 3; i++) this.rBias[i] += (s.r[i] - this.rBias[i]) * kq;
        this.quietStd += (this.winStd - this.quietStd) * (1 - Math.exp(-dt / 20));
      }
      this.departT = this.hMag > o.departAcc ? this.departT + dt : 0;
      this.loudT = this.winStd > thr * 2.5 ? this.loudT + dt : 0;
      if (this.departT >= o.departHold || this.loudT >= 0.8) this.startSegment(s.t);
      this.stops.at(-1).dwell = s.t - this.stops.at(-1).t;
      return;
    }

    // ---- moving ----
    this.seg.samples.push(s);
    if (!quiet) this.moveStd = this.moveStd == null ? this.winStd
      : this.moveStd + (this.winStd - this.moveStd) * (1 - Math.exp(-dt / 30));

    // gyro axis-mapping evidence: low-passed rotation energy along the vertical
    for (const name of Object.keys(GYRO_MAPS)) {
      const lw = GYRO_MAPS[name](this.lpR);
      const e = this.mapEnergy[name];
      e[0] += dot(lw, this.U0) ** 2 * dt;
      e[1] += dot(lw, lw) * dt;
    }

    this.accumulateF(h, dt);
    if (!this.F && this.fStats.time >= o.lockSec) {
      this.lockF();
      this.replayLive();
    } else if (this.F) {
      this.stepLive(s, w, dt);
    }

    const segDur = s.t - this.seg.t0;
    if (segDur > 3 && (this.stillT >= o.minStillSec || this.slopeT >= o.slopeStillSec)) {
      this.endSegment(s.t - (this.stillT >= o.minStillSec ? this.stillT : this.slopeT));
    }
  }

  // ---------- forward axis ----------

  accumulateF(h, dt) {
    const c1 = dot(h, this.E1), c2 = dot(h, this.E2);
    if (Math.hypot(c1, c2) < this.o.departAcc * 0.8) return;
    const f = this.fStats;
    f.sxx += c1 * c1 * dt; f.sxy += c1 * c2 * dt; f.syy += c2 * c2 * dt;
    if (!this.F) { f.sx += c1 * dt; f.sy += c2 * dt; }
    f.time += dt;
  }

  lockF(keepSignOf = null) {
    const f = this.fStats;
    const phi = 0.5 * Math.atan2(2 * f.sxy, f.sxx - f.syy);
    let F = add(scale(this.E1, Math.cos(phi)), scale(this.E2, Math.sin(phi)));
    const ref = keepSignOf || add(scale(this.E1, f.sx), scale(this.E2, f.sy));
    if (dot(F, ref) < 0) F = scale(F, -1);
    this.F = F;
    this.L = cross(this.U0, this.F);
    if (!keepSignOf) this.events.push({ type: 'axis', t: this.lastT });
  }

  // ---------- live (provisional) integration ----------

  stepLive(s, w, dt) {
    const r = dot(w, this.U0);
    this.psi += r * dt;
    // pitch stays at the departure station's value while moving: on a real ride
    // the phone gyro showed ~0.15°/s of false pitch rate under vibration
    // live view only: subtract the accelerometer bias learned on earlier segments
    const aF = dot(s.a, this.F) - this.gMag * Math.sin(this.theta) - this.biasPrior;
    this.v += aF * dt;
    this.aF = aF;
    const vp = Math.max(this.v, 0);
    const d = vp * dt;
    this.pos = add(this.pos, dirVec(this.psi, this.theta, d));
    this.seg.liveDist += d;
    const last = this.live.at(-1);
    if (!last || dist(last, this.pos) >= 1) this.live.push(this.pos.slice());
  }

  replayLive() {
    const seg = this.seg;
    this.pos = seg.p0.slice(); this.psi = seg.psi0; this.theta = seg.theta0; this.v = 0;
    this.live = [this.pos.slice()]; seg.liveDist = 0;
    let lt = seg.samples[0]?.t;
    for (const s of seg.samples) {
      const dt = clamp(s.t - lt, 0, 0.1); lt = s.t;
      const rr = s.r ? sub(s.r, seg.rBias) : [0, 0, 0];
      this.stepLive(s, scale(GYRO_MAPS[this.gyroMap](rr), DEG), dt);
    }
  }

  // ---------- segments ----------

  startSegment(t) {
    const back = this.o.departHold + 0.3;
    const pre = this.win.filter((x) => x.t >= t - back);
    this.seg = {
      t0: pre[0]?.t ?? t,
      samples: pre.slice(),
      p0: this.pos.slice(), psi0: this.psi, theta0: this.thetaStation,
      rBias: this.rBias.slice(), liveDist: 0,
    };
    this.theta = this.thetaStation;
    this.v = 0;
    this.live = [this.pos.slice()];
    this.state = 'moving';
    this.departT = this.loudT = 0;
    this.events.push({ type: 'depart', t });
    if (this.F) this.replayLive();
  }

  endSegment(tStop) {
    const seg = this.seg;
    // pitch at the stop, from gravity measured over the quiet window
    const quietSamples = this.win.filter((x) => x.t >= tStop);
    const mA = stillStats(quietSamples.length ? quietSamples : this.win).meanA;
    this.g0 = mA.slice();
    if (!this.F && this.fStats.time > 0.3) this.lockF();
    const thetaEnd = this.F ? clamp(Math.asin(clamp(dot(normalize(mA), this.F), -1, 1)), -this.o.maxPitch, this.o.maxPitch) : 0;

    // first ride: refine the axis with braking samples too, keeping the sign
    if (this.F && this.segments.length === 0) this.lockF(this.F);
    if (this.mapEnergy && this.F) this.chooseGyroMap();

    let result = null;
    if (this.F) {
      const end = seg.samples.findIndex((x) => x.t >= tStop);
      const samples = end > 0 ? seg.samples.slice(0, end + 1) : seg.samples;
      result = integrateSegment(samples, {
        F: this.F, L: this.L, U: this.U0, gMag: this.gMag, rBias: seg.rBias,
        map: GYRO_MAPS[this.gyroMap], p0: seg.p0, psi0: seg.psi0, theta0: seg.theta0,
        thetaEnd, maxPitch: this.o.maxPitch, step: this.o.pointStep,
      });
    }

    this.state = 'stopped';
    this.v = 0;
    this.live = [];
    this.seg = null;
    this.quietT = this.stillT = this.slopeT = 0;

    if (!result || seg.handled || result.dist < this.o.minSegDist || result.vmax < 1) {
      // false departure: roll back to the stop position
      this.pos = seg.p0.slice(); this.psi = seg.psi0; this.theta = this.thetaStation;
      this.events.push({ type: 'cancel', t: tStop });
      return;
    }

    this.path.push(...result.points.slice(1));
    this.pos = result.points.at(-1).slice();
    this.psi = result.psiEnd;
    this.theta = this.thetaStation = thetaEnd;
    this.totalDist += result.dist;
    const stop = { p: this.pos.slice(), t: tStop, dwell: 0, n: this.stops.length, dist: result.dist, dur: result.dur, vmax: result.vmax, bias: result.bias };
    this.stops.push(stop);
    this.segments.push({ ...result, points: undefined, t0: seg.t0, t1: tStop });
    this.events.push({ type: 'stop', t: tStop, stop, points: result.points, liveDist: seg.liveDist });
  }

  chooseGyroMap() {
    const ratio = (e) => (e[1] > 1e-6 ? e[0] / e[1] : 0);
    const enough = this.mapEnergy.spec[1] > 0.002; // need some real turning
    if (!enough) return;
    const best = ratio(this.mapEnergy.xyz) > ratio(this.mapEnergy.spec) * 1.3 ? 'xyz' : 'spec';
    if (best !== this.gyroMap) {
      this.gyroMap = best;
      this.events.push({ type: 'gyromap', map: best });
    }
  }

  get biasPrior() {
    if (!this.segments?.length) return 0;
    const b = this.segments.filter((s) => !s.open).map((s) => s.bias).sort((x, y) => x - y);
    if (!b.length) return 0;
    return clamp(b[b.length >> 1], -0.15, 0.15);
  }

  /**
   * Ends the ride. Returns { points, arrived } for a segment closed by this
   * call, or null.
   *  - If the phone was picked up during the segment, that segment is dropped.
   *  - If the train is braking, Finish counts as the arrival: the segment gets
   *    the v=0 correction, so the user need not wait for a full stop.
   *  - Otherwise the segment is kept open with only the bias prior.
   */
  finish() {
    const seg = this.seg;
    let out = null;
    if (this.state === 'moving' && seg?.handled) {
      this.pos = seg.p0.slice(); this.psi = seg.psi0;
      this.events.push({ type: 'handled', t: this.lastT });
    } else if (this.state === 'moving' && this.F && seg && seg.samples.length > 1) {
      const arrived = this.isBraking(seg);
      const result = integrateSegment(seg.samples, {
        F: this.F, L: this.L, U: this.U0, gMag: this.gMag, rBias: seg.rBias,
        map: GYRO_MAPS[this.gyroMap], p0: seg.p0, psi0: seg.psi0, theta0: seg.theta0,
        thetaEnd: null, fixedBias: arrived ? undefined : this.biasPrior,
        maxPitch: this.o.maxPitch, step: this.o.pointStep,
      });
      if (result.dist >= this.o.minSegDist) {
        this.path.push(...result.points.slice(1));
        this.pos = result.points.at(-1).slice();
        this.psi = result.psiEnd;
        this.totalDist += result.dist;
        this.segments.push({ ...result, points: undefined, t0: seg.t0, t1: this.lastT, open: !arrived });
        if (arrived) {
          this.stops.push({ p: this.pos.slice(), t: this.lastT, dwell: 0, n: this.stops.length, dist: result.dist, dur: result.dur, vmax: result.vmax, bias: result.bias });
        }
        out = { points: result.points, arrived, stop: arrived ? this.stops.at(-1) : null };
      }
    }
    this.state = 'finished';
    this.seg = null; this.live = []; this.v = 0;
    return out;
  }

  /** Mean forward acceleration over the last 3 s is clearly negative. */
  isBraking(seg) {
    const tEnd = seg.samples.at(-1).t;
    const tail = seg.samples.filter((x) => x.t >= tEnd - 3);
    if (tail.length < 10) return false;
    const g = this.gMag * Math.sin(seg.theta0);
    const a = tail.reduce((sum, x) => sum + dot(x.a, this.F) - g, 0) / tail.length - this.biasPrior;
    return a < -0.25;
  }

  /** Current speed for display (m/s), never negative. */
  get speed() { return this.state === 'moving' ? Math.max(this.v, 0) : 0; }
}

// ---------- pure helpers ----------

function newFStats() { return { sxx: 0, sxy: 0, syy: 0, sx: 0, sy: 0, time: 0 }; }

function dirVec(psi, theta, d) {
  const c = Math.cos(theta) * d;
  return [Math.cos(psi) * c, Math.sin(psi) * c, Math.sin(theta) * d];
}

function dist(a, b) { return len(sub(a, b)); }

function stdA(win) {
  const n = win.length;
  if (n < 3) return 0;
  let m = [0, 0, 0];
  for (const s of win) m = add(m, s.a);
  m = scale(m, 1 / n);
  let v = 0;
  for (const s of win) { const d = sub(s.a, m); v += dot(d, d); }
  return Math.sqrt(v / n);
}

export function stillStats(samples) {
  const n = samples.length || 1;
  let mA = [0, 0, 0], mR = [0, 0, 0], nr = 0;
  for (const s of samples) {
    mA = add(mA, s.a);
    if (s.r) { mR = add(mR, s.r); nr++; }
  }
  mA = scale(mA, 1 / n);
  mR = nr ? scale(mR, 1 / nr) : [0, 0, 0];
  return { meanA: mA, meanR: mR, stdA: stdA(samples) };
}

/**
 * Re-integrates one stop-to-stop segment with the ZUPT constraints:
 * the grade is interpolated between the pitches measured from gravity at both stops,
 * speed drift is spread linearly so that it ends at exactly 0.
 */
export function integrateSegment(samples, c) {
  const n = samples.length;
  const t0 = samples[0].t, T = Math.max(samples[n - 1].t - t0, 1e-3);
  const psi = new Float64Array(n), th = new Float64Array(n), dts = new Float64Array(n);
  let p = c.psi0;
  for (let i = 0; i < n; i++) {
    const s = samples[i];
    const dt = i ? clamp(s.t - samples[i - 1].t, 0, 0.1) : 0;
    dts[i] = dt;
    const rr = s.r ? sub(s.r, c.rBias) : [0, 0, 0];
    const w = scale(c.map(rr), DEG);
    p += dot(w, c.U) * dt;
    psi[i] = p;
  }
  // Grade: interpolated between the two stops, where it is measured from gravity.
  // The gyro's pitch rate is not trusted (vibration makes it drift).
  const thEnd = c.thetaEnd ?? c.theta0;
  let v = 0;
  const vr = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    th[i] = clamp(c.theta0 + (thEnd - c.theta0) * (samples[i].t - t0) / T, -c.maxPitch, c.maxPitch);
    v += (dot(samples[i].a, c.F) - c.gMag * Math.sin(th[i])) * dts[i];
    vr[i] = v;
  }
  // m/s² — residual accelerometer bias along the track (ZUPT), or a given prior
  // when the segment has no closing stop
  const bias = c.fixedBias ?? vr[n - 1] / T;
  let pos = c.p0.slice(), d = 0, vmax = 0;
  const points = [pos.slice()];
  for (let i = 0; i < n; i++) {
    const vi = Math.max(vr[i] - bias * (samples[i].t - t0), 0);
    vmax = Math.max(vmax, vi);
    const step = vi * dts[i];
    pos = add(pos, dirVec(psi[i], th[i], step));
    d += step;
    if (dist(points.at(-1), pos) >= c.step) points.push(pos.slice());
  }
  if (dist(points.at(-1), pos) > 0.01) points.push(pos.slice());
  return { points, dist: d, vmax, bias, psiEnd: psi[n - 1], dur: T };
}

/**
 * Feeds a recording into a fresh tracker, honoring the calibration and
 * re-calibration marks stored with it. feedUntil(tSec) advances playback
 * (time relative to the first sample) and returns true when finished.
 */
export function createFeeder(rec, opts) {
  const samples = rec.samples.map(unpackSample);
  const tr = new Tracker(opts);
  const calN = Math.min(Math.max(rec.calibrationCount || 0, 30), samples.length);
  tr.calibrate(samples.slice(0, calN));
  const recals = (rec.marks || []).filter((m) => m.type === 'recal').sort((a, b) => a.from - b.from);
  const t0 = samples[0]?.t ?? 0;
  let i = calN;
  return {
    tracker: tr,
    duration: (samples.at(-1)?.t ?? 0) - t0,
    get time() { return (samples[Math.min(i, samples.length - 1)]?.t ?? t0) - t0; },
    feedUntil(tSec) {
      while (i < samples.length && samples[i].t - t0 <= tSec) {
        const m = recals.find((x) => x.from === i);
        if (m) { tr.calibrate(samples.slice(m.from, m.to)); i = m.to; continue; }
        tr.push(samples[i++]);
      }
      return i >= samples.length;
    },
  };
}

/** Run a whole recording through a fresh tracker (for tests). */
export function replayRecording(rec, opts) {
  const f = createFeeder(rec, opts);
  f.feedUntil(Infinity);
  return f.tracker;
}

/** Recording rows are flat arrays: [t_ms, ax, ay, az, alpha, beta, gamma]. */
export function unpackSample(row) {
  return {
    t: row[0] / 1000,
    a: [row[1], row[2], row[3]],
    r: row[4] == null ? null : [row[4], row[5], row[6]],
  };
}

export function packSample(t_ms, a, r) {
  const f = (x) => Math.round(x * 10000) / 10000;
  return r
    ? [Math.round(t_ms * 10) / 10, f(a[0]), f(a[1]), f(a[2]), f(r[0]), f(r[1]), f(r[2])]
    : [Math.round(t_ms * 10) / 10, f(a[0]), f(a[1]), f(a[2]), null, null, null];
}
