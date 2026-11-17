// Set2Print: parts list -> LDraw geometry -> studs-up meshes in mm -> plates per colour -> 3MF + STL zip.
import * as THREE from 'three';
import { LDrawLoader } from 'three/addons/loaders/LDrawLoader.js';
import { COLORS } from './colors.js';
import { autoSupport } from './supports.js';
import { buildBed, showPlate } from './viewer.js';

// raw.githubusercontent serves every file with CORS; jsDelivr refuses parts of this repo (over its 50 MB limit).
const LIB = 'https://raw.githubusercontent.com/gkjohnson/ldraw-parts-library/master/complete/ldraw/';
const LDU_MM = 0.4;            // 1 LDraw unit = 0.4 mm
const $ = (id) => document.getElementById(id);

// ---------- small helpers ----------
const store = {
  get(k) { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
const status = (t) => { $('status').textContent = t; };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function colourOf(c) {
  // c may be a Rebrickable id ("4") or a name ("Red")
  if (c === undefined || c === null || c === '') return { id: '-1', name: 'Any colour', rgb: '999999' };
  const s = String(c).trim();
  if (COLORS[s]) return { id: s, name: COLORS[s][0], rgb: COLORS[s][1] };
  const lower = s.toLowerCase();
  for (const [id, [name, rgb]] of Object.entries(COLORS)) if (name.toLowerCase() === lower) return { id, name, rgb };
  return { id: s, name: s, rgb: '999999' };
}

// ---------- inputs ----------
// Built-in set data (data/, rebuilt weekly from Rebrickable's free database downloads).
let indexP = null;
const loadIndex = () => (indexP ??= fetch('data/index.json').then((r) => { if (!r.ok) throw new Error('index'); return r.json(); }));
const bucket = (sn) => sn.toLowerCase().slice(0, 3).replace(/[^a-z0-9]/g, '') || '_';

// "6000", "6000-1", "75192" or a name like "millennium falcon" -> the set's number
async function resolveSet(query) {
  const q = query.trim();
  if (!q) throw new Error('Type a set number (like 10696) or part of a set name.');
  const index = await loadIndex().catch(() => { throw new Error('The set list could not be loaded. Check your connection and try again.'); });
  const lower = q.toLowerCase();
  const exact = index.find((r) => r[0].toLowerCase() === lower) || index.find((r) => r[0].toLowerCase() === lower + '-1');
  if (exact) return exact[0];
  const hits = index.filter((r) => r[1].toLowerCase().includes(lower));
  if (!hits.length) throw new Error(`No set matches "${q}". Try the number printed on the box.`);
  return hits[0][0]; // index is newest first
}

async function fromBuiltIn(query, withSpares) {
  const sn = await resolveSet(query);
  const r = await fetch(`data/sets/${bucket(sn)}.json`);
  if (!r.ok) throw new Error('The set data could not be loaded. Try again in a minute.');
  const set = (await r.json())[sn];
  if (!set) throw new Error(`Set ${sn} has no parts list yet.`);
  const lines = set.p.filter((row) => withSpares || !row[3]).map(([part, col, qty, , name]) => ({ part, ldraw: part, name, colour: colourOf(String(col)), qty }));
  return { title: `${sn} ${set.n} (${set.y})`, lines };
}

// suggestions while typing
async function suggest() {
  const q = $('setnum').value.trim().toLowerCase();
  if (q.length < 2) { $('setlist').innerHTML = ''; return; }
  const index = await loadIndex().catch(() => []);
  const hits = [];
  for (const r of index) {
    if (r[0].toLowerCase().startsWith(q) || r[1].toLowerCase().includes(q)) hits.push(r);
    if (hits.length >= 12) break;
  }
  $('setlist').innerHTML = hits.map((r) => `<option value="${esc(r[0])}">${esc(r[1])} (${r[2]}, ${r[3]} pieces)</option>`).join('');
}

function fromText(text, withSpares) {
  const rows = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!rows.length) throw new Error('Paste a parts list first: one "part, colour, quantity" per line.');
  let cols = { part: 0, colour: 1, qty: 2, spare: -1 };
  const first = rows[0].split(/[,;\t]/).map((s) => s.trim().toLowerCase());
  if (first.some((h) => /part|color|colour|quantity|qty/.test(h))) {
    cols = {
      part: first.findIndex((h) => /^part/.test(h)),
      colour: first.findIndex((h) => /colou?r/.test(h)),
      qty: first.findIndex((h) => /quantity|qty/.test(h)),
      spare: first.findIndex((h) => /spare/.test(h)),
    };
    rows.shift();
  }
  const merged = new Map();
  for (const row of rows) {
    const f = row.split(/[,;\t]/).map((s) => s.trim().replace(/^"|"$/g, ''));
    const part = f[cols.part];
    if (!part) continue;
    if (cols.spare >= 0 && /^(true|1|yes)$/i.test(f[cols.spare] || '') && !withSpares) continue;
    const colour = colourOf(cols.colour >= 0 ? f[cols.colour] : '');
    const qty = Math.max(1, parseInt(cols.qty >= 0 ? f[cols.qty] : '1', 10) || 1);
    const k = part + '|' + colour.id;
    if (merged.has(k)) merged.get(k).qty += qty;
    else merged.set(k, { part, ldraw: part, name: '', colour, qty });
  }
  return { title: 'parts-list', lines: [...merged.values()] };
}

// ---------- geometry ----------
const loader = new LDrawLoader();
loader.setPartsLibraryPath(LIB);
let materialsReady = null;
const geomCache = new Map();

function candidates(id) {
  const base = id.toLowerCase().replace(/\.dat$/, '');
  const c = [base];
  const m = base.match(/^(\d+)[a-z]+\d*$/); // e.g. 3069bpr0001 -> 3069b, 3069
  if (m) { const b = base.match(/^(\d+[a-z]?)/)[1]; if (b !== base) c.push(b); if (m[1] !== b) c.push(m[1]); }
  return [...new Set(c)];
}

function parseAsync(text) {
  return new Promise((res, rej) => loader.parse(text, res, rej));
}

async function loadPart(id) {
  if (geomCache.has(id)) return geomCache.get(id);
  const p = (async () => {
    if (!materialsReady) materialsReady = loader.preloadMaterials(LIB + 'LDConfig.ldr').catch(() => {});
    await materialsReady;
    for (const name of candidates(id)) {
      const ok = await fetch(LIB + 'parts/' + name + '.dat', { method: 'HEAD' }).then((r) => r.ok).catch(() => false);
      if (!ok) continue;
      const group = await parseAsync(`0 Set2Print\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 ${name}.dat\n`);
      const mesh = toMesh(group);
      if (!mesh.tris.length) continue; // a sub-file failed to load: treat as not found rather than ship an empty part
      return { name, mesh };
    }
    return null;
  })();
  geomCache.set(id, p);
  return p;
}

// Collect triangles in mm, studs up (+Z), welded, sitting on z=0 and centred on x/y.
function toMesh(group) {
  group.updateMatrixWorld(true);
  const pos = [];
  const v = new THREE.Vector3();
  group.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry;
    const a = g.attributes.position;
    const idx = g.index;
    const n = idx ? idx.count : a.count;
    for (let i = 0; i < n; i++) {
      v.fromBufferAttribute(a, idx ? idx.getX(i) : i).applyMatrix4(o.matrixWorld);
      // LDraw: -Y is up. Map (x, y, z) -> (x, z, -y): a rotation, so faces keep their winding.
      pos.push(v.x * LDU_MM, v.z * LDU_MM, -v.y * LDU_MM);
    }
  });
  const verts = [], tris = [], map = new Map();
  const id = (x, y, z) => {
    const k = Math.round(x * 1e4) + ',' + Math.round(y * 1e4) + ',' + Math.round(z * 1e4);
    let i = map.get(k);
    if (i === undefined) { i = verts.length / 3; verts.push(x, y, z); map.set(k, i); }
    return i;
  };
  for (let i = 0; i < pos.length; i += 9) {
    const a = id(pos[i], pos[i + 1], pos[i + 2]), b = id(pos[i + 3], pos[i + 4], pos[i + 5]), c = id(pos[i + 6], pos[i + 7], pos[i + 8]);
    if (a !== b && b !== c && a !== c) tris.push(a, b, c);
  }
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < verts.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], verts[i + k]); max[k] = Math.max(max[k], verts[i + k]); }
  const off = [-(min[0] + max[0]) / 2, -(min[1] + max[1]) / 2, -min[2]];
  for (let i = 0; i < verts.length; i += 3) for (let k = 0; k < 3; k++) verts[i + k] += off[k];
  return { verts: new Float32Array(verts), tris: new Uint32Array(tris), size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

// One decision per unique part: pose + fins, cached.
const supportCache = new Map();
function supported(g) {
  if (!supportCache.has(g.name)) {
    supportCache.set(g.name, new Promise((res) => setTimeout(() => {
      let s;
      try { s = autoSupport(g.mesh); } catch (e) { s = { mesh: g.mesh, note: 'support check failed: ' + e.message, unserved: 1 }; }
      res({ name: g.name, mesh: s.mesh, support: s });
    }, 0)));
  }
  return supportCache.get(g.name);
}

// ---------- layout: shelf-pack footprints onto plates ----------
// Bambu X1/P1 beds have a no-print zone in the front-left corner (purge chute): 18 x 28 mm.
const KEEPOUT = { w: 18, h: 28 };
function pack(items, bed, gap, margin = 8) {
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

// ---------- writers ----------
function model3mf(objects, items, scale) {
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
const LEGO_SETTINGS = Object.freeze({
  wall_loops: '3',                          // walls and studs print solid (3-4 perimeters: Printpal)
  wall_generator: 'arachne',                // even wall widths on thin features (Klemmbrick, 178 reviews)
  wall_sequence: 'outer wall/inner wall',   // outer wall laid first, most precise (Klemmbrick)
  seam_position: 'back',                    // seams off the clutch faces (Klemmbrick)
  sparse_infill_density: '15%',             // MachineBlocks, Bambu default
  brim_type: 'outer_only', brim_width: '5', // small footprints stay down and flat (Prusa blog, MikeMakess)
  enable_support: '0',                      // Set2Print adds its own pillars and fins
  // X-Y contour/hole compensation come from the user's fit test (sources disagree on direction)
});
let baseCfgP = null;
async function projectSettings(layer, rgb) {
  baseCfgP ??= fetch('bambu/p1s-base.json').then((r) => r.json());
  const cfg = { ...(await baseCfgP), ...LEGO_SETTINGS };
  cfg.layer_height = layer;
  const fit = fitState();                  // from the fit test, 0 until the user reports a fit
  cfg.xy_contour_compensation = fit.contour.toFixed(2);
  cfg.xy_hole_compensation = fit.hole.toFixed(2);
  cfg.print_settings_id = `Set2Print Lego ${layer}mm`;
  cfg.filament_colour = ['#' + rgb.toUpperCase()];
  cfg.different_settings_to_system = [Object.keys(LEGO_SETTINGS).concat('layer_height').join(';'), '', ''];
  return JSON.stringify(cfg, null, 4);
}

async function write3mf(zip, path, objects, items, scale, settings) {
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

function stl(mesh, scale) {
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

// ---------- UI ----------
let lastZip = null, lastName = 'set2print.zip';

function render(lines) {
  $('rows').innerHTML = lines.map((l, i) => `<tr id="r${i}"><td class="mono">${esc(l.part)}</td><td class="name">${esc(l.name || '')}</td>` +
    `<td><span class="sw" style="background:#${esc(l.colour.rgb)}"></span>${esc(l.colour.name)}</td><td>${l.qty}</td><td><span class="pill wait">waiting</span></td></tr>`).join('');
}
const setRow = (i, cls, text) => { const c = document.querySelector(`#r${i} td:last-child`); if (c) c.innerHTML = `<span class="pill ${cls}">${esc(text)}</span>`; };
const sum = (o) => { for (const [k, v] of Object.entries(o)) $('s-' + k).textContent = v; };

async function build() {
  const btn = $('go');
  btn.disabled = true; $('dl').hidden = true; lastZip = null;
  try {
    const spares = $('spares').checked;
    const scale = (parseFloat($('scale').value) || 100) / 100;
    const gap = parseFloat($('gap').value) || 12;
    const bed = parseFloat($('bed').value) || 256;
    const fins = $('fins').checked;
    buildBed(bed); showPlate(null); $('platetabs').innerHTML = ''; $('viewnote').hidden = false;
    let src;
    if ($('tab-set').getAttribute('aria-selected') === 'true') {
      status('Looking up the set…');
      src = await fromBuiltIn($('setnum').value, spares);
    } else {
      src = fromText($('listtext').value, spares);
    }
    const lines = src.lines;
    render(lines);
    const colours = new Set(lines.map((l) => l.colour.id));
    sum({ parts: lines.reduce((a, l) => a + l.qty, 0), unique: new Set(lines.map((l) => l.ldraw)).size, colours: colours.size, plates: 0, missing: 0 });

    // load geometry, 4 at a time
    let done = 0, missing = 0;
    const queue = lines.map((l, i) => [l, i]);
    const worker = async () => {
      while (queue.length) {
        const [l, i] = queue.shift();
        setRow(i, 'wait', 'loading');
        const g = await loadPart(l.ldraw).catch(() => null);
        l.geom = g && (fins ? await supported(g) : g);
        if (!g) { setRow(i, 'bad', 'not in LDraw'); missing++; }
        else if (!fins || !l.geom.support || l.geom.support.note === 'prints as is') setRow(i, 'ok', 'ready');
        else setRow(i, l.geom.support.unserved ? 'skip' : 'ok', l.geom.support.note);
        done++; status(`Loading parts ${done} / ${lines.length}`);
        sum({ missing });
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);

    // pack per colour and write
    status('Laying out plates…');
    const zip = new JSZip();
    const base = slug(src.title) || 'set';
    let plateCount = 0;
    const viewPlates = [];
    const byColour = new Map();
    for (const l of lines) if (l.geom) { if (!byColour.has(l.colour.name)) byColour.set(l.colour.name, []); byColour.get(l.colour.name).push(l); }
    for (const [colour, ls] of byColour) {
      const items = [];
      for (const l of ls) for (let q = 0; q < l.qty; q++) items.push({ line: l, w: l.geom.mesh.size[0] * scale, h: l.geom.mesh.size[1] * scale });
      const plates = pack(items, bed, gap);
      for (let p = 0; p < plates.length; p++) {
        const objs = [], objIndex = new Map();
        const placed = plates[p].map((it) => {
          const key = it.line.geom.name;
          if (!objIndex.has(key)) { objIndex.set(key, objs.length + 1); objs.push({ label: `${key} ${it.line.name || ''}`.trim(), mesh: it.line.geom.mesh }); }
          return { obj: objIndex.get(key), cx: it.cx, cy: it.cy };
        });
        const tag = plates[p][0].oversize ? '-oversize' : '';
        const rgb = ls[0].colour.rgb;
        viewPlates.push({ name: `${colour} ${p + 1}`, rgb, scale, items: plates[p].map((it) => ({ mesh: it.line.geom.mesh, cx: it.cx, cy: it.cy })) });
        const settings = bed === 256 ? await projectSettings($('layer').value, rgb) : null;
        await write3mf(zip, `plates/${slug(colour)}-${p + 1}${tag}.3mf`, objs, placed, scale, settings);
        plateCount++; sum({ plates: plateCount });
        status(`Writing plates… ${plateCount}`);
      }
    }
    const seen = new Set();
    for (const l of lines) if (l.geom && !seen.has(l.geom.name)) { seen.add(l.geom.name); zip.file(`parts/${l.geom.name}.stl`, stl(l.geom.mesh, scale)); }
    const notFound = lines.filter((l) => !l.geom);
    if (notFound.length) zip.file('not-found.txt', 'These parts are not in the LDraw library (often stickers, printed or rubber parts, or newer molds):\n\n' + notFound.map((l) => `${l.part}\t${l.colour.name}\tx${l.qty}\t${l.name || ''}`).join('\n') + '\n');
    const supNotes = [...new Map(lines.filter((l) => l.geom && l.geom.support && l.geom.support.note !== 'prints as is').map((l) => [l.geom.name, l.geom.support])).entries()];
    if (supNotes.length) zip.file('supports.txt', 'Parts turned or given fins automatically (slicer supports stay off):\n\n' + supNotes.map(([n, s]) => `${n}\t${s.note}\t(unsupported underside studs-up: ${s.before.toFixed(1)} mm2, left after supports: ${s.after.toFixed(1)} mm2)`).join('\n') + '\n');
    zip.file('README.txt', `Made with Set2Print from: ${src.title}\nScale ${Math.round(scale * 1000) / 10}%. Parts are studs-up unless supports.txt says otherwise, one 3MF per plate, named by colour.\nPrint with slicer supports OFF: overhangs were checked by geometry (bridges up to 20 mm, overhangs up to ~70 degrees) and given breakaway fins (Support Fins engine) where needed.\nPart geometry from the LDraw.org parts library (CC BY 2.0). Inventory and colours from Rebrickable.\n`);
    renderPlateTabs(viewPlates);
    lastZip = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
    lastName = base + '-set2print.zip';
    $('dl').hidden = false;
    status(`Done: ${plateCount} plates${missing ? `, ${missing} line(s) not found (listed in not-found.txt)` : ''}.`);
  } catch (e) {
    status(e.message || String(e));
  } finally {
    btn.disabled = false;
  }
}

function download() {
  if (!lastZip) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(lastZip); a.download = lastName;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// ---------- fit test ----------
// Print a 2x4 brick and a 2x4 plate with the current settings, try them on real bricks, then
// report the fit. Studs are outer contours, so their fit moves X-Y contour compensation; the
// hollow underside is a hole in every layer, so its fit moves X-Y hole compensation.
const FIT_STEP = 0.05; // mm per report
function fitState() {
  try { const v = JSON.parse(store.get('s2p.fit') || '{}'); return { contour: +v.contour || 0, hole: +v.hole || 0, n: +v.n || 0 }; }
  catch { return { contour: 0, hole: 0, n: 0 }; }
}
function showFit() {
  const f = fitState();
  $('fitnow').textContent = f.n
    ? `Your fit: studs ${f.contour >= 0 ? '+' : ''}${f.contour.toFixed(2)} mm, underside ${f.hole >= 0 ? '+' : ''}${f.hole.toFixed(2)} mm (after ${f.n} report${f.n === 1 ? '' : 's'}). Used in every build.`
    : 'Not tested yet: plates use 0 adjustment.';
}
function reportFit(part, verdict) {
  const f = fitState();
  // studs too tight -> shrink them (contour -); underside too tight -> widen the hollow (hole +)
  if (part === 'studs') f.contour += verdict === 'tight' ? -FIT_STEP : verdict === 'loose' ? FIT_STEP : 0;
  else f.hole += verdict === 'tight' ? FIT_STEP : verdict === 'loose' ? -FIT_STEP : 0;
  f.contour = Math.max(-0.3, Math.min(0.3, Math.round(f.contour * 100) / 100));
  f.hole = Math.max(-0.3, Math.min(0.3, Math.round(f.hole * 100) / 100));
  f.n++;
  store.set('s2p.fit', JSON.stringify(f));
  showFit();
  status(verdict === 'good' ? `Noted: the ${part === 'studs' ? 'studs fit' : 'underside fits'}.` : `Adjusted the ${part === 'studs' ? 'studs' : 'underside'} by ${FIT_STEP} mm. Print the fit test again to check.`);
}

async function buildFitTest() {
  const btn = $('fit'); btn.disabled = true; $('dl').hidden = true; lastZip = null;
  try {
    status('Loading the test parts…');
    const [brick, plate] = await Promise.all([loadPart('3001'), loadPart('3020')]);
    if (!brick || !plate) throw new Error('The test parts could not be loaded. Check your connection and try again.');
    const red = colourOf('4');
    const scale = (parseFloat($('scale').value) || 100) / 100;
    const objs = [{ label: '3001 Brick 2 x 4 (fit test)', mesh: brick.mesh }, { label: '3020 Plate 2 x 4 (fit test)', mesh: plate.mesh }];
    const items = [{ obj: 1, cx: 108, cy: 128 }, { obj: 2, cx: 148, cy: 128 }];
    const zip = new JSZip();
    await write3mf(zip, 'fit-test.3mf', objs, items, scale, await projectSettings($('layer').value, red.rgb));
    const f = fitState();
    zip.file('HOW-TO-USE.txt', [
      'Set2Print fit test: a 2x4 brick and a 2x4 plate with your current settings',
      `(studs ${f.contour.toFixed(2)} mm, underside ${f.hole.toFixed(2)} mm, scale ${Math.round(scale * 1000) / 10}%).`,
      '',
      '1. Print it with the filament you will use for the set.',
      '2. Studs: press a real brick onto the test brick.',
      '3. Underside: press the test brick onto a real brick.',
      '4. On Set2Print, tell it each one was too tight, just right or too loose.',
      '   It adjusts the matching setting by 0.05 mm and uses it in every build. Repeat until both are just right.',
    ].join('\n') + '\n');
    lastZip = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
    lastName = 'set2print-fit-test.zip';
    renderPlateTabs([{ name: 'Fit test', rgb: red.rgb, scale, items: items.map((it) => ({ mesh: objs[it.obj - 1].mesh, cx: it.cx, cy: it.cy })) }]);
    $('dl').hidden = false;
    status('Fit test ready: about 20 minutes at 0.20 mm.');
  } catch (e) { status(e.message || String(e)); } finally { btn.disabled = false; }
}

// plate tabs over the 3D view
function renderPlateTabs(list) {
  const nav = $('platetabs');
  nav.innerHTML = '';
  list.forEach((pl, i) => {
    const btn = document.createElement('button');
    btn.innerHTML = `<span class="sw" style="background:#${esc(pl.rgb)}"></span>${esc(pl.name)}`;
    btn.setAttribute('aria-pressed', i === 0);
    btn.onclick = () => { for (const b of nav.children) b.setAttribute('aria-pressed', b === btn); showPlate(pl); };
    nav.appendChild(btn);
  });
  showPlate(list[0]);
  $('viewnote').hidden = list.length > 0;
}

function selectTab(which) {
  const set = which === 'set';
  $('tab-set').setAttribute('aria-selected', set); $('tab-list').setAttribute('aria-selected', !set);
  $('pane-set').hidden = !set; $('pane-list').hidden = set;
}

$('setnum').value = store.get('s2p.set');
$('setnum').oninput = () => { store.set('s2p.set', $('setnum').value); suggest(); };
fetch('data/meta.json').then((r) => r.json()).then((m) => { $('datainfo').textContent = `${m.sets.toLocaleString()} sets, updated ${m.built}.`; }).catch(() => {});
$('tab-set').onclick = () => selectTab('set');
$('tab-list').onclick = () => selectTab('list');
$('go').onclick = build;
$('fit').onclick = buildFitTest;
for (const b of document.querySelectorAll('[data-fit]')) b.onclick = () => reportFit(b.dataset.part, b.dataset.fit);
$('fitreset').onclick = () => { store.set('s2p.fit', ''); showFit(); status('Fit adjustments cleared.'); };
showFit();
$('bed').onchange = () => buildBed(parseFloat($('bed').value) || 256);
$('dl').onclick = download;
$('file').onchange = async (e) => { const f = e.target.files[0]; if (f) { $('listtext').value = await f.text(); } };
const drop = $('drop');
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = async (e) => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) $('listtext').value = await f.text(); };

// test hook: lets an automated check run the whole pipeline without clicks
window.set2print = { fromText, loadPart, pack, build, supported, get zip() { return lastZip; } };
