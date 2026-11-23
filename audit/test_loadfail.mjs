// Check index.html's load-failure message: when a script (three.js from jsDelivr, JSZip, the site's own) fails to
// load, or the app hasn't started about 25 s after the page started, the page shows a message with a retry button; when the
// app did start it stays hidden. Runs the page's inline script against a stub document (no browser).
//   node audit/test_loadfail.mjs
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const fails = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((s) => /loadfail/.test(s));
check(!!script && /id="loadfail"[^>]*hidden/.test(html) && /id="loadretry"/.test(html), 'index.html has a hidden load-failure message with a retry button and its script');
function run({ ready = false } = {}) {
  const box = { hidden: true }, retry = {}, listeners = {}, timers = [];
  let reloaded = false;
  const ctx = {
    document: { documentElement: { dataset: ready ? { ready: '1' } : {} }, getElementById: (id) => (id === 'loadfail' ? box : retry) },
    window: { addEventListener: (t, f) => { listeners[t] = f; } },
    location: { reload: () => { reloaded = true; } },
    setTimeout: (f, ms) => timers.push([f, ms]),
  };
  vm.runInNewContext(script || '', ctx);
  return { box, retry, listeners, timers, reloaded: () => reloaded };
}
if (script) {
  let p = run();
  p.listeners.error?.({ target: { tagName: 'SCRIPT' } });
  check(p.box.hidden === false, 'a script that fails to load shows the message');
  p.retry.onclick?.();
  check(p.reloaded(), 'Try again reloads the page');
  p = run();
  p.listeners.error?.({ target: { tagName: 'IMG' } });
  check(p.box.hidden === true, 'an image that fails to load does not');
  // a stalled script holds the load event back for ever: the timer must not wait for it
  p = run();
  p.timers.forEach(([f]) => f());
  check(p.box.hidden === false && p.timers.some(([, ms]) => ms >= 15000 && ms <= 30000), `no app 15-30 s after the page started, with no load event ever (a stalled script), shows the message (timers: ${p.timers.map(([, ms]) => ms).join(', ') || 'none'})`);
  p = run({ ready: true });
  p.listeners.load?.(); p.timers.forEach(([f]) => f()); p.listeners.error?.({ target: { tagName: 'SCRIPT' } });
  check(p.box.hidden === true, 'once the app has started, nothing shows it');
}
console.log(fails.length ? `FAIL (${fails.length})` : 'PASS');
process.exit(fails.length ? 1 : 0);
