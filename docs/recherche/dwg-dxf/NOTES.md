# Reading architects' DWG / DXF files - research notes

Date of the tests: 2026-11-27. Linux container, Node 22.23.5, Python 3.13.18, 4 CPUs.
Everything below marked **[RUN]** was proved by running code in this directory; **[DOC]** comes from the package's own
README / registry metadata; **[WEB]** from a web search result (page not opened by me); **[MEM]** is from memory, not verified.

Directory layout

```
js/                     node_modules + spike scripts (t_*.mjs / t_*.cjs), js/bundle/ = esbuild browser bundles
py/                     venv + spike scripts (make_fixture.py, extract_plan.py, test_variants.py ...)
fixtures/               the generated floor-plan fixtures + fixture_truth.json
samples/libredwg/       LibreDWG test DWGs R13 ... 2018 (downloaded)
samples/probe/          other real DXF / DWG test files (downloaded)
samples/real/           mlight_canteen.dwg = a real 2.6 MB architectural DWG (R2007)
out/                    converted files, extractor JSON + PNG overlays, variants table
```

---------------------------------------------------------------------------------------------------------------------

## 1. Candidates - what exists, installs and works

### 1.1 Summary table (all rows [RUN] unless stated)

| package (version tested) | kind | licence (declared) | DWG R13/R14/2000/2004/2007/2010/2013/2018 | real 2.6 MB DWG (25 123 entities) | size shipped to a browser | verdict |
|---|---|---|---|---|---|---|
| `@node-projects/acad-ts` 3.10.0 | pure TypeScript port of ACadSharp, reads + writes DWG and DXF | MIT | all 8 OK | OK, 0.8-0.9 s | 1.01 MB min, **211 KB gzip**, no WASM | **best fit for a closed-source browser app** |
| `dwg-to-dxf` 0.1.2 | acadrust (Rust) compiled to WASM, DWG -> DXF text | MPL-2.0 (glue MIT) | all 8 OK | OK, 0.39 s -> 14.8 MB DXF | 3.37 MB wasm, 1.18 MB gzip, 0.89 MB brotli | good second engine / fallback |
| `@mlightcad/libredwg-web` 0.9.4 | GNU LibreDWG compiled to WASM, typed JSON-like DB | **GPL-3.0** | all 8 OK | OK, 0.20 s read + 0.67 s convert | 7.85 MB wasm, 2.03 MB gzip, 1.09 MB brotli (+ 58 KB JS gzip) | most mature decoder, but GPL |
| `@mlightcad/libredwg-converter` 3.16.5 | wrapper of the above for the "RealDWG-Web" data model, Web-Worker only | GPL-3.0 | (same WASM) | not run separately | same WASM | only useful with the mlightcad viewer stack |
| `@isopodlabs/dwg` 1.2.1 | pure TypeScript | MIT (declared; class names `DRW_*` look like libdxfrw, which is GPL-2+ - provenance not verified) | all 8 OK | OK but **5.8 s** | 175 KB min, 53 KB gzip | crashes on 2 of my files, slow on R2007 |
| `dwgdxf` 2.0.1 | older acadrust 0.4 WASM | MIT wrapper (core is MPL-2.0) | converts all 8, **with bugs** | 1.76 s -> **80 MB** DXF | 0.82 MB wasm | do not use (see 1.4) |
| `@mlightcad/libdxfrw-web` 0.1.0 | libdxfrw WASM | GPL-2.0-only | partial (returns ok=false on several, drops HATCH etc.) | **FAILS: 0 entities** | 1.45 MB wasm | reject |
| `libredwg-web` (unscoped) | - | - | - | - | - | **does not exist on npm** (404) |
| `dxf-parser` 1.1.2 (2022) | pure JS DXF only | MIT | - | parses converted 14.8 MB DXF in 0.22 s | 26 KB min, 7.8 KB gzip | drops HATCH, ATTRIB, LEADER, VIEWPORT silently |
| `dxf` 5.3.1 | pure JS DXF only | MIT | - | 0.35 s | 95 KB min | has HATCH + ATTRIB; DIMENSION has no measured value |
| `@dxfom/dxf` 0.2.0 (2023) | low-level group-code tree | GPL-3.0 | - | 0.24 s | 1.4 KB | complete but raw; GPL |
| `dxf-json` 0.18.0 | typed DXF parser | GPL-3.0 | - | 0.50 s | 92 KB min | complete; GPL |
| `@mlightcad/dxf-json` 1.2.8 | fork of the above | GPL-3.0 | - | **72 s** on the 14.8 MB DXF | - | performance bug, GPL |
| Python `ezdxf` 1.4.5 | DXF read/write, pure Python | MIT | no DWG (its `addons.dwg` is a stub: fails on every file) | reads converted DXF in 1.4 s | - | **backend DXF library of choice** |
| Python `ezdwg` 0.22.0 | Rust core + Python API, reads DWG R13-2018 | MIT | r14/2000/2007/2018 OK | OK, 0.53 s native read | - | promising, immature (see 1.4) |
| `ezdxf.addons.odafc` | drives the proprietary ODA File Converter | ezdxf MIT; converter proprietary | all (per ODA) | **not runnable here** | - | documented only (see 1.6) |
| LibreDWG native (`dwgread`, `dwg2dxf`) | C library/CLI | GPL-3.0-or-later | same code as the WASM build | not installed here (no apt package in Ubuntu 24.04 cache) | - | fine for a server (no distribution) |

Not tested: DWG older than R13 (R12, R11 ...). I found no sample; LibreDWG and acad-ts both claim some pre-R13 support [DOC].
AutoCAD has written the "2018" format (AC1032) from release 2018 onwards [MEM], so AC1032 is the format to expect from current
AutoCAD / BricsCAD / Archicad exports; older archives will be AC1015 ... AC1027.

### 1.2 Commands that worked

```bash
# JS
cd js && npm init -y
npm install @mlightcad/libredwg-web @mlightcad/libredwg-converter @mlightcad/data-model dxf-parser dxf @dxfom/dxf \
            @node-projects/acad-ts dwgdxf dwg-to-dxf @isopodlabs/dwg @mlightcad/libdxfrw-web dxf-json @mlightcad/dxf-json jsts
node t_libredwg_web.mjs ../samples/libredwg/*.dwg           # SAMPLE=INSERT,DIMENSION,HATCH prints example entities
node t_acad_ts.mjs ../samples/libredwg/*.dwg                # SAMPLE=Insert,DimensionAligned,Hatch
node t_acadrust_wasm.mjs ../out/acadrust ../samples/libredwg/*.dwg     # dwgdxf + dwg-to-dxf -> DXF files
node t_isopod.cjs ../samples/libredwg/*.dwg
node t_libdxfrw.cjs ../samples/libredwg/*.dwg
node t_dxf_parsers.mjs ../samples/probe/floorplan_sky.dxf ...          # 5 JS DXF parsers side by side
node t_dxf2dwg.mjs ../fixtures/fixture_rdc_cm.dxf ../out/fixture_rdc_cm.acadts.dwg [AC1032]   # DXF -> DWG with acad-ts
node t_browser_path.mjs ../out/fixture_rdc_cm.acadts_2018.dwg '^MUR$'  # acad-ts + JSTS polygonize, pure JS
node t_bundle_sandbox.cjs bundle/acad-ts-dwg-dxf.min.js ../samples/real/mlight_canteen.dwg

# Python
cd py && python3 -m venv venv && ./venv/bin/pip install ezdxf shapely numpy matplotlib ezdwg
./venv/bin/python make_fixture.py ../fixtures
./venv/bin/python extract_plan.py ../fixtures/fixture_rdc_cm.dxf --png ../out/x.png --json ../out/x.json
PNG=1 WARN=1 ./venv/bin/python test_variants.py ../fixtures ../out/variants
./venv/bin/python -I inspect_dxf.py some.dxf ; ./venv/bin/python -I peek.py some.dxf 60
```

Minimal reading code that worked:

```js
// (a) acad-ts, MIT, pure TS - DWG and DXF
import { DwgReader, DxfReader } from '@node-projects/acad-ts'
const doc = DwgReader.readFromStream(arrayBuffer, (sender, e) => notes.push(e.message))     // DWG: ArrayBuffer
const doc2 = DxfReader.readFromStream(uint8Array, () => {})                                   // DXF: raw BYTES (code page!)
doc.header.insUnits / doc.header.measurementUnits / doc.header.versionString
for (const e of doc.modelSpace.entities) {
  e.constructor.name            // Line, LwPolyline, Insert, TextEntity, MText, DimensionLinear, Hatch ...
  e.layer.name
  // Line: e.startPoint / e.endPoint;  LwPolyline: e.vertices[i].location + .bulge, e.isClosed
  // Insert: e.block.name, e.insertPoint, e.xScale, e.yScale, e.rotation, [...e.attributes].map(a => [a.tag, a.value])
  // Dimension*: e.measurement (computed), e.text (override, '<>' = measured);  Hatch: e.paths[i].edges
}

// (b) LibreDWG WASM, GPL-3
import { Dwg_File_Type, LibreDwg } from '@mlightcad/libredwg-web'
const lib = await LibreDwg.create('./node_modules/@mlightcad/libredwg-web/wasm/')   // dir holding libredwg-web.wasm
const dwg = lib.dwg_read_data(arrayBuffer, Dwg_File_Type.DWG)                      // or Dwg_File_Type.DXF
const db = lib.convert(dwg); lib.dwg_free(dwg)
db.header.INSUNITS, db.tables.LAYER.entries, db.tables.BLOCK_RECORD.entries[i].entities, db.entities
// GOTCHA: db.entities = model space + ALL paper spaces + ATTRIBs flattened. Filter with e.ownerBlockRecordSoftId.

// (c) acadrust WASM, MPL-2.0: DWG bytes -> DXF text, then any DXF reader
import { init, convertDwgToDxf } from 'dwg-to-dxf'
await init(); const dxfBytes = await convertDwgToDxf(new Uint8Array(buf))        // synchronous inside: run in a Worker
```

```python
import ezdxf
from ezdxf import recover
try: doc = ezdxf.readfile(path)
except Exception: doc, auditor = recover.readfile(path)          # tolerant reader for damaged DXF
msp = doc.modelspace(); doc.header.get("$INSUNITS"); doc.header.get("$MEASUREMENT")
ins.dxf.name, ins.dxf.insert, ins.dxf.rotation, ins.dxf.xscale, [(a.dxf.tag, a.dxf.text) for a in ins.attribs]
ins.virtual_entities()                 # block content transformed to WCS (handles mirrored / non-uniform scale)
dim.dxf.get("actual_measurement"), dim.get_measurement(), dim.dxf.text      # stored value, recomputed value, override
mtext.plain_text(); text.plain_text()   # strips \P, {\f...;}, %%u
ezdxf.path.make_path(e).flattening(sag) # LWPOLYLINE bulges / ARC / SPLINE -> vertices

from ezdxf.addons import odafc           # needs the proprietary ODA File Converter installed by the user
odafc.is_installed()                     # False here
doc = odafc.readfile("plan.dwg")         # DWG -> temp DXF -> ezdxf document
# Windows default path [RUN, printed from ezdxf.options]: "C:\Program Files\ODA\ODAFileConverter\ODAFileConverter.exe"
```

### 1.3 What comes out (checked on LibreDWG's example_2018.dwg and on the real files) [RUN]

| | libredwg-web | acad-ts | dwg-to-dxf + ezdxf | ezdwg |
|---|---|---|---|---|
| layers, blocks | yes | yes | yes | yes (entity carries `layer_handle`, not the name) |
| LINE / LWPOLYLINE (bulge) / ARC / CIRCLE | yes | yes | yes | yes |
| INSERT with name, point, scale, rotation | yes | yes | yes | yes |
| ATTRIB values of an INSERT | `insert.attribs[].tag/.text.text` | `insert.attributes[].tag/.value` | `ins.attribs` | ATTRIB as separate entities |
| TEXT / MTEXT | yes (raw MTEXT codes `\P`) | yes (raw codes) | yes, `plain_text()` | yes |
| DIMENSION measured value | `measurement` 1504.6795 (stored) | `measurement` 1504.6798 (recomputed) | `actual_measurement` + recomputed | `actual_measurement` |
| HATCH boundary paths | `boundaryPaths[].edges` | `paths[].edges` | `hatch.paths` | `paths[].points` |
| `$INSUNITS`, `$MEASUREMENT` | yes | yes | yes | `doc.insunits`; `to_dxf()` writes `$INSUNITS=6` whatever the source |
| unsupported objects | silently dropped by `convert()` (HELIX, PDFUNDERLAY -> 0 entities) | reported through the notification callback | kept as raw DXF | - |

All readers agree on the real `canteen.dwg`: 25 123 model-space entities (22 835 LINE, 690 INSERT, 359 LWPOLYLINE, 274 HATCH,
188 MTEXT, 106 TEXT, 28 DIMENSION ...), `$INSUNITS=4`, layers `Wall`, `windows`, `door`, `Axes`, `txt`, `Columns` ...

### 1.4 Timings (single run, warm module, 4 CPU container) [RUN]

| step | canteen.dwg 2.6 MB (R2007) | small 150 KB example |
|---|---|---|
| libredwg-web WASM init | 30-37 ms | |
| libredwg-web read + convert | 197 + 672 ms | 7 + 11 ms |
| acad-ts DwgReader (module import 155 ms) | 818-877 ms | 29 ms |
| dwg-to-dxf (init 12 ms) | 390 ms, output 14.8 MB DXF | 9 ms |
| ... then parse that DXF: dxf-parser / dxf / dxf-json / acad-ts DxfReader / ezdxf | 220 / 349 / 500 / 4 988 / 1 474 ms | |
| dwgdxf | 1 755 ms, output 80 MB DXF | 29 ms |
| @isopodlabs/dwg | 5 765 ms | 22 ms |
| ezdwg (Python) native read | 531 ms | 11 ms |
| whole Python extractor on the converted DXF (load, flatten, polygonize, rooms) | 2.7-2.9 s | 45-90 ms on the fixtures |

Failure modes seen [RUN]
- `libredwg-web` prints `Open dwg file with error code: 4 / 64 / 68` on most files and still returns complete data. These are
  LibreDWG's non-critical warning bits (unhandled class, value out of bounds) [MEM]; treat only a null result as failure.
- `libredwg-web`: `convert()` drops entity types it does not map; `db.entities` mixes model and paper space.
- `acad-ts`: DXF reading is slow on big files (5 s for 14.8 MB) - read the DWG directly instead (0.85 s).
  Project is very young and moves fast (npm `time.modified` 2026-11-25, version 3.10.0): pin the version, keep a regression corpus.
- `dwg-to-dxf`: conversion is synchronous (blocks the thread) and the DXF is 5-6x bigger than the DWG.
- `dwgdxf` (acadrust 0.4): writes `$MEASUREMENT=0` for metric files, **duplicates every entity** for R13/R14 (130 instead of 65),
  duplicate handles in the R2013 output (ezdxf warns), 80 MB output for a 2.6 MB DWG.
- `@isopodlabs/dwg`: `stream: out of bounds` on ACadSharp's `sample_AC1032.dwg`; `0 is not a table or dictionary` on every DWG
  written by acad-ts; 5.8 s on the R2007 file.
- `@mlightcad/libdxfrw-web`: 0 entities on the real R2007 file, 27 of ~160 on ACadSharp's sample.
- `ezdwg.to_dxf()`: explodes DIMENSIONs by default, `$INSUNITS` forced to 6 (metres) although the source says 4, 613 of 690 INSERTs kept.
  Its native `read()` API is correct (insunits 4, 25 123 entities).
- `dxf-parser`: needs the caller to decode the bytes. A pre-2007 DXF is in the `$DWGCODEPAGE` (ANSI_1252 here): read as UTF-8,
  "m²" becomes "m\ufffd"; read as latin1 it is right. It also drops ATTRIB (window attributes lost) and HATCH.
- `ezdxf.addons.dwg`: `DwgVersionError` / returns None - not a usable DWG reader.

### 1.5 Bundle sizes [RUN] (`npx esbuild entry.mjs --bundle --minify --format=esm --platform=browser`, gzip -9, brotli q11)

```
acad-ts (DwgReader + DxfReader)   1 006 267 B   gzip 210 901   brotli 164 066   (no tree-shaking gain: DWG-only is the same size)
@isopodlabs/dwg                     175 346 B   gzip  53 188
dxf-parser                           26 231 B   gzip   7 771
dxf                                  95 492 B   gzip  27 072
dxf-json                             91 636 B   gzip  23 211
libredwg-web JS wrapper             201 685 B   gzip  58 177   + libredwg-web.wasm 7 854 188 B  gzip 2 031 561  brotli 1 085 222
dwg-to-dxf JS                         5 218 B   gzip   2 192   + dwg_to_dxf_bg.wasm 3 366 462 B gzip 1 180 627  brotli   888 041
dwgdxf wasm                         821 610 B   gzip 349 784
libdxfrw.wasm                     1 454 038 B   gzip 490 129
```

The acad-ts browser bundle has no Node imports and ran inside a bare `vm` context that only exposes `TextDecoder`,
`TextEncoder`, `crypto` (Web Crypto) and `console`: 25 123 entities from canteen.dwg in 1.1 s (`t_bundle_sandbox.cjs`).
**Not tested in a real browser** (none available here).

### 1.6 Licences and what they mean for the product (my reading - not legal advice)

- **LibreDWG = GPL-3.0-or-later**, copyright FSF, which refused to relicense [WEB: gnu.org/software/libredwg, Wikipedia].
  `@mlightcad/libredwg-web` and `-converter` are GPL-3.0 [RUN: package.json]. Sending the WASM to the user's browser is
  distribution of GPL object code, so a web app that links it must itself be offered under GPL-3-compatible terms with source.
  A closed-source browser product cannot bundle it. The `libredwg-converter` README says it runs the parser in a separate Web
  Worker bundle "for license isolation" [DOC] - that is the author's legal theory, not an established rule; I would not build a
  commercial product on it without a lawyer. On a **server** GPL-3 code can be used without publishing the application
  (GPL-3 is not AGPL), but then the file leaves the PC.
- **acad-ts = MIT**, port of ACadSharp (MIT) [RUN: LICENSE file; WEB for ACadSharp]. No copyleft: fine for closed or open apps.
- **acadrust = MPL-2.0** from version 0.2.0 on (0.1.x was MIT) [RUN: crates.io API]. `dwg-to-dxf` ships MPL text + the Rust
  sources of its wrapper. MPL is file-level copyleft: a closed app may use it; changes to the MPL files must be published and the
  licence notice kept. `dwgdxf`'s README calls acadrust "MIT" - that is wrong for the version it embeds.
- **ezdxf = MIT**, **shapely = BSD-3-Clause** (bundles GEOS, LGPL-2.1, dynamically linked in the wheel) [RUN: wheel metadata].
- **JSTS = EDL-1.0 OR EPL-1.0** [RUN: package.json] - EDL is BSD-style.
- **`dxf-json`, `@dxfom/dxf`, `@mlightcad/dxf-json` = GPL-3.0** - same problem as LibreDWG for a closed web app.
- **ODA File Converter**: free download, but governed by the ODA "Community User Agreement": a limited, non-transferable,
  revocable licence; it "may not directly or indirectly resell or distribute a Community Application ... as part of any
  commercial application" [WEB: opendesign.com agreement PDF, search-result excerpt - I could not open the PDF]. So it cannot be
  bundled; at best the user installs it and a desktop/back-end component calls it through `ezdxf.addons.odafc`. Whether driving
  it from a commercial product is allowed needs ODA's answer. An ODA SDK membership is the paid route.
- `@isopodlabs/dwg` declares MIT but its API (`DRW_LINE`, `DRW_Header` style names) mirrors libdxfrw (GPL-2+). I could not check
  whether code was ported. Unresolved, one more reason not to depend on it.

---------------------------------------------------------------------------------------------------------------------

## 2. Real sample files obtained (all through raw.githubusercontent.com) [RUN]

```
LibreDWG/libredwg master test/test-data/  example_r13.dwg example_r14.dwg example_2000.dwg example_2004.dwg example_2007.dwg
                                          example_2010.dwg example_2013.dwg example_2018.dwg sample_2000.dwg sample_2018.dwg
                                          2007/ATMOS-DC22S.dwg 2000/TS1.dwg 2010/gh209_1.dwg 2018/Helix.dwg 2004/Underlay.dwg
                                          2000/PolyLine2D.dwg 2000/Leader.dwg
   (404: sample_2004/2007/2010/2013.dwg, example_r2.10.dwg and my other guesses)
mlightcad/cad-data main data/canteen.dwg                     2.6 MB, AC1021, a real canteen building plan  <- the real DWG
skymakerolof/dxf master test/resources/floorplan.dxf         1.1 MB, AC1018, a real US house floor plan    <- the real DXF
skymakerolof/dxf master test/resources/Ceco.NET-Architecture-Tm-53.dxf   architectural detail
gdsestimating/dxf-parser master samples/data/api-cw750-details.dxf       curtain-wall details, 293 dimensions
gdsestimating/three-dxf master sample/data/demo.dxf
DomCR/ACadSharp master samples/sample_AC1032.dwg
```
No npm tarball of the 21 packages I scanned ships a DWG. mozman/ezdxf `examples_dxf/Minimal_DXF_AC1009.dxf` is 35 bytes.
The GitHub API, github.com HTML and the Autodesk sample page are blocked here, so I could not list directories.

What the two real plans taught me
- `floorplan.dxf`: header says `$INSUNITS=4` (mm) and `$MEASUREMENT=1`, but the drawing is in **inches** (room sizes written
  as `13'8 x 14'`, door swings of radius 30). Layers are a **bound xref**: `xref-Bishop-Overland-08$0$A-WALL`. Walls are plain
  LINEs, doors and windows are lines and arcs on one mixed layer `A-OPENING` (no blocks). Room names carry `%%u` underline codes.
- `canteen.dwg`: plan, elevations and sections share one model space; rooms are labelled with **numbers 1..19** that refer to a
  legend table, not with names or areas; windows are anonymous dynamic blocks `*U21`; no north arrow; `$DIMSCALE=50`.

---------------------------------------------------------------------------------------------------------------------

## 3. The fixture (py/make_fixture.py) [RUN]

A two-storey single-family house, 10.00 x 8.00 m outside, exterior walls 40 cm, partitions 15 cm, plus an attached unheated
garage (24 cm walls) on the ground floor.

| file | content | unit / header | layers | DXF version |
|---|---|---|---|---|
| `fixture_rdc_cm.dxf` | ground floor, 6 rooms incl. garage, 6 windows, 7 doors, garage door drawn as one dashed line | cm, `$INSUNITS=5` | MUR, FENETRE, PORTE, TEXTE, COTATION, MOBILIER, ESCALIER, AXES, CARTOUCHE, SYMBOLES | R2010 (UTF-8) |
| `fixture_etage_mm.dxf` | first floor, 6 rooms, 7 windows, 5 doors, ANSI31 wall HATCH | mm, `$INSUNITS=4` | Wand, Fenster, Tuer, Text_Raum, Bemassung, Moebel, Treppe, Achsen, Plankopf, Wand_Schraffur | R2000 (cp1252) |
| `fixture_2storeys_aia.dxf` | both storeys side by side in ONE model space | cm, `$INSUNITS=0` | A-WALL, A-GLAZ, A-DOOR, A-AREA-IDEN, A-ANNO-DIMS, A-FURN ... | R2013 |
| `fixture_truth.json` | rooms, areas, openings, azimuths, heated gross area per floor | | | |

Realism built in
- walls = double lines (LINE, some open LWPOLYLINE), cut at every opening, jamb lines present; drawing origin far from 0,0
- windows: parametric unit block `FENETRE` scaled by `xscale = width/100`, `yscale = wall thickness`, ATTRIBs REF / LARG / HAUT /
  ALLEGE (file 1, 3); fixed-size blocks named `Fenster 1,40x1,35` without attributes (file 2)
- doors: blocks `PORTE_80` (leaf + quarter-circle), mirrored ones with `xscale = -1`, **no threshold line** (the wall gap is open)
- labels: `"Séjour 37,08 m²"` (TEXT), `"Cuisine\P12,16 m²"` (MTEXT), name and `"S = 8,38 m²"` as two TEXTs, MTEXT with inline
  font codes and `m2`, German `"11,50 qm"`, one room with a name only; the kitchen label is deliberately 0.85 m² wrong
- DIMENSION entities (chain + overall), one with a typed-over text `"10.00"` that contradicts nothing but hides the measurement
- north arrow block rotated -20 deg, title block frame around everything, title text, scale text, paper-space layout with a 1:50 viewport
- noise: furniture block, table, circle, 14 stair treads, dashed axis lines
- defects: one line end 0.3 cm short, one 0.5 cm overshoot, one duplicated line, one line split in two with a 0.05 cm offset,
  one wall line drawn on layer `0`

`out/fixture_rdc_cm.png` is a rendering of the ground floor (ezdxf drawing add-on).
The fixtures were also written as DWG with acad-ts (`out/*.acadts.dwg`, R2000 / R2010 / R2013 / R2018) and read back by
LibreDWG (independent code base): same entity counts, `$INSUNITS`, attributes and accented texts.

---------------------------------------------------------------------------------------------------------------------

## 4. Why raw linework is hard to turn into rooms and walls

1. **A DWG has no rooms and no walls.** It has lines. A wall is two parallel lines somebody drew 40 cm apart. A room is the
   empty space left between wall lines. Nothing in the file says which is which.
2. **Rooms are not closed.** Every door is a hole in the wall linework. Doors drawn as leaf + arc do not close it.
3. **Layer names are free text.** MUR, Wand, A-WALL, `xref$0$A-WALL`, `Wall`, "Calque 3", or everything on layer 0. One layer can
   mix doors and windows (`A-OPENING`), and foundation or roof layers can contain the word "wall" (`S-STEM-WALL`).
4. **Units are not reliable.** `$INSUNITS` can be 0, or wrong (real file: says mm, is inches). mm, cm and m are all common here.
5. **Drafting is sloppy.** Ends that miss by a few mm or cm, overshoots, duplicates, lines on the wrong layer, walls with or
   without jamb lines, walls drawn straight through the windows.
6. **Blocks.** Doors, windows, sometimes the whole plan (bound xref) are block references: nested, rotated, mirrored (negative
   scale), non-uniformly scaled, anonymous (`*U21` dynamic blocks). Content on layer 0 inside a block takes the layer of the insert.
7. **Xrefs.** An attached xref is only a file name; the geometry is in another file the user did not upload.
8. **Model space vs paper space.** Geometry is normally in model space at 1:1; the sheet (title block, scale) is in paper space
   through viewports. Some offices draw everything in model space including the frame, several floors, sections and elevations
   side by side (both my real files do).
9. **Labels vary.** Name + area in one text, in two texts, in an MTEXT with formatting codes, in block attributes, or only a room
   number that points to a legend. Areas with comma or dot, m², m2, qm. Labels can be outdated.
10. **What a plan does not contain at all:** window heights and sill heights (unless in attributes or block names), storey
    heights, wall build-ups / U-values, which rooms are heated. The energy certificate needs all of them.

---------------------------------------------------------------------------------------------------------------------

## 5. The pragmatic algorithm (py/extract_plan.py) [RUN]

1. **Load**: `ezdxf.readfile`, fallback `ezdxf.recover.readfile`. Model space only. Flatten block references recursively with
   `virtual_entities()`; layer-0 content inherits the insert's layer; every INSERT at any depth is recorded.
2. **Layer mapping** by name, after stripping xref prefixes (`name|layer`, `name$0$layer`) and accents; ordered regex rules for
   FR / DE / EN / AIA: hatch, dim, frame, foundation, roof, stair, axis, furniture, door, window, wall, text.
   Fallback when no name looks like a wall: score each layer by the length of line pairs that are parallel, 5-65 cm apart and
   overlapping by 50 % ("double lines"); the best layer is proposed as wall layer.
3. **Units**: votes from `$INSUNITS`, the median radius of 90-degree door-swing arcs (0.6-1.1 m expected), feet-inch texts;
   afterwards the ratio between polygon areas and the areas written in the labels re-checks the choice and re-runs if needed.
4. **Wall linework to wall solids**: LINE / polyline / arc segments of the wall layers -> endpoint clustering (1 cm) ->
   free ends extended by ray casting up to 6 cm or merged with a facing free end (corner rebuilt at the line intersection) ->
   pairs of free ends at wall-thickness distance closed (walls without jambs) -> layer-0 lines adopted if they close more faces ->
   `shapely.unary_union(lines, grid_size=0.5 mm)` -> `polygonize_full`. Faces whose maximum inscribed circle has a radius
   <= 0.36 m are wall solids.
5. **Jamb pairing**: a short edge of a wall solid with convex corners at both ends is a wall end. Two wall ends that face each
   other, have the same length (= wall thickness), are aligned, 0.35-5.5 m apart and have no wall between them are an opening.
   The rectangle between them is the "bridge". This needs neither blocks nor layer names and gives the true structural width.
6. **Rooms and outline**: union(wall solids + bridges). Each connected component is one plan (one storey when several are drawn
   side by side). Its exterior ring is the building outline; its holes are the rooms (net area between wall faces).
7. **Semantics**: texts inside a room polygon give name and stated area; a bridge is a window or a door according to the block
   insert / arc / lines of the window and door layers lying on it (a quarter-circle arc means door even on a mixed layer);
   attributes and sizes in block names (`1,40x1,35`) are attached. Inserts that sit on an uninterrupted wall are reported from
   their own bounding box. Exterior or interior is decided by the distance to the outline.
8. **Orientation**: north arrow block found by name (nord / north / Nordpfeil ...), its rotation gives north; azimuth of the
   outward normal of each exterior opening and of each outline edge -> 8 sectors.
9. **Heated gross outline**: rooms whose name matches garage / cave / Keller / grenier / terrasse ... are guessed unheated;
   heated rooms grown by 0.70 m, clipped to the building outline, unheated rooms removed, slivers removed by an opening.
   Result: gross area, perimeter, facade length per orientation, length against unheated rooms.
10. **Self-checks that become questions to the user**: contradictory units, guessed wall layer, label area vs geometry,
    several room names in one region (= a door was not closed), unpaired wall ends, unmatched door/window blocks, no north arrow.

A browser port needs a planar-graph kernel in JS. JSTS (port of JTS, EDL/EPL) has the same `UnaryUnionOp`, `Polygonizer`,
buffer and union. `js/t_browser_path.mjs` proves the chain acad-ts -> JSTS on the fixture DWG: 6 of the 9 wall solids without
any healing (33 dangles), i.e. the healing steps of 4. are what closes the other 3; they are plain code and port directly.
Running the Python extractor unchanged in the browser through Pyodide is the other option; I did not test it.

---------------------------------------------------------------------------------------------------------------------

## 6. Results

### 6.1 Fixtures and degraded variants (py/test_variants.py, table saved in out/variants_table.md) [RUN]

Columns: rooms found with the right name / with the right area (+-0.02 m²) / exterior windows with right width and orientation /
same ignoring the window-vs-door type / doors with right width / heated gross area within 0.1 m².

| file | variant | unit | plans | rooms named | area ok | windows typed | ext. openings | doors | heated gross | wall layer |
|---|---|---|---|---|---|---|---|---|---|---|
| rdc_cm | base | cm | 1/1 | 6/6 | 6/6 | 6/6 | 6/6 | 7/7 | 1/1 | MUR |
| rdc_cm | no_jambs | cm | 1/1 | 4/6 | 4/6 | 3/6 | 3/6 | 7/7 | 0/1 | MUR |
| rdc_cm | rotated17 | cm | 1/1 | 6/6 | 6/6 | 6/6 | 6/6 | 7/7 | 1/1 | MUR |
| rdc_cm | anon_layers | cm | 1/1 | 6/6 | 6/6 | 6/6 | 6/6 | 7/7 | 1/1 | Calque5 (guessed) |
| rdc_cm | exploded | cm | 1/1 | 6/6 | 6/6 | 6/6 | 6/6 | 7/7 | 1/1 | MUR |
| rdc_cm | walls_through | cm | 1/1 | 6/6 | 6/6 | 6/6 | 6/6 | 7/7 | 1/1 | MUR |
| rdc_cm | one_block | cm | 1/1 | 6/6 | 6/6 | 6/6 | 6/6 | 7/7 | 1/1 | MUR |
| rdc_cm | no_units | cm | 1/1 | 6/6 | 6/6 | 6/6 | 6/6 | 7/7 | 1/1 | MUR |
| rdc_cm | gaps_3cm | cm | 1/1 | 6/6 | 6/6 | 6/6 | 6/6 | 7/7 | 1/1 | MUR |
| etage_mm | base | mm | 1/1 | 6/6 | 6/6 | 7/7 | 7/7 | 5/5 | 1/1 | Wand |
| etage_mm | no_jambs | mm | 1/1 | 5/6 | 4/6 | 5/7 | 5/7 | 3/5 | 1/1 | Wand |
| etage_mm | rotated17 / anon_layers / exploded / walls_through / one_block / no_units / gaps_3cm | mm | 1/1 | 6/6 | 6/6 | 7/7 | 7/7 | 5/5 | 1/1 | Wand (Calque5 guessed) |
| 2storeys_aia | base | cm | 2/2 | 12/12 | 12/12 | 13/13 | 13/13 | 12/12 | 2/2 | A-WALL |

Ground floor, base case, numbers produced: outline 96.01 m² / 44.01 m (house + garage), heated gross 79.999 m² / 36.0 m
(truth 80 / 36), heated net 63.705 m², facades S 10.0, W 8.0, N 10.0, E 4.06 m + 3.94 m against the garage, north 20 deg,
windows at azimuth 160 / 250 / 340 / 70 deg, the cuisine label flagged (label 12.16, geometry 11.31).
The same scores come out of the full DWG chain: fixture DXF -> DWG (acad-ts) -> DXF (dwg-to-dxf WASM) -> ezdxf -> extractor.

How this evolved, honestly: the first version scored 0/6 on `gaps_3cm` and on `no_jambs`, 4/6 on `one_block` and
`walls_through`. Ray-cast healing, corner rebuilding, the layer-0 adoption rule and looser jamb tolerances fixed all but
`no_jambs`. What still fails there is a **compound defect**: jamb lines missing AND one wall face on the wrong layer. The
unclosed wall chunk is then bridged over (a false 4.37 m "window", two rooms merged into 13.53 m²). The result looks plausible.
Only the "2 room labels in one region" warning and the area mismatch reveal it. This is the main risk of the approach.

Caveat: I wrote both the fixture and the extractor. The base scores prove the code path, not real-world accuracy.

### 6.2 Real files [RUN]

`samples/probe/floorplan.dxf` (US house, 967 entities), no user input, 0.22 s
- units: header says mm, extractor chose **inches** from door swings and feet-inch texts (correct)
- wall layer found through the bound-xref prefix; 50 wall ends without jambs closed automatically
- 13 closed regions = 97.5 m². 10 carry a room name read from the drawing; where the drawing states a size it matches: BEDROOM 17.77 m²
  (label 13'8 x 14' = 17.8), BEDROOM 2 13.80 m² (13'6 x 11' = 13.8), 2 CAR GARAGE 40.96 m² (21'2 x 20'10 = 40.97), guessed unheated
- **not closed**: great room, kitchen, dining room, entry, hall, bedroom 3 (open plan, walls partly on other layers);
  19 unpaired wall ends; so the building outline and the heated perimeter are wrong (outline 112.9 m² / 109.9 m is not a footprint)
- 22 openings found (doors 0.71-0.92 m, windows 0.61-1.83 m, garage door bridged); no north arrow

`samples/real/mlight_canteen.dwg` (25 123 entities) through dwg-to-dxf, no user input, 2.7 s
- units mm from the header (no contradicting evidence), layers Wall / windows / door / Axes / txt mapped by name
- 63 wall solids, 61 bridges, 23 closed rooms = 355.8 m² in the right half of a roughly 50 x 20 m building; the large hall on
  the left is not closed (38 unpaired wall ends), so there is no usable outline for the whole building
- 67 openings: 24 windows (mostly 0.86 m modules, block `*U21`), 35 doors (blocks d1..d12, mostly 0.8-1.3 m), 8 unclassified.
  9 of them are implausible (narrower than 0.4 m or wider than 2 m, up to 4.1 m): either real wide openings or bridges
  thrown across a missing wall piece. They need a plausibility filter and the user's eye
- **0 room names**: the labels are numbers pointing to a legend; no north arrow; 11 window/door blocks not matched to a wall gap

Bottom line: on tidy residential plans with double-line walls the automatic pass is essentially complete. On the two real files
it delivered units, layers, most openings with correct widths and roughly half of the rooms with correct areas, but **not a
trustworthy building outline** without the user closing a few gaps. I have no real Luxembourg architect's plan; this must be
repeated on 10-20 real ones before promising anything.

---------------------------------------------------------------------------------------------------------------------

## 7. Recommendation

Browser-only (files stay on the PC)
1. Reader: `@node-projects/acad-ts` (MIT) in a Web Worker, for DWG and DXF. 211 KB gzip, no WASM, attributes / dimensions /
   hatches / code pages handled. Pin the version.
2. Second engine when acad-ts throws or returns nothing: `dwg-to-dxf` (MPL-2.0, 1.2 MB gzip, lazy-loaded) -> DXF -> acad-ts
   `DxfReader` or `dxf` (MIT). Two independent decoders (ACadSharp lineage in TS and in Rust are related, so not fully independent).
3. LibreDWG WASM only if the product is released under GPL-3, or kept as a separately distributed optional tool.
4. Always accept DXF as well: every CAD program, Archicad included, can save DXF, and it is the escape hatch when a DWG fails.
5. Geometry: port section 5 to JS on JSTS, or run the Python code in Pyodide (to be evaluated).

Back end / desktop helper (Node or Python)
1. Python `ezdxf` + `shapely`: the extractor in this directory runs as is.
2. DWG -> DXF on the server: `dwg-to-dxf` or acad-ts under Node (proved), or LibreDWG's `dwg2dxf` (GPL is not a problem
   server-side), or `ezdwg` once it matures. ODA File Converter only if the user installs it and ODA confirms the use is allowed.

What the user must still confirm or supply (each item is backed by a failure or warning observed above)
- drawing unit when the evidence disagrees or is absent; the wall layer when it was guessed from geometry
- which plan is which storey when several are found; storey heights (never in a plan)
- closing clicks where wall ends stay unpaired; a visual check of the coloured room overlay against the stated areas
- heated vs unheated for every room (keyword guess only), which fixes the heated perimeter
- north direction when no north arrow is found, and even when one is found (assumption: arrow points to +Y in its block)
- window heights and sill heights unless attributes or block names carry them; door vs window on unclassified openings
- room names when the plan uses numbers and a legend
- everything thermal (constructions, U-values, systems): not in the linework

---------------------------------------------------------------------------------------------------------------------

## 8. Dead ends and things not done

- `libredwg-web` (unscoped name) does not exist. `ezdxf.addons.dwg` does not read anything. `libdxfrw` WASM is unreliable.
- ODA File Converter and native LibreDWG could not be installed here; not run.
- No test in a real browser; no memory measurements; no DWG larger than 2.6 MB; no pre-R13 DWG; no password-protected or
  corrupted DWG; no DWG with attached (unbound) xrefs; no Archicad or Allplan export (their layer and block conventions differ).
- Curved walls are flattened but never appeared in a test. Walls drawn as single lines, as MLINE, or only as HATCH are not
  handled (MLINE is expanded by `virtual_entities()`, untested).
- The extractor ignores DIMENSION entities for geometry. They could cross-check units and overall sizes (measurement vs text
  override is available: the fudged `"10.00"` dimension in the fixture is readable through acad-ts and ezdxf).
- Paper-space viewport scale (written in the fixtures) is not used yet; with the scale text it would give the unit as well.

Sources for the [WEB] items
- https://www.gnu.org/software/libredwg/ , https://en.wikipedia.org/wiki/LibreDWG (licence, FSF refusal to relicense)
- https://www.opendesign.com/files/2025-09/ODA%20Community%20User%20Agreement%2009-2025.pdf (search excerpt only)
- https://github.com/DomCR/ACadSharp (MIT), https://crates.io/api/v1/crates/acadrust (queried directly: MPL-2.0 since 0.2.0)
- https://autodesk.com/autocad-samples (official sample DWGs, blocked for curl here)
