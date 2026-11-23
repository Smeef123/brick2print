// Stamp the published site's own script and data URLs with the commit, so browsers never mix a
// cached old file with a new one after an update.   node scripts/stamp.mjs _site <version>
import fs from 'node:fs';
import path from 'node:path';

const [dir, ver] = process.argv.slice(2);
// quotes include backticks: data/sets/${bucket}.json is a template literal
const local = /((?:from |import |src=|fetch\(|Worker\()['"`](?:\.\/)?(?:[\w-]+\/)*[\w${}()-]+\.(?:js|json))(['"`])/g;
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
let n = 0;
for (const f of walk(dir).filter((f) => /\.(js|html)$/.test(f) && !f.includes(`${path.sep}vendor${path.sep}`) && !f.includes('/vendor/'))) {
  const s = fs.readFileSync(f, 'utf8');
  // leave libraries (three/..., urls) alone: only this site's own files get the stamp
  const t = s.replace(local, (m, a, q) => (/http|['"]three\//.test(a) ? m : `${a}?v=${ver}${q}`));
  if (t !== s) { fs.writeFileSync(f, t); n++; }
}
console.log(`stamped ${n} files with ?v=${ver}`);
