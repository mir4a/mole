// Rides are saved to IndexedDB in chunks while recording, so a crashed or
// reloaded tab does not lose the data.

const DB = 'mole', VER = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const rq = indexedDB.open(DB, VER);
    rq.onupgradeneeded = () => {
      const db = rq.result;
      db.createObjectStore('rides', { keyPath: 'id' });
      const ch = db.createObjectStore('chunks', { keyPath: ['rideId', 'idx'] });
      ch.createIndex('ride', 'rideId');
    };
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
  return dbp;
}

const tx = async (stores, mode, fn) => {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(stores, mode);
    const out = fn(t);
    t.oncomplete = () => res(out?.result ?? out);
    t.onerror = () => rej(t.error);
  });
};

export async function saveRideMeta(meta) {
  try { await tx(['rides'], 'readwrite', (t) => t.objectStore('rides').put(meta)); } catch {}
}

export async function appendChunk(rideId, idx, rows) {
  try { await tx(['chunks'], 'readwrite', (t) => t.objectStore('chunks').put({ rideId, idx, rows })); } catch {}
}

export async function listRides() {
  try {
    const db = await open();
    return await new Promise((res) => {
      const rq = db.transaction('rides').objectStore('rides').getAll();
      rq.onsuccess = () => res(rq.result.sort((a, b) => b.id - a.id));
      rq.onerror = () => res([]);
    });
  } catch { return []; }
}

export async function loadRide(id) {
  const db = await open();
  const meta = await new Promise((res) => {
    const rq = db.transaction('rides').objectStore('rides').get(id);
    rq.onsuccess = () => res(rq.result);
  });
  const chunks = await new Promise((res) => {
    const rq = db.transaction('chunks').objectStore('chunks').index('ride').getAll(id);
    rq.onsuccess = () => res(rq.result);
  });
  chunks.sort((a, b) => a.idx - b.idx);
  return { ...meta, samples: chunks.flatMap((c) => c.rows) };
}

export async function deleteRide(id) {
  const db = await open();
  const keys = await new Promise((res) => {
    const rq = db.transaction('chunks').objectStore('chunks').index('ride').getAllKeys(id);
    rq.onsuccess = () => res(rq.result);
  });
  await tx(['rides', 'chunks'], 'readwrite', (t) => {
    t.objectStore('rides').delete(id);
    for (const k of keys) t.objectStore('chunks').delete(k);
  });
}
