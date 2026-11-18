// node test/tracker.test.mjs — runs synthetic rides through the tracker and
// compares stop-to-stop distances and stop positions with ground truth.
import { simulateRide } from '../js/sim.js';
import { replayRecording } from '../js/tracker.js';

const cases = [
  { name: 'phone leaning on window, spec gyro', opts: {} },
  { name: 'phone flat on seat, rotated 120°', opts: { phone: { yaw: 120, pitch: 0, roll: 0 }, seed: 3 } },
  { name: 'old WebKit gyro axis order', opts: { gyroMap: 'xyz', seed: 11 } },
  { name: 'big accel bias 0.1 m/s²', opts: { accBias: [0.1, -0.1, 0.1], seed: 5 } },
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
process.exit(failed ? 1 : 0);
