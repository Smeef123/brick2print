// Shelf-pack part footprints onto plates. Shared by the site (app.js) and the audit (audit/build_set.mjs).
// Bambu X1/P1 beds have a no-print zone in the front-left corner (purge chute): 18 x 28 mm.
const KEEPOUT = { w: 18, h: 28 };
export function pack(items, bed, gap, margin = 8) {
  const usable = bed - 2 * margin;
  const sorted = [...items].sort((a, b) => b.h - a.h || b.w - a.w);
  const plates = [];
  let plate = null, x = 0, y = 0, shelf = 0;
  const clearX = KEEPOUT.w + gap / 2 - margin; // first x that clears the corner zone
  const startX = () => (margin + y < KEEPOUT.h + gap / 2 ? clearX : 0);
  const newPlate = () => { plate = []; plates.push(plate); y = 0; shelf = 0; x = startX(); };
  newPlate();
  for (const it of sorted) {
    if (it.w > usable || it.h > usable) { plates.push([{ ...it, cx: bed / 2, cy: bed / 2, oversize: true }]); continue; }
    if (x + it.w > usable) { y += shelf + gap; shelf = 0; x = startX(); }
    if (y + it.h > usable) { newPlate(); }
    plate.push({ ...it, cx: margin + x + it.w / 2, cy: margin + y + it.h / 2 });
    x += it.w + gap; shelf = Math.max(shelf, it.h);
  }
  return plates.filter((p) => p.length);
}
