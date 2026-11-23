// Check that a failure inside the Support Fins engine shows in the part's note instead of vanishing.
// A flat plus shape with thin arms 1 mm over the plate needs fins in both poses it may take (pillars that thin
// are refused); the engine is swapped for one that throws.   node audit/test_fins_failure.mjs
import { autoSupport } from '../supports.js';

const V = [], T = [];
const box = (x0, y0, z0, x1, y1, z1) => {
  const b = V.length / 3;
  V.push(x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1);
  for (const f of [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]) T.push(b + f);
};
box(-5, -5, 0, 5, 5, 10);                                   // core on the plate
box(5, -0.3, 1, 25, 0.3, 9); box(-25, -0.3, 1, -5, 0.3, 9);  // arms 1 mm up, 0.6 mm thin: too thin for a pillar
box(-0.3, 5, 1, 0.3, 25, 9); box(-0.3, -25, 1, 0.3, -5, 9);
const plus = { verts: new Float32Array(V), tris: new Uint32Array(T), size: [50, 50, 10] };
const real = autoSupport(plus);
const broken = autoSupport(plus, () => { throw new Error('engine exploded'); });
console.log(`real engine: "${real.note}"\nthrowing engine: "${broken.note}"`);
const ok = /fins failed: engine exploded/.test(broken.note) && !/fins failed/.test(real.note);
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
