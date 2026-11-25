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
const mul = (M, v) => [0, 1, 2].map((i) => M[i][0] * v[0] + M[i][1] * v[1] + M[i][2] * v[2]);
const matT = (A) => [0, 1, 2].map((i) => [0, 1, 2].map((j) => A[j][i]));
const matMul = (A, B) => [0, 1, 2].map((i) => [0, 1, 2].map((j) => A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j]));

/** Car -> world rotation for heading psi, pitch theta (nose up +) and roll phi (left side up +). */
function carToWorld(psi, theta, phi) {
  const [cz, sz, cy, sy, cx, sx] = [Math.cos(psi), Math.sin(psi), Math.cos(-theta), Math.sin(-theta), Math.cos(phi), Math.sin(phi)];
  const Rz = [[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]];
  const Ry = [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]];
  const Rx = [[1, 0, 0], [0, cx, -sx], [0, sx, cx]];
  return matMul(Rz, matMul(Ry, Rx));
}

export const DEFAULT_ROUTE = [
  { length: 1450, curves: [{ at: 400, len: 300, angle: 35 }], grade: -2.5 },
  { length: 2100, curves: [{ at: 300, len: 250, angle: -20 }, { at: 1300, len: 400, angle: -60 }], grade: 3 },
  { length: 1200, curves: [], grade: -1.5 },
  { length: 1800, curves: [{ at: 600, len: 350, angle: 75 }], grade: 2 },
];

/**
 * @param {object} o
 *   route, hz, seed, phone: {yaw,pitch,roll} in degrees (how the phone sits in the car),
 *   accBias [3] m/s², gyroBias [3] deg/s, gyroMap 'spec'|'webkit' (how the browser reports motion; 'webkit' = iPhone Safari:
 *   rotationRate in x,y,z order and the accelerometer with the opposite sign)
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
  const truthAtt = []; // [t, pitch, heading] while moving
  const trackLengths = [];
  let t = 0, x = 0, y = 0, z = 0, psi = (o.startHeading || 0);

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
    const sign = gyroMap === 'webkit' ? -1 : 1; // iPhone: opposite handedness
    const f = mulT(M, fCar).map((v, i) => sign * v + accBias[i] + gauss(r) * vib);
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
    // cant (superelevation): the car leans into curves, ramping in over ~25 m
    const cantMax = (o.cantMax ?? 5) * DEG;
    // curvature averaged over a 50 m window, computed exactly so it ramps smoothly
    const cantAt = (s) => {
      let k = 0;
      for (const c of seg.curves) {
        const overlap = Math.max(0, Math.min(s + 25, c.at + c.len) - Math.max(s - 25, c.at));
        k += ((c.angle * DEG) / c.len) * overlap / 50;
      }
      return -Math.sign(k) * Math.min(cantMax, Math.atan((vmax * vmax * Math.abs(k)) / g));
    };
    // grade profile: dips/humps between stations, level at both platforms
    const gr = (seg.grade || 0) / 100;
    const thetaAt = (s) => Math.atan(gr * Math.sin(Math.PI * s / L) ** 2 * 1.0);
    // Kinematically consistent motion: the car's attitude is a rotation
    // matrix, and the gyro and accelerometer readings are derived from it.
    let Rprev = carToWorld(psi, 0, 0), vwPrev = [0, 0, 0];
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
      const th = thetaAt(s), k = kappa(s), phi = cantAt(s);
      psi += v * k * dt;              // heading of the track (about the world vertical)
      x += Math.cos(psi) * Math.cos(th) * ds;
      y += Math.sin(psi) * Math.cos(th) * ds;
      z += Math.sin(th) * ds;
      truth.push([x, y, z]);
      truthAtt.push([t, th, psi]);
      if (o.gps && t - lastGps >= 1) { lastGps = t; gpsFix(); }
      const R = carToWorld(psi, th, phi);
      const fwd = [R[0][0], R[1][0], R[2][0]];
      const vw = fwd.map((c) => c * v);
      const aw = vw.map((c, i) => (c - vwPrev[i]) / dt);
      const fCar = mul(matT(R), [aw[0], aw[1], aw[2] + g]);
      const dR = matMul(matT(Rprev), R);
      const wCar = [(dR[2][1] - dR[1][2]) / (2 * dt), (dR[0][2] - dR[2][0]) / (2 * dt), (dR[1][0] - dR[0][1]) / (2 * dt)];
      Rprev = R; vwPrev = vw;
      emit(fCar, wCar, true);
    }
    stopsTruth.push([x, y, z]);
    trackLengths.push(s);
    standStill(dwell, 0);
  }
  return {
    recording: {
      version: 1, kind: 'synthetic', profile: o.profile || 'metro', platform: gyroMap === 'webkit' ? 'webkit' : 'spec',
      hz, calibrationCount, samples,
      gps: o.gps ? gps : undefined, startedAt: new Date().toISOString(),
    },
    truth, stopsTruth, trackLengths, truthAtt, endHeading: psi, mount: M,
  };
}

/**
 * Synthetic sensor check (see sensorcheck.js): the phone held upright, screen
 * facing the user, then laid flat screen up over ~2 s, with a wobbly hand.
 * platform 'spec' | 'webkit'; gyroReversed flips the gyro sign (a hypothetical
 * device), to test that the check notices.
 */
export function simulateSensorCheck({ platform = 'spec', gyroReversed = false, seed = 1, turnSec = 2, hz = 60 } = {}) {
  const r = rng(seed), g = 9.80665, dt = 1 / hz;
  // world: X right, Y away from the user, Z up. Upright, screen facing the user:
  // device x = X, y = Z, z = -Y.
  const C0 = [[1, 0, 0], [0, 0, -1], [0, 1, 0]];
  const Rx = (b) => [[1, 0, 0], [0, Math.cos(b), -Math.sin(b)], [0, Math.sin(b), Math.cos(b)]];
  const Ry = (b) => [[Math.cos(b), 0, Math.sin(b)], [0, 1, 0], [-Math.sin(b), 0, Math.cos(b)]];
  const Rz = (b) => [[Math.cos(b), -Math.sin(b), 0], [Math.sin(b), Math.cos(b), 0], [0, 0, 1]];
  const total = 1 + turnSec + 1;
  const att = (t) => {
    const u = Math.min(Math.max((t - 1) / turnSec, 0), 1);
    const beta = -Math.PI / 2 * (0.5 - 0.5 * Math.cos(Math.PI * u)); // ease in/out to flat
    const wob = Math.sin(Math.PI * u);
    return matMul(Rz(0.15 * wob * Math.sin(7 * t)), matMul(Ry(0.12 * wob * Math.sin(5 * t)), matMul(Rx(beta), C0)));
  };
  const samples = [];
  let Cp = att(0);
  for (let t = 0; t <= total; t += dt) {
    const C = att(t);
    const f = mulT(C, [0, 0, g]).map((v) => v + gauss(r) * 0.05);
    const dR = matMul(matT(Cp), C);
    const w = [(dR[2][1] - dR[1][2]) / (2 * dt), (dR[0][2] - dR[2][0]) / (2 * dt), (dR[1][0] - dR[0][1]) / (2 * dt)];
    Cp = C;
    const wd = w.map((v) => (gyroReversed ? -v : v) / DEG + gauss(r) * 0.3 + 0.2);
    const a = platform === 'webkit' ? f.map((v) => -v) : f;
    const rr = platform === 'webkit' ? [wd[0], wd[1], wd[2]] : [wd[2], wd[0], wd[1]];
    samples.push({ t, a, r: rr });
  }
  return samples;
}

/**
 * A transfer: ride line A, pause, walk to line B with the phone in hand
 * (turning, swinging, a detour that turns 120° and back), resume on line B,
 * which heads turnDeg off A's last heading, with the phone lying differently.
 * Returns a recording with pause/resume marks plus truth for both lines.
 */
export function simulateTransfer(o = {}) {
  const hz = o.hz || 60, g = 9.80665, dt = 1 / hz;
  const gyroMap = o.gyroMap || 'spec', seed = o.seed ?? 4, dwell = o.dwell || 20;
  const accBias = o.accBias || [0.04, -0.03, 0.05], gyroBias = o.gyroBias || [0.15, -0.1, 0.2];
  const common = { gyroMap, accBias, gyroBias, dwell, hz };
  const A = simulateRide({ ...common, seed, route: o.routeA || DEFAULT_ROUTE.slice(0, 2), phone: o.phoneA || { yaw: 30, pitch: -70, roll: 10 } });
  const psiB = A.endHeading + (o.turnDeg ?? 110) * DEG;
  const B = simulateRide({ ...common, seed: seed + 1, route: o.routeB || DEFAULT_ROUTE.slice(2), phone: o.phoneB || { yaw: -60, pitch: 0, roll: 0 }, startHeading: psiB });

  const C1 = matMul(carToWorld(A.endHeading, 0, 0), A.mount);
  const C2 = matMul(carToWorld(psiB, 0, 0), B.mount);
  // relative rotation C1 -> C2 as axis-angle, walked along smoothly
  const Rrel = matMul(matT(C1), C2);
  const ang = Math.acos(Math.max(-1, Math.min(1, (Rrel[0][0] + Rrel[1][1] + Rrel[2][2] - 1) / 2)));
  const ax = ang > 1e-6 ? [Rrel[2][1] - Rrel[1][2], Rrel[0][2] - Rrel[2][0], Rrel[1][0] - Rrel[0][1]].map((v) => v / (2 * Math.sin(ang))) : [0, 0, 1];
  const axisAngle = (k, th) => {
    const c = Math.cos(th), s = Math.sin(th), C = 1 - c, [x, y, z] = k;
    return [[c + x * x * C, x * y * C - z * s, x * z * C + y * s], [y * x * C + z * s, c + y * y * C, y * z * C - x * s], [z * x * C - y * s, z * y * C + x * s, c + z * z * C]];
  };
  const Rz = (b) => [[Math.cos(b), -Math.sin(b), 0], [Math.sin(b), Math.cos(b), 0], [0, 0, 1]];
  const walkSec = o.walkSec || 120, r = rng(seed + 7);
  const att = (t) => {
    const u = Math.min(Math.max(t / walkSec, 0), 1), env = Math.sin(Math.PI * u);
    const detour = Rz(120 * DEG * Math.sin(Math.PI * u) ** 2);         // turn a corner and back
    const sway = axisAngle([1, 0, 0], 0.25 * env * Math.sin(2 * Math.PI * 0.9 * t));
    return matMul(detour, matMul(C1, matMul(axisAngle(ax, ang * (0.5 - 0.5 * Math.cos(Math.PI * u))), sway)));
  };
  const walkRows = [];
  const tA = A.recording.samples.at(-1)[0] / 1000 + dt;
  let Cp = att(0);
  for (let t = 0; t < walkSec; t += dt) {
    const C = att(t);
    const aw = [0.5 * Math.sin(2 * Math.PI * 1.8 * t), 0.3 * Math.cos(2 * Math.PI * 0.9 * t), 1.5 * Math.sin(2 * Math.PI * 1.8 * t)];
    const f = mulT(C, [aw[0], aw[1], aw[2] + g]).map((v, i) => (gyroMap === 'webkit' ? -v : v) + accBias[i] + gauss(r) * 0.3);
    const dR = matMul(matT(Cp), C);
    const w = [(dR[2][1] - dR[1][2]) / (2 * dt), (dR[0][2] - dR[2][0]) / (2 * dt), (dR[1][0] - dR[0][1]) / (2 * dt)];
    Cp = C;
    const wd = w.map((v, i) => v / DEG + gyroBias[i] + gauss(r) * 0.5);
    const rr = gyroMap === 'spec' ? [wd[2], wd[0], wd[1]] : [wd[0], wd[1], wd[2]];
    walkRows.push(packSample((tA + t) * 1000, f, rr));
  }
  const tB = tA + walkSec;
  const bRows = B.recording.samples.map((row) => [Math.round((row[0] / 1000 + tB) * 1e4) / 10, ...row.slice(1)]);
  const aRows = A.recording.samples;
  const pauseAt = aRows.length - Math.round((dwell / 2) * hz);
  const resumeFrom = aRows.length + walkRows.length + hz, resumeTo = resumeFrom + 3 * hz;
  const endA = A.stopsTruth.at(-1);
  return {
    recording: {
      ...A.recording, samples: [...aRows, ...walkRows, ...bRows],
      marks: [{ type: 'pause', at: pauseAt }, { type: 'resume', from: resumeFrom, to: resumeTo }],
    },
    stopsA: A.stopsTruth,
    stopsB: B.stopsTruth.map((p) => [p[0] + endA[0], p[1] + endA[1], p[2] + endA[2]]),
    walkRows: walkRows.length,
  };
}
