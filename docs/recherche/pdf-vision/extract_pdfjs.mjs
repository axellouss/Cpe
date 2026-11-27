// extract_pdfjs.mjs - same IR as extract_py.py but produced with pdf.js (pdfjs-dist 6.x, runs unchanged
// in a browser: only the file reading differs).  Usage: node extract_pdfjs.mjs <pdf> <out.json>
// IR coordinates: PDF points, origin top-left, y down (we apply the page viewport transform at scale 1).
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'node:fs';

const DRAW = { moveTo: 0, lineTo: 1, curveTo: 2, quadraticCurveTo: 3, closePath: 4 };
const mul = (m, n) => [ // m after n  (apply n first, then m): pdf "cm" semantics ctm' = ctm x n
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

function bezier(p0, p1, p2, p3, n = 8) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, mt = 1 - t;
    out.push([mt ** 3 * p0[0] + 3 * mt * mt * t * p1[0] + 3 * mt * t * t * p2[0] + t ** 3 * p3[0],
      mt ** 3 * p0[1] + 3 * mt * mt * t * p1[1] + 3 * mt * t * t * p2[1] + t ** 3 * p3[1]]);
  }
  return out;
}

export async function extractPage(page) {
  const vp = page.getViewport({ scale: 1 });
  const V = vp.transform; // user space (y up) -> top-left (y down)
  // ---------- text ----------
  const tc = await page.getTextContent({ disableNormalization: false });
  const texts = [];
  for (const it of tc.items) {
    if (!it.str || !it.str.trim()) continue;
    const [a, b, , , e, f] = it.transform;
    const size = Math.hypot(a, b);
    const ang = Math.atan2(b, a); // PDF space, y up
    const ux = Math.cos(ang), uy = Math.sin(ang);
    // corners of the run box in user space: origin on baseline, width along u, height along n (up)
    const nx = -uy, ny = ux;
    const pts = [[e, f], [e + ux * it.width, f + uy * it.width],
      [e + ux * it.width + nx * size, f + uy * it.width + ny * size], [e + nx * size, f + ny * size]]
      .map(([x, y]) => apply(V, x, y));
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    // reading direction in the DISPLAY frame (the viewport includes /Rotate): transform the direction vector
    const dxv = V[0] * ux + V[2] * uy, dyv = V[1] * ux + V[3] * uy;
    const angDisp = Math.atan2(-dyv, dxv); // y down -> flip so that 90 = reads bottom-to-top
    texts.push({ s: it.str.trim(), x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2,
      angle: Math.round(angDisp * 1800 / Math.PI) / 10, size, font: it.fontName });
  }
  // ---------- vector paths ----------
  const ol = await page.getOperatorList();
  const segs = [];
  let ctm = [1, 0, 0, 1, 0, 0], lw = 1, dash = false;
  const stack = [];
  let pid = 0;
  const STROKING = new Set([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const FILLING = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const CLOSING = new Set([OPS.closeStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  for (let i = 0; i < ol.fnArray.length; i++) {
    const fn = ol.fnArray[i], args = ol.argsArray[i];
    switch (fn) {
      case OPS.save: stack.push({ ctm, lw, dash }); break;
      case OPS.restore: { const s = stack.pop(); if (s) ({ ctm, lw, dash } = s); break; }
      case OPS.transform: ctm = mul(ctm, args); break;
      case OPS.setLineWidth: lw = args[0]; break;
      case OPS.setDash: dash = Array.isArray(args[0]) && args[0].length > 0; break;
      case OPS.paintFormXObjectBegin: stack.push({ ctm, lw, dash }); if (args[0]) ctm = mul(ctm, args[0]); break;
      case OPS.paintFormXObjectEnd: { const s = stack.pop(); if (s) ({ ctm, lw, dash } = s); break; }
      case OPS.constructPath: {
        const paintOp = args[0], data = args[1] && args[1][0];
        if (!data) break;
        const stroke = STROKING.has(paintOp), fill = FILLING.has(paintOp);
        if (!stroke && !fill) break; // endPath / clip only
        const M = mul(V, ctm);
        const scale = Math.sqrt(Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]));
        const w = stroke ? lw * scale : 0;
        let cur = null, start = null;
        const push = (p, q, kind) => segs.push({ x0: p[0], y0: p[1], x1: q[0], y1: q[1], w, kind, stroke, fill, pid, dash });
        for (let k = 0; k < data.length;) {
          const op = data[k++];
          if (op === DRAW.moveTo) { cur = start = apply(M, data[k], data[k + 1]); k += 2; }
          else if (op === DRAW.lineTo) { const p = apply(M, data[k], data[k + 1]); k += 2; push(cur, p, 'l'); cur = p; }
          else if (op === DRAW.curveTo) {
            const p1 = apply(M, data[k], data[k + 1]), p2 = apply(M, data[k + 2], data[k + 3]), p3 = apply(M, data[k + 4], data[k + 5]); k += 6;
            const pts = bezier(cur, p1, p2, p3);
            for (let j = 0; j < pts.length - 1; j++) push(pts[j], pts[j + 1], 'c');
            cur = p3;
          } else if (op === DRAW.quadraticCurveTo) {
            const p1 = apply(M, data[k], data[k + 1]), p2 = apply(M, data[k + 2], data[k + 3]); k += 4;
            const c1 = [cur[0] + 2 / 3 * (p1[0] - cur[0]), cur[1] + 2 / 3 * (p1[1] - cur[1])];
            const c2 = [p2[0] + 2 / 3 * (p1[0] - p2[0]), p2[1] + 2 / 3 * (p1[1] - p2[1])];
            const pts = bezier(cur, c1, c2, p2);
            for (let j = 0; j < pts.length - 1; j++) push(pts[j], pts[j + 1], 'c');
            cur = p2;
          } else if (op === DRAW.closePath) {
            if (cur && start && (cur[0] !== start[0] || cur[1] !== start[1])) push(cur, start, 'l');
            cur = start;
          } else { throw new Error('unknown draw op ' + op); }
        }
        if (CLOSING.has(paintOp) && cur && start && (cur[0] !== start[0] || cur[1] !== start[1])) push(cur, start, 'l');
        pid++;
        break;
      }
      default: break;
    }
  }
  return { width: vp.width, height: vp.height, texts, segs };
}

if (process.argv[1] && process.argv[1].endsWith('extract_pdfjs.mjs')) {
  const [pdf, out] = process.argv.slice(2);
  const t0 = performance.now();
  const data = new Uint8Array(fs.readFileSync(pdf));
  const doc = await getDocument({ data, useSystemFonts: true, verbosity: 0 }).promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) pages.push(await extractPage(await doc.getPage(n)));
  const dt = (performance.now() - t0) / 1000;
  fs.writeFileSync(out, JSON.stringify({ backend: 'pdfjs', file: pdf, seconds: +dt.toFixed(3), pages }));
  pages.forEach((p, i) => {
    const ws = [...new Set(p.segs.map(s => s.w.toFixed(2)))].sort();
    console.log(`[pdfjs] page ${i + 1}: ${p.texts.length} texts, ${p.segs.length} segs, widths(pt)=[${ws}], rotated texts=${p.texts.filter(t => Math.abs(t.angle) > 1).length}`);
  });
  console.log(`[pdfjs] ${dt.toFixed(3)}s`);
}
