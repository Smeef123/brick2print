// Rebuild bambu/decisions.json with no one in the loop: pick the audit parts (audit/pick_parts.py, Rebrickable's
// downloads), slice each one plain and with automatic supports (audit/run.mjs, Bambu Studio CLI, 180 s and 1.5 GB per
// slice), keep plain the parts where supports came out worse (audit/decisions.py), then run audit/test_project.mjs.
// decisions.json is only replaced when every step worked; the old one is kept beside it as decisions.prev.json.
//   node audit/refresh_decisions.mjs [parts.json] [decisions out]   (needs Bambu Studio, Python and the local LDraw
//   library; about 1-2 h for the full list; a short parts list and another output file make a trial run)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
const ROOT = path.join(HERE, '..'), OUT = path.join(HERE, 'out');
const stamp = new Date().toISOString().slice(0, 10);
const [partsArg, outArg] = process.argv.slice(2);
const parts = partsArg ? path.resolve(partsArg) : path.join(OUT, `parts-${stamp}.json`), results = path.join(OUT, `results-${stamp}-${process.pid}.jsonl`);
const run = (what, cmd, args, opts = {}) => {
  console.log(`-- ${what}`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: ['ignore', opts.out ? 'pipe' : 'inherit', 'inherit'], encoding: 'utf8', maxBuffer: 1 << 28, ...opts });
  if (r.status !== 0) { console.log(`FAIL: ${what} (exit ${r.status}${r.error ? ', ' + r.error.message : ''})`); process.exit(1); }
  return r.stdout;
};
fs.mkdirSync(OUT, { recursive: true });
// run.mjs must take the one-slicer limit and the results file from the environment (2026-11-23 working copy): an
// older run.mjs ignores them and starts half the cores' worth of slicers
if (!/process\.env\.RESULTS/.test(fs.readFileSync(path.join(HERE, 'run.mjs'), 'utf8')) || !/SLICER_MB/.test(fs.readFileSync(path.join(HERE, 'run.mjs'), 'utf8'))) { console.log('FAIL: audit/run.mjs lacks the SLICERS/SLICER_MB/RESULTS settings'); process.exit(1); }
if (!fs.existsSync(parts)) fs.writeFileSync(parts, run('pick the parts', 'python', ['audit/pick_parts.py'], { out: true }));
run('slice every part plain and supported', process.execPath, ['audit/run.mjs', parts],
  { env: { ...process.env, SLICERS: process.env.SLICERS || '1', SLICER_MB: '1500', RESULTS: results } });
const fresh = run('decide which parts print plain', 'python', ['audit/decisions.py', results], { out: true });
JSON.parse(fresh);   // must be JSON before it replaces anything
const file = outArg ? path.resolve(outArg) : path.join(ROOT, 'bambu', 'decisions.json'), prev = file.replace(/\.json$/, '.prev.json');
if (!fs.existsSync(file)) fs.writeFileSync(file, '{}');
const old = JSON.parse(fs.readFileSync(file, 'utf8')), now = JSON.parse(fresh);
fs.copyFileSync(file, prev);
fs.writeFileSync(file, fresh);
const out = run('check a project still slices', process.execPath, ['audit/test_project.mjs'], { out: true });
if (!/^PASS$/m.test(out)) { fs.copyFileSync(prev, file); console.log(out + '\nFAIL: test_project, decisions.json put back'); process.exit(1); }
const added = Object.keys(now).filter((k) => !(k in old)), dropped = Object.keys(old).filter((k) => !(k in now));
console.log(`decisions.json: ${Object.keys(now).length} parts print plain; added ${added.join(' ') || 'none'}; dropped ${dropped.join(' ') || 'none'}`);
console.log('PASS');
