// Check the site itself in headless Chrome, every path a visitor uses, and slice what it downloads in the
// Bambu Studio CLI (every plate must get G-code, each on its own filament). Exits 1 on any failure.
//   node audit/test_site.mjs [local|<url>] [desktop|phone]   (FLAKY=0.05: local server answers 5% of library requests 503)
// local serves this checkout (or SITE_DIR, e.g. the publish workflow's _site) on a free 127.0.0.1 port (parallel runs don't collide), with ldraw/ from
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

// Failures on purpose (local server only): a fault answers matching paths with 404/503 (after `delay` ms), or never
// ('stall'), for `left` requests and counts its hits, so a check can prove its fault was really met.
const faults = [];
let url = where;
if (where === 'local') {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x/').pathname);
    const f = faults.find((x) => x.left > 0 && x.re.test(rel));
    if (f) { f.left--; f.hits++; if (f.mode !== 'stall') setTimeout(() => res.writeHead(f.mode).end(), f.delay); return; }
    let p = path.join(ROOT, rel);
    // a checkout has no ldraw/ (the publish workflow adds it): serve the local library in its place
    if (rel.startsWith('/ldraw/') && !fs.existsSync(path.join(ROOT, 'ldraw'))) p = path.join(LDRAW, rel.slice(7));
    // FLAKY=0.05: answer that share of library requests 503, as GitHub Pages does under a burst (88 times for set 11374 live)
    if (rel.startsWith('/ldraw/') && Math.random() < +(process.env.FLAKY || 0)) { res.writeHead(503).end(); return; }
    if (p.endsWith(path.sep) || p === ROOT) p = path.join(p, 'index.html');
    if (!(p.startsWith(ROOT) || p.startsWith(path.resolve(LDRAW))) || !fs.existsSync(p) || !fs.statSync(p).isFile()) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(p).pipe(res);
  });
  await new Promise((ok, no) => server.once('error', no).listen(0, '127.0.0.1', ok));
  server.unref();
  url = `http://127.0.0.1:${server.address().port}/`;
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
// QUICK_SETS); on a phone reporting 1 GB set 11926 still builds and downloads, set 10294 is refused up front in words, and a baseplate is refused by the exact check after loading.
// The publish step adds ?v=<commit> to the site's own files so a visitor never mixes versions: on the built site
// (SITE_DIR) or the live one, every site-relative script or data request must carry it, phone mode included.
const STAMPED = where !== 'local' || !!process.env.SITE_DIR, unstamped = new Set();
let stampedSeen = 0;
const watchStamps = (pg) => pg.on('request', (r) => {
  const u = new URL(r.url());
  if (!r.url().startsWith(url) || !/\.(js|json)$/.test(u.pathname) || u.pathname.includes('/vendor/')) return;
  if (u.searchParams.get('v')) stampedSeen++; else unstamped.add(u.pathname);
});
async function phoneChecks() {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, acceptDownloads: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36' });
  const page = await ctx.newPage(), cdp = await ctx.newCDPSession(page);
  watchStamps(page);
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
  // A phone that says how much memory it has (window.__dm GB, read on every call as navigator.deviceMemory is). Both
  // refusals: the up-front one from the parts list, and the exact one after loading. The small set must still build.
  const small = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, acceptDownloads: true });
  const p3 = await small.newPage();
  watchStamps(p3);
  await p3.addInitScript(() => Object.defineProperty(navigator, 'deviceMemory', { get: () => window.__dm ?? 1 }));
  let crashed = false; p3.on('crash', () => { crashed = true; });
  await p3.goto(url, { waitUntil: 'load' });
  await p3.waitForFunction(() => /sets, updated/.test(document.getElementById('datainfo').textContent), null, { timeout: 60000 });
  check(await p3.evaluate(() => navigator.deviceMemory) === 1, 'phone with 1 GB: the page sees deviceMemory 1');
  const mb = (st) => { const m = /needs about (\d+) MB of memory and this browser gives a page about (\d+) MB/.exec(st); return m ? { need: +m[1], have: +m[2] } : { need: 0, have: -1 }; };
  async function build3(dm, fill, press = '#go') {   // press: the one button that starts this build
    await p3.evaluate((d) => { window.__dm = d; }, dm);
    await fill(); await p3.click(press);
    await p3.waitForFunction(() => !document.getElementById('go').disabled, null, { timeout: 30 * 60000, polling: 1000 }).catch(() => {});
    const st = crashed ? 'tab crashed' : (await p3.textContent('#status')).trim();
    const rows = await p3.$$eval('#rows tr', (trs) => trs.map((tr) => tr.textContent));
    return { st, rows: rows.length, ready: rows.filter((t) => /ready/.test(t)).length, tabs: await p3.locator('#platetabs button').count(), anyway: await p3.isVisible('#anyway'), dl: await p3.isVisible('#dl'), ...mb(st) };
  }
  const bySet = (sn) => () => p3.fill('#setnum', sn);
  const a3 = await build3(1, bySet('11926-1'));
  const dl3 = /^Done/.test(a3.st) && await Promise.all([p3.waitForEvent('download', { timeout: 300000 }), p3.click('#dl')]).then(([d]) => d, () => null);
  check(!!dl3 && !/too big for this device/i.test(a3.st), `phone with 1 GB: set 11926-1 builds and downloads ("${a3.st.slice(0, 160)}", ${dl3 ? dl3.suggestedFilename() : 'no download'})`);
  const b3 = await build3(1, bySet('10294-1'));   // a big set: its row count is read from the page
  // the up-front refusal: no plates, Build anyway offered (not pressed: the set is too big to load in a test)
  check(/too big for this device/i.test(b3.st) && b3.need > b3.have && b3.have > 0 && b3.tabs === 0 && b3.ready === 0 && b3.anyway,
    `phone with 1 GB: set 10294-1 (${b3.rows} rows on the page) refused before loading, in words, Build anyway offered: ${b3.need} MB > ${b3.have} MB ("${b3.st.slice(0, 120)}")`);
  // The exact check: a 16 x 16 baseplate (3867) is one row on the list but, by guess (not measured), more mesh than a
  // row's average. A tiny device makes the up-front refusal state the list's estimate L; with exactly L MB for the
  // page the list passes, and only the check after loading can refuse it (plates shown: tabs > 0).
  const c0 = await build3(0.01, async () => { await p3.click('#tab-list'); await p3.fill('#listtext', '3867,4,1'); });
  check(c0.need > 0 && c0.ready === 0 && c0.tabs === 0 && c0.anyway, `phone: baseplate list refused up front on a tiny device, estimate ${c0.need} MB, Build anyway offered ("${c0.st.slice(0, 100)}")`);
  // Build anyway on the up-front refusal still stops at the exact check, which refuses too on this tiny device
  const c1 = await build3(0.01, async () => {}, '#anyway');
  check(/too big for this device/i.test(c1.st) && c1.tabs > 0 && c1.need > c1.have && c1.anyway && !c1.dl,
    `phone, Build anyway on the up-front refusal: loads, then the exact check refuses (${c1.tabs} plate tabs, ${c1.need} MB > ${c1.have} MB, "${c1.st.slice(0, 100)}")`);
  const c3 = await build3(c0.need / 512, async () => {});
  check(/too big for this device/i.test(c3.st) && c3.have === c0.need && c3.need > c3.have && c3.tabs > 0 && c3.anyway && !c3.dl,
    `phone with ${c0.need} MB for the page: baseplate refused after loading by the exact check, ${c3.need} MB > ${c3.have} MB, ${c3.tabs} plate tabs ("${c3.st.slice(0, 120)}")`);
  // Build anyway on the exact refusal writes the project
  const c4 = await build3(c0.need / 512, async () => {}, '#anyway');
  check(/^Done/.test(c4.st) && c4.dl && c4.tabs > 0, `phone, Build anyway on the exact refusal: "${c4.st.slice(0, 100)}", download ${c4.dl ? 'shown' : 'missing'}`);
  await small.close(); await ctx.close();
}
try {
  if (MODE === 'phone') await phoneChecks(); else {
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  // LDraw's loader tries each folder (parts/, p/, models/, the root) and expects 404s; the browser's own favicon request is not the page's
  // (with FLAKY the server's own 503s on the library are expected too: the page must ride them out, which the build checks prove)
  const probe = (u) => /\/ldraw\/.*\.dat$/i.test(u) || /\/favicon\.ico$/.test(u) || (!!process.env.FLAKY && /\/ldraw\//.test(u));
  page.on('console', (m) => { if (m.type() === 'error' && !(/Failed to load resource/.test(m.text()) && probe(m.location().url))) errors.push(`console: ${m.text()} ${m.location().url || ''}`); });
  page.on('pageerror', (e) => errors.push('page: ' + e.message));
  page.on('requestfailed', (r) => errors.push(`request failed: ${r.url()} ${r.failure()?.errorText}`));
  watchStamps(page);
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
  const loadedAt = Date.now();
  const info = await page.waitForFunction(() => /sets, updated/.test(document.getElementById('datainfo').textContent), null, { timeout: 30000 }).then(() => true, () => false);
  check(info, 'page loads with the set list (' + (await text('#datainfo')) + ')');
  const box = await page.locator('#viewport canvas').boundingBox();
  check(box && box.width > 200 && box.height > 200, `3D view canvas ${box ? Math.round(box.width) + 'x' + Math.round(box.height) : 'missing'}`);
  check(await page.isVisible('#viewnote') && /256 × 256/.test(await text('#viewnote')), 'empty-plate note shown');
  await page.waitForTimeout(500);
  const empty = await view();

  // the page's longest main-thread block: while one runs, the page can't scroll, click or redraw
  await page.evaluate(() => { window.__longest = 0; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__longest = Math.max(window.__longest, e.duration); }).observe({ type: 'longtask' }); });
  // without long-task reports both freeze checks below would read 0 and pass
  check(await page.evaluate(() => PerformanceObserver.supportedEntryTypes.includes('longtask')), 'the browser reports long tasks (needed by the freeze checks)');

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
  // Parts expected not to be in the library, by part number (2026-11-23: 10696 lacks 98560; 11374 lacks 4 parts in 5 rows,
  // checked absent from the LDraw library 2026-11-23)
  // EXPECT_BROKEN: rows reading "not printable" (the part's file is there, a piece it uses is not); none recorded.
  const EXPECT_MISSING = { '10696-1': ['98560'], '11374-1': ['10118867', '114913c01', '2752', '65151c02'] }, EXPECT_BROKEN = { '10696-1': [], '11374-1': [] };
  const namedOk = (list, label, sn, found, how) => {
    const f = [...new Set(found)].sort().join(' '), want = [...list[sn]].sort().join(' ');
    return check(f === want, `set ${sn}${how}: ${label} ${f || 'none'}, expected ${want || 'none'}${f !== want && !want ? ' (list not filled in yet: fill it from this first run)' : ''}`);
  };
  const missingOk = (sn, found, how) => namedOk(EXPECT_MISSING, 'not in the library', sn, found, how);
  for (const sn of ['10696-1', '11374-1']) {
    console.log(`-- set ${sn}`);
    if (process.env.QUICK_SETS) {
      // The publish runner has no GPU and few cores (a full build of 11374 took over 20 min there): check what the big
      // sets add over 11926, that every row resolves to a file of the site's own library, the way the site's
      // loader does it (parts.js resolvePart). Full builds of these sets run on the PC (QUICK_SETS unset).
      const { resolvePart, setLibrary } = await import('../parts.js');
      setLibrary(url + 'ldraw/');
      const set = await fetch(`${url}data/sets/${sn.slice(0, 3)}.json`).then((x) => x.json()).then((x) => x[sn]);
      const rows = set.p.filter((x) => !x[3]);
      const missing = [];
      for (const [part, , , , name] of rows) if (!(await resolvePart(part, name)).length) missing.push(part);
      check(rows.length > 0, `set ${sn}: ${rows.length} rows to resolve`);
      missingOk(sn, missing, ' (top file of each part resolved only)');
      continue;
    }
    await page.fill('#setnum', sn);
    const r = await build();
    const failed = r.rows.filter((x) => /load failed|support check failed/.test(x[4])).length;
    const gone = r.rows.filter((x) => /not in LDraw/.test(x[4])).map((x) => x[0]), broken = r.rows.filter((x) => /not printable/.test(x[4])).map((x) => x[0]);
    missingOk(sn, gone, '');
    namedOk(EXPECT_BROKEN, 'not printable (a piece missing from the library)', sn, broken, '');
    // the status counts each kind on its own; the "not found" tile (s-missing) holds both (app.js, 2026-11-23)
    const said = (re) => +(re.exec(r.status)?.[1] || 0), goneSaid = said(/(\d+) part\(s\) not in the library/), brokenSaid = said(/(\d+) part\(s\) not printable/);
    check(/^Done/.test(r.status) && r.plates > 0 && r.tabs === r.plates && failed === 0 && goneSaid === gone.length && brokenSaid === broken.length && r.missing === gone.length + broken.length && r.dl,
      `set ${sn}: ${r.plates} plates from ${r.parts} pieces in ${r.s.toFixed(0)} s, status says ${goneSaid} not in the library (${gone.length} rows) and ${brokenSaid} not printable (${broken.length} rows), "not found" tile ${r.missing}, ${failed} failed${failed ? ': ' + r.rows.filter((x) => /failed/.test(x[4])).slice(0, 2).map((x) => x[0] + ' ' + x[4]).join(' / ') : ''}`);
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

  // 10. failures on purpose: each check also proves its fault was met (hits), or it would pass on a healthy server.
  // Not here (covered without a browser): retries after a refusal spread out (test_fetch.mjs 1b).
  // the page's own load-failure timer, read from index.html: wait past it, then the message must still be hidden
  const failMs = +(/setTimeout\(fail, (\d+)\)/.exec(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'))?.[1] || 0);
  await page.waitForTimeout(Math.max(0, failMs + 1000 - (Date.now() - loadedAt)));
  check(failMs > 0 && Date.now() - loadedAt > failMs && await page.isHidden('#loadfail'), `normal load: no load-failure message ${Math.round((Date.now() - loadedAt) / 1000)} s after loading (its timer: ${failMs / 1000 || 'not found'} s)`);
  for (const how of ['blocked', 'stalled']) {
    const pg = await ctx.newPage();
    let met = 0;
    await pg.route('**/three.module.js', (route) => { met++; if (how === 'blocked') route.abort(); });   // stalled: never answered
    await pg.goto(url, { waitUntil: 'commit' });
    const shown = await pg.waitForSelector('#loadfail:not([hidden])', { timeout: failMs + 20000 }).then(() => true, () => false);
    check(met > 0 && shown, `three.module.js ${how} (${met} requests): the load-failure message shows`);
    await pg.close();
  }
  // a worker's three.js download fails once: the download retry absorbs it (the broken-worker path is tested below),
  // and the build still gives every part, none failed, no empty shape
  {
    let met = 0;
    const once3 = (route) => { if (met++ === 0) route.abort(); else route.continue(); };
    await ctx.route('**/three@*/+esm', once3);
    const pg = await ctx.newPage();
    await pg.goto(url, { waitUntil: 'load' });
    await pg.click('#tab-list'); await pg.fill('#listtext', '3001,4,1\n3003,4,1'); await pg.uncheck('#fins');
    const r = await build(pg, 180000).catch(unfinished);
    await ctx.unroute('**/three@*/+esm', once3);
    let empty = -1;
    if (r.dl) {
      const [d] = await Promise.all([pg.waitForEvent('download', { timeout: 60000 }), pg.click('#dl')]);
      const model = await (await JSZip.loadAsync(fs.readFileSync(await d.path()))).file('3D/3dmodel.model').async('string');
      const objs = model.split('<object ').slice(1).filter((o) => o.includes('<mesh>'));
      empty = objs.length ? objs.filter((o) => !o.includes('<triangle ')).length : -1;
    }
    check(met > 0 && /^Done/.test(r.status) && r.rows.length === 2 && !r.rows.some((x) => /failed/.test(x[4])) && empty === 0,
      `three.js blocked once for a worker (${met} requests): build "${r.status.slice(0, 60)}", rows ${r.rows.map((x) => x[4]).join(' | ')}, ${empty < 0 ? 'no shapes written' : empty + ' empty shapes'}`);
    await pg.close();
  }
  if (where !== 'local') console.log('skip server faults: they need the local server');
  else {
    const fault = (re, mode, left = Infinity, delay = 0) => { const f = { re, mode, left, delay, hits: 0 }; faults.push(f); return f; };
    const clear = (f) => faults.splice(faults.indexOf(f), 1);
    // oneWorker: the page sees 2 cores, so it starts one worker and every part shares its loader
    const fresh = async (list, fins, oneWorker = false) => {
      const pg = await ctx.newPage();
      if (oneWorker) await pg.addInitScript(() => Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 2 }));
      await pg.goto(url, { waitUntil: 'load' });
      await pg.waitForFunction(() => document.documentElement.dataset.ready === '1', null, { timeout: 60000 });
      await pg.click('#tab-list'); await pg.fill('#listtext', list);
      if (fins) await pg.check('#fins'); else await pg.uncheck('#fins');
      return pg;
    };
    const rowsSay = (r) => r.rows.map((x) => x[0] + ' ' + x[4]).join(' | ') || r.status;

    console.log('-- parts.js answers 503 three times');
    let f = fault(/^\/parts\.js$/, 503, 3);
    let pg = await fresh('3001,4,1', false);
    let r = await build(pg, 180000).catch(unfinished);
    clear(f);
    check(f.hits === 3 && /^Done/.test(r.status) && r.rows.length === 1 && !r.rows.some((x) => /failed/.test(x[4])), `parts.js 503 x${f.hits} then OK: still builds (${rowsSay(r)})`);
    await pg.close();

    // the same text is looked for both ways, so a reworded note fails "down" instead of passing "back"
    console.log('-- decisions.json down, then back');
    const NOTE = 'The list of parts checked in Bambu Studio could not be loaded';
    const notes = (st) => st.split(NOTE).length - 1;
    f = fault(/^\/bambu\/decisions\.json$/, 404);
    pg = await fresh('2852,4,1', true);   // 2852 is in decisions.json: prints plain
    r = await build(pg, 180000).catch(unfinished);
    clear(f);
    check(f.hits > 0 && /^Done/.test(r.status) && notes(r.status) === 1 && !/checked in Bambu Studio/.test(r.rows[0]?.[4] || ''), `decisions.json down (${f.hits} requests): the note shows ${notes(r.status)} time(s), 2852 not from the list (${rowsSay(r)})`);
    r = await build(pg, 180000).catch(unfinished);
    check(/^Done/.test(r.status) && notes(r.status) === 0 && /checked in Bambu Studio/.test(r.rows[0]?.[4] || ''), `decisions.json back: next build uses the list, note shown ${notes(r.status)} time(s) (${rowsSay(r)})`);
    // the GPU context lost and restored: the view is drawn again as it was
    const v0 = await pg.locator('#viewport canvas').screenshot();
    const lostOk = await pg.evaluate(async () => {
      const c = document.querySelector('#viewport canvas'), gl = c.getContext('webgl2') || c.getContext('webgl'), ext = gl?.getExtension('WEBGL_lose_context');
      if (!ext) return false;
      ext.loseContext(); await new Promise((ok) => setTimeout(ok, 300));
      const was = gl.isContextLost();
      ext.restoreContext(); await new Promise((ok) => setTimeout(ok, 1500));
      return was && !gl.isContextLost();
    });
    check(lostOk && !differ(v0, await pg.locator('#viewport canvas').screenshot()), `GPU context lost and restored (${lostOk ? 'happened' : 'not emulated'}): the view is drawn as before`);
    await pg.close();

    // one worker, so both parts share one loader; 3001's sub-file answers 404 late (1.5 s). Both orders: with 3001
    // first, 3003 can finish before the 404 lands; with 3003 first, 3001's failure lands while 3003 is still loading.
    for (const list of ['3001,4,1\n3003,4,1', '3003,4,1\n3001,4,1']) {
      const order = list.split('\n').map((x) => x.split(',')[0]).join(' then ');
      console.log(`-- two parts in one worker (${order}), 3001 with a sub-file missing`);
      f = fault(/\/3001s01\.dat$/i, 404, Infinity, 1500);
      pg = await fresh(list, false, true);
      const workers = [];
      pg.on('worker', (w) => workers.push(w));
      r = await build(pg, 180000).catch(unfinished);
      clear(f);
      const say = (id) => r.rows.find((x) => x[0] === id)?.[4] || '';
      check(f.hits > 0 && workers.length === 1 && /^Done/.test(r.status) && /not printable/.test(say('3001')) && !/not printable|failed|not in LDraw/.test(say('3003')),
        `sub-file of 3001 missing, ${order} (${f.hits} requests, ${workers.length} worker): only 3001 reads "not printable" (${rowsSay(r)})`);
      await pg.close();
    }

    // A worker goes away while it still has jobs: two workers (the page sees 3 cores, 8 GB); the second worker's
    // parts.js downloads fine but its import throws, so that worker reports itself broken and the page drops it while
    // support checks run on the other. The build must finish, the button come back, and no row stay waiting/loading.
    // (Placeholder for the page fixer's way to fail a worker's import after its download; swap it in here.)
    console.log('-- a worker goes away with jobs waiting');
    {
      let served = 0, bad = 0;
      const pg = await ctx.newPage();
      await pg.addInitScript(() => { Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 3 }); Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 }); });
      await pg.route('**/parts.js*', async (route) => {
        if (served++ !== 1) return route.continue();
        bad++;
        route.fulfill({ contentType: 'text/javascript', headers: { 'Cache-Control': 'no-store' }, body: 'throw new Error("test: import fails after download");' });
      });
      const workers = [];
      pg.on('worker', (w) => workers.push(w));
      await pg.goto(url, { waitUntil: 'load' });
      await pg.click('#tab-list'); await pg.fill('#listtext', '3040,4,1\n3665,4,1\n4286,4,1\n3001,4,1\n3003,4,1\n3020,4,1'); await pg.check('#fins');
      const r = await build(pg, 300000).catch(unfinished);
      const enabled = await pg.isEnabled('#go');
      const stuck = r.rows.filter((x) => /^(waiting|loading)$/.test(x[4])).length;
      check(bad === 1 && workers.length >= 2 && /^Done/.test(r.status) && enabled && r.rows.length === 6 && stuck === 0,
        `worker gone with jobs waiting (${workers.length} workers, ${bad} broken import): build "${r.status.slice(0, 60)}", button ${enabled ? 'enabled' : 'disabled'}, ${stuck} rows stuck (${r.rows.map((x) => x[0] + ' ' + x[4]).join(' | ')})`);
      await pg.close();
    }

    console.log('-- library refuses a burst');
    f = fault(/^\/ldraw\//, 503, 12);
    pg = await fresh('3004,4,1\n3005,4,1\n3010,4,1\n3622,4,1', false);
    r = await build(pg, 300000).catch(unfinished);
    clear(f);
    check(f.hits === 12 && /^Done/.test(r.status) && !r.rows.some((x) => /failed/.test(x[4])), `library 503 x${f.hits}: still builds (${rowsSay(r)})`);
    await pg.close();
  }

  // phone width: no sideways scrolling
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth);
  check(wide <= 390, `phone width 390 px: page is ${wide} px wide`);
  }
} catch (e) {
  check(false, 'test stopped: ' + e.message.split('\n')[0]);
} finally { await browser.close(); }
if (STAMPED) check(!unstamped.size && stampedSeen > 0, unstamped.size ? 'unstamped site files: ' + [...unstamped].join(' ') : `every site script and data file carries its version stamp (${stampedSeen} stamped requests)`);
else console.log('skip version stamps: a plain checkout is not stamped (set SITE_DIR to the built site)');
check(!errors.length, errors.length ? `${errors.length} browser errors:\n  ` + errors.join('\n  ') : 'no browser errors');
console.log(failures.length ? `FAIL (${failures.length})` : 'PASS');
process.exit(failures.length ? 1 : 0);
