// 3MF / STL writers and the Lego print settings. Shared by the site (app.js) and the audit (audit/).
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function model3mf(objects, items, scale) {
  const f = (n) => (Math.round(n * 1e4) / 1e4).toString();
  let s = '<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n<resources>\n';
  objects.forEach((o, i) => {
    const vs = [], ts = [];
    for (let k = 0; k < o.mesh.verts.length; k += 3) vs.push(`<vertex x="${f(o.mesh.verts[k])}" y="${f(o.mesh.verts[k + 1])}" z="${f(o.mesh.verts[k + 2])}"/>`);
    for (let k = 0; k < o.mesh.tris.length; k += 3) ts.push(`<triangle v1="${o.mesh.tris[k]}" v2="${o.mesh.tris[k + 1]}" v3="${o.mesh.tris[k + 2]}"/>`);
    s += `<object id="${i + 1}" name="${esc(o.label)}" type="model"><mesh><vertices>${vs.join('')}</vertices><triangles>${ts.join('')}</triangles></mesh></object>\n`;
  });
  s += '</resources>\n<build>\n';
  for (const it of items) s += `<item objectid="${it.obj}" transform="${f(scale)} 0 0 0 ${f(scale)} 0 0 0 ${f(scale)} ${f(it.cx)} ${f(it.cy)} 0"/>\n`;
  return s + '</build>\n</model>\n';
}

// Lego print settings written into every plate, on top of a complete Bambu P1S/X1/P2S profile
// (bambu/p1s-base.json: 0.20mm Standard, Generic PLA). Evidence for each value is in README.md.
export const LEGO_SETTINGS = Object.freeze({
  wall_loops: '3',                          // walls and studs print solid (3-4 perimeters: Printpal)
  wall_generator: 'arachne',                // even wall widths on thin features (Klemmbrick, 178 reviews)
  wall_sequence: 'outer wall/inner wall',   // outer wall laid first, most precise (Klemmbrick)
  seam_position: 'back',                    // seams off the clutch faces (Klemmbrick)
  sparse_infill_density: '15%',             // MachineBlocks, Bambu default
  brim_type: 'no_brim',                     // the user's fit test: the brim was hard to remove and left a lip at the base
  enable_support: '0',                      // Set2Print adds its own pillars and fins
  // X-Y contour/hole compensation come from the user's fit test (sources disagree on direction)
});
/** The complete Bambu project settings for a plate: base profile + Lego values + layer, colour and fit. */
export function settingsJson(base, layer, rgb, fit = { contour: 0, hole: 0 }) {
  const cfg = { ...base, ...LEGO_SETTINGS };
  cfg.layer_height = String(layer);
  cfg.xy_contour_compensation = fit.contour.toFixed(2);
  cfg.xy_hole_compensation = fit.hole.toFixed(2);
  cfg.print_settings_id = `Set2Print Lego ${layer}mm`;
  cfg.filament_colour = ['#' + rgb.toUpperCase()];
  cfg.different_settings_to_system = [Object.keys(LEGO_SETTINGS).concat('layer_height').join(';'), '', ''];
  return JSON.stringify(cfg, null, 4);
}

export async function write3mf(JSZip, zip, path, objects, items, scale, settings) {
  const z = new JSZip();
  z.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>');
  z.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>');
  let model = model3mf(objects, items, scale);
  // marked as a Bambu Studio project so the slicer takes the embedded settings
  if (settings) {
    model = model.replace('<resources>', '<metadata name="Application">BambuStudio-02.09.01.70</metadata>\n<resources>');
    z.file('Metadata/project_settings.config', settings);
  }
  z.file('3D/3dmodel.model', model);
  zip.file(path, await z.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
}

// ---------- one Bambu Studio project with every plate ----------
// Bambu lays plates out in a grid, each 1.2 bed widths apart (PartPlate: LOGICAL_PART_PLATE_GAP = 1/5),
// columns = round(sqrt(n)), plus one when sqrt(n) rounds down. Plate k's objects sit at that offset.
function plateGrid(n) { const v = Math.sqrt(n), r = Math.round(v); return v > r ? r + 1 : r; }

/** Settings for several filaments: every per-filament list repeated, then given each colour. */
export function multiFilamentSettings(base, filamentKeys, layer, rgbs, fit = { contour: 0, hole: 0 }) {
  const cfg = JSON.parse(settingsJson(base, layer, rgbs[0], fit));
  const n = rgbs.length;
  for (const k of filamentKeys) if (Array.isArray(cfg[k]) && cfg[k].length) { const one = cfg[k]; cfg[k] = Array.from({ length: n }, () => one).flat(); }
  cfg.filament_colour = rgbs.map((c) => '#' + c.toUpperCase());
  cfg.filament_multi_colour = cfg.filament_colour.slice();
  cfg.filament_self_index = rgbs.map((_, i) => String(i + 1));
  cfg.filament_map = rgbs.map(() => '1');
  cfg.flush_volumes_matrix = rgbs.flatMap((_, i) => rgbs.map((__, j) => (i === j ? '0' : '280')));
  cfg.flush_volumes_vector = Array(2 * n).fill('140');
  return JSON.stringify(cfg, null, 4);
}

/**
 * plates: [{ name, filament (1-based), items: [{ key, label, mesh, cx, cy }] }] in bed coordinates.
 * Writes one .3mf Bambu Studio opens as a project: every plate, each object on its plate's filament.
 */
export async function projectFile(JSZip, plates, settings, bed = 256, scale = 1) {
  const f = (v) => (Math.round(v * 1e4) / 1e4).toString();
  const objects = [], objIndex = new Map(), items = [], perPlate = plates.map(() => []), instances = new Map();
  const cols = plateGrid(plates.length), stride = bed * 1.2;
  plates.forEach((pl, k) => {
    const ox = (k % cols) * stride, oy = -Math.floor(k / cols) * stride;
    for (const it of pl.items) {
      const key = it.key + '|' + pl.filament;
      if (!objIndex.has(key)) { objIndex.set(key, objects.length + 1); objects.push({ label: it.label, mesh: it.mesh, filament: pl.filament }); }
      const obj = objIndex.get(key), inst = instances.get(obj) || 0;
      instances.set(obj, inst + 1);
      items.push({ obj, x: it.cx + ox, y: it.cy + oy });
      perPlate[k].push({ obj, inst });
    }
  });
  let model = '<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n<metadata name="Application">BambuStudio-02.09.01.70</metadata>\n<resources>\n';
  objects.forEach((o, i) => {
    const vs = [], ts = [];
    for (let k = 0; k < o.mesh.verts.length; k += 3) vs.push(`<vertex x="${f(o.mesh.verts[k])}" y="${f(o.mesh.verts[k + 1])}" z="${f(o.mesh.verts[k + 2])}"/>`);
    for (let k = 0; k < o.mesh.tris.length; k += 3) ts.push(`<triangle v1="${o.mesh.tris[k]}" v2="${o.mesh.tris[k + 1]}" v3="${o.mesh.tris[k + 2]}"/>`);
    model += `<object id="${i + 1}" name="${esc(o.label)}" type="model"><mesh><vertices>${vs.join('')}</vertices><triangles>${ts.join('')}</triangles></mesh></object>\n`;
  });
  model += '</resources>\n<build>\n';
  for (const it of items) model += `<item objectid="${it.obj}" transform="${f(scale)} 0 0 0 ${f(scale)} 0 0 0 ${f(scale)} ${f(it.x)} ${f(it.y)} 0"/>\n`;
  model += '</build>\n</model>\n';
  let ms = '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n';
  objects.forEach((o, i) => {
    ms += `  <object id="${i + 1}">\n    <metadata key="name" value="${esc(o.label)}"/>\n    <metadata key="extruder" value="${o.filament}"/>\n  </object>\n`;
  });
  let ident = 100;
  plates.forEach((pl, k) => {
    ms += `  <plate>\n    <metadata key="plater_id" value="${k + 1}"/>\n    <metadata key="plater_name" value="${esc(pl.name)}"/>\n    <metadata key="locked" value="false"/>\n`;
    for (const p of perPlate[k]) ms += `    <model_instance>\n      <metadata key="object_id" value="${p.obj}"/>\n      <metadata key="instance_id" value="${p.inst}"/>\n      <metadata key="identify_id" value="${ident++}"/>\n    </model_instance>\n`;
    ms += '  </plate>\n';
  });
  ms += '</config>\n';
  const z = new JSZip();
  z.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/><Default Extension="config" ContentType="text/xml"/></Types>');
  z.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>');
  z.file('3D/3dmodel.model', model);
  z.file('Metadata/project_settings.config', settings);
  z.file('Metadata/model_settings.config', ms);
  return z.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

export function stl(mesh, scale) {
  const n = mesh.tris.length / 3, buf = new ArrayBuffer(84 + n * 50), dv = new DataView(buf);
  dv.setUint32(80, n, true);
  let o = 84;
  for (let t = 0; t < n; t++) {
    o += 12; // normal left zero; slicers recompute it
    for (let k = 0; k < 3; k++) { const vi = mesh.tris[t * 3 + k] * 3; for (let a = 0; a < 3; a++) { dv.setFloat32(o, mesh.verts[vi + a] * scale, true); o += 4; } }
    o += 2;
  }
  return new Uint8Array(buf);
}

