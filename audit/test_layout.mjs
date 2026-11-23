// Check layout.js pack(): every placed part lies inside the bed and clear of the Bambu X1/P1 no-print corner
// (front-left, 18 x 28 mm), and no two parts overlap. Parts no plate can hold come back in plates.oversize.
//   node audit/test_layout.mjs   (no dependencies; run before every deploy by .github/workflows/pages.yml)
import { pack } from '../layout.js';

const fails = [];
const check = (bed, gap, items, what) => {
  const plates = pack(items, bed, gap);
  for (const it of plates.oversize) if (Math.max(it.w, it.h) <= bed - 16 && !(it.w > bed - 16 - 18 && it.h > bed - 16 - 28)) fails.push(`${what}: ${it.w}x${it.h} left off as too big but fits`);
  if (plates.flat().length + plates.oversize.length !== items.length) fails.push(`${what}: ${items.length} parts in, ${plates.flat().length} placed + ${plates.oversize.length} too big`);
  for (const p of plates) {
    const boxes = p.map((it) => [it.cx - it.w / 2, it.cy - it.h / 2, it.cx + it.w / 2, it.cy + it.h / 2]);
    boxes.forEach(([x0, y0, x1, y1], i) => {
      if (x0 < -1e-9 || y0 < -1e-9 || x1 > bed + 1e-9 || y1 > bed + 1e-9) fails.push(`${what}: part ${i} at ${x0.toFixed(1)},${y0.toFixed(1)}-${x1.toFixed(1)},${y1.toFixed(1)} leaves the ${bed} mm bed`);
      if (x0 < 18 && y0 < 28) fails.push(`${what}: part ${i} at ${x0.toFixed(1)},${y0.toFixed(1)} overlaps the no-print corner`);
      boxes.slice(i + 1).forEach(([a0, b0, a1, b1], j) => { if (x0 < a1 - 1e-9 && a0 < x1 - 1e-9 && y0 < b1 - 1e-9 && b0 < y1 - 1e-9) fails.push(`${what}: parts ${i} and ${i + j + 1} overlap`); });
    });
  }
};
let cases = 0;
for (const bed of [180, 256, 300]) for (const gap of [2, 12, 40]) {
  // one wide part of every width up to the usable bed, alone and in front of smaller ones
  for (let w = 10; w <= bed - 16; w += 1) for (const h of [5, 20, 60]) {
    check(bed, gap, [{ w, h }], `bed ${bed} gap ${gap} one ${w}x${h}`);
    check(bed, gap, [{ w, h: h + 1 }, { w: 30, h: 10 }, { w: 12, h: h }, { w, h }], `bed ${bed} gap ${gap} mixed ${w}x${h}`);
    cases += 2;
  }
  // many small parts: several plates
  check(bed, gap, Array.from({ length: 300 }, (_, k) => ({ w: 8 + (k % 7) * 4, h: 8 + (k % 5) * 6 })), `bed ${bed} gap ${gap} 300 small`);
  cases++;
}
console.log(`${cases} layouts checked, ${fails.length} problems`);
for (const f of fails.slice(0, 10)) console.log('  ' + f);
console.log(fails.length ? 'FAIL' : 'PASS');
process.exit(fails.length ? 1 : 0);
