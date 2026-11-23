// Brick2Print: parts list -> LDraw geometry -> studs-up meshes in mm -> plates per colour -> one Bambu Studio .3mf.
import { COLORS } from './colors.js';
import { multiFilamentSettings, projectFile } from './export3mf.js';
import { buildBed, showPlate } from './viewer.js';
import { pack } from './layout.js';
import { getJSON, once, setDeadline, tabId } from './net.js';
import { memoryForPageMB, workerCount, projectNeedMB, listNeedMB } from './limits.js';
import { createPool } from './pool.js';

const $ = (id) => document.getElementById(id);
// a number input's value held to its min and max (shown back in the box); unreadable -> its default
function num(id) {
  const el = $(id), v = parseFloat(el.value);
  const n = Number.isFinite(v) ? Math.min(+el.max, Math.max(+el.min, v)) : +el.defaultValue;
  if (String(n) !== el.value) el.value = n;
  return n;
}

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
const loadIndex = once(() => getJSON('data/index.json'));
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
  const shard = await getJSON(`data/sets/${bucket(sn)}.json`).catch(() => { throw new Error('The set data could not be loaded. Check your connection and try again.'); });
  const set = shard[sn];
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
  const first = rows[0].split(/[,;\t]/).map((s) => s.trim().replace(/^"|"$/g, '').toLowerCase());
  // a header row: Rebrickable (Part, Color, Quantity, Is Spare) or BrickLink (Item No, Color, Qty)
  const bricklink = first.some((h) => /^item ?(no|number|id)$/.test(h));
  if (first.some((h) => /part|item|colou?r|quantity|qty|amount/.test(h))) {
    cols = {
      part: first.findIndex((h) => /^part|^item ?(no|number|id)$/.test(h)),
      colour: first.findIndex((h) => /colou?r/.test(h)),
      qty: first.findIndex((h) => /quantity|qty|amount/.test(h)),
      spare: first.findIndex((h) => /spare/.test(h)),
    };
    if (cols.part < 0) throw new Error(`No part column in the header ("${rows[0]}"): name one "Part" or "Item No".`);
    rows.shift();
  }
  const merged = new Map();
  for (const row of rows) {
    const f = row.split(/[,;\t]/).map((s) => s.trim().replace(/^"|"$/g, ''));
    const part = f[cols.part];
    if (!part) continue;
    if (cols.spare >= 0 && /^(true|1|yes)$/i.test(f[cols.spare] || '') && !withSpares) continue;
    // BrickLink numbers its colours differently from Rebrickable (BrickLink 5 is red, Rebrickable 5 is pink)
    if (bricklink && cols.colour >= 0 && /^\d+$/.test(f[cols.colour] || '')) throw new Error('This is a BrickLink list with BrickLink colour numbers, which differ from Rebrickable\'s. Use colour names (Red, Light Bluish Gray) or a Rebrickable export.');
    const colour = colourOf(cols.colour >= 0 ? f[cols.colour] : '');
    const q = cols.qty >= 0 && f[cols.qty] !== '' && f[cols.qty] !== undefined ? parseInt(f[cols.qty], 10) : 1;   // no quantity given: one
    if (!(q > 0)) continue;   // 0, negative or unreadable: nothing to print
    const qty = q;
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
// Loaded once per build (not per part: under a refusing host each part would wait again). If it can't be loaded,
// that build gives every part automatic supports and says so; nothing is remembered, the next build tries again.
const loadDecisions = once(() => getJSON('bambu/decisions.json'));
// Loading a part and its support check run in worker threads (site_worker.js): a baseplate takes seconds to
// load and a big part seconds to minutes to check, which would freeze the page.
// One core left for the page; fewer workers when the device has little memory (each holds three.js and a parts
// loader). pool.js settles every job a worker held whenever it goes away, whatever the route (audit/test_pool.mjs).
const pool = createPool(() => new Worker('site_worker.js', { type: 'module', name: JSON.stringify({ imports: JSON.parse(document.querySelector('script[type="importmap"]').textContent).imports, tab: tabId }) }), workerCount(navigator));   // three.js's URLs, and this tab's id for its build deadline (net.js)
// a part's mesh (null: not in LDraw); throws if it could not be loaded at all
const partCache = new Map();
// Each id is resolved to its LDraw file names first, so printed variants of one shape (3069bpr0001, 3069bpr0002 ->
// 3069b) load once; the meshes live only here, the workers drop theirs after each load.
const shapeCache = new Map();
// Every job goes this way: an error answer is thrown, never taken for a result (pool.js has already re-sent a job
// whose worker went away).
// run: pool.run, or a build's session run so its deadline can give its jobs up without touching anyone else's.
const job = (kind, data, run = pool.run) => run(kind, data).then((r) => { if (r?.error) throw Object.assign(new Error(r.error), { missingFiles: r.missingFiles }); return r; });
function loadShape(file, run) {
  if (!shapeCache.has(file)) shapeCache.set(file, job('load', { part: file }, run).catch((e) => { shapeCache.delete(file); throw e; }));
  return shapeCache.get(file);
}
function loadPart(id, name = '', run) {
  if (!partCache.has(id)) {
    partCache.set(id, job('resolve', { part: id, name }, run).then(async (files) => {
      for (const f of files) { const g = await loadShape(f, run); if (g) return g; }   // null: that file has no faces, try the next
      return null;
    }).catch((e) => { partCache.delete(id); throw e; }));
  }
  return partCache.get(id);
}
function supported(g, v, run) {   // v: this build's decisions list, or null when it couldn't be loaded
  if (!supportCache.has(g.name)) {
    supportCache.set(g.name, (async () => {
      const s = v?.[g.name] === 'plain' ? { mesh: g.mesh, note: 'prints as is (checked in Bambu Studio)', before: 0, after: 0, unserved: 0 } : await job('support', { mesh: g.mesh }, run).then((r) => (r?.mesh ? r : Promise.reject(new Error('no shape came back'))))
        .catch((e) => ({ mesh: g.mesh, note: 'support check failed: ' + e.message, unserved: 1 }));   // fails in words, with the part's own shape
      // decided without the checked list, or the check failed (here, in the worker or in the pool: all say it this
      // way): decide again next build, never remember a failure as the answer
      if (!v || s.note?.startsWith('support check failed')) supportCache.delete(g.name);
      return { name: g.name, mesh: s.mesh, support: s };
    })());
  }
  return supportCache.get(g.name);
}

// ---------- writers (export3mf.js) ----------
// One Bambu Studio project: the P1S/X1/P2S profile with the Lego values, one filament per colour.
const loadBase = once(() => getJSON('bambu/p1s-base.json')), loadFilKeys = once(() => getJSON('bambu/filament-keys.json'));
async function projectSettings(layer, rgbs, bed) {
  const [baseCfg, filKeys] = await Promise.all([loadBase(), loadFilKeys()]).catch(() => { throw new Error('The printer settings could not be loaded. Check your connection and build again.'); });
  const cfg = JSON.parse(multiFilamentSettings(baseCfg, filKeys, layer, rgbs, fitState()));
  if (bed !== 256) cfg.printable_area = ['0x0', `${bed}x0`, `${bed}x${bed}`, `0x${bed}`];
  return JSON.stringify(cfg, null, 4);
}

// ---------- UI ----------
let lastFile = null, lastName = 'brick2print.3mf';

function render(lines) {
  $('rows').innerHTML = lines.map((l, i) => `<tr id="r${i}"><td class="mono">${esc(l.part)}</td><td class="name">${esc(l.name || '')}</td>` +
    `<td><span class="sw" style="background:#${esc(l.colour.rgb)}"></span>${esc(l.colour.name)}</td><td>${l.qty}</td><td><span class="pill wait">waiting</span></td></tr>`).join('');
}
const setRow = (i, cls, text) => { const c = document.querySelector(`#r${i} td:last-child`); if (c) c.innerHTML = `<span class="pill ${cls}">${esc(text)}</span>`; };
const sum = (o) => { for (const [k, v] of Object.entries(o)) $('s-' + k).textContent = v; };

// Both memory refusals are estimates (limits.js), so each offers "Build anyway". Passing the rough up-front one still
// stops at the exact one after loading, which offers its own; neither pass is remembered past the next build.
let pass = { list: false, exact: false }, offered = null;
async function build() {
  const force = pass; pass = { list: false, exact: false };
  const btn = $('go');
  btn.disabled = true; $('dl').hidden = true; $('anyway').hidden = true; lastFile = null;
  // A build is given up only when it stops making progress: 10 minutes with no part loaded and no support check back.
  // Each answer moves both limits on (the worker jobs here, library retries in net.js), so a slow device that keeps
  // going is never cut off. The session's jobs are this build's alone.
  const STALL = 10 * 60 * 1000;
  const jobs = pool.session({ stallMs: STALL, why: 'the build made no progress for 10 minutes', onAlive: () => setDeadline(Date.now() + STALL) });
  try {
    const spares = $('spares').checked;
    const scale = num('scale') / 100, gap = num('gap'), bed = num('bed');
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
    // the list alone already tells whether writing it would fit (the exact check after loading stays)
    const listMB = listNeedMB(lines.length), pageMB = memoryForPageMB(navigator);
    if (listMB > pageMB && !force.list) { offered = 'list'; $('anyway').hidden = false; throw new Error(`This set is too big for this device: writing it needs about ${listMB} MB of memory and this browser gives a page about ${pageMB} MB. Build it on a computer, paste part of the list, or try anyway.`); }
    const colours = new Set(lines.map((l) => l.colour.id));
    sum({ parts: lines.reduce((a, l) => a + l.qty, 0), unique: new Set(lines.map((l) => l.ldraw)).size, colours: colours.size, plates: 0, missing: 0 });

    // load geometry, 4 at a time
    const decisions = fins ? await loadDecisions().catch(() => null) : null, decisionsMissing = fins && !decisions;
    let done = 0, missing = 0, unloaded = 0, notPrintable = 0;   // unloaded: download failed, a new build tries again
    const queue = lines.map((l, i) => [l, i]);
    const worker = async () => {
      while (queue.length) {
        const [l, i] = queue.shift();
        setRow(i, 'wait', 'loading');
        let failed = '', incomplete = false;
        const g = await loadPart(l.ldraw, l.name, jobs.run).catch((e) => { failed = e.message; incomplete = !!e.missingFiles; return null; });
        l.geom = g && (fins ? await supported(g, decisions, jobs.run) : g);
        if (!g && incomplete) { setRow(i, 'bad', 'not printable: ' + failed); notPrintable++; }   // the library lacks part of it: no retry helps
        else if (!g && failed) { setRow(i, 'bad', 'load failed: ' + failed); unloaded++; }
        else if (!g) { setRow(i, 'bad', 'not in LDraw'); missing++; }
        else if (!fins || !l.geom.support || l.geom.support.note === 'prints as is') setRow(i, 'ok', 'ready');
        else setRow(i, l.geom.support.unserved ? 'skip' : 'ok', l.geom.support.note);
        done++; status(`Loading parts ${done} / ${lines.length}`);
        sum({ missing: missing + notPrintable });
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
      // wider than the space beside the no-print corner and taller than the space above it
      for (const it of plates.oversize) if (!tooBig.includes(it.line)) { tooBig.push(it.line); setRow(lines.indexOf(it.line), 'bad', `too big for a ${bed} mm bed (no-print corner)`); }
      for (let p = 0; p < plates.length; p++) {
        const rgb = ls[0].colour.rgb;
        viewPlates.push({ name: `${colour} ${p + 1}`, rgb, scale, items: plates[p].map((it) => ({ mesh: it.line.geom.mesh, cx: it.cx, cy: it.cy })) });
        projectPlates.push({ name: `${colour} ${p + 1}`, filament, items: plates[p].map((it) => ({ key: it.line.geom.name, label: `${it.line.geom.name} ${it.line.name || ''}`.trim(), mesh: it.line.geom.mesh, cx: it.cx, cy: it.cy })) });
        plateCount++; sum({ plates: plateCount });
        status(`Writing plates… ${plateCount}`);
      }
    }
    renderPlateTabs(viewPlates);
    // Writing the project holds every object's vertices as text: refuse in words rather than let a phone kill the tab.
    const needMB = projectNeedMB(projectPlates), haveMB = memoryForPageMB(navigator);
    if (projectPlates.length && needMB > haveMB && !force.exact) {
      offered = 'exact'; $('anyway').hidden = false;
      status(`This set is too big for this device: writing it needs about ${needMB} MB of memory and this browser gives a page about ${haveMB} MB. The plates are shown above; build the download on a computer, paste part of the list, or try anyway.`);
      return;
    }
    if (projectPlates.length) {
      status('Writing the Bambu Studio project…');
      lastFile = new Blob([await projectFile(JSZip, projectPlates, await projectSettings($('layer').value, colourRgbs, bed), bed, scale)], { type: 'model/3mf' });
      lastName = base + '.3mf';
      $('dl').hidden = false;
    }
    status(`Done: ${plateCount} plate${plateCount === 1 ? '' : 's'}${missing ? `, ${missing} part(s) not in the library` : ''}${notPrintable ? `, ${notPrintable} part(s) not printable (pieces missing from the library)` : ''}${unloaded ? `, ${unloaded} part(s) could not be downloaded (build again to retry)` : ''}${tooBig.length ? `, ${tooBig.length} too big for the bed` : ''} (marked in the table below).${decisionsMissing ? ' The list of parts checked in Bambu Studio could not be loaded, so this build gave every part automatic supports; build again to retry.' : ''}`);
  } catch (e) {
    status(e.message || String(e));
  } finally {
    btn.disabled = false;
    setDeadline(null);
    jobs.close();
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
    const scale = num('scale') / 100;
    const objs = [{ label: '3001 Brick 2 x 4 (fit test)', mesh: brick.mesh }, { label: '3020 Plate 2 x 4 (fit test)', mesh: plate.mesh }];
    const items = [{ obj: 1, cx: 108, cy: 128 }, { obj: 2, cx: 148, cy: 128 }];
    const pl = [{ name: 'Fit test', filament: 1, items: items.map((it) => ({ key: objs[it.obj - 1].label, label: objs[it.obj - 1].label, mesh: objs[it.obj - 1].mesh, cx: it.cx, cy: it.cy })) }];
    lastFile = new Blob([await projectFile(JSZip, pl, await projectSettings($('layer').value, [red.rgb], 256), 256, scale)], { type: 'model/3mf' });
    lastName = 'brick2print-fit-test.3mf';
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
getJSON('data/meta.json').then((m) => { $('datainfo').textContent = `${m.sets.toLocaleString()} sets, updated ${m.built}.`; }).catch(() => {});
$('tab-set').onclick = () => selectTab('set');
$('tab-list').onclick = () => selectTab('list');
$('go').onclick = build;
$('anyway').onclick = () => { pass = { list: true, exact: offered === 'exact' }; build(); };
$('fit').onclick = buildFitTest;
for (const b of document.querySelectorAll('[data-fit]')) b.onclick = () => reportFit(b.dataset.part, b.dataset.fit);
$('fitreset').onclick = () => { store.set('s2p.fit', ''); showFit(); status('Fit adjustments cleared.'); };
showFit();
function showBed(size) { buildBed(size); $('viewnote').textContent = `Empty plate (${size} × ${size} mm). Find a set or paste a list, then Build plates.`; }
$('bed').onchange = () => showBed(num('bed'));
$('dl').onclick = () => save(lastFile, lastName);
$('file').onchange = async (e) => { const f = e.target.files[0]; if (f) { $('listtext').value = await f.text(); } };
const drop = $('drop');
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = async (e) => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) $('listtext').value = await f.text(); };
document.documentElement.dataset.ready = '1';   // index.html shows a message if this never happens (three.js or a script failed to load)
$('loadfail').hidden = true;   // shown by index.html's 25 s timer on a slow connection: the app did start
