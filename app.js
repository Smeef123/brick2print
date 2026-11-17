// Set2Print: parts list -> LDraw geometry -> studs-up meshes in mm -> plates per colour -> 3MF + STL zip.
import * as THREE from 'three';
import { LDrawLoader } from 'three/addons/loaders/LDrawLoader.js';
import { COLORS } from './colors.js';
import { autoSupport } from './supports.js';

// raw.githubusercontent serves every file with CORS; jsDelivr refuses parts of this repo (over its 50 MB limit).
const LIB = 'https://raw.githubusercontent.com/gkjohnson/ldraw-parts-library/master/complete/ldraw/';
const LDU_MM = 0.4;            // 1 LDraw unit = 0.4 mm
const API = 'https://rebrickable.com/api/v3/lego';
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
async function fromRebrickable(setNum, key, withSpares) {
  if (!key) throw new Error('Add your Rebrickable API key, or switch to "Paste or upload a list".');
  let set = setNum.trim();
  if (!set) throw new Error('Enter a set number, for example 6000-1.');
  if (!/-\d+$/.test(set)) set += '-1';
  const head = { Authorization: 'key ' + key, Accept: 'application/json' };
  const info = await fetch(`${API}/sets/${encodeURIComponent(set)}/`, { headers: head });
  if (info.status === 401) throw new Error('Rebrickable refused the API key. Check it under Settings → API on rebrickable.com.');
  if (info.status === 404) throw new Error(`Rebrickable has no set "${set}". Check the number on rebrickable.com.`);
  if (!info.ok) throw new Error(`Rebrickable answered ${info.status}. Try again in a minute.`);
  const meta = await info.json();
  const out = [];
  let url = `${API}/sets/${encodeURIComponent(set)}/parts/?page_size=1000&inc_part_details=1`;
  while (url) {
    await new Promise((r) => setTimeout(r, 1100)); // Rebrickable allows 1 request per second
    const r = await fetch(url, { headers: head });
    if (!r.ok) throw new Error(`Rebrickable answered ${r.status} while reading the parts list.`);
    const j = await r.json();
    for (const it of j.results) {
      if (it.is_spare && !withSpares) continue;
      const ld = it.part.external_ids && it.part.external_ids.LDraw;
      out.push({
        part: it.part.part_num, ldraw: (ld && ld[0]) || it.part.part_num, name: it.part.name,
        colour: { id: String(it.color.id), name: it.color.name, rgb: it.color.rgb }, qty: it.quantity,
      });
    }
    url = j.next;
  }
  return { title: `${meta.set_num} ${meta.name}`, lines: out };
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

async function write3mf(zip, path, objects, items, scale) {
  const z = new JSZip();
  z.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>');
  z.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>');
  z.file('3D/3dmodel.model', model3mf(objects, items, scale));
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
    let src;
    if ($('tab-set').getAttribute('aria-selected') === 'true') {
      store.set('s2p.key', $('apikey').value.trim());
      status('Reading the parts list from Rebrickable…');
      src = await fromRebrickable($('setnum').value, $('apikey').value.trim(), spares);
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
        await write3mf(zip, `plates/${slug(colour)}-${p + 1}${tag}.3mf`, objs, placed, scale);
        plateCount++; sum({ plates: plateCount });
        status(`Writing plates… ${plateCount}`);
      }
    }
    const seen = new Set();
    for (const l of lines) if (l.geom && !seen.has(l.geom.name)) { seen.add(l.geom.name); zip.file(`parts/${l.geom.name}.stl`, stl(l.geom.mesh, scale)); }
    const notFound = lines.filter((l) => !l.geom);
    if (notFound.length) zip.file('not-found.txt', 'These parts are not in the LDraw library (often stickers, printed or rubber parts, or newer molds):\n\n' + notFound.map((l) => `${l.part}\t${l.colour.name}\tx${l.qty}\t${l.name || ''}`).join('\n') + '\n');
    const supNotes = [...new Map(lines.filter((l) => l.geom && l.geom.support && l.geom.support.note !== 'prints as is').map((l) => [l.geom.name, l.geom.support])).entries()];
    if (supNotes.length) zip.file('supports.txt', 'Parts turned or given fins automatically (slicer supports stay off):\n\n' + supNotes.map(([n, s]) => `${n}\t${s.note}\t(unsupported before: ${s.before.toFixed(1)} mm2, after turning: ${s.after.toFixed(1)} mm2)`).join('\n') + '\n');
    zip.file('README.txt', `Made with Set2Print from: ${src.title}\nScale ${Math.round(scale * 1000) / 10}%. Parts are studs-up unless supports.txt says otherwise, one 3MF per plate, named by colour.\nPrint with slicer supports OFF: overhangs were checked by geometry (bridges up to 20 mm, overhangs up to ~70 degrees) and given breakaway fins (Support Fins engine) where needed.\nPart geometry from the LDraw.org parts library (CC BY 2.0). Inventory and colours from Rebrickable.\n`);
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

function selectTab(which) {
  const set = which === 'set';
  $('tab-set').setAttribute('aria-selected', set); $('tab-list').setAttribute('aria-selected', !set);
  $('pane-set').hidden = !set; $('pane-list').hidden = set;
}

$('apikey').value = store.get('s2p.key');
$('tab-set').onclick = () => selectTab('set');
$('tab-list').onclick = () => selectTab('list');
$('go').onclick = build;
$('dl').onclick = download;
$('file').onchange = async (e) => { const f = e.target.files[0]; if (f) { $('listtext').value = await f.text(); } };
const drop = $('drop');
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = async (e) => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) $('listtext').value = await f.text(); };

// test hook: lets an automated check run the whole pipeline without clicks
window.set2print = { fromText, loadPart, pack, build, supported, get zip() { return lastZip; } };
