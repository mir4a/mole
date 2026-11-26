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
- **Heading and grade come from the gyroscope**, integrated as a full 3D
  attitude (not the magnetometer, which is useless next to traction motors).
  The full rotation matters: in canted curves part of the turn shows up on the
  phone's pitch axis. Gravity measured at every stop pins the pitch there, and
  the elevation profile (relative to the start) is drawn in the summary.
- **Sensor conventions differ between phones.** iPhone Safari reports the
  accelerometer with the opposite sign to the spec and the gyro axes in another
  order (found by checking real rides against the metro line map). A one-time
  sensor check on the setup screen measures them: the phone held upright,
  screen facing you (the spec says y = +9.8), then laid flat screen up. The
  known pose gives the accelerometer sign; propagating gravity through the turn
  with each gyro hypothesis gives the axis order and sign. Without the check
  the page falls back to guessing from the user agent.
- **Gyro axis order is detected automatically.** Browsers have disagreed on how
  `rotationRate.alpha/beta/gamma` map to device axes.

While moving, the line is provisional (white). At each stop it is replaced by the
corrected segment (amber tube) and a platform marker.

On synthetic rides (`node test/tracker.test.mjs`) segment lengths come out within
about 0–9 % and the stop positions drift 2–8 % of the distance travelled. Real
rides will be worse; that is what the recordings are for.

## Bus and tram modes

Pick **Bus** or **Tram** on the setup screen. The tram profile sits between the
metro and the bus: rails (no sideslip, smoother runs) but tight junction curves,
traffic lights and hills; GPS is recorded the same way. With **Bus**, the tracker uses a bus profile (sharper
turns, harder braking, shorter stops, stops on hills up to ~8 %, steeper grades)
and the page records GPS alongside the motion sensors. GPS is not used for the
route itself: it is drawn as a blue reference line next to the sensor track, and
the summary lists each segment's GPS length and the sensors' error against it.
The GPS track is rotated to match the sensor track at the first stop, since the
sensors have no compass heading.

On synthetic bus rides (`BUS_OPTS` in `js/sim.js`) segment lengths come out
within about 0–10 %; the worst case is a segment with a hill in the middle,
because the grade inside a segment is interpolated between the two stops.

## Transfers (Pause / Resume)

Changing lines mid-ride: tap **Pause** at the station, walk to the next train
with the page open, fix the phone there and tap **Resume** while it stands.
While paused the phone's attitude is carried by the gyro (with a slow tilt
correction from gravity), so when the new line's forward axis is learned at
its first departure, its heading is known in the same frame as the old line.
On synthetic transfers (a 120° detour on the way, the phone swinging, up to a
5 min walk) the new line points within ~5° of the truth. If the screen went
off during the walk, the rotation is lost and the page says the new line's
direction is a guess. The walking distance and the height change (escalators)
are not measured: the new line starts where the old one paused, marked
*transfer*. Pause and resume are stored as marks in the recording, so replays
reproduce them.

## Vehicles

Everything that differs between kinds of vehicle lives in `js/vehicles.js`,
one object per vehicle:

- `tracker`: algorithm tuning layered over the tracker's defaults (stop and
  departure thresholds, how strong a push must be to teach the forward axis,
  grade and speed limits, how fast a turn may be before it counts as the phone
  being picked up);
- `gps`: record GPS as a reference track;
- `stops`: `'stations'` numbers every standstill (metro); `'confirm'` shows
  standstills as unnumbered halts, lights and crossings included, and the rider
  marks the real stops after the ride (bus, tram). Every standstill still resets
  the speed drift either way;
- `copy`: the setup-screen texts (`data-copy` keys in `index.html`);
- `demo`: the synthetic route behind *Demo ride*.

Adding a vehicle is adding an object there; the vehicle switch, setup texts,
ride view and demo pick it up.

## Station data (Prague)

`data/prague.json` lists lines A, B and C in order with coordinates (from
Wikidata, CC0) and the depth of each platform below the terrain (middle of the
platform), taken from the station pages of [metroweb.cz](https://metroweb.cz/metro/)
(Tomáš Rejdal), Wikidata where missing. Depths are known for 55 of 61 line
stations; the four newest stations of line A, Prosek and Střížkov are still
missing. Transfer stations differ a lot between lines (Můstek A 29.3 m / B
40.3 m, Muzeum A 34 m / C 10 m, Florenc B 39 m / C 9.35 m), which is what a
transfer needs.

On a metro ride the page names the stops: the start station comes from the
last GPS fix before going underground (or is picked by hand on the setup
screen), the direction is chosen at the first stop by comparing the measured
distance with the gaps to both neighbours, and then the ride walks along the
line. A stop much shorter than the gap to the next station is a stop in the
tunnel (a red signal): it still resets the speed drift but isn't a station. At
a transfer (Pause / Resume) the matcher switches to the station's other line
and moves the track up or down by the difference in platform depths, drawn as
a vertical link. On a real ride Jinonice -> Florenc all eight stations came out
right.

The same site's technical data also tunes the metro profile: running tracks
are at most 40 ‰ (so pitch is capped at 2.5°) and station tracks at most 3 ‰
(a stop that seems tilted means the phone moved). Its longest gap between
stations, Smíchovské nádraží – Radlická at 2240 m, came out at 2315 m on a
real ride.

## Vehicle models

The vehicles on screen are procedural low-poly models built in `js/models.js`
(a metro car, a three-section tram and a city bus, sized in metres). A
vehicle's entry in `js/vehicles.js` can also point at glTF files instead
(`model: { parts, front, scale }`); they are loaded with three.js' GLTFLoader
and replace the procedural model once loaded.

Riders can load their own model too: under the vehicle switch, **Load .glb**
takes a binary glTF file, which is kept in the browser (IndexedDB) and works
offline. A turntable preview shows it with an orange arrow at the front; **Turn
90°** fixes a file whose front faces another way, and **Length** scales it
uniformly to the real size (19 m metro car, 31 m tram, 12 m bus by default).
A file that doesn't load is dropped and the built-in model is used; **Use
built-in** goes back to it at any time.

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
- `js/models.js`: procedural vehicle models, and loading glTF models when a vehicle names files
- `js/sensors.js`: DeviceMotion, iOS permission, screen wake lock
- `js/vehicles.js`: per-vehicle tuning, behaviour, texts and demo routes
- `js/sensorcheck.js`: one-time sensor check (accelerometer sign, gyro axes)
- `js/stations.js`: station network, nearest station, stop naming and transfers
- `data/prague.json`: Prague lines, stations, coordinates and platform depths
- `js/gps.js`: GPS reference track for bus mode (local metres, alignment, distances)
- `js/store.js`: IndexedDB storage of rides
- `js/app.js`: UI flow (setup and calibration, ride, summary, replay)
- `vendor/`: three.js r160 and OrbitControls, vendored for offline use

## Backlog

- Ground elevation over each station (a terrain service, fetched on the phone)
  to pin the whole elevation profile, not only transfers.
- The walking part of a transfer: steps and heading for the horizontal path.
- Snap the track to the real line geometry (OpenStreetMap).
