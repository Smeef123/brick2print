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
  BRIDGE_MM: 40,       // bridges: 20 mm ordinary, 20-50 mm a real option on P-series PLA (50 mm printed clean on a P2S); the audit found 20 turned parts that printed fine studs-up
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
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let k = 0; k < verts.length; k += 3) { minX = Math.min(minX, verts[k]); maxX = Math.max(maxX, verts[k]); minY = Math.min(minY, verts[k + 1]); maxY = Math.max(maxY, verts[k + 1]); }
  const box = { i0: Math.floor(minX / g) - 2, j0: Math.floor(minY / g) - 2 };
  box.nx = Math.floor(maxX / g) + 3 - box.i0; box.ny = Math.floor(maxY / g) + 3 - box.j0;
  const grids = new Map();
  const reach = Math.ceil(BRIDGE_MM / g), cant = CANTILEVER_MM / g;
  let fail = 0;
  const failing = [];
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
    if (!ok && nearest > cant) { fail++; failing.push(cells[c] * g + g / 2, cells[c + 1] * g + g / 2, z); }
  }
  const under = cells.map((v, k) => (k % 3 === 2 ? v : v * g + g / 2));
  // islands: a layer region with nothing under it in the layer below starts in mid-air,
  // however close it sits to a wall beside it
  const isl = islandStarts(verts, tris);
  const have = new Set();
  let islandCells = 0;
  for (let c = 0; c < failing.length; c += 3) have.add(Math.floor(failing[c] / g) + ',' + Math.floor(failing[c + 1] / g) + ',' + Math.round(failing[c + 2] / 3));
  for (let c = 0; c < isl.length; c += 3) {
    const k = Math.floor(isl[c] / g) + ',' + Math.floor(isl[c + 1] / g) + ',' + Math.round(isl[c + 2] / 3);
    if (have.has(k)) continue;
    have.add(k); fail++; islandCells++;
    failing.push(isl[c], isl[c + 1], isl[c + 2]); under.push(isl[c], isl[c + 1], isl[c + 2]);
  }
  // islandMm2: the part that starts in mid-air (a print failure, not just a rougher underside)
  return { failMm2: fail * g * g + (isl.emptyGap ? EMPTY_GAP_PENALTY : 0), islandMm2: islandCells * g * g, cells: cells.length / 3, failCells: fail, failing, under, emptyGap: isl.emptyGap, layerCells: isl.layerCells };
}
const MAX_SLENDER = 2.5; // height : narrowest footprint side, for a turned part
const EMPTY_GAP_PENALTY = 1e6; // a pose with a layer of nothing between solid layers can't be sliced at all

// Slice the part at each layer's mid-height (LAYER_MM steps), fill each section
// (even-odd scanlines on a FINE_MM grid) and report the cells of every region that
// overlaps nothing in the layer below: [x, y, z] at the region's underside.
const LAYER_MM = 0.2, FINE_MM = 0.1, MIN_ISLAND_CELLS = 4, MIN_LAYER_MM2 = 0.0, ISLAND_JOIN_CELLS = 12; // 1.2 mm: about three line widths, enough for hole roofs split by open meshes
function islandStarts(verts, tris) {
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < verts.length; k += 3) for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], verts[k + a]); max[a] = Math.max(max[a], verts[k + a]); }
  const f = FINE_MM, x0 = min[0] - f, y0 = min[1] - f;
  const W = Math.ceil((max[0] - x0) / f) + 2, H = Math.ceil((max[1] - y0) / f) + 2;
  const nt = tris.length / 3, out = [];
  let prev = null, seenSolid = false, emptyAfterSolid = false;
  out.emptyGap = false;   // a layer with nothing in it between solid layers: the slicer refuses that
  for (let z = LAYER_MM / 2; z < max[2]; z += LAYER_MM) {
    // segments of this section
    const seg = [];
    for (let t = 0; t < nt; t++) {
      const p = tri(verts, tris, t);
      if (Math.max(p[2], p[5], p[8]) < z || Math.min(p[2], p[5], p[8]) > z) continue;
      const pts = [];
      for (let e = 0; e < 3; e++) {
        const a = e * 3, b = ((e + 1) % 3) * 3, za = p[a + 2], zb = p[b + 2];
        if ((za - z) * (zb - z) > 0 || za === zb) continue;
        const u = (z - za) / (zb - za);
        pts.push(p[a] + u * (p[b] - p[a]), p[a + 1] + u * (p[b + 1] - p[a + 1]));
      }
      if (pts.length >= 4) seg.push(pts[0], pts[1], pts[2], pts[3]);
    }
    const occ = new Uint8Array(W * H);
    for (let j = 0; j < H; j++) {
      const y = y0 + (j + 0.5) * f, xs = [];
      for (let s = 0; s < seg.length; s += 4) {
        const ya = seg[s + 1], yb = seg[s + 3];
        if ((ya <= y) === (yb <= y)) continue;
        xs.push(seg[s] + (y - ya) / (yb - ya) * (seg[s + 2] - seg[s]));
      }
      xs.sort((a, b) => a - b);
      for (let q = 0; q + 1 < xs.length; q += 2) {
        const i0 = Math.max(0, Math.ceil((xs[q] - x0) / f - 0.5)), i1 = Math.min(W - 1, Math.floor((xs[q + 1] - x0) / f - 0.5));
        for (let i = i0; i <= i1; i++) occ[j * W + i] = 1;
      }
    }
    let cellsHere = 0;
    for (let c = 0; c < occ.length; c++) cellsHere += occ[c];
    (out.layerCells ??= []).push(cellsHere);
    const any = cellsHere * f * f >= MIN_LAYER_MM2;   // less than this, the slicer drops the layer
    if (any) { if (emptyAfterSolid) out.emptyGap = true; seenSolid = true; } else if (seenSolid) emptyAfterSolid = true;
    if (prev && z > LAYER_MM) {
      const lab = new Int32Array(W * H);
      let id = 0;
      for (let c0 = 0; c0 < W * H; c0++) {
        if (!occ[c0] || lab[c0]) continue;
        id++;
        const stack = [c0], comp = [];
        lab[c0] = id;
        let touches = false;
        while (stack.length) {
          const c = stack.pop(); comp.push(c);
          if (prev[c]) touches = true;
          const i = c % W, j = (c - i) / W;
          for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const ii = i + di, jj = j + dj;
            if (ii < 0 || jj < 0 || ii >= W || jj >= H) continue;
            const n = jj * W + ii;
            if (occ[n] && !lab[n]) { lab[n] = id; stack.push(n); }
          }
        }
        if (!touches && comp.length >= MIN_ISLAND_CELLS) {
          // A piece with other material close on both sides in its own layer is a bridge across
          // a narrow gap (a hole roof, often split only by an open mesh); the slicer joins it.
          const near = (i, j, di, dj) => { for (let s = 1; s <= ISLAND_JOIN_CELLS; s++) { const ii = i + di * s, jj = j + dj * s; if (ii < 0 || jj < 0 || ii >= W || jj >= H) return false; const n = jj * W + ii; if (occ[n] && lab[n] !== id) return true; } return false; };
          for (const c of comp) {
            const i = c % W, j = (c - i) / W;
            if ([[1, 0], [0, 1], [1, 1], [1, -1]].some(([di, dj]) => near(i, j, di, dj) && near(i, j, -di, -dj))) continue;
            out.push(x0 + (i + 0.5) * f, y0 + (j + 0.5) * f, z - LAYER_MM / 2);
          }
        }
      }
    }
    prev = occ;
  }
  return out;
}

// ---- breakaway pillars ----
// Under every cell that still fails: a column from whatever is below it (the plate
// or the part) up to GAP_MM short of the underside, so it snaps off. Cells that
// would bring a pillar within CLEAR_MM of the part's sides are dropped, and a
// cluster thinner than MIN_PILLAR_MM is skipped (too thin to print).
export const PILLAR = Object.freeze({ GAP_MM: 0.2, CLEAR_MM: 0.3, MIN_PILLAR_MM: 0.8 });

function floorBelow(verts, tris, x, y, z) {
  let best = 0;
  for (let t = 0; t < tris.length / 3; t++) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = tri(verts, tris, t);
    if (Math.min(az, bz, cz) > z) continue;
    const ux = bx - ax, uy = by - ay, vx = cx - ax, vy = cy - ay, det = ux * vy - uy * vx;
    if (Math.abs(det) < 1e-9) continue;
    const px = x - ax, py = y - ay, s = (px * vy - py * vx) / det, r = (ux * py - uy * px) / det;
    if (s < 0 || r < 0 || s + r > 1) continue;
    const zz = az + s * (bz - az) + r * (cz - az);
    if (zz < z - 0.5 && zz > best) best = zz;
  }
  return best;
}

export function addPillars(mesh, failing, under = []) {
  const { CELL_MM: g } = RULES, { GAP_MM, CLEAR_MM, MIN_PILLAR_MM } = PILLAR;
  const { verts, tris } = mesh;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let k = 0; k < verts.length; k += 3) { minX = Math.min(minX, verts[k]); maxX = Math.max(maxX, verts[k]); minY = Math.min(minY, verts[k + 1]); maxY = Math.max(maxY, verts[k + 1]); }
  const box = { i0: Math.floor(minX / g) - 4, j0: Math.floor(minY / g) - 4 };
  box.nx = Math.floor(maxX / g) + 5 - box.i0; box.ny = Math.floor(maxY / g) + 5 - box.j0;
  const grids = new Map();
  const occAt = (z) => { const k = Math.round(z / 0.5); if (!grids.has(k)) grids.set(k, sectionGrid(verts, tris, Math.max(0.4, k * 0.5), box)); return grids.get(k); };
  const clear = Math.ceil(CLEAR_MM / g);
  // keep a cell only if no part outline comes within CLEAR_MM of it anywhere along its column
  // footprint: the failing cells plus the underside around them (within GROW_MM), so a
  // pillar can be wide enough to print even when only a sliver of the underside fails
  const GROW = 3, fk = new Set();
  for (let c = 0; c < failing.length; c += 3) fk.add(Math.floor(failing[c] / g) + ',' + Math.floor(failing[c + 1] / g));
  const near = (x, y) => { const i = Math.floor(x / g), j = Math.floor(y / g); for (let a = -GROW; a <= GROW; a++) for (let b = -GROW; b <= GROW; b++) if (fk.has((i + a) + ',' + (j + b))) return true; return false; };
  const cand = [...failing];
  for (let c = 0; c < under.length; c += 3) if (near(under[c], under[c + 1]) && !fk.has(Math.floor(under[c] / g) + ',' + Math.floor(under[c + 1] / g))) cand.push(under[c], under[c + 1], under[c + 2]);
  const cols = [], taken = new Set(), why = { low: 0, side: 0, thin: 0 };
  for (let c = 0; c < cand.length; c += 3) {
    const x = cand[c], y = cand[c + 1], z = cand[c + 2];
    const ck = Math.floor(x / g) + ',' + Math.floor(y / g) + ',' + Math.round(z / 3);   // stacked undersides (3 mm apart or more) get their own pillars
    if (taken.has(ck)) continue;
    // the foot stands on the highest point under the cell's corners: on a slope or curve no part of it hangs in the air
    const top = z - GAP_MM, floor = Math.max(...[[-1, -1], [1, -1], [1, 1], [-1, 1], [0, 0]].map(([a, b]) => floorBelow(verts, tris, x + a * g / 2, y + b * g / 2, z)));
    if (top - floor < 0.4) { why.low++; continue; }
    const i = Math.floor(x / g) - box.i0, j = Math.floor(y / g) - box.j0;
    let ok = true;
    for (let h = floor + 0.5; h < top - 0.3 && ok; h += 0.5) {
      const occ = occAt(h);
      for (let di = -clear; di <= clear && ok; di++) for (let dj = -clear; dj <= clear; dj++) {
        const ii = i + di, jj = j + dj;
        if (ii >= 0 && jj >= 0 && ii < box.nx && jj < box.ny && occ[jj * box.nx + ii]) { ok = false; break; }
      }
    }
    if (ok) { taken.add(ck); cols.push({ i, j, k: Math.round(z / 3), x, y, top, floor }); } else why.side++;
  }
  // cluster neighbouring cells; drop clusters too thin to print
  const key = (i, j, k) => i + ',' + j + ',' + k, at = new Map(cols.map((c) => [key(c.i, c.j, c.k), c]));
  const seen = new Set(), keep = [];
  let pillars = 0;
  for (const c of cols) {
    if (seen.has(key(c.i, c.j, c.k))) continue;
    const group = [], stack = [c];
    seen.add(key(c.i, c.j, c.k));
    while (stack.length) {
      const p = stack.pop(); group.push(p);
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const q = at.get(key(p.i + di, p.j + dj, p.k));
        if (q && !seen.has(key(q.i, q.j, q.k))) { seen.add(key(q.i, q.j, q.k)); stack.push(q); }
      }
    }
    const is = group.map((p) => p.i), js = group.map((p) => p.j);
    const w = (Math.max(...is) - Math.min(...is) + 1) * g, h = (Math.max(...js) - Math.min(...js) + 1) * g;
    if (Math.min(w, h) < MIN_PILLAR_MM) { why.thin += group.length; continue; }
    pillars++;
    keep.push(...group);
  }
  if (!keep.length) return { mesh, pillars: 0, why };
  // one closed box per cell (the slicer unions touching boxes)
  const nv = verts.length / 3, V = Array.from(verts), T = Array.from(tris);
  const F = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  keep.forEach((p, n) => {
    const x0 = (p.i + box.i0) * g, y0 = (p.j + box.j0) * g, x1 = x0 + g, y1 = y0 + g;
    const b = nv + n * 8;
    const b0 = Math.max(0, p.floor - 0.3); // sink the foot into whatever it stands on so it never starts in mid-air
    V.push(x0, y0, b0, x1, y0, b0, x1, y1, b0, x0, y1, b0, x0, y0, p.top, x1, y0, p.top, x1, y1, p.top, x0, y1, p.top);
    for (const f of F) T.push(b + f[0], b + f[1], b + f[2]);
  });
  return { mesh: { verts: new Float32Array(V), tris: new Uint32Array(T), size: mesh.size }, pillars, why };
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
 * Pick a pose, then fins, then pillars, until the geometry rule passes.
 * @returns {{ mesh, pose: string, before: number, after: number, fins: number, pillars: number, unserved: number, note: string }}
 *   before: unsupported mm^2 studs-up; after: what is left once everything is added
 */
export function autoSupport(mesh) {
  const up = unsupportedArea(mesh);
  if (up.failMm2 < RULES.MIN_FAIL_MM2) return { mesh, pose: 'studs up', before: up.failMm2, after: up.failMm2, fins: 0, pillars: 0, unserved: 0, note: 'prints as is' };
  // Every pose is judged by what is left after its pillars, so turning only wins when
  // it really ends better; studs-up wins ties, then fewer pillars.
  let best = null;
  for (const pose of POSES) {
    const pm = pose === POSES[0] ? mesh : posed(mesh, pose);
    // a turned pose must stand steadily: no taller than MAX_SLENDER times its narrowest footprint side
    if (pose !== POSES[0] && pm.size[2] > MAX_SLENDER * Math.min(pm.size[0], pm.size[1])) continue;
    const area = pose === POSES[0] ? up : unsupportedArea(pm);
    let m = pm, left = area, pillars = 0;
    if (area.failMm2 >= RULES.MIN_FAIL_MM2) {
      const p = addPillars(pm, area.failing, area.under);
      if (p.pillars) { pillars = p.pillars; m = reseat(p.mesh); left = unsupportedArea(m); }
    }
    const c = { pose, m, before: area.failMm2, left, pillars };
    // studs-up keeps clutch surfaces on the plate and up top, so a turn has to leave less than
    // half of what studs-up (with its pillars) leaves, and studs-up has to need help at all
    if (!best) best = c;
    else if (best.pose === POSES[0] && best.left.failMm2 < RULES.MIN_FAIL_MM2) continue;
    // a turn must not start more of the part in mid-air than studs-up does: that fails outright, a rough underside doesn't
    else if (c.left.islandMm2 > best.left.islandMm2 + 0.5) continue;
    else if (c.left.failMm2 < Math.min(best.left.failMm2 - 0.5, best.pose === POSES[0] ? best.left.failMm2 * 0.5 : Infinity)) best = c;
    else if (best.pose !== POSES[0] && Math.abs(c.left.failMm2 - best.left.failMm2) <= 0.5 && c.pillars < best.pillars) best = c;
  }
  const turned = best.pose !== POSES[0] ? `turned ${best.pose.name}` : 'studs up';
  let m = best.m, fins = 0, pillars = best.pillars, left = best.left;
  if (!pillars && left.failMm2 < RULES.MIN_FAIL_MM2) return { mesh: m, pose: best.pose.name, before: up.failMm2, after: left.failMm2, fins: 0, pillars: 0, unserved: 0, note: `${turned} so it needs no support` };

  // 2. what pillars could not reach (too close to the part's sides): fins from the
  //    Support Fins engine (threshold 30 deg from the plate = 60 from vertical)
  if (left.failMm2 >= RULES.MIN_FAIL_MM2) {
    try {
      const soup = new Float64Array(m.tris.length * 3);
      for (let t = 0; t < m.tris.length; t++) for (let a = 0; a < 3; a++) soup[t * 3 + a] = m.verts[m.tris[t] * 3 + a];
      const res = computeFins(soup, { threshold: 30 });
      fins = (res.stats.braces || 0) + (res.stats.props || 0);
      if (fins) { m = append(m, res.triangles, res.offset); left = unsupportedArea(m); } // a bed pad with no fin on it holds nothing up
    } catch (e) { /* leave it to the report */ }
  }
  const unserved = left.failMm2 >= RULES.MIN_FAIL_MM2 ? 1 : 0;
  const parts = [turned];
  if (pillars) parts.push(`${pillars} pillar${pillars === 1 ? '' : 's'}`);
  if (fins) parts.push(`${fins} fin${fins === 1 ? '' : 's'}`);
  if (left.emptyGap) parts.push('a loose piece the slicer will refuse');
  else if (unserved) parts.push(`${left.failMm2.toFixed(1)} mm² still unsupported`);
  return { mesh: m, pose: best.pose.name, before: Math.min(up.failMm2, EMPTY_GAP_PENALTY), after: left.emptyGap ? left.failMm2 - EMPTY_GAP_PENALTY : left.failMm2, fins, pillars, unserved, note: parts.join(', ') };
}

// fin_world = fin_seated - offset; append to the part's mesh (the slicer unions them)
function append(m, triangles, o) {
  const n = triangles.length / 9, base = m.verts.length / 3;
  const verts = new Float32Array(m.verts.length + n * 9), tris = new Uint32Array(m.tris.length + n * 3);
  verts.set(m.verts); tris.set(m.tris);
  for (let k = 0; k < n * 3; k++) {
    verts[m.verts.length + k * 3] = triangles[k * 3] - o.x;
    verts[m.verts.length + k * 3 + 1] = triangles[k * 3 + 1] - o.y;
    verts[m.verts.length + k * 3 + 2] = triangles[k * 3 + 2] - o.z;
    tris[m.tris.length + k] = base + k;
  }
  return reseat({ verts, tris });
}

// centre on x/y, sit on z = 0, recompute size (fins and pads can widen the footprint)
function reseat(m) {
  const v = m.verts;
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < v.length; k += 3) for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], v[k + a]); max[a] = Math.max(max[a], v[k + a]); }
  const off = [-(min[0] + max[0]) / 2, -(min[1] + max[1]) / 2, -min[2]];
  for (let k = 0; k < v.length; k += 3) for (let a = 0; a < 3; a++) v[k + a] += off[a];
  return { verts: v, tris: m.tris, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}
