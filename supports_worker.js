// Runs the support check off the page's main thread, so the page keeps scrolling and redrawing while a big part is checked.
import { autoSupport } from './supports.js';

onmessage = ({ data: { id, mesh } }) => {
  let s;
  try { s = autoSupport(mesh); } catch (e) { s = { mesh, note: 'support check failed: ' + e.message, unserved: 1 }; }
  postMessage({ id, s }, [s.mesh.verts.buffer, s.mesh.tris.buffer]);
};
