// Station network (data/prague.json) and a matcher that names the stops of a
// metro ride: which station each stop is, which way along the line we go, and
// what a transfer does to the height.
//
// The sensors only know distances between stops. The matcher compares them
// with the straight-line gaps between stations (x 1.1 for curves), from a
// known start station (the last GPS fix before going underground, or picked
// by hand) or, without one, from every station at once: the pattern of gaps
// gives the line away within a few stops. A stop much shorter than the gap to
// the next station is a stop in the tunnel (a red signal): it still resets the
// speed drift, but isn't a station.

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

const TUNNEL_COST = 0.6; // a stop between stations (a red signal) is possible but uncommon
const STAY_COST = 1.5;   // a pause that isn't a change of line
const MISS = 1.8;        // more than this share of the gap: a station was passed without stopping
const BEAM = 600;        // hypotheses kept
const SURE = 1.0;        // the best answer must beat any different one by this much
const TURN = 15 * DEG;   // spread of the measured vs. map bearing offset within a line
const TURN_WALK = 35 * DEG; // ... carried across a transfer walk by the gyro
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * Which station each stop of a ride is, found from the distances between stops.
 *
 * Every hypothesis is a (line, station, direction) the ride could be at, with
 * a cost: how badly the measured distances fit the station gaps so far
 * (|log(measured / expected)| per station, plus a cost per stop in a tunnel)
 * and how badly the drawn shape fits the map: the drawing may be rotated as a
 * whole, but the angle between drawn and real station-to-station bearings
 * should stay the same from hop to hop. Pauses (transfers) branch onto the
 * other lines of the station. With a known
 * start the hypotheses begin there; without one they begin at every station,
 * and the pattern of gaps finds the line within a few stops.
 */
export class RouteMatcher {
  /** start: [{ line, index }] candidates, or null when the start is unknown. */
  constructor(net, start = null) {
    this.net = net;
    const list = start?.length ? start : Object.entries(net.lines).flatMap(([line, l]) => l.map((_, index) => ({ line, index })));
    this.hyps = list.map((c) => ({ line: c.line, index: c.index, dir: null, since: 0, cost: 0, labels: [{ line: c.line, index: c.index }], transfers: [], pS: [0, 0], off: null, offSd: TURN }));
  }

  /** Best hypothesis, and whether it beats every one that disagrees on key(h) by SURE. */
  pick(key) {
    const best = this.hyps[0];
    if (!best) return { best: null, sure: false };
    const k = key(best);
    const rival = this.hyps.find((h) => key(h) !== k);
    return { best, sure: !rival || rival.cost - best.cost >= SURE };
  }

  get current() {
    const { best, sure } = this.pick((h) => `${h.line}:${h.index}`);
    if (!best || !sure) return null;
    return { line: best.line, index: best.index, station: this.net.station(best.line, best.index), dir: best.dir };
  }

  label(l) {
    if (l === null) return { kind: 'tunnel' };
    const s = this.net.station(l.line, l.index);
    return { kind: 'station', line: l.line, index: l.index, name: s.name };
  }

  /**
   * A stop after dist metres, at p ([x, y] in the drawing, if known). Returns
   * { kind: 'station', line, index, name }, { kind: 'tunnel' } or
   * { kind: 'unknown' } (not sure yet).
   */
  onStop(dist, p = null) {
    const out = [];
    for (const h of this.hyps) {
      const since = h.since + dist;
      let tunnel = false;
      for (const dir of h.dir == null ? [1, -1] : [h.dir]) {
        const g = this.net.gap(h.line, h.index, dir);
        if (!g) continue;
        const r = since / g;
        if (r < TUNNEL) {
          if (!tunnel) out.push({ ...h, since, cost: h.cost + TUNNEL_COST, labels: [...h.labels, null] });
          tunnel = true;
        } else if (r <= MISS) {
          let cost = h.cost + Math.abs(Math.log(r)), off = h.off, offSd = h.offSd;
          if (p && h.pS) {
            const a = this.net.station(h.line, h.index), b = this.net.station(h.line, h.index + dir);
            const d = wrap(Math.atan2(p[1] - h.pS[1], p[0] - h.pS[0]) - bearing(a, b));
            if (off != null) cost += Math.min((wrap(d - off) / offSd) ** 2, 4) / 2;
            off = off == null ? d : off + wrap(d - off) / 2;
            offSd = TURN;
          }
          out.push({ ...h, index: h.index + dir, dir, since: 0, cost, off, offSd, pS: p, labels: [...h.labels, { line: h.line, index: h.index + dir }] });
        }
      }
    }
    this.hyps = out.length ? prune(out) : this.hyps.map((h) => ({ ...h, since: h.since + dist, cost: h.cost + 2, labels: [...h.labels, null] }));
    const n = this.hyps[0].labels.length - 1;
    const { best, sure } = this.pick((h) => JSON.stringify(h.labels[n]));
    return sure ? this.label(best.labels[n]) : { kind: 'unknown' };
  }

  /**
   * The best reading of the whole ride so far: labels[n] for every stop
   * ({ kind: 'unknown' } where close rivals disagree) and the transfers all
   * close rivals agree on ({ at, from, to }).
   */
  route() {
    const best = this.hyps[0];
    if (!best) return null;
    const close = this.hyps.filter((h) => h.cost - best.cost < SURE);
    const key = (l) => (l ? `${l.line}:${l.index}` : '-');
    const labels = best.labels.map((l, n) => (close.every((h) => key(h.labels[n]) === key(l)) ? (l ? this.label(l) : { kind: 'tunnel' }) : { kind: 'unknown' }));
    const tk = (t) => `${t.at}>${key(t.to)}`;
    const transfers = best.transfers
      .filter((t) => close.every((h) => h.transfers.some((u) => tk(u) === tk(t))))
      .map((t) => ({ at: t.at, from: { ...t.from, station: this.net.station(t.from.line, t.from.index) }, to: { ...t.to, station: this.net.station(t.to.line, t.to.index) } }));
    return { labels, transfers };
  }

  /**
   * Changing lines at the current station. Returns { from, to, dz } with dz the
   * height change in metres (platform depths below the same ground), or null
   * when it isn't clear which line the ride continues on. headingKept: the
   * gyro carried the direction across the walk.
   */
  transfer(headingKept = true) {
    const out = [];
    for (const h0 of this.hyps) {
      const h = { ...h0, off: headingKept ? h0.off : null, offSd: TURN_WALK };
      const at = h.labels.length - 1;
      out.push({ ...h, dir: null, cost: h.cost + STAY_COST });
      if (h.since > 0) continue; // paused between stations: no change of line
      const st = this.net.station(h.line, h.index);
      for (const o of this.net.byName(st.name)) {
        if (o.line === h.line) continue;
        out.push({ ...h, line: o.line, index: o.index, dir: null, transfers: [...h.transfers, { at, from: { line: h.line, index: h.index }, to: { line: o.line, index: o.index } }] });
      }
    }
    this.hyps = prune(out);
    const { best, sure } = this.pick((h) => `${h.line}:${h.index}`);
    const t = best?.transfers.at(-1);
    if (!sure || !t || t.at !== best.labels.length - 1) return null;
    const from = { ...t.from, station: this.net.station(t.from.line, t.from.index) };
    const to = { ...t.to, station: this.net.station(t.to.line, t.to.index) };
    const dz = from.station.depth != null && to.station.depth != null ? from.station.depth - to.station.depth : null;
    return { from, to, dz };
  }
}

/** Map bearing from a to b (radians, counter-clockwise from east). */
function bearing(a, b) {
  return Math.atan2(b.lat - a.lat, (b.lon - a.lon) * Math.cos(((a.lat + b.lat) / 2) * DEG));
}

/** Cheapest first; one hypothesis per position (the cheaper history wins). */
function prune(hyps) {
  hyps.sort((a, b) => a.cost - b.cost);
  const seen = new Set(), out = [];
  for (const h of hyps) {
    const k = `${h.line}:${h.index}:${h.dir}:${Math.round(h.since / 50)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(h);
    if (out.length >= BEAM) break;
  }
  return out;
}

let cached = null;
/** Loads the bundled station data (browser). */
export async function loadNetwork(url = 'data/prague.json') {
  if (!cached) cached = fetch(url).then((r) => r.json()).then((d) => new Network(d)).catch(() => null);
  return cached;
}
