// LDraw part -> studs-up triangle mesh in millimetres. Shared by the site (app.js) and the audit (audit/).
import * as THREE from 'three';
import { LDrawLoader } from 'three/addons/loaders/LDrawLoader.js';

// raw.githubusercontent serves every file with CORS; jsDelivr refuses parts of this repo (over its 50 MB limit).
let LIB = 'https://raw.githubusercontent.com/gkjohnson/ldraw-parts-library/master/complete/ldraw/';
const LDU_MM = 0.4;            // 1 LDraw unit = 0.4 mm

const loader = new LDrawLoader();
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

