// Fetching from the site's own host, which refuses bursts: GitHub Pages answered 88 requests with 503 while the live
// site built set 11374 (2026-11-23). Shared by the page (app.js) and the workers (parts.js, site_worker.js).
//
// One pause for the whole page and all its workers: a 503, 429 or other 5xx (or a dropped connection) sets "pause
// until", honouring Retry-After, else 0.25, 0.5, 1, 2, 4 s with jitter, and tells every other worker and the page
// (BroadcastChannel). Waiting requests then go again spread over part of the pause, not all at the same instant.
// A request gives up when its own time passes capMs or the build's deadline (setDeadline) passes, whichever is
// first. Other answers (404 included) come back at once.

let pauseUntil = 0, pauseLen = 0, deadline = Infinity;
// This tab's id: the page makes one, its workers get it in their name (app.js). The pause is shared by every tab of
// the site (they all hit one host), the build deadline only within one tab.
export const tabId = (() => { try { return JSON.parse(globalThis.name || '{}').tab || null; } catch { return null; } })() || Math.random().toString(36).slice(2);
const tabChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('brick2print-build-' + tabId) : null;
tabChannel?.unref?.();
if (tabChannel) tabChannel.onmessage = ({ data }) => { if (data && 'deadline' in data) deadline = data.deadline ?? Infinity; };
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('brick2print-host') : null;
channel?.unref?.();   // Node: don't keep a process alive for it
// A worker started after a pause began asks the others what holds now; its first request waits up to 50 ms for an
// answer (one reply is enough).
let heard;
const hello = new Promise((ok) => { heard = ok; setTimeout(ok, channel ? 50 : 0); });
if (channel) {
  channel.onmessage = ({ data }) => {
    if (!data) return;
    if (data.ask) { if (pauseUntil > Date.now()) channel.postMessage({ until: pauseUntil, len: pauseLen }); if (deadline !== Infinity) tabChannel?.postMessage({ deadline }); return; }
    if (data.until > pauseUntil) { pauseUntil = data.until; pauseLen = data.len || pauseLen; }
    heard();
  };
  channel.postMessage({ ask: 1 });
}
const retryAfterMs = (r) => {
  const v = r.headers?.get?.('retry-after');
  if (!v) return 0;
  const s = Number(v);
  return Number.isFinite(s) ? s * 1000 : Math.max(0, Date.parse(v) - Date.now()) || 0;
};
function pause(ms) {
  const until = Date.now() + ms;
  if (until <= pauseUntil) return;
  pauseUntil = until; pauseLen = ms;
  channel?.postMessage({ until, len: ms });
}

/** The build's own time limit, for this tab's page and workers only; null lifts it. */
export function setDeadline(ts) {
  deadline = ts ?? Infinity;
  tabChannel?.postMessage({ deadline: ts ?? null });
}

/** fetch() that rides out a host refusing a burst. Resolves with the last answer, or throws the last network error. */
export async function fetchRetry(input, init, { capMs = 30000, base = 250, realFetch = fetchRetry.realFetch || globalThis.fetch.bind(globalThis) } = {}) {
  await hello;
  const start = Date.now();
  let r, err;
  for (let n = 0; ; n++) {
    const giveUp = Math.min(start + capMs, deadline);
    const wake = pauseUntil > Date.now() ? pauseUntil + Math.random() * Math.max(base, pauseLen / 2) : 0;   // spread the wake-ups
    if (n > 0 && wake > giveUp) { if (r) return r; throw err; }   // the pause (this one's or another worker's) runs past the limit
    if (wake) await sleep(Math.min(wake, giveUp) - Date.now());   // the first try waits no later than the limit
    r = undefined; err = undefined;
    try { r = await realFetch(input, init); } catch (e) { err = e; }
    if (r && !(r.status >= 500 || r.status === 429)) return r;
    const delay = Math.max(r ? retryAfterMs(r) : 0, base * 2 ** Math.min(n, 4) * (0.5 + Math.random()));
    pause(delay);   // even when this request gives up, the others are told to hold back
    if (Date.now() + delay > giveUp) { if (r) return r; throw err; }
  }
}

/** A cached async result that forgets a failure, so the next call tries again instead of repeating the error. */
export function once(make) {
  let p = null;
  return () => (p ??= make().catch((e) => { p = null; throw e; }));
}

/** JSON from the site's host; a non-2xx answer is an error, never an empty result. */
export async function getJSON(url) {
  const r = await fetchRetry(url);
  if (!r.ok) throw new Error(`${url} answered ${r.status}`);
  return r.json();
}
