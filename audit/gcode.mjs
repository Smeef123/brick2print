// Mid-air area and print time from real G-code: extrusions rasterised at 0.1 mm with a 0.42 mm line. A region
// counts as mid-air when it overlaps nothing in the layer below nor the one below that (one-layer support gap).
// Same method as worker.mjs gcodeStats, plus arcs: G2/G3 moves (arc fitting is on) are followed along the arc
// instead of their chord, which cut across empty space and made the number jump between slices.
export function gcodeStats(text, where = null) {   // where: array that receives [x, y, layer, mm2] per mid-air region
  if (!text) return { midair: null, minutes: null };
  const G = 0.1, R = Math.round(0.21 / G), layers = [];
  let cur = null, x = null, y = null, feat = '';
  const num = (re, line) => { const m = re.exec(line); return m ? +m[1] : null; };
  for (const line of text.split('\n')) {
    if (line.startsWith('; CHANGE_LAYER')) { cur = []; layers.push(cur); continue; }
    if (line.startsWith('; FEATURE:')) { feat = line.slice(10).trim(); continue; }
    const g = line.slice(0, 3);
    if (!cur || !(g === 'G1 ' || g === 'G0 ' || g === 'G2 ' || g === 'G3 ')) continue;
    const nx = num(/X(-?[\d.]+)/, line) ?? x, ny = num(/Y(-?[\d.]+)/, line) ?? y, e = / E([\d.]+)/.test(line);
    if (e && x !== null && feat !== 'Custom' && feat !== 'Prime tower') {
      if (g === 'G2 ' || g === 'G3 ') {
        const cx = x + (num(/I(-?[\d.]+)/, line) || 0), cy = y + (num(/J(-?[\d.]+)/, line) || 0), r = Math.hypot(x - cx, y - cy);
        let a0 = Math.atan2(y - cy, x - cx), a1 = Math.atan2(ny - cy, nx - cx);
        if (g === 'G3 ' && a1 <= a0) a1 += 2 * Math.PI;   // counter-clockwise
        if (g === 'G2 ' && a1 >= a0) a1 -= 2 * Math.PI;   // clockwise
        const n = Math.max(2, Math.ceil((Math.abs(a1 - a0) * r) / 0.2));
        let px = x, py = y;
        for (let q = 1; q <= n; q++) { const a = a0 + ((a1 - a0) * q) / n, qx = cx + r * Math.cos(a), qy = cy + r * Math.sin(a); cur.push(px, py, qx, qy); px = qx; py = qy; }
      } else cur.push(x, y, nx, ny);
    }
    x = nx; y = ny;
  }
  const key = (i, j) => i * 100000 + j;
  const raster = (segs) => {
    const s = new Set();
    for (let k = 0; k < segs.length; k += 4) {
      const [x1, y1, x2, y2] = [segs[k], segs[k + 1], segs[k + 2], segs[k + 3]];
      const n = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / (G / 2)));
      for (let q = 0; q <= n; q++) {
        const ci = Math.round((x1 + (x2 - x1) * q / n) / G), cj = Math.round((y1 + (y2 - y1) * q / n) / G);
        for (let a = -R; a <= R; a++) for (let b = -R; b <= R; b++) if (a * a + b * b <= R * R) s.add(key(ci + a, cj + b));
      }
    }
    return s;
  };
  let prev = null, prev2 = new Set(), mid = 0;
  for (const L of layers) {
    const occ = raster(L);
    if (prev) {
      const seen = new Set();
      for (const c of occ) {
        if (seen.has(c)) continue;
        const stack = [c], comp = []; seen.add(c); let touch = false;
        while (stack.length) {
          const p = stack.pop(); comp.push(p);
          if (prev.has(p) || prev2.has(p)) touch = true;
          for (const d of [100000, -100000, 1, -1]) { const q = p + d; if (occ.has(q) && !seen.has(q)) { seen.add(q); stack.push(q); } }
        }
        if (!touch) { mid += comp.length * G * G; if (where) where.push([Math.floor(comp[0] / 100000) * G, (comp[0] % 100000) * G, layers.indexOf(L), comp.length * G * G]); }
      }
    }
    prev2 = prev || new Set(); prev = occ;
  }
  const t = /total estimated time: (?:(\d+)h )?(?:(\d+)m )?(\d+)s/.exec(text);
  return { midair: Math.round(mid * 10) / 10, minutes: t ? Math.round(((+t[1] || 0) * 3600 + (+t[2] || 0) * 60 + +t[3]) / 6) / 10 : null };
}
