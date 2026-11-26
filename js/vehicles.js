// Everything that differs between kinds of vehicle lives here, one object per
// vehicle. Adding a vehicle means adding an object; the tracker, the setup
// screen, the ride view and the demo pick it up from this registry.
//
//   label      name on the vehicle switch
//   noun       how the copy refers to it ("Waiting for the bus to pull away")
//   tracker    algorithm tuning, layered over the tracker's DEFAULTS
//   gps        record GPS as a reference track (above ground only)
//   stops      'stations': every standstill is a numbered stop (metro);
//              'confirm':  standstills are unnumbered halts (lights, crossings
//                          and stops alike); the rider marks the real stops
//                          after the ride. Either way every standstill resets
//                          the speed drift: that is physics, not labelling.
//   copy       setup-screen texts, keyed by data-copy="..." in index.html
//   network    station data (js/stations.js) to name the stops, if any
//   length     real length in metres; a model the user loads is scaled to it
//   model      optional 3D model files (glTF) laid front to back, which way
//              their front faces in the file, and the size scale in metres
//              (length, height, width), e.g. { parts: ['assets/models/x.glb'],
//              front: '+z', scale: [1, 1, 1] }. Without it the procedural
//              model from js/models.js is used
//   demo       options for simulateRide() (js/sim.js) behind "Demo ride"

const DEG = Math.PI / 180;

// Shared street copy for bus and tram, filled with the noun.
const streetCopy = (noun, plural, curves) => ({
  openTitle: 'Open this page before you board',
  openText: "The page saves itself on the phone, so a patchy connection on the way doesn't matter.",
  sensorsText: 'The page needs the accelerometer and the gyroscope. On iPhone the browser will ask for permission. Location is asked for too, as a reference.',
  mountText: `The phone has to ride with the ${noun} and not move on its own. The floor is best; a seat or your lap rocks. ${plural} ${curves}, so put it where it can't slide.`,
  calibTitle: 'Calibrate at a stop',
  calibText: `While the ${noun} is standing at a stop, tap Start and don't touch the phone for 3 seconds. The first pull-away after that tells the app which way is forward.`,
  finishText: `At your stop, tap Finish as the ${noun} pulls in: you don't have to wait for it to stop.`,
  transferText: `Changing ${noun}s? Tap Pause at the stop and keep this page open while you walk: the phone's gyro carries the direction across. On the next ${noun}, fix the phone and tap Resume while it stands.`,
});

export const VEHICLES = {
  metro: {
    label: 'Metro',
    noun: 'train',
    length: 19,
    // Prague metro technical data (metroweb.cz): running tracks at most 40 ‰,
    // station tracks at most 3 ‰, so a stop that seems tilted means the phone moved.
    tracker: {
      maxPitch: 2.5 * DEG,
      stationPitch: 0.35 * DEG,
      // real stops need speed corrections of at most ~0.06 m/s² (measured);
      // a quiet stretch at 50 km/h taken for a stop needed 0.5. Street
      // vehicles creep in queues, where short hops need big ones, so not there.
      maxBias: 0.25,
    },
    gps: false,
    stops: 'stations',
    network: 'data/prague.json', // station names, order and platform depths
    copy: {
      note: 'Tuned for trains: smooth runs, gentle curves, level platforms.',
      openTitle: 'Open this page before you go underground',
      openText: 'There is no network in the tunnel. The page saves itself on the phone and then works offline.',
      sensorsText: 'The page needs the accelerometer and the gyroscope. On iPhone the browser will ask for permission.',
      mountText: "The phone has to ride with the car and not move on its own. Holding it in your hand won't work: your hand moves more than the train does.",
      calibTitle: 'Calibrate at a station',
      calibText: "While the train is standing at a station, tap Start and don't touch the phone for 3 seconds. The first departure after that tells the app which way is forward.",
      finishText: "At your last station, tap Finish as the train pulls in: you don't have to wait for it to stop.",
      transferText: 'Changing lines? Tap Pause at the station and keep this page open while you walk: the phone\'s gyro carries the direction across. On the next train, fix the phone and tap Resume while it stands.',
      demoNote: 'The demo runs a synthetic 4-segment metro ride through the same algorithm, 25× faster than real time.',
    },
    demo: {},
  },

  // Rails like the metro (no sideslip, smoother than a bus), streets like a
  // bus: tight junction curves (~20 m radius), traffic lights, hills.
  tram: {
    label: 'Tram',
    noun: 'tram',
    length: 31,
    tracker: {
      departAcc: 0.2,
      departHold: 0.35,
      minStillSec: 1.2,
      stopAcc: 0.25,
      slopeAcc: 0.8,
      slopeStillSec: 4,
      maxPitch: 8 * DEG,
      moveRate: 1.0,          // trams turn at up to ~20°/s
      minSegDist: 10,
      lockSec: 2,
      fAcc: 0.5,
      vMax: 80 / 3.6,
    },
    gps: true,
    stops: 'confirm',
    copy: {
      ...streetCopy('tram', 'Trams', 'lurch through junction curves'),
      note: 'Tuned for trams: rails like the metro, but tight street curves, traffic lights and hills. GPS is recorded too, to check the drawn route against it.',
      demoNote: 'The demo runs a synthetic 4-segment tram ride, with simulated GPS, through the same algorithm, 25× faster than real time.',
    },
    demo: {
      profile: 'tram', vmax: 14, aAcc: 1.1, aDec: 1.3, dwell: 20, vibration: 0.4, vibrationStill: 0.04,
      route: [
        { length: 520, curves: [{ at: 180, len: 35, angle: 80 }], grade: 3 },
        { length: 410, curves: [{ at: 120, len: 90, angle: -35 }], grade: -6 },
        { length: 680, curves: [{ at: 60, len: 30, angle: -90 }, { at: 400, len: 120, angle: 40 }], grade: 5 },
        { length: 450, curves: [], grade: -2 },
      ],
    },
  },

  // A city bus: short hops, right-angle turns, hard braking, stops on hills,
  // a body that rolls, squats and kneels at stops.
  bus: {
    label: 'Bus',
    noun: 'bus',
    length: 12,
    tracker: {
      departAcc: 0.25,        // an idling engine shakes more than a train at a platform
      departHold: 0.3,
      minStillSec: 1.0,       // traffic-light stops can be short
      stopAcc: 0.3,
      slopeAcc: 0.8,          // stops on hills, up to ~8 %
      slopeStillSec: 4,
      maxPitch: 10 * DEG,     // street grades are much steeper than metro ones
      moveRate: 1.2,          // a bus turns at up to ~30°/s; a hand moves a phone faster
      minSegDist: 8,
      lockSec: 2.5,           // pull-aways often start with a turn into traffic
      fAcc: 0.6,              // weaker pushes are mostly body roll and a phone rocking
      vMax: 80 / 3.6,
    },
    gps: true,
    stops: 'confirm',
    copy: {
      ...streetCopy('bus', 'Buses', 'corner hard'),
      note: 'Tuned for buses: sharp turns, hard braking, stops on hills. GPS is recorded too, to check the drawn route against it.',
      demoNote: 'The demo runs a synthetic 5-stop bus ride, with simulated GPS, through the same algorithm, 25× faster than real time.',
    },
    demo: {
      profile: 'bus', vmax: 13, aAcc: 1.3, aDec: 1.5, dwell: 15, vibration: 0.6, vibrationStill: 0.06,
      route: [
        { length: 420, curves: [{ at: 150, len: 22, angle: 90 }], grade: 4 },
        { length: 310, curves: [], grade: -3 },
        { length: 560, curves: [{ at: 80, len: 25, angle: -90 }, { at: 380, len: 60, angle: 30 }], grade: 6 },
        { length: 380, curves: [{ at: 200, len: 40, angle: -45 }], grade: -5 },
        { length: 470, curves: [{ at: 120, len: 22, angle: 90 }], grade: 2 },
      ],
    },
  },
};

/** The vehicle definition for an id, falling back to the metro. */
export function vehicleOf(id) {
  return VEHICLES[id] || VEHICLES.metro;
}

/** A known vehicle id, or 'metro'. */
export function vehicleId(id) {
  return VEHICLES[id] ? id : 'metro';
}
