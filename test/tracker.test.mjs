// node test/tracker.test.mjs — runs synthetic rides through the tracker and
// compares stop-to-stop distances and stop positions with ground truth.
import { simulateRide, simulateSensorCheck, simulateTransfer } from '../js/sim.js';
import { VEHICLES } from '../js/vehicles.js';
import { Network, RouteMatcher, haversine } from '../js/stations.js';
import fs from 'fs';

const BUS_OPTS = VEHICLES.bus.demo, TRAM_OPTS = VEHICLES.tram.demo;
import { analyzeSensorCheck } from '../js/sensorcheck.js';
import { replayRecording, createFeeder } from '../js/tracker.js';
import { gpsReference, gpsDistance } from '../js/gps.js';

const cases = [
  { name: 'phone leaning on window, spec gyro', opts: {} },
  { name: 'phone flat on seat, rotated 120°', opts: { phone: { yaw: 120, pitch: 0, roll: 0 }, seed: 3 } },
  { name: 'iPhone Safari motion conventions', opts: { gyroMap: 'webkit', seed: 11 } },
  { name: 'big accel bias 0.1 m/s²', opts: { accBias: [0.1, -0.1, 0.1], seed: 5 } },
  { name: 'city bus, phone on the seat', opts: { ...BUS_OPTS, phone: { yaw: 70, pitch: 0, roll: 0 }, seed: 9 } },
  { name: 'city bus, phone on the window, iPhone', opts: { ...BUS_OPTS, gyroMap: 'webkit', seed: 4 } },
  { name: 'tram, phone on the window, iPhone', opts: { ...TRAM_OPTS, gyroMap: 'webkit', seed: 6 } },
  { name: 'tram, phone on the seat', opts: { ...TRAM_OPTS, phone: { yaw: -40, pitch: 0, roll: 0 }, seed: 15 } },
];

let failed = 0;
for (const c of cases) {
  const { recording, stopsTruth, trackLengths } = simulateRide(c.opts);
  const tr = replayRecording(recording);
  const est = tr.stops.map((s) => s.p);
  console.log(`\n# ${c.name}  (gyro map: ${tr.gyroMap}, stops found: ${est.length - 1}/${stopsTruth.length - 1})`);
  if (est.length !== stopsTruth.length) { console.log('  FAIL: wrong number of stops'); failed++; continue; }
  let worstLen = 0, worstPos = 0, totalTrue = 0;
  for (let i = 1; i < est.length; i++) {
    const dTrue = trackLengths[i - 1];
    const dEst = tr.stops[i].dist;
    const posErr = Math.hypot(...est[i].map((v, k) => v - stopsTruth[i][k]));
    totalTrue += dTrue;
    worstLen = Math.max(worstLen, Math.abs(dEst - dTrue) / dTrue);
    worstPos = Math.max(worstPos, posErr / totalTrue);
    console.log(`  stop ${i}: true ${dTrue.toFixed(0)} m, est ${dEst.toFixed(0)} m (${((dEst / dTrue - 1) * 100).toFixed(1)}%), position error ${posErr.toFixed(0)} m, dz true ${stopsTruth[i][2].toFixed(1)} est ${est[i][2].toFixed(1)}`);
  }
  const ok = worstLen < 0.12 && worstPos < 0.15;
  console.log(`  worst length error ${(worstLen * 100).toFixed(1)}%, worst drift ${(worstPos * 100).toFixed(1)}% of distance → ${ok ? 'OK' : 'FAIL'}`);
  if (!ok) failed++;
}

// Finish pressed while the train is still braking into the last station:
// it should count as the arrival and get the v=0 correction.
{
  const { recording, trackLengths } = simulateRide({ seed: 21, dwell: 25 });
  const hz = recording.hz;
  const cut = { ...recording, samples: recording.samples.slice(0, recording.samples.length - (25 + 2) * hz) };
  const tr = replayRecording(cut);
  const last = tr.finish();
  const truth = trackLengths.at(-1);
  const err = last ? Math.abs(tr.segments.at(-1).dist - truth) / truth : 1;
  const ok = last?.arrived && err < 0.12;
  console.log(`\n# finish while braking: arrived=${last?.arrived}, last segment ${tr.segments.at(-1)?.dist.toFixed(0)} m vs ${truth.toFixed(0)} m → ${ok ? 'OK' : 'FAIL'}`);
  if (!ok) failed++;
}
// Bus ride with simulated GPS: the GPS track must line up with the sensor
// track and give comparable segment lengths.
{
  const { recording, trackLengths } = simulateRide({ ...BUS_OPTS, gps: true, seed: 12 });
  const tr = replayRecording(recording);
  const calT = recording.samples[recording.calibrationCount - 1][0] / 1000;
  const ref = gpsReference(recording.gps, tr, calT);
  const gpsLens = tr.segments.map((s) => gpsDistance(ref.local, s.t0, s.t1));
  const worst = Math.max(...gpsLens.map((g, i) => Math.abs(g - trackLengths[i]) / trackLengths[i]));
  const lastStop = tr.stops.at(-1).p, lastGps = ref.points.at(-1);
  const endGap = Math.hypot(lastStop[0] - lastGps[0], lastStop[1] - lastGps[1]);
  const ok = ref.aligned && worst < 0.1;
  console.log(`\n# bus GPS reference: aligned=${ref.aligned}, GPS segment lengths within ${(worst * 100).toFixed(1)}% of truth, sensor/GPS end gap ${endGap.toFixed(0)} m → ${ok ? 'OK' : 'FAIL'}`);
  if (!ok) failed++;
}
// Sensor check: must recover each convention from one upright -> flat turn.
for (const [platform, gyroReversed, want] of [
  ['spec', false, { accSign: 1, gyroMap: 'spec', gyroSign: 1 }],
  ['webkit', false, { accSign: -1, gyroMap: 'webkit', gyroSign: 1 }],
  ['spec', true, { accSign: 1, gyroMap: 'spec', gyroSign: -1 }],
]) {
  const res = analyzeSensorCheck(simulateSensorCheck({ platform, gyroReversed, seed: 3 }));
  const ok = res.ok && res.accSign === want.accSign && res.gyroMap === want.gyroMap && res.gyroSign === want.gyroSign;
  console.log(`\n# sensor check ${platform}${gyroReversed ? ' (reversed gyro)' : ''}: ${res.message} error ${res.error?.toFixed(1)}°, margin ${res.margin?.toFixed(0)}° → ${ok ? 'OK' : 'FAIL'}`);
  if (!ok) failed++;
}
// A check with a flipped gyro must also fix a whole ride.
{
  const { recording } = simulateRide({ seed: 8 });
  const flipped = { ...recording, samples: recording.samples.map((x) => [x[0], x[1], x[2], x[3], -x[4], -x[5], -x[6]]) };
  const plain = replayRecording(flipped), checked = replayRecording({ ...flipped, sensorCheck: { ok: true, accSign: 1, gyroMap: 'spec', gyroSign: -1 } }), ref = replayRecording(recording);
  const endGap = (tr) => Math.hypot(tr.stops.at(-1).p[0] - ref.stops.at(-1).p[0], tr.stops.at(-1).p[1] - ref.stops.at(-1).p[1]);
  const ok = endGap(checked) < 5 && endGap(plain) > 200;
  console.log(`\n# reversed gyro ride: end ${endGap(plain).toFixed(0)} m off without the check, ${endGap(checked).toFixed(0)} m with it → ${ok ? 'OK' : 'FAIL'}`);
  if (!ok) failed++;
}
// Transfer: pause at the end of line A, walk with the phone in hand, resume on
// line B. The gyro must carry the heading so line B points the right way.
for (const [name, o] of [['turn 110°', {}], ['iPhone, turn -70°', { gyroMap: 'webkit', turnDeg: -70, seed: 9 }], ['turn 180°, 5 min walk', { turnDeg: 180, walkSec: 300, seed: 2 }]]) {
  const sim = simulateTransfer(o);
  const tr = replayRecording(sim.recording);
  const iT = tr.stops.findIndex((x) => x.transfer);
  const e0 = tr.stops[iT]?.p, e1 = tr.stops[iT + 1]?.p, t0 = sim.stopsB[0], t1 = sim.stopsB[1];
  const err = e1 ? ((Math.atan2(e1[1] - e0[1], e1[0] - e0[0]) - Math.atan2(t1[1] - t0[1], t1[0] - t0[0])) * 180 / Math.PI + 540) % 360 - 180 : 999;
  const ok = iT === sim.stopsA.length - 1 && tr.stops.length === sim.stopsA.length + sim.stopsB.length - 1 && Math.abs(err) < 10;
  console.log(`\n# transfer, ${name}: line B points ${err.toFixed(1)}° off → ${ok ? 'OK' : 'FAIL'}`);
  if (!ok) failed++;
}
// The screen went off during the walk: the heading must be reported as lost.
{
  const sim = simulateTransfer({ seed: 5 });
  const rec = sim.recording, rows = rec.samples;
  const pause = rec.marks[0].at, cut = pause + 30 * 60; // drop 20 s of the walk
  const samples = [...rows.slice(0, cut), ...rows.slice(cut + 20 * 60)];
  const marks = [rec.marks[0], { ...rec.marks[1], from: rec.marks[1].from - 1200, to: rec.marks[1].to - 1200 }];
  const f = createFeeder({ ...rec, samples, marks }); f.feedUntil(1e9);
  const ev = f.tracker.events.find((e) => e.type === 'resume');
  const ok = ev && ev.headingKept === false;
  console.log(`\n# transfer with the screen off mid-walk: heading kept = ${ev?.headingKept} → ${ok ? 'OK' : 'FAIL'}`);
  if (!ok) failed++;
}
// Station matching on the Prague data: a ride from Zličín along line B with a
// stop at a red signal, then a transfer at Můstek to line A.
{
  const net = new Network(JSON.parse(fs.readFileSync(new URL('../data/prague.json', import.meta.url))));
  const B = net.lines.B, zl = B.findIndex((x) => x.name === 'Zličín'), mu = B.findIndex((x) => x.name === 'Můstek');
  const dir = mu > zl ? 1 : -1;
  const m = new RouteMatcher(net, net.byName('Zličín'));
  const got = [];
  for (let i = zl; i !== mu; i += dir) {
    const d = haversine(B[i], B[i + dir]) * 1.15;
    if (i === zl + 4 * dir) { m.onStop(d * 0.3); m.onStop(d * 0.7); } // a red signal in the tunnel
    else m.onStop(d);
    got.push(m.current.station.name);
  }
  const t = m.transfer();
  const ok = got.at(-1) === 'Můstek' && got.length === Math.abs(mu - zl) && t?.to.line === 'A' && Math.abs(t.dz - 11) < 0.01;
  console.log(`\n# stations: Zličín → ${got.at(-1)} (${got.length} stations, a tunnel stop skipped), transfer to ${t?.to.line}, height ${t?.dz?.toFixed(1)} m → ${ok ? 'OK' : 'FAIL'}`);
  if (!ok) failed++;
}
// No start station: the line has to come from the gaps and the shape alone.
// Jinonice -> Můstek (B), one hop on A to Muzeum, C to Florenc, drawn rotated
// by 40°, with 8 % noise on distances and 6° on bearings; the heading is lost
// on the first walk.
{
  const net = new Network(JSON.parse(fs.readFileSync(new URL('../data/prague.json', import.meta.url))));
  const D = Math.PI / 180, R = 6371008.8;
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
  const legs = [['B', 'Jinonice', 'Můstek'], ['A', 'Můstek', 'Muzeum'], ['C', 'Muzeum', 'Florenc']];
  const m = new RouteMatcher(net, null);
  let p = [0, 0], rot = 40 * D;
  legs.forEach(([L, a, b], k) => {
    if (k > 0) { if (k === 1) rot += 75 * D; m.transfer(k !== 1); }
    const list = net.lines[L], i0 = list.findIndex((x) => x.name === a), i1 = list.findIndex((x) => x.name === b), dir = i1 > i0 ? 1 : -1;
    for (let i = i0; i !== i1; i += dir) {
      const s0 = list[i], s1 = list[i + dir];
      const e = [(s1.lon - s0.lon) * D * R * Math.cos(s0.lat * D), (s1.lat - s0.lat) * D * R];
      const th = rot + rnd() * 6 * D, f = 1.1 * (1 + rnd() * 0.08);
      p = [p[0] + f * (Math.cos(th) * e[0] - Math.sin(th) * e[1]), p[1] + f * (Math.sin(th) * e[0] + Math.cos(th) * e[1])];
      m.onStop(Math.hypot(e[0], e[1]) * f, p);
    }
  });
  const r = m.route();
  const names = r?.labels.map((l) => l.name ?? l.kind);
  const ok = names?.[0] === 'Jinonice' && names?.[6] === 'Můstek' && names?.[7] === 'Muzeum' && names?.at(-1) === 'Florenc' && r.transfers.map((t) => t.to.line).join('') === 'AC';
  console.log(`\n# stations without a start: ${names?.join(' > ')} → ${ok ? 'OK' : 'FAIL'}`);
  if (!ok) failed++;
}
process.exit(failed ? 1 : 0);
