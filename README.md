# Mole

A proof of concept that draws a metro tunnel (or a bus route) in 3D from a
phone's accelerometer and gyroscope only (no GPS underground). Fix the phone in the car, calibrate at a
station, and the app draws the route as the train moves.

## How it works

Integrating raw acceleration twice drifts by hundreds of metres within a minute, so
the tracker (`js/tracker.js`) leans on what a heavy rail vehicle gives for free:

- **No sideslip.** Speed is along the car's axis only. That axis is learned from the
  first departure (the principal direction of horizontal acceleration).
- **Stops are zero-velocity updates.** At every stop the speed is exactly 0, so the
  accelerometer bias for the segment is solved for and the whole segment is
  re-integrated. Pitch drift is corrected against gravity measured at the stop.
- **Heading comes from the gyroscope** (yaw rate about the vertical), not the
  magnetometer, which is useless next to traction motors.
- **Gyro axis order is detected automatically.** Browsers have disagreed on how
  `rotationRate.alpha/beta/gamma` map to device axes.

While moving, the line is provisional (white). At each stop it is replaced by the
corrected segment (amber tube) and a platform marker.

On synthetic rides (`node test/tracker.test.mjs`) segment lengths come out within
about 0–9 % and the stop positions drift 2–8 % of the distance travelled. Real
rides will be worse; that is what the recordings are for.

## Bus mode

Pick **Bus** on the setup screen. The tracker then uses a bus profile (sharper
turns, harder braking, shorter stops, stops on hills up to ~8 %, steeper grades)
and the page records GPS alongside the motion sensors. GPS is not used for the
route itself: it is drawn as a blue reference line next to the sensor track, and
the summary lists each segment's GPS length and the sensors' error against it.
The GPS track is rotated to match the sensor track at the first stop, since the
sensors have no compass heading.

On synthetic bus rides (`BUS_OPTS` in `js/sim.js`) segment lengths come out
within about 0–10 %; the worst case is a segment with a hill in the middle,
because the grade inside a segment is interpolated between the two stops.

## Run it

It is a static site with no build step. Sensors need HTTPS (or `localhost`).

- **GitHub Pages:** Settings → Pages → *Deploy from a branch* → pick the branch,
  folder `/ (root)`.
- **Locally:** `python3 -m http.server`, then open `http://localhost:8000`
  (sensors only work on a phone, so use the demo ride on a desktop).

Open the page **before** going underground: a service worker keeps it working
offline.

## Recordings

Every live ride is saved to IndexedDB in chunks while recording, and can be
exported as JSON (raw samples `[t_ms, ax, ay, az, alpha, beta, gamma]`) and
replayed through the algorithm with *Open recording*.

## Files

- `js/tracker.js`: dead reckoning, stop detection, ZUPT segment correction
- `js/sim.js`: synthetic metro ride generator (demo and tests)
- `js/scene.js`: three.js view (tunnel tubes, platforms, follow and orbit cameras)
- `js/sensors.js`: DeviceMotion, iOS permission, screen wake lock
- `js/gps.js`: GPS reference track for bus mode (local metres, alignment, distances)
- `js/store.js`: IndexedDB storage of rides
- `js/app.js`: UI flow (setup and calibration, ride, summary, replay)
- `vendor/`: three.js r160 and OrbitControls, vendored for offline use
