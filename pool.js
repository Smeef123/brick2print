// The page's worker pool (site_worker.js runs part loading and support checks). Kept apart from app.js so
// audit/test_pool.mjs can drive it with fake workers.
//
// No promise the pool hands out is ever left waiting. Every way a worker can stop answering goes through retire():
// it is terminated, leaves the pool, and every job it still holds is sent once more to another worker or, if it has
// had its second chance or no worker can be made, settled with an error in words (a support check with the part's
// own shape, never an empty one). Routes: the worker's onerror (script failed to load or threw), onmessageerror
// (a reply that can't be read), a reply saying the worker can't load its code, a reply the page can't handle, a
// failed postMessage. A flow that can give up (a build at its deadline) runs its jobs through its own session():
// session.abandon() settles that session's jobs in words with no second chance, stops the workers holding them
// (their other jobs get their one re-send) and refuses that session's later jobs in words. Nothing is closed for
// anyone else, so no caller has to reopen anything. The pool's size is fixed when it is made; it refills on the
// next job once every worker has been retired.

/** make(): a new worker (an object with postMessage, terminate and on* handlers); size: how many to keep. */
export function createPool(make, size) {
  const workers = [], jobs = new Map();   // job id -> { w, kind, data, res, tries }
  let nextId = 0;
  const failed = (j, why) => (j.kind === 'support'
    ? { mesh: j.data.mesh, note: 'support check failed: ' + why, unserved: 1 }
    : { error: why });

  function retire(w, why, again = true) {
    if (w.retired) return;
    w.retired = true;
    try { w.terminate(); } catch { /* already gone */ }
    if (workers.includes(w)) workers.splice(workers.indexOf(w), 1);
    for (const [id, j] of [...jobs]) {
      if (j.w !== w) continue;
      jobs.delete(id);
      if (again && j.tries < 2) send(j); else j.res(failed(j, why));   // once more elsewhere, else in words
    }
  }
  function spawn() {
    const w = make();
    w.busy = 0;
    w.onmessage = ({ data }) => {
      try {
        const j = jobs.get(data?.id);
        if (!j || j.w !== w) throw new Error('a reply for no job it holds');
        jobs.delete(data.id); w.busy--;
        if (data.r?.workerBroken) {   // it can't load its code: its other jobs go elsewhere, and so does this one
          const why = data.r.error || 'the worker could not load its code';
          retire(w, why);   // first, so the job doesn't go back to the same worker
          if (j.tries < 2) send(j); else j.res(failed(j, why));
          return;
        }
        j.res(data.r);
      } catch (e) { retire(w, 'the page could not read its answer (' + e.message + ')'); }
    };
    w.onerror = (e) => { e?.preventDefault?.(); retire(w, e?.message || 'the worker stopped'); };
    w.onmessageerror = () => retire(w, 'its answer could not be read');
    workers.push(w);
    return w;
  }
  // Hands a job to a worker; settles it in words when that can't happen (its session gave up, no worker can be made).
  function send(j) {
    if (j.s?.closed) { j.res(failed(j, j.s.closed)); return; }
    try { if (!workers.length) for (let k = 0; k < size; k++) spawn(); } catch (e) { /* use whatever was made */ }
    if (!workers.length) { j.res(failed(j, 'no worker could be started')); return; }
    const w = workers.reduce((a, b) => (b.busy < a.busy ? b : a));
    const id = ++nextId;
    j.w = w; j.tries++; w.busy++;
    jobs.set(id, j);
    try { w.postMessage({ id, kind: j.kind, ...j.data }); } catch (e) { retire(w, 'could not send it work (' + e.message + ')'); }
  }
  const run = (kind, data, s) => new Promise((res) => send({ kind, data, res, tries: 0, s }));
  return {
    /** Resolves with the worker's answer, or an answer in words when no worker could give one; never hangs. */
    run: (kind, data) => run(kind, data),
    /** Jobs that can be given up together: abandon(why) settles every one of them in words now, re-sends none, and
     *  refuses this session's later jobs in words. Other sessions' jobs and run() are untouched. */
    session: () => {
      const s = { closed: '' };
      return {
        run: (kind, data) => run(kind, data, s),
        abandon: (why) => {
          s.closed = why;
          const held = new Set();
          for (const [id, j] of [...jobs]) if (j.s === s) { jobs.delete(id); j.w.busy--; held.add(j.w); j.res(failed(j, why)); }
          for (const w of held) retire(w, why);   // stops the stuck work; anyone else's jobs on it get their one re-send
        },
      };
    },
    get size() { return workers.length; },
    get waiting() { return jobs.size; },
  };
}
