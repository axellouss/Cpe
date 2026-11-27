// Spike: read DWG with @isopodlabs/dwg (MIT-declared, pure TypeScript; class names DRW_* resemble libdxfrw)
// usage: node t_isopod.cjs file1.dwg ...
const { readFileSync } = require('node:fs')
const { basename } = require('node:path')
const { DWG, DXF } = require('@isopodlabs/dwg')

;(async () => {
  for (const file of process.argv.slice(2)) {
    const t1 = performance.now()
    try {
      if (/\.dxf$/i.test(file)) {
        const dxf = DXF.read(readFileSync(file))
        const counts = {}
        for (const e of dxf.entities) counts[e.constructor.name] = (counts[e.constructor.name] ?? 0) + 1
        console.log(`\n=== ${basename(file)} DXF read ${(performance.now() - t1).toFixed(0)} ms`, JSON.stringify({ version: dxf.version, layers: dxf.layers.size, blocks: dxf.blocks.size, n: dxf.entities.length, counts, unsupported: Object.fromEntries(dxf.unsupported) }).slice(0, 900))
        continue
      }
      const dwg = new DWG(new Uint8Array(readFileSync(file)))
      const ok = await dwg.ready
      if (!ok) { console.log(`${basename(file)}: not supported (ready=false)`); continue }
      const c = await dwg.contents()
      const dt = performance.now() - t1
      const counts = {}
      for (const e of c.entities) counts[e.constructor.name] = (counts[e.constructor.name] ?? 0) + 1
      console.log(`\n=== ${basename(file)} read ${dt.toFixed(0)} ms`, JSON.stringify({
        version: dwg.version, INSUNITS: dwg.vars?.INSUNITS, MEASUREMENT: dwg.vars?.MEASUREMENT,
        layers: [...c.layers.keys()].slice(0, 12), nBlocks: c.blocks.size, n: c.entities.length, counts, unsupported: Object.fromEntries(c.unsupported)
      }).slice(0, 1400))
      if (process.env.SAMPLE) {
        const seen = new Set()
        for (const e of c.entities) {
          const n = e.constructor.name
          if (seen.has(n)) continue
          seen.add(n)
          if (/INSERT|DIMENSION|HATCH|LWPOLY|TEXT/.test(n)) console.log('  sample', n, JSON.stringify(e, (k, v) => (typeof v === 'bigint' ? Number(v) : v)).slice(0, 700))
        }
      }
      await dwg.close()
    } catch (e) {
      console.log(`${basename(file)}: EXCEPTION after ${(performance.now() - t1).toFixed(0)} ms: ${String(e?.message ?? e).slice(0, 300)}`)
    }
  }
})()
