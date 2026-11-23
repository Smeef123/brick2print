// Rebuild bambu/decisions.json with no one in the loop: pick the audit parts (audit/pick_parts.py, Rebrickable's
// downloads), slice each one plain and with automatic supports (audit/run.mjs, Bambu Studio CLI, 180 s and 1.5 GB per
// slice), keep plain the parts where supports came out worse (audit/decisions.py). decisions.json is only replaced
// when the new list passes the checks below; the old one is kept beside it as decisions.prev.json.
//   node audit/refresh_decisions.mjs [parts.json] [decisions out]   (needs Bambu Studio, Python and the local LDraw
//   library; about 1-2 h for the full list; a short parts list and another output file make a trial run)
// DEPENDS on an audit/run.mjs that reads SLICERS, SLICER_MB and RESULTS from the environment. The run.mjs committed
// at 6646bd4 does not: it hard-codes 8 slicers and appends to audit/out/results.jsonl, skipping parts already listed
// there, so it can neither be held to one slicer nor give a fresh results file. This script refuses to start until
// that run.mjs is committed.
// Checks before replacing (numbers chosen from the 2026-11 reruns: 370 of 415 parts finished, the rest "not in
// LDraw", none crashed; the one real rerun, 57c50b7 -> 29b233d, dropped 4 of 20 decisions after a method change):
// at least one finished slice; at most 10% of rows crashed; the new list not empty; every entry "plain" and backed by
// a plain slice in this run that gave G-code; at most max(2, 25%) of the existing decisions disappear. A refused list
// is left as decisions.new.json to look at and copy by hand if it is right. test_project.mjs is not run: it never
// reads decisions.json, and every "plain" entry is a part whose plain slice is checked above.
// An empty list is always refused: decisions.json has had 20-24 entries; to clear it, edit it by hand.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
const ROOT = path.join(HERE, '..'), OUT = path.join(HERE, 'out');
const stamp = new Date().toISOString().slice(0, 10);
const [partsArg, outArg] = process.argv.slice(2);
const parts = partsArg ? path.resolve(partsArg) : path.join(OUT, `parts-${stamp}.json`), results = path.join(OUT, `results-${stamp}-${process.pid}.jsonl`);
const fail = (msg) => { console.log(`FAIL: ${msg}`); process.exit(1); };
const run = (what, cmd, args, opts = {}) => {
  console.log(`-- ${what}`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: ['ignore', opts.out ? 'pipe' : 'inherit', 'inherit'], encoding: 'utf8', maxBuffer: 1 << 28, ...opts });
  if (r.status !== 0) fail(`${what} (exit ${r.status}${r.error ? ', ' + r.error.message : ''})`);
  return r.stdout;
};
const runSrc = fs.readFileSync(path.join(HERE, 'run.mjs'), 'utf8');
if (!['SLICERS', 'SLICER_MB', 'RESULTS'].every((k) => runSrc.includes(`process.env.${k}`)))
  fail('audit/run.mjs does not read the SLICERS, SLICER_MB and RESULTS settings, so it would start 8 slicers at once and mix in old results. '
    + 'The run.mjs that reads them exists only as uncommitted work (2026-11-23); commit that version, then run this again. Nothing was changed.');
fs.mkdirSync(OUT, { recursive: true });
if (!fs.existsSync(parts)) fs.writeFileSync(parts, run('pick the parts', 'python', ['audit/pick_parts.py'], { out: true }));
run('slice every part plain and supported', process.execPath, ['audit/run.mjs', parts],
  { env: { ...process.env, SLICERS: process.env.SLICERS || '1', SLICER_MB: '1500', RESULTS: results } });
const rows = fs.existsSync(results) ? fs.readFileSync(results, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)) : [];
const done = rows.filter((r) => r.status === 'done').length, crashed = rows.filter((r) => r.status === 'crash').length;
console.log(`results: ${rows.length} parts, ${done} sliced, ${crashed} crashed`);
if (!done) fail(`no part finished slicing (${rows.length} rows in ${results}); decisions.json not touched`);
if (crashed > 0.1 * rows.length) fail(`${crashed} of ${rows.length} parts crashed (limit 10%); decisions.json not touched`);
const fresh = run('decide which parts print plain', 'python', ['audit/decisions.py', results], { out: true });
const now = JSON.parse(fresh);   // must be JSON before it replaces anything
const file = outArg ? path.resolve(outArg) : path.join(ROOT, 'bambu', 'decisions.json'), prev = file.replace(/\.json$/, '.prev.json');
const old = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
const added = Object.keys(now).filter((k) => !(k in old)), dropped = Object.keys(old).filter((k) => !(k in now));
// each "plain" must rest on a plain slice that gave G-code in this run (decisions.py's rule, checked here again)
const slicedPlain = new Set(rows.filter((r) => r.status === 'done' && r.off?.rc === 0).map((r) => r.ldraw));
const odd = Object.entries(now).filter(([k, v]) => v !== 'plain' || !slicedPlain.has(k)).map(([k]) => k);
const maxDrop = Math.max(2, Math.floor(0.25 * Object.keys(old).length));
if (!Object.keys(now).length || odd.length || dropped.length > maxDrop) {
  const kept = file.replace(/\.json$/, '.new.json');
  fs.writeFileSync(kept, fresh);
  fail((!Object.keys(now).length ? 'the new list is empty' : odd.length ? `not "plain" or without a plain slice that gave G-code: ${odd.join(' ')}` : `${dropped.length} of ${Object.keys(old).length} existing decisions would disappear (limit ${maxDrop}): ${dropped.join(' ')}`)
    + `. ${path.relative(ROOT, file)} not touched; the new list is in ${path.relative(ROOT, kept)} to check and copy by hand if it is right`);
}
if (fs.existsSync(file)) fs.copyFileSync(file, prev);
fs.writeFileSync(file, fresh);
console.log(`decisions.json: ${Object.keys(now).length} parts print plain; added ${added.join(' ') || 'none'}; dropped ${dropped.join(' ') || 'none'}`);
console.log('PASS');
