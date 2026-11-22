// Build a set's Bambu Studio project headless, the way the site does (parts -> supports -> plates -> .3mf),
// then optionally slice it with the Bambu Studio CLI and report every plate.
//   node audit/build_set.mjs <set number> <out dir> [--slice]   (LDraw library served on port 8767)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import './polyfill.mjs';
import JSZip from 'jszip';
import { setLibrary, loadPart } from '../parts.js';
import { autoSupport } from '../supports.js';
import { multiFilamentSettings, projectFile } from '../export3mf.js';
import { pack } from '../layout.js';
import { COLORS } from '../colors.js';

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '..');
const [setNum, out, flag] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
setLibrary('http://127.0.0.1:8767/');
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const sn = /-\d+$/.test(setNum) ? setNum : setNum + '-1';
const set = read(`data/sets/${sn.toLowerCase().slice(0, 3).replace(/[^a-z0-9]/g, '') || '_'}.json`)[sn];
if (!set) throw new Error('no set ' + sn);
const decisions = read('bambu/decisions.json');
const lines = set.p.filter((r) => !r[3]).map(([part, col, qty, , name]) => ({ part, name, colour: COLORS[col] ? { name: COLORS[col][0], rgb: COLORS[col][1] } : { name: String(col), rgb: '999999' }, qty }));
const geom = new Map();
for (const l of lines) {
  if (!geom.has(l.part)) {
    const t0 = Date.now(), g = await loadPart(l.part);
    geom.set(l.part, g && { name: g.name, mesh: decisions[g.name] === 'plain' ? g.mesh : autoSupport(g.mesh).mesh });
    if (process.env.VERBOSE) console.log(`${geom.size} ${l.part} ${Date.now() - t0} ms`);
  }
  l.geom = geom.get(l.part);
}
if (![...geom.values()].some(Boolean)) throw new Error('no part loaded: is the LDraw library served on port 8767?');
const byColour = new Map(), rgbs = [], plates = [];
for (const l of lines) if (l.geom) (byColour.get(l.colour.name) || byColour.set(l.colour.name, []).get(l.colour.name)).push(l);
for (const [colour, ls] of byColour) {
  rgbs.push(ls[0].colour.rgb);
  const items = ls.flatMap((l) => Array.from({ length: l.qty }, () => ({ line: l, w: l.geom.mesh.size[0], h: l.geom.mesh.size[1] })));
  pack(items, 256, 12).forEach((p, k) => plates.push({ name: `${colour} ${k + 1}`, filament: rgbs.length,
    items: p.map((it) => ({ key: it.line.geom.name, label: it.line.geom.name, mesh: it.line.geom.mesh, cx: it.cx, cy: it.cy })) }));
}
const settings = multiFilamentSettings(read('bambu/p1s-base.json'), read('bambu/filament-keys.json'), '0.2', rgbs);
const file = path.join(out, 'project.3mf');
fs.writeFileSync(file, await projectFile(JSZip, plates, settings));
fs.writeFileSync(path.join(out, 'plates.json'), JSON.stringify(plates.map((p) => ({ name: p.name, parts: [...new Set(p.items.map((i) => i.key))] }))));
console.log(`${sn}: ${lines.filter((l) => !l.geom).length} parts missing, ${plates.length} plates -> ${file}`);
if (flag === '--slice') {
  // One CLI run per plate, each killed after 180 s and counted as a failure: the CLI sometimes stalls at
  // start-up (one thread, under 1 s CPU, no log).
  let ok = 0;
  for (let k = 1; k <= plates.length; k++) {
    const dir = path.join(out, `plate${k}`);
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir);   // never read a stale result
    spawnSync('C:/Program Files/Bambu Studio/bambu-studio.exe', ['--slice', String(k), '--outputdir', dir, '--allow-newer-file', file], { stdio: 'ignore', timeout: 180000 });
    const rf = path.join(dir, 'result.json'), res = fs.existsSync(rf) ? JSON.parse(fs.readFileSync(rf, 'utf8')) : null;
    const g = fs.existsSync(path.join(dir, `plate_${k}.gcode`));
    if (res?.return_code === 0 && g) ok++;
    const w = (res?.sliced_plates || []).map((p) => p.warning_message).filter(Boolean).join(' / ');
    console.log(`plate ${k} ${plates[k - 1].name}: ${!res ? 'FAILED (no result in 180 s)' : res.return_code !== 0 ? 'FAILED ' + res.error_string : !g ? 'FAILED (no G-code)' : w || 'no warning'}`);
  }
  console.log(`slicer return: ${ok} of ${plates.length} plates sliced`);
}
process.exit(0);
