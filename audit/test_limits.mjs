// Check limits.js: device memory and worker count when the browser doesn't say (Safari, Firefox), and the up-front
// estimate that refuses a set before loading it.   node audit/test_limits.mjs
import { deviceMemoryGB, memoryForPageMB, workerCount, listNeedMB } from '../limits.js';

const fails = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };
const iphone = { maxTouchPoints: 5, hardwareConcurrency: 6 }, desktopSafari = { maxTouchPoints: 0, hardwareConcurrency: 8 };
const android4 = { deviceMemory: 4, maxTouchPoints: 5, hardwareConcurrency: 8 };
check(deviceMemoryGB(iphone) === 3, `iPhone (no deviceMemory, touch) taken as ${deviceMemoryGB(iphone)} GB (want 3)`);
check(deviceMemoryGB(desktopSafari) === 8, `desktop Safari (no deviceMemory, no touch) taken as ${deviceMemoryGB(desktopSafari)} GB`);
check(workerCount(iphone) === 2, `iPhone gets ${workerCount(iphone)} workers (want 2)`);
check(workerCount(android4) === 2 && workerCount({ deviceMemory: 2, hardwareConcurrency: 8 }) === 1 && workerCount({ hardwareConcurrency: 16 }) === 4, 'workers: 4 GB -> 2, 2 GB -> 1, 16-core desktop -> 4');
// a phone that doesn't report memory gets a finite page budget (the old code made it unlimited, so no set was ever
// refused on an iPhone), and the up-front estimate refuses a big list there when the budget is small
check(Number.isFinite(memoryForPageMB(iphone)) && memoryForPageMB(iphone) === 1536, `iPhone page budget ${memoryForPageMB(iphone)} MB (want 1536, finite)`);
const rows11374 = 484, rows11926 = 21;
check(listNeedMB(rows11926) === 266 && listNeedMB(rows11374) === 613, `up-front estimate: 11926 ${listNeedMB(rows11926)} MB, 11374 ${listNeedMB(rows11374)} MB (11374 measured after loading: 608)`);
check(listNeedMB(rows11374) > memoryForPageMB({ deviceMemory: 1, maxTouchPoints: 5 }), `a 1 GB phone (${memoryForPageMB({ deviceMemory: 1, maxTouchPoints: 5 })} MB) refuses 11374 before loading`);
console.log(fails.length ? `FAIL (${fails.length})` : 'PASS');
process.exit(fails.length ? 1 : 0);
