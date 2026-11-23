// The build plate view: opens on an empty P1S-sized bed, then shows each plate Set2Print lays out.
// Bed grid, lighting and camera framing follow printfins.com's web/ui/scene.js (MIT).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const host = document.getElementById('viewport');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
host.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 1, 1, 5000);
camera.up.set(0, 0, 1);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;

scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x6f7480, 2.0));
const key = new THREE.DirectionalLight(0xffffff, 1.6); key.position.set(0.6, -1, 1.4); scene.add(key);
const fill = new THREE.DirectionalLight(0xffffff, 0.5); fill.position.set(-1, 0.7, 0.5); scene.add(fill);
const under = new THREE.DirectionalLight(0xffffff, 0.6); under.position.set(-0.35, 0.55, -1.2); scene.add(under);

const bed = new THREE.Group(); scene.add(bed);
const parts = new THREE.Group(); scene.add(parts);
let size = 256;

function theme() {
  const css = getComputedStyle(document.documentElement);
  return { bg: css.getPropertyValue('--view-bg').trim() || '#16191c', minor: css.getPropertyValue('--view-grid').trim() || '#2b303a', major: css.getPropertyValue('--view-grid-major').trim() || '#3d4552' };
}

export function buildBed(sx = 256, sy = sx, sz = 250) {
  size = sx;
  bed.clear();
  const t = theme();
  scene.background = new THREE.Color(t.bg);
  const hx = sx / 2, hy = sy / 2, minor = [], major = [];
  for (let x = -hx; x <= hx + 0.01; x += 10) ((Math.round(x + hx) % 50 === 0) ? major : minor).push(x, -hy, 0, x, hy, 0);
  for (let y = -hy; y <= hy + 0.01; y += 10) ((Math.round(y + hy) % 50 === 0) ? major : minor).push(-hx, y, 0, hx, y, 0);
  for (const [pts, color] of [[minor, t.minor], [major, t.major]]) {
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    bed.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color })));
  }
  // the textured plate itself, slightly below the grid
  const plateMesh = new THREE.Mesh(new THREE.PlaneGeometry(sx, sy), new THREE.MeshStandardMaterial({ color: 0x23272b, roughness: 0.95 }));
  plateMesh.position.z = -0.05; bed.add(plateMesh);
  // P1/X1 front-left no-print corner (18 x 28 mm)
  const zone = new THREE.Mesh(new THREE.PlaneGeometry(18, 28), new THREE.MeshBasicMaterial({ color: 0x5a2a2a, transparent: true, opacity: 0.6 }));
  zone.position.set(-hx + 9, -hy + 14, 0.01); bed.add(zone);
  const box = new THREE.Box3Helper(new THREE.Box3(new THREE.Vector3(-hx, -hy, 0), new THREE.Vector3(hx, hy, sz)), new THREE.Color(t.major));
  box.material.transparent = true; box.material.opacity = 0.35; bed.add(box);
  frame();
}

function frame() {
  const reach = size;
  const dist = reach * 1.45 * Math.max(1, 1.0 / camera.aspect);
  camera.position.set(dist * 0.15, -dist * 0.85, dist * 0.7);
  camera.near = 1; camera.far = dist * 10; camera.updateProjectionMatrix();
  controls.target.set(0, 10, 20); controls.update();
  redraw();
}

const geoCache = new WeakMap();
function geometryOf(mesh) {
  if (geoCache.has(mesh)) return geoCache.get(mesh);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(mesh.verts, 3));
  g.setIndex(new THREE.BufferAttribute(mesh.tris, 1));
  g.computeVertexNormals();
  geoCache.set(mesh, g);
  return g;
}

/** Show one plate: items [{ mesh, cx, cy }] in bed coordinates (0..size), scale, colour rgb hex. */
export function showPlate(plate) {
  parts.clear();
  redraw();
  if (!plate) return;
  const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#' + plate.rgb), roughness: 0.55, metalness: 0, side: THREE.DoubleSide });
  for (const it of plate.items) {
    const m = new THREE.Mesh(geometryOf(it.mesh), mat);
    m.scale.setScalar(plate.scale);
    m.position.set(it.cx - size / 2, it.cy - size / 2, 0);
    parts.add(m);
  }
}

function resize() {
  const w = host.clientWidth, h = host.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix(); frame();
}
new ResizeObserver(() => { resize(); }).observe(host);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => buildBed(size));

// Drawn only when something changed (a plate, the bed, the size, the camera), not 60 times a second: without a GPU
// (software WebGL) the constant redraw took most of the CPU the part loading and support checks need.
let queued = false;
function redraw() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; const moving = controls.update(); renderer.render(scene, camera); if (moving) redraw(); });   // damping keeps the camera gliding a few frames
}
controls.addEventListener('change', redraw);
resize();
buildBed(256);
