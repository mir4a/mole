// One-time sensor check: finds this phone's motion-sensor conventions before a
// ride, so turns and slopes are never drawn mirrored.
//
// The user holds the phone upright with the screen facing them, then lays it
// flat, screen up.
//  * Accelerometer sign: by the spec an upright phone reads y = +9.8 and a flat
//    one z = +9.8. A flipped accelerometer reads both negative. This needs the
//    known pose: from the data alone a mirrored world is just as physical.
//  * Gyro axis order and sign: gravity is propagated through the turn with each
//    candidate (dg/dt = -w x g); the right one ends where the accelerometer says
//    gravity is.

import { GYRO_MAPS } from './tracker.js';

const DEG = Math.PI / 180;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.sqrt(dot(a, a));
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const mean = (rows, k) => [0, 1, 2].map((i) => rows.reduce((s, x) => s + x[k][i], 0) / rows.length);
const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(a, b) / (len(a) * len(b))))) / DEG;

function rotate(v, w, dt) {
  const th = len(w) * dt;
  if (th < 1e-12) return v;
  const k = w.map((x) => x / len(w)), c = Math.cos(-th), s = Math.sin(-th), kd = dot(k, v), kx = cross(k, v);
  return [0, 1, 2].map((i) => v[i] * c + kx[i] * s + k[i] * kd * (1 - c));
}

/** Which way gravity points in the raw data: 'upright' (±y), 'flat' (±z) or null. */
export function poseOf(a) {
  const g = len(a);
  if (g < 7) return null;
  if (Math.abs(a[1]) / g > 0.8) return { pose: 'upright', sign: Math.sign(a[1]) };
  if (Math.abs(a[2]) / g > 0.8) return { pose: 'flat', sign: Math.sign(a[2]) };
  return null;
}

/**
 * samples: [{ t (s), a: [x,y,z] raw accelerationIncludingGravity, r: [alpha,beta,gamma] deg/s }]
 * from the upright pose (first stillSec still), through the turn, to the flat
 * pose (last stillSec still).
 * Returns { ok, accSign, gyroMap, gyroSign, error, margin, message }.
 */
export function analyzeSensorCheck(samples, stillSec = 0.5) {
  if (samples.length < 20 || samples.some((s) => !s.r)) return { ok: false, message: 'No gyroscope data.' };
  const t0 = samples[0].t, t1 = samples.at(-1).t;
  const first = samples.filter((s) => s.t <= t0 + stillSec), last = samples.filter((s) => s.t >= t1 - stillSec);
  const g1 = mean(first, 'a'), g2 = mean(last, 'a'), bias = mean(first, 'r');
  const p1 = poseOf(g1), p2 = poseOf(g2);
  if (!p1 || p1.pose !== 'upright') return { ok: false, message: 'Start with the phone upright, screen facing you.' };
  if (!p2 || p2.pose !== 'flat') return { ok: false, message: 'End with the phone lying flat, screen up.' };
  if (p1.sign !== p2.sign) return { ok: false, message: 'The two poses disagree. Upright with the screen facing you, then flat with the screen up.' };
  const accSign = p1.sign; // +1 as in the spec, -1 flipped
  if (angle(g1, g2) < 45) return { ok: false, message: 'Turn the phone further, all the way to flat.' };

  const results = [];
  for (const map of Object.keys(GYRO_MAPS)) {
    for (const sign of [1, -1]) {
      let g = g1.slice(), lt = samples[0].t;
      for (const s of samples) {
        const dt = s.t - lt; lt = s.t;
        const w = GYRO_MAPS[map](s.r.map((x, i) => x - bias[i])).map((x) => x * sign * DEG);
        g = rotate(g, w, dt);
      }
      results.push({ map, sign, error: angle(g, g2) });
    }
  }
  results.sort((a, b) => a.error - b.error);
  const [best, next] = results;
  const margin = next.error - best.error;
  if (best.error > 15 || margin < 10) {
    return { ok: false, message: 'The turn was too fast or too shaky to read. Try again, slowly and smoothly.', results };
  }
  const accNote = accSign === 1 ? 'standard accelerometer' : 'flipped accelerometer (usual on iPhone)';
  const gyroNote = best.map === 'webkit' ? 'iPhone-style gyroscope axes' : 'standard gyroscope axes';
  return {
    ok: true, accSign, gyroMap: best.map, gyroSign: best.sign, error: best.error, margin, results,
    message: `Sensors checked: ${accNote}, ${gyroNote}${best.sign === -1 ? ', reversed rotation' : ''}.`,
  };
}
