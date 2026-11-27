# Reading plans delivered as PDF (vector or scanned) or images - research notes

Date: 2026-11-27. Everything under "MEASURED" was produced by the scripts in this directory
(`/tmp/claude-0/-home-user-Cpe/777c5250-2203-5ad4-9fa2-9a73c3e3c91c/scratchpad/research/pdf-vision`).
Everything under "LITERATURE" comes from web search result summaries (arxiv.org / huggingface.co could NOT be
opened from this sandbox, so numbers quoted from papers are second-hand unless stated otherwise).

## 0. Honest scope statement (read first)

* All measurements are on **synthetic fixtures that I drew myself** (reportlab), plus degraded variants.
  No real Luxembourg architect PDF was available. The heuristics were developed against these same fixtures,
  so the headline numbers (errors of 0.01-0.1 %) are a **best case = "the PDF pipeline is geometrically
  lossless when the heuristics fire"**, not a field accuracy. The stress tests (section 4) show how brittle
  the automatic topology step is. A pilot on 20-30 real plans is mandatory before promising anything.
* pdf.js was run in **Node 22** (`pdfjs-dist/legacy/build/pdf.mjs`), not inside a real browser. The API used
  (`getTextContent`, `getOperatorList`, `getOptionalContentConfig`) is the browser API; a browser run was not done.
* No deep-learning floor-plan model was run (CubiCasa5k etc. need GPU / dataset downloads that are blocked here).
  No paid API was called. The LLM part is literature + official Anthropic documentation only.
* What exactly LuxEeB-Tool needs (which area definition: inner / outer dimensions, An, envelope areas) was NOT
  researched here (other topic). I use "outline (external dimensions)" and "room net areas" as generic targets.

## 1. Files

| file | purpose |
|---|---|
| `make_fixtures.py` | draws `fixtures/fr_A3_1-100.pdf` (A3, 1:100, FR, "AutoCAD style": loose wall segments, one line per dimension chain, cm dims, Type1 font; RDC + Étage + Coupe A-A + north arrow + title block) and `fixtures/de_A3_1-50.pdf` (A3, 1:50, DE, 3 pages EG/OG/Schnitt, "Archicad style": filled wall polygons, one line per dimension, German mixed m/cm dims with superscript half-cm `3,26⁵` / `11⁵`, embedded TrueType subset) + `*.truth.json` (exact rooms, areas, outlines, dimensions, north, levels) |
| `make_variants.py` | `fr_A4_fit.pdf` (the 1:100 sheet "printed to fit" on A4, title block still says 1:100, real 1:141.5; page becomes a Form XObject) and `fr_A3_rot90.pdf` (/Rotate 90) |
| `make_cad_plot.py` | DXF -> PDF through `ezdxf.addons.drawing` (PyMuPDF backend) = a real CAD plot path; plus `layers_ocg.pdf` (PDF layers / OCG) |
| `extract_py.py` | PDF -> IR JSON with **PyMuPDF** or **pdfplumber** (texts with bbox/angle/size, stroked/filled segments with line width, curves flattened) |
| `extract_pdfjs.mjs` | same IR with **pdf.js** (pdfjs-dist 6.5.438) |
| `analyze.py` | scale text, room labels + areas, dimension self-calibration, wall faces, room polygons, outline, heated outline, north arrow, section levels, evaluation against truth |
| `run_all.sh` | regenerate + extract (3 backends) + analyse -> `out/*.txt` |
| `stress_tests.py` | degrade the IR (hairline, no dims, no areas, no text, endpoint jitter) -> `out/stress.txt` |
| `parser_tests.py` | unit tests of scale / area / room-vocabulary parsers -> `out/parser_tests.txt` |
| `raster_tests.py` | synthetic scans (200 / 100 dpi, skew, blur, noise, JPEG), RapidOCR, classical-CV outline, snapping corners -> `out/raster.txt` |
| `ocr_tesseractjs.mjs` | browser-capable OCR (tesseract.js WASM, offline `@tesseract.js-data/fra`) on the scans |
| `click_sim.py` | Monte-Carlo of click calibration + outline tracing -> `out/click_sim.txt` |
| `geom_js_spike.mjs` | noding + polygonize + mitred buffer in JavaScript with JSTS (browser-capable geometry) |
| `perf_test.py` | 200 000-segment A1 sheet for extractor timing |
| `probe_pdfjs.mjs`, `probe_ocg.mjs` | pdf.js operator-list / optional-content probes |

Setup that worked:
```bash
python3 -m venv .venv --system-site-packages
.venv/bin/pip install pymupdf shapely opencv-python-headless networkx ezdxf rapidocr-onnxruntime
npm install pdfjs-dist jsts tesseract.js @tesseract.js-data/fra @tesseract.js-data/deu
./run_all.sh; .venv/bin/python stress_tests.py; .venv/bin/python raster_tests.py; .venv/bin/python click_sim.py
```
Versions / licences (from package metadata): PyMuPDF 2.2 (MuPDF 1.28.6) **AGPL-3.0 or Artifex commercial**;
pdfplumber 0.11.10 MIT (pdfminer.six MIT); pdfjs-dist 6.5.438 Apache-2.0; shapely 2.2.0 BSD-3; JSTS 2.12.1 EDL/EPL;
OpenCV 5.1.0 Apache-2.0; rapidocr-onnxruntime 1.2.3 Apache-2.0 (+ onnxruntime 1.29 MIT); tesseract.js 7.0.0 Apache-2.0;
ezdxf 1.4.5 MIT; reportlab 5.0.1 BSD. **PyMuPDF's AGPL matters for a closed-source desktop product** - pdf.js or
pdfplumber/pdfminer (or pypdfium2, not tested for paths) avoid it.

## 2. MEASURED - vector PDF extraction, three backends

### 2.1 Text with coordinates
* All three give every string with position, font size and direction. Token sets are identical between PyMuPDF and
  pdfplumber (FR page: 89 tokens; DE pages: 55 / 40 / 30). pdf.js gives the same strings but splits one run at a wide
  whitespace gap ("Échelle 1:100        12.03.2024" -> 2 items), i.e. 91 / 57 / 42 / 32 tokens. Accents, `²`, `ß`, `±`
  come out correctly from both a Type1 (WinAnsi) and an embedded TrueType subset font.
* Rotated text (vertical dimension chains): PyMuPDF `get_text("dict")` gives `line["dir"]`; pdf.js gives the text matrix
  in `item.transform`. **pdfplumber `extract_words()` returns 90°-text reversed by default** ("850" -> "058"); it needs
  `char_dir_rotated="btt"`, and pdfminer's char `size` for rotated glyphs is the glyph ADVANCE (splits words if `size`
  is in `extra_attrs`). I replaced it by my own grouping from `char["matrix"]` (`group_chars()` in `extract_py.py`).
* German superscript half-centimetres (`11⁵`, `3,26⁵`) arrive as a separate smaller run (size 3.9 vs 6.0) in all three
  backends; `dimension_tokens()` merges them (6/6 on the DE fixture).
* **/Rotate pitfalls (verified on `fr_A3_rot90.pdf`)**: PyMuPDF returns text and drawings in the UNROTATED frame while
  `page.rect` is rotated -> call `page.remove_rotation()` first. pdfplumber/pdfminer and the pdf.js viewport give display
  coordinates, but pdf.js `item.transform` (text direction) stays in the native frame -> transform the direction vector
  with the viewport matrix. `normalize_rotation()` in `analyze.py` then turns the IR so that the dominant text reads
  left-to-right. After these fixes all three backends give the same results on the rotated sheet.
* **Text that is not text**: the DXF -> PDF plot through ezdxf (`cad_plot_ezdxf.pdf`) contains **0 text spans**; every TEXT
  and DIMENSION string is a filled glyph outline (10 filled paths). Same thing is known for AutoCAD SHX fonts (not tested
  here). Then nothing textual works (no scale, no labels) -> OCR of the rendered page (section 5) or user input.

### 2.2 Vector paths and line widths
* PyMuPDF `page.get_drawings()` -> items `l` / `c` / `re` / `qu`, `width`, `color`, `fill`, `dashes`, `layer`.
* pdfplumber `page.lines / rects / curves` with `linewidth`, `pts`, `path` (ops `m l c h`), `stroke`, `fill`, `dash`.
* pdf.js `page.getOperatorList()`: in **6.5.438** `OPS.constructPath` args are
  `[paintOp, [Float32Array data], Float32Array minMax]`, `data` is a flat stream using `DrawOPS`
  `{moveTo:0, lineTo:1, curveTo:2, quadraticCurveTo:3, closePath:4}`; `paintOp` is `OPS.stroke / fill / eoFill /
  fillStroke / closeStroke / endPath ...`. This differs from older pdf.js versions (ops + args arrays) - pin the
  version. You must track `save / restore / transform / setLineWidth / setDash / paintFormXObjectBegin(matrix) /
  paintFormXObjectEnd` yourself; effective width = `lineWidth * sqrt(|det CTM|)`. Coordinates are float32.
* Result: the sets of stroked segments are **identical** across the 3 backends (553 on FR; 321 / 219 / 85 on DE; widths
  0.26-1.98 pt reproduced exactly; the A4-fit variant inside a Form XObject gives widths x0.707 in all three).
  PyMuPDF merges a fill path followed by the identical stroke path into one `fs` path (321 vs 412 segments) - harmless.
* **PDF layers survive**: `layers_ocg.pdf` -> PyMuPDF `get_drawings()[i]["layer"]` = "A-WALL (Murs)" / "A-DIMS (Cotes)";
  pdf.js `doc.getOptionalContentConfig()` lists the groups and the operator list wraps content in
  `beginMarkedContentProps ["OC", {type:"OCG", id}]`. The ezdxf plot also carries the DXF layers as OCGs
  (`a-wall`, `a-dims`, `a-text`). When a PDF has layers, wall selection by layer name beats every heuristic.
  (Whether typical Luxembourg office exports keep layers was not checked.)
* Speed, A1 sheet with 200 000 segments + 3 000 texts (4.5 MB): **pdf.js 1.4 s, PyMuPDF 2.4 s, pdfplumber 12.3 s**
  (extraction only, 1 core). Fixture pages take ~0.1 s in all three.

### 2.3 Results of the full pipeline on the clean fixtures (identical for PyMuPDF / pdfplumber / pdf.js)

| metric | FR 1:100 (1 page) | DE 1:50 (3 pages) |
|---|---|---|
| declared scale found in title block | yes | yes x3 |
| dimension texts matched to a measured interval | 41/41 | 25/25, 15/15, 9/9 |
| scale from dimension self-calibration | 1:100.00 (err 0.000 %) | 1:50.00 (err 0.000 %) |
| scale from room-area labels (unit-free) | err -0.009 % | err -0.002 % / +0.011 % |
| room names found / area labels parsed | 12/12, 12/12 | 11/11, 11/11 |
| room polygons measured, max area error | 12/12, 0.091 % | 11/11, 0.036 % |
| building outline (faces method), area error, IoU | -0.013 % / -0.024 %, 0.9998 | -0.007 % / -0.005 %, 0.9999 |
| building outline (closing method r = 1.3 m) | 0.000 % | 0.000 % |
| heated outline (external dims) | -0.024 % (85.0 of 114.75 m² footprint) | +0.032 % / -0.005 % |
| heated / unheated default: confident+correct / ambiguous / wrong | 11 / 1 / 0 | 10 / 1 / 0 |
| north arrow direction error (differs per backend: text bbox definition) | -1.0° .. +0.4° | -0.9° .. +1.5° |
| section levels (+0,00 / +2,80 / +5,60) and "HSP / RH 2,50 m" | found | found |

The remaining 0.01-0.09 % is the 0.05 pt snapping grid and the label rounding to 0.01 m².

### 2.4 "Print to fit" - why the title-block scale must never be trusted alone
`fr_A4_fit.pdf` (A3 sheet scaled x0.7067 onto A4): title block says **1:100**, dimension self-calibration says
**1:141.49**, area-label calibration says **1:141.48** (all 3 backends), and all areas come out right (85.01 / 114.76 m²).
Using the declared scale would give areas wrong by **-50 %**. Rule: declared scale = hint; consensus of dimension texts
and/or area labels = truth; disagreement > 1 % = tell the user.

## 3. Algorithms that worked (see `analyze.py`)

1. **Scale text**: regex with keyword (`Échelle|Éch.|Maßstab|Massstab|Mst.|M.|scale`) + `1[:/]N`, N restricted to
   standard denominators, guarded against dates/times. `parser_tests.py`: 16/18 cases; the 2 failures are OCR
   confusions (`l:100`, `1:5O`) -> add an OCR-tolerant variant after OCR.
2. **Room labels / areas**: `AREA_RE` (`m²|m2|m ²|qm`, comma or dot) 15/16 cases (fails on thousands separator
   "1 234,50 m²"); name token paired with the area token just below it. FR/DE/LU vocabulary -> class
   H (heated) / U (unheated) / A (ambiguous -> ask) / X (outside): 35/41 on tricky strings. Failures are informative:
   "Kellerflur" -> H, "Chambre froide" -> H, "Vide sur séjour" -> H (it is a void), "Garagentor" -> U (not a room),
   "Salle de jeux", LU "Kachen" unknown. => vocabulary is a decent default, never a decision; an LLM text call on the
   list of labels would do this better (text classification is an LLM strength).
3. **Dimension self-calibration**: merge thin collinear segments -> lines that are crossed symmetrically by >= 2 short
   segments (ticks / extension lines) are dimension lines -> consecutive crossings are intervals -> numeric text parallel
   to the line whose centre projects into the interval -> `value / length`. Units: tokens with a decimal separator are
   metres (+0.005 with superscript 5), integers are tested as mm / cm / m and the hypothesis closest to a standard (or
   the declared) scale wins; robust consensus (median, 2 % inliers). Works with one line per chain (FR) and one line per
   dimension (DE), with displaced texts on narrow intervals, and with the German mixed convention.
   Not covered: arrow-head or dot terminators without crossing lines, dimension text inside a broken line, aligned
   (oblique) dimensions were not in the fixtures, radial/angular dimensions.
4. **Unit-free calibration from area labels**: `sqrt(label m² / polygon pt²)` per labelled room. Independent of the
   dimension chains and of the mm/cm/m question; needs room polygons (step 5). In real life label areas may follow
   another convention (plaster deduction, areas under sloping roofs, niches) -> use as a cross-check within ~2-3 %,
   not as primary calibration.
5. **Wall faces -> rooms**: wall line class = heaviest stroke width that is not the sheet frame and carries > 4 % of
   the stroked length; every opening interrupts BOTH faces of a wall, so collinear gaps are bridged only if a twin gap
   with the same extent exists 4-70 cm away (without this twin test, collinear door/window jambs of different walls got
   connected and cut rooms: Cuisine 8.95 instead of 12.27 m², Palier 5.46 instead of 9.37 m²); then
   `shapely.ops.polygonize`. Room = smallest face containing the label point.
6. **Outline**: (a) exterior of the union of faces; (b) topology-free "closing": buffer wall segments by r (mitre),
   take the exterior ring, buffer back by -r. (b) is exact for right-angled footprints, survives unsnapped endpoints,
   but fills notches/recesses narrower than 2r as well as openings.
7. **Heated outline in external dimensions**: heated (+ambiguous) room faces grown by 0.62 m, clipped to the building
   outline, minus unheated room faces, then an opening of 0.14 m to drop annex wall stubs. Garage + cellar annex correctly
   excluded on both fixtures (85.0 of 114.75 m²; 87.0 of 108.0 m²).
8. **North**: "N"/"Nord" token + nearest circle path -> direction centre -> letter. +-1.5° on my two arrows. Real north
   arrows are wildly diverse: treat as a pre-fill for a compass widget, never as a result.
9. **Section**: level marks `[+-±]d,dd` -> storey heights by difference; `HSP|RH|lichte Höhe d,dd` -> clear height.

## 4. MEASURED - where it breaks (`stress_tests.py`, page 1 of each fixture)

| degradation | effect |
|---|---|
| A. all strokes same width ("hairline" export) | no wall class -> fallback "all straight lines": room area errors up to **18 % (FR) / 22 % (DE)** (stairs and fixtures cut faces), outline +0.4..+0.5 %, heated outline -0.02 % / -2.7 %, area-label calibration off by 3.6 % on DE -> must be flagged by the label cross-check and confirmed by the user |
| B. no dimension texts | area-label calibration still gives the scale (err < 0.01 %) |
| C. no area labels | dimension calibration alone is enough; rooms still measured |
| D. no text at all (outlined fonts) | no scale, no labels: nothing automatic. Needs OCR or one user-typed length |
| E. endpoint jitter +-0.15 pt (sloppy snapping) | faces/topology method collapses (outline **-34 %, -82 %, -10 %**, rooms missing); closing method stays at **+0.01..+0.06 %** |

Lessons: (1) the outline should come from the robust closing method, rooms from the topological method, and the two must
agree; (2) a proper vertex-snapping pre-pass is needed before polygonize in production; (3) line weights are a strong but
fragile cue - prefer PDF layers when present; (4) clutter not present in my fixtures and certain to hurt: hatches with
heavy pens, insulation symbols, furniture, tiles, terraces/balconies/roof overhangs drawn with wall-weight lines,
several buildings on a sheet, oblique or curved walls (code handles any angle in principle - untested), multi-scale
sheets (details at 1:20 next to plans at 1:100), raster images embedded in a "vector" PDF.

When automatic outline detection fails on a vector PDF the fallback is still much better than raster: endpoints and
intersections are exact snapping targets, so a user-traced polygon has CAD precision.

## 5. MEASURED - scans / images (`raster_tests.py`, `ocr_tesseractjs.mjs`)

Synthetic scans of the FR sheet: grey, 0.6° skew, blur, noise, JPEG q=50.
At 1:100: 200 dpi -> 78.7 px/m and 6 pt text = 17 px; 100 dpi -> 39.4 px/m and 8 px text.

| OCR engine, input | room names | area labels | horiz. dims | vert. dims | scale text | levels | false numbers |
|---|---|---|---|---|---|---|---|
| RapidOCR (PP-OCR, ONNX, CPU, offline), 200 dpi, tiles 1100 px + 90° pass, 5.8 s | 12/12 | 11/11 | 21/27 | 12/14 | yes | 3/3 | none |
| RapidOCR, 100 dpi, 2.8 s | 9/12 | 9/11 | 7/27 | 2/14 | yes | 3/3 | "60", "70" |
| RapidOCR, 100 dpi upscaled x2, 4.9 s | 8/12 | 8/11 | 12/27 | 10/14 | yes | 3/3 | "101", "1227", "7280", "950" |
| tesseract.js 7 (WASM, `fra`), 200 dpi whole page, PSM sparse | 11/12 | 11/11 | 13/15 distinct values | not run | yes | - | - |
| tesseract.js, 100 dpi | 9/12 | **0/11** | 5/15 | not run | yes | - | - |

* OCR also rescues the outlined-text CAD plot rendered at 200 dpi: "Séjour", "70,84 m²", "1000", "850",
  "Echelle l:100" (note the `l` for `1`).
* At <= 100 dpi OCR invents numbers. Never use a single OCR'd dimension; only a consensus of several dimension
  readings that agree on one scale, or a number the user confirmed.
* Vertical text needs a second pass on the image rotated by 90°; plans need tiling (text is tiny relative to the sheet).

Classical-CV outline (Otsu -> opening to keep thick strokes -> drop small blobs -> closing r = 1.3 m -> external contour),
scale taken from (dpi, declared 1:100):
* first version: **+23 % and +147 %** (tick/extension-line crossings survive the opening and the closing glues the
  dimension chains to the building);
* with small-blob removal: RDC **+0.79 %**, Étage **+0.94 %** at 200 dpi; +0.62 % / +0.75 % at 100 dpi (bias = half
  line thickness + skew). The section drawing also yields a blob (63 m²) that must be recognised as "not a plan".
  This is a clean synthetic scan; on real scans (hatches, furniture, stamps, folds, handwriting) expect frequent failure
  -> it is a *suggestion* the user accepts or redraws.
* Corner candidates for snapping (`goodFeaturesToTrack` on the thick-stroke mask): only 17/28 true outline corners have a
  candidate within 3 px at 200 dpi, 7/28 at 100 dpi -> use line detection + intersections instead (not done).

## 6. MEASURED - human-in-the-loop accuracy model (`click_sim.py`, 20 000 trials per row)

Area error (%) of an L-shaped 13.5 x 8.5 m footprint; each click has Gaussian error sigma (px); "calib L" is the length of
the dimension the user clicked for calibration. mean |err| / P95:

| image | sigma | calib L | calibration only | tracing only | both |
|---|---|---|---|---|---|
| 1:100 @ 150 dpi (59 px/m) | 0.7 px (snapped) | 13.5 m | 0.20 / 0.48 | 0.13 / 0.31 | **0.23 / 0.57** |
| 1:100 @ 150 dpi | 2 px (zoom loupe) | 13.5 m | 0.57 / 1.38 | 0.36 / 0.89 | **0.67 / 1.64** |
| 1:100 @ 150 dpi | 2 px | 5 m | 1.52 / 3.73 | 0.36 / 0.90 | 1.56 / 3.84 |
| 1:100 @ 150 dpi | 2 px | **1 m (a door)** | 7.70 / 18.9 | 0.37 / 0.90 | **7.70 / 19.0** |
| 1:100 @ 150 dpi | 5 px (finger, no zoom) | 13.5 m | 1.43 / 3.52 | 0.92 / 2.24 | 1.69 / 4.15 |
| 1:100 @ 300 dpi or 1:50 @ 150 dpi (118 px/m) | 2 px | 13.5 m | 0.28 / 0.69 | 0.18 / 0.45 | **0.34 / 0.83** |
| 1:100 @ 100 dpi (39 px/m) | 2 px | 13.5 m | 0.85 / 2.10 | 0.55 / 1.36 | 1.01 / 2.48 |
| 1:200 @ 150 dpi (30 px/m) | 2 px | 13.5 m | 1.14 / 2.78 | 0.73 / 1.78 | 1.35 / 3.30 |

Not in the simulation, add on top: uniform paper / copier / scanner scaling error of 0.5 / 1 / 2 % in length = **+1.0 / +2.0 /
+4.0 %** in area; anisotropic stretch; perspective of phone photos; and blunders: tracing the inner wall face instead of the
outer one = **-16.7 %** on a 10 x 8.5 m house with 40 cm walls, the wall axis = -8.5 %.

Design consequences: (1) calibration error dominates tracing error -> force the LONGEST overall dimension, refuse short
ones, ask a second perpendicular one as a check (it also reveals anisotropic scans); (2) snapping and a zoom loupe are
worth a factor 3; (3) the UI must make "which wall face" impossible to get wrong (show the wall thickness band, state
"extérieur / außen" on the polygon); (4) show each traced edge length next to the nearest dimension text.

## 7. Browser (pdf.js) versus Python - verdict

| capability | PyMuPDF | pdfplumber | pdf.js (+ JSTS) |
|---|---|---|---|
| text + bbox + direction | yes (best) | yes after own char grouping | yes (strings per text op; transform gives direction) |
| stroke paths + widths + dashes | yes | yes | yes, with ~120 lines of CTM/state tracking |
| fills | yes | yes | yes |
| PDF layers (OCG) | yes (`layer`) | not tested | yes (optional content config + marked content) |
| /Rotate | needs `remove_rotation()` | ok | ok (viewport) |
| speed on 200k segments | 2.4 s | 12.3 s | 1.4 s |
| rendering for display / OCR input | yes | via pdfium | yes (canvas) - not exercised here |
| geometry (noding, polygonize, mitred buffer) | shapely | shapely | **JSTS 2.12.1 reproduced 85.00 / 114.75 / 107.99 m² exactly** (`geom_js_spike.mjs`, 0.2-0.3 s) |
| OCR | RapidOCR (ONNX) | - | tesseract.js WASM (weaker on small text) / onnxruntime-web (not tested) |
| licence | AGPL / commercial | MIT | Apache-2.0 (+ EDL/EPL for JSTS) |

Conclusion: a 100 % client-side pipeline (pdf.js + JSTS, files never leave the expert's PC - relevant for client data) is
technically sufficient for the vector tier; only `analyze.py` (~450 lines of logic) has to be ported, or run through
Pyodide (not tested). Python is more comfortable for R&D. Do not ship PyMuPDF in a closed product without a licence.

## 8. LITERATURE - automatic floor-plan recognition on raster images (second-hand unless noted)

* **Raster-to-Vector** (Liu, Wu, Kohli, Furukawa, ICCV 2017): junction heat-maps + integer programming; README claims
  "around 90 % precision and recall" on Japanese real-estate floorplans (LIFULL HOME'S). Torch7/Py2.7 code, PyTorch
  port "not evaluated". (README read directly from GitHub raw.)
* **CubiCasa5K** (Kalervo et al., 2019): 5 000 Finnish real-estate marketing floorplans, > 80 object categories, polygon
  annotations; multi-task CNN on the R2V architecture. Dataset licence **CC BY-NC 4.0** (LICENSE read directly) ->
  not usable commercially as is. A secondary summary quotes mean room IoU ~57.5 % and icon IoU ~55.7 % on the test set
  (not verified against the paper tables).
* **RoomFormer** (CVPR 2023, MIT code) and **HEAT** (GPLv3 + "non-commercial research purposes only") are **not** for
  scanned drawings: RoomFormer's README says "2D floorplan reconstruction from 3D scans" (point-cloud density maps,
  Structured3D / SceneCAD). They are regularly cited for floorplans but solve a different input problem.
* Recent raster vectorisers: **Raster2Seq** (arXiv 2602.09016, SIGGRAPH 2026; project page admits artefacts on noisy
  CubiCasa5K because geometric constraints are not enforced), **PolyRoom**, **FRI-Net**, **FloorplanVLM** (arXiv 2602.06507,
  Qwen2.5-VL fine-tuned to emit JSON; 92.52 % external-wall IoU on the authors' own FPBench-2K), a 2024 multi-unit paper
  reporting mean F1 0.86 over five classes on CubiCasa. One search summary quotes HEAT on CubiCasa5K at Room F1 78.2 /
  Corner 53.7 / Angle 32.3. Protocols differ between papers; nothing is comparable to "area within x %".
* **Vector-native symbol spotting** on CAD drawings (FloorPlanCAD dataset, 30 "thing" + 5 "stuff" classes incl. walls):
  SymPoint 83.3 PQ, SymPoint-V2 90.1 PQ, CADTransformer ~68.9, GAT-CADNet 73.7, CADSpotting (2024). This is the family
  that would replace my line-weight heuristics for doors/windows/walls on vector PDFs/DXF. Licences and Europe-style
  drawings: not checked.
* **Commercial**: RasterScan (API on RapidAPI, HF demo), Planner 5D recognition API (accepts JPEG/PNG/PDF/DWG/DXF, aims at
  3D interiors), Tectly, Kreo / Togal.AI / Bluebeam for quantity take-off. **No vendor accuracy figure was found.**
  Bluebeam Revu's documented workflow is exactly the fallback proposed here: calibrate by clicking two points of a known
  length ("recommended" over typing the scale), "Snap to Content" on vector PDFs, separate X/Y scales for distorted scans,
  verify against a second known dimension, viewports for multi-scale sheets.
* Take-away: the public models are trained on real-estate marketing plans (few dimensions, no sections, other symbol
  conventions) and score IoU ~0.5-0.9 on rooms. An IoU of 0.9 can still be a 10 % area error. None of this is good
  enough to feed an official certificate without the human check; at best it pre-draws the polygon the user corrects.

## 9. LITERATURE + OFFICIAL DOCS - multimodal LLMs reading plans

* **AECV-Bench** (arXiv 2601.04819, Jan 2026; 120 floor plans for counting, 192 QA pairs): OCR / text-centric document QA
  up to ~0.95 accuracy; counting doors and windows only ~0.40-0.55 with large proportional errors (a review quotes
  Gemini 3 Pro at 0.39 exact-match for doors, 0.34 for windows, MAPE 15 % / 20 %); bedrooms/toilets > 0.70 because they
  can be read from labels.
* **Aliyev & Barsi 2026** (Periodica Polytechnica Civil Eng.): zero-shot room-area estimation by three open-source VLMs on
  100 colour-coded plans: R² ~0.71, **MAPE ~43 %**, worse for small rooms, far below deterministic image analysis.
* **ArchSIBench** (arXiv 2605.20837): 3 000 expert QA pairs on plans/sections/3D; best model (Gemini 3 Pro per a review)
  ~77.9 % average, near untrained humans, clearly below trained architects.
* **Anthropic vision documentation (read directly, platform.claude.com/docs/en/build-with-claude/vision)**:
  image cost = `ceil(w/28) * ceil(h/28)` visual tokens; max native resolution 2 576 px long edge / 4 784 visual tokens on
  "Claude 4.7 and later", 1 568 px / 1 568 tokens on other models, larger images are downscaled; limitations listed:
  "might hallucinate or make mistakes when interpreting low-quality, rotated, or very small images", "coordinate and
  localization outputs are approximate ... verify outputs before relying on them", counts are approximate.
  PDF input: 32 MB request, 600 pages (from the bundled claude-api skill reference).
  Consequence: an A3 sheet (3308 x 2339 px at 200 dpi) is reduced to about 2300 x 1630 px (~140 dpi equivalent) if sent
  as one image -> 6 pt text ~11 px: borderline. Send 4-6 overlapping tiles rendered at 200 dpi instead (each <= 4 784
  tokens, i.e. <= ~29 k input tokens per A3 sheet; with the price table cached in the skill on 2026-11-03 that is about
  0.3 cent (Haiku 5.5) to 12 cents (Opus 5.5) of input per sheet - verify prices before budgeting).
* How to use an LLM here (design, not tested): give it the **deterministically extracted text tokens with coordinates**
  plus the rendered tiles and ask for semantics only - which view is which storey, room label -> heated / unheated /
  ask, which text is the scale, the dimension unit note ("toutes les cotes en cm"), wall build-up legends, window
  schedule tables. Never ask it for a length or an area from pixels; never accept an LLM-read number without the
  consensus check of section 3.3. Every LLM answer becomes a pre-filled, visibly "to confirm" field.

## 10. Minimal human-in-the-loop flow that feels like a game (proposal)

Principle: the machine proposes, the user confirms with one tap; every confirmation fills a visible progress ring
("dossier complet à 60 %"), with live m² counters. Never a toolbar, never layers, never coordinates.

1. **Drop the file** -> sheet thumbnails; each detected view becomes a card ("Rez-de-chaussée", "Étage", "Coupe A-A") the
   user drags onto a small building silhouette (cellar / ground / floor / attic). Wrong guesses are fixed by dragging.
2. **Scale badge**. Vector + consensus: green badge "Échelle vérifiée 1:100 - 41 cotes concordantes" and nothing to do.
   Disagreement with the title block: orange badge "Le plan annonce 1:100, les cotes donnent 1:141 (impression
   réduite ?) - on utilise les cotes". No consensus: **"Pose la règle"**: a ruler with two magnetic ends; the user
   drops it on the longest dimension, the value field is pre-filled from OCR, a second perpendicular dimension is
   requested as a "double check" (reward animation when both agree within 1 %; if not: "scan déformé", X/Y scales).
3. **Heated envelope = colouring game**. Rooms appear tinted: orange = heated, blue = unheated, hatched = "?"; the user
   taps to flip. The outer outline of the orange set is drawn as a thick glowing line on the OUTER wall face with the
   wall band visible, area counter running. Garage / cave / grenier come pre-set to blue from the vocabulary.
   Fallback when rooms were not found: **"Relie les points"** - magnetic corners (vector endpoints or detected corners),
   right-angle lock, each edge shows its length next to the plan's own dimension text (green tick when they agree),
   the polygon closes with a snap. 4-12 taps for a house.
4. **Windows = tap on the façade**. Detected candidates (vector: thin rectangle with a glass line inside a wall gap) are
   shown as dots to confirm; missing ones are added by one tap on the outline; width comes from the plan, height from a
   single "hauteur de fenêtre type" value that can be overridden per window; orientation is derived from the north.
5. **North = compass dial** pre-rotated from the detected arrow; the user turns it if needed.
6. **Heights**: level marks from the section pre-fill "hauteur d'étage 2,80 m"; otherwise one number field.
7. **Plausibility screen** before export: sum of room labels vs measured rooms, outline vs rooms ratio (wall share), label
   vs measurement mismatches highlighted on the plan, calibration confidence, list of assumptions.

## 11. Tier strategy with expected accuracy on areas

"Measured" = this work on synthetic data; "expected" = my engineering estimate, to be validated on real plans.

| tier | input | how | area accuracy | must ask the user |
|---|---|---|---|---|
| 0 | IFC (also the route for Archicad `.pln`: export IFC; not researched here) | read IfcSpace / IfcWall / IfcWindow | expected: model-exact (< 0.1 %) if the model is well built; real risk is model quality, not precision | confirm heated spaces, storeys, what is missing in the model |
| 1 | DWG / DXF (not researched here) | model-space geometry, layers, real text, DIMENSION entities | expected < 0.5 %; unit ($INSUNITS) check by the same dimension/area consensus | confirm wall layers / outline, heated rooms, north, heights |
| 2a | vector PDF, clean (text is text, dims or area labels present, usable line weights or layers) | this pipeline | measured <= 0.1 % (synthetic). Expected on real plans 0.1-0.5 % once the outline is confirmed | confirm the proposed outline (1 tap), flip ambiguous rooms, compass, heights if no section |
| 2b | vector PDF, messy (hairlines, outlined fonts, sloppy snapping, clutter) | closing outline + snap-tracing on exact vector endpoints, OCR for texts | measured: auto rooms off by up to 22 %, closing outline still +0.5 %. Expected 0.3-1 % after user tracing with vector snapping | one ruler calibration if no text; trace or correct the outline; heated rooms; compass; heights |
| 3a | flat scan >= 200 dpi (or raster-only PDF) | OCR for labels (measured 100 % of room/area labels at 200 dpi), CV outline as suggestion (measured < 1 % on a clean synthetic scan), ruler + magnetic polygon | simulated 0.3-1.0 % mean, P95 <= 2.5 %; plus 1-2 % for paper/scan distortion -> expect **1-3 %** | ruler on the longest dimension (+ a perpendicular one), accept/redraw outline, heated rooms, tap windows, compass, heights |
| 3b | phone photo, <= 100 dpi, fax-like copies | 4-corner rectification, ruler x2, tracing; OCR unreliable (measured: area labels 0-82 %, invented numbers) | expected **3-8 %**; prefer the plan's own printed room areas and dimensions typed/confirmed by the user | everything in 3a plus sheet corners, and confirmation of every number read |

In every tier the dominant risks are **semantic blunders, not measurement precision**: wrong scale (-50 % measured),
inner instead of outer wall face (-17 %), garage/terrace inside the heated outline (+35 % on the FR fixture: 114.75 vs
85.0 m²), wrong storey assignment. The product should therefore spend its UX budget on the confirmation steps of
section 10 and on cross-checks, not on squeezing the last 0.1 % out of geometry.

## 12. Dead ends / gotchas log

* `pdfplumber.extract_words(extra_attrs=["size"])` splits rotated words (size = glyph advance) and reverses them.
* Subtracting `page.rotation` from the pdfminer char-matrix angle is WRONG (rotation is already folded in).
* Skipping wall segments shorter than 1 pt in the gap-bridging step broke the twin test (1 pt wall stubs between a door
  and a T-junction matter): three rooms merged into one of 44 m².
* Extending every segment by 0.5 pt does not rescue jittered drawings; the collinearity grouping breaks first.
* Classical-CV closing without small-blob removal glues dimension chains to the building (+23 % .. +147 %).
* `goodFeaturesToTrack` is a poor source of snapping corners.
* WebFetch to arxiv.org and huggingface.co is blocked in this sandbox; raw.githubusercontent.com and
  platform.claude.com worked.
