// Check the site itself in headless Chrome, every path a visitor uses, and slice what it downloads in the
// Bambu Studio CLI (every plate must get G-code, each on its own filament). Exits 1 on any failure.
//   node audit/test_site.mjs [local|<url>]
// local serves this checkout (or SITE_DIR, e.g. the publish workflow's _site) on 127.0.0.1:8768, with ldraw/ from
// LDRAW_DIR (default C:/Users/Connor/tools/ldraw) when the site folder has none.
// Needs `npm install` in audit/ (playwright-core) and Chrome (CHROME=path to override); the browser is headless.
// Without Bambu Studio (BAMBU=path to override; none on the publish workflow's Linux runner) the downloads are
// checked but not sliced, and the run says so.
// Covers: page load and empty 3D bed; set suggestions; a set by number and by name; plate tabs and the 3D view;
// paste a list (merging, colour names and numbers) with bed, gap, layer, scale and supports-off options; a
// Rebrickable CSV upload with and without spares; bad input messages; fit-test reports, plate and reset.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import JSZip from 'jszip';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
const ROOT = path.resolve(process.env.SITE_DIR || path.join(HERE, '..'));
const LDRAW = process.env.LDRAW_DIR || 'C:/Users/Connor/tools/ldraw';
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BAMBU = process.env.BAMBU || 'C:/Program Files/Bambu Studio/bambu-studio.exe';
const SLICE = fs.existsSync(BAMBU);
const SET = '11926-1', SET_NAME = 'Parts for Wooden Minifigure';   // 29 pieces, 12 unique parts, all in LDraw
const [where = 'local', MODE = 'desktop'] = process.argv.slice(2);   // MODE phone: the phone checks only
const OUT = path.join(HERE, 'out', 'site-test', (where === 'local' ? 'local' : 'live') + (MODE === 'phone' ? '-phone' : ''));
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });

const failures = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures.push(what); return ok; };

let url = where;
if (where === 'local') {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x/').pathname);
    let p = path.join(ROOT, rel);
    // a checkout has no ldraw/ (the publish workflow adds it): serve the local library in its place
    if (rel.startsWith('/ldraw/') && !fs.existsSync(path.join(ROOT, 'ldraw'))) p = path.join(LDRAW, rel.slice(7));
    if (p.endsWith(path.sep) || p === ROOT) p = path.join(p, 'index.html');
    if (!(p.startsWith(ROOT) || p.startsWith(path.resolve(LDRAW))) || !fs.existsSync(p) || !fs.statSync(p).isFile()) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(p).pipe(res);
  });
  await new Promise((ok, no) => server.once('error', no).listen(8768, '127.0.0.1', ok));
  server.unref();
  url = 'http://127.0.0.1:8768/';
}

// what the downloaded project holds: plates (name, objects, filament), filament colours, settings
async function readProject(file) {
  const z = await JSZip.loadAsync(fs.readFileSync(file));
  const ms = await z.file('Metadata/model_settings.config').async('string');
  const cfg = JSON.parse(await z.file('Metadata/project_settings.config').async('string'));
  const model = await z.file('3D/3dmodel.model').async('string');
  const extruder = Object.fromEntries([...ms.matchAll(/<object id="(\d+)">\s*<metadata key="name"[^>]*>\s*<metadata key="extruder" value="(\d+)"/g)].map((m) => [m[1], +m[2]]));
  const plates = [...ms.matchAll(/<plate>([\s\S]*?)<\/plate>/g)].map((m) => {
    const objs = [...m[1].matchAll(/key="object_id" value="(\d+)"/g)].map((o) => o[1]);
    return { name: /plater_name" value="([^"]*)"/.exec(m[1])[1], objects: objs.length, filaments: [...new Set(objs.map((o) => extruder[o]))] };
  });
  const scales = [...new Set([...model.matchAll(/transform="([\d.]+) /g)].map((m) => +m[1]))];
  return { plates, cfg, scales };
}

// one CLI run slices every plate; per plate: G-code present and on the plate's own filament
async function slicedOk(file, proj, tag) {
  if (!SLICE) { console.log(`skip ${tag}: no Bambu Studio here (${BAMBU}), download not sliced`); return true; }
  const dir = path.join(OUT, 'slice-' + tag); fs.mkdirSync(dir, { recursive: true });
  const r = spawnSync(BAMBU, ['--slice', '0', '--outputdir', dir, '--export-3mf', 's.3mf', '--allow-newer-file', file], { stdio: 'ignore', timeout: 180000 });   // the CLI can stall at start-up
  const rf = path.join(dir, 'result.json');
  if (!fs.existsSync(rf)) return check(false, `${tag}: slicer gave no result within 180 s (${r.error?.code || 'exit ' + r.status})`);
  const res = JSON.parse(fs.readFileSync(rf, 'utf8'));
  const z = await JSZip.loadAsync(fs.readFileSync(path.join(dir, 's.3mf')));
  let good = 0;
  for (let k = 1; k <= proj.plates.length; k++) {
    const g = await z.file(`Metadata/plate_${k}.gcode`)?.async('string');
    const tools = g ? [...new Set([...g.matchAll(/^M620 S(\d+)/gm)].map((m) => +m[1] + 1))].filter((t) => t !== 256) : [];   // S255 = unload
    const want = proj.plates[k - 1].filaments;
    if (g && g.length > 1000 && (tools.length ? tools.join() === want.join() : want.join() === '1')) good++;
    else console.log(`     plate ${k} ${proj.plates[k - 1].name}: ${g ? 'filament ' + tools.join() + ' want ' + want.join() : 'no G-code'}`);
  }
  return check(res.return_code === 0 && good === proj.plates.length, `${tag}: slicer return ${res.return_code}, ${good} of ${proj.plates.length} plates sliced on their own filament`);
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: (process.env.CHROME_ARGS || '').split(' ').filter(Boolean) });   // CHROME_ARGS=--disable-gpu: like a runner without GPU
const errors = [];
// Phone (test_site.mjs <where> phone): 390 x 844, touch, mobile user agent, CPU 4x slower, as a phone would load it.
// No sideways scrolling, every control at least 44 px to tap (links inside sentences excepted), one finger turns the
// 3D view and two pinch it, plate tabs leave the view free, set 11926 builds and downloads (10696 too unless
// QUICK_SETS), and a set too big for the phone's memory is refused in words.
async function phoneChecks() {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, acceptDownloads: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36' });
  const page = await ctx.newPage(), cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  page.on('pageerror', (e) => errors.push('phone page: ' + e.message));
  page.on('crash', () => errors.push('phone tab crashed'));
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => /sets, updated/.test(document.getElementById('datainfo').textContent), null, { timeout: 60000 });
  const layout = () => page.evaluate(() => {
    const small = [];
    for (const el of document.querySelectorAll('button, input, select, textarea, a[href]')) {
      if (!el.checkVisibility() || (el.tagName === 'A' && el.closest('p'))) continue;   // a link inside a sentence is sized by the text
      const r = (el.closest('label') || el).getBoundingClientRect();
      if (r.width < 44 || r.height < 44) small.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''} "${(el.textContent || el.value || '').trim().slice(0, 14)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    return { overflow: document.documentElement.scrollWidth - innerWidth, small: [...new Set(small)] };
  });
  let l = await layout();
  check(l.overflow <= 0, `phone: no sideways scrolling (${l.overflow} px over)`);
  check(!l.small.length, `phone: every control at least 44 px to tap (${l.small.length} smaller${l.small.length ? ': ' + l.small.slice(0, 6).join(', ') : ''})`);
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i })) });
  for (const sn of process.env.QUICK_SETS ? ['11926-1'] : ['11926-1', '10696-1']) {
    await page.fill('#setnum', sn);
    const t0 = Date.now();
    await page.click('#go');
    await page.waitForFunction(() => !document.getElementById('go').disabled, null, { timeout: 30 * 60000, polling: 1000 });
    const st = (await page.textContent('#status')).trim(), plates = await page.locator('#platetabs button').count();
    check(/^Done/.test(st) && plates > 0, `phone: set ${sn} builds in ${((Date.now() - t0) / 1000).toFixed(0)} s: "${st}"`);
    const canvas = page.locator('#viewport canvas');
    await canvas.scrollIntoViewIfNeeded();
    const b = await canvas.boundingBox(), cx = b.x + b.width / 2, cy = b.y + b.height / 2;
    check(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName === 'CANVAS', [cx, cy]), `phone: set ${sn}'s ${plates} plate tabs leave the middle of the 3D view free to touch`);
    const s0 = await canvas.screenshot();
    await touch('touchStart', [[cx, cy]]); for (let k = 1; k <= 8; k++) await touch('touchMove', [[cx + k * 12, cy + k * 3]]); await touch('touchEnd', []);
    await page.waitForTimeout(1200);
    const s1 = await canvas.screenshot();
    await touch('touchStart', [[cx - 30, cy], [cx + 30, cy]]); for (let k = 1; k <= 8; k++) await touch('touchMove', [[cx - 30 - k * 8, cy], [cx + 30 + k * 8, cy]]); await touch('touchEnd', []);
    await page.waitForTimeout(1200);
    const s2 = await canvas.screenshot();
    check(Buffer.compare(s0, s1) !== 0 && Buffer.compare(s1, s2) !== 0, `phone: one finger turns the 3D view, two fingers zoom it (set ${sn})`);
    const dl = await Promise.all([page.waitForEvent('download', { timeout: 300000 }), page.click('#dl')]).then(([d]) => d, () => null);
    check(!!dl, `phone: set ${sn} downloads (${dl ? dl.suggestedFilename() : 'no download'})`);
  }
  l = await layout();
  check(l.overflow <= 0 && !l.small.length, `phone, after building: no sideways scrolling (${l.overflow} px), every control 44 px (${l.small.length} smaller${l.small.length ? ': ' + l.small.slice(0, 4).join(', ') : ''})`);
  // a phone that says it has little memory: a big set is refused in words, the tab stays alive
  const small = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const p3 = await small.newPage();
  await p3.addInitScript(() => Object.defineProperty(navigator, 'deviceMemory', { get: () => 0.25 }));
  let crashed = false; p3.on('crash', () => { crashed = true; });
  await p3.goto(url, { waitUntil: 'load' });
  await p3.waitForFunction(() => /sets, updated/.test(document.getElementById('datainfo').textContent), null, { timeout: 60000 });
  const bigSet = process.env.QUICK_SETS ? '11926-1' : '11374-1';   // on the runner the small set, refused all the same at 0.25 GB
  await p3.fill('#setnum', bigSet); await p3.click('#go');
  await p3.waitForFunction(() => !document.getElementById('go').disabled, null, { timeout: 30 * 60000, polling: 1000 }).catch(() => {});
  const st3 = crashed ? 'tab crashed' : (await p3.textContent('#status')).trim();
  check(/too big for this device/i.test(st3), `phone with 0.25 GB: set ${bigSet} refused in words ("${st3.slice(0, 140)}")`);
  await small.close(); await ctx.close();
}
const unstamped = new Set();   // the publish step adds ?v=<commit> to the site's own files so a visitor never mixes versions
try {
  if (MODE === 'phone') await phoneChecks(); else {
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  // LDraw's loader tries each folder (parts/, p/, models/, the root) and expects 404s; the browser's own favicon request is not the page's
  const probe = (u) => /\/ldraw\/.*\.dat$/i.test(u) || /\/favicon\.ico$/.test(u);
  page.on('console', (m) => { if (m.type() === 'error' && !(/Failed to load resource/.test(m.text()) && probe(m.location().url))) errors.push(`console: ${m.text()} ${m.location().url || ''}`); });
  page.on('pageerror', (e) => errors.push('page: ' + e.message));
  page.on('requestfailed', (r) => errors.push(`request failed: ${r.url()} ${r.failure()?.errorText}`));
  page.on('request', (r) => { const u = new URL(r.url()); if (where !== 'local' && r.url().startsWith(url) && /\.(js|json)$/.test(u.pathname) && !u.pathname.includes('/vendor/') && !u.searchParams.get('v')) unstamped.add(u.pathname); });
  page.on('response', (r) => { if (r.status() >= 400 && !probe(r.url())) errors.push(`HTTP ${r.status()}: ${r.url()}`); });
  const text = (sel) => page.textContent(sel).then((t) => t.trim());
  const view = () => page.locator('#viewport canvas').screenshot();
  const differ = (a, b) => Buffer.compare(a, b) !== 0;

  async function build(pg = page, limit = 20 * 60000) {
    const t0 = Date.now(), text = (sel) => pg.textContent(sel).then((t) => t.trim());
    await pg.click('#go');
    // build() disables the button until it ends
    await pg.waitForFunction(() => !document.getElementById('go').disabled, null, { timeout: limit, polling: 500 });
    const r = { s: (Date.now() - t0) / 1000, status: await text('#status'), tabs: await pg.locator('#platetabs button').count(), dl: await pg.isVisible('#dl') };
    for (const k of ['parts', 'unique', 'colours', 'plates', 'missing']) r[k] = +(await text('#s-' + k));
    r.rows = await pg.$$eval('#rows tr', (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent.trim())));
    console.log(`     "${r.status}" in ${r.s.toFixed(1)} s: ${r.parts} pieces, ${r.unique} unique, ${r.colours} colours, ${r.plates} plates, ${r.tabs} tabs, ${r.missing} missing`);
    return r;
  }
  async function download(tag) {
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('#dl')]);
    const file = path.join(OUT, tag + '-' + dl.suggestedFilename());
    await dl.saveAs(file);
    const proj = await readProject(file);
    console.log(`     ${path.basename(file)}: ${fs.statSync(file).size} bytes, plates ${proj.plates.map((p) => `${p.name} (${p.objects})`).join(', ')}`);
    return { file, proj };
  }

  // 1. page load
  await page.goto(url, { waitUntil: 'load' });
  const info = await page.waitForFunction(() => /sets, updated/.test(document.getElementById('datainfo').textContent), null, { timeout: 30000 }).then(() => true, () => false);
  check(info, 'page loads with the set list (' + (await text('#datainfo')) + ')');
  const box = await page.locator('#viewport canvas').boundingBox();
  check(box && box.width > 200 && box.height > 200, `3D view canvas ${box ? Math.round(box.width) + 'x' + Math.round(box.height) : 'missing'}`);
  check(await page.isVisible('#viewnote') && /256 × 256/.test(await text('#viewnote')), 'empty-plate note shown');
  await page.waitForTimeout(500);
  const empty = await view();

  // the page's longest main-thread block: while one runs, the page can't scroll, click or redraw
  await page.evaluate(() => { window.__longest = 0; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__longest = Math.max(window.__longest, e.duration); }).observe({ type: 'longtask' }); });

  // 2. suggestions while typing
  await page.fill('#setnum', 'wooden minif');
  await page.dispatchEvent('#setnum', 'input');
  const sug = await page.waitForFunction((s) => [...document.querySelectorAll('#setlist option')].some((o) => o.value === s), SET, { timeout: 10000 }).then(() => true, () => false);
  check(sug, `typing a name suggests ${SET} (${await page.locator('#setlist option').count()} suggestions)`);

  // 3. a set by number, default options
  console.log(`-- set ${SET} by number`);
  await page.fill('#setnum', SET);
  const a = await build();
  const frozen = await page.evaluate(() => window.__longest);
  check(frozen < 1000, `page stays responsive while building: longest freeze ${Math.round(frozen)} ms (limit 1000)`);
  check(/^Done: \d+ plates/.test(a.status) && a.plates > 0 && a.missing === 0, 'set by number builds with every part found');
  check(a.parts === 29 && a.rows.length >= a.unique, `parts table: ${a.rows.length} rows, ${a.parts} pieces (want 29)`);
  check(!a.rows.some((r) => /failed|not in LDraw/.test(r[4])), 'no row reports a failed support check or missing part');
  check(a.tabs === a.plates && a.dl, 'one tab per plate and the download button shown');
  check(!(await page.isVisible('#viewnote')), 'empty-plate note hidden once plates are shown');
  await page.waitForTimeout(500);
  const first = await view();
  check(differ(empty, first), '3D view shows the first plate (differs from the empty bed)');
  await page.locator('#platetabs button').nth(1).click();
  await page.waitForTimeout(500);
  const second = await view();
  check(await page.locator('#platetabs button').nth(1).getAttribute('aria-pressed') === 'true' && differ(first, second), 'clicking the second plate tab selects it and changes the view');
  // the view is drawn only on change (no constant redraw): dragging must still turn it
  const cb = await page.locator('#viewport canvas').boundingBox();
  await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2); await page.mouse.down();
  await page.mouse.move(cb.x + cb.width / 2 + 150, cb.y + cb.height / 2 + 40, { steps: 8 }); await page.mouse.up();
  await page.waitForTimeout(800);
  check(differ(second, await view()), 'dragging the 3D view turns it');
  const A = await download('number');
  check(A.proj.plates.length === a.plates, `project has ${A.proj.plates.length} plates, page showed ${a.plates}`);
  check(A.proj.cfg.filament_colour.length === a.colours && A.proj.plates.every((p) => p.filaments.length === 1), `one filament per colour (${A.proj.cfg.filament_colour.join(' ')}), one per plate`);
  check(A.proj.cfg.layer_height === '0.2' && A.proj.cfg.enable_support === '0' && A.proj.scales.join() === '1', 'default settings: 0.2 mm layers, slicer supports off, scale 1');
  await slicedOk(A.file, A.proj, 'number');

  // 3b. a 32 x 32 baseplate (11023-1, part 3811: 295k triangles) must not freeze the page while it loads
  console.log('-- baseplate set 11023-1');
  await page.evaluate(() => { window.__longest = 0; });
  await page.fill('#setnum', '11023-1');
  const bp = await build();
  const bpFrozen = await page.evaluate(() => window.__longest);
  check(/^Done/.test(bp.status) && bp.parts === 1 && bp.missing === 0, 'baseplate set builds (the plate is reported too big for the bed)');
  check(bpFrozen < 1000, `page stays responsive while loading a baseplate: longest freeze ${Math.round(bpFrozen)} ms (limit 1000)`);

  // 3c. the set-number path on real sets of other sizes: plates, nothing failed to load, nothing reported missing
  // that the library has (2026-11-23: 11374 has 5 such rows, 10696 one; with the old GitHub mirror 41 and 1)
  for (const [sn, maxMissing] of [['10696-1', 1], ['11374-1', 6]]) {   // 10696: 98560 is not in the library
    console.log(`-- set ${sn}`);
    if (process.env.QUICK_SETS) {
      // The publish runner has no GPU and few cores (a full build of 11374 took over 20 min there): check what the big
      // sets add over 11926, that every row resolves to a file of the site's own library, the way the site's
      // loader does it (parts.js resolvePart). Full builds of these sets run on the PC (QUICK_SETS unset).
      const { resolvePart, setLibrary } = await import('../parts.js');
      setLibrary(url + 'ldraw/');
      const set = await fetch(`${url}data/sets/${sn.slice(0, 3)}.json`).then((x) => x.json()).then((x) => x[sn]);
      const rows = set.p.filter((x) => !x[3]);
      let missing = 0;
      for (const [part, , , , name] of rows) if (!(await resolvePart(part, name)).length) missing++;
      check(rows.length > 0 && missing <= maxMissing, `set ${sn} (parts resolved only): ${rows.length - missing} of ${rows.length} rows resolve in the site's library, ${missing} not in it (at most ${maxMissing})`);
      continue;
    }
    await page.fill('#setnum', sn);
    const r = await build();
    const failed = r.rows.filter((x) => /load failed|support check failed/.test(x[4])).length;
    check(/^Done/.test(r.status) && r.plates > 0 && r.tabs === r.plates && failed === 0 && r.missing <= maxMissing && r.dl,
      `set ${sn}: ${r.plates} plates from ${r.parts} pieces in ${r.s.toFixed(0)} s, ${r.missing} rows not in the library (at most ${maxMissing}), ${failed} failed`);
  }

  // 4. the same set by name
  console.log(`-- set by name "${SET_NAME}"`);
  await page.fill('#setnum', SET_NAME);
  const b = await build();
  check(/^Done/.test(b.status) && b.parts === a.parts && b.plates === a.plates, 'set by name finds the same set');

  // 5. pasted list with every option changed
  console.log('-- pasted list, bed 180, gap 4, 0.10 mm, scale 150 %, supports off');
  await page.click('#tab-list');
  check(await page.isVisible('#pane-list') && !(await page.isVisible('#pane-set')), 'list tab shows the list pane');
  await page.fill('#listtext', '3001,4,2\n3003,Yellow,4\n3020,0,1\n3001,Red,1');
  await page.fill('#bed', '180'); await page.dispatchEvent('#bed', 'change');
  check(/180 × 180/.test(await text('#viewnote')), 'empty-plate note follows the bed size: ' + (await text('#viewnote')));
  await page.fill('#gap', '4'); await page.selectOption('#layer', '0.1'); await page.fill('#scale', '150');
  await page.uncheck('#fins');
  const c = await build();
  check(/^Done/.test(c.status) && c.parts === 8 && c.unique === 3 && c.colours === 3, 'list merges 3001 red by number and by name; 3 colours');
  const C = await download('list');
  const rgb = C.proj.cfg.filament_colour.join(' ');
  check(['#C91A09', '#F2CD37', '#05131D'].every((h) => rgb.includes(h)), `colours red, yellow, black (${rgb})`);
  check(C.proj.cfg.layer_height === '0.1' && C.proj.cfg.printable_area?.join() === '0x0,180x0,180x180,0x180' && C.proj.scales.join() === '1.5', `options written: layer ${C.proj.cfg.layer_height}, bed ${C.proj.cfg.printable_area}, scale ${C.proj.scales}`);
  await slicedOk(C.file, C.proj, 'list');
  await page.fill('#bed', '256'); await page.dispatchEvent('#bed', 'change');
  await page.fill('#gap', '12'); await page.selectOption('#layer', '0.2'); await page.fill('#scale', '100'); await page.check('#fins');

  // 5b. a part LDraw lacks and one too big for the bed are reported, the rest still builds
  console.log('-- missing and too-big parts, bed 100');
  await page.fill('#bed', '100'); await page.uncheck('#fins');
  await page.fill('#listtext', '3001,4,1\n92438,4,1\nnotapart123,4,1');
  const m = await build();
  const rowOf = (id) => m.rows.find((r) => r[0] === id)?.[4] || '';
  check(m.missing === 1 && m.plates === 1 && /1 part\(s\) not in the library/.test(m.status) && /1 too big/.test(m.status), 'status names the missing and the too-big part');
  check(/not in LDraw/.test(rowOf('notapart123')) && /too big for a 100 mm bed/.test(rowOf('92438')), `rows: notapart123 "${rowOf('notapart123')}", 92438 "${rowOf('92438')}"`);
  await page.fill('#bed', '256'); await page.dispatchEvent('#bed', 'change'); await page.check('#fins');

  // 6. Rebrickable CSV upload, spares off then on
  console.log('-- CSV upload');
  const csv = path.join(OUT, 'list.csv');
  fs.writeFileSync(csv, 'Part,Color,Quantity,Is Spare\n3001,4,2,False\n3001,4,1,True\n3024,15,3,False\n');
  await page.setInputFiles('#file', csv);
  await page.waitForFunction(() => document.getElementById('listtext').value.includes('Is Spare'), null, { timeout: 5000 }).catch(() => {});
  const d = await build();
  check(d.parts === 5, `uploaded CSV without spares: ${d.parts} pieces (want 5)`);
  await page.check('#spares');
  const e = await build();
  check(e.parts === 6, `with spares: ${e.parts} pieces (want 6)`);
  await page.uncheck('#spares');

  // 6b. other list headers and quantities: BrickLink's "Item No" column, colour names; a 0 quantity is skipped
  await page.fill('#listtext', 'Item No,Color,Qty\n3001,Red,2\n3003,Yellow,0\n3024,White,3');
  const bl = await build();
  check(bl.parts === 5 && bl.unique === 2, `BrickLink header with colour names: ${bl.parts} pieces, ${bl.unique} parts (want 5, 2; the 0-quantity row skipped)`);
  await page.fill('#listtext', 'Item No,Color,Qty\n3001,5,2');
  const bln = await build();
  check(/BrickLink/.test(bln.status) && bln.parts === 0, `BrickLink colour numbers are refused with a reason: "${bln.status}"`);
  await page.fill('#listtext', 'Name,Amount\nBrick,2');
  const np = await build();
  check(/part column/i.test(np.status), `a header without a part column explains itself: "${np.status}"`);

  // 6c. typed numbers outside the inputs' limits are clamped, not replaced by the defaults
  await page.fill('#listtext', '3001,4,1');
  await page.fill('#bed', '50'); await page.fill('#scale', '10'); await page.fill('#gap', '0');
  await build();
  const CL = await download('clamp');
  check(CL.proj.cfg.printable_area?.join() === '0x0,100x0,100x100,0x100' && CL.proj.scales.join() === '0.5', `bed 50 -> ${CL.proj.cfg.printable_area?.[2] || 256}, scale 10% -> ${CL.proj.scales} (want 100x100, 0.5)`);
  check(await page.inputValue('#gap') === '2', `gap 0 shows as ${await page.inputValue('#gap')} (want the minimum, 2)`);
  await page.fill('#bed', '256'); await page.dispatchEvent('#bed', 'change'); await page.fill('#scale', '100'); await page.fill('#gap', '12');

  // 7. bad input says what to do
  await page.fill('#listtext', '');
  const bad = await build();
  check(/Paste a parts list/.test(bad.status), 'empty list explains itself');
  check(bad.plates === 0 && bad.parts === 0 && !bad.dl && !bad.rows.some((r) => r[0] === '3001'), `a failed build clears the last one's results (shows ${bad.parts} pieces, ${bad.plates} plates)`);
  await page.click('#tab-set');
  await page.fill('#setnum', 'zzqq no such set');
  check(/No set matches/.test((await build()).status), 'unknown set explains itself');

  // 8. fit test
  console.log('-- fit test');
  await page.click('[data-part="studs"][data-fit="tight"]');
  await page.click('[data-part="hollow"][data-fit="loose"]');
  check(/studs -0\.05 mm, underside -0\.05 mm/.test(await text('#fitnow')), 'fit reports adjust the settings: ' + (await text('#fitnow')));
  await page.click('#fit');
  await page.waitForFunction(() => /Fit test ready/.test(document.getElementById('status').textContent), null, { timeout: 60000 }).catch(() => {});
  const F = await download('fit');
  check(F.proj.plates.length === 1 && F.proj.plates[0].objects === 2 && F.proj.cfg.xy_contour_compensation === '-0.05' && F.proj.cfg.xy_hole_compensation === '-0.05', `fit-test plate: ${F.proj.plates[0]?.objects} objects, contour ${F.proj.cfg.xy_contour_compensation}, hole ${F.proj.cfg.xy_hole_compensation}`);
  await slicedOk(F.file, F.proj, 'fit');
  await page.click('#fitreset');
  check(/Not tested yet/.test(await text('#fitnow')), 'fit reset');
  // 9. a part/support worker that fails to load: the build still ends and says so, and the next build gets working workers
  console.log('-- broken support worker, then a second list');
  const p2 = await ctx.newPage();
  const broken = (route) => route.fulfill({ contentType: 'text/javascript', headers: { 'Cache-Control': 'no-store' }, body: 'throw new Error("test: broken support worker");' });
  await p2.route('**/site_worker.js*', broken);
  await p2.goto(url, { waitUntil: 'load' });
  await p2.click('#tab-list');
  const unfinished = (e) => ({ status: 'did not finish: ' + e.message.split('\n')[0], rows: [] });
  await p2.fill('#listtext', '3001,4,1\n3003,4,1');
  const w1 = await build(p2, 120000).catch(unfinished);
  check(/^Done/.test(w1.status) && w1.rows.length === 2 && w1.rows.every((r) => /failed/.test(r[4])) && /2 part\(s\) could not be downloaded/.test(w1.status) && !/not in the library/.test(w1.status), `broken worker: build ends, rows and status say why (${w1.status} | ${w1.rows.map((r) => r[4]).join(' | ')})`);
  await p2.unroute('**/site_worker.js*', broken);
  await p2.fill('#listtext', '3020,4,1\n3024,4,1');
  const w2 = await build(p2, 120000).catch(unfinished);
  check(/^Done/.test(w2.status) && w2.rows.length === 2 && !w2.rows.some((r) => /failed/.test(r[4])), `next build after the broken worker gets working ones (${w2.rows.map((r) => r[4]).join(' | ') || w2.status})`);
  await p2.close();

  // phone width: no sideways scrolling
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth);
  check(wide <= 390, `phone width 390 px: page is ${wide} px wide`);
  }
} catch (e) {
  check(false, 'test stopped: ' + e.message.split('\n')[0]);
} finally { await browser.close(); }
if (where !== 'local') check(!unstamped.size, unstamped.size ? 'unstamped site files: ' + [...unstamped].join(' ') : 'every site script and data file carries its version stamp');
check(!errors.length, errors.length ? `${errors.length} browser errors:\n  ` + errors.join('\n  ') : 'no browser errors');
console.log(failures.length ? `FAIL (${failures.length})` : 'PASS');
process.exit(failures.length ? 1 : 0);
