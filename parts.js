// LDraw part -> studs-up triangle mesh in millimetres. Shared by the site (app.js) and the audit (audit/).
import * as THREE from 'three';
import { LDrawLoader } from 'three/addons/loaders/LDrawLoader.js';

// raw.githubusercontent serves every file with CORS; jsDelivr refuses parts of this repo (over its 50 MB limit).
let LIB = 'https://raw.githubusercontent.com/gkjohnson/ldraw-parts-library/master/complete/ldraw/';
const LDU_MM = 0.4;            // 1 LDraw unit = 0.4 mm

// ---- print-accurate studs and tubes ----
// LDraw is drawn for screens: its stud is a 16-sided cylinder (4.71 mm across the flats, LEGO 4.80)
// and its underside tube is 6.40 mm across (LEGO 6.51). Printed, those don't clutch at all. Parts
// build their studs and tubes from shared primitives, so every common one is replaced here with a
// 96-sided cylinder whose flats sit at the printable size: solid studs (stud.dat), open studs
// (stud2/stud2a, same outside), tubes (stud4/stud4a). LDraw units: 1 LDU = 0.4 mm, -Y is up.
// Not replaced (no printed reference number yet): the 1xN underside pin stud3 and rarer variants.
const SEGS = 96, FLAT = 1 / Math.cos(Math.PI / SEGS);   // corner radius that puts the flats on size
// Studs 5.00 mm across: MachineBlocks 5.00, Klemmbrick 5.04 (measured, 2,800+ prints); research/fdm-printing SKILL.md:285,295.
// Tubes stay 6.51 (LEGO; Klemmbrick 6.53, MachineBlocks 6.41). The fit test then tunes both in 0.05 mm steps.
const STUD_R = (2.5 / LDU_MM) * FLAT, TUBE_R = (3.255 / LDU_MM) * FLAT, TUBE_HOLE_R = (2.4 / LDU_MM) * FLAT;
const OPEN_STUD_HOLE_R = (1.6 / LDU_MM) * FLAT;          // LDraw's open-stud hole (4 LDU), now round at size
function ring(r, y) { return Array.from({ length: SEGS }, (_, k) => [r * Math.cos((2 * Math.PI * k) / SEGS), y, r * Math.sin((2 * Math.PI * k) / SEGS)]); }
const P = (p) => p.map((v) => +v.toFixed(4)).join(' ');
// type-4 quads / type-3 triangles, wound counter-clockwise seen from outside (BFC CERTIFY CCW)
// Stud height 1.7 mm (LEGO; proven printable bricks use 1.6-1.8: MachineBlocks 1.6, Klemmbrick 1.8).
// LDraw's plate hollow is only 1.6 mm deep, so printFit() below deepens plate hollows to 2.2 mm
// (MachineBlocks' value), leaving 0.5 mm above the stud for the printed roof's droop.
const STUD_H = 1.7 / LDU_MM;
// A stud standing on the part's top face, open at the bottom like LDraw's. (Closing it with a bottom
// face made the support check read 471 mm2 of 3036's top as unsupported and pillar it.) hole > 0: open stud.
function studDat(hole = 0) {
  const lo = ring(STUD_R, 0), hi = ring(STUD_R, -STUD_H), out = ['0 Set2Print print-accurate stud', '0 BFC CERTIFY CCW'];
  const iLo = ring(hole, 0), iHi = ring(hole, -STUD_H);
  for (let k = 0; k < SEGS; k++) {
    const k2 = (k + 1) % SEGS;
    out.push(`4 16 ${P(lo[k2])} ${P(hi[k2])} ${P(hi[k])} ${P(lo[k])}`);   // side, facing out
    if (!hole) { out.push(`3 16 0 ${P([-STUD_H])} 0 ${P(hi[k])} ${P(hi[k2])}`); continue; }   // top, facing up (-Y)
    out.push(`4 16 ${P(iLo[k])} ${P(iHi[k])} ${P(iHi[k2])} ${P(iLo[k2])}`);   // hole wall, facing the hole
    out.push(`4 16 ${P(hi[k2])} ${P(iHi[k2])} ${P(iHi[k])} ${P(hi[k])}`);     // top ring, facing up
  }
  return out.join('\n') + '\n';
}
function tubeDat() {
  const oLo = ring(TUBE_R, 0), oHi = ring(TUBE_R, -4), iLo = ring(TUBE_HOLE_R, 0), iHi = ring(TUBE_HOLE_R, -4);
  const out = ['0 Set2Print print-accurate underside tube', '0 BFC CERTIFY CCW'];
  for (let k = 0; k < SEGS; k++) {
    const k2 = (k + 1) % SEGS;
    out.push(`4 16 ${P(oLo[k2])} ${P(oHi[k2])} ${P(oHi[k])} ${P(oLo[k])}`);   // outer wall, facing out
    out.push(`4 16 ${P(iLo[k])} ${P(iHi[k])} ${P(iHi[k2])} ${P(iLo[k2])}`);   // inner wall, facing the hole
    out.push(`4 16 ${P(oLo[k])} ${P(iLo[k])} ${P(iLo[k2])} ${P(oLo[k2])}`);   // bottom ring, facing down (+Y)
    out.push(`4 16 ${P(oHi[k2])} ${P(iHi[k2])} ${P(iHi[k])} ${P(oHi[k])}`);   // top ring (inside the part)
  }
  return out.join('\n') + '\n';
}
// Our faces carry their own colour code so toMesh() can find them and turn any stud or tube that came
// out inside-out right side out: through three.js some references flip the winding (upside-down tubes
// in 3062a and 85861, the mirrored side open stud of 4070 and 87087, which then sliced with mid-air).
const OWN = '9716';
const own = (text) => text.replace('0 BFC CERTIFY CCW', `0 BFC CERTIFY CCW\n0 !COLOUR Set2Print_Primitive CODE ${OWN} VALUE #808080 EDGE #333333`).replace(/^([34]) 16 /gm, `$1 ${OWN} `);
const OPEN = own(studDat(OPEN_STUD_HOLE_R)), TUBE = own(tubeDat());
const PRINT_PRIMITIVES = { 'stud.dat': own(studDat()), 'stud2.dat': OPEN, 'stud2a.dat': OPEN, 'stud4.dat': TUBE, 'stud4a.dat': TUBE };
const dataUrl = (text) => 'data:text/plain;charset=utf-8,' + encodeURIComponent(text);
const loader = new LDrawLoader();
loader.manager.setURLModifier((url) => {
  const m = /\/(?:parts|p)\/(stud(?:2a?|4a?)?\.dat)$/i.exec(url);
  return m ? dataUrl(PRINT_PRIMITIVES[m[1].toLowerCase()]) : url;
});
loader.setPartsLibraryPath(LIB);

/** Point at another copy of the LDraw library (the audit uses a local one). */
export function setLibrary(url) { LIB = url; loader.setPartsLibraryPath(url); materialsReady = null; geomCache.clear(); }
let materialsReady = null;
const geomCache = new Map();

function candidates(id) {
  const base = id.toLowerCase().replace(/\.dat$/, '');
  // Rebrickable adds print / pattern / sticker suffixes the 3D shape doesn't care about:
  // 3069bpr0001 -> 3069b -> 3069, 92456c01pr0035 -> 92456c01 -> 92456, 6126a -> 6126
  const noPrint = base.replace(/(pr|pat|px|pb|ps|pt|pc)\d+[a-z]?$/, '');
  const noAssembly = noPrint.replace(/c\d{2}$/, '');
  const mold = noAssembly.match(/^(\d+[a-z]?)/)?.[1];
  const digits = noAssembly.match(/^(\d+)/)?.[1];
  return [...new Set([base, noPrint, noAssembly, mold, digits].filter(Boolean))];
}

function parseAsync(text) {
  return new Promise((res, rej) => loader.parse(text, res, rej));
}

export async function loadPart(id) {
  if (geomCache.has(id)) return geomCache.get(id);
  const p = (async () => {
    if (!materialsReady) materialsReady = loader.preloadMaterials(LIB + 'LDConfig.ldr').catch(() => {});
    await materialsReady;
    for (const name of candidates(id)) {
      const ok = await fetch(LIB + 'parts/' + name + '.dat', { method: 'HEAD' }).then((r) => r.ok).catch(() => false);
      if (!ok) continue;
      const group = await parseAsync(`0 Set2Print\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 ${name}.dat\n`);
      const mesh = toMesh(group);
      if (!mesh.tris.length) continue; // a sub-file failed to load: treat as not found rather than ship an empty part
      return { name, mesh };
    }
    return null;
  })();
  geomCache.set(id, p);
  return p;
}

// ---- print fit: two things every proven printable brick does and LDraw doesn't ----
// 1. Side gap: LDraw draws parts at the full 8 mm grid (a 2x4 is 32.0 x 16.0). MachineBlocks and
//    LEGO.scad take 0.1 mm off each side (31.8 x 15.8), Klemmbrick 0.075, so neighbours don't jam.
//    Every outside wall lying on the part's stud grid line moves 0.1 mm in.
// 2. Plate hollows: LDraw's plate hollow is 1.6 mm deep under a 1.6 mm roof. Every hollow ceiling
//    1.6 mm above the bottom it opens onto moves up 0.6 mm (MachineBlocks: 2.2 deep, 1.0 roof),
//    if at least 0.8 mm of roof stays. Tubes and pins under it grow with it.
// Inside/outside is a winding number along a vertical line (BFC-certified LDraw winding).
const SIDE_GAP = 0.1, HOLLOW_GROW = 0.6, PLATE_HOLLOW = 1.6, MIN_ROOF = 0.8, PITCH = 8, PROBE = 0.05;
function printFit(verts, tris) {
  const T = [];
  for (let t = 0; t < tris.length; t += 3) {
    const ix = [tris[t], tris[t + 1], tris[t + 2]], p = ix.map((i) => [verts[3 * i], verts[3 * i + 1], verts[3 * i + 2]]);
    const u = [0, 1, 2].map((k) => p[1][k] - p[0][k]), w = [0, 1, 2].map((k) => p[2][k] - p[0][k]);
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const len = Math.hypot(...n);
    if (len < 1e-9) continue;
    T.push({ ix, p, n: n.map((v) => v / len), area: len / 2, c: [0, 1, 2].map((k) => (p[0][k] + p[1][k] + p[2][k]) / 3),
      x0: Math.min(p[0][0], p[1][0], p[2][0]), x1: Math.max(p[0][0], p[1][0], p[2][0]),
      y0: Math.min(p[0][1], p[1][1], p[2][1]), y1: Math.max(p[0][1], p[1][1], p[2][1]) });
  }
  // Non-vertical triangles bucketed on a 2 mm grid, so a vertical line only meets its own cell's
  // triangles (without this, a baseplate's 100k+ triangles made every probe scan them all).
  const G = 2, cell = (ix, iy) => (ix + 50000) * 100000 + (iy + 50000), grid = new Map();
  for (const t of T) {
    if (Math.abs(t.n[2]) < 1e-9) continue;
    for (let ix = Math.floor(t.x0 / G); ix <= Math.floor(t.x1 / G); ix++)
      for (let iy = Math.floor(t.y0 / G); iy <= Math.floor(t.y1 / G); iy++) {
        const k = cell(ix, iy);
        (grid.get(k) || grid.set(k, []).get(k)).push(t);
      }
  }
  // z of every surface crossing the vertical line through (x, y); a tiny offset dodges shared edges
  const column = (x, y) => {
    x += 1.37e-4; y += 2.71e-4;
    const zs = [];
    for (const t of grid.get(cell(Math.floor(x / G), Math.floor(y / G))) || []) {
      if (x < t.x0 || x > t.x1 || y < t.y0 || y > t.y1) continue;
      const [a, b, c] = t.p, d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
      const l1 = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / d, l2 = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / d;
      if (l1 < 0 || l2 < 0 || l1 + l2 > 1) continue;
      zs.push([l1 * a[2] + l2 * b[2] + (1 - l1 - l2) * c[2], Math.sign(t.n[2])]);
    }
    return zs;
  };
  // winding number along +z: crossing an up-facing surface leaves the solid. Unlike plain parity this
  // survives LDraw's overlapping pieces (a stud standing on the brick's full top face).
  const inside = (x, y, z) => column(x, y).reduce((s, [h, d]) => s + (h > z ? d : 0), 0) > 0;
  // a few points spread over a triangle, so one blocked spot (a tube, a side stud) doesn't hide it
  const W = [[1 / 3, 1 / 3, 1 / 3], [0.8, 0.1, 0.1], [0.1, 0.8, 0.1], [0.1, 0.1, 0.8], [0.45, 0.45, 0.1], [0.45, 0.1, 0.45], [0.1, 0.45, 0.45]];
  const samples = (t) => W.map((w) => [0, 1, 2].map((k) => w[0] * t.p[0][k] + w[1] * t.p[1][k] + w[2] * t.p[2][k]));
  const move = new Map();   // vertex -> [dx, dy, dz]
  const shift = (i, k, d) => { const m = move.get(i) || [0, 0, 0]; if (Math.abs(d) > Math.abs(m[k])) m[k] = d; move.set(i, m); };

  // 1. side gap, per horizontal axis
  for (const k of [0, 1]) {
    const walls = [];
    for (const t of T) {
      if (Math.abs(t.n[k]) < 0.999) continue;
      let out = 0;
      for (const s of samples(t)) {
        const a = [...s], b = [...s];
        a[k] -= PROBE; b[k] += PROBE;
        const ia = inside(...a), ib = inside(...b);
        if (ia !== ib) { out = ia ? 1 : -1; break; }
      }
      if (out) walls.push({ t, out, phase: ((t.c[k] % PITCH) + PITCH) % PITCH });
    }
    // the stud grid line is where most outside-wall area sits; only grids at 0 or 4 mm (mod 8) count
    const score = new Map();
    for (const w of walls) { const q = (Math.round(w.phase * 100) / 100) % PITCH; score.set(q, (score.get(q) || 0) + w.t.area); }
    const best = [...score].sort((a, b) => b[1] - a[1])[0];
    if (!best || Math.min(best[0] % 4, 4 - (best[0] % 4)) > 0.01) continue;
    for (const w of walls) {
      const d = Math.abs(w.phase - best[0]);
      if (Math.min(d, PITCH - d) > 0.01) continue;
      for (const i of w.t.ix) shift(i, k, -w.out * SIDE_GAP);
    }
  }

  // 1b. round outside walls (round bricks and plates): LDraw cylinders whose radius is a whole number
  //     of half-studs (4 mm) around a point of the 4 mm grid move 0.1 mm in, toward that centre.
  for (const t of T) {
    if (Math.abs(t.n[2]) > 0.01 || Math.max(Math.abs(t.n[0]), Math.abs(t.n[1])) > 0.999) continue;
    const C = [Math.round(t.c[0] / 4) * 4, Math.round(t.c[1] / 4) * 4];
    let centre = null;
    for (let dx = -16; dx <= 16 && !centre; dx += 4) for (let dy = -16; dy <= 16 && !centre; dy += 4) {
      const cx = C[0] + dx, cy = C[1] + dy, rx = t.c[0] - cx, ry = t.c[1] - cy, r = Math.hypot(rx, ry);
      if (r < 1 || (rx * t.n[0] + ry * t.n[1]) / r < 0.995) continue;          // facet faces away from it
      const R = t.p.map((p) => Math.hypot(p[0] - cx, p[1] - cy));
      if (R.every((v) => v > 2 && Math.abs(v - Math.round(v / 4) * 4) < 0.02)) centre = [cx, cy];
    }
    if (!centre) continue;
    const s = samples(t).find((q) => inside(q[0] - t.n[0] * PROBE, q[1] - t.n[1] * PROBE, q[2]) !== inside(q[0] + t.n[0] * PROBE, q[1] + t.n[1] * PROBE, q[2]));
    if (!s || !inside(s[0] - t.n[0] * PROBE, s[1] - t.n[1] * PROBE, s[2])) continue;   // not an outside wall
    for (const i of t.ix) {
      const rx = verts[3 * i] - centre[0], ry = verts[3 * i + 1] - centre[1], r = Math.hypot(rx, ry);
      shift(i, 0, -SIDE_GAP * rx / r); shift(i, 1, -SIDE_GAP * ry / r);
    }
  }

  // 2. plate hollows
  // only faces wound downward can be ceilings (skips every stud top: 100k+ triangles on a baseplate)
  const flat = T.filter((t) => t.n[2] < -0.999);
  const facesDown = (s) => !inside(s[0], s[1], s[2] - PROBE) && inside(s[0], s[1], s[2] + PROBE);
  const down = flat.filter((t) => samples(t).some(facesDown));
  const bottoms = new Set(down.map((t) => Math.round(t.c[2] * 100)));
  const ceilings = down.filter((t) => {
    const h = t.c[2];
    if (!bottoms.has(Math.round((h - PLATE_HOLLOW) * 100))) return false;
    return samples(t).some((s) => {
      if (!facesDown(s)) return false;
      const zs = column(s[0], s[1]);
      if (zs.some(([z]) => z < h - PLATE_HOLLOW - 1e-3)) return false;  // open below down to the plate's bottom
      const roof = Math.min(...zs.filter(([z, d]) => z > h + 1e-3 && d > 0).map(([z]) => z));
      return roof - h - HOLLOW_GROW >= MIN_ROOF;
    });
  });
  const inTri = (t, x, y) => {
    const [a, b, c] = t.p, d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    const l1 = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / d, l2 = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / d;
    return l1 > -1e-6 && l2 > -1e-6 && l1 + l2 < 1 + 1e-6;
  };
  const atHeight = new Map();   // height (0.001 mm) -> vertex indices
  if (ceilings.length) for (let i = 0; i < verts.length / 3; i++) {
    const k = Math.round(verts[3 * i + 2] * 1000);
    (atHeight.get(k) || atHeight.set(k, []).get(k)).push(i);
  }
  for (const t of ceilings) {
    // every vertex at the ceiling's height over it: the ceiling, the tops of walls, tubes and pins
    for (const i of atHeight.get(Math.round(t.c[2] * 1000)) || []) {
      const x = verts[3 * i], y = verts[3 * i + 1];
      if (x >= t.x0 - 1e-3 && x <= t.x1 + 1e-3 && y >= t.y0 - 1e-3 && y <= t.y1 + 1e-3 && inTri(t, x, y)) shift(i, 2, HOLLOW_GROW);
    }
  }
  for (const [i, m] of move) for (let k = 0; k < 3; k++) verts[3 * i + k] += m[k];
}

// Each of our stud and tube shells must enclose positive volume; reverse the ones that don't. Studs are
// open where they stand on the part, so volume is taken about the middle of that opening (the opening is
// flat, so the missing face then adds nothing and the sign is exact).
function orientOwnShells(verts, tris, mine) {
  const par = new Map(), fd = (i) => { while (par.get(i) !== i) { par.set(i, par.get(par.get(i))); i = par.get(i); } return i; };
  for (let t = 0; t < mine.length; t++) if (mine[t]) for (let k = 0; k < 3; k++) par.set(tris[3 * t + k], tris[3 * t + k]);
  for (let t = 0; t < mine.length; t++) if (mine[t]) { const r = fd(tris[3 * t]); par.set(fd(tris[3 * t + 1]), r); par.set(fd(tris[3 * t + 2]), r); }
  const edges = new Map();   // undirected edge -> use count, within our faces
  for (let t = 0; t < mine.length; t++) if (mine[t]) for (let k = 0; k < 3; k++) {
    const a = tris[3 * t + k], b = tris[3 * t + (k + 1) % 3], e = a < b ? a + ',' + b : b + ',' + a;
    edges.set(e, (edges.get(e) || 0) + 1);
  }
  const origin = new Map();   // shell -> [sum x, y, z, n] of its opening's vertices
  for (const [e, n] of edges) if (n === 1) for (const i of e.split(',').map(Number)) {
    const r = fd(i), o = origin.get(r) || [0, 0, 0, 0];
    for (let k = 0; k < 3; k++) o[k] += verts[3 * i + k];
    o[3]++; origin.set(r, o);
  }
  const vol = new Map();
  for (let t = 0; t < mine.length; t++) {
    if (!mine[t]) continue;
    const r = fd(tris[3 * t]), o = origin.get(r), c0 = o ? [o[0] / o[3], o[1] / o[3], o[2] / o[3]] : [0, 0, 0];
    const [a, b, c] = [0, 1, 2].map((k) => [0, 1, 2].map((j) => verts[3 * tris[3 * t + k] + j] - c0[j]));
    vol.set(r, (vol.get(r) || 0) + a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]));
  }
  for (let t = 0; t < mine.length; t++) if (mine[t] && vol.get(fd(tris[3 * t])) < 0) [tris[3 * t + 1], tris[3 * t + 2]] = [tris[3 * t + 2], tris[3 * t + 1]];
}

// Collect triangles in mm, studs up (+Z), welded, sitting on z=0 and centred on x/y.
export function toMesh(group) {
  group.updateMatrixWorld(true);
  const pos = [], tagged = [];   // tagged[t]: triangle t is a face of one of our print primitives
  const v = new THREE.Vector3();
  group.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry;
    const a = g.attributes.position;
    const idx = g.index;
    const n = idx ? idx.count : a.count;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const groups = g.groups.length ? g.groups : [{ start: 0, count: n, materialIndex: 0 }];
    for (const gr of groups) {
      const mine = mats[gr.materialIndex]?.userData?.code === OWN;
      for (let i = gr.start; i < Math.min(gr.start + gr.count, n); i++) {
        v.fromBufferAttribute(a, idx ? idx.getX(i) : i).applyMatrix4(o.matrixWorld);
        // LDraw: -Y is up. Map (x, y, z) -> (x, z, -y): a rotation, so faces keep their winding.
        pos.push(v.x * LDU_MM, v.z * LDU_MM, -v.y * LDU_MM);
        if ((i - gr.start) % 3 === 0) tagged.push(mine);
      }
    }
  });
  const verts = [], tris = [], mineTris = [], map = new Map();
  const id = (x, y, z) => {
    const k = Math.round(x * 1e4) + ',' + Math.round(y * 1e4) + ',' + Math.round(z * 1e4);
    let i = map.get(k);
    if (i === undefined) { i = verts.length / 3; verts.push(x, y, z); map.set(k, i); }
    return i;
  };
  for (let i = 0; i < pos.length; i += 9) {
    const a = id(pos[i], pos[i + 1], pos[i + 2]), b = id(pos[i + 3], pos[i + 4], pos[i + 5]), c = id(pos[i + 6], pos[i + 7], pos[i + 8]);
    if (a !== b && b !== c && a !== c) { tris.push(a, b, c); mineTris.push(tagged[i / 9]); }
  }
  orientOwnShells(verts, tris, mineTris);
  printFit(verts, tris);
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < verts.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], verts[i + k]); max[k] = Math.max(max[k], verts[i + k]); }
  const off = [-(min[0] + max[0]) / 2, -(min[1] + max[1]) / 2, -min[2]];
  for (let i = 0; i < verts.length; i += 3) for (let k = 0; k < 3; k++) verts[i + k] += off[k];
  return { verts: new Float32Array(verts), tris: new Uint32Array(tris), size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

