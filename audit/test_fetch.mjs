// Check how the page and its workers fetch from a host that refuses bursts, as GitHub Pages does (503s, Retry-After):
// requests to the parts library (parts.js, which wraps fetch for three.js too) and the page's own JSON (net.js).
//   node audit/test_fetch.mjs   (no network: a local server plays the host)
import http from 'node:http';
import './polyfill.mjs';
import { setLibrary } from '../parts.js';
import { Worker } from 'node:worker_threads';
import { fetchRetry, once, getJSON, setDeadline, tabId } from '../net.js';

let mode = 'ok', refuseUntil = 0, hits = [];
const server = http.createServer((req, res) => {
  const now = Date.now();
  hits.push(now);
  if (mode === 'window' && now < refuseUntil) { res.writeHead(503, { 'Retry-After': '1', Connection: 'close' }).end(); return; }
  if (mode === 'always') { res.writeHead(503, { Connection: 'close' }).end(); return; }
  if (req.url.includes('missing')) { res.writeHead(404, { Connection: 'close' }).end(); return; }
  if (req.url.includes('html')) { res.writeHead(200, { 'Content-Type': 'text/html', Connection: 'close' }).end('<html>'); return; }
  res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' }).end('{"ok":1}');
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
server.unref();
const base = `http://127.0.0.1:${server.address().port}/`;
setLibrary(base + 'ldraw/');

const fails = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };

// 1. a burst of 20 library requests while the host refuses for 1 s with Retry-After: 1. Each request must wait out
//    the one shared pause instead of knocking on its own schedule, and all must succeed.
mode = 'window'; hits = []; refuseUntil = Date.now() + 1000;
const t0 = Date.now();
const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => fetch(base + `ldraw/parts/x${i}.dat`)));
const during = hits.filter((t) => t < refuseUntil).length;
check(rs.every((r) => r.ok), `burst of 20 during a 1 s refusal: ${rs.filter((r) => r.ok).length} of 20 succeed`);
check(during <= 20, `the host sees ${during} requests while refusing (20 at most: one each, then everyone waits for Retry-After)`);
check(Date.now() - t0 >= 900, `requests wait out Retry-After: done after ${Date.now() - t0} ms (at least 900)`);

// 1b. the waiting requests go again spread out, not all in the same instant after the pause
const after = hits.filter((t) => t >= refuseUntil).sort((a, b) => a - b);
check(after.length >= 20 && after[after.length - 1] - after[0] >= 150, `after the pause the 20 requests come back spread over ${after.length ? after[after.length - 1] - after[0] : 0} ms (at least 150)`);

// 1c. the pause is shared with the other threads (the page's workers): one thread is told 503 + Retry-After: 1, and
//     a request another thread makes right after waits for the end of that pause instead of knocking at once
mode = 'window'; hits = []; refuseUntil = Date.now() + 1000;
await fetchRetry(base + 'data/a.json', undefined, { capMs: 0 });   // gets the 503 and sets the pause, gives up at once
const w = new Worker(`import { fetchRetry } from ${JSON.stringify(new URL('../net.js', import.meta.url).href)};
  import { parentPort } from 'node:worker_threads';
  const t = Date.now(); const r = await fetchRetry(${JSON.stringify(base + 'data/b.json')});
  parentPort.postMessage({ status: r.status, waited: Date.now() - t });`, { eval: true });
const wr = await new Promise((ok) => w.once('message', ok));
await w.terminate();
check(wr.status === 200 && hits.length === 2, `another thread waits out the shared pause: ${hits.length} requests seen (want 2), it waited ${wr.waited} ms and got ${wr.status}`);

// 1d. the build's deadline caps every request, whatever its own cap
mode = 'always'; hits = [];
setDeadline(Date.now() + 1200);
const t2 = Date.now();
const rd = await fetchRetry(base + 'data/c.json', undefined, { capMs: 60000, base: 100 });
setDeadline(null);
check(rd.status === 503 && Date.now() - t2 < 2500, `the build deadline (1.2 s) ends a request whose own cap is 60 s: gave up after ${Date.now() - t2} ms`);

// 1e. the deadline belongs to one tab: a worker of this tab is held to it, a worker of another tab of the site is not
//     (the pause stays shared by every tab)
mode = 'always';
const tabWorker = (tab) => new Worker(`globalThis.name = ${JSON.stringify(JSON.stringify({ tab }))};
  const { fetchRetry } = await import(${JSON.stringify(new URL('../net.js', import.meta.url).href)});
  const { parentPort } = await import('node:worker_threads');
  await new Promise((ok) => setTimeout(ok, 100));   // joined and heard before the deadline is set
  parentPort.postMessage('ready');
  await new Promise((ok) => parentPort.once('message', ok));
  const t = Date.now(); await fetchRetry(${JSON.stringify(base + 'data/d.json')}, undefined, { capMs: 5000, base: 100 });
  parentPort.postMessage(Date.now() - t);`, { eval: true });
const mineW = tabWorker(tabId), otherW = tabWorker('another-tab');
await Promise.all([mineW, otherW].map((w) => new Promise((ok) => w.once('message', ok))));
setDeadline(Date.now() + 800);
mineW.postMessage('go'); otherW.postMessage('go');
const [mineMs, otherMs] = await Promise.all([mineW, otherW].map((w) => new Promise((ok) => w.once('message', ok))));
setDeadline(null);
await Promise.all([mineW.terminate(), otherW.terminate()]);
check(mineMs < 1300 && otherMs >= 1800, `this tab's 0.8 s deadline: its worker gave up after ${mineMs} ms (under 1.3 s), another tab's worker kept its own 5 s limit (${otherMs} ms, at least 1.8 s)`);

// 2. a host that never recovers: the request gives up within its time cap with the host's answer
mode = 'always'; hits = [];
const t1 = Date.now();
const r2 = await fetchRetry(base + 'data/index.json', undefined, { capMs: 2000, base: 100 });
check(r2.status === 503 && Date.now() - t1 < 4000, `a host refusing for good: gives up with 503 after ${Date.now() - t1} ms (cap 2 s), ${hits.length} tries`);

// 3. a 404 is an answer, not a failure to retry
mode = 'ok'; hits = [];
const r3 = await fetchRetry(base + 'missing.json');
check(r3.status === 404 && hits.length === 1, `404 comes back at once (${hits.length} request)`);

// 4. JSON helpers: a 404 or a page that isn't JSON is an error, and a cached failure is forgotten
let attempts = 0;
const shouldFail = { v: true };
const get = once(async () => { attempts++; if (shouldFail.v) throw new Error('down'); return 'data'; });
await get().catch(() => {});
shouldFail.v = false;
check((await get()) === 'data' && attempts === 2, `a failed load is tried again on the next call (${attempts} attempts)`);
check(await getJSON(base + 'missing.json').then(() => false, () => true), 'getJSON: 404 is an error, not an empty result');
check(await getJSON(base + 'html').then(() => false, () => true), 'getJSON: an HTML page is an error');

console.log(fails.length ? `FAIL (${fails.length})` : 'PASS');
process.exit(fails.length ? 1 : 0);
