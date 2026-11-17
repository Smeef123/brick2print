// LDraw part -> studs-up triangle mesh in millimetres. Shared by the site (app.js) and the audit (audit/).
import * as THREE from 'three';
import { LDrawLoader } from 'three/addons/loaders/LDrawLoader.js';

// raw.githubusercontent serves every file with CORS; jsDelivr refuses parts of this repo (over its 50 MB limit).
let LIB = 'https://raw.githubusercontent.com/gkjohnson/ldraw-parts-library/master/complete/ldraw/';
const LDU_MM = 0.4;            // 1 LDraw unit = 0.4 mm

// ---- print-accurate studs and tubes ----
// LDraw is drawn for screens: its stud is a 16-sided cylinder (4.71 mm across the flats, LEGO 4.80)
// and its underside tube is 6.40 mm across (LEGO 6.51). Printed, those don't clutch at all. Every
// part builds its studs and tubes from two shared primitives, so those two are replaced here with
// 96-sided cylinders whose flats sit at LEGO's sizes. LDraw units: 1 LDU = 0.4 mm, -Y is up.
const SEGS = 96, FLAT = 1 / Math.cos(Math.PI / SEGS);   // corner radius that puts the flats on size
// Studs print at 4.90 mm, not LEGO's 4.80: hard PLA with layer ridges needs a little interference to
// grip (a MakerWorld stud test gripped only at 4.9-5.0; the user's 4.80 fit test was loose). The fit
// test then fine-tunes in 0.05 mm steps. Tubes stay at LEGO's 6.51 mm.
const STUD_R = (2.45 / LDU_MM) * FLAT, TUBE_R = (3.255 / LDU_MM) * FLAT, TUBE_HOLE_R = (2.4 / LDU_MM) * FLAT;
function ring(r, y) { return Array.from({ length: SEGS }, (_, k) => [r * Math.cos((2 * Math.PI * k) / SEGS), y, r * Math.sin((2 * Math.PI * k) / SEGS)]); }
const P = (p) => p.map((v) => +v.toFixed(4)).join(' ');
// type-4 quads / type-3 triangles, wound counter-clockwise seen from outside (BFC CERTIFY CCW)
// Stud height: LDraw (1.6 mm) exactly fills a plate's hollow, so any droop of the printed hollow's
// roof (it prints as a bridge) stops a plate sitting flush (user's fit test, 2026-11-17). LEGO plates
// leave room above the stud; printed ones need it too: studs stand 1.3 mm, leaving 0.3 mm (1.5 layers).
const STUD_H = 1.3 / LDU_MM;
function studDat() {
  const lo = ring(STUD_R, 0), hi = ring(STUD_R, -STUD_H), out = ['0 Set2Print print-accurate stud', '0 BFC CERTIFY CCW'];
  for (let k = 0; k < SEGS; k++) {
    const k2 = (k + 1) % SEGS;
    out.push(`4 16 ${P(lo[k])} ${P(hi[k])} ${P(hi[k2])} ${P(lo[k2])}`);   // side
    out.push(`3 16 0 ${P([-STUD_H])} 0 ${P(hi[k2])} ${P(hi[k])}`);          // top, facing up (-Y)
  }
  return out.join('\n') + '\n';
}
function tubeDat() {
  const oLo = ring(TUBE_R, 0), oHi = ring(TUBE_R, -4), iLo = ring(TUBE_HOLE_R, 0), iHi = ring(TUBE_HOLE_R, -4);
  const out = ['0 Set2Print print-accurate underside tube', '0 BFC CERTIFY CCW'];
  for (let k = 0; k < SEGS; k++) {
    const k2 = (k + 1) % SEGS;
    out.push(`4 16 ${P(oLo[k])} ${P(oHi[k])} ${P(oHi[k2])} ${P(oLo[k2])}`);   // outer wall, facing out
    out.push(`4 16 ${P(iLo[k2])} ${P(iHi[k2])} ${P(iHi[k])} ${P(iLo[k])}`);   // inner wall, facing the hole
    out.push(`4 16 ${P(oLo[k2])} ${P(iLo[k2])} ${P(iLo[k])} ${P(oLo[k])}`);   // bottom ring, facing down (+Y)
    out.push(`4 16 ${P(oHi[k])} ${P(iHi[k])} ${P(iHi[k2])} ${P(oHi[k2])}`);   // top ring (inside the part)
  }
  return out.join('\n') + '\n';
}
const PRINT_PRIMITIVES = { 'stud.dat': studDat(), 'stud4.dat': tubeDat() };
const dataUrl = (text) => 'data:text/plain;charset=utf-8,' + encodeURIComponent(text);
const loader = new LDrawLoader();
loader.manager.setURLModifier((url) => {
  const m = /\/(?:parts|p)\/(stud4?\.dat)$/i.exec(url);
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

// Collect triangles in mm, studs up (+Z), welded, sitting on z=0 and centred on x/y.
export function toMesh(group) {
  group.updateMatrixWorld(true);
  const pos = [];
  const v = new THREE.Vector3();
  group.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry;
    const a = g.attributes.position;
    const idx = g.index;
    const n = idx ? idx.count : a.count;
    for (let i = 0; i < n; i++) {
      v.fromBufferAttribute(a, idx ? idx.getX(i) : i).applyMatrix4(o.matrixWorld);
      // LDraw: -Y is up. Map (x, y, z) -> (x, z, -y): a rotation, so faces keep their winding.
      pos.push(v.x * LDU_MM, v.z * LDU_MM, -v.y * LDU_MM);
    }
  });
  const verts = [], tris = [], map = new Map();
  const id = (x, y, z) => {
    const k = Math.round(x * 1e4) + ',' + Math.round(y * 1e4) + ',' + Math.round(z * 1e4);
    let i = map.get(k);
    if (i === undefined) { i = verts.length / 3; verts.push(x, y, z); map.set(k, i); }
    return i;
  };
  for (let i = 0; i < pos.length; i += 9) {
    const a = id(pos[i], pos[i + 1], pos[i + 2]), b = id(pos[i + 3], pos[i + 4], pos[i + 5]), c = id(pos[i + 6], pos[i + 7], pos[i + 8]);
    if (a !== b && b !== c && a !== c) tris.push(a, b, c);
  }
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < verts.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], verts[i + k]); max[k] = Math.max(max[k], verts[i + k]); }
  const off = [-(min[0] + max[0]) / 2, -(min[1] + max[1]) / 2, -min[2]];
  for (let i = 0; i < verts.length; i += 3) for (let k = 0; k < 3; k++) verts[i + k] += off[k];
  return { verts: new Float32Array(verts), tris: new Uint32Array(tris), size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

