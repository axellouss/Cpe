# Prior art and UX - plan reading to pre-fill LuxEeB-Tool

Research notes, 2026-11-27. Topic: (1) who already turns plans into energy-certificate inputs, (2) UX patterns and a
minimal question script. Directory:
`/tmp/claude-0/-home-user-Cpe/777c5250-2203-5ad4-9fa2-9a73c3e3c91c/scratchpad/research/prior-art-ux`

Confidence tags used everywhere:

- **[RUN]** proved by running code in this directory (script and output named)
- **[OFF]** official source that I actually read (only possible for files on raw.githubusercontent.com, saved in `gh_raw/`)
- **[OFF-x]** official / vendor source, but seen only as a WebSearch excerpt (page itself could not be opened)
- **[SEC]** secondary source through a WebSearch excerpt (review sites, press, forums, vendor blogs about themselves)
- **[SIB]** taken from a sibling researcher's notes in `../luxeeb-tool`, `../cpe-method`, `../pdf-vision`, `../dwg-dxf`,
  `../ifc-pln` (their own confidence applies; read them for detail)
- **[MEM]** recalled from model memory, NOT checked in this session. Hypothesis to verify, never a number to quote to a customer.
- **[UNK]** looked for and not found / could not verify

---

## 0. TL;DR

1. **Nobody targets LuxEeB-Tool.** In 29 web queries here (plus about 60 and 55 by the `luxeeb-tool` and `cpe-method`
   researchers and a GitHub code search with 0 hits [SIB]) no product, plugin, converter or research project was found that reads plans and
   feeds LuxEeB-Tool. The only Luxembourg-accepted residential tool with a model import is Lesosai (IFC / gbXML, needs
   a clean 3D BIM model, nothing for 2D PDF/DWG) [SIB].
2. **"AI reads the plan" is not the gap - it is becoming a commodity elsewhere.** Hottgenroth (DE) announced in 2026 a
   "GebaeudeScan" app whose CAD module "HottKI" builds a 3D model from LiDAR scans or imported floor plans [SEC];
   an Austrian funded project "Energieausweis-KI" (2025-2026) prototyped plans + photos -> energy-certificate data and
   concluded it is promising but needs much more training data before market [OFF-x]; Togal.AI / Kreo sell AI takeoff
   for estimators [SEC]. All of them are tied to their own calculation kernel or to cost estimating.
3. **The real gap is the Luxembourg last mile**: quantities under the Luxembourg conventions (An net with the 1.0 m
   rule, A and Ve with outside dimensions, windows at rough opening, 8 orientations [SIB]), the official U-value
   typology for existing buildings wired to a short interview [SIB], a visible provenance per value (the ministry audits
   inputs [SIB]), FR/DE, and a safe hand-over into a tool that has no import interface [SIB].
4. **Technically naive promises** (details in section 3.3): "drop a .pln", "fully automatic from any PDF", "U-values
   from the plan", "heating system from the plan", "we fill LuxEeB-Tool for you without you checking", "certificate
   without site visit", "98 % accurate".
5. **A 9-question script is enough for a first pass** of an existing single-family house when the plan reading works
   (section 5). In the spike, 13 clicks and 0 keystrokes produce 29 result fields, each tagged plan / calculated /
   default / you [RUN]. A reconstructed LuxEeB input list has about 71 first-pass values; about 82 % of them need no
   typing if plan reading works, 13 come from the 9 questions [RUN on a reconstructed, unverified list].
6. **What to ask is decided by influence, not by habit.** Proxy-model sensitivities [RUN]: unnoticed facade
   insulation -36 % on heating demand, construction period one class off +-26 %, heated cellar yes/no +21 %, a
   print-to-fit scale error -38 %, while a wrong north costs about 1 % on an old house (but 12-18 % on a recent
   well-glazed one). So: always verify scale with one known dimension, ask renovation history and heated zone, and
   treat orientation as a one-tap confirmation, not a question.
7. **UX evidence is thinner than UX folklore.** Read at source: GOV.UK Design System (one question per page, allow
   "I don't know", check-answers page reduces errors, progress indicators often useless, expert/internal tools may
   group questions) and WCAG 2.2 SC 2.5.7 (any drag needs a non-drag alternative - applies to the compass) [OFF].
   Seen as excerpts: progress-bar meta-analysis (32 experiments: constant bars do not reduce drop-off, fast-early
   progress does) [OFF-x]; Typeform's 47 % / 57 % completion figures are vendor numbers without a control group [SEC].
   Lemonade, TurboTax, Duolingo, magicplan specifics are from memory only: the shared search budget ran out.

---

## 1. Method and limits (read before trusting anything)

- **WebSearch**: 29 queries executed, then the tool refused further calls: the budget of 200 searches is shared by all
  agents of the run and was used up. Two queries were refused (Lemonade onboarding; GOV.UK / NN/g evidence). I did not
  work around the limit. Not searched at all for that reason: Lemonade, TurboTax, Duolingo, NN/g, Baymard, cove.tool,
  Revit Insight / Green Building Studio details, UK RdSAP tools, Liciel, Kizeo, Luxembourg myenergy/Klima-Agence tools.
- **WebFetch**: `ENOTFOUND` on www.baulinks.de and www.nngroup.com (hosts outside the session allowlist). Stopped
  after two failures, as the tool instructs. Hosts that would have to be allowed for a follow-up: www.baulinks.de,
  www.hottgenroth.de, projekte.ffg.at, energie.wallonie.be, www.vlaanderen.be, togal.ai, lesosai.com, www.nngroup.com,
  www.gov.uk, passivehouse.com, help.graphisoft.com, info.cype.com.
- **Therefore**: every product fact in Part 1 is a search-engine excerpt ([OFF-x] / [SEC]) or memory ([MEM]). Excerpts
  are fragments written by the search tool; prices in particular must be re-checked on the vendor page.
- **Read at source** (curl to raw.githubusercontent.com, files in `gh_raw/`, treated as data): GOV.UK Design System
  patterns `question-pages`, `check-answers`, `complete-multiple-tasks`, `confirmation-pages`, component `task-list`;
  W3C WCAG 2.2 SC 2.5.7 "Dragging Movements" and 2.1 SC 2.5.1; READMEs of CubiCasa5k, FloorplanTransformation,
  bim2sim, Open3CL.
- **Run here**: a single-file UX prototype tested in headless Chrome (27/27 checks), a sensitivity proxy model, an
  input-budget count, a Keystroke-Level-Model estimate (section 6).
- No real LuxEeB-Tool, no real Luxembourg plan and no real user was available. Nothing in this file is a usability
  test result.

---

## 2. Part 1 - who already turns plans into energy-certificate inputs?

### 2.1 Comparison table

"Auto" = what the software derives without the user. Prices are indications from excerpts, excl. VAT unless stated.

| Product (country) | Input formats | What is automatic | What the user still does | Price indication | Luxembourg / LuxEeB? | Conf. |
|---|---|---|---|---|---|---|
| **Lesosai** (E4tech, CH) | IFC, IFCzip (64-bit), gbXML via BIM/BEM module; OpenStreetMap for shading. No DXF/DWG/PDF import found | Geometry and elements from a clean BIM model; a gbXML wizard asks for missing information such as zones | Build or obtain a 3D model with spaces; constructions, systems, checks | BIM/BEM module about 150 EUR, Luxembourg module 0 / 140 / 290 EUR (labels unclear), plus base licence and yearly updates | **Yes: has a Luxembourg module; its .bld is accepted by the CPE register. It replaces LuxEeB-Tool, it does not feed it** | [SIB], gbXML wizard [SEC: EPFL slide deck 2018] |
| **LuxEeB-Tool** itself (State of Luxembourg) | none (manual entry; project file .txt, undocumented) | U-value from layers, window U per EN ISO 10077, shading helper | everything else | free | it is the target; no import interface, no plugin found | [SIB] |
| **BuildingEnvelopeEstimator** (same State download site) | unknown | reportedly estimates the envelope from few inputs | unknown | free | Luxembourg; no documentation found - worth 30 minutes on a Windows PC | [SIB] existence only |
| **PEB software + "PEB 3D Modeler"** (Wallonia / Brussels; Flanders: EPB-software 3G) | background image of a plan with scaling, DXF import; Flanders: "3D import of geometric data" since v11.5.3 (March 2021) | Areas and volumes from the 3D model the user draws over the background; transfer geometric model -> energy model | Trace / draw the building, assign everything else. Flanders' own help says working through the 3D module is not advised because it still contains errors; many reporters measure in SketchUp instead | free government software [MEM] | no | [OFF-x] manual table of contents (energie.wallonie.be), vlaanderen.be EPB-pedia excerpts |
| **French DPE suites**: Perrenoud (DPEWin, BatiAudit), WinDPE/WinPlan (OBBC), Pleiades (Izuba), Expertec Pro, Liciel | BatiAudit: 3D entry from a grid or a background plan, "scanned or DWG"; Pleiades: import of plans or images; WinPlan: graphical plan entry with opening dimensions carried into the DPE; Expertec: laser sketch on site, DWG/DXF export | Areas and lengths once the user has drawn the plan | Draw over the plan, all thermal and system data. No automatic recognition of plans confirmed | not found | no | [SEC] (appvizer, effy, vendor brochure excerpts); Liciel and Kizeo not searched [UNK] |
| **French AI start-ups**: Kelvin, Auditoo, apihom, Kanopee "CheckDPE" | Kelvin: address + open data + satellite images + photos/videos | Remote pre-diagnosis and costed renovation scenarios with a **confidence index**; press says it counts radiators and detects doors and ceiling height in videos | Result is a pre-study for renovation sales, not a regulatory DPE; the certified diagnostician still does the DPE | SaaS, price not found; Kelvin raised 5 M EUR (June 2024) | no | [SEC] (TechCrunch, Batiweb, Maddyness excerpts) |
| **Open3CL** (FR, open source, MIT) | DPE file in ADEME XML or JSON | Recomputes a DPE; 3D viewer of the dwelling and its losses | n/a - it is an engine, not a capture tool | free | no. Shows what an open exchange format enables - Luxembourg has none | [OFF] README read |
| **Hottgenroth / ETU Energieberater 18599 3D + HottCAD + GebaeudeScan-App** (DE) | Images, PDF, DWG/DXF, IFC (with maintenance contract), free drawing; Revit and Allplan plugins; LiDAR scan; 2026 app also "import of floor plans" | HottCAD: 3D building model, areas, volumes; 2026: "the CAD module HottKI recognises the imported data automatically and creates a 3D model" | Calibrate, check/trace, constructions, systems. Recognition accuracy: no figure found | HottCAD 599 EUR, HottScan modeller extra licence 799 EUR (flyer 01/2024, non-binding); base software not found | no (German DIN V 18599 / GEG kernel) | datasheet / flyer [OFF-x], Baulinks 2026 article [SEC] |
| **ZUB Helena, Envisys EVEBI, Daemmwerk** (DE) | [MEM] each has a graphical capture module and an IFC or gbXML interface | [MEM] areas from a model the user draws or imports | as above | not found | no | **[UNK]** - my one query returned nothing usable |
| **ArchiPHYSIK** (A-NULL, AT) | Archicad interface (areas, volumes, build-ups, orientations), SketchUp interface, IFC | Transfers quantities from the architect's model, can watch the Archicad project for changes | Model must be prepared; forum users report geometry often has to be redrawn and that a wall not sitting exactly on a slab breaks the import | not found | no | [SEC] Graphisoft forum, TU Wien theses |
| **"Energieausweis-KI"** (AT research, FFG; Black Automation e.U. + VRVis, with ecotech) | plans + photos + existing certificates | AI models extract the data needed for the calculation; validated prototype | Conclusion of the project itself: approach is suitable to automate a large part, but **much more high-quality training data is needed before it is market-ready** | research project 04/2025-05/2026 | no | [OFF-x] FFG project database |
| **PHPP + designPH** (Passive House Institute) | SketchUp model | Assigns each surface to a thermal group, sums areas, window schedule, exports to PHPP | Build the SketchUp model by hand; thermal bridges not in designPH's balance; systems in PHPP | not found | no | [OFF-x] passipedia / passivehouse.com excerpts |
| **Archicad Energy Evaluation** (Graphisoft) | native Archicad model | "Model geometry analysis" builds space boundaries; exports gbXML and PHPP (standard), VIP-Energy / SBEM with EcoDesigner STAR | A zone in every conditioned space, "inner edge" zone method only, extra steps for roofs/shells, re-run update; a 2024 forum thread reports gaps in the gbXML that turn inner walls into outer walls | part of Archicad | no; but an Archicad -> IFC -> Lesosai chain exists [SIB] | [OFF-x] help-centre excerpts, [SEC] forum |
| **Revit energy model / Insight / gbXML / Green Building Studio** (Autodesk) | Revit model | [MEM] automatic "energy analytical model", gbXML export, cloud simulation for early design | [MEM] model clean-up; not a national certificate tool | [MEM] part of the AEC collection | no | **[MEM]** - not searched |
| **cove.tool** | [MEM] plugins for Revit / Rhino / SketchUp / Archicad, drawing tool | [MEM] early-stage energy and daylight | - | - | no | **[UNK]** - not searched |
| **CYPETHERM** suite (CYPE, ES) | IFC4 through BIMserver.center ("Open BIM") | A wizard generates the thermal geometry from the IFC; needs IfcSpace with boundaries | Country modules exist for IT, ES and others; constructions and systems by the user | not found | no Luxembourg module found | [OFF-x] info.cype.com excerpts |
| **IFC -> BEM research** (BIM2SIM, IFC2gbXML, UCL / TU Wien / Tulsa studies) | IFC | Semi-automatic. Second-level space boundaries are "a critical yet technically demanding step"; spaces are often not defined; mapping is not one-to-one; clashes must be fixed iteratively | Repair the model | free (bim2sim is LGPL, "still under heavy development") | no | [OFF] bim2sim README, [SEC] paper excerpts |
| **Togal.AI** | PDF / image drawings | AI labels rooms and measures areas, counts, lengths for cost estimating | "Estimator oversight remains essential" (2026 Utica University study: accuracy varied by finish type, ceilings best, floors moderate). An earlier study reports -51 % takeoff time | 299 USD per user and month billed yearly (vendor page excerpt) | no | [SEC] |
| **Kreo** | PDF drawings, BIM | AI first pass of takeoff | Check before pricing | from 95 GBP per month | no | [SEC] |
| **Bluebeam Revu** | PDF | Manual measurement tools; an AI tier ("Max") exists but its content was not retrieved | Calibrate and measure by hand | Basics 260 USD per user and year; measurement needs Core or higher | no | [SEC], AI tier [UNK] |
| **CubiCasa** | phone video scan of the home | 2D floor plan, room dimensions, gross living area report aligned with ANSI Z765 | Walk through the house; no measured accuracy found | base plans free in the US, about 10-15 USD per add-on / GLA report | no | [SEC] |
| **magicplan** | phone camera / LiDAR room scan, sketch | Floor plan, room areas, estimates and reports | Scan each room; import of an existing PDF plan not confirmed | about 75-90 USD per user and month (estimate tier) | no | [SEC] |
| **Planimeter** | - | - | - | - | - | **[UNK]** no result |

### 2.2 What the open research code says about floor-plan recognition

- CubiCasa5k: 5000 annotated floor-plan images, over 80 object categories; model needs a CUDA GPU; the dataset database
  takes about 105 GB as shipped [OFF, README].
- Raster-to-Vector (Liu et al., ICCV 2017): "around 90 % precision and recall" on its benchmark [OFF, README] - i.e. on
  marketing-style floor plans, roughly one wall junction in ten is wrong. Good for a first guess, useless without review.
- The sibling `../pdf-vision` notes measured that vector PDFs can be read almost losslessly **when heuristics fire**,
  and that topology is brittle; `../ifc-pln` shows a .pln cannot be parsed outside Archicad [SIB].

### 2.3 Patterns in the prior art

1. Every certified tool keeps its own geometry capture: **trace over a background plan** (PEB 3D Modeler, HottCAD,
   Perrenoud, Pleiades) or **import a BIM model** (Lesosai, CYPETHERM, ArchiPHYSIK). Tracing is the 20-year-old
   baseline the product must beat; it already works on any PDF.
2. BIM import fails on model quality, not on file reading (forum reports for ArchiPHYSIK and Archicad gbXML; research
   on space boundaries). Existing houses have no BIM model anyway.
3. Takeoff AI is sold to estimators and measures **net room finishes**, not a thermal envelope: no storey heights, no
   outside dimensions, no orientation, no heated / unheated distinction.
4. Remote AI diagnosis (Kelvin) is positioned as a **pre-study with a confidence index**, explicitly not the certificate.
5. Where a State publishes an exchange format (France: ADEME XML), an ecosystem appears (Open3CL). Luxembourg publishes
   none; the register only ingests the tool's own .txt / Lesosai .bld [SIB].

---

## 3. Conclusions of Part 1

### 3.1 Where the real gap is

| Need of a Luxembourg expert | Covered today? |
|---|---|
| Quantities in the Luxembourg conventions (An net inside the envelope with clear height > 1.0 m; A and Ve outside dimensions; windows at rough opening; facades in 8 sectors) straight from 2D plans | No. Generic takeoff tools give net room areas only; foreign certificate tools use their own conventions |
| Official Luxembourg defaults for existing buildings (U-value typology by age class and added insulation, indicative n50, flat thermal-bridge surcharge) applied automatically from two or three answers | Only inside LuxEeB-Tool / Lesosai as manual choices [SIB] |
| Provenance per value ("measured on sheet 2", "typology 1969-83", "typed by expert") and an exportable audit trail | No tool found that does it; the ministry audit checks exactly the input data [SIB] |
| FR / DE interface with the tool's own vocabulary | LuxEeB-Tool and Lesosai only |
| Getting the values into LuxEeB-Tool | Nobody. No interface; options are ranked in `../luxeeb-tool/NOTES.md` |

The gap is small in market terms: a directory counts about 480 authorised professionals [SIB, SEC]. That explains why
no vendor built it, and it caps what the product may cost to build and maintain.

### 3.2 What can be promised honestly

- "Drop the PDF / DWG / IFC; you get the take-off (areas, volumes, facades by orientation, window list) with every
  number traceable to the plan, and you correct it by tapping."
- "Answer 9 questions; you get a complete first-pass input set with official defaults, in the order LuxEeB-Tool asks."
- "You stay the author: nothing is transferred that you have not seen."

### 3.3 What is technically naive to promise

| Promise | Why it is naive | Evidence |
|---|---|---|
| "Drop your .pln" | The format can only be opened by Archicad; the user must export IFC / DWG / PDF | [SIB] ifc-pln |
| "Fully automatic from any PDF" | Scans, text converted to outlines, print-to-fit scale (a 1:100 sheet printed on A4 is really 1:141; the proxy model shows -38 % on heating demand), no section = no heights, fragile wall topology | [SIB] pdf-vision, [RUN] sensitivity |
| "The AI recognises everything" | The only funded project on exactly this (AT, 2025-26) concluded that more training data is needed before market; research code reaches about 90 % on clean benchmark plans | [OFF-x], [OFF] |
| "U-values from the plan" | An existing house plan shows a wall thickness, not the layers, and never the later insulation - which is the single most influential unknown (-36 % in the proxy model, -17..-29 % in the sibling's) | [RUN], [SIB] |
| "Heating, hot water, ventilation from the plan" | Not on architectural plans | [SIB] master table |
| "We type it into LuxEeB-Tool for you" | No interface; a UI robot can put a right value in a wrong field silently after any update | [SIB] luxeeb-tool |
| "CPE without a site visit" | An approved expert must visit an existing building; the expert is liable and audited | [SIB] cpe-method |
| "98 % accurate" style numbers | Vendor takeoff figures concern finishes on clean commercial drawings; an independent 2026 study found accuracy depends on the element type and that oversight stays essential | [SEC] |
| "Exact orientation / shading from the plan" | A north arrow is just a drawing; it matters about 1 % for an old house but 12-18 % for a recent well-glazed one, so it must be confirmed, cheaply | [RUN] |

---

## 4. Part 2 - UX patterns, with what is actually documented

### 4.1 Evidence I could read or see

| Pattern | Source | What it says | Conf. |
|---|---|---|---|
| One question per page | GOV.UK Design System, "Question pages" | "Asking just one question per question page helps users understand what you're asking them to do, and focus on the specific question and its answer." Know why you ask every question; "only ask users for information you really need"; allow "I do not know" when valid; never ask twice - pre-populate | [OFF] |
| ... but not always for experts | same | "User research will tell you when you can group pages together. For example, if you're designing an internal service for government users who need to repeat and switch between tasks quickly." | [OFF] |
| Progress indicators | same | Test without one first. Step bars that show all steps "are often not noticed", "do not scale well", "make it hard to handle conditional sections". The Carer's Allowance team removed a 12-step progress indicator "with no effect on completion rates or times" | [OFF] |
| Progress indicators, measured | Villar, Callegaro, Yang 2013, meta-analysis of 32 randomised experiments (Social Science Computer Review 31(6)) | A constant-speed indicator does not significantly reduce drop-off; fast-to-slow reduces it; slow-to-fast increases it | [OFF-x] abstract via Google Research |
| Check answers before submitting | GOV.UK "Check answers" | Helps "increase users' confidence" and "reduce error rates as users are given a second chance to notice and correct errors"; a "Change" link per row; after a change return to the check page, do not replay the journey | [OFF] |
| Task list with statuses | GOV.UK "Complete multiple tasks" | For long transactions over several sessions; few statuses; let the user decide when a section is completed ("No, I'll come back later") | [OFF] |
| Avoid drag-only controls | GOV.UK (range sliders) + WCAG 2.2 SC 2.5.7 (AA) | "All functionality that uses a dragging movement for operation can be achieved by a single pointer without dragging" | [OFF] |
| One-question-at-a-time, measured | Typeform help centre | Average completion 47 % (older page), 57 % (newer page; desktop 58 %, mobile 56 %). Vendor's own data, no control group. A competitor's blog says conversational forms start to hurt beyond about 12-14 questions | [SEC] |
| Confidence shown to the user | Kelvin (FR) | The remote diagnosis is delivered with a confidence index that says how reliable the first estimate is | [SEC] |

### 4.2 Patterns from products, from memory (not verified in this session)

| Pattern | Who does it well [MEM] | Why it fits here |
|---|---|---|
| Interview that hides the form | TurboTax: step-by-step questions on top of the tax forms, document import ("we found these values, are they right?"), a running refund figure, and a "forms mode" for experts | Same structure: plan import = document import; LuxEeB sheets = the forms; class preview = the running figure |
| Conversational, one tap per answer, address first then pre-filled property facts | Lemonade (quote advertised in about 90 seconds - marketing claim) | Address and plan first, then only what could not be derived |
| Keyboard-first single question | Typeform (Enter to continue, letter keys for choices) | Experts repeat the task; 1-9 keys for options beat the mouse |
| Small, honest progress rewards | Duolingo (lesson progress bar, streaks) | Use the progress and completeness meters, skip streaks, mascots and confetti: this is a liability-bearing professional task |
| Point at the thing instead of describing it | magicplan (corners in the camera view), Togal (coloured areas, click to fix) | Colour the heated zone on the plan; tap rooms and facades |
| Click a value, see where it came from | document-extraction review screens (invoice capture tools) | The provenance jump to the plan region is the trust mechanism and the audit trail |
| Reduced data sets with defaults by age band | UK RdSAP, German simplified data capture for existing dwellings; Luxembourg's own "U-Wert-Typologien fuer bestehende Gebaeude" [SIB] | The official precedent for "ask the period, default the rest" |

Classic results I rely on, also from memory: defaults are sticky (Johnson and Goldstein 2003); people over-trust
automated suggestions (automation bias / complacency, Parasuraman and Manzey 2010); visible head start increases
completion (endowed progress, Nunes and Dreze 2006); showing the work increases perceived value (labour illusion,
Buell and Norton 2011); Keystroke-Level Model operator times (Card, Moran, Newell). None re-checked. [MEM]

### 4.3 Design rules for this product (each with its reason)

1. **Document first, questions second.** The plan drop must fill most of the result before the first question. In the
   spike the completeness meter is at 52 % after loading the plan and before any answer [RUN]; that is the
   "fast early progress" the meta-analysis found helpful.
2. **Confirm cards, not empty fields.** One card "this is what I read" with one primary button and a "correct" link
   per row. Corrections open in place.
3. **Never let a default look like a fact.** Stickiness of defaults plus automation bias is the main risk of this
   product: an expert who rubber-stamps a wrong U-value signs a wrong certificate. So: source tag on every value (plan /
   calculated / default / you), amber for defaults until touched, low-confidence items sorted first on the review
   screen, and a forced look only for the few values that dominate the result (scale, heated zone, renovation history).
4. **One question per screen with a visible "why the plan cannot tell".** It justifies the question to an expert and
   documents the reasoning.
5. **Answer by picking, not typing.** Period cards, system cards, tap-the-room. Typing only for optional refinements
   (exact year, cm of insulation, kWp).
6. **"I don't know" is a valid answer** and yields a tagged default (GOV.UK rule); it keeps the flow moving on site.
7. **Live consequences.** Tapping the cellar changes An and Ve under the plan immediately (spike: +49 % An, +44 % Ve
   for the demo house [RUN]). This is the "playful" part that is not childish: the building reacts.
8. **Compass with three inputs**: drag the needle, 8 sector buttons, +-15 degree buttons / arrow keys. Required by
   WCAG 2.5.7, and the sector buttons are faster anyway because LuxEeB only needs 8 sectors.
9. **Undo everywhere, no confirmation dialogs.** One history stack for every change (Ctrl+Z and a button). Tested in
   the spike, including undo across screens [RUN].
10. **Expert mode is a view, not another product.** A toggle shows the full field table at any time; for repeat users
    GOV.UK itself allows grouped questions. Add number-key shortcuts for options.
11. **Progress = "question 3 of 9" plus completeness and confidence meters**, not a 12-step breadcrumb (GOV.UK).
12. **Bilingual by construction.** All strings in a dictionary keyed by language, LuxEeB-Tool's own terms (An,
    Energiebezugsflaeche / surface de reference energetique), language switch at any time without losing state [RUN],
    decimal comma on copy [RUN]. Compass letters differ: FR N-NE-E-SE-S-SO-O-NO, DE N-NO-O-SO-S-SW-W-NW; note "O" is
    west in French and east in German - always show the degree value or the arrow next to the letter.
13. **Result in the order of the target tool**, with a copy button per value, because there is no import interface.
14. **Do not show an energy class.** Only LuxEeB-Tool computes it; a preview would be taken for the result. A loss
    breakdown ("where the heat goes") is safe and useful.

What I would not do: mascots, points, streaks, confetti, chat bubbles pretending to be a person, sliders for numbers.

---

## 5. Proposed question script (existing single-family house, good plan available)

### 5.1 Before the questions: one confirm card (zero questions if all is right)

Read from the plan and shown with a confidence chip; one tap "all correct" [prototype: `found` step]:

| Item | Read from | If missing or wrong |
|---|---|---|
| Address | title block | type it (also gives the municipality) |
| Scale | scale text, checked against one dimension chain | **mandatory fallback: click two points of a known dimension** |
| Storeys and storey heights | section drawing | one number per storey |
| North | north arrow, site plan | compass (buttons or drag) |
| Number of dwellings | count of kitchens / entrance doors | 1 tap |
| Plan date | title block | used only to pre-select the period in Q2 |

### 5.2 The 9 questions

| # | Question (answer type) | Why the plan cannot tell | Default if "I don't know" | Inputs it settles |
|---|---|---|---|---|
| Q1 | Occasion: existing building (sale / rent), renovation, or new build? (3 cards) | Administrative context, not geometry | none - required | certificate type, which rules apply |
| Q2 | Construction period? (8 period cards, pre-selected from the plan date; exact year optional) | A plan date is a hint, not proof (permit vs completion, copies) | period from plan date, flagged | year; unlocks all typology defaults (walls, roof, floor, windows, distribution, controls) |
| Q3 | Is this the heated zone? (plan coloured heated / unheated; tap rooms; tap facades that touch a neighbour) | Plans label rooms, not whether cellar, attic, veranda, garage are heated today; party walls are not always drawn | guess from room labels, flagged | An, Ve, envelope elements and their boundary type, generator inside / outside the envelope |
| Q4 | What was renovated since construction? (4 toggles: windows -> year; roof or top ceiling -> cm; facade -> cm; cellar ceiling -> cm; big button "nothing changed") | Original plans predate the works | "nothing changed", flagged | U-values of the four element groups, window Uw and g |
| Q5 | How is the house heated? (8 picture cards: generator + energy carrier), then age band or year of installation | Not on architectural plans; at best a room labelled "chaufferie / Heizraum" | none - required | generator, carrier, year of the installation |
| Q6 | How is the heat emitted? (radiators / floor heating / both) | Emitters are rarely drawn | by period | system temperatures, emission |
| Q7 | Hot water? (by the heating / separate electric / heat-pump water heater) | Not on architectural plans | by the heating | hot-water generation and its defaults |
| Q8 | Ventilation? (windows / exhaust / heat recovery) + optional blower-door value | Only on building-services plans; a test result is a document | windows, indicative n50 | ventilation system, n50, recovery efficiency default |
| Q9 | Solar on the roof? (none / PV kWp / thermal m2 / both) | Usually installed after the plans | none | PV and solar-thermal inputs |

Count: 9 questions, of which Q2, Q3, Q4 are one-tap acceptances of a pre-filled guess in the happy path.

Order: Q1-Q2 are trivial (fast start), Q3-Q4 are the high-influence ones while attention is fresh, Q5-Q9 are
recognition tasks answerable in the boiler room.

### 5.3 Asked only when the plan is poor (not counted above)

Scale by two clicks; storey height; roof type and pitch when there is no section; window heights when neither
annotated ("126/138.5") nor on an elevation (default sill / lintel heights); attic knee-wall height for the 1.0 m rule
of An. With a bad scan expect 12-15 interactions instead of 9.

### 5.4 Deliberately not asked in the first pass

| Item | Why it can wait |
|---|---|
| Measured consumption of the last years (goes on page 4 of the certificate [SIB]) | Does not enter the calculation; upload bills later |
| Modernisation recommendations (page 5 [SIB]) | Expert judgement; the tool can propose the weakest elements |
| Exact layer build-ups, measured U-values | Upgrade path after the first pass; the official typology is conservative, so refining pays off [SIB] |
| Thermal-bridge proof, detailed shading | Flat defaults exist [SIB] |
| Owner details, cadastral number | Administrative, typed once in LuxEeB-Tool |

### 5.5 Why these and not others - influence ranking [RUN, proxy model]

`python3 -I spikes/sensitivity.py` (output `out/sensitivity.txt`, `out/sensitivity.json`). Proxy = German EnEV
simplified heating-period method written from memory, illustrative U-values, demo house of the prototype (10.24 m x
9.24 m, two heated storeys, period 1969-1983, baseline 27 380 kWh/a). It ranks inputs; it is not the Luxembourg method.

| One input wrong | Change of heating demand | Settled by |
|---|---|---|
| Plan scale wrong by 41 % (A3 sheet printed on A4) | -37.5 % | one known dimension |
| Facade insulated later (12 cm) but not known | -36.0 % | Q4 |
| Construction period one class off | -26.1 .. +26.8 % | Q2 |
| Heated zone: cellar heated or not | +21.1 % | Q3 |
| Heat recovery present but not known (illustrative) | -12.1 % | Q8 |
| Top ceiling insulated later (16 cm) | -8.0 % | Q4 |
| Cellar ceiling insulated later (8 cm) | -7.1 % | Q4 |
| Windows replaced (Uw 2.8 -> 1.3) | -7.0 % | Q4 |
| Storey height 2.80 m read as 2.60 / 3.00 | -4.9 .. +4.9 % | section or confirm card |
| Thermal-bridge surcharge 0.10 vs 0.05 | -4.9 % | expert mode |
| Airtightness test available | -3.4 % | Q8 |
| Plan scale wrong by 2 % | -2.8 .. +2.8 % | one known dimension |
| North wrong by 180 / 90 / 45 degrees | +1.3 / +1.1 / -0.4 % | compass confirm |
| Window areas off by 20 % | -0.7 .. +0.7 % | elevations or default |

Heat generator, same heat demand, illustrative factors: old oil boiler +21 %, gas condensing -11 %, heat pump -54 %,
pellets -81 % primary energy against a low-temperature boiler - Q5 moves the primary-energy class more than any
geometric detail.

Recent well-insulated variant with 22 m2 south glazing (baseline 4 668 kWh/a): north wrong by 90 degrees +12.3 %,
by 180 degrees +18.0 %. Orientation cannot be dropped; it only needs to be right to the 45-degree sector.

The sibling `../cpe-method` ran an independent stand-in model and found the same ranking (wall retrofit -17..-29 %,
age class +-7..17 %, orientation / window area below about 2 % for uninsulated houses) [SIB].

---

## 6. Spikes (all reproducible)

```
cd /tmp/claude-0/-home-user-Cpe/777c5250-2203-5ad4-9fa2-9a73c3e3c91c/scratchpad/research/prior-art-ux
(cd prototype && npm install puppeteer-core)        # 25.19.0; drives the system /usr/bin/google-chrome (158)
node prototype/test_wizard.mjs                      # 27/27 checks, writes out/wizard_test.{txt,json}, out/shot_*.png
python3 -I spikes/sensitivity.py                    # out/sensitivity.{txt,json}
python3 -I spikes/input_budget.py                   # out/input_budget.{txt,json,md}
```

### 6.1 `prototype/wizard.html` - the question script as a clickable single file [RUN]

One HTML file, no dependency, no network, 369 lines in total (dense JavaScript). Open it in any browser. What is real: the
flow, FR/DE strings, undo stack, compass, tap-the-room plan, meters, result table with source tags and copy buttons.
What is fake: the plan-reading result (hard-coded demo house), the U-value table (illustrative placeholders), the
geometry (rectangular box), the confidence numbers (arbitrary weights).

Measured by `prototype/test_wizard.mjs` in headless Chrome (`out/wizard_test.txt`):

| Check | Result |
|---|---|
| Completeness / confidence right after loading the plan, before any question | 52 % / 32 % |
| Happy path to a complete result | **13 clicks, 0 keystrokes**, 9 questions |
| Result fields | 29, none empty: 8 from the plan, 7 calculated, 6 defaults, 8 answered |
| Completeness / confidence at the end | 100 % / 85 % |
| Language switch FR -> DE on the result screen | labels change, answers kept |
| Ctrl+Z and undo button | step back across screens and restore answers; 5 undos restore the guessed heated zone |
| Tap one cellar room | An 156.4 -> 178.4 m2, Ve unchanged (the level is not mostly heated) |
| Tap the whole cellar | An 233.8 m2 (+49 %), Ve 762 m3 (+44 %), "cellar ceiling" replaced by "ground slab" |
| Room toggle from the keyboard | works (Enter) |
| Compass | +15 degree button, sector button, arrow key and drag all set the north; facade areas move to the new sectors |
| "Facade insulated" answer | wall U 1.0 (default) -> 0.23 (you); typing 20 cm -> 0.15 |
| "I don't know" on Q6 | default value, tagged default, confidence 0.5 |
| Expert mode | full field table on any question screen |
| 390 px wide | no horizontal page scroll |
| JavaScript errors | none |

Screenshots: `out/shot_1_found_fr.png` (confirm card), `out/shot_2_q3_zone_fr.png`, `out/shot_5_q3_cellar_heated.png`
(tap to correct), `out/shot_6_compass.png`, `out/shot_3_result_fr.png`, `out/shot_4_result_de.png`, `out/shot_7_phone.png`.
Export of the happy path: `out/export_happy_path.json`.

Lessons from building it:

- Puppeteer cannot `focus()` SVG elements through its own helper ("Cannot focus non-HTMLElement"); use
  `page.evaluate(() => el.focus())`. Give SVG rooms `tabindex`, `role="switch"` and a key handler or they are mouse-only.
- A rectangular house rotated by 90 degrees keeps the same four sector names; only the areas swap. Tests must compare
  areas, not sector ids (my first test failed on this).
- After the user answers "nothing changed", defaults still showed a red "uncertain" chip. That punishes an honest
  answer; defaults confirmed by an explicit answer should turn amber, not red. The scoring needs design work.
- The French and German sector letters collide ("O"), see rule 12.
- Not built: neighbour (party wall) tapping on facades, roof type picker, scale calibration by two clicks, plan
  region highlight when clicking a value. They are the next things to prototype.

### 6.2 Keystroke-Level-Model estimate [RUN on a model; operator times MEM]

Operators: keystroke 0.28 s, point 1.1 s, click 0.2 s, home 0.4 s, mental preparation 1.35 s.
One tap = 2.65 s; one typed numeric field (decide, point, click, home, 5 characters, Tab) = 4.73 s.

| Scenario | Estimate |
|---|---|
| Wizard happy path (13 taps) | 34.5 s |
| Typing the same 29 fields into an empty form | 137 s |
| Typing the about 71 first-pass values of the reconstructed LuxEeB list | about 336 s |

This counts hands only. The real cost of today's workflow is the take-off (measuring and adding up areas from the
plans), which KLM does not model and for which I found no published timing. It must be measured with two or three
experts before any "saves X hours" claim.

### 6.3 `spikes/input_budget.py` - where each input can come from [RUN on a reconstructed list]

38 input groups, about 80 typed values for the demo house (list reconstructed from the manual's entry procedure [SIB]
and general knowledge of this family of methods; **not checked field by field against LuxEeB-Tool**):

| Source | Input groups | Typed values | Share |
|---|---|---|---|
| plan geometry | 11 | 26 | 32 % |
| plan text | 2 | 4 | 5 % |
| default by period | 8 | 21 | 26 % |
| fixed default | 4 | 7 | 9 % |
| question | 9 | 13 | 16 % |
| later / site visit | 4 | 9 | 11 % |

First pass without "later": 71 values, 58 (82 %) without typing if plan reading works, 13 from the 9 questions.
Full table: `out/input_budget.md`. The sibling master table (`../cpe-method/NOTES.md` section 10) is the better
reference for the field list; mine adds the question mapping.

### 6.4 `spikes/sensitivity.py` - see 5.5.

---

## 7. Dead ends and things not verified

- WebFetch on any vendor or government site: blocked (section 1).
- ZUB Helena, Envisys EVEBI, Daemmwerk import features and prices: one combined query returned unrelated pages; no
  budget to retry. [UNK]
- Planimeter: no result. [UNK]
- cove.tool, Revit Insight / Green Building Studio, Liciel, Kizeo: not searched. [UNK]/[MEM]
- Prices of Lesosai (base), ArchiPHYSIK, designPH, PHPP, CYPETHERM, Hottgenroth base software: not found.
- Measured effects for Lemonade, TurboTax, Duolingo, magicplan: not searched; everything in 4.2 is memory.
- GOV.UK's own measurements behind "one thing per page": the pattern page links to blog posts I could not open; only
  the Carer's Allowance statement quoted on the pattern page itself is verified.
- Hottgenroth "HottKI": what exactly it recognises (walls? windows? from PDF or only from scans?) and how well - the
  Baulinks article could not be opened. This is the most relevant competitor claim to read in full.
- bau.de forum thread 10472: a German energy consultant advertises a self-built capture app (sketch on the device,
  calibrate a photo or PDF of a plan); no figures. [SEC]
- Whether any Luxembourg actor (Klima-Agence, energieagence, OAI, a local start-up) has an internal tool: not found
  in my queries, not excluded.
- gh search for RdSAP schema repositories returned nothing usable; UK RdSAP statements are memory.

---

## 8. Sources

Read at source (in `gh_raw/`):
- https://raw.githubusercontent.com/alphagov/govuk-design-system/main/src/patterns/question-pages/index.md
- https://raw.githubusercontent.com/alphagov/govuk-design-system/main/src/patterns/check-answers/index.md
- https://raw.githubusercontent.com/alphagov/govuk-design-system/main/src/patterns/complete-multiple-tasks/index.md
- https://raw.githubusercontent.com/alphagov/govuk-design-system/main/src/patterns/confirmation-pages/index.md
- https://raw.githubusercontent.com/alphagov/govuk-design-system/main/src/components/task-list/index.md
- https://raw.githubusercontent.com/w3c/wcag/main/guidelines/sc/22/dragging-movements.html
- https://raw.githubusercontent.com/CubiCasa/CubiCasa5k/master/README.md
- https://raw.githubusercontent.com/art-programmer/FloorplanTransformation/master/README.md
- https://raw.githubusercontent.com/BIM2SIM/bim2sim/main/README.md
- https://raw.githubusercontent.com/Open3CL/engine/main/README.md

Seen as WebSearch excerpts only:
- Hottgenroth: https://www.baulinks.de/webplugin/2026/1119.php4 ; https://www.haustec.de/sites/default/files/2021-02/hottscan_flyer.pdf ; https://www.hottgenroth.de/M/SOFTWARE/Apps-Aufmass/HottConnect/Seite.html,225109,185400
- FFG Energieausweis-KI: https://projekte.ffg.at/projekt/5138220/pdf ; https://projekte.ffg.at/projekt/95f2453e-f36b-1410-863e-00d3c07d99bb/pdf
- bau.de app thread: https://bau.de/forum/enev/10472.php ; KIT press release (not read): https://www.kit.edu/kit/english/pi_2026_045_faster-renovation-decisions-with-ai.php
- Belgium: https://energie.wallonie.be/servlet/Repository/user-manual-fr-peb-3d-modeler-v3-5.pdf?ID=23336 ; https://www.vlaanderen.be/epb-pedia/epb-software/epb-software-3g/archief-wijzigingen-per-versie-epb-software-3g ; https://www.vlaanderen.be/epb-pedia/epb-software/epb-software-3g/werking-epb-software-3g/tips-bij-eerste-gebruik
- France: https://www.appvizer.fr/magazine/construction/btp/logiciel-dpe ; https://www.effy.fr/gestion-entreprise/logiciel-audit-energetique ; https://media.xpair.com/pdf/renovation/perrenoud-batiaudit.pdf ; https://techcrunch.com/2024/06/10/kelvin-wants-to-help-save-the-planet-by-applying-ai-to-home-energy-audits ; https://www.batiweb.com/actualites/numerique-bim/un-diagnostic-de-renovation-energetique-a-distance-grace-a-l-ia-de-kelvin-45824
- ArchiPHYSIK / Archicad: https://community.graphisoft.com/t5/Nachhaltiges-Planen/Weiterentwicklung-APH/td-p/448063 ; https://help.graphisoft.com/AC/27/INT/_AC27_Help/110_EnergyEvaluation/110_EnergyEvaluation-5.htm ; https://help.graphisoft.com/AC/28/INT/_AC28_Help/110_EnergyEvaluation/110_EnergyEvaluation-26.htm ; https://community.graphisoft.com/t5/Graphisoft-Technology-Preview/Issues-with-gbXML-Export-from-Archicad-persists-even-in-AC28/td-p/615291
- designPH: https://passipedia.org/planning/calculating_energy_efficiency/phpp_-_the_passive_house_planning_package/designph_plugin ; https://passivehouse.com/designph/support/faq/
- CYPE: https://info.cype.com/en/product/cypetherm-eplus-home/ ; https://www.buildingsmart.es/app/download/12578484226/Ficha-OpenBIM-CYPETHERM%20HE%20Plus.pdf
- IFC to BEM: https://discovery.ucl.ac.uk/id/eprint/10219000/1/1-s2.0-S0926580525007526-main.pdf ; https://arxiv.org/html/2601.16813v1 ; https://mdpi.com/2075-5309/14/8/2444 ; https://repositum.tuwien.at/bitstream/20.500.12708/18535/1/Spielhaupter%20Oliver%20-%202021%20-%20BIM%20to%20BEM%20transformation%20workflows%20A%20case%20study...pdf
- Takeoff: https://togal.ai/pricing ; https://easychair.org/publications/paper/pkrRp ; https://www.g2.com/products/kreo/pricing ; https://www.bluebeam.com/de-de/pricing/ ; https://www.capterra.com/p/193054/CubiCasa/ ; https://www.capterra.com/p/210335/magicplan/
- Lesosai: https://www.epfl.ch/labs/leso/wp-content/uploads/2018/05/Lesosai_7_presentation.pdf (rest via `../luxeeb-tool/NOTES.md`)
- UX: https://research.google/pubs/where-am-i-a-meta-analysis-of-experiments-on-the-effects-of-progress-indicators-for-web-surveys/ ; https://help.typeform.com/hc/en-us/articles/360029615911 ; https://fillout.com/blog/one-question-at-a-time-form

---

## 9. Files in this directory

| File | Content |
|---|---|
| `NOTES.md` | this file |
| `prototype/wizard.html` | clickable UX spike (FR/DE, 9 questions, confirm card, compass, tap-the-room, undo, expert mode) |
| `prototype/test_wizard.mjs` | headless-Chrome test, 27 checks, interaction counts, KLM estimate |
| `spikes/sensitivity.py` | proxy-model influence ranking |
| `spikes/input_budget.py` | input list by source and question mapping |
| `out/` | test log and JSON, 7 screenshots, exported field set, sensitivity and input-budget outputs |
| `gh_raw/` | the pattern pages and READMEs read at source (data only) |
