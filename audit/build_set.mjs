// Build a set's Bambu Studio project headless, the way the site does (parts -> supports -> plates -> .3mf),
// then optionally slice it with the Bambu Studio CLI and report every plate.
//   node audit/build_set.mjs <set number> <out dir> [--slice [repeats=3]]   (serves the local LDraw library itself)
import fs from 'node:fs';
import path from 'node:path';
import './polyfill.mjs';
import JSZip from 'jszip';
import { loadPart } from '../parts.js';
import { useLocalLibrary } from './ldraw.mjs';
import { sliceProject } from './slice_project.mjs';
import { autoSupport } from '../supports.js';
import { multiFilamentSettings, projectFile } from '../export3mf.js';
import { pack } from '../layout.js';
import { COLORS } from '../colors.js';

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '..');
const [setNum, out, flag] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
await useLocalLibrary();
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
if (![...geom.values()].some(Boolean)) throw new Error('no part loaded: check the LDraw library (audit/ldraw.mjs)');
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
if (flag === '--slice') await sliceProject(file, out, +(process.argv[5] || 3));   // median of 3 slices per plate
process.exit(0);
