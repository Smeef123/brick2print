// Stamp the published site's own script and data URLs with the commit, so browsers never mix a
// cached old file with a new one after an update.   node scripts/stamp.mjs _site <version>
//
// Every quoted string in the site's .js and .html files that is a whole site-relative path to a .js or .json
// file gets ?v=<version>, whatever uses it: import, fetch, getJSON, fetchRetry, new Worker, src=. (Matching only
// some callers left getJSON('data/index.json') and fetchRetry('parts.js') unstamped, 2026-11-23.) Library
// names (three, three/addons/...), full URLs and vendor/ are left alone. audit/test_stamp.mjs checks the result.
import fs from 'node:fs';
import path from 'node:path';

const [dir, ver] = process.argv.slice(2);
// quotes include backticks: data/sets/${bucket(sn)}.json is a template literal
export const SITE_PATH = /(['"`])((?:\.\/)?(?:[\w${}()-]+\/)*[\w${}()-]+\.(?:js|json))\1/g;
const isLibrary = (p) => /^three(\/|$)/.test(p);
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
if (dir) {
  let n = 0;
  for (const f of walk(dir).filter((f) => /\.(js|html)$/.test(f) && !f.split(path.sep).includes('vendor') && !f.split('/').includes('vendor') && !f.split(path.sep).includes('ldraw'))) {
    const s = fs.readFileSync(f, 'utf8');
    const t = s.replace(SITE_PATH, (m, q, p) => (isLibrary(p) ? m : `${q}${p}?v=${ver}${q}`));
    if (t !== s) { fs.writeFileSync(f, t); n++; }
  }
  console.log(`stamped ${n} files with ?v=${ver}`);
}
