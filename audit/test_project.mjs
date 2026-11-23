// Check: a multi-plate, multi-colour project from export3mf.projectFile slices in Bambu Studio,
// every plate gets G-code, each plate holds the right objects, and each uses its own filament.
//   node audit/test_project.mjs  (serves the local LDraw library itself)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import './polyfill.mjs';
import JSZip from 'jszip';
import { loadPart } from '../parts.js';
import { useLocalLibrary } from './ldraw.mjs';
import { projectFile, multiFilamentSettings } from '../export3mf.js';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
const OUT = path.join(ROOT, 'out', 'project-test');
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
await useLocalLibrary();
const base = JSON.parse(fs.readFileSync(path.join(ROOT, '..', 'bambu', 'p1s-base.json'), 'utf8'));
const keys = JSON.parse(fs.readFileSync(path.join(ROOT, '..', 'bambu', 'filament-keys.json'), 'utf8'));
const [b, p, s] = await Promise.all(['3001', '3020', '3005'].map(loadPart));
const it = (g, cx, cy) => ({ key: g.name, label: g.name, mesh: g.mesh, cx, cy });
// Studs and tubes where the part has them, also in parts built from grouped primitives (stug-*): those once
// came out with every stud and tube piled up mid-part. Stud tops span (studs - 1) x 8 + 5.0 mm; tubes cross
// the plate hollow 1.9 mm up.
let geomOk = true;
for (const [id, nx, ny] of [['3958', 6, 6], ['92438', 16, 8], ['3020', 4, 2]]) {
  const { verts: v, tris: t } = (await loadPart(id)).mesh;
  let top = -Infinity, x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, cross = 0;
  for (let k = 2; k < v.length; k += 3) top = Math.max(top, v[k]);
  for (let k = 0; k < v.length; k += 3) if (v[k + 2] > top - 1e-3) { x0 = Math.min(x0, v[k]); x1 = Math.max(x1, v[k]); y0 = Math.min(y0, v[k + 1]); y1 = Math.max(y1, v[k + 1]); }
  for (let k = 0; k < t.length; k += 3) { const z = [0, 1, 2].map((q) => v[t[k + q] * 3 + 2]); if (Math.min(...z) < 1.9 && Math.max(...z) > 1.9) cross++; }
  const want = [(nx - 1) * 8 + 5, (ny - 1) * 8 + 5], got = [x1 - x0, y1 - y0], tubes = cross > 500;
  const good = Math.abs(got[0] - want[0]) < 0.05 && Math.abs(got[1] - want[1]) < 0.05 && tubes;
  if (!good) geomOk = false;
  console.log(`${id}: stud tops span ${got.map((g) => g.toFixed(2)).join(' x ')} mm (want ${want.join(' x ')}), ${cross} faces cross the hollow at 1.9 mm ${good ? 'OK' : 'WRONG'}`);
}
const plates = [
  { name: 'Red 1', filament: 1, items: [it(b, 60, 60), it(b, 120, 60), it(p, 60, 120)] },
  { name: 'Blue 1', filament: 2, items: [it(b, 128, 128)] },
  { name: 'Yellow 1', filament: 3, items: [it(s, 60, 60), it(s, 100, 60), it(s, 140, 60), it(p, 100, 120)] },
  { name: 'Red 2', filament: 1, items: [it(p, 128, 128)] },
];
const settings = multiFilamentSettings(base, keys, '0.2', ['C91A09', '0055BF', 'F2CD37']);
fs.writeFileSync(path.join(OUT, 'project.3mf'), await projectFile(JSZip, plates, settings));
const r = spawnSync('C:/Program Files/Bambu Studio/bambu-studio.exe', ['--slice', '0', '--outputdir', OUT, '--export-3mf', 's.3mf', '--allow-newer-file', path.join(OUT, 'project.3mf')], { encoding: 'utf8', timeout: 180000 });   // the CLI can stall at start-up
if (!fs.existsSync(path.join(OUT, 'result.json'))) { console.log('FAIL: slicer gave no result within 180 s'); process.exit(1); }
const res = JSON.parse(fs.readFileSync(path.join(OUT, 'result.json'), 'utf8'));
console.log('slicer return', res.return_code, res.error_string || '', '| plates sliced', (res.sliced_plates || []).length);
const z = await JSZip.loadAsync(fs.readFileSync(path.join(OUT, 's.3mf')));
let ok = res.return_code === 0;
for (let k = 1; k <= plates.length; k++) {
  const g = await z.file(`Metadata/plate_${k}.gcode`)?.async('string');
  if (!g) { console.log(`plate ${k}: NO G-code`); ok = false; continue; }
  const tools = [...new Set([...g.matchAll(/^M620 S(\d+)/gm)].map((m) => +m[1] + 1))].filter((t) => t !== 256); // S255 = unload, not a filament
  // Bambu labels objects only when a plate has several; a lone object prints unlabelled
  const labelled = new Set([...g.matchAll(/^; start printing object, unique label id: (\d+)/gm)].map((m) => m[1])).size;
  const objs = labelled || (+(/total filament weight \[g\] : ([\d.]+)/.exec(g)?.[1] || 0) > 0 ? 1 : 0);
  const want = plates[k - 1];
  const good = tools.length === 1 && tools[0] === want.filament && objs === want.items.length;
  if (!good) ok = false;
  console.log(`plate ${k} "${want.name}": filament ${tools.join(',') || '?'} (want ${want.filament}), objects ${objs} (want ${want.items.length}) ${good ? 'OK' : 'WRONG'}`);
}
console.log(ok && geomOk ? 'PASS' : 'FAIL');
