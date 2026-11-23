// Check supports.js addPillars() on one huge failing cluster: a 100 x 100 mm slab held 5 mm up, every cell under
// it failing (160,000 cells in one cluster). Spreading that many values into Math.max() or push() overflows the stack.
//   node audit/test_supports_big.mjs
import { addPillars } from '../supports.js';

const box = (x0, y0, z0, x1, y1, z1) => ({
  verts: new Float32Array([x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1]),
  tris: new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]),
  size: [x1 - x0, y1 - y0, z1],
});
const slab = box(-50, -50, 5, 50, 50, 6), failing = [];
for (let x = -49.875; x < 50; x += 0.25) for (let y = -49.875; y < 50; y += 0.25) failing.push(x, y, 5);
let out;
try { out = addPillars(slab, failing, []); } catch (e) { console.log(`FAIL: ${failing.length / 3} failing cells -> ${e.constructor.name}: ${e.message}`); process.exit(1); }
const ok = out.pillars >= 1 && out.mesh.tris.length > slab.tris.length;
console.log(`${failing.length / 3} failing cells in one cluster -> ${out.pillars} pillar cluster(s), ${(out.mesh.tris.length - slab.tris.length) / 3} pillar triangles`);
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
