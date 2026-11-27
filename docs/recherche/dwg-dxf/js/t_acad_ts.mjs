// Spike: read DWG / DXF with @node-projects/acad-ts (MIT, pure TypeScript port of ACadSharp)
// usage: node t_acad_ts.mjs file1.dwg file2.dxf ...
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
const t0 = performance.now()
const acad = await import('@node-projects/acad-ts')
console.log(`module import: ${(performance.now() - t0).toFixed(0)} ms`)
const { DwgReader, DxfReader } = acad

function safe(fn, d = undefined) { try { return fn() } catch (e) { return d ?? `ERR:${e.message}` } }

for (const file of process.argv.slice(2)) {
  const buf = readFileSync(file)
  const isDxf = /\.dxf$/i.test(file)
  const notes = []
  const t1 = performance.now()
  try {
    const doc = isDxf
      ? DxfReader.readFromStream(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), (s, e) => notes.push(e.message))
      : DwgReader.readFromStream(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), (s, e) => notes.push(e.message))
    const t2 = performance.now()
    const counts = {}
    const ents = [...doc.modelSpace.entities]
    for (const e of ents) counts[e.constructor.name] = (counts[e.constructor.name] ?? 0) + 1
    const layers = safe(() => [...doc.layers].map(l => l.name), [])
    const blocks = safe(() => [...doc.blockRecords].map(b => `${b.name}(${[...b.entities].length})`), [])
    const h = doc.header
    console.log(`\n=== ${basename(file)} (${buf.length} bytes) read ${(t2 - t1).toFixed(0)} ms; notifications=${notes.length}`)
    console.log(JSON.stringify({
      version: safe(() => h.versionString ?? h.version),
      insUnits: safe(() => h.insUnits), measurementUnits: safe(() => h.measurementUnits),
      linearUnitFormat: safe(() => h.linearUnitFormat),
      extMin: safe(() => h.modelSpaceExtMin), extMax: safe(() => h.modelSpaceExtMax),
      nLayers: layers.length, layers: layers.slice(0, 12), nBlocks: blocks.length, blocks: blocks.slice(0, 12),
      nEntities: ents.length, counts
    }))
    if (notes.length) console.log('  first notifications:', notes.slice(0, 4))
    if (process.env.SAMPLE) {
      const want = process.env.SAMPLE.split(',')
      const seen = new Set()
      for (const e of ents) {
        const n = e.constructor.name
        if (seen.has(n) || !(want.includes(n) || want.includes('all'))) continue
        seen.add(n)
        const o = {}
        for (const k of Object.keys(e)) {
          const v = e[k]
          if (v == null || typeof v === 'function') continue
          if (typeof v === 'object') {
            if (k.startsWith('_owner') || k === 'owner' || k === '_document') continue
            o[k] = safe(() => JSON.stringify(v, (kk, vv) => (kk.startsWith('_owner') || kk === 'owner' || kk === '_document' || kk === 'document') ? undefined : vv).slice(0, 220), '[obj]')
          } else o[k] = v
        }
        console.log('  sample', n, JSON.stringify(o).slice(0, 1500))
        if (n === 'Insert') {
          console.log('    block name:', safe(() => e.block?.name), 'insertPoint:', JSON.stringify(e.insertPoint), 'scale', e.xScale, e.yScale, 'rot', e.rotation,
            'attributes:', safe(() => [...e.attributes].map(a => `${a.tag}=${a.value}`)))
        }
        if (/Dimension/.test(n)) console.log('    measurement:', safe(() => e.measurement), 'text:', safe(() => e.text))
        if (n === 'Hatch') console.log('    paths:', safe(() => e.paths.length), safe(() => e.paths[0].edges.map(x => x.constructor.name).join(',')))
        if (n === 'LwPolyline') console.log('    closed:', safe(() => e.isClosed), 'vertices:', safe(() => e.vertices.length), safe(() => JSON.stringify(e.vertices[0])))
      }
    }
  } catch (err) {
    console.log(`${basename(file)}: EXCEPTION after ${(performance.now() - t1).toFixed(0)} ms: ${err?.message ?? err}`)
    if (process.env.STACK) console.log(err.stack)
  }
}
