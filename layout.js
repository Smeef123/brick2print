// Shelf-pack part footprints onto plates. Shared by the site (app.js) and the audit (audit/build_set.mjs).
// Bambu X1/P1 beds have a no-print zone in the front-left corner (purge chute): 18 x 28 mm.
const KEEPOUT = { w: 18, h: 28 };
// Returns the plates; parts no plate can hold are left off them and listed in plates.oversize.
export function pack(items, bed, gap, margin = 8) {
  const usable = bed - 2 * margin;
  const sorted = [...items].sort((a, b) => b.h - a.h || b.w - a.w);
  const plates = [], oversize = [];
  let plate = null, x = 0, y = 0, shelf = 0;
  const clearX = KEEPOUT.w + gap / 2 - margin; // first x that clears the corner zone
  const startX = () => (margin + y < KEEPOUT.h + gap / 2 ? clearX : 0);
  const cornerY = KEEPOUT.h + gap / 2 - margin;   // first shelf y that clears the corner zone
  const newPlate = () => { plate = []; plates.push(plate); y = 0; shelf = 0; x = startX(); };
  // a part too wide for the space beside the corner starts its shelf above the corner instead
  const aboveCorner = (it) => { if (x + it.w > usable && x > 0 && shelf === 0) { y = Math.max(y, cornerY); x = 0; } };
  newPlate();
  for (const it of sorted) {
    if (it.w > usable || it.h > usable) { oversize.push(it); continue; }
    if (x + it.w > usable) { y += shelf + gap; shelf = 0; x = startX(); }
    aboveCorner(it);
    if (y + it.h > usable) {
      newPlate(); aboveCorner(it);
      // wider than the space beside the corner and taller than the space above it: no plate holds it
      if (y + it.h > usable) { oversize.push(it); x = startX(); continue; }
    }
    plate.push({ ...it, cx: margin + x + it.w / 2, cy: margin + y + it.h / 2 });
    x += it.w + gap; shelf = Math.max(shelf, it.h);
  }
  const out = plates.filter((p) => p.length);
  out.oversize = oversize;
  return out;
}
