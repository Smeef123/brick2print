// Serve the local LDraw library (C:\Users\Connor\tools\ldraw, or LDRAW_DIR) on 127.0.0.1:8767 from this
// process unless something already answers there, and point parts.js at it. Every audit script calls this.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { setLibrary } from '../parts.js';

const PORT = 8767, URL_ = `http://127.0.0.1:${PORT}/`;
const ROOT = process.env.LDRAW_DIR || 'C:/Users/Connor/tools/ldraw';

export async function useLocalLibrary() {
  const up = await fetch(URL_ + 'LDConfig.ldr', { method: 'HEAD' }).then((r) => r.ok).catch(() => false);
  if (!up) {
    if (!fs.existsSync(path.join(ROOT, 'LDConfig.ldr'))) throw new Error(`no LDraw library at ${ROOT} (set LDRAW_DIR)`);
    const server = http.createServer((req, res) => {
      const p = path.join(ROOT, decodeURIComponent(new URL(req.url, URL_).pathname));
      fs.stat(p, (e, st) => {
        if (e || !st.isFile() || !p.startsWith(path.normalize(ROOT))) { res.writeHead(404).end(); return; }
        res.writeHead(200, { 'Content-Length': st.size, 'Cache-Control': 'no-store' });
        if (req.method === 'HEAD') res.end(); else fs.createReadStream(p).pipe(res);
      });
    });
    await new Promise((ok, fail) => server.once('error', fail).listen(PORT, '127.0.0.1', ok));
    server.unref();
  }
  setLibrary(URL_);
}
