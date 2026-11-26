// Low-poly vehicle models for the ride view, built from three.js primitives so
// they work offline. Each model faces +x (forward), sits with its floor on
// y = 0 and is sized in metres, like the rest of the scene. Windows glow so the
// vehicle reads in a dark tunnel.
import * as THREE from '../vendor/three.module.min.js';
import { GLTFLoader } from '../vendor/GLTFLoader.js';

const mat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.25, ...extra });
const glow = (color, intensity = 1) => new THREE.MeshStandardMaterial({ color: 0x111111, emissive: color, emissiveIntensity: intensity, roughness: 0.3 });

/** A body section: rounded cross-section (w x h, top corners rounded) extruded along x for len. */
function bodyShell(len, w, h, r, material) {
  const s = new THREE.Shape();
  s.moveTo(-w / 2, 0);
  s.lineTo(w / 2, 0);
  s.lineTo(w / 2, h - r);
  s.quadraticCurveTo(w / 2, h, w / 2 - r, h);
  s.lineTo(-w / 2 + r, h);
  s.quadraticCurveTo(-w / 2, h, -w / 2, h - r);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: len, bevelEnabled: true, bevelSize: 0.12, bevelThickness: 0.12, bevelSegments: 2, curveSegments: 6 });
  g.translate(0, 0, -len / 2);
  g.rotateY(Math.PI / 2); // extrusion axis z -> x (length along x)
  return new THREE.Mesh(g, material);
}

function box(x, y, z, sx, sy, sz, material) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), material);
  m.position.set(x, y, z);
  return m;
}

/** Window band and doors along both sides of a section centred at cx. */
function sides(group, cx, len, w, { winY, winH, doors = [], doorW = 1.3, doorY, doorH, glass, door, frame }) {
  for (const side of [-1, 1]) {
    const z = side * (w / 2 + 0.13);
    group.add(box(cx, winY, z, len - 1.2, winH, 0.04, glass));
    for (const dx of doors) {
      group.add(box(cx + dx, doorY, z + side * 0.01, doorW, doorH, 0.05, door));
      group.add(box(cx + dx, winY, z + side * 0.02, 0.06, winH, 0.05, frame)); // door split
    }
  }
}

function wheelSet(group, x, gauge, y, r, material) {
  for (const side of [-1, 1]) {
    const wh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.25, 16), material);
    wh.rotation.x = Math.PI / 2;
    wh.position.set(x, y, side * gauge / 2);
    group.add(wh);
  }
}

function lights(group, x, y, w, color = 0xfff2c8) {
  for (const side of [-1, 1]) group.add(box(x, y, side * (w / 2 - 0.4), 0.08, 0.18, 0.35, glow(color, 2.2)));
}

/** Metro car, ~19 m: silver body, coloured stripe, four doors a side, a cab at the front. */
function metroCar() {
  const g = new THREE.Group();
  const L = 19, W = 2.7, H = 3.0, floor = 1.0;
  const body = mat(0xc9d0d6, { metalness: 0.5 });
  g.add(bodyShell(L, W, H, 0.5, body).translateY(floor));
  // underframe and bogies
  g.add(box(0, floor - 0.25, 0, L - 3, 0.5, W - 0.5, mat(0x2a2f33)));
  for (const bx of [-6.5, 6.5]) {
    g.add(box(bx, 0.55, 0, 2.6, 0.45, W - 0.7, mat(0x1d2124)));
    for (const ax of [-0.9, 0.9]) wheelSet(g, bx + ax, 1.44, 0.45, 0.42, mat(0x3a3f44, { metalness: 0.7 }));
  }
  // stripe, windows and doors (lit inside)
  for (const side of [-1, 1]) g.add(box(0, floor + 0.95, side * (W / 2 + 0.11), L - 0.6, 0.22, 0.03, mat(0xffb238, { emissive: 0xffb238, emissiveIntensity: 0.25 })));
  sides(g, 0, L, W, { winY: floor + 1.9, winH: 0.85, doors: [-6, -2, 2, 6], doorY: floor + 1.2, doorH: 2.15, glass: glow(0xffe0a0, 0.9), door: mat(0x8d979e), frame: mat(0x30363b) });
  // cab: dark front mask, windscreen, headlights
  g.add(box(L / 2 + 0.16, floor + 1.4, 0, 0.08, 2.5, W - 0.2, mat(0x2b3136)));
  g.add(box(L / 2 + 0.22, floor + 1.95, 0, 0.04, 0.95, W - 0.6, glow(0x9ad0ff, 0.55)));
  lights(g, L / 2 + 0.24, floor + 0.55, W);
  // tail lights
  for (const side of [-1, 1]) g.add(box(-L / 2 - 0.22, floor + 0.55, side * (W / 2 - 0.4), 0.08, 0.16, 0.3, glow(0xff3b30, 1.5)));
  return g;
}

/** Articulated low-floor tram, ~31 m in three sections, red and cream, with a pantograph. */
function tram() {
  const g = new THREE.Group();
  const W = 2.46, H = 2.95, floor = 0.35;
  const red = mat(0xc8202c, { metalness: 0.3 }), cream = mat(0xf1e6cf, { metalness: 0.1 });
  const sections = [{ x: 10.2, len: 10 }, { x: 0, len: 9.4 }, { x: -10.2, len: 10 }];
  for (const s of sections) {
    g.add(bodyShell(s.len, W, H, 0.45, cream).translateX(s.x).translateY(floor));
    for (const side of [-1, 1]) g.add(box(s.x, floor + 0.4, side * (W / 2 + 0.11), s.len - 0.2, 0.8, 0.03, red)); // red skirt
    sides(g, s.x, s.len, W, { winY: floor + 1.75, winH: 1.15, doors: [-2.6, 2.6], doorW: 1.3, doorY: floor + 1.1, doorH: 2.0, glass: glow(0xffe6b0, 0.85), door: red, frame: mat(0x2b2b2b) });
    for (const ax of [-3.2, 3.2]) wheelSet(g, s.x + ax, 1.435, 0.35, 0.34, mat(0x2a2a2a));
  }
  // bellows between sections
  for (const x of [5.1, -5.1]) g.add(box(x, floor + 1.5, 0, 0.8, H - 0.3, W - 0.3, mat(0x222222)));
  // red roof line and pantograph on the middle section
  g.add(box(0, floor + H + 0.15, 0, 30, 0.12, 1.4, red));
  const pan = new THREE.Group();
  const rod = mat(0x555c61, { metalness: 0.8 });
  pan.add(box(0, 0.55, 0, 0.12, 1.2, 0.12, rod).rotateZ(0.6));
  pan.add(box(0.7, 1.4, 0, 0.12, 1.2, 0.12, rod).rotateZ(-0.6));
  pan.add(box(0.35, 2.0, 0, 0.18, 0.1, 1.8, rod));
  pan.position.set(-1, floor + H + 0.2, 0);
  g.add(pan);
  // front: windscreen and lights
  g.add(box(15.38, floor + 1.85, 0, 0.04, 1.25, W - 0.5, glow(0x9ad0ff, 0.55)));
  lights(g, 15.4, floor + 0.7, W);
  return g;
}

/** City bus, 12 m: big windows, wheels, a destination display. */
function bus() {
  const g = new THREE.Group();
  const L = 12, W = 2.55, H = 2.75, floor = 0.35;
  const paint = mat(0xe8eef2, { metalness: 0.2 }), accent = mat(0xe3262f);
  g.add(bodyShell(L, W, H, 0.35, paint).translateY(floor));
  for (const side of [-1, 1]) g.add(box(0, floor + 0.35, side * (W / 2 + 0.11), L - 0.4, 0.5, 0.03, accent));
  sides(g, 0, L, W, { winY: floor + 1.75, winH: 1.2, doors: [4.7, 0.2, -4.0], doorW: 1.2, doorY: floor + 1.15, doorH: 2.1, glass: glow(0xffe6b0, 0.8), door: mat(0x3a4148), frame: mat(0x1e2226) });
  // wheels in arches
  for (const x of [3.6, -2.4]) {
    wheelSet(g, x, W + 0.1, 0.5, 0.5, mat(0x1b1b1b));
    for (const side of [-1, 1]) g.add(box(x, 0.85, side * (W / 2 + 0.1), 1.3, 0.12, 0.04, mat(0x222222)));
  }
  // front: windscreen, destination display, lights; rear engine grille
  g.add(box(L / 2 + 0.2, floor + 1.55, 0, 0.04, 1.5, W - 0.4, glow(0x9ad0ff, 0.55)));
  g.add(box(L / 2 + 0.22, floor + 2.5, 0, 0.04, 0.3, W - 0.7, glow(0xffa21f, 1.6)));
  lights(g, L / 2 + 0.24, floor + 0.5, W);
  g.add(box(-L / 2 - 0.2, floor + 0.9, 0, 0.06, 0.9, W - 0.6, mat(0x2a2f33)));
  for (const side of [-1, 1]) g.add(box(-L / 2 - 0.22, floor + 0.55, side * (W / 2 - 0.35), 0.08, 0.16, 0.3, glow(0xff3b30, 1.5)));
  return g;
}

const BUILDERS = { metro: metroCar, tram, bus };

/** The model for a vehicle id ('metro' | 'tram' | 'bus'), centred on its length. */
export function vehicleModel(kind = 'metro') {
  const g = (BUILDERS[kind] || metroCar)();
  g.traverse((o) => { if (o.isMesh) o.castShadow = false; });
  return g;
}

// ---------- models from files ----------

const loader = new GLTFLoader();
const scenes = new Map(); // url -> Promise<THREE.Group>
const FRONT = { '+x': 0, '+z': Math.PI / 2, '-x': Math.PI, '-z': -Math.PI / 2 };

function loadScene(url) {
  if (!scenes.has(url)) scenes.set(url, loader.loadAsync(url).then((g) => g.scene));
  return scenes.get(url);
}

/**
 * Builds a vehicle from glTF files (spec from js/vehicles.js): each part is
 * turned to face +x and laid behind the previous one, the whole is centred
 * on its length with its floor on y = 0 and scaled to metres.
 */
export async function loadVehicleModel(spec) {
  const parts = await Promise.all(spec.parts.map(loadScene));
  const train = new THREE.Group();
  let front = 0;
  for (const src of parts) {
    const holder = new THREE.Group();
    const part = src.clone(true);
    part.rotation.y = FRONT[spec.front] ?? 0;
    holder.add(part);
    holder.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(holder);
    holder.position.x = front - box.max.x;
    front -= box.max.x - box.min.x;
    train.add(holder);
  }
  train.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(train);
  const centre = box.getCenter(new THREE.Vector3());
  for (const h of train.children) { h.position.x -= centre.x; h.position.y -= box.min.y; h.position.z -= centre.z; }
  const out = new THREE.Group();
  out.add(train);
  if (spec.length) out.scale.setScalar(spec.length / Math.max(box.max.x - box.min.x, 1e-6)); // to real size, not stretched
  else out.scale.set(...(spec.scale || [1, 1, 1]));
  return out;
}

/** A first guess for a new file: its front lies along its longer horizontal axis. */
export async function guessFront(url) {
  const size = new THREE.Box3().setFromObject(await loadScene(url)).getSize(new THREE.Vector3());
  return size.x >= size.z ? '+x' : '+z';
}

/** Order of the "Turn 90°" button: which way the file's front faces. */
export const FRONTS = ['+x', '+z', '-x', '-z'];

/**
 * A small turntable preview on a canvas, with an arrow marking the front.
 * show(model) frames any model; the turntable spins while the page is visible.
 */
export function modelPreview(canvas) {
  const r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xfff1d6, 0x101418, 1.3));
  const sun = new THREE.DirectionalLight(0xffffff, 0.9); sun.position.set(30, 40, 50); scene.add(sun);
  const cam = new THREE.PerspectiveCamera(30, 2, 0.1, 2000);
  const table = new THREE.Group(); scene.add(table);
  let current = null, raf = 0, fit = null;
  const frame = () => {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (w && h && (canvas.width !== Math.round(w * r.getPixelRatio()) || canvas.height !== Math.round(h * r.getPixelRatio()))) {
      r.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix();
    }
    if (fit) {
      // the whole turntable fits whichever way it faces
      const half = Math.min(cam.fov / 2, Math.atan(Math.tan(cam.fov * Math.PI / 360) * cam.aspect) * 180 / Math.PI) * Math.PI / 180;
      const d = fit.r / Math.tan(half);
      cam.position.set(0, fit.y + d * 0.3, d * 0.95);
      cam.lookAt(0, fit.y, 0);
    }
    table.rotation.y += 0.006;
    r.render(scene, cam);
    raf = document.hidden ? 0 : requestAnimationFrame(frame);
  };
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !raf) raf = requestAnimationFrame(frame); });
  return {
    show(model) {
      if (current) table.remove(current);
      current = new THREE.Group();
      current.add(model);
      const box = new THREE.Box3().setFromObject(model), size = box.getSize(new THREE.Vector3());
      const len = Math.max(size.x, size.z, 1);
      const arrow = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(box.max.x + len * 0.04, size.y * 0.5, 0), len * 0.25, 0xffb238, len * 0.08, len * 0.05);
      current.add(arrow);
      table.add(current);
      fit = { r: len * 0.62, y: size.y * 0.45 };
      if (!raf) raf = requestAnimationFrame(frame);
    },
  };
}
