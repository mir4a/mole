// GPS as a reference track: converts fixes to local metres and rotates them
// into the dead-reckoning frame (x = first direction of travel, y = left),
// so both paths can be drawn and compared on the same scene.
//
// Fix rows: [t_ms, lat, lon, accuracy_m, speed_mps|null, heading_deg|null]

const R_EARTH = 6371008.8;
const DEG = Math.PI / 180;
const MAX_ACC = 30; // m; fixes worse than this are ignored

/** Fixes -> [{ t (s), e, n, acc, speed }] in metres east/north of the origin fix. */
export function toLocal(fixes, origin) {
  const [, lat0, lon0] = origin;
  const kx = R_EARTH * Math.cos(lat0 * DEG) * DEG, ky = R_EARTH * DEG;
  return fixes
    .filter((f) => f[3] == null || f[3] <= MAX_ACC)
    .map((f) => ({ t: f[0] / 1000, e: (f[2] - lon0) * kx, n: (f[1] - lat0) * ky, acc: f[3], speed: f[4] }));
}

function nearest(local, t) {
  let best = null, bd = Infinity;
  for (const p of local) {
    const d = Math.abs(p.t - t);
    if (d < bd) { bd = d; best = p; }
  }
  return bd <= 5 ? best : null;
}

/**
 * Builds the GPS reference for a tracker: origin at the fix closest to the
 * calibration, rotation fixed by the first stop (or, before that, by the
 * current position once both tracks are 30 m from the start).
 */
export function gpsReference(fixes, tracker, tCal) {
  if (!fixes?.length) return null;
  const originFix = fixes.reduce((a, b) => (Math.abs(b[0] / 1000 - tCal) < Math.abs(a[0] / 1000 - tCal) ? b : a));
  const local = toLocal(fixes, originFix);
  if (local.length < 2) return null;

  let dr = null, g = null;
  const firstStop = tracker.stops[1];
  if (firstStop) { dr = firstStop.p; g = nearest(local, firstStop.t); }
  if (!g) { dr = tracker.pos; g = local.at(-1); }
  const ok = g && Math.hypot(dr[0], dr[1]) > 30 && Math.hypot(g.e, g.n) > 30;
  const angle = ok ? Math.atan2(dr[1], dr[0]) - Math.atan2(g.n, g.e) : null;

  const c = Math.cos(angle ?? 0), s = Math.sin(angle ?? 0);
  const points = local.map((p) => [c * p.e - s * p.n, s * p.e + c * p.n, 0]);
  return { aligned: ok, points, local };
}

/**
 * Distance along the GPS track between two times (s). The fixes are smoothed
 * over 3 points and steps under 1 m are dropped, so jitter while standing at a
 * stop does not add up.
 */
export function gpsDistance(local, t0, t1) {
  const pts = local.filter((p) => p.t >= t0 && p.t <= t1);
  const sm = pts.map((p, i) => {
    const w = pts.slice(Math.max(0, i - 1), i + 2);
    return { e: w.reduce((s, q) => s + q.e, 0) / w.length, n: w.reduce((s, q) => s + q.n, 0) / w.length };
  });
  let d = 0, prev = sm[0];
  for (const p of sm.slice(1)) {
    const step = Math.hypot(p.e - prev.e, p.n - prev.n);
    if (step >= 1) { d += step; prev = p; }
  }
  return d;
}

/** GPS speed (m/s) at time t: the receiver's own value, else the displacement over the last ~4 s. */
export function gpsSpeed(local, t) {
  const recent = local.filter((p) => p.t <= t && t - p.t < 4.5);
  const last = recent.at(-1), first = recent[0];
  if (!last) return null;
  if (last.speed != null && last.speed >= 0) return last.speed;
  if (!first || last.t - first.t < 2) return null;
  const v = Math.hypot(last.e - first.e, last.n - first.n) / (last.t - first.t);
  return v < 0.7 ? 0 : v; // a few metres of drift while standing is not motion
}
