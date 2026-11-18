// Synthetic metro ride: produces a recording in the same format as the app,
// plus the ground-truth path. Used for the "demo" button and for tests.
import { packSample } from './tracker.js';

const DEG = Math.PI / 180;

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(r) {
  return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
}

// rotation matrix from yaw/pitch/roll (device -> car)
function rotMatrix(yaw, pitch, roll) {
  const [cy, sy, cp, sp, cr, sr] = [Math.cos(yaw), Math.sin(yaw), Math.cos(pitch), Math.sin(pitch), Math.cos(roll), Math.sin(roll)];
  return [
    [cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr],
    [sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr],
    [-sp, cp * sr, cp * cr],
  ];
}
const mulT = (M, v) => [0, 1, 2].map((j) => M[0][j] * v[0] + M[1][j] * v[1] + M[2][j] * v[2]);

// A city bus: short hops, right-angle turns at junctions, steeper grades.
export const BUS_ROUTE = [
  { length: 420, curves: [{ at: 150, len: 22, angle: 90 }], grade: 4 },
  { length: 310, curves: [], grade: -3 },
  { length: 560, curves: [{ at: 80, len: 25, angle: -90 }, { at: 380, len: 60, angle: 30 }], grade: 6 },
  { length: 380, curves: [{ at: 200, len: 40, angle: -45 }], grade: -5 },
  { length: 470, curves: [{ at: 120, len: 22, angle: 90 }], grade: 2 },
];

export const BUS_OPTS = { profile: 'bus', route: BUS_ROUTE, vmax: 13, aAcc: 1.3, aDec: 1.5, dwell: 15, vibration: 0.6, vibrationStill: 0.06 };

export const DEFAULT_ROUTE = [
  { length: 1450, curves: [{ at: 400, len: 300, angle: 35 }], grade: -2.5 },
  { length: 2100, curves: [{ at: 300, len: 250, angle: -20 }, { at: 1300, len: 400, angle: -60 }], grade: 3 },
  { length: 1200, curves: [], grade: -1.5 },
  { length: 1800, curves: [{ at: 600, len: 350, angle: 75 }], grade: 2 },
];

/**
 * @param {object} o
 *   route, hz, seed, phone: {yaw,pitch,roll} in degrees (how the phone sits in the car),
 *   accBias [3] m/s², gyroBias [3] deg/s, gyroMap 'spec'|'xyz' (how rotationRate is reported)
 */
export function simulateRide(o = {}) {
  const route = o.route || DEFAULT_ROUTE;
  const hz = o.hz || 60, dt = 1 / hz;
  const r = rng(o.seed ?? 7);
  const ph = o.phone || { yaw: 30, pitch: -70, roll: 10 };
  const M = rotMatrix(ph.yaw * DEG, ph.pitch * DEG, ph.roll * DEG);
  const accBias = o.accBias || [0.04, -0.03, 0.05];
  const gyroBias = o.gyroBias || [0.15, -0.1, 0.2];
  const gyroMap = o.gyroMap || 'spec';
  const vmax = o.vmax || 20, aAcc = o.aAcc || 1.0, aDec = o.aDec || 1.1, dwell = o.dwell || 25, g = 9.80665;
  const vibMove = o.vibration ?? 0.25, vibStill = o.vibrationStill ?? 0.02;

  const samples = [];
  const truth = [[0, 0, 0]];
  const stopsTruth = [[0, 0, 0]];
  const trackLengths = [];
  let t = 0, x = 0, y = 0, z = 0, psi = 0;

  // optional GPS: the route rotated to a random compass heading, 1 Hz, ~4 m noise
  const gps = [];
  let lastGps = -1;
  const rot = r() * 2 * Math.PI, lat0 = 50.08, lon0 = 14.42;
  // phone GNSS error drifts slowly rather than jumping every second
  let ne = 0, nn = 0;
  const gpsFix = () => {
    ne = 0.9 * ne + 0.44 * gauss(r) * 4; nn = 0.9 * nn + 0.44 * gauss(r) * 4;
    const e = Math.cos(rot) * x - Math.sin(rot) * y + ne;
    const n = Math.sin(rot) * x + Math.cos(rot) * y + nn;
    gps.push([Math.round(t * 1000), lat0 + n / 111320, lon0 + e / (111320 * Math.cos(lat0 * DEG)), 5, null, null]);
  };

  const emit = (fCar, wCar, moving) => {
    const vib = moving ? vibMove : vibStill;
    const f = mulT(M, fCar).map((v, i) => v + accBias[i] + gauss(r) * vib);
    const wd = mulT(M, wCar).map((v, i) => v / DEG + gyroBias[i] + gauss(r) * (moving ? 0.6 : 0.05));
    const rr = gyroMap === 'spec' ? [wd[2], wd[0], wd[1]] : [wd[0], wd[1], wd[2]];
    samples.push(packSample(t * 1000, f, rr));
    t += dt;
  };
  const standStill = (sec, theta) => {
    for (let i = 0; i < sec * hz; i++) {
      emit([g * Math.sin(theta), 0, g * Math.cos(theta)], [0, 0, 0], false);
      if (o.gps && t - lastGps >= 1) { lastGps = t; gpsFix(); }
    }
  };

  const calibrationCount = 4 * hz;
  standStill(4 + dwell * 0.5, 0);

  for (const seg of route) {
    const L = seg.length;
    let s = 0, v = 0;
    const kappa = (s) => {
      for (const c of seg.curves) if (s >= c.at && s < c.at + c.len) return (c.angle * DEG) / c.len;
      return 0;
    };
    // grade profile: dips/humps between stations, level at both platforms
    const gr = (seg.grade || 0) / 100;
    const thetaAt = (s) => Math.atan(gr * Math.sin(Math.PI * s / L) ** 2 * 1.0);
    const dThetaDs = (s) => (gr * 2 * Math.sin(Math.PI * s / L) * Math.cos(Math.PI * s / L) * Math.PI / L) / (1 + (gr * Math.sin(Math.PI * s / L) ** 2) ** 2);
    while (s < L) {
      const remain = L - s;
      let a;
      // slow down for curves: lateral acceleration stays under ~1.5 m/s²
      let vCap = vmax, brakeFor = false;
      for (const c of seg.curves) {
        const vc = Math.min(vmax, Math.sqrt(1.5 / Math.abs((c.angle * DEG) / c.len)));
        if (s >= c.at && s < c.at + c.len) vCap = Math.min(vCap, vc);
        else if (c.at > s && v > vc && (v * v - vc * vc) / (2 * aDec) >= c.at - s - 1) brakeFor = true;
      }
      if (v * v / (2 * aDec) >= remain) a = -Math.max(v * v / (2 * Math.max(remain, 0.05)), 0.2);
      else if (brakeFor) a = -aDec;
      else if (v < vCap - 0.05) a = aAcc;
      else if (v > vCap + 0.05) a = -aDec;
      else a = 0;
      v = Math.max(v + a * dt, 0);
      if (v === 0 && remain < 2) break;
      const ds = v * dt;
      s += ds;
      const th = thetaAt(s), k = kappa(s);
      const yawRate = v * k, pitchRate = v * dThetaDs(s);
      psi += yawRate * dt;
      x += Math.cos(psi) * Math.cos(th) * ds;
      y += Math.sin(psi) * Math.cos(th) * ds;
      z += Math.sin(th) * ds;
      truth.push([x, y, z]);
      if (o.gps && t - lastGps >= 1) { lastGps = t; gpsFix(); }
      emit([a + g * Math.sin(th), v * yawRate, g * Math.cos(th)], [0, -pitchRate, yawRate], true);
    }
    stopsTruth.push([x, y, z]);
    trackLengths.push(s);
    standStill(dwell, 0);
  }
  return {
    recording: {
      version: 1, kind: 'synthetic', profile: o.profile || 'metro', hz, calibrationCount, samples,
      gps: o.gps ? gps : undefined, startedAt: new Date().toISOString(),
    },
    truth, stopsTruth, trackLengths,
  };
}
