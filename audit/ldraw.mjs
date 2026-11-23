// Serve the local LDraw library (C:\Users\Connor\tools\ldraw, or LDRAW_DIR) on 127.0.0.1:8767 from this
// process unless something already answers there, and point parts.js at it. Every audit script calls this.
// A server inside another audit process stops answering while that process computes (a support check can
// hold it for minutes), so an answer must come within 2 s; otherwise this process serves its own copy on a free port.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { setLibrary } from '../parts.js';

const PORT = 8767;
const ROOT = process.env.LDRAW_DIR || 'C:/Users/Connor/tools/ldraw';
const answers = (url) => fetch(url + 'LDConfig.ldr', { method: 'HEAD', signal: AbortSignal.timeout(2000) }).then((r) => r.ok).catch(() => false);

export async function useLocalLibrary() {
  let url = `http://127.0.0.1:${PORT}/`;
  if (!(await answers(url))) {
    if (!fs.existsSync(path.join(ROOT, 'LDConfig.ldr'))) throw new Error(`no LDraw library at ${ROOT} (set LDRAW_DIR)`);
    const server = http.createServer((req, res) => {
      const p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x/').pathname));
      fs.stat(p, (e, st) => {
        if (e || !st.isFile() || !p.startsWith(path.normalize(ROOT))) { res.writeHead(404).end(); return; }
        res.writeHead(200, { 'Content-Length': st.size, 'Cache-Control': 'no-store' });
        if (req.method === 'HEAD') res.end(); else fs.createReadStream(p).pipe(res);
      });
    });
    const listen = (port) => new Promise((ok, fail) => server.once('error', fail).listen(port, '127.0.0.1', ok));
    await listen(PORT).catch(() => listen(0));   // 8767 taken by a busy process: any free port
    server.unref();
    url = `http://127.0.0.1:${server.address().port}/`;
  }
  setLibrary(url);
}
