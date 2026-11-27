// Spike: read DWG (and DXF) with @mlightcad/libredwg-web (LibreDWG compiled to WASM, GPL-3.0)
// usage: node t_libredwg_web.mjs file1.dwg file2.dxf ...
import { readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Dwg_File_Type, LibreDwg } from '@mlightcad/libredwg-web'

const here = dirname(fileURLToPath(import.meta.url))
const wasmDir = join(here, 'node_modules/@mlightcad/libredwg-web/wasm/')

const t0 = performance.now()
const libredwg = await LibreDwg.create(wasmDir)
const tInit = performance.now() - t0
console.log(`WASM init: ${tInit.toFixed(0)} ms`)

function summarize(db) {
  const counts = {}
  for (const e of db.entities ?? []) counts[e.type] = (counts[e.type] ?? 0) + 1
  const layers = (db.tables?.LAYER?.entries ?? []).map(l => l.name)
  const blocks = (db.tables?.BLOCK_RECORD?.entries ?? []).map(b => `${b.name}(${(b.entities ?? []).length})`)
  const h = db.header ?? {}
  return {
    version: h.ACADVER ?? db.version,
    INSUNITS: h.INSUNITS, MEASUREMENT: h.MEASUREMENT, LUNITS: h.LUNITS, DIMSCALE: h.DIMSCALE, LTSCALE: h.LTSCALE,
    EXTMIN: h.EXTMIN, EXTMAX: h.EXTMAX,
    nLayers: layers.length, layers: layers.slice(0, 12),
    nBlocks: blocks.length, blocks: blocks.slice(0, 12),
    nEntities: (db.entities ?? []).length, counts
  }
}

for (const file of process.argv.slice(2)) {
  const buf = readFileSync(file)
  const isDxf = /\.dxf$/i.test(file)
  const t1 = performance.now()
  let dwg, db
  try {
    dwg = libredwg.dwg_read_data(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), isDxf ? Dwg_File_Type.DXF : Dwg_File_Type.DWG)
    const t2 = performance.now()
    if (!dwg) { console.log(`${basename(file)}: FAILED dwg_read_data returned ${dwg}`); continue }
    db = libredwg.convert(dwg)
    const t3 = performance.now()
    libredwg.dwg_free(dwg)
    console.log(`\n=== ${basename(file)} (${buf.length} bytes) read ${(t2 - t1).toFixed(0)} ms, convert ${(t3 - t2).toFixed(0)} ms`)
    console.log(JSON.stringify(summarize(db)))
    if (process.env.SAMPLE) {
      const seen = new Set()
      for (const e of db.entities) {
        if (seen.has(e.type)) continue
        seen.add(e.type)
        if (process.env.SAMPLE === 'all' || process.env.SAMPLE.split(',').includes(e.type))
          console.log('  sample', e.type, JSON.stringify(e).slice(0, 900))
      }
    }
  } catch (err) {
    console.log(`${basename(file)}: EXCEPTION ${err?.message ?? err}`)
  }
}
