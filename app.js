// Set2Print: parts list -> LDraw geometry -> studs-up meshes in mm -> plates per colour -> one Bambu Studio .3mf.
import { COLORS } from './colors.js';
import { multiFilamentSettings, projectFile } from './export3mf.js';
import { buildBed, showPlate } from './viewer.js';
import { pack } from './layout.js';

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
// Loading a part and its support check run in worker threads (site_worker.js): a baseplate takes seconds to
// load and a big part seconds to minutes to check, which would freeze the page.
const pool = [], waiting = new Map();
let jobId = 0;
function inWorker(kind, data) {
  if (!pool.length) {
    for (let k = 0; k < Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)); k++) {
      const w = new Worker('site_worker.js', { type: 'module' });
      w.busy = 0;
      w.onmessage = ({ data }) => { w.busy--; waiting.get(data.id).res(data.r); waiting.delete(data.id); };
      // a worker that failed to load or crashed leaves the pool (the next job makes a new pool if none is left)
      w.onerror = (e) => {
        e.preventDefault(); w.terminate(); if (pool.includes(w)) pool.splice(pool.indexOf(w), 1);
        const why = e.message || 'worker error';
        for (const [id, j] of waiting) if (j.w === w) { j.res(j.kind === 'load' ? { error: why } : { mesh: j.data.mesh, note: 'support check failed: ' + why, unserved: 1 }); waiting.delete(id); }
      };
      pool.push(w);
    }
  }
  const w = pool.reduce((a, b) => (b.busy < a.busy ? b : a));
  w.busy++;
  return new Promise((res) => {
    const id = ++jobId;
    waiting.set(id, { res, w, kind, data });
    w.postMessage({ id, kind, ...data });   // copied, not moved: a loaded mesh stays cached here
  });
}
// a part's mesh (null: not in LDraw); throws if it could not be loaded at all
const partCache = new Map();
function loadPart(id) {
  if (!partCache.has(id)) partCache.set(id, inWorker('load', { part: id }).then((r) => { if (r?.error) { partCache.delete(id); throw new Error(r.error); } return r; }));
  return partCache.get(id);
}
function supported(g) {
  if (!supportCache.has(g.name)) {
    supportCache.set(g.name, verified().then(async (v) => {
      const s = v[g.name] === 'plain' ? { mesh: g.mesh, note: 'prints as is (checked in Bambu Studio)', before: 0, after: 0, unserved: 0 } : await inWorker('support', { mesh: g.mesh });
      return { name: g.name, mesh: s.mesh, support: s };
    }));
  }
  return supportCache.get(g.name);
}

// ---------- writers (export3mf.js) ----------
let baseCfgP = null, filKeysP = null;
// One Bambu Studio project: the P1S/X1/P2S profile with the Lego values, one filament per colour.
async function projectSettings(layer, rgbs, bed) {
  baseCfgP ??= fetch('bambu/p1s-base.json').then((r) => r.json());
  filKeysP ??= fetch('bambu/filament-keys.json').then((r) => r.json());
  const cfg = JSON.parse(multiFilamentSettings(await baseCfgP, await filKeysP, layer, rgbs, fitState()));
  if (bed !== 256) cfg.printable_area = ['0x0', `${bed}x0`, `${bed}x${bed}`, `0x${bed}`];
  return JSON.stringify(cfg, null, 4);
}

// ---------- UI ----------
let lastFile = null, lastName = 'set2print.3mf';

function render(lines) {
  $('rows').innerHTML = lines.map((l, i) => `<tr id="r${i}"><td class="mono">${esc(l.part)}</td><td class="name">${esc(l.name || '')}</td>` +
    `<td><span class="sw" style="background:#${esc(l.colour.rgb)}"></span>${esc(l.colour.name)}</td><td>${l.qty}</td><td><span class="pill wait">waiting</span></td></tr>`).join('');
}
const setRow = (i, cls, text) => { const c = document.querySelector(`#r${i} td:last-child`); if (c) c.innerHTML = `<span class="pill ${cls}">${esc(text)}</span>`; };
const sum = (o) => { for (const [k, v] of Object.entries(o)) $('s-' + k).textContent = v; };

async function build() {
  const btn = $('go');
  btn.disabled = true; $('dl').hidden = true; lastFile = null;
  try {
    const spares = $('spares').checked;
    const scale = (parseFloat($('scale').value) || 100) / 100;
    const gap = parseFloat($('gap').value) || 12;
    const bed = parseFloat($('bed').value) || 256;
    const fins = $('fins').checked;
    showBed(bed); showPlate(null); $('platetabs').innerHTML = ''; $('viewnote').hidden = false;
    $('rows').innerHTML = '<tr><td colspan="5" class="hint">Parts appear here once you build plates.</td></tr>'; sum({ parts: 0, unique: 0, colours: 0, plates: 0, missing: 0 });   // a failed build must not leave the last one's results
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
        let failed = '';
        const g = await loadPart(l.ldraw).catch((e) => { failed = e.message; return null; });
        l.geom = g && (fins ? await supported(g) : g);
        if (!g) { setRow(i, 'bad', failed ? 'load failed: ' + failed : 'not in LDraw'); missing++; }
        else if (!fins || !l.geom.support || l.geom.support.note === 'prints as is') setRow(i, 'ok', 'ready');
        else setRow(i, l.geom.support.unserved ? 'skip' : 'ok', l.geom.support.note);
        done++; status(`Loading parts ${done} / ${lines.length}`);
        sum({ missing });
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);

    // pack per colour and write
    status('Laying out plates…');
    const base = slug(src.title) || 'set';
    let plateCount = 0;
    const viewPlates = [], projectPlates = [], colourRgbs = [];
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
      colourRgbs.push(ls[0].colour.rgb);
      const filament = colourRgbs.length;
      const items = [];
      for (const l of ls) for (let q = 0; q < l.qty; q++) items.push({ line: l, w: l.geom.mesh.size[0] * scale, h: l.geom.mesh.size[1] * scale });
      const plates = pack(items, bed, gap);
      for (let p = 0; p < plates.length; p++) {
        const rgb = ls[0].colour.rgb;
        viewPlates.push({ name: `${colour} ${p + 1}`, rgb, scale, items: plates[p].map((it) => ({ mesh: it.line.geom.mesh, cx: it.cx, cy: it.cy })) });
        projectPlates.push({ name: `${colour} ${p + 1}`, filament, items: plates[p].map((it) => ({ key: it.line.geom.name, label: `${it.line.geom.name} ${it.line.name || ''}`.trim(), mesh: it.line.geom.mesh, cx: it.cx, cy: it.cy })) });
        plateCount++; sum({ plates: plateCount });
        status(`Writing plates… ${plateCount}`);
      }
    }
    renderPlateTabs(viewPlates);
    if (projectPlates.length) {
      status('Writing the Bambu Studio project…');
      lastFile = new Blob([await projectFile(JSZip, projectPlates, await projectSettings($('layer').value, colourRgbs, bed), bed, scale)], { type: 'model/3mf' });
      lastName = base + '.3mf';
      $('dl').hidden = false;
    }
    status(`Done: ${plateCount} plate${plateCount === 1 ? '' : 's'}${missing ? `, ${missing} part(s) not in the library` : ''}${tooBig.length ? `, ${tooBig.length} too big for the bed` : ''} (marked in the table below).`);
  } catch (e) {
    status(e.message || String(e));
  } finally {
    btn.disabled = false;
  }
}

function save(blob, name) {
  if (!blob) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
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
  const btn = $('fit'); btn.disabled = true; $('dl').hidden = true; lastFile = null;
  try {
    status('Loading the test parts…');
    const [brick, plate] = await Promise.all([loadPart('3001'), loadPart('3020')]);
    if (!brick || !plate) throw new Error('The test parts could not be loaded. Check your connection and try again.');
    const red = colourOf('4');
    const scale = (parseFloat($('scale').value) || 100) / 100;
    const objs = [{ label: '3001 Brick 2 x 4 (fit test)', mesh: brick.mesh }, { label: '3020 Plate 2 x 4 (fit test)', mesh: plate.mesh }];
    const items = [{ obj: 1, cx: 108, cy: 128 }, { obj: 2, cx: 148, cy: 128 }];
    const pl = [{ name: 'Fit test', filament: 1, items: items.map((it) => ({ key: objs[it.obj - 1].label, label: objs[it.obj - 1].label, mesh: objs[it.obj - 1].mesh, cx: it.cx, cy: it.cy })) }];
    lastFile = new Blob([await projectFile(JSZip, pl, await projectSettings($('layer').value, [red.rgb], 256), 256, scale)], { type: 'model/3mf' });
    lastName = 'set2print-fit-test.3mf';
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
function showBed(size) { buildBed(size); $('viewnote').textContent = `Empty plate (${size} × ${size} mm). Find a set or paste a list, then Build plates.`; }
$('bed').onchange = () => showBed(parseFloat($('bed').value) || 256);
$('dl').onclick = () => save(lastFile, lastName);
$('file').onchange = async (e) => { const f = e.target.files[0]; if (f) { $('listtext').value = await f.text(); } };
const drop = $('drop');
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = async (e) => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) $('listtext').value = await f.text(); };

// test hook: lets an automated check run the whole pipeline without clicks
window.set2print = { fromText, loadPart, pack, build, supported, get file() { return lastFile; } };
