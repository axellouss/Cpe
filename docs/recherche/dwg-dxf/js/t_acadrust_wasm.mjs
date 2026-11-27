// Spike: DWG -> DXF conversion with acadrust-based WASM packages (dwgdxf = MIT wrapper, dwg-to-dxf = MPL-2.0 fork)
// usage: node t_acadrust_wasm.mjs <outdir> file1.dwg ...
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'

const outdir = process.argv[2]
mkdirSync(outdir, { recursive: true })
const files = process.argv.slice(3)

const pkgs = {}
for (const name of ['dwgdxf', 'dwg-to-dxf']) {
  try {
    const t0 = performance.now()
    const m = await import(name)
    await m.init()
    pkgs[name] = m
    console.log(`${name}: init ${(performance.now() - t0).toFixed(0)} ms`)
  } catch (e) { console.log(`${name}: INIT FAILED ${e.message}`) }
}

for (const file of files) {
  const bytes = new Uint8Array(readFileSync(file))
  for (const [name, m] of Object.entries(pkgs)) {
    const t1 = performance.now()
    try {
      const dxf = await m.convertDwgToDxf(bytes)
      const dt = performance.now() - t1
      const out = join(outdir, `${basename(file, '.dwg')}.${name}.dxf`)
      writeFileSync(out, dxf)
      const txt = Buffer.from(dxf).toString('latin1')
      const ents = {}
      // crude count of entity records inside ENTITIES section
      const sec = txt.split(/\r?\n\s*2\r?\nENTITIES\r?\n/)[1]?.split(/\r?\n\s*0\r?\nENDSEC/)[0] ?? ''
      for (const mm of sec.matchAll(/(?:^|\n)\s*0\r?\n([A-Z_0-9]+)\r?\n/g)) ents[mm[1]] = (ents[mm[1]] ?? 0) + 1
      console.log(`${basename(file)} via ${name}: OK ${dt.toFixed(0)} ms -> ${dxf.length} bytes`, JSON.stringify(ents))
    } catch (e) {
      console.log(`${basename(file)} via ${name}: FAILED ${(performance.now() - t1).toFixed(0)} ms: ${String(e?.message ?? e).slice(0, 200)}`)
    }
  }
}
