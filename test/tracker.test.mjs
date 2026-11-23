// node test/tracker.test.mjs — runs synthetic rides through the tracker and
// compares stop-to-stop distances and stop positions with ground truth.
import { simulateRide, BUS_OPTS, TRAM_OPTS, simulateSensorCheck } from '../js/sim.js';
import { analyzeSensorCheck } from '../js/sensorcheck.js';
import { replayRecording } from '../js/tracker.js';
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
process.exit(failed ? 1 : 0);
