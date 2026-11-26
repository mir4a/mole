// 3D view: finished segments as tunnel tubes, the current ride as a live line,
// stops as platforms. Tracker frame (x fwd, y left, z up) -> three.js (x, y up, -z).
import * as THREE from '../vendor/three.module.min.js';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { vehicleModel } from './models.js';

const COLORS = {
  bg: 0x0b0f12, tunnel: 0xffb238, open: 0xb8c4cc, gps: 0x5aa9ff, centre: 0xffd27a, live: 0xf2f5f7,
  platform: 0x4fd08a, grid: 0x24313a, gridMain: 0x3a4a56, train: 0xffffff,
};

export class TunnelScene {
  constructor(container) {
    this.vex = 1; // vertical exaggeration
    this.links = [];          // vertical links between platforms at transfers
    this.numberStops = true; // metro stations get numbers; bus and tram halts don't
    this.k = 1;   // visual scale of tube/platform/labels (grows in overview so they stay visible)
    this.mode = 'follow';
    this.segments = []; // { points (tracker frame), open (no closing stop, uncorrected) }
    this.stops = [];
    this.livePts = [];
    this.trainPos = [0, 0, 0];
    this.heading = 0;

    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true }));
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    r.setClearColor(COLORS.bg);
    container.appendChild(r.domElement);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(COLORS.bg, 0.00045);
    this.camera = new THREE.PerspectiveCamera(55, 1, 1, 60000);
    this.camera.position.set(-150, 90, 60);

    this.controls = new OrbitControls(this.camera, r.domElement);
    this.controls.enableDamping = true;
    this.controls.enabled = false;
    this.controls.autoRotateSpeed = 0.8;
    this.controls.addEventListener('start', () => { this.controls.autoRotate = false; });
    r.domElement.addEventListener('pointerdown', () => { if (this.mode === 'follow') this.setMode('free'); });

    this.scene.add(new THREE.HemisphereLight(0xfff1d6, 0x101418, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 0.6);
    sun.position.set(300, 800, 200);
    this.scene.add(sun);

    this.grid = new THREE.GridHelper(40000, 400, COLORS.gridMain, COLORS.grid);
    this.grid.position.y = -40;
    this.scene.add(this.grid);

    this.tunnelGroup = new THREE.Group();
    this.scene.add(this.tunnelGroup);
    this.stopGroup = new THREE.Group();
    this.scene.add(this.stopGroup);

    // live line (growable)
    this.liveMax = 20000;
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.liveMax * 3), 3));
    lg.setDrawRange(0, 0);
    this.liveLine = new THREE.Line(lg, new THREE.LineBasicMaterial({ color: COLORS.live, transparent: true, opacity: 0.9 }));
    this.liveLine.frustumCulled = false;
    this.scene.add(this.liveLine);
    // the 1px line is near-invisible on phones, so the live path is also drawn as a tube
    this.liveTube = null;
    this.liveBuiltAt = 0;
    this.liveMat = new THREE.MeshBasicMaterial({ color: COLORS.live, transparent: true, opacity: 0.85 });
    // GPS reference track (bus mode)
    this.gpsPts = [];
    this.gpsMesh = null;
    this.gpsMat = new THREE.MeshBasicMaterial({ color: COLORS.gps, transparent: true, opacity: 0.8 });

    // the vehicle: a model per kind (js/models.js), with a lamp ahead of it
    this.train = new THREE.Group();
    this.train.rotation.order = 'YZX'; // heading, then pitch in the vehicle's frame
    this.scene.add(this.train);
    const lamp = new THREE.PointLight(0xffc870, 2.5, 140, 1.2);
    lamp.position.set(14, 2, 0);
    this.train.add(lamp);
    this.pitch = 0;
    this.setVehicle('metro');

    this.resize = this.resize.bind(this);
    window.addEventListener('resize', this.resize);
    this.resize();
    this.addStop([0, 0, 0], 0, 0);
  }

  toThree(p) { return new THREE.Vector3(p[0], p[2] * this.vex, -p[1]); }

  resize() {
    const el = this.renderer.domElement.parentElement;
    const w = el.clientWidth || window.innerWidth, h = el.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  clear() {
    this.segments = []; this.stops = []; this.livePts = []; this.gpsPts = []; this.links = [];
    this.trainPos = [0, 0, 0]; this.heading = 0;
    this.rebuild();
    this.addStop([0, 0, 0], 0, 0);
  }

  addSegment(points, opts = {}) {
    const seg = { points, open: !!opts.open };
    this.segments.push(seg);
    this.buildSegment(seg);
  }

  buildSegment({ points, open }) {
    if (points.length < 2) return;
    const color = open ? COLORS.open : COLORS.tunnel;
    const pts = points.map((p) => this.toThree(p));
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    const lengthM = curve.getLength();
    const tube = new THREE.Mesh(
      new THREE.TubeGeometry(curve, Math.min(Math.max(Math.round(lengthM / 6), 8), 1500), 3 * this.k, 12, false),
      new THREE.MeshStandardMaterial({
        color, emissive: color, emissiveIntensity: 0.12,
        transparent: true, opacity: 0.34, side: THREE.DoubleSide, depthWrite: false, roughness: 0.6,
      })
    );
    const rings = new THREE.Mesh(
      new THREE.TubeGeometry(curve, Math.min(Math.max(Math.round(lengthM / 25), 4), 600), 3.05 * this.k, 10, false),
      new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.18 })
    );
    const centre = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: open ? COLORS.open : COLORS.centre })
    );
    this.tunnelGroup.add(tube, rings, centre);
  }

  /** label: text over the platform, null for an unnumbered halt, undefined for the default. */
  addStop(p, n, heading, label) {
    this.stops.push({ p, n, heading, label });
    this.buildStop(p, n, heading, label);
  }

  /** A vertical link between two platforms at a transfer. */
  addLink(a, b) {
    const l = { a, b };
    this.links.push(l);
    this.buildLink(l);
  }

  buildLink({ a, b }) {
    const pa = this.toThree(a), pb = this.toThree(b);
    if (pa.distanceTo(pb) < 0.5) return;
    const geo = new THREE.TubeGeometry(new THREE.LineCurve3(pa, pb), 4, 1.2 * this.k, 8, false);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: COLORS.platform, transparent: true, opacity: 0.6 }));
    this.tunnelGroup.add(mesh);
  }

  /** Relabels the stop numbered n, adding it if it isn't drawn yet. */
  setStopLabel(n, label, p, heading = 0) {
    const s = this.stops.find((x) => x.n === n);
    if (s) { s.label = label; this.rebuild(); } else if (p) this.addStop(p, n, heading, label);
  }

  /** Relabels all stops at once (index = stop number; 'start' at 0). */
  setStopLabels(labels) {
    this.stops.forEach((s, i) => { s.label = labels[i]; });
    this.rebuild();
  }

  buildStop(p, n, heading, label) {
    const g = new THREE.Group();
    const plat = new THREE.Mesh(
      new THREE.BoxGeometry(100 + 20 * this.k, 1.2 * this.k, 9 * this.k),
      new THREE.MeshStandardMaterial({ color: COLORS.platform, emissive: COLORS.platform, emissiveIntensity: 0.35, transparent: true, opacity: 0.75 })
    );
    plat.position.y = -2.5 * this.k;
    g.add(plat);
    const text = label !== undefined ? label : n === 0 ? 'start' : this.numberStops ? String(n) : null;
    if (text) {
      const sprite = makeLabel(text);
      sprite.position.y *= this.k;
      g.add(sprite);
    } else {
      plat.scale.set(0.35, 1, 1); // a halt at a light or a crossing: short, unnumbered
    }
    g.position.copy(this.toThree(p));
    g.rotation.y = heading;
    this.stopGroup.add(g);
  }

  setLive(points, force = false) {
    const now = performance.now();
    // the tracker appends to the same array, so compare against the count we last built
    const grew = points !== this.livePts || points.length !== this.liveBuiltLen;
    this.livePts = points;
    if (force || points.length < 2 || (grew && now - this.liveBuiltAt > 300)) this.buildLiveTube(points, now);
    const n = Math.min(points.length, this.liveMax);
    const arr = this.liveLine.geometry.attributes.position.array;
    for (let i = 0; i < n; i++) {
      const p = points[i];
      arr[i * 3] = p[0]; arr[i * 3 + 1] = p[2] * this.vex; arr[i * 3 + 2] = -p[1];
    }
    this.liveLine.geometry.attributes.position.needsUpdate = true;
    this.liveLine.geometry.setDrawRange(0, n);
  }

  buildLiveTube(points, now) {
    this.liveBuiltAt = now;
    this.liveBuiltLen = points.length;
    if (this.liveTube) {
      this.scene.remove(this.liveTube);
      this.liveTube.geometry.dispose();
      this.liveTube = null;
    }
    if (points.length < 2) return;
    const step = Math.max(1, Math.ceil(points.length / 600));
    const pts = points.filter((_, i) => i % step === 0 || i === points.length - 1).map((p) => this.toThree(p));
    if (pts.length < 2) return;
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    this.liveTube = new THREE.Mesh(new THREE.TubeGeometry(curve, pts.length * 2, 1.6 * this.k, 6, false), this.liveMat);
    this.liveTube.frustumCulled = false;
    this.scene.add(this.liveTube);
  }

  setGps(points) {
    this.gpsPts = points;
    if (this.gpsMesh) {
      this.scene.remove(this.gpsMesh);
      this.gpsMesh.geometry.dispose();
      this.gpsMesh = null;
    }
    if (points.length < 2) return;
    const step = Math.max(1, Math.ceil(points.length / 800));
    const pts = points.filter((_, i) => i % step === 0 || i === points.length - 1).map((p) => this.toThree(p));
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    this.gpsMesh = new THREE.Mesh(new THREE.TubeGeometry(curve, pts.length * 2, 1.0 * this.k, 5, false), this.gpsMat);
    this.gpsMesh.frustumCulled = false;
    this.scene.add(this.gpsMesh);
  }

  setTrain(pos, heading, pitch = 0) {
    this.trainPos = pos;
    this.heading = heading;
    this.pitch = pitch;
  }

  /** Swaps the vehicle model ('metro' | 'tram' | 'bus'). */
  setVehicle(kind) {
    if (this.vehicleKind === kind) return;
    this.vehicleKind = kind;
    if (this.model) {
      this.train.remove(this.model);
      this.model.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
    }
    this.model = vehicleModel(kind);
    this.model.position.y = -1.8; // sit roughly centred in the 3 m tunnel tube
    this.train.add(this.model);
  }

  setAutoRotate(on) { this.controls.autoRotate = on; }

  setVex(v) { this.vex = v; this.rebuild(); }

  rebuild() {
    for (const grp of [this.tunnelGroup, this.stopGroup]) {
      for (const c of [...grp.children]) {
        grp.remove(c);
        c.traverse?.((o) => { o.geometry?.dispose(); o.material?.map?.dispose(); o.material?.dispose(); });
      }
    }
    for (const s of this.segments) this.buildSegment(s);
    for (const l of this.links) this.buildLink(l);
    const stops = this.stops; this.stops = [];
    for (const s of stops) this.addStop(s.p, s.n, s.heading, s.label);
    this.setLive(this.livePts, true);
    this.setGps(this.gpsPts);
  }

  setMode(mode) {
    this.mode = mode;
    this.controls.enabled = mode !== 'follow';
    const far = mode === 'overview';
    this.scene.fog.density = far ? 0 : 0.00045;
    const k = far ? Math.max(1, this.extent() / 900) : 1;
    if (k !== this.k) { this.k = k; this.train.scale.setScalar(k); this.rebuild(); }
    if (far) this.fitAll();
    this.onModeChange?.(mode);
  }

  extent() {
    const box = new THREE.Box3();
    box.expandByPoint(this.toThree(this.trainPos));
    for (const s of this.segments) for (const p of s.points) box.expandByPoint(this.toThree(p));
    for (const p of this.livePts) box.expandByPoint(this.toThree(p));
    for (const p of this.gpsPts) box.expandByPoint(this.toThree(p));
    return box.getSize(new THREE.Vector3()).length();
  }

  fitAll() {
    const box = new THREE.Box3();
    box.expandByPoint(this.toThree(this.trainPos));
    for (const s of this.segments) for (const p of s.points) box.expandByPoint(this.toThree(p));
    for (const p of this.livePts) box.expandByPoint(this.toThree(p));
    for (const p of this.gpsPts) box.expandByPoint(this.toThree(p));
    const c = box.getCenter(new THREE.Vector3());
    const size = Math.max(box.getSize(new THREE.Vector3()).length(), 200);
    this.controls.target.copy(c);
    this.camera.position.set(c.x - size * 0.45, c.y + size * 0.42, c.z + size * 0.6);
    this.controls.update();
  }

  render() {
    const tp = this.toThree(this.trainPos);
    this.train.position.copy(tp);
    this.train.rotation.y = this.heading;
    this.train.rotation.z = Math.atan(Math.tan(this.pitch) * this.vex); // drawn with the height exaggeration
    if (this.mode === 'follow') {
      // rigidly behind the vehicle (fast replays too); only the view direction is smoothed
      if (this.camHeading == null) this.camHeading = this.heading;
      const dh = Math.atan2(Math.sin(this.heading - this.camHeading), Math.cos(this.heading - this.camHeading));
      this.camHeading += dh * 0.08;
      const back = new THREE.Vector3(-Math.cos(this.camHeading), 0, Math.sin(this.camHeading));
      const side = new THREE.Vector3(-back.z, 0, back.x);
      this.camera.position.copy(tp).addScaledVector(back, 48).addScaledVector(side, 14).add(new THREE.Vector3(0, 20, 0));
      this.controls.target.copy(tp).addScaledVector(back, -12);
      this.camera.lookAt(this.controls.target);
    } else {
      this.controls.update();
    }
    this.grid.position.x = Math.round(tp.x / 100) * 100;
    this.grid.position.z = Math.round(tp.z / 100) * 100;
    this.renderer.render(this.scene, this.camera);
  }
}

function makeLabel(text) {
  const c = document.createElement('canvas');
  const probe = c.getContext('2d');
  probe.font = '600 48px system-ui, sans-serif';
  const W = Math.min(768, Math.max(256, Math.ceil(probe.measureText(text).width) + 80));
  c.width = W; c.height = 128;
  const x = c.getContext('2d');
  x.fillStyle = 'rgba(11,15,18,0.85)';
  x.beginPath();
  if (x.roundRect) x.roundRect(28, 20, W - 56, 88, 18); else x.rect(28, 20, W - 56, 88);
  x.fill();
  x.strokeStyle = '#4fd08a'; x.lineWidth = 6; x.stroke();
  x.fillStyle = '#e8edf0';
  let size = 48;
  do { x.font = `600 ${size}px system-ui, sans-serif`; size -= 2; } while (x.measureText(text).width > W - 80 && size > 18);
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText(text, W / 2, 66);
  // constant size on screen: readable from far away, never a wall of text up close
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, transparent: true, sizeAttenuation: false }));
  s.scale.set(0.07 * (W / 256), 0.035, 1);
  s.position.y = 22;
  s.renderOrder = 10;
  return s;
}
