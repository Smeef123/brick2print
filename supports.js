// Automatic supports for Set2Print, decided by geometry.
//
// The rule, in one line: a point on the underside of a part prints without support
// if it lies on a straight path of at most BRIDGE_MM between two pieces of material
// just below it (a bridge), or within CANTILEVER_MM of material just below it (an
// overhang that steps out a little each layer). Everything else needs support.
//
// Bands are the P-series PLA planning bands (bambu MCP fdm_capability): conventional
// bridges up to about 20 mm are ordinary; slopes up to about 70 degrees from vertical
// print unsupported. A slope of angle a from vertical steps out h*tan(a) per layer
// of height h, so testing "material within CANTILEVER_MM, PROBE_MM below" puts the
// limit at atan(CANTILEVER_MM / PROBE_MM) = atan(1.0 / 0.3) ~ 73 degrees.
//
// When a part fails in its studs-up pose, the six axis-aligned poses are scored by
// unsupported area and the best one is used; whatever still needs support gets
// breakaway fins from the Support Fins engine (vendored, MIT).
import { computeFins } from './vendor/support-fins/plugins/shared/engine/fins_entry.js';

export const RULES = Object.freeze({
  BRIDGE_MM: 20,       // longest ordinary bridge
  CANTILEVER_MM: 1.0,  // sideways step allowed from material below
  PROBE_MM: 0.3,       // how far below a ceiling we look for that material
  CELL_MM: 0.25,       // sampling grid
  BED_MM: 0.35,        // faces this close to the plate sit on it
  MIN_FAIL_MM2: 2.0,   // ignore unsupported specks smaller than this (about one stud's underside)
  DOWN_DEG: 45,        // only faces tilted past this from vertical are checked
});

// ---- geometry helpers ----
function tri(verts, tris, t) {
  const a = tris[t * 3] * 3, b = tris[t * 3 + 1] * 3, c = tris[t * 3 + 2] * 3;
  return [verts[a], verts[a + 1], verts[a + 2], verts[b], verts[b + 1], verts[b + 2], verts[c], verts[c + 1], verts[c + 2]];
}

// Cells on downward faces steeper than DOWN_DEG from vertical: [x, y, z] samples.
function ceilingCells(verts, tris) {
  const { CELL_MM: g, BED_MM, DOWN_DEG } = RULES;
  const minNz = -Math.sin((90 - DOWN_DEG) * Math.PI / 180); // nz below this = past DOWN_DEG from vertical
  const cells = [];
  const seen = new Set();
  for (let t = 0; t < tris.length / 3; t++) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = tri(verts, tris, t);
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) continue;
    if (nz / len > minNz) continue;                       // not facing down steeply enough
    if (Math.max(az, bz, cz) < BED_MM) continue;           // sits on the plate
    const det = ux * vy - uy * vx;                         // 2D area*2 in XY
    if (Math.abs(det) < 1e-9) continue;
    const x0 = Math.floor(Math.min(ax, bx, cx) / g), x1 = Math.ceil(Math.max(ax, bx, cx) / g);
    const y0 = Math.floor(Math.min(ay, by, cy) / g), y1 = Math.ceil(Math.max(ay, by, cy) / g);
    for (let i = x0; i <= x1; i++) for (let j = y0; j <= y1; j++) {
      const px = (i + 0.5) * g - ax, py = (j + 0.5) * g - ay;
      const s = (px * vy - py * vx) / det, r = (ux * py - uy * px) / det;
      if (s < 0 || r < 0 || s + r > 1) continue;
      const z = az + s * uz + r * vz;
      if (z < BED_MM) continue;
      const k = i + ',' + j + ',' + Math.round(z / 0.2);
      if (seen.has(k)) continue;
      seen.add(k);
      cells.push(i, j, z);
    }
  }
  return cells;
}

// Occupancy of the part's cross-section at height z: walls cut by the plane, plus
// anything lying at that height (the plate itself when z is near 0).
function sectionGrid(verts, tris, z, box) {
  const { CELL_MM: g } = RULES;
  const W = box.nx, H = box.ny, occ = new Uint8Array(W * H);
  const mark = (x, y) => {
    const i = Math.floor(x / g) - box.i0, j = Math.floor(y / g) - box.j0;
    if (i >= 0 && j >= 0 && i < W && j < H) occ[j * W + i] = 1;
  };
  if (z <= RULES.BED_MM) { occ.fill(1); return occ; }     // the plate holds everything at its own level
  for (let t = 0; t < tris.length / 3; t++) {
    const p = tri(verts, tris, t);
    const pts = [];
    for (let e = 0; e < 3; e++) {
      const a = e * 3, b = ((e + 1) % 3) * 3;
      const za = p[a + 2], zb = p[b + 2];
      if ((za - z) * (zb - z) > 0 || za === zb) continue;
      const f = (z - za) / (zb - za);
      pts.push(p[a] + f * (p[b] - p[a]), p[a + 1] + f * (p[b + 1] - p[a + 1]));
    }
    if (pts.length < 4) continue;
    const [x1, y1, x2, y2] = pts;
    const n = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / (g / 2)));
    for (let k = 0; k <= n; k++) mark(x1 + (x2 - x1) * k / n, y1 + (y2 - y1) * k / n);
  }
  return occ;
}

const DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1]].map(([x, y]) => { const l = Math.hypot(x, y); return [x / l, y / l]; });

/**
 * Unsupported underside area of a posed mesh (mm, z up, seated on z = 0).
 * @returns {{ failMm2: number, cells: number, failCells: number }}
 */
export function unsupportedArea(mesh) {
  const { verts, tris } = mesh;
  const { CELL_MM: g, PROBE_MM, BRIDGE_MM, CANTILEVER_MM } = RULES;
  const cells = ceilingCells(verts, tris);
  if (!cells.length) return { failMm2: 0, cells: 0, failCells: 0 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let k = 0; k < verts.length; k += 3) { minX = Math.min(minX, verts[k]); maxX = Math.max(maxX, verts[k]); minY = Math.min(minY, verts[k + 1]); maxY = Math.max(maxY, verts[k + 1]); }
  const box = { i0: Math.floor(minX / g) - 2, j0: Math.floor(minY / g) - 2 };
  box.nx = Math.floor(maxX / g) + 3 - box.i0; box.ny = Math.floor(maxY / g) + 3 - box.j0;
  const grids = new Map();
  const reach = Math.ceil(BRIDGE_MM / g), cant = CANTILEVER_MM / g;
  let fail = 0;
  for (let c = 0; c < cells.length; c += 3) {
    const i = cells[c] - box.i0, j = cells[c + 1] - box.j0, z = cells[c + 2];
    const zp = Math.max(0, z - PROBE_MM), key = Math.round(zp / 0.1);
    if (!grids.has(key)) grids.set(key, sectionGrid(verts, tris, key * 0.1, box));
    const occ = grids.get(key);
    const hit = (dx, dy) => {           // steps to the first occupied cell along (dx, dy), or Infinity
      for (let s = 0; s <= reach; s++) {
        const x = Math.round(i + dx * s), y = Math.round(j + dy * s);
        if (x < 0 || y < 0 || x >= box.nx || y >= box.ny) return Infinity;
        if (occ[y * box.nx + x]) return s;
      }
      return Infinity;
    };
    let ok = false, nearest = Infinity;
    for (const [dx, dy] of DIRS) {
      const a = hit(dx, dy), b = hit(-dx, -dy);
      nearest = Math.min(nearest, a, b);
      if (a + b <= reach) { ok = true; break; }     // bridged between two anchors
    }
    if (!ok && nearest > cant) fail++;
  }
  return { failMm2: fail * g * g, cells: cells.length / 3, failCells: fail };
}

// ---- poses ----
// Rotations as functions on (x, y, z); studs-up is the identity.
export const POSES = [
  { name: 'studs up',   f: (x, y, z) => [x, y, z] },
  { name: 'studs down', f: (x, y, z) => [x, -y, -z] },
  { name: 'on +X side', f: (x, y, z) => [z, y, -x] },
  { name: 'on -X side', f: (x, y, z) => [-z, y, x] },
  { name: 'on +Y side', f: (x, y, z) => [x, z, -y] },
  { name: 'on -Y side', f: (x, y, z) => [x, -z, y] },
];

export function posed(mesh, pose) {
  const v = mesh.verts, out = new Float32Array(v.length);
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < v.length; k += 3) {
    const p = pose.f(v[k], v[k + 1], v[k + 2]);
    for (let a = 0; a < 3; a++) { out[k + a] = p[a]; min[a] = Math.min(min[a], p[a]); max[a] = Math.max(max[a], p[a]); }
  }
  const off = [-(min[0] + max[0]) / 2, -(min[1] + max[1]) / 2, -min[2]];
  for (let k = 0; k < out.length; k += 3) for (let a = 0; a < 3; a++) out[k + a] += off[a];
  return { verts: out, tris: mesh.tris, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

/**
 * Pick a pose and add fins where geometry says they're needed.
 * @returns {{ mesh, pose: string, before: number, after: number, fins: number, unserved: number, note: string }}
 *   before/after: unsupported mm^2 studs-up / in the chosen pose
 */
export function autoSupport(mesh) {
  const up = unsupportedArea(mesh);
  if (up.failMm2 < RULES.MIN_FAIL_MM2) return { mesh, pose: 'studs up', before: up.failMm2, after: up.failMm2, fins: 0, unserved: 0, note: 'prints as is' };
  let best = { pose: POSES[0], m: mesh, area: up.failMm2 };
  for (const pose of POSES.slice(1)) {
    const m = posed(mesh, pose);
    const a = unsupportedArea(m).failMm2;
    if (a < best.area - 0.5 || (Math.abs(a - best.area) <= 0.5 && m.size[2] < best.m.size[2])) best = { pose, m, area: a };
  }
  if (best.area < RULES.MIN_FAIL_MM2) return { mesh: best.m, pose: best.pose.name, before: up.failMm2, after: best.area, fins: 0, unserved: 0, note: `turned ${best.pose.name} so it needs no support` };
  // Still overhanging: fins under it. Threshold 30 deg from the plate = 60 from vertical.
  const m = best.m, soup = new Float64Array(m.tris.length * 3);
  for (let t = 0; t < m.tris.length; t++) for (let a = 0; a < 3; a++) soup[t * 3 + a] = m.verts[m.tris[t] * 3 + a];
  let res;
  try { res = computeFins(soup, { threshold: 30 }); } catch (e) { return { mesh: m, pose: best.pose.name, before: up.failMm2, after: best.area, fins: 0, unserved: 1, note: 'fin engine error: ' + e.message }; }
  const walls0 = (res.stats.braces || 0) + (res.stats.props || 0);
  const n = walls0 ? res.triangles.length / 9 : 0; // a bed pad with no fin on it holds nothing up
  if (!n && !res.stats.unserved) return { mesh: m, pose: best.pose.name, before: up.failMm2, after: best.area, fins: 0, unserved: 0, note: `turned ${best.pose.name}; ${best.area.toFixed(1)} mm² of shallow overhang left to print as is` };
  if (!n) return { mesh: m, pose: best.pose.name, before: up.failMm2, after: best.area, fins: 0, unserved: res.stats.unserved || 1, note: 'needs support the fins can\'t give this way up' };
  // fin_world = fin_seated - offset; append fins to the part's mesh (the slicer unions them)
  const base = m.verts.length / 3, verts = new Float32Array(m.verts.length + n * 9), tris = new Uint32Array(m.tris.length + n * 3);
  verts.set(m.verts); tris.set(m.tris);
  const o = res.offset;
  for (let k = 0; k < n * 3; k++) {
    verts[m.verts.length + k * 3] = res.triangles[k * 3] - o.x;
    verts[m.verts.length + k * 3 + 1] = res.triangles[k * 3 + 1] - o.y;
    verts[m.verts.length + k * 3 + 2] = res.triangles[k * 3 + 2] - o.z;
    tris[m.tris.length + k] = base + k;
  }
  // footprint may grow with the bed pad
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < verts.length; k += 3) for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], verts[k + a]); max[a] = Math.max(max[a], verts[k + a]); }
  const off = [-(min[0] + max[0]) / 2, -(min[1] + max[1]) / 2, -min[2]];
  for (let k = 0; k < verts.length; k += 3) for (let a = 0; a < 3; a++) verts[k + a] += off[a];
  const walls = (res.stats.braces || 0) + (res.stats.props || 0);
  return {
    mesh: { verts, tris, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] },
    pose: best.pose.name, before: up.failMm2, after: best.area, fins: walls, unserved: res.stats.unserved || 0,
    note: `${best.pose.name}, ${walls} fin${walls === 1 ? '' : 's'}` + (res.stats.unserved ? `, ${res.stats.unserved} overhang(s) left` : ''),
  };
}
