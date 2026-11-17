// Set2Print: parts list -> LDraw geometry -> studs-up meshes in mm -> plates per colour -> 3MF + STL zip.
import { COLORS } from './colors.js';
import { loadPart } from './parts.js';
import { settingsJson, write3mf as write3mfWith, stl } from './export3mf.js';
import { autoSupport } from './supports.js';
import { buildBed, showPlate } from './viewer.js';

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

// One decision per unique part: pose + fins, cached.
const supportCache = new Map();
// Parts the audit sliced in Bambu Studio where automatic supports came out worse than plain
// studs-up (audit/decisions.py): those print plain. Unaudited parts use the geometry rules.
let verifiedP = null;
const verified = () => (verifiedP ??= fetch('bambu/decisions.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({})));
function supported(g) {
  if (!supportCache.has(g.name)) {
    supportCache.set(g.name, verified().then((v) => new Promise((res) => setTimeout(() => {
      let s;
      if (v[g.name] === 'plain') s = { mesh: g.mesh, note: 'prints as is (checked in Bambu Studio)', before: 0, after: 0, unserved: 0 };
      else {
        try { s = autoSupport(g.mesh); } catch (e) { s = { mesh: g.mesh, note: 'support check failed: ' + e.message, unserved: 1 }; }
      }
      res({ name: g.name, mesh: s.mesh, support: s });
    }, 0))));
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

// ---------- writers (export3mf.js) ----------
let baseCfgP = null;
async function projectSettings(layer, rgb) {
  baseCfgP ??= fetch('bambu/p1s-base.json').then((r) => r.json());
  return settingsJson(await baseCfgP, layer, rgb, fitState());
}
const write3mf = (zip, path, objects, items, scale, settings) => write3mfWith(JSZip, zip, path, objects, items, scale, settings);

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
    // parts wider than the bed (minus its edge margins) can't be printed whole: report them, don't ship a broken plate
    const tooBig = [];
    for (const l of lines) {
      if (!l.geom) continue;
      if (Math.max(l.geom.mesh.size[0], l.geom.mesh.size[1]) * scale > bed - 16) { tooBig.push(l); setRow(lines.indexOf(l), 'bad', `too big for a ${bed} mm bed`); continue; }
      if (!byColour.has(l.colour.name)) byColour.set(l.colour.name, []);
      byColour.get(l.colour.name).push(l);
    }
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
    if (tooBig.length) zip.file('too-big.txt', `These parts are wider than a ${bed} mm bed and were left out:\n\n` + tooBig.map((l) => `${l.part}\t${l.colour.name}\tx${l.qty}\t${l.name || ''}`).join('\n') + '\n');
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
