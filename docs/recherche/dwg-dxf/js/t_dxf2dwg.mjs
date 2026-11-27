// Spike: write a DWG from a DXF with @node-projects/acad-ts (MIT) so that the ezdxf fixtures can also be tested as DWG.
// usage: node t_dxf2dwg.mjs in.dxf out.dwg [AC1032|AC1027|AC1024|AC1018|AC1015]
import { readFileSync, writeFileSync } from 'node:fs'
import { DxfReader, DwgWriter, ACadVersion } from '@node-projects/acad-ts'
const [src, dst, ver] = process.argv.slice(2)
const buf = readFileSync(src)
const notes = []
const doc = DxfReader.readFromStream(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), (s, e) => notes.push(e.message))
if (ver) doc.header.version = ACadVersion[ver]
const t = performance.now()
const out = DwgWriter.writeToBuffer(doc, (s, e) => notes.push(e.message))
writeFileSync(dst, Buffer.from(out))
console.log(`${src} -> ${dst}: ${out.byteLength} bytes in ${(performance.now() - t).toFixed(0)} ms, version ${doc.header.versionString}, notifications ${notes.length}`)
if (notes.length) console.log('  e.g.', notes.slice(0, 3))
