// What a device can take, from what the browser tells (navigator). Pure functions, so audit/test_limits.mjs checks them.
//
// Memory: Chrome reports navigator.deviceMemory (GB, capped at 8); Safari and Firefox don't. A touch device that
// doesn't say is taken as a 3 GB phone (the iPhones and mid-range Androids of recent years have 3-6 GB), a desktop
// browser that doesn't say as 8 GB. The page gets about half of it. These are guesses, not measured on a phone.
export function deviceMemoryGB(nav) {
  if (nav.deviceMemory) return nav.deviceMemory;
  return nav.maxTouchPoints > 0 ? 3 : 8;
}
export const memoryForPageMB = (nav) => Math.round(deviceMemoryGB(nav) * 1024 / 2);

/** Worker threads: one core left for the page; fewer on small memory (each holds three.js and a parts loader). */
export function workerCount(nav) {
  const mem = deviceMemoryGB(nav);
  return Math.max(1, Math.min(4, (nav.hardwareConcurrency || 2) - 1, mem <= 2 ? 1 : mem <= 4 ? 2 : 4));
}

// Writing the project holds every object's vertices as text: the page and workers (about 250 MB in headless Chrome)
// plus about 10 bytes per byte of mesh for every object (shape x colour). Set 11374: 475 objects, 608 MB.
export function projectNeedMB(plates) {
  const seen = new Set();
  let bytes = 0;
  for (const pl of plates) for (const it of pl.items) {
    const k = it.key + '|' + pl.filament;
    if (!seen.has(k)) { seen.add(k); bytes += it.mesh.verts.byteLength + it.mesh.tris.byteLength; }
  }
  return Math.round(250 + (bytes * 10) / 1048576);
}
// The same estimate before anything is loaded, from the parts list alone: one object per row (part x colour), at
// the average of the measured sets (11374: (608 - 250) MB / 475 objects = 0.75 MB). The exact check above still
// runs once the parts are loaded.
export const listNeedMB = (rows) => Math.round(250 + rows * 0.75);
