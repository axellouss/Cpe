// Spike: compare pure-JS DXF parsers on the same files.
// usage: node t_dxf_parsers.mjs file1.dxf ...   (DETAIL=1 prints first INSERT / DIMENSION / HATCH of each parser)
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

const parsers = {}

// 1. dxf-parser (MIT, gdsestimating) -- last release 2022
try {
  const DxfParser = require('dxf-parser')
  const P = DxfParser.default ?? DxfParser.DxfParser ?? DxfParser
  parsers['dxf-parser'] = txt => {
    const d = new P().parseSync(txt)
    return { ents: d.entities, type: e => e.type, header: d.header, layers: Object.keys(d.tables?.layer?.layers ?? {}), blocks: Object.keys(d.blocks ?? {}) }
  }
} catch (e) { console.log('dxf-parser load failed', e.message) }

// 2. dxf (MIT, skymakerolof)
try {
  const dxf = require('dxf')
  parsers['dxf'] = txt => {
    const d = dxf.parseString(txt)
    return { ents: d.entities, type: e => e.type, header: d.header, layers: Object.keys(d.tables?.layers ?? {}), blocks: (d.blocks ?? []).map(b => b.name) }
  }
} catch (e) { console.log('dxf load failed', e.message) }

// 3. @dxfom/dxf (GPL-3.0) -- low level group-code tree
try {
  const m = await import('@dxfom/dxf')
  parsers['@dxfom/dxf'] = txt => {
    const d = m.parseDxfFileString(txt)
    const ents = d.ENTITIES ?? []
    return { ents, type: e => (m.getGroupCodeValue ? m.getGroupCodeValue(e, 0) : e[0]?.[1]), header: d.HEADER, layers: (d.TABLES?.LAYER ?? []).map(l => m.getGroupCodeValue?.(l, 2)), blocks: Object.keys(d.BLOCKS ?? {}) }
  }
} catch (e) { console.log('@dxfom/dxf load failed', e.message) }

// 4. dxf-json (GPL-3.0, dotoritos-kim) and 5. @mlightcad/dxf-json (GPL-3.0 fork)
for (const name of ['dxf-json', '@mlightcad/dxf-json']) {
  try {
    const m = await import(name)
    const P = m.DxfParser ?? m.default?.DxfParser ?? m.default
    parsers[name] = txt => {
      const d = new P().parseSync(txt)
      return { ents: d.entities, type: e => e.type, header: d.header, layers: Object.keys(d.tables?.LAYER?.entries ?? {}).length ? (d.tables.LAYER.entries.map?.(l => l.name) ?? Object.keys(d.tables.LAYER.entries)) : [], blocks: Object.keys(d.blocks ?? {}) }
    }
  } catch (e) { console.log(name, 'load failed', e.message) }
}

function pick(h, k) { if (!h) return undefined; return h[k] ?? h['$' + k] ?? h[k.replace('$', '')] }

for (const file of process.argv.slice(2)) {
  const buf = readFileSync(file)
  // NOTE: naive decoding. Pre-2007 DXF uses $DWGCODEPAGE (ANSI_1252 typical); AC1021+ is UTF-8.
  const head = buf.subarray(0, 4000).toString('latin1')
  const ver = /\$ACADVER\s+1\s+(AC\d+)/.exec(head)?.[1]
  const txt = ver && ver >= 'AC1021' ? buf.toString('utf8') : buf.toString('latin1')
  console.log(`\n##### ${basename(file)} (${(buf.length / 1e6).toFixed(2)} MB, ${ver})`)
  for (const [name, fn] of Object.entries(parsers)) {
    const t1 = performance.now()
    try {
      const r = fn(txt)
      const dt = performance.now() - t1
      const counts = {}
      for (const e of r.ents) { const t = r.type(e); counts[t] = (counts[t] ?? 0) + 1 }
      console.log(`  ${name.padEnd(20)} ${dt.toFixed(0).padStart(5)} ms  n=${r.ents.length} layers=${r.layers.length} blocks=${r.blocks.length} INSUNITS=${JSON.stringify(pick(r.header, '$INSUNITS'))} MEAS=${JSON.stringify(pick(r.header, '$MEASUREMENT'))}  ${JSON.stringify(counts).slice(0, 330)}`)
      if (process.env.DETAIL) {
        for (const T of ['INSERT', 'DIMENSION', 'HATCH', 'LWPOLYLINE']) {
          const e = r.ents.find(x => r.type(x) === T)
          if (e) console.log(`      ${T}: ${JSON.stringify(e).slice(0, 520)}`)
        }
      }
    } catch (e) {
      console.log(`  ${name.padEnd(20)} FAILED after ${(performance.now() - t1).toFixed(0)} ms: ${String(e?.message ?? e).slice(0, 160)}`)
    }
  }
}
