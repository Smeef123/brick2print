// Measure the clutch geometry of a brick mesh against LEGO's numbers.
//   node audit/measure_fit.mjs [part]   (serves the local LDraw library itself)
// Slices the mesh at a few heights and reports, at the stud and in the hollow underside:
//   stud radius (to the flats and to the corners of the polygon), tube outer radius,
//   distance from a stud position to the inner wall. LEGO: stud 4.8 mm across (r 2.4),
//   tube 6.51 mm across (r 3.255), so a stud touches the tube and the wall with ~0 clearance.
import './polyfill.mjs';
import { loadPart } from '../parts.js';
import { useLocalLibrary } from './ldraw.mjs';

await useLocalLibrary();
const id = process.argv[2] || '3001';
const g = await loadPart(id);
const { verts, tris, size } = g.mesh;
console.log(`${id}: ${size.map((v) => v.toFixed(2)).join(' x ')} mm, ${tris.length / 3} triangles`);

function section(z) {
  const segs = [];
  for (let t = 0; t < tris.length; t += 3) {
    const p = [0, 1, 2].map((k) => [verts[tris[t + k] * 3], verts[tris[t + k] * 3 + 1], verts[tris[t + k] * 3 + 2]]);
    const pts = [];
    for (let e = 0; e < 3; e++) {
      const a = p[e], b = p[(e + 1) % 3];
      if ((a[2] - z) * (b[2] - z) > 0 || a[2] === b[2]) continue;
      const u = (z - a[2]) / (b[2] - a[2]);
      pts.push([a[0] + u * (b[0] - a[0]), a[1] + u * (b[1] - a[1])]);
    }
    if (pts.length >= 2) segs.push(pts[0], pts[1]);
  }
  return segs;
}
// distance from point to segment
const dseg = (px, py, [ax, ay], [bx, by]) => { const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy; let t = l ? ((px - ax) * dx + (py - ay) * dy) / l : 0; t = Math.max(0, Math.min(1, t)); return Math.hypot(px - ax - t * dx, py - ay - t * dy); };
const near = (segs, x, y, rmax) => { let m = Infinity, far = 0; for (let k = 0; k < segs.length; k += 2) { const d = dseg(x, y, segs[k], segs[k + 1]); if (d < rmax) { m = Math.min(m, d); far = Math.max(far, Math.hypot(segs[k][0] - x, segs[k][1] - y)); } } return { min: m, far }; };

const top = size[2];
// stud centres of a brick centred at 0: x = (i - (nx-1)/2) * 8, y likewise
const nx = Math.round(size[0] / 8), ny = Math.round(size[1] / 8);
const studs = []; for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) studs.push([(i - (nx - 1) / 2) * 8, (j - (ny - 1) / 2) * 8]);
const s = section(top - 0.8);
const sr = studs.map(([x, y]) => near(s, x, y, 3));
console.log(`stud radius: flats ${Math.min(...sr.map((r) => r.min)).toFixed(3)} mm, corners ${Math.max(...sr.map((r) => r.far)).toFixed(3)} mm (LEGO 2.400)`);
// underside: look at 2 mm up inside the hollow
const u = section(Math.min(2.0, size[2] - 1.6 - 0.8));
const tubes = []; for (let i = 0; i < nx - 1; i++) for (let j = 0; j < ny - 1; j++) tubes.push([(i - (nx - 2) / 2) * 8, (j - (ny - 2) / 2) * 8]);
for (const [x, y] of tubes) { const r = near(u, x, y, 4); console.log(`tube at ${x},${y}: outer surface ${r.min.toFixed(3)} mm from centre (flats; LEGO 3.255), corners ${r.far.toFixed(3)}`); }
// a stud of the brick below sits under each stud position: clearance to the nearest surface around it
for (const [x, y] of studs.slice(0, 4)) {
  const r = near(u, x, y, 5);
  console.log(`under stud ${x},${y}: nearest surface ${r.min.toFixed(3)} mm from a stud centre -> clearance ${(r.min - 2.4).toFixed(3)} mm (LEGO ~0.00)`);
}
