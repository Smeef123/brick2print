// Check pool.js with fake workers: whichever way a worker stops answering, every job it held settles (re-sent once
// to another worker, then an answer in words), and nothing hangs.   node audit/test_pool.mjs
import { createPool } from '../pool.js';

const fails = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };
// a fake worker: holds the jobs sent to it; the test decides how it answers
const all = [];
function fake() {
  const w = { got: [], terminated: false, postMessage(m) { this.got.push(m); }, terminate() { this.terminated = true; } };
  all.push(w);
  return w;
}
const answer = (w, m, r) => w.onmessage({ data: { id: m.id, r } });
const settled = (p, ms = 200) => Promise.race([p.then((v) => ({ v })), new Promise((ok) => setTimeout(() => ok(null), ms))]);
const mesh = { verts: [1], tris: [0] };

// 1. the checker's case: W holds a long support check for X; a load reply from W says it can't load its code
let pool = createPool(fake, 2);
const x = pool.run('support', { mesh });          // goes to worker 0
const y = pool.run('load', { part: '3001' });     // goes to worker 1
const [w0, w1] = all.slice(-2);
const xMsg = w0.got[0], yMsg = w1.got[0];
answer(w1, yMsg, { error: 'this worker could not load its code (import failed)', workerBroken: true });
// X stays on w0 (healthy); now w0 also breaks while X is held: a reply for another job says broken
check(w1.terminated, 'a worker that says it is broken is terminated');
const yAgain = w0.got.find((m) => m.kind === 'load');
check(!!yAgain, 'its load job is sent again to the other worker');
answer(w0, yAgain, { error: 'this worker could not load its code (import failed)', workerBroken: true });
// X was held by worker 0 when it was retired: it must now sit on a live worker, not on the dead one
check(w0.terminated, 'worker 0 is terminated too');
const live = all.filter((w) => !w.terminated), xHere = live.flatMap((w) => w.got.filter((m) => m.kind === 'support').map((m) => [w, m]));
check(xHere.length === 1, `the support check worker 0 was still holding moved to a live worker (${xHere.length})`);
if (xHere.length) answer(xHere[0][0], xHere[0][1], { mesh, note: 'prints as is' });
const sx = await settled(x), sy = await settled(y);
check(!!sx && sx.v?.mesh === mesh, `and settles with its answer (${sx ? JSON.stringify(sx.v.note) : 'still waiting'})`);
check(!!sy && !!sy.v?.error, `the twice-failed load settles with an error in words (${sy ? sy.v.error : 'still waiting'})`);

// 2. onerror, onmessageerror, a throwing reply handler, a reply for no job: each settles what it held
for (const [route, kill] of [
  ['onerror', (w) => w.onerror({ message: 'boom', preventDefault() {} })],
  ['onmessageerror', (w) => w.onmessageerror({})],
  ['a reply for no job', (w) => w.onmessage({ data: { id: 99999, r: {} } })],
  ['a reply that cannot be read', (w) => w.onmessage({ data: null })],
]) {
  pool = createPool(fake, 1);
  const p = pool.run('support', { mesh });
  kill(all.at(-1));                  // the first worker goes; the job moves to a new one
  kill(all.at(-1));                  // and that one too
  const s = await settled(p);
  check(!!s && (s.v?.note?.startsWith('support check failed') || s.v?.mesh), `${route}: the held support check settles (${s ? (s.v.note || 'answered') : 'still waiting'}), ${pool.waiting} jobs left waiting`);
  check(!s || s.v?.mesh === mesh || s.v?.note === undefined, `${route}: a failed support check keeps the part's own shape`);
  check(pool.waiting === 0, `${route}: no jobs left waiting (${pool.waiting})`);
}

// 2b. a build's deadline: ONE abandon of its session settles every job it holds in words, re-sends none, and refuses
//     its later jobs; another flow's job (the fit test) on the same workers is re-sent and answered; afterwards the
//     pool and new sessions work with nothing reopened
pool = createPool(fake, 2);
const before = all.length;
const b1 = pool.session();
const held = [b1.run('support', { mesh }), b1.run('load', { part: '3001' }), b1.run('support', { mesh })];
const other = pool.run('load', { part: '3020' });   // the fit test, sharing the stuck workers
b1.abandon('the build took longer than 10 minutes');
const hs = await Promise.all(held.map((p) => settled(p)));
check(hs.every((h) => h && (h.v.error || h.v.note?.startsWith('support check failed'))), `one abandon settles all ${held.length} jobs in words (${hs.map((h) => (h ? h.v.error || h.v.note : 'still waiting')).join(' | ')})`);
check(all.slice(before, before + 2).every((w) => w.terminated), 'the workers holding them are stopped');
const resent = all.slice(before + 2).flatMap((w) => w.got);
check(resent.length === 1 && resent[0].part === '3020', `only the other flow's job is re-sent (${resent.map((m) => m.kind + ' ' + (m.part || 'mesh')).join(', ') || 'nothing'})`);
if (resent[0]) answer(all.find((w) => w.got.includes(resent[0])), resent[0], { name: '3020' });
check((await settled(other))?.v?.name === '3020', "the other flow's job is answered, not failed by the build's deadline");
const sentBefore = all.reduce((n, w) => n + w.got.length, 0);
const late = await settled(b1.run('load', { part: '3003' }));
check(!!late?.v?.error && all.reduce((n, w) => n + w.got.length, 0) === sentBefore, `a job the abandoned build asks for later doesn't run (${late ? late.v.error : 'still waiting'})`);
const fit = pool.run('resolve', { part: '3001' }), b2 = pool.session(), next = b2.run('resolve', { part: '3002' });
for (const w of all.slice(before + 2)) for (const m of w.got) if (m.kind === 'resolve') answer(w, m, [m.part]);
check(JSON.stringify((await settled(fit))?.v) === '["3001"]', 'after an abandon, the fit test runs with nothing reopened');
check(JSON.stringify((await settled(next))?.v) === '["3002"]', 'the next build (a new session) runs');
check(pool.waiting === 0, `no jobs left waiting (${pool.waiting})`);

// 2c. making a worker throws while a dead worker's jobs are being re-sent: every one still settles, in words
let broken = false;
pool = createPool(() => { if (broken) throw new Error('no more workers'); return fake(); }, 1);
const many = [pool.run('support', { mesh }), pool.run('load', { part: 'a' }), pool.run('load', { part: 'b' })];
broken = true;
all.at(-1).onerror({ message: 'crashed', preventDefault() {} });
const ms = await Promise.all(many.map((p) => settled(p)));
check(ms.every((m) => m && (m.v.error || m.v.note?.startsWith('support check failed'))), `a worker that can't be made: all 3 jobs settle in words (${ms.map((m) => (m ? m.v.error || m.v.note : 'still waiting')).join(' | ')})`);
check(pool.waiting === 0, `no jobs left waiting (${pool.waiting})`);
const none = await settled(pool.run('load', { part: 'c' }));
check(!!none?.v?.error, `a new job when no worker can be made settles in words (${none ? none.v.error : 'still waiting'})`);

// 2d. the build's give-up limit counts time with no progress, not time since the start: a slow session that keeps
//     answering runs well past the limit; one that stops answering is abandoned, in words, once the limit passes
pool = createPool(fake, 1);
let alive = 0;
const slow = pool.session({ stallMs: 120, why: 'no progress', onAlive: () => alive++ });
const answers = [];
for (let k = 0; k < 5; k++) {   // 5 jobs of 80 ms each: 400 ms in all, over three times the limit
  const p = slow.run('load', { part: 'p' + k });
  await new Promise((ok) => setTimeout(ok, 80));
  const w = all.at(-1);
  answer(w, w.got.at(-1), { name: 'p' + k });
  answers.push((await settled(p))?.v?.name);
}
check(answers.join() === 'p0,p1,p2,p3,p4', `a slow session that keeps answering is not cut off (${answers.join()})`);
check(alive >= 6, `each answer moves the network deadline on too (${alive} calls, want 6)`);
const stuck = slow.run('support', { mesh });
const st = await settled(stuck, 400);
check(!!st?.v?.note?.startsWith('support check failed: no progress') && all.at(-1).terminated, `a session with no answer for the limit is abandoned in words (${st ? st.v.note || st.v.error : 'still waiting'})`);
slow.close();
check(pool.waiting === 0, `no jobs left waiting (${pool.waiting})`);

// 3. a healthy pool answers normally and refills after every worker was retired
pool = createPool(fake, 2);
const p3 = pool.run('resolve', { part: '3001' });
answer(all.at(-2), all.at(-2).got[0], ['3001']);
check(JSON.stringify((await settled(p3))?.v) === '["3001"]', 'a normal answer comes through unchanged');
console.log(fails.length ? `FAIL (${fails.length})` : 'PASS');
process.exit(fails.length ? 1 : 0);
