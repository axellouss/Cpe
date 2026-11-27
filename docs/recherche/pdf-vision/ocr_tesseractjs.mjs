// ocr_tesseractjs.mjs - browser-capable OCR (tesseract.js = Tesseract compiled to WASM) on the synthetic scans.
// Language data comes from the npm packages @tesseract.js-data/{fra,deu} (no CDN needed).
import { createWorker, PSM } from 'tesseract.js';
import path from 'node:path';
import fs from 'node:fs';
const truth = JSON.parse(fs.readFileSync('fixtures/fr_A3_1-100.truth.json'));
const norm = s => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, '');
const langPath = path.resolve('node_modules/@tesseract.js-data/fra/4.0.0_best_int');
for (const img of process.argv.slice(2)) {
  const t0 = performance.now();
  const worker = await createWorker('fra', 1, { langPath, cachePath: path.resolve('out'), gzip: true });
  await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
  const { data } = await worker.recognize(img);
  await worker.terminate();
  const text = data.text;
  const toks = text.split(/\s+/).filter(Boolean);
  const ntext = norm(text);
  const rooms = truth.pages[0].views.flatMap(v => v.rooms ?? []);
  const names = rooms.filter(r => ntext.includes(norm(r.name))).length;
  const areas = rooms.filter(r => r.area_label).filter(r => text.includes(r.area_label.match(/\d+,\d+/)[0])).length;
  const nAreas = rooms.filter(r => r.area_label).length;
  const dims = truth.pages[0].views.flatMap(v => v.dims ?? []).filter(d => d.axis === 'x');
  const want = [...new Set(dims.map(d => d.text))];
  const got = want.filter(v => toks.includes(v)).length;
  console.log(`${img}: ${(performance.now() - t0) / 1000 | 0} s | room names ${names}/${rooms.length} | area labels ${areas}/${nAreas} | distinct horizontal dim values ${got}/${want.length} | scale ${/1\s*[:/]\s*100/.test(text) ? 'yes' : 'NO'}`);
}
