// Set2Print audit: the picked parts through the site's own pipeline, then Bambu Studio.
//
//   node audit/run.mjs [parts.json]
//
// For each part a worker loads it, chooses pose and supports, and writes two one-part plates with
// the site's Lego settings: "off" = studs-up, no supports; "on" = what the site ships. Each is
// sliced REPEATS times by Bambu Studio's CLI and judged by the middle result: does it slice,
// Bambu's warnings, and the mid-air area measured from the G-code.
//
// SAFETY: the whole run shares ONE limit of MAX_SLICERS slicer processes, and a slicer only starts
// while at least MIN_FREE_GB of RAM is free. (Run 3 multiplied per-process limits into ~396
// slicers and crashed the PC, 2026-11-17.) Never start several copies of this script.
// Results stream to audit/out/results.jsonl.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
const OUT = path.join(ROOT, 'out');
const BAMBU = 'C:/Program Files/Bambu Studio/bambu-studio.exe';
const MAX_SLICERS = 8, MIN_FREE_GB = 6, WORKERS = 6, REPEATS = 3, PARTS_IN_FLIGHT = 8;
const partsFile = process.argv[2] || path.join(OUT, 'parts.json');
const resultsPath = path.join(OUT, 'results.jsonl');

// ---- worker pool ----
const idle = [], waiting = [], pending = new Map();
let nextId = 0;
for (let k = 0; k < WORKERS; k++) {
  const w = new Worker(new URL('./worker.mjs', import.meta.url), { workerData: { lib: 'http://127.0.0.1:8767/', base: path.join(ROOT, '..', 'bambu', 'p1s-base.json') } });
  w.on('message', ({ id, ok, err }) => { const p = pending.get(id); pending.delete(id); release(w); if (err) p.reject(new Error(err)); else p.resolve(ok); });
  idle.push(w);
}
function release(w) { const next = waiting.shift(); if (next) next(w); else idle.push(w); }
function run(kind, arg) {
  return new Promise((resolve, reject) => {
    const go = (w) => { const id = nextId++; pending.set(id, { resolve, reject }); w.postMessage({ id, kind, arg }); };
    const w = idle.pop();
    if (w) go(w); else waiting.push(go);
  });
}

// ---- the one slicer limit ----
let active = 0, peak = 0, minFree = Infinity;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function acquire() {
  for (;;) {
    const free = os.freemem() / 2 ** 30;
    minFree = Math.min(minFree, free);
    if (active < MAX_SLICERS && free >= MIN_FREE_GB) { active++; peak = Math.max(peak, active); return; }
    await sleep(1000);
  }
}
async function slice(file, dir) {
  fs.mkdirSync(dir, { recursive: true });
  await acquire();
  await new Promise((resolve) => {
    let ended = false;
    const end = () => { if (!ended) { ended = true; clearTimeout(timer); active--; resolve(); } };
    const p = spawn(BAMBU, ['--slice', '0', '--outputdir', dir, '--export-3mf', 's.3mf', '--allow-newer-file', '--arrange', '0', file], { stdio: 'ignore' });
    try { os.setPriority(p.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
    const timer = setTimeout(() => p.kill(), 180000);
    p.on('exit', end);
    p.on('error', end);
  });
  let res = { return_code: 'no result', error_string: 'slicer exited without a result', sliced_plates: [] };
  try { res = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8')); } catch {}
  const st = res.return_code === 0 ? await run('stats', { dir }) : { midair: null, minutes: null };
  return { rc: res.return_code, error: res.return_code === 0 ? '' : res.error_string, warnings: (res.sliced_plates || []).map((x) => x.warning_message).filter(Boolean), ...st };
}

function median(runs) {
  const ok = runs.filter((r) => r.rc === 0 && r.midair !== null).sort((a, b) => a.midair - b.midair);
  const list = runs.map((r) => (r.rc === 0 ? r.midair : 'fail'));
  if (ok.length * 2 <= runs.length) return { ...(runs.find((r) => r.rc !== 0) || runs[0]), runs: list };
  return { ...ok[Math.floor(ok.length / 2)], runs: list, warnings: [...new Set(runs.flatMap((r) => r.warnings))] };
}

async function audit(p) {
  const dir = path.join(OUT, 'work', p.part.replace(/[^a-z0-9_-]/gi, '_'));
  const row = await run('decide', { part: p, dir });
  if (row.status !== 'ready') return row;
  const many = (v) => Promise.all(Array.from({ length: REPEATS }, (_, k) => slice(path.join(dir, v + '.3mf'), path.join(dir, `${v}${k}`))));
  const [offs, ons] = await Promise.all([many('off'), many('on')]);
  return { ...row, off: median(offs), on: median(ons), status: 'done' };
}

const done = new Set();
if (fs.existsSync(resultsPath)) for (const l of fs.readFileSync(resultsPath, 'utf8').split('\n')) if (l.trim()) done.add(JSON.parse(l).part);
const parts = JSON.parse(fs.readFileSync(partsFile, 'utf8')).filter((p) => !done.has(p.part));
console.log(`${parts.length} parts, ${done.size} already done; at most ${MAX_SLICERS} slicers, only while ${MIN_FREE_GB} GB RAM is free`);
const out = fs.createWriteStream(resultsPath, { flags: 'a' });
let i = 0, n = 0;
async function lane() {
  while (i < parts.length) {
    const p = parts[i++];
    let r;
    try { r = await audit(p); } catch (e) { r = { part: p.part, category: p.category, status: 'crash', error: String((e && e.stack) || e) }; }
    out.write(JSON.stringify(r) + '\n');
    n++;
    if (n % 10 === 0 || n === parts.length) console.log(`${n}/${parts.length} ${new Date().toISOString().slice(11, 19)} slicers now ${active}, peak ${peak}, lowest free RAM ${minFree.toFixed(1)} GB`);
  }
}
await Promise.all(Array.from({ length: PARTS_IN_FLIGHT }, lane));
out.end();
console.log(`done; peak slicers ${peak}, lowest free RAM ${minFree.toFixed(1)} GB`);
process.exit(0);
