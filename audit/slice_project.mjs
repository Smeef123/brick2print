// Slice every plate of a Set2Print project with the Bambu Studio CLI, `repeats` times, and report per plate the
// median mid-air area from the G-code (audit/gcode.mjs) with its spread, print time and the slicer's warning.
//   node audit/slice_project.mjs <project.3mf> <out dir> [repeats=3]
// One CLI run per plate and repeat, killed after 180 s and counted as a failure: the CLI sometimes stalls at
// start-up (one thread, under 1 s CPU, no log). Clean = sliced and median mid-air under 0.5 mm2.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import JSZip from 'jszip';
import { gcodeStats } from './gcode.mjs';

const BAMBU = 'C:/Program Files/Bambu Studio/bambu-studio.exe';
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

export async function sliceProject(file, out, repeats = 3) {
  const cfg = await (await JSZip.loadAsync(fs.readFileSync(file))).file('Metadata/model_settings.config').async('string');
  const names = [...cfg.matchAll(/key="plater_name" value="([^"]*)"/g)].map((m) => m[1]);
  const rows = [];
  for (let k = 1; k <= names.length; k++) {
    const runs = [];
    let warning = '';
    for (let r = 0; r < repeats; r++) {
      const dir = path.join(out, `plate${k}-${r}`);
      fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });   // never read a stale result
      spawnSync(BAMBU, ['--slice', String(k), '--outputdir', dir, '--allow-newer-file', file], { stdio: 'ignore', timeout: 180000 });
      const rf = path.join(dir, 'result.json'), gf = path.join(dir, `plate_${k}.gcode`);
      const res = fs.existsSync(rf) ? JSON.parse(fs.readFileSync(rf, 'utf8')) : null;
      if (res?.return_code !== 0 || !fs.existsSync(gf)) { runs.push(null); continue; }
      warning = (res.sliced_plates || []).map((p) => p.warning_message).filter(Boolean).join(' / ') || warning;
      runs.push(gcodeStats(fs.readFileSync(gf, 'utf8')));
      fs.rmSync(gf);   // G-code is large; the numbers are kept
    }
    const ok = runs.filter(Boolean), mids = ok.map((s) => s.midair);
    const row = { plate: k, name: names[k - 1], sliced: ok.length, of: repeats, midair: ok.length ? median(mids) : null,
      spread: ok.length ? [Math.min(...mids), Math.max(...mids)] : null, minutes: ok.length ? median(ok.map((s) => s.minutes)) : null, warning };
    row.clean = ok.length === repeats && row.midair < 0.5;
    rows.push(row);
    console.log(`plate ${k} ${row.name}: ${ok.length}/${repeats} sliced, mid-air ${row.midair} mm2 (${row.spread?.join('-')}), ${row.minutes} min${warning ? ' | ' + warning : ''}`);
  }
  const clean = rows.filter((r) => r.clean).length;
  console.log(`clean ${clean} of ${rows.length} plates; total median mid-air ${rows.reduce((a, r) => a + (r.midair || 0), 0).toFixed(1)} mm2; ${rows.reduce((a, r) => a + (r.minutes || 0), 0).toFixed(0)} min`);
  fs.writeFileSync(path.join(out, 'slices.json'), JSON.stringify(rows, null, 1));
  return rows;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'))) {
  const [file, out, n] = process.argv.slice(2);
  await sliceProject(file, out, +n || 3);
  process.exit(0);
}
