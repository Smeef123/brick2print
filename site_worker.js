// The page's worker threads: loading a part (LDraw -> print-ready mesh) and its support check both run here, so
// the page keeps scrolling and redrawing while a baseplate (295k triangles) loads or a big part is checked.
import { autoSupport } from './supports.js';
import { fetchRetry, once } from './net.js';

// parts.js imports three.js by bare name, which the page's import map resolves; a worker has no import map, so
// app.js hands it the page's map as the worker's name, and parts.js is loaded with its two three.js imports
// pointed at jsDelivr's resolved (+esm) build of the same files. The version lives only in index.html.
const imports = JSON.parse(self.name).imports;   // name: { imports: the page's import map, tab: net.js's tab id }
const THREE_URL = imports.three.replace(/build\/three\.module\.js$/, '+esm');
const LDRAW_URL = imports['three/addons/'] + 'loaders/LDrawLoader.js/+esm';
// Loaded on first use and again after a failure (a dropped download of parts.js or of three.js must not leave this
// worker broken for the visit: every part sent to it would fail until reload).
// three.js is fetched first (with retries) and imported only once it has arrived: a failed import is remembered by the
// browser's module map for this worker, so it would fail every time. If it fails all the same the worker reports
// itself broken and the page replaces it.
let broken = '';
const parts = once(async () => {
  for (const u of [THREE_URL, LDRAW_URL]) { const t = await fetchRetry(u); if (!t.ok) throw new Error(`three.js answered ${t.status}`); }
  const r = await fetchRetry('parts.js');
  if (!r.ok) throw new Error(`parts.js answered ${r.status}`);
  const src = await r.text();
  const out = src.replace("from 'three/addons/loaders/LDrawLoader.js'", `from '${LDRAW_URL}'`).replace("from 'three'", `from '${THREE_URL}'`)
    .replace(/from '(\.\/net\.js[^']*)'/, (m, spec) => `from '${new URL(spec, self.location.href).href}'`);   // a blob module has no base for ./ (spec keeps parts.js's own ?v=)
  if (/from '(three|\.\/)/.test(out)) throw new Error('parts.js imports changed: update site_worker.js');
  return import(URL.createObjectURL(new Blob([out], { type: 'text/javascript' }))).catch((e) => { broken = e.message || 'import failed'; throw e; });
});

onmessage = async ({ data: { id, kind, part, name, mesh } }) => {
  let r;
  // a worker that couldn't load three.js can't load parts, but a support check needs no three.js: it still runs those
  if (broken && kind !== 'support') { postMessage({ id, r: { error: 'this worker could not load its code (' + broken + ')', workerBroken: true } }); return; }
  try {
    if (kind === 'resolve') r = await (await parts()).resolvePart(part, name);
    else if (kind === 'load') { const P = await parts(); r = await P.loadPart(part); P.dropMeshes(); }   // the page keeps the mesh
    else r = autoSupport(mesh);
  } catch (e) {
    r = kind === 'support' ? { mesh, note: 'support check failed: ' + e.message, unserved: 1 } : { error: e.message, missingFiles: e.missingFiles, workerBroken: !!broken };   // a failed 'resolve' answered like a support result read as "files is not iterable"
  }
  // copied, not transferred (a transfer list throws if both arrays ever share one buffer); a reply that can't be sent
  // still answers the job, so the page never waits on it
  try { postMessage({ id, r }); } catch (e) { postMessage({ id, r: kind === 'support' ? { mesh, note: 'support check failed: ' + e.message, unserved: 1 } : { error: e.message } }); }
};
