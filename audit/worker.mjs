// Audit worker thread: the CPU-heavy steps, so the main process only schedules.
//   decide: load a part, choose pose and supports, write off.3mf / on.3mf
//   stats:  read a sliced 3MF and measure mid-air area from its G-code
import fs from 'node:fs';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import './polyfill.mjs';
import JSZip from 'jszip';
import { setLibrary, loadPart } from '../parts.js';
import { autoSupport } from '../supports.js';
import { settingsJson, write3mf } from '../export3mf.js';

setLibrary(workerData.lib);
const settings = settingsJson(JSON.parse(fs.readFileSync(workerData.base, 'utf8')), '0.2', 'C91A09');

async function plate3mf(file, mesh, label) {
  const zip = new JSZip();
  await write3mf(JSZip, zip, 'p.3mf', [{ label, mesh }], [{ obj: 1, cx: 128, cy: 128 }], 1, settings);
  fs.writeFileSync(file, await zip.file('p.3mf').async('nodebuffer'));
}

async function decide(p, dir) {
  const row = { part: p.part, name: p.name, category: p.category, uses: p.uses };
  const t0 = Date.now();
  const g = await loadPart(p.part).catch((e) => ({ error: e.message }));
  if (!g || g.error) return { ...row, status: 'not in LDraw', error: g && g.error };
  row.ldraw = g.name;
  let s;
  try { s = autoSupport(g.mesh); } catch (e) { return { ...row, status: 'support error', error: e.message }; }
  Object.assign(row, { decision: s.note, pose: s.pose, pillars: s.pillars || 0, fins: s.fins || 0, ruleBefore: s.before, ruleAfter: s.after, decideMs: Date.now() - t0 });
  fs.mkdirSync(dir, { recursive: true });
  await plate3mf(path.join(dir, 'off.3mf'), g.mesh, g.name);
  await plate3mf(path.join(dir, 'on.3mf'), s.mesh, g.name);
  return { ...row, status: 'ready' };
}

async function stats(dir) {
  let gcode = '';
  try { const z = await JSZip.loadAsync(fs.readFileSync(path.join(dir, 's.3mf'))); gcode = await z.file('Metadata/plate_1.gcode').async('string'); } catch {}
  return gcodeStats(gcode);
}

// Mid-air starts from real G-code: extrusions rasterised at 0.1 mm with a 0.42 mm line. A region
// counts when it overlaps nothing in the layer below nor the one below that (one-layer support gap allowed).
function gcodeStats(text) {
  if (!text) return { midair: null, minutes: null };
  const G = 0.1, R = Math.round(0.21 / G), layers = [];
  let cur = null, x = null, y = null, feat = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('; CHANGE_LAYER')) { cur = []; layers.push(cur); continue; }
    if (line.startsWith('; FEATURE:')) { feat = line.slice(10).trim(); continue; }
    if (!cur || !(line.startsWith('G1') || line.startsWith('G0') || line.startsWith('G2') || line.startsWith('G3'))) continue;
    const mx = /X(-?[\d.]+)/.exec(line), my = /Y(-?[\d.]+)/.exec(line), me = / E([\d.]+)/.exec(line);
    const nx = mx ? +mx[1] : x, ny = my ? +my[1] : y;
    if (me && x !== null && feat !== 'Custom' && feat !== 'Prime tower') cur.push(x, y, nx, ny);
    x = nx; y = ny;
  }
  const key = (i, j) => i * 100000 + j;
  const raster = (segs) => {
    const s = new Set();
    for (let k = 0; k < segs.length; k += 4) {
      const [x1, y1, x2, y2] = [segs[k], segs[k + 1], segs[k + 2], segs[k + 3]];
      const n = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / (G / 2)));
      for (let q = 0; q <= n; q++) {
        const ci = Math.round((x1 + (x2 - x1) * q / n) / G), cj = Math.round((y1 + (y2 - y1) * q / n) / G);
        for (let a = -R; a <= R; a++) for (let b = -R; b <= R; b++) if (a * a + b * b <= R * R) s.add(key(ci + a, cj + b));
      }
    }
    return s;
  };
  let prev = null, prev2 = new Set(), mid = 0;
  for (const L of layers) {
    const occ = raster(L);
    if (prev) {
      const seen = new Set();
      for (const c of occ) {
        if (seen.has(c)) continue;
        const stack = [c], comp = []; seen.add(c); let touch = false;
        while (stack.length) {
          const p = stack.pop(); comp.push(p);
          if (prev.has(p) || prev2.has(p)) touch = true;
          for (const d of [100000, -100000, 1, -1]) { const q = p + d; if (occ.has(q) && !seen.has(q)) { seen.add(q); stack.push(q); } }
        }
        if (!touch) mid += comp.length * G * G;
      }
    }
    prev2 = prev || new Set(); prev = occ;
  }
  const t = /total estimated time: (?:(\d+)h )?(?:(\d+)m )?(\d+)s/.exec(text);
  return { midair: Math.round(mid * 10) / 10, minutes: t ? Math.round(((+t[1] || 0) * 3600 + (+t[2] || 0) * 60 + +t[3]) / 6) / 10 : null };
}

parentPort.on('message', async ({ id, kind, arg }) => {
  try { parentPort.postMessage({ id, ok: kind === 'decide' ? await decide(arg.part, arg.dir) : await stats(arg.dir) }); }
  catch (e) { parentPort.postMessage({ id, err: String((e && e.stack) || e) }); }
});
