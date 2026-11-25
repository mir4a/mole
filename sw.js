// Offline support: network first (so updates arrive), cache as fallback
// with a short timeout, because underground the network usually hangs
// rather than failing fast.
const CACHE = 'mole-v11';
const CORE = [
  './', 'index.html', 'manifest.webmanifest', 'icon.svg',
  'js/app.js', 'js/tracker.js', 'js/sensors.js', 'js/scene.js', 'js/sim.js', 'js/store.js', 'js/gps.js', 'js/sensorcheck.js', 'js/vehicles.js',
  'vendor/three.module.min.js', 'vendor/OrbitControls.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const timeout = new Promise((resolve) => setTimeout(resolve, 2500, null));
    const net = fetch(req).then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    }).catch(() => null);
    const res = await Promise.race([net, timeout]);
    return res || (await cache.match(req, { ignoreSearch: true })) || (await net) || Response.error();
  })());
});
