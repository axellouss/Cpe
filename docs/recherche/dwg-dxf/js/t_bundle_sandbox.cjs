// Sanity check: run the esbuild *browser* bundle of acad-ts inside a bare vm context that only has browser-like globals
// (no require, no process, no Buffer, no fs). Not a real browser test, but proves there is no hidden Node dependency.
// usage: node t_bundle_sandbox.cjs bundle/acad-ts-dwg-dxf.min.js file.dwg
const vm = require('vm'), fs = require('fs')
const [bundle, file] = process.argv.slice(2)
const code = fs.readFileSync(bundle, 'utf8').replace(/^export\s*\{[^}]*\};?\s*$/m, '')
const sandbox = { TextDecoder, TextEncoder, console, crypto: globalThis.crypto, performance, URL, setTimeout }
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(code, sandbox)
const [DwgReader] = sandbox.x
const b = fs.readFileSync(file)
const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
const t = Date.now()
const doc = vm.runInContext('(ab) => x[0].readFromStream(ab, () => {})', sandbox)(ab)
console.log(`bare-sandbox bundle OK: ${[...doc.modelSpace.entities].length} model-space entities, version ${doc.header.versionString}, ${Date.now() - t} ms`)
