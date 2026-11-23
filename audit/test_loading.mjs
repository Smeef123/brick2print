// Check parts.js loadPart() against a library server that fails on purpose: only a part LDraw really lacks
// (404 everywhere) reads as "not in LDraw" (null); a server error or a failed sub-file throws, is not cached,
// and the next try after the fault clears loads the whole part.
//   node audit/test_loading.mjs   (serves the local LDraw library, C:\Users\Connor\tools\ldraw or LDRAW_DIR)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import './polyfill.mjs';
import { loadPart, setLibrary } from '../parts.js';

const ROOT = process.env.LDRAW_DIR || 'C:/Users/Connor/tools/ldraw';
let fault = null, flaky = 0;   // flaky: share of requests answered 503 at random, as GitHub Pages does under a burst
const gets = [];   // files downloaded (GET), to see what a load fetched   // regex of paths answered with 503
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x/').pathname);
  if (req.method === 'GET') gets.push(rel);
  if ((fault && fault.test(rel)) || Math.random() < flaky) { res.writeHead(503, { Connection: 'close' }).end(); return; }
  const p = path.join(ROOT, rel);
  fs.stat(p, (e, st) => {
    if (e || !st.isFile()) { res.writeHead(404, { Connection: 'close' }).end(); return; }
    res.writeHead(200, { 'Content-Length': st.size, Connection: 'close' });
    if (req.method === 'HEAD') res.end(); else fs.createReadStream(p).pipe(res);
  });
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
server.unref();
setLibrary(`http://127.0.0.1:${server.address().port}/`);

const fails = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };
const tris = (g) => (g ? g.mesh.tris.length / 3 : 0);
const attempt = (id) => loadPart(id).then((g) => ({ g }), (e) => ({ e }));

for (const [id, re, what] of [
  ['3004', /^\/p\/box5\.dat$/, 'a primitive (box5.dat) answers 503'],   // first: nothing has loaded box5 yet
  ['3020', /^\/parts\/3020\.dat$/, 'the part file itself answers 503'],
  ['3003', /^\/parts\/s\/3003s01\.dat$/, 'a sub-part (s/3003s01.dat) answers 503'],
]) {
  fault = re;
  const a = await attempt(id);
  check(!!a.e, `${id}: ${what} -> ${a.e ? 'throws: ' + a.e.message.slice(0, 70) : a.g ? `loaded ${tris(a.g)} triangles` : 'null (read as not in LDraw)'}`);
  fault = null;
  const b = await attempt(id);
  check(tris(b.g) > 500, `${id}: after the fault clears it loads whole (${b.g ? tris(b.g) : b.e?.message || 'null'} triangles)`);
}
// GitHub Pages answers a burst of requests with some 503s (88 of them while the live site built set 11374,
// 2026-11-23); the parts must still load whole and the same as without them
flaky = 0.3;
const parts = ['3062b', '4070', '3040b', '3039', '3665', '2420', '3710', '3009', '4162', '3460'];
const flakyRes = await Promise.all(parts.map(attempt));
flaky = 0;
const steady = await Promise.all(parts.map(async (id) => tris((await attempt(id)).g)));
const okCount = flakyRes.filter((r, i) => r.g && tris(r.g) === steady[i]).length;
check(okCount === parts.length, `with 30% of answers 503: ${okCount} of ${parts.length} parts load whole (${flakyRes.filter((r) => r.e).map((r) => r.e.message.slice(0, 50)).slice(0, 2).join('; ') || 'no errors'})`);
const full = await attempt('3001');
check(tris(full.g) > 1000, `3001 loads whole: ${tris(full.g)} triangles`);
check((await attempt('nosuchpart99')).g === null, 'a part LDraw lacks reads as not in LDraw (null)');
// printed variants of one shape (Rebrickable 3069bpr0001, 3069bpr0002 -> LDraw 3069b) load it once
const v1 = await attempt('3069bpr0001'), n = gets.length, v2 = await attempt('3069bpr0002');
check(v1.g && v2.g && v1.g.mesh === v2.g.mesh && gets.length === n, `3069bpr0002 reuses 3069bpr0001's shape (${gets.length - n} files downloaded for it)`);
console.log(fails.length ? `FAIL (${fails.length})` : 'PASS');
process.exit(fails.length ? 1 : 0);
