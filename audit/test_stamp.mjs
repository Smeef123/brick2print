// Check scripts/stamp.mjs on a copy of the site's files: afterwards no site-relative .js/.json URL in any page script
// or index.html may lack ?v=, whichever function uses it (import, fetch, getJSON, fetchRetry, Worker, src=), and no
// URL may be glued together from pieces the stamp can't see ('data/' + x + '.json').
//   node audit/test_stamp.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-'));
const files = fs.readdirSync(ROOT).filter((f) => /\.(js|html)$/.test(f));
for (const f of files) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'stamp.mjs'), dir, 'test1'], { encoding: 'utf8' });
console.log((r.stdout || '').trim(), (r.stderr || '').trim());
const unstamped = [], glued = [];
for (const f of files) {
  const s = fs.readFileSync(path.join(dir, f), 'utf8');
  for (const m of s.matchAll(/(['"`])([^'"`\s]*?\.(?:js|json)(?:\?[^'"`\s]*)?)\1/g)) {
    const p = m[2];
    if (/^(https?:|\/\/|three(\/|$))/.test(p)) continue;
    if (/^\.(js|json)$/.test(p) || p.startsWith('.json') || p.startsWith('.js')) { glued.push(`${f}: ${m[0]}`); continue; }
    if (!/\?v=test1$/.test(p)) unstamped.push(`${f}: ${m[0]}`);
  }
}
fs.rmSync(dir, { recursive: true, force: true });
const fails = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };
check(!unstamped.length, `every site .js/.json URL stamped (${unstamped.length} not${unstamped.length ? ': ' + unstamped.join(', ') : ''})`);
check(!glued.length, `no URL glued from pieces (${glued.join(', ') || 'none'})`);
console.log(fails.length ? `FAIL (${fails.length})` : 'PASS');
process.exit(fails.length ? 1 : 0);
