// size of what a browser has to download for web-ifc (raw / gzip / brotli)
import fs from 'node:fs'; import zlib from 'node:zlib'; import path from 'node:path';
const dir = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'node_modules/web-ifc');
const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json')));
console.log('web-ifc', pkg.version, 'license:', pkg.license);
for (const f of ['web-ifc.wasm', 'web-ifc-mt.wasm', 'web-ifc-node.wasm', 'web-ifc-api.js', 'web-ifc-api-iife.js', 'web-ifc-api-node.js']) {
  const b = fs.readFileSync(path.join(dir, f));
  const gz = zlib.gzipSync(b, { level: 9 }).length;
  const br = zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
  console.log(f.padEnd(22), 'raw', (b.length / 1024).toFixed(0).padStart(6), 'KiB | gzip', (gz / 1024).toFixed(0).padStart(5), 'KiB | brotli', (br / 1024).toFixed(0).padStart(5), 'KiB');
}
