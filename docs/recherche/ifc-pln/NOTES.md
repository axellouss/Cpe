# Research notes - Archicad .pln projects and IFC models as input for a LuxEeB-Tool pre-fill

Date of work: 2026-11-27. Environment: Linux container, Node 22.23, Python 3.13, 4 CPUs, no Archicad, no Revit, no dotnet.
Everything under "PROVEN" was run here; everything else carries its source and a confidence mark:
`[run]` proved by running code here - `[official]` vendor / project's own documentation - `[secondary]` forum or search-engine
summary of a page I could not open - `[unverified]` memory or inference.

Network limits that shaped the work: `raw.githubusercontent.com`, npm, PyPI and nuget.org were reachable.
`help.graphisoft.com`, `community.graphisoft.com`, `aps.autodesk.com` were NOT reachable (DNS refused), so all Graphisoft and
Autodesk statements below come from search-result summaries of those pages, not from reading them.

Directory layout

```
NOTES.md                      this file
samples/                      10 real IFC files (untrusted downloads, never executed)
spike/inspect_ifc.py          semantic inventory with ifcopenshell (no geometry)
spike/energy_quantities.py    geometry first cut with ifcopenshell + shapely (the reference implementation)
spike/energy_bands.py         variant: slices the building by z instead of trusting storey containment
spike/uvalue_demo.py          U-value from material layers (patched Archicad file + file authored with the API)
spike/webifc_spike.mjs        same extraction + same geometry first cut with web-ifc, dependency-free (raster based)
spike/webifc_uvalue.mjs       U-value from layers with web-ifc
spike/measure_webifc_size.mjs WASM / JS bundle size raw, gzip, brotli
spike/browser/                server.mjs + test.html: web-ifc in a REAL headless Chrome
spike/compare.py, matrix.py   side-by-side reports
spike/run_all_*.sh            batch runners
out/                          every measured output (json + txt), out/compare.txt is the main one
web/                          READMEs / command list fetched from GitHub raw (PlaIO, RvtIO, rvt-rs, Tapir) - data only
venv/, spike/node_modules/    local installs
```

How to rerun

```bash
cd <this dir>
python3 -m venv venv && ./venv/bin/pip install ifcopenshell numpy shapely      # ifcopenshell 0.9.0.post1, numpy 2.5.5, shapely 2.2.0
(cd spike && npm install web-ifc)                                             # web-ifc 0.0.81
OUT_DIR=$PWD/out ./venv/bin/python -I spike/inspect_ifc.py samples/AC20-FZK-Haus.ifc
./venv/bin/python -I spike/energy_quantities.py samples/AC20-FZK-Haus.ifc --json out/AC20-FZK-Haus.energy.json
node spike/webifc_spike.mjs samples/AC20-FZK-Haus.ifc --json out/AC20-FZK-Haus.webifc.json
./venv/bin/python -I spike/compare.py out
./venv/bin/python -I spike/uvalue_demo.py samples/AC20-FZK-Haus.ifc out/authored
node spike/measure_webifc_size.mjs
# real browser: node spike/browser/server.mjs 8791 out/webifc_chrome_single.json &
#               google-chrome --headless=new --no-sandbox --disable-gpu --no-proxy-server http://127.0.0.1:8791/test.html
```

`python -I` (isolated mode) is used because the IFC files are untrusted downloads; scripts live in `spike/`, data in `samples/`.

---------------------------------------------------------------------------------------------------------------------------

# PART 1 - "I have a PLN"

## 1.1 Is there any parser for .pln / .pla / .tpl / .bpn outside Archicad?  Answer: no usable one.

| candidate | what it really does | confidence |
|---|---|---|
| **PlaIO 0.1.0** (NuGet `PlaIO`, `PlaIO.Cli`; github IOExtend/PlaIO; MIT; .NET 8/10; NuGet page: 94 downloads, last updated 11/12/2026) | Reads only the *container* of .pla/.pln (file starts with `ROF FDB `): header, `BL`/`DY` block index, raw / zero-mask / LZ payloads, 30-byte "object directory" records (class number, pos, count, GUID), and the PNG cover of a .bimx. README, Limitations: "Class names and the contents of objects (elements, parameters, geometry) are not interpreted", "Version 0.1.0 is a preview", developed against files saved by Archicad 27, 29, 30. | `[official]` project README + NuGet page, read here (`web/IOExtend_PlaIO_main_README.md`). Not run (no dotnet in the container). |
| Graphisoft: converter / SDK that reads PLN without Archicad | None found. Community threads "Converting Archicad pln to IFC without install Archicad", "Is there any API that can read pln file, also don't open it in [Archicad]" end without a solution; a Wishlist item "Extracting information from a PLN without opening it" is still open. A moderator's argument: the same PLN gives very different IFCs depending on translator settings, so a context-free converter makes little sense. | `[secondary]` search summaries of community.graphisoft.com (host blocked) |
| Archicad C++ Add-On API (API DevKit) | Runs *inside* Archicad as an add-on. Not a file reader. | `[unverified]` (general knowledge, consistent with all sources above) |
| Archicad JSON / Python API (+ Tapir add-on) | Talks over HTTP to a **running** Archicad (`http://127.0.0.1:19723`, next instances 19724...). Not a file reader. See 1.3. | `[official]` Tapir README |
| Open Design Alliance (ODA) | ODA has RVT/RFA (BimRv) and IFC and DWG SDKs; no trace of PLN support (a Graphisoft forum user: "if the ODA would announce ARCHICAD PLN support..."). Archicad itself uses the ODA engine to import RFA/RVT. | `[secondary]`, ODA's own format matrix not checked |
| Autodesk Platform Services (Model Derivative) | I could not open the supported-formats page. From memory PLN is not a supported source format. | `[unverified]` |
| BIMx (.bimx) | Graphisoft's presentation format. No public spec or parser; PlaIO reads only its cover PNG. | `[official]` for PlaIO part, rest `[unverified]` |
| PRONOM (UK National Archives) | Only identification signatures for PLN (fmt/1913, fmt/1955), no structure. | `[secondary]` |

Free ways to *open* a PLN: Archicad **demo mode** opens any file but "cannot be saved, copied, exported, or published" - so no IFC
export. The 30-day **trial** has full functionality; the education version watermarks. `[secondary]` (Graphisoft support article
summaries). So "the expert who only received a PLN and owns no Archicad" cannot convert it for free in a legitimate, durable way.

**Conclusion 1.1**: a PLN can only be turned into something readable by Archicad itself. The product must not promise "drop your .pln".
What it can promise: "drop the IFC (or PDF/DWG) that Archicad saves from that PLN - here is the 30-second recipe", and later a
one-click connector for users who have Archicad open (1.3).

## 1.2 What Archicad can export that a third-party tool can read

| export | content relevant to a CPE | notes / confidence |
|---|---|---|
| **IFC 2x3** (Coordination View 2.0; Archicad is certified for CV2.0 import+export) | geometry, storeys, zones as IfcSpace, layer sets, psets, base quantities, optional space boundaries | `[secondary]` help pages; structure confirmed on 4 real Archicad files `[run]` |
| **IFC4** (Reference View, Design Transfer View; help of AC 29/30 also lists IFC4.3 as a translator schema) | same; in IFC4 the building-material data goes onto `IfcMaterial` (`Pset_MaterialThermal`, `Pset_MaterialCommon`) | `[secondary]` + `[run]`: AC20-FZK-Haus.ifc really carries `Pset_MaterialThermal.ThermalConductivity` on its materials (value 0.0 because the model had none) |
| translator options that matter | "IFC Space boundaries" (writes IfcRelSpaceBoundary - "useful in thermal calculation applications"), "IFC Base Quantities", "Building Material properties", property mapping: Archicad *Position* (Exterior / Interior / Undefined) -> `Pset_*Common.IsExternal` | `[secondary]` help pages 121_IFC-42, 121_IFC-50; the Position->IsExternal behaviour is confirmed `[run]`: FZK-Haus AC20 has Position "Nicht definiert" on all walls and **no IsExternal at all** |
| **gbXML** (Energy Evaluation, standard feature) | thermal blocks, opaque/transparent 2nd-level space boundaries with U-value, materials | `[secondary]`. Potentially the richest export (surfaces by type with azimuth/tilt/area) but it only exists if the architect set up Energy Evaluation (zones + thermal blocks). I had no Archicad-made gbXML to test. **Open question.** |
| **PHPP** export (Energy Evaluation, standard; PHPP 7 and 9) | writes space-boundary and material data into a PHPP Excel workbook the user owns | `[secondary]` |
| VIP-Energy, SBEM/iSBEM, baseline | only with the EcoDesigner STAR add-on | `[secondary]` |
| **DWG / DXF** | 2D drawings (plans, sections) via DXF/DWG translators | `[unverified]` general knowledge; covered by another researcher |
| **PDF** | layouts / views, vector | idem |
| **Schedules -> XLS/XLSX** | Interactive Schedule window: Save As Excel workbook (zone lists with areas, window lists with W x H, wall lists) | `[secondary]`; a zone schedule + a window schedule would already answer area and window questions, but needs schedule set-up by the user |
| **BIMx** | closed, not usable | |
| **JSON/Python API** | live access to elements, properties, zones, composites, building-material physical properties | 1.3 |

## 1.3 The automation API - a realistic "connector" when Archicad is running

Source: Tapir README and command list fetched from `raw.githubusercontent.com/ENZYME-APD/tapir-archicad-automation/main/...`
(`web/ENZYME-APD_*`), i.e. the project's own documentation `[official]`. Nothing here was run (no Archicad).

* Archicad (24+) has a built-in JSON interface: POST JSON to `http://127.0.0.1:19723`; the official `archicad` Python package wraps
  it (`GetElementsByType`, `GetPropertyValuesOfElements`, ...). It needs a running, licensed Archicad with the project open.
* **Tapir** ("free and open source", licence text not checked) is an add-on installed into Archicad 25-30 (Win + Mac, signed installer)
  that adds **831 JSON commands** (count from `docs/archicad-addon/command_definitions.js`). Call pattern (from the README):

```python
import json, urllib.request
req = urllib.request.Request("http://127.0.0.1:19723", headers={"Content-Type": "application/json"})
body = {"command": "API.ExecuteAddOnCommand", "parameters": {
        "addOnCommandId": {"commandNamespace": "TapirCommand", "commandName": "GetAddOnVersion"},
        "addOnCommandParameters": {}}}
print(json.load(urllib.request.urlopen(req, json.dumps(body).encode()))["result"]["addOnCommandResponse"])
```

* Commands that matter for us (names and descriptions copied from the command list):
  `OpenProject`, `GetProjectInfo`, `GetStories` (level, height), **`IFCFileOperation`** ("saves the project as an IFC file. A save can name
  the export translator to use"), `GetIFCExportTranslators`, `GetZoneBoundaries` (connected elements, neighbour zones),
  `GetZoneReductions` (area reductions for walls, sloping roofs, low ceilings), `GetBuildingMaterialPhysicalProperties`,
  `GetBuildingMaterials`, `GetComposites`, `GetDetailsOfElements` (geometry parameters), `Get3DGeometryOfElements`,
  `GetRelationsOfElements` (zones on the two sides of windows/doors), `GetSurfaceQuantitiesOfElements`, `CalculateSunPosition`.
* What this enables: a button "Import from the Archicad that is open" which (a) asks Archicad to save an IFC with *our* translator
  settings, or (b) reads zones, composites and conductivities directly - data that usually gets lost in a hand-made IFC export.
  Cost: user must install an add-on (admin rights on Windows) and own Archicad. It is a v2 feature, not the MVP.

## 1.4 Realistic path for a user who "has a PLN"

1. User has Archicad (architects): File > Save as > IFC. We ship a one-page recipe (FR/DE, screenshots) and ideally an importable
   translator: IFC4 (or 2x3 CV2.0), **Base Quantities on, Space Boundaries on, Building Material properties on**, whole model, with zones.
   Expect ~2-15 MB for a house (the Archicad samples here are 2.6-4.6 MB).
2. User has no Archicad (most energy experts): ask the architect for the IFC (plus PDF plans as fallback). The app should generate
   the e-mail to the architect ("please export IFC with these 3 options") - that is the honest "PLN support".
3. Later: Tapir/JSON connector (1.3).
4. Never: parsing the PLN ourselves. A reverse-engineering effort exists (PlaIO) but decodes no elements, and the format changes
   with every Archicad release.

## 1.5 Same question for Revit (.rvt)

RVT is also proprietary (OLE compound file with undocumented streams). The official route is IFC export from inside Revit (Autodesk's
exporter is open source but is a Revit add-in). Without Revit: Autodesk Platform Services (cloud, paid, per-job; job output types
include `ifc` per the API reference summary - `[secondary]`), or the ODA BimRv SDK (commercial membership - `[secondary]`).
New since 2025-26 and worth watching, but **not tested here**: `RvtIO` (MIT, .NET, preview 0.4.0, README claims it reads Revit 2020-2026
files "without Revit or the Revit API" and exports IFC2x3 / IFC4 / GLB / JSON; "Byte equality with Revit's own IFC export is not claimed")
and `rvt-rs` (Apache-2.0, Rust/Python, README: "not yet a full Revit model reader") - both `[official]` READMEs in `web/`, maturity and
legal standing unverified. For the product the answer is the same as for PLN: accept the IFC, give the user the export recipe.
Revit-made IFCs are, on the evidence below, *less* reliable than Archicad-made ones (no spaces unless Rooms were placed, IsExternal from
the wall type "Function", default locations, implausible auto-computed U-values).

---------------------------------------------------------------------------------------------------------------------------

# PART 2 - IFC spike (everything in this part was run)

## 2.1 Sample files (all downloaded with curl from raw.githubusercontent.com)

| file | origin | authoring tool | schema / MVD in header | size |
|---|---|---|---|---|
| AC20-FZK-Haus.ifc | ThatOpen/engine_web-ifc/main/tests/ifcfiles/public/ | ARCHICAD 20 | IFC4, `[, QuantityTakeOffAddOnView, SpaceBoundary2ndLevelAddOnView]` | 2.6 MB |
| AC11-FZK-Haus-IFC.ifc | opensourceBIM/TestFiles/master/TestData/data/ | ArchiCAD 11 | IFC2x3 | 4.1 MB |
| AC11-Institute-Var-2-IFC.ifc | idem | ArchiCAD 11 (5-storey office) | IFC2x3 | 2.8 MB |
| AC9R1-Haus-G-H-Ver2-2x3.ifc | idem | ArchiCAD 9 (semi-detached house with basement) | IFC2x3 | 4.6 MB |
| Ifc2x3_Duplex_Architecture.ifc | youshengCode/IfcSampleFiles/main/ (= buildingSMART "Duplex_A_20110907") | Revit Architecture 2011 | IFC2x3 CoordinationView | 2.4 MB |
| SampleHouse4.ifc | xBimTeam/XbimEssentials/master/Tests/TestFiles/ | Revit 2015 | IFC4 CV2.0 + QTO | 2.3 MB |
| Ifc4_SampleHouse.ifc | youshengCode/IfcSampleFiles/main/ | same model re-saved by xbim | IFC4 | 2.3 MB |
| Ifc4_Revit_ARC.ifc | idem | Revit 2021 (split-level house, retaining walls) | IFC4 ReferenceView_V1.2 | 13.6 MB |
| BasicHouse.ifc | andrewisen/bim-whale-ifc-samples/main/BasicHouse/IFC/ | Revit 2021 | IFC2x3 CV2.0 + QTO | 52.7 MB |
| AdvancedProject.ifc | idem /AdvancedProject/IFC/ | Revit 2021 (13 apartment blocks on one site) | IFC2x3 CV2.0 + QTO | 44.3 MB |

Dead ends: `buildingSMART/Sample-Test-Files/.../Duplex_A_20110907.ifc` and `aothms/IfcOpenHouse/master/IfcOpenHouse.ifc` -> 404 at the
guessed paths; GitHub API / HTML / jsdelivr / unpkg are blocked so directories could not be listed. **Limit of the evidence: the newest
Archicad export I could get is Archicad 20 (2016). No Archicad 25-29 export, no file from a Luxembourg office.** The four Archicad files
are KIT test models that were prepared carefully (zones, space boundaries) - real office files will be worse.

## 2.2 What is really in the files (out/*.inventory.json, out/matrix.txt)

| file | app / schema | len unit | TrueNorth | spaces (with area qto) | walls: IsExternal T/F/missing | walls w/ Qto | walls w/ layer set | walls w/ U | windows: dims / host / U / IsExternal present | slab types | lambda>0 materials | space boundaries |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| AC9R1-Haus-G-H | ArchiCAD 9 / IFC2X3 | METRE | 0 deg | 26 (0) | 0/0/60 | 60/60 | 60/60 | 0/60 | 35/35/0/0 of 35 | FLOOR 31, ROOF 4 | 0/11 | 513 (2nd level) |
| AC11-FZK-Haus | ArchiCAD 11 / IFC2X3 | METRE | 0 deg | 7 (7) | 8/5/0 | 13/13 | 13/13 | 13/13 | 11/11/11/11 of 11 | BASESLAB 1, FLOOR 1, ROOF 2 | 0/5 | 98 (2nd level) |
| AC11-Institute | ArchiCAD 11 / IFC2X3 | METRE | 0 deg | 82 (82) | 44/75/0 | 119/119 | 119/119 | 119/119 | 206/206/206/206 of 206 | FLOOR 5, ROOF 21 | 0/4 | 1175 (2nd level) |
| AC20-FZK-Haus | ARCHICAD 20 / IFC4 | METRE | 50 deg | 7 (7) | **0/0/13** | 13/13 | 13/13 | 13/13 | 11/11/11/**0** of 11 | BASESLAB 1, FLOOR 1, ROOF 2 | 0/6 (4 present as 0.0) | 81 (2nd level, "2a") |
| Duplex (Revit 2011) | Revit / IFC2X3 | METRE | **MISSING** | 21 (0) | 23/34/0 | 0/57 | 57/57 | 0/57 | 24/24/0/24 of 24 | FLOOR 20, ROOF 1 | 0/18 | 265 (1st level) |
| SampleHouse4 (Revit 2015) | Revit / IFC4 | MILLIMETRE | 0 deg | 4 (4) | 3/2/0 | 2/5 | 2/5 | 5/5 | 4/4/4/4 of 4 | FLOOR 2 | 0/32 | none |
| Ifc4_Revit_ARC (Revit 2021) | Revit / IFC4 RV | MILLIMETRE | 0 deg | **0** | 28/19/0 | 47/47 | 47/47 | 12/47 | 17/15/2/17 of 17 | FLOOR 10, BASESLAB 23, ... | 0/107 | none |
| BasicHouse (Revit 2021) | Revit / IFC2X3 | MILLIMETRE | 0 deg | **0** | 4/9/0 | 13/13 | 13/13 | 0/13 | 19/19/0/19 of 19 | NOTDEFINED 2, FLOOR 1 | 0/53 | none |
| AdvancedProject (Revit 2021) | Revit / IFC2X3 | MILLIMETRE | 0 deg | 8 (8) | **390/0/0** | 381/390 | 389/390 | 67/390 | 263/263/0/263 of 263 | FLOOR 41, NOTDEFINED 2 | 0/97 | none |

Reading of the table, item by item (the list the brief asked for):

* **Length units**: METRE in Archicad files, MILLIMETRE in Revit 2015+ files. `ifcopenshell.util.unit.calculate_unit_scale(f)` gives
  1.0 / 0.001. `ifcopenshell.geom` and web-ifc geometry both come out in metres; *attributes* (OverallWidth, LayerThickness, Elevation,
  quantities) stay in file units and must be scaled (areas x scale^2). Angle unit DEGREE everywhere.
* **True north**: `IfcGeometricRepresentationContext.TrueNorth` present in 9/10 files but = (0,1) "north is +Y" in 8 of them, i.e. the
  export default; only AC20-FZK-Haus has a real value (0.766, 0.643 = 50 deg clockwise from +Y). Missing in the Revit 2011 file.
  `IfcMapConversion`: in none. Convention used: bearing(v) = atan2(vx, vy); compass azimuth of a normal = bearing(n) - bearing(TrueNorth).
* **Site lat/long**: present in 9/10 files but not trustworthy. The same house says 52.52N 13.40E (Berlin) in the ArchiCAD 11 export
  and 49.10N 8.44E (Karlsruhe, where the model was made) in the AC20 export; the Revit files say Chicago, London, Boston (which I
  believe is Revit's default location - `[unverified]`) and Stockholm, and I cannot tell which are real. Never use it to pick a
  climate zone without asking.
* **Storeys and elevations**: always present. Revit files contain helper levels that are not storeys ("T/FDN" -1.25, "Ceiling" 2.7,
  "Level 1 Living Rm." -0.55, "Roof Line", "Level 2" 4.0 next to "1 - First Floor" 3.5). The tool must let the user confirm the storeys.
* **IfcSpace**: all 4 Archicad files have zones as spaces with geometry; 2 of 6 Revit files have none, AdvancedProject only 8 (one flat).
  Names are the room number, LongName the room name ("Schlafzimmer", "Küche", "Heizung", "Keller" - useful to guess heated/unheated).
  Quantities: `BaseQuantities` with `NetFloorArea`, `GrossFloorArea`, `Height`, `NetVolume`... in AC11/AC20 and Revit 2015/2021;
  none in ArchiCAD 9 and Revit 2011. See 2.4 for why `NetFloorArea` must not be used blindly.
* **Walls**: `IfcWallStandardCase` (Archicad, Revit 2x3) / `IfcWall` (IFC4). `Pset_WallCommon.IsExternal`: see 2.5.
  Base quantities (`GrossSideArea`, `NetSideArea`, `Length`, `Height`, `Width`) present in most files, absent in Revit 2011.
  Archicad adds `ArchiCADQuantities` with *exactly* what a thermal calc wants ("Brutto-Wandoberflächenbereich an der Außenseite",
  "Oberflächenbereich der Fenster in der Wand", ...) but under **localised property names** (German here) - unusable generically.
* **Windows / doors**: `OverallWidth`/`OverallHeight` on 100 %. Host wall through `IfcRelFillsElement -> IfcOpeningElement ->
  IfcRelVoidsElement` on 100 % of Archicad windows; Revit: skylights are hosted by `IfcRoof` (Duplex) or have **no host at all**
  (Revit 2021 RV file, 2 skylights). `Pset_WindowCommon.ThermalTransmittance`: Archicad FZK 1.4 (typed by the modeller);
  Revit 5.56 / 3.69 (family defaults); absent in 3 Revit files. `GlazingAreaFraction`: only in the Revit 2011 file and its value is the
  literal string "GlazingAreaFraction". g-value: only as Revit's "Analytical Properties.Solar Heat Gain Coefficient" (0.86) in one file.
  Frame share: never.
* **Slabs**: `PredefinedType` BASESLAB/FLOOR/ROOF is clean in Archicad 11/20. Archicad 9 and Revit put ground slabs as FLOOR; Revit roofs
  are `IfcRoof` (no geometry) aggregating `IfcSlab` with PredefinedType **NOTDEFINED**; Revit 2021 RV marks 23 footings as BASESLAB.
  Rule that worked: roof = slab with type ROOF **or** aggregated under an IfcRoof.
* **Roof slope**: `Pset_SlabCommon.PitchAngle` only in Revit files (and 0.0 for most); never in Archicad. Slope from the mesh normal
  works on all files (30 deg FZK-Haus, 42 deg + 15 deg dormers Haus G-H, 14.3 deg BasicHouse = its PitchAngle).
* **Material layer sets**: the reliable part. 100 % of walls and slabs in 8/10 files carry an `IfcMaterialLayerSet` with thickness and
  material name ("Isolierung, weich" 0.10 + "Stahlbeton" 0.25; "Masonry - Brick" 0.092 / "Air Space" 0.025 / "Rigid insulation" 0.05 /
  "Concrete Block" 0.193 / "Metal - Stud Layer" 0.041 / "Plasterboard" 0.016). The FZK-Haus files are single-layer placeholders.
* **Thermal conductivity**: non-zero in **0 of 10** files (0 of 365 `IfcMaterial` entities). AC20 writes `Pset_MaterialThermal.ThermalConductivity = 0.0`.
  So a U-value from layers was computable on none of the real files -> 2.6.
* **U-value in psets**: Archicad: typed by hand (ext. wall 0.4, int. wall 1.5, roof 0.3). Revit: computed from material assets and often
  absurd - walls 47.5 and 10.46 W/m2K, slab 6.3. Must be shown as a suggestion only.
* **IfcRelSpaceBoundary**: all 4 Archicad files (2nd level, with `IfcCurveBoundedPlane` geometry and INTERNAL/EXTERNAL flag);
  Revit 2011: 1st level; Revit 2015/2021: none. See 2.4.

## 2.3 The geometry first cut (spike/energy_quantities.py and spike/webifc_spike.mjs)

Method - deliberately independent of IsExternal, base quantities and space boundaries:

1. Tessellate walls, slabs, roofs, spaces, windows, doors in world coordinates, metres
   (ifcopenshell: `settings.set("use-world-coords", True)`; walls also with `"disable-opening-subtractions"` = gross geometry;
   web-ifc: `StreamAllMeshesWithTypes`, vertices are Y-up -> IFC (x, y, z) = (X, -Z, Y)).
2. **Footprint per storey (external dimensions)** = union of the plan projections of the walls and spaces of the storey, gaps <= 6 cm
   closed, holes filled, pieces < 4 m2 dropped. Python: shapely. JS: occupancy grid (2.5 cm cells), dilate, flood-fill the outside
   from the border, erode back - no library.
3. **Facade**: a vertical triangle of a wall (or floor-slab edge) is exterior when a probe 10 cm in front of it is outside the footprint,
   a probe 10 cm behind is inside, and the face lies within 3 cm of the footprint outline. Outward normal -> compass sector (8 x 45 deg).
   Gross = geometry without openings; net = geometry with openings.
4. **Windows / doors**: area = OverallWidth x OverallHeight; exterior if exactly one of two probes 0.6 m either side of the element plane
   is outside the footprint; orientation = exterior normal of the host wall (fallback: PCA of the mesh). Also computed: silhouette area
   of the mesh on its own plane.
5. **Roof**: upward triangles of roof slabs, clipped to the footprint (overhangs excluded), area / cos(slope), grouped by slope + sector.
6. **Gross volume**: height field on a 5 cm grid - highest and lowest point of walls/slabs/roofs above each cell, clipped to the storey
   band, masked by the storey footprint. Handles pitched roofs without any solid modelling.
7. **Floor area**: IfcSpace quantities next to the area recomputed from the space mesh, plus area with clear height >= 1.0 / 1.5 / 2.0 m
   (height field of the space solid).
8. Space boundaries (if present): areas of EXTERNAL physical boundaries by element class and orientation, read from the
   `IfcCurveBoundedPlane` polylines.

### Verification on AC20-FZK-Haus (12 m x 10 m house, 30 deg gable roof, true north 50 deg) - hand calculation vs. both toolchains

| quantity | by hand | ifcopenshell + shapely | web-ifc + raster |
|---|---|---|---|
| footprint, each storey | 12 x 10 = 120.00 m2 | 120.0 | 120 |
| gross volume ground storey (slab bottom -0.2 to +2.7) | 120 x 2.9 = 348.0 m3 | 348.0 | 348 |
| gross volume attic (to top of roof covering) | 2 x 5 x (0.731 + 3.618)/2 x 12 = 260.9 m3 | 260.92 | 260.92 |
| facade ground storey, long / short side (incl. 0.2 m slab edge) | 34.8 / 29.0 m2 | 34.8 / 29.0 | (net only) |
| gable wall | 2 x 5 x (0.5 + 3.387)/2 = 19.43 m2 | 19.43 | - |
| knee walls | 12 x 0.5 = 6.0 m2 | 6.0 | 6 |
| net wall by orientation NE / SE / SW / NW | - | 40.85 / 28.83 / 38.82 / 31.2 | 40.85 / 28.83 / 38.82 / 31.2 |
| roof inside the outline, per pitch | 12 x 5 / cos 30 = 69.28 m2 | 69.28 (82.56 with overhang = Archicad's GrossArea 82.561) | - |
| windows NE / NW / SE / SW (W x H) | - | 5.8 / 7.2 / 4.8 / 5.8 = 23.6 | identical |
| exterior doors SE / SW | - | 4.77 / 2.03 | identical |
| round gable windows d = 1.0 m | pi/4 = 0.785 m2 | W x H says 1.0, silhouette 0.784 | - |
| exterior walls found | 8 named "Wand-Ext-*" | 8 EXT / 5 INT with **no IsExternal in the file** | 8 / 5 |

The same building exported by ArchiCAD 11 (true north = +Y) gives the same numbers with sectors N/E/S/W, and there the geometric
test agrees with the pset on 13/13 walls and 16/16 openings. On the Institute building it agrees on **119/119 walls and 283/283 openings**.

### Cross-check of the two toolchains on all files (out/compare.txt)

| file | gross floor area m2 (py / js) | gross volume m3 (py / js) | windows total m2 (py / js) | exterior walls geometry vs pset |
|---|---|---|---|---|
| AC20-FZK-Haus | 240.0 / 240 | 608.92 / 608.91 | 23.6 / 23.6 | 8 ext, pset missing |
| AC11-FZK-Haus | 240.0 / 240 | 608.92 / 608.91 | 23.6 / 23.6 | 13/13 agree |
| AC9R1-Haus-G-H | 443.26 / 442.62 | 1216.88 / 1213.02 | 68.46 / 68.45 | 28 ext, pset missing |
| AC11-Institute | 2592.0 / 2591.99 | 7315.92 / 7315.9 | 309.5 / 309.5 | 119/119 agree |
| Duplex (Revit 2011) | 626.56 / 626.56 | 1062.1 / 1056.79 | 65.95 / 65.94 | 16 ext; 7 walls declared external are not on the facade (4 party walls, 3 inner foundation walls) |
| SampleHouse4 | 162.06 / 161.8 | 310.68 / 310.68 | 8.76 / 8.76 | 5/5 agree |
| BasicHouse | 214.7 / 214.7 | 715.29 / 715.27 | 38.18 / 38.18 | 13/13 agree |
| Ifc4_Revit_ARC | 333.92 / 294.67 | 1025.34 / 923.37 | 29.24 / 60.75 | **both wrong** - see 2.5 |
| AdvancedProject | 12962 / 12812 | 21186 / 18932 | 757.68 / 757.68 | **both wrong** - see 2.5 |

On the 7 clean models the two independent implementations agree within 0.5 %. On the two messy ones they disagree with each other
and with reality - that is the honest boundary of "fully automatic".

## 2.4 Things that look usable but are traps

* **`NetFloorArea` of an Archicad space is the architect's own "calculated area"**, not a physical quantity. FZK-Haus AC20: attic
  "Galerie" NetFloorArea 74.51 m2, while its floor polygon is 107.16 m2; the height field of the space solid gives 94.62 m2 (h >= 1.0 m),
  **74.10 m2 (h >= 1.5 m)**, 54.72 m2 (h >= 2.0 m): Archicad applied a 1.5 m low-ceiling cut set in that project. Ground-floor rooms:
  21.41 vs 22.07 = exactly 3 % deduction (plaster allowance). The kitchen has no deduction. AC11 export of the same house: 107.16.
  -> compute the energy reference area from the space geometry with the regulation's own rule; show the IFC value only as a comparison.
* **Space boundaries give inner dimensions.** FZK-Haus, EXTERNAL physical boundaries: walls 154.5 m2 (boundary polygons *include* the
  window areas and exclude the strips where partitions meet the facade), windows 23.17, base slab 101.39, roof 123.74 - against
  178.5 / 23.6 / 120 / 138.6 m2 by external dimensions. If the regulation wants external dimensions (to be confirmed by the regulation
  researcher) space boundaries underestimate the envelope by 10-16 % on this house. In the Revit 2011 file the "EXTERNAL" flag also
  covers party walls (524 m2 of "external wall" boundaries on a building with 420 m2 of facade including foundations).
* **OverallWidth x OverallHeight** over-states non-rectangular windows (round: +27 %). Cheap fix: mesh silhouette or opening geometry.
* **Storey containment** (`IfcRelContainedInSpatialStructure`) is not a floor-by-floor description in Revit exports: in AdvancedProject
  109 of 110 walls attached to "1 - First Floor" are 15 m high, and storeys 2-5 contain no wall. `energy_bands.py` slices by z instead
  and gets a footprint on every floor; it needed a second rule to keep 0.5 m knee walls (first version lost them: 112.98 instead of 120 m2).
* **Windows and doors must not be tessellated with ifcopenshell**: 47 s of 64 s on BasicHouse is 27 Revit window/door families
  (617 000 triangles in a 13-wall house). web-ifc did the whole file in 0.5 s. Use W x H + host wall, or tessellate openings only.
* **Balconies / porches / terraces**: adding floor slabs to the footprint inflated the Duplex ground floor from 156.6 to 207.5 m2 and
  lost two facades. Footprint must come from walls + spaces only (current code).
* Not handled, known: walls exported as parts (`IfcBuildingElementPart`, Archicad option to explode composites), curtain walls
  (only partly), elements below ground (no terrain reasoning), cantilevers (height field assumes nothing open underneath),
  several buildings in one file, unheated attached volumes (garage, cellar) - nothing in IFC says "heated".

## 2.5 Where IFC exports are unreliable - evidence from these files

| issue | evidence here | consequence for the tool |
|---|---|---|
| IsExternal missing | AC20-FZK-Haus: 0 of 13 walls, 0 of 16 openings, 0 of 4 slabs (Archicad Position left "Undefined"); ArchiCAD 9 file: no Pset_WallCommon | derive exterior from geometry, never require the pset |
| IsExternal wrong | AdvancedProject: **390 of 390 walls True** (more than 210 of them are on no facade: 238 by the Python implementation, 213 by the JS one); Duplex: party walls and inner foundation walls True, roof `Pset_RoofCommon.IsExternal` False, slab-on-grade False; Revit_ARC: 10 retaining walls True | show classification, let the user fix by click |
| no spaces | 2 of 6 Revit files; Revit exports rooms only if Rooms exist and the option is on | fall back to footprint minus walls, or ask the area |
| space quantities absent or "creative" | none in AC9 / Revit 2011; architect's deductions in AC20 | recompute from geometry |
| true north | default +Y in 8 of 10, missing in 1 | always ask (compass on the plan) |
| location | same house: Berlin in one export, Karlsruhe in the other; others unverifiable | ask the commune |
| conductivity | 0 of 365 materials | constructions must come from a catalogue or typed U |
| U-values | hand-typed (Archicad) or implausible defaults (Revit: 47.5, 10.46, 5.56) | suggestion only |
| glazing fraction, g, frame | effectively never | ask per window type / defaults by glazing type |
| roof typing | Revit: IfcRoof without geometry + NOTDEFINED slabs | use aggregation, not PredefinedType |
| levels | helper levels in every Revit file | user confirms storeys |
| site walls, retaining walls, several buildings | Revit_ARC (split-level, retaining walls): facade 1080 m2 for a ~150 m2 footprint; AdvancedProject: 13 outlines, 11 081 m2 | user must pick the heated outline; this cannot be guessed |

General statements from the literature / forums (not from my files): Archicad writes IsExternal from the element's *Position*
classification and not at all for some element types `[secondary]`; Revit writes it from the wall type's *Function* parameter and
windows default to False in some versions `[secondary]`.

## 2.6 U-value from layers

No real file allowed it, so the code path is proven on two constructed cases (`spike/uvalue_demo.py`, `spike/webifc_uvalue.mjs`):

1. AC20-FZK-Haus with conductivities written into the `Pset_MaterialThermal` Archicad had already created
   (Leichtbeton 0.21, Stahlbeton 2.3, "Solid" 0.13 - my values, for the demo only): exterior wall 0.30 m -> U = 1/(0.13 + 0.30/0.21 + 0.04)
   = **0.626** (pset says 0.4), interior wall 0.24 m -> 0.762 (pset 1.5), roof -> 0.596 (pset 0.3). Same numbers from web-ifc (0.6256, 0.7617).
2. A wall authored with `ifcopenshell.api` (render 15 mm 0.87 / EPS 160 mm 0.032 / clay block 240 mm 0.45 / plaster 15 mm 0.51):
   U = **0.1739** by code (both toolchains) = 0.1739 by hand.

Where to read lambda: IFC4 `IfcMaterial.HasProperties -> IfcMaterialProperties("Pset_MaterialThermal").ThermalConductivity`;
IFC2x3 `IfcThermalMaterialProperties.ThermalConductivity` (none in the samples). Treat 0.0 as missing. Formula used: EN ISO 6946 with
Rsi/Rse 0.13/0.04 walls, 0.10/0.04 roofs, 0.17/0.04 floors; homogeneous layers only - stud layers ("Metal - Stud Layer"), air gaps and
fixings need the standard's corrections, which the code does not do. API snippet that worked:

```python
f = ifcopenshell.api.run("project.create_file", version="IFC4")
ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcProject", name="demo"); ifcopenshell.api.run("unit.assign_unit", f)
wall = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcWall", name="AW1")
ls = ifcopenshell.api.run("material.add_material_set", f, name="AW1", set_type="IfcMaterialLayerSet")
m = ifcopenshell.api.run("material.add_material", f, name="EPS 032")
layer = ifcopenshell.api.run("material.add_layer", f, layer_set=ls, material=m)
ifcopenshell.api.run("material.edit_layer", f, layer=layer, attributes={"LayerThickness": 160})
ps = ifcopenshell.api.run("pset.add_pset", f, product=m, name="Pset_MaterialThermal")
ifcopenshell.api.run("pset.edit_pset", f, pset=ps, properties={"ThermalConductivity": 0.032})
ifcopenshell.api.run("material.assign_material", f, products=[wall], material=ls)
```

## 2.7 web-ifc: size and speed

Package `web-ifc` 0.0.81, licence MPL-2.0 (`spike/measure_webifc_size.mjs`):

| file | raw | gzip -9 | brotli 11 |
|---|---|---|---|
| web-ifc.wasm (browser, single thread) | 1681 KiB | 611 KiB | 461 KiB |
| web-ifc-mt.wasm (threads, needs COOP/COEP) | 1646 KiB | 608 KiB | 447 KiB |
| web-ifc-node.wasm | 1610 KiB | 603 KiB | 444 KiB |
| web-ifc-api.js (ESM; mostly schema tables) | 6003 KiB | 526 KiB | 245 KiB |
| web-ifc-api-iife.js | 6189 KiB | 532 KiB | 248 KiB |

So a browser downloads about **1.1 MB gzip / 0.7 MB brotli** once. ifcopenshell for comparison: 191 MB installed, LGPL-3.0-or-later.

Node 22, 4 CPUs (`out/perf_table.txt`). "analysis" = footprint + facade + openings + volume in plain JS:

| file | MB | web-ifc OpenModel | properties pass | geometry (walls, slabs, roofs, spaces, windows, doors) | analysis | Node RSS | ifcopenshell same job |
|---|---|---|---|---|---|---|---|
| AC20-FZK-Haus | 2.6 | 28 ms | 52 ms | 140 ms | 97 ms | 214 MB | 1.7 s |
| AC9R1-Haus-G-H | 4.6 | 43 ms | 33 ms | 112 ms | 255 ms | 219 MB | 3.3 s |
| AC11-Institute | 2.8 | 31 ms | 70 ms | 239 ms | 926 ms | 272 MB | 4.3 s |
| Duplex | 2.4 | 27 ms | 79 ms | 122 ms | 242 ms | 228 MB | 0.7 s |
| Ifc4_Revit_ARC | 13.6 | 136 ms | 36 ms | 202 ms | 1490 ms | 318 MB | 1.3 s |
| BasicHouse | 52.7 | 589 ms | 43 ms | 539 ms | 138 ms | 422 MB | 64 s |
| AdvancedProject | 44.3 | 590 ms | 323 ms | 2469 ms | 1723 ms | 582 MB | 110 s |

WASM instantiation: 15-17 ms in Node.

**Real browser** - headless Chrome 158, the IIFE bundle + `web-ifc.wasm` served from localhost (`spike/browser/`, `out/webifc_chrome_single.json`):
`Init` 36 ms; OpenModel 16-343 ms; all geometry of the model 106 ms - 2.0 s; walls/slabs/roofs/spaces only 15 ms - 1.4 s; JS heap 20-209 MB.
With COOP/COEP headers (`crossOriginIsolated`, multi-thread build) `Init` took **10 s** and nothing got faster
(`out/webifc_chrome_mt.json`) - use the single-thread build and do not set those headers.

web-ifc gotchas met:
* `GetNameFromTypeCode()` returns mixed case in 0.0.81 ("IfcMaterialLayerSetUsage"); comparing with upper-case constants silently failed.
* `properties.getPropertySets()` rescans all relations for each element; build one index over `IFCRELDEFINESBYPROPERTIES` instead (done).
* Geometry is Y-up; vertex buffer = 6 floats per vertex (position, normal); apply `flatTransformation` (column-major 4x4).
* No option for geometry without opening subtraction (only net walls); gross = net + openings, or use the footprint outline x height.
* A plain JS array as flood-fill stack overflowed on a 30 M cell grid (`RangeError: Invalid array length`) -> typed-array queue, and the
  cell size is coarsened above 6 M cells.
* Dead end: loading the browser bundle inside Node with a fetch shim ("not compiled for this environment") - used real Chrome instead.

ifcopenshell gotchas: `by_type()` returns tuples in 0.9 (no `+` with lists); `numpy.cross` on 2-D vectors is gone in numpy 2.x;
`-I` drops the script directory from `sys.path` (insert it by hand to import sibling modules).

---------------------------------------------------------------------------------------------------------------------------

# What the tool can take from an IFC, and what it has to ask

Take without asking (after showing it): storeys and heights, outline per storey, gross floor area and gross volume by external
dimensions, facade area by orientation (once north is known), window and door sizes with host and orientation, roof pitches and areas,
layer thicknesses and material names per construction type, room names and floor polygons where zones exist.

Ask - each one can be a click on the model instead of a form field:

1. **Where is north?** (compass on the plan; pre-set from the file only if it is not the default).
2. **Which storeys / rooms are heated?** (click storeys; pre-tick by room names such as Keller, Garage, Heizung, Speicher).
3. **Is this the heated outline?** (per storey; needed when the file holds site walls, a garage, several buildings).
4. **What is behind each outer surface?** outside air / ground / unheated room / neighbour (party wall). Default from geometry + storey
   below ground level; one click to change.
5. **Constructions**: one question per distinct layer set (typically 3-8 per house): confirm the U-value or pick layers from a catalogue;
   the file's layer names and thicknesses pre-fill it.
6. **Windows**: U_w, g and frame share per window type (typically 2-5 types).
7. Commune / altitude, year of construction, and everything about systems (heating, DHW, ventilation, airtightness, thermal bridges):
   not in an architectural IFC at all.

# Recommendation (developer version)

* Treat IFC as the BIM input format; treat "PLN" and "RVT" as "please export IFC - here is how" (+ later an Archicad connector via the
  JSON API / Tapir `IFCFileOperation`).
* Parse in the browser (or an Electron/Tauri shell on Windows) with **web-ifc**, single-thread build, in a web worker. The files never
  leave the user's PC. Keep **ifcopenshell** in the test suite as the reference implementation (the two agreed within 0.5 %).
* Own the geometry: footprint from walls + spaces, in/out probing for exterior faces, height field for volume and for floor area with a
  clear-height rule, z-band slicing instead of storey containment. `webifc_spike.mjs` does extraction + footprint + facade + windows +
  volume in 300 (dense) lines of dependency-free JS.
* Use psets and quantities only as hints and as a consistency check ("the file says 173.4 m2, we measure 208.5 m2 - which rule applies?").
* Build the confirmation step as a 3-D view of the envelope coloured by classification with click-to-fix; that is where both the
  reliability and the "playful" come from. Budget real work for it: on 2 of the 9 analysed models the automatic result was unusable.
* Get 10-20 IFC exports from Luxembourg architects (Archicad 26-29, Revit 2023-26) before fixing any heuristic: the newest Archicad
  export tested here is from 2016.
