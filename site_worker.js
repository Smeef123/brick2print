// The page's worker threads: loading a part (LDraw -> print-ready mesh) and its support check both run here, so
// the page keeps scrolling and redrawing while a baseplate (295k triangles) loads or a big part is checked.
import { autoSupport } from './supports.js';

// parts.js imports three.js by bare name, which the page's import map resolves; a worker has no import map, so
// app.js hands it the page's map as the worker's name, and parts.js is loaded with its two three.js imports
// pointed at jsDelivr's resolved (+esm) build of the same files. The version lives only in index.html.
const imports = JSON.parse(self.name).imports;
const THREE_URL = imports.three.replace(/build\/three\.module\.js$/, '+esm');
const LDRAW_URL = imports['three/addons/'] + 'loaders/LDrawLoader.js/+esm';
const parts = fetch('parts.js').then((r) => r.text()).then((src) => {
  const out = src.replace("from 'three/addons/loaders/LDrawLoader.js'", `from '${LDRAW_URL}'`).replace("from 'three'", `from '${THREE_URL}'`);
  if (out.includes("from 'three")) throw new Error('parts.js imports changed: update site_worker.js');
  return import(URL.createObjectURL(new Blob([out], { type: 'text/javascript' })));
});

onmessage = async ({ data: { id, kind, part, name, mesh } }) => {
  let r;
  try {
    if (kind === 'load') r = await (await parts).loadPart(part, name);
    else r = autoSupport(mesh);
  } catch (e) {
    r = kind === 'load' ? { error: e.message } : { mesh, note: 'support check failed: ' + e.message, unserved: 1 };
  }
  postMessage({ id, r });   // copied, not transferred: a transfer list throws if both arrays ever share one buffer
};
