import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'node:fs';
const data = new Uint8Array(fs.readFileSync(process.argv[2]));
const doc = await getDocument({ data, useSystemFonts: true, verbosity: 0 }).promise;
const page = await doc.getPage(1);
const vp = page.getViewport({ scale: 1 });
console.log('viewport', vp.width, vp.height, vp.transform);
const tc = await page.getTextContent();
console.log('text items', tc.items.length);
console.log(JSON.stringify(tc.items.slice(0, 3), null, 0));
console.log(JSON.stringify(tc.items.filter(i => Math.abs(i.transform[1]) > 0.1).slice(0, 3)));
const ol = await page.getOperatorList();
const names = Object.fromEntries(Object.entries(OPS).map(([k, v]) => [v, k]));
const cnt = {};
for (const f of ol.fnArray) cnt[names[f]] = (cnt[names[f]] || 0) + 1;
console.log(cnt);
let shown = 0;
for (let i = 0; i < ol.fnArray.length && shown < 6; i++) {
  if (names[ol.fnArray[i]] === 'constructPath') {
    const a = ol.argsArray[i];
    console.log('constructPath args:', a.length, a.map(x => x === null ? 'null' : (x.constructor ? x.constructor.name : typeof x)),
      'a0=', a[0], names[a[0]], 'a1=', a[1] && Array.from(a[1][0] ? a[1][0].slice?.(0, 16) ?? a[1] : a[1]).slice(0,16), 'a2=', a[2] && Array.from(a[2]));
    shown++;
  }
}
for (const n of ['setLineWidth', 'transform', 'setDash', 'setStrokeRGBColor', 'setFillRGBColor', 'save', 'restore','setStrokeColor','setStrokeGray']) {
  const i = ol.fnArray.findIndex(f => names[f] === n);
  if (i >= 0) console.log(n, JSON.stringify(ol.argsArray[i]));
}
