// Spike: read DWG with @mlightcad/libdxfrw-web (libdxfrw WASM, GPL-2.0-only declared; unmaintained since 2025-03)
const { readFileSync } = require('node:fs')
const { basename, join } = require('node:path')
const createModule = require('@mlightcad/libdxfrw-web/dist/libdxfrw.js')
;(async () => {
  const t0 = performance.now()
  const lib = await (createModule.default ?? createModule)({ locateFile: f => join(__dirname, 'node_modules/@mlightcad/libdxfrw-web/dist', f) })
  console.log('init', (performance.now() - t0).toFixed(0), 'ms')
  const etypes = Object.fromEntries(Object.entries(lib.DRW_ETYPE).filter(([k, v]) => v && typeof v.value === 'number').map(([k, v]) => [v.value, k]))
  for (const file of process.argv.slice(2)) {
    const buf = readFileSync(file)
    const t1 = performance.now()
    try {
      const database = new lib.DRW_Database()
      const fileHandler = new lib.DRW_FileHandler()
      fileHandler.database = database
      const content = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
      const isDxf = /\.dxf$/i.test(file)
      const rdr = isDxf ? new lib.DRW_DxfRW(content) : new lib.DRW_DwgR(content)
      const ok = rdr.read(fileHandler, false)
      const dt = performance.now() - t1
      const ents = fileHandler.database.mBlock.entities
      const counts = {}
      for (let i = 0, n = ents.size(); i < n; i++) { const e = ents.get(i); const k = etypes[e.eType.value] ?? e.eType.value; counts[k] = (counts[k] ?? 0) + 1 }
      console.log(`${basename(file)}: ok=${ok} ${dt.toFixed(0)} ms n=${ents.size()} ${JSON.stringify(counts).slice(0, 500)}`)
    } catch (e) { console.log(`${basename(file)}: EXCEPTION ${(performance.now() - t1).toFixed(0)} ms ${String(e?.message ?? e).slice(0, 200)}`) }
  }
})()
