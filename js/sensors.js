// Thin wrapper over DeviceMotionEvent + Screen Wake Lock.

export function motionSupported() {
  return typeof window !== 'undefined' && 'DeviceMotionEvent' in window;
}

/** iOS needs an explicit permission request from a user gesture. */
export async function requestMotionPermission() {
  if (!motionSupported()) return 'unsupported';
  const DME = window.DeviceMotionEvent;
  if (typeof DME.requestPermission === 'function') {
    try { return await DME.requestPermission(); } catch { return 'denied'; }
  }
  return 'granted';
}

/**
 * Starts listening. onSample({tMs, a:[x,y,z], r:[alpha,beta,gamma]|null}).
 * Returns { stop(), stats } where stats.hz / stats.hasGyro update live.
 */
export function startMotion(onSample) {
  const stats = { hz: 0, hasGyro: false, hasAccel: false, count: 0 };
  let winStart = performance.now(), winCount = 0, lastT = 0;
  const handler = (e) => {
    const g = e.accelerationIncludingGravity;
    if (!g || g.x == null) return;
    stats.hasAccel = true;
    let t = e.timeStamp > 0 ? e.timeStamp : performance.now();
    if (t <= lastT) t = lastT + 0.1;
    lastT = t;
    const rr = e.rotationRate;
    const r = rr && rr.alpha != null ? [rr.alpha, rr.beta, rr.gamma] : null;
    if (r) stats.hasGyro = true;
    stats.count++;
    winCount++;
    const now = performance.now();
    if (now - winStart >= 1000) {
      stats.hz = Math.round((winCount * 1000) / (now - winStart));
      winStart = now; winCount = 0;
    }
    onSample({ tMs: t, a: [g.x, g.y, g.z], r });
  };
  window.addEventListener('devicemotion', handler);
  return { stats, stop: () => window.removeEventListener('devicemotion', handler) };
}

/** Keeps the screen on while the page is visible. Re-acquires after tab switches. */
export function keepAwake() {
  let lock = null, wanted = true;
  const acquire = async () => {
    if (!wanted || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    try { lock = await navigator.wakeLock.request('screen'); } catch { lock = null; }
  };
  const onVis = () => { if (document.visibilityState === 'visible') acquire(); };
  document.addEventListener('visibilitychange', onVis);
  acquire();
  return {
    get active() { return !!lock && !lock.released; },
    release() {
      wanted = false;
      document.removeEventListener('visibilitychange', onVis);
      lock?.release().catch(() => {});
    },
  };
}
