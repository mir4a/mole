// Station network (data/prague.json) and a matcher that names the stops of a
// metro ride: which station each stop is, which way along the line we go, and
// what a transfer does to the height.
//
// The sensors only know distances between stops. The matcher takes a start
// station (from the last GPS fix before going underground, or picked by hand),
// decides the direction at the first stop by comparing the measured distance
// with the straight-line distances to both neighbours, and then walks along
// the line. A stop much shorter than the gap to the next station is a stop in
// the tunnel (a red signal): it still resets the speed drift, but isn't a
// station.

const R_EARTH = 6371008.8;
const DEG = Math.PI / 180;
const TRACK = 1.1;     // track length / straight-line distance between stations, typical
const TUNNEL = 0.6;    // less than this share of the expected gap: a stop in the tunnel

export function haversine(a, b) {
  const dLat = (b.lat - a.lat) * DEG, dLon = (b.lon - a.lon) * DEG;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(h));
}

const fold = (s) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');

export class Network {
  constructor(data) {
    this.city = data.city;
    this.lines = data.lines; // { A: [{ name, lat, lon, depth }, ...], ... } in order
  }

  station(line, index) { return this.lines[line]?.[index] ?? null; }

  /** Every (line, index) whose station is within maxDist metres, nearest first. */
  near(lat, lon, maxDist = 800) {
    const out = [];
    for (const [line, list] of Object.entries(this.lines)) {
      list.forEach((s, index) => {
        const d = haversine({ lat, lon }, s);
        if (d <= maxDist) out.push({ line, index, name: s.name, dist: d });
      });
    }
    return out.sort((a, b) => a.dist - b.dist);
  }

  /** All (line, index) with this station name (transfer stations have several). */
  byName(name) {
    const f = fold(name), out = [];
    for (const [line, list] of Object.entries(this.lines)) list.forEach((s, index) => { if (fold(s.name) === f) out.push({ line, index, name: s.name }); });
    return out;
  }

  /** Expected track length from index to index + dir, or null past a terminus. */
  gap(line, index, dir) {
    const a = this.station(line, index), b = this.station(line, index + dir);
    return a && b ? haversine(a, b) * TRACK : null;
  }
}

export class RouteMatcher {
  /** start: [{ line, index }] candidates (several at a transfer station, or nearby stations). */
  constructor(net, start) {
    this.net = net;
    this.cands = start.map((c) => ({ line: c.line, index: c.index }));
    this.dir = null;
    this.since = 0; // metres since the last station
  }

  get current() {
    if (this.cands.length !== 1) return null;
    const c = this.cands[0];
    return { ...c, station: this.net.station(c.line, c.index), dir: this.dir };
  }

  /**
   * A stop after dist metres. Returns { kind: 'station', line, index, name } or
   * { kind: 'tunnel' } (or { kind: 'unknown' } while the start is unknown).
   */
  onStop(dist) {
    if (!this.cands.length) return { kind: 'unknown' };
    this.since += dist;
    if (this.dir == null) {
      // first station: pick the candidate and direction whose gap fits best
      let best = null;
      for (const c of this.cands) {
        for (const dir of [1, -1]) {
          const g = this.net.gap(c.line, c.index, dir);
          if (!g) continue;
          const score = Math.abs(Math.log(this.since / g));
          if (!best || score < best.score) best = { c, dir, g, score };
        }
      }
      if (!best || this.since < TUNNEL * best.g) return { kind: 'tunnel' };
      this.cands = [{ line: best.c.line, index: best.c.index + best.dir }];
      this.dir = best.dir;
      this.since = 0;
      return this.stationResult();
    }
    const c = this.cands[0];
    const g = this.net.gap(c.line, c.index, this.dir);
    if (!g || this.since < TUNNEL * g) return { kind: 'tunnel' };
    c.index += this.dir;
    this.since = 0;
    return this.stationResult();
  }

  stationResult() {
    const c = this.cands[0], s = this.net.station(c.line, c.index);
    return { kind: 'station', line: c.line, index: c.index, name: s.name };
  }

  /**
   * Changing lines at the current station. Returns { from, to, dz } with dz the
   * height change in metres (platform depths below the same ground), or null
   * when the station isn't a known transfer.
   */
  transfer() {
    const cur = this.current;
    if (!cur) return null;
    const others = this.net.byName(cur.station.name).filter((x) => x.line !== cur.line);
    if (!others.length) return null;
    const from = { line: cur.line, index: cur.index, station: cur.station };
    const to = others[0];
    const toStation = this.net.station(to.line, to.index);
    const dz = from.station.depth != null && toStation.depth != null ? from.station.depth - toStation.depth : null;
    this.cands = others.map((o) => ({ line: o.line, index: o.index }));
    this.dir = null;
    this.since = 0;
    return { from, to: { ...to, station: toStation }, dz };
  }
}

let cached = null;
/** Loads the bundled station data (browser). */
export async function loadNetwork(url = 'data/prague.json') {
  if (!cached) cached = fetch(url).then((r) => r.json()).then((d) => new Network(d)).catch(() => null);
  return cached;
}
