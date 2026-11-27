# LuxEeB-Tool - how could a third-party program put data INTO it?

Research notes, 2026-11-27. Topic: the LuxEeB-Tool software itself (publisher, technology, file formats,
import/export, register, Lesosai, automation options).

Confidence tags used below:
- **[RUN]** proved by running code in this sandbox (script + output in this directory)
- **[OFF]** official source (ministry / guichet.lu / OAI / vendor), but read only through WebSearch excerpts - the
  pages themselves could NOT be fetched (see section 1)
- **[SEC]** secondary source (training catalogues, aggregator sites, third-party pages)
- **[INF]** my inference from the evidence - plausible, NOT verified
- **[UNK]** not found / could not verify

---

## 0. TL;DR

1. **No public import interface, API, plugin or documented file format for LuxEeB-Tool was found.** GitHub code
   search returns 0 hits for "LuxEeB-Tool", "LuxEeB-H", "LuxEeB-F", "energyefficient.lu" [RUN]. No PyPI/npm package
   named luxeeb or lesosai [RUN]. No forum post, plugin or vendor page describing an import was found [UNK].
2. **"LuxEeB-H" and "LuxEeB-Tool" are the same product line, not two different tools.** The task brief assumed
   LuxEeB-H = old Excel tool (RGD 2007) and LuxEeB-Tool = new tool (RGD 2021). Evidence says otherwise: the
   official manual has been titled "Manuel du LuxEeB-Tool" since 2009; the ministry's 2021 presentation says
   *"LuxEeB-H (tool) mise a jour sur RGD 2021 en cours (Ministere)"*; training providers still call the current
   software "LuxEeB-H"/"LuxEeb_H" in 2024-2026; the register manual says ".txt (LuxEeB-H-tool)". "H" = habitation,
   "F" = fonctionnel. The RGD 2021 version is the 6.x series of the same tool [OFF].
3. **Technology: the only documented fact is "Microsoft Excel macros + VBA"** (official manual v1.7, 2009/2013,
   which the ministry page still links as THE manual of the current software) [OFF]. Whether 6.x is still an Excel
   workbook is **not confirmed** [UNK]; hints both ways (license.dat, Setup_Luxeeb.exe, in-app update).
4. **The most promising door is the project file.** The tool has "Enregistrement de projets" / "Chargement de
   projets enregistres" functions; its autosave file is `Autosave.txt`; the national register is fed by uploading
   the ".txt (LuxEeB-H-tool)" file "from the location where it is saved" (same wording as for Lesosai's native
   project file .bld). So the LuxEeB project file is very probably a **plain .txt that the tool can load back**
   [INF]. If true, a third-party program could WRITE such a file and the expert would just click "load project".
   Format undocumented -> must be reverse-engineered from saved samples (legal check of the licence first).
5. **Lesosai is the only accepted residential CPE software with a documented model import**: IFC / IFCzip (64-bit
   build only) and gbXML through its BIM/BEM module; it has a Luxembourg module and its .bld is accepted by the
   register [OFF/SEC]. No Lesosai <-> LuxEeB conversion exists [UNK - none found].
6. I could **not** download or run LuxEeB-Tool here (vendor host blocked by the proxy, no Windows). Every
   statement about the inside of version 6.x must be re-checked on a Windows PC: see the 30-minute recon plan in
   section 8 and the two scripts in `spikes/`.

---

## 1. Method and environment limits (read this before trusting anything)

- Shell network: only package registries and raw.githubusercontent.com. Verified: `curl https://luxeeb.lu/` ->
  `CONNECT tunnel failed, response 403` [RUN]. I did not try to get around the block.
- WebFetch: `ENOTFOUND` for meco.gouvernement.lu, guichet.public.lu, luxeeb.lu, www.oai.lu (hosts outside the
  session allowlist). After four failures I stopped trying other hosts.
- Therefore **all web facts come from WebSearch result excerpts** (the search tool summarises the indexed page).
  I could not open the manual PDF, the register PDF, the licence PDF, LuxEeB-Version.txt or the installer.
  The excerpts were consistent across ~60 queries, but they are fragments: section bodies I wanted most
  (project save/load, export) never came back.
- `gh` works (v2.89.0) including `search/code` [RUN].
- Hosts that would need to be allowed for a proper follow-up: `luxeeb.lu`, `software.luxeeb.lu`,
  `meco.gouvernement.lu`, `guichet.public.lu`, `www.oai.lu`, `lesosai.com`, `www.downloadsai.com`.

---

## 2. Q1 - What LuxEeB-Tool is

| Item | Finding | Conf. |
|---|---|---|
| Purpose | Official calculation tool for residential CPE ("Outil de calcul relatif au reglement concernant la performance energetique des batiments d'habitation") | [OFF] manual |
| Publisher / owner | Luxembourg State - Ministry of the Economy, energy directorate ("Departement de l'energie" in OAI notices; contact luxeeb@eco.etat.lu) | [OFF] |
| Original author / developer | Manual: written by **Markus Lichtmess** (Jan 2009, modified June 2013) for the Ministere de l'Economie et du Commerce exterieur, "traite par **Goblet Lavandier & Associes**" (Luxembourg engineering firm). Software Informer also lists Goblet Lavandier & Associes Ingenieurs-Conseils S.A. as developer of versions 3.x | [OFF] manual, [SEC] |
| Current developer of 6.x | Not confirmed. Dr. Markus Lichtmess now runs "Institut fuer Gebaeude-Energieforschung" (ingefo.de); its "Praxis" page presents the "LuxEeB-h-Tool" (residential, with a link to the handbook) and "LuxEeB-f-Tool", and says the State has to develop such software itself because the market is too small | [SEC] ingefo.de |
| Current version | **6.09** is the newest version I found (OAI news item 4348, undated in excerpts): "corrections et optimisations au niveau de l'impression des CPE"; detailed changelog = `Versionsinfo.pdf` (German) inside the installer; "licence obtenue pour la version 6.05 ou anterieure reste valable". Earlier: 5.07 (January 2020, had wrong parameters, corrected version followed - OAI news 2231); 3.0/3.2/3.5/3.53 on Software Informer (old). A newer version than 6.09 may exist: check `LuxEeB-Version.txt` on luxeeb.lu | [OFF] OAI |
| Download | Free. Ministry page links an external site; OAI gives `https://software.luxeeb.lu/Setup_Luxeeb.zip`. luxeeb.lu ("Software Luxeeb") lists: `Setup_Luxeeb.exe`, `Setup_Luxeeb.zip`, `LuxEeB-Version.txt`, `Lizenzbedingungen_LuxEeB-Tool.pdf`, `EcoCheck-Tool.zip`, `Lizenzbedingungen_EcoCheck-Tool.pdf`, `Donnees_climatiques_Luxembourg.xlsx/.epw`, `Setup_BuildingEnvelopeEstimator.exe`, `BuildingEnvelopeEstimator-Version.txt`, `Setup_DistrictHeatingFactors.exe`, `DistrictHeatingFactors-Version.txt` | [OFF] excerpts |
| Licence | "Vous acceptez les conditions de licence en telechargeant le logiciel LuxEeB-Tool (Zip)". Demo mode with password **demo**. To issue CPEs a personalised licence is required; it is requested **from inside the software** by any expert accredited under RGD 2021; the licence file carries the expert's unique number, printed on every CPE. 6.x: file `license.dat` in the installation folder (OAI). Old manual: `LIZENZ.TXT` with registration data + personal key, button "Lizenzdatei anfordern". Manual excerpt of the licence contract: software provided "as is", licensor declines liability for direct/indirect damage, licensee indemnifies licensor | [OFF] |
| Licence terms on reverse engineering / automation / file-format use | Not found - the PDF (`Lizenzbedingungen_LuxEeB-Tool.pdf`, German) could not be read | [UNK] |
| Platform / technology | Manual v1.7: "LuxEeB-Tool utilise des macros Microsoft Excel et VBA"; requires Excel 2000 or later with macros enabled; default install dir `C:\Programme\LuxEeB-Tool\`; navigation via a "barre de navigation" and a right-click context menu; a button "Materialdatenbank" opens a materials database | [OFF] manual (2013) |
| Is 6.x still Excel/VBA? | Not confirmed. For: the ministry page still links this same manual for the current tool. Against/neutral: 6.x has `license.dat` (not LIZENZ.TXT), an in-app update function and an in-app licence request. Both are possible in VBA, so no conclusion | [UNK] |
| Updates | "les mises a jour peuvent etre realisees en utilisant la fonction interne du logiciel ... ou bien en reinstallant le logiciel"; licences stay valid across updates; the energy department asks experts to keep the software up to date to stay compliant | [OFF] |
| Sister tools on the same site | EcoCheck-Tool (feasibility study, art. 7 RGD 2021), **BuildingEnvelopeEstimator**, DistrictHeatingFactors. No documentation found for BuildingEnvelopeEstimator. ingefo.de says a method estimating the envelope area "from few inputs" was developed for Luxembourg "to facilitate the creation of Energiepaesse" and is implemented in the Luxembourg renovation simulator. The link between that method and BuildingEnvelopeEstimator.exe is my guess | [OFF] list, [INF] link |

### Naming, once and for all
- **LuxEeB** = the Luxembourg energy-performance scheme/branding (also the prefix of expert numbers `LUXEEB.R.XXXXX`
  and of the mailbox luxeeb@eco.etat.lu).
- **LuxEeB-Tool** = official name of the free residential tool (manual title, ministry page).
- **LuxEeB-H / LuxEeb_H / LuxEeB-h-Tool** = the same residential tool, as named by trainers (House of Training,
  energieagence, eacademy.lu), by the register manual and by the ministry's own 2021 slides.
- **LuxEeB-F (IBP)** = different product for non-residential buildings, developed by Fraunhofer IBP, sold by
  Heilmann Software, the only authorised one for functional buildings since 2021-07-01 [OFF].
- I found **no evidence of a separate "old Excel LuxEeB-H" replaced by a "new non-Excel LuxEeB-Tool"**.

---

## 3. Q2 - Project file, import/export, catalogues

What the manual excerpts give (all [OFF], manual v1.7):
- Chapter "Generalites" contains sections **"Enregistrement de projets"** and **"Chargement de projets
  enregistres"** (bodies not retrievable).
- **Autosave**: "Activation de la sauvegarde automatique a intervalles de 15 minutes, en arriere-plan. Le fichier
  de sauvegarde est place dans le repertoire d'installation de LuxEeB-Tool (par defaut,
  `C:\Programme\LuxEeB-Tool\Autosave.txt`)"; a button opens that file from the default location.
- The passport number is generated from the project data entered.
- Materials database: select a (yellow) layer row of a construction element, click **Materialdatenbank**.
- Manual sections seen in excerpts: 0.4 Enregistrement (licence registration) / 0.4.1; 2.1.2 "Concept regissant la
  saisie des donnees et la structure du logiciel"; 2.2.3 "Saisie de la composition d'un element de construction";
  2.2.6 manual entry of element parameters; 2.5.2 shading of transparent elements; 2.7 ventilation (2.7.1,
  2.7.1.1); 2.9 summary table of construction elements; 2.10 heating-demand table; 3 "Calcul des installations";
  3.3 auxiliary energy; 3.4 summary table of technical installations.

Conclusions:
- **Project file extension/format: very likely plain `.txt`** [INF] - evidence chain: Autosave.txt + register
  accepts ".txt (LuxEeB-H-tool)" taken "from where it is saved" + an Excel/VBA tool that must persist a
  protected workbook's inputs outside the workbook. NOT verified: encoding, structure (key=value? one value per
  line? cell dump?), checksum/signature, whether the licence/expert number is embedded.
- **Documented?** No public specification found [UNK].
- **XML / CSV interchange, clipboard paste from Excel, templates:** nothing found [UNK]. If the tool is an Excel
  workbook, ordinary copy/paste into unlocked input cells may simply work - to be tested.
- **Catalogues:** built-in materials database (see above) [OFF]; window U-value estimation per EN ISO 10077-1
  inside the tool [OFF]. User-extensible catalogue: unknown.

---

## 4. Q3 - The register file

Source: "Registre des calculs et certificats de performance energetique (CPE)" - user manual of the CPE import
software, 12 pages, v1.8 (guichet.public.lu `registre-calculs-cpe.pdf`), excerpts [OFF]:
- Portal reached via **www.energyefficient.lu**, section "Registre des certificats de performance energetique"
  (search results show the portal living at `https://www.luxeeb.lu/ee.php`; BuiltWith records redirects
  energyefficient.lu -> luxeeb.lu) [OFF/SEC].
- Steps: create/activate account ("Activer mon compte") -> log in with expert number (LUXEEB.R.XXXXX) + password
  -> **add the `.txt` (LuxEeB-H-tool) or `.bld` (Lesosai) files "depuis l'emplacement ou ils sont enregistres"**,
  several at once -> import -> a summary shows the status of each file (print it as proof).
- Help: registre@eco.etat.lu.
- **Direction: output only.** The register consumes the calculation file; nothing indicates it can give data
  back to an expert or to third parties [OFF for the upload, UNK for any download].
- **What the .txt contains:** not documented in the excerpts [UNK]. Since the ministry's quality control checks
  inputs (envelope, reference area, volume, installations - see `controle-cpe-recapitulatif.pdf`), the file most
  likely carries the full calculation inputs, i.e. it is the project file itself [INF].
- Is the register .txt identical to the "save project" file, or a separate export? [UNK] - first thing to check
  on a real installation.

---

## 5. Q4 - Lesosai

| Item | Finding | Conf. |
|---|---|---|
| Accepted for Luxembourg residential CPE (RGD 2021)? | Yes: ministry page lists "LuxEeB-Tool et Lesosai" for residential buildings. OAI/FCCE note 0529-E21 (2021-12-20): Lesosai update for RGD 2021 done, downloadable/purchasable at lesosai.com. Lesosai 2024 release notes: several projects were compared with LuxEeB by independent offices and the FCCE | [OFF], [SEC] |
| Vendor | E4tech Software SA (Switzerland); "Module Luxembourg" in the 2026 brochure; paid (ministry: "peuvent etre achetes aupres du fournisseur externe") | [OFF]/[SEC] |
| Price hints | lesosai.com/tarifs excerpt: BIM/BEM module 150 EUR first purchase, 65 EUR update from 2025; Luxembourg module shown as 0 / 140 / 290 EUR depending on column (labels unclear in the excerpt). One-off purchase + yearly paid updates. Check the live page | [SEC] excerpt |
| .bld | Native Lesosai building/project file (a `bldexemples` folder ships one .bld per standard). Internal format (text/binary) not found | [SEC], [UNK] |
| Model import | BIM/BEM module: **IFC, IFCzip (64-bit Lesosai only), gbXML (32/64-bit)**, BCF export, OpenStreetMap import for shading. IFC read per ISO 10303-21; IFC2x3 recommended for Revit, IFC4 for Archicad; Archicad 25 ships a dedicated Lesosai IFC translator (per Lesosai docs); Revit via "USai Revit Plugin" | [SEC] vendor PDFs on downloadsai.com (excerpts) |
| DXF/DWG import | Nothing found | [UNK] |
| Lesosai <-> LuxEeB-Tool conversion | Nothing found in either direction | [UNK] |
| Known pitfall | Ministry control report: "absence d'influence des ponts thermiques, coche par defaut dans le logiciel Lesosai" listed among frequent errors | [OFF] excerpt |
| Training | IFSB: "Utilisation du logiciel LESOSAI : creation de CPE (nouvelle reglementation lux.)", ~1300 EUR HT | [SEC] |

Product meaning: for Archicad (.pln) users there is already a vendor-supported chain
**Archicad -> IFC -> Lesosai (Luxembourg module) -> .bld -> register**. It does not touch LuxEeB-Tool and it needs
a real 3D model with thermal semantics; it does nothing for 2D PDF/DWG plans.

---

## 6. Q5 - Third-party integrations, training material, entry workflow

- Integrations / plugins / converters for LuxEeB-Tool: **none found** (web + GitHub) [RUN for GitHub, UNK for web].
- Training (all sell classroom time, none publishes screen-by-screen material) [SEC]:
  - House of Training x energieagence: "Energiepass Wohngebaeude (LuxEeB-H)" (7 h, about 650 EUR; sessions listed
    for 2024-11-12, 2025-11-25, 2026-04-28, 2026-10-07), "Vertieferschulung" (thermal bridges, coding of technical
    installations in the software), French equivalents. Programme: mandatory requirements, energy reference
    area, thermal envelope, energy balances, "Einfuehrung in die LuxEeB_H-Software (Demo Version) und Uebungen".
  - eacademy.lu (energieagence e-learning), lifelong-learning.lu listings, IFSB (Lesosai).
- Data-entry procedure from the manual ("Procedure de saisie pour un batiment") [OFF]:
  1. General project data (building type, number of dwellings, address, ...)
  2. Definition of the construction element types (layer build-ups, materials database, U-values; windows per
     EN ISO 10077-1)
  3. Building envelope data and linking of surfaces to construction elements - always gross (external)
     dimensions; exterior surfaces sorted by the **eight compass directions**; shading of transparent elements
  4. Energy reference area and building volume
  5. (not retrieved - by the chapter list: ventilation, then technical installations: heating, DHW, solar
     thermal, mechanical ventilation, PV; summary tables; certificate print-out)
- The official quality-control summary lists error families the product should guard against: wrong building
  type; reference area / heated volume computed inconsistently from gross vs net dimensions; implausible
  modernisation recommendations (page 5); missing consumption record (page 4) [OFF].
- One Luxembourg provider states an Energiepass cannot be computed automatically by online software because the
  consumption-based method is not allowed and an on-site inspection is essential [SEC] - a market objection to
  expect.

---

## 7. Q6 - If there is no import interface: options, ranked

Everything in this section that describes LuxEeB-Tool internals is conditional on the recon in section 8.
Library facts are [RUN] (registry probe); behaviour claims are engineering judgement, not tested against the tool.

### Option A - write the project .txt and let the expert "load project"  (best IF the file is plain text)
- Pro: no fragile UI driving; one user action; the official tool recalculates everything itself, so the expert
  still sees and validates every value inside the official software; works offline; fast.
- Con: undocumented format -> reverse engineering by differential saves; every tool update may add/reorder
  fields (the tool itself must migrate old projects, so the format is probably tolerant - to verify); possible
  checksum or embedded licence data; licence terms unknown; the ministry could object.
- Effort to validate: half a day with a demo install (does demo mode allow saving? [UNK]).
- Mitigation: version-pin by reading the header of a file freshly saved by the user's own installed version and
  using it as template ("fill the user's own empty project" instead of generating from scratch).

### Option B - Excel COM automation (only IF the tool is an Excel workbook)
- Drive the open workbook through COM (`pywin32` 312, 2026-06; or `xlwings` 0.37.12, 2026-11; or `winax` for
  Node) and write `Range.Value` into the input cells; Worksheet_Change handlers still fire.
- Pro: far more robust than clicking; cells addressed by sheet name + named range/address; no screen geometry.
- Con: cell addresses are internal and change between versions; protected sheets (only unlocked cells are
  writable - never unprotect); inputs done through VBA UserForms (materials database, wizards) are not reachable
  by cell writes; the tool may run its own Excel instance; needs desktop Excel on the same PC.

### Option C - UI Automation "robot typist" (pywinauto / FlaUI / uiautomation / AutoHotkey)
Verified library status [RUN] (`out/pkg_probe.json`, `out/release_dates.txt`):

| Library | Latest | Released | Note |
|---|---|---|---|
| pywinauto | 0.6.9 (1.0.0b1 pre-release 2026-10-15) | 2025-01-06 | previous release 0.6.8 was 2019-10-27 -> 5-year gap; imports on Linux but any use fails (`No module named 'win32gui'`) so it cannot be CI-tested off Windows |
| uiautomation (Python) | 2.0.29 | 2025-08-05 | Windows COM only (import fails on Linux) |
| FlaUI.Core / UIA3 (.NET, NuGet) | 5.0.0 | 2025-02-25 | 4.0.0 was 2022-09 |
| robotframework-flaui | 7.0.0 | 2026-11-10 | active |
| pyautogui | 0.9.54 | 2023-05-24 | pixel/keyboard level only |
| @nut-tree/nut-js (npm) | 404 on the public registry | - | original package no longer public; community fork @nut-tree-fork/nut-js 4.2.6 (2025-03) |

- Pro: needs no knowledge of file formats; works on whatever the screen shows.
- Con (serious):
  - Coupled to window titles, control names, tab order, language (FR/DE UI), DPI, Excel/Office version.
  - If Excel-hosted: the grid is one big control; VBA UserForms expose little to UI Automation; you end up
    sending keystrokes to "whatever has focus" = blind typing.
  - Any ministry update can silently shift a field: the robot then types a correct value into the WRONG field
    without an error. In a regulated calculation this is the worst failure mode.
  - Modal message boxes, validation pop-ups, autosave every 15 min, focus stealing.
  - Hard to test: needs a Windows VM with the real tool for every released version.
  - Antivirus/EDR in engineering offices often flags input injection.
- Verdict: acceptable only as a user-triggered, small-step helper (next section), not as a "fill everything" robot.

### Option D - side-by-side copy assistant (recommended baseline; works with whatever A/B turn out to be)
A narrow always-on-top panel next to LuxEeB-Tool that lists the values in exactly the order of the tool's entry
procedure (project -> element types -> envelope surfaces by element and orientation -> reference area and volume
-> installations), one tap = copy, with FR/DE labels identical to the tool's, decimal comma, units, and a tick
when done.
- Pro: zero coupling to the tool's internals; survives updates (only a label/order mapping to maintain); no
  licence question; the expert types/pastes and therefore reviews every value (liability stays clean); the same
  panel serves Lesosai users; can show the provenance of each value on the plan (playful + trust).
- Con: still dozens to a few hundred manual inputs per building; less "magic".
- Upgrades that keep the low coupling: (1) block copy as tab-separated text for multi-cell paste if the tool's
  sheets accept it [to test]; (2) user-triggered "type next value + Tab" hotkey into the cell the user has
  focused (the user chooses the target, the helper only saves keystrokes); (3) a final screen-vs-expected
  comparison list the expert ticks off.

### Option E - go through Lesosai instead (gbXML / IFC)
Only documented import path into an accepted tool; requires the expert to own Lesosai + BIM module and a clean
3D model; not what the user asked for (LuxEeB-Tool), but worth offering as an export target (gbXML) later.

### Option F - ask the ministry
The tool is State-owned and the State already operates a register that parses the calculation file. Asking the
energy directorate (luxeeb@eco.etat.lu) for (a) the project-file specification or (b) permission to generate it
is cheap and removes the legal uncertainty of option A. Also ask what BuildingEnvelopeEstimator is.

### Liability and regulatory points for every option
- The CPE carries the expert's unique number from the licence file; the accredited expert answers for the
  inputs. The ministry runs controls and publishes error statistics [OFF]. Sanction details (withdrawal of
  accreditation etc.) were not retrieved [UNK] - check RGD 9 June 2021 and the accreditation regulation.
- Licence: "as is", licensor not liable, licensee indemnifies [OFF excerpt]; clauses on automation/reverse
  engineering unknown [UNK].
- Design rules that follow: never print/sign/upload automatically; always leave the expert a per-value review
  with the source on the plan; mark estimated vs measured values; detect the installed LuxEeB-Tool version and
  refuse to transfer if it is not a version the mapping was validated against; keep a transfer log.
- The regulation moves: RGD 2021 has been amended and EPBD recast 2024/1275 is being transposed (a draft
  regulation transposing art. 23, 24, 27, 29 exists; nothing found yet on a new CPE scale or a new tool) [OFF
  excerpt/UNK]. Expect tool updates; build the mapping as data, not code.

---

## 8. Recon plan for a Windows PC (30 minutes, settles the open questions)

1. Read `Lizenzbedingungen_LuxEeB-Tool.pdf` first (clauses on reverse engineering, automated use, file formats).
2. Install from the official link, start in demo mode (password `demo`).
3. Does Excel start? -> answers "Excel/VBA or standalone".
4. `python spikes/recon_windows.py "<install dir>" > recon.json` (UNTESTED script: lists installed files with
   magic bytes, finds the window/process, dumps the UI Automation tree, and if Excel-hosted lists workbook /
   sheet names, protection flags and defined names via COM; read-only).
5. Save a project; look at the extension. Run `python spikes/sniff_project_file.py <file>` (TESTED, see below).
6. Change exactly one input (e.g. one wall area 10 -> 11), save again, diff the two files -> field mapping method.
7. Locate the register export (menu name?) and compare that file with the saved project (identical?).
8. Try: copy a 3x3 block from Excel and paste into the envelope table; type with decimal comma vs point.
9. Check demo-mode limits (save? print? export?).
10. Install BuildingEnvelopeEstimator and note its inputs/outputs (possible existing "few inputs" envelope method).

---

## 9. What was run here (reproducible)

```
# GitHub code search (gh 2.89.0)                           -> out/gh_search_counts.tsv
./spikes/gh_search.sh
"LuxEeB-Tool" 0 | "LuxEeB-H" 0 | "LuxEeB_H" 0 | "LuxEeB-F" 0 | "energyefficient.lu" 0
"luxeeb" 274 (all noise: Pluxee, expired-domain lists, base64) | "Energiepass" Luxembourg 39 (none about the tool)
"lesosai" bld 2 (noise)
# repo search                                              -> out/gh_repo_search.txt
luxeeb: 1 repo (unrelated bot) | lesosai: 1 (unrelated) | energiepass luxembourg: 0

# registry probe for automation libraries                  -> out/pkg_probe.json, out/release_dates.txt
python3 -I spikes/pkg_probe.py > out/pkg_probe.json
pypi luxeeb: 404, pypi lesosai: 404, npm luxeeb: 404

# Windows UI libs on Linux                                 -> out/linux_import_check.txt
pywinauto 0.6.9 imports, but `from pywinauto import backend` -> ModuleNotFoundError: win32gui
uiautomation -> ImportError: COM technology not available

# unknown-file sniffer self-test (8/8 PASS)                -> out/sniff_selftest.txt
python3 -I spikes/sniff_project_file.py --selftest
  detects: text (cp1252 / utf-16 / ascii; key=value vs delimited table; decimal comma), xml, zip (xlsm with
  vbaProject.bin), OLE2 (.xls), sqlite, high-entropy binary

# vendor host                                              -> blocked
curl https://luxeeb.lu/  => CONNECT tunnel failed, response 403
```

`spikes/recon_windows.py` only passed `py_compile`; it has never been executed.

---

## 10. Dead ends

- Fetching any Luxembourg page or the installer (blocked) - no workaround attempted.
- Getting the body text of the manual sections on saving/loading projects through search excerpts: ~10 differently
  worded queries (FR/DE), never returned.
- Finding the German handbook text, a v6 manual, Versionsinfo.pdf content, release dates of 6.x: not indexed.
- Software Informer pages for "LuxEeB-Tool 3.x": auto-generated description, useless except for the developer name.
- Scribd copy of the manual (44 pages): only the cover is indexed.
- Theses / YouTube tutorials / forums showing LuxEeB-Tool screens: none found.
- `Nasheor/BERAutomation` (GitHub hit for "Energiepass Luxembourg"): an Irish BER estimator with country climate
  tables, unrelated to LuxEeB-Tool.

---

## 11. Sources (all via WebSearch excerpts unless marked RUN)

- Ministry technical information page: https://meco.gouvernement.lu/fr/domaines-activites/energie/efficacite-energetique/informations-techniques.html (also /en/, /de/)
- Manual FR: https://meco.gouvernement.lu/dam-assets/le-ministere/fonctions/energie/efficacite-energetique/manuel.pdf ; DE: .../handbuch.pdf
- Register manual: https://guichet.public.lu/dam-assets/catalogue-pdf/urbanisme/experts-habitation/notes-informations/registre-calculs-cpe.pdf
- Control summary: https://guichet.public.lu/dam-assets/catalogue-pdf/urbanisme/experts-habitation/faq/controle-cpe-recapitulatif.pdf
- Vendor/download site: https://luxeeb.lu/ ; https://software.luxeeb.lu/Setup_Luxeeb.zip ; register portal https://www.luxeeb.lu/ee.php
- OAI news 6.09: https://www.oai.lu/fr/24/accueil/actualite-agenda/actualite/0-mode-news-id-4348/ ; 5.07: .../0-mode-news-id-2231/
- OAI/FCCE note 2021-12-20: https://www.oai.lu/files/Actualites/2022/0529-E21_Note_information_OAIFCCE_situation_logiciel_LuxEeB-F_IBP.pdf
- Ministry slides RGD 2021: https://maint.gouvernement.lu/dam-assets/circulaires/2021/juillet-decembre/4024-Presentation.pdf
- ingefo: https://ingefo.de/Praxis/ ; https://ingefo.de/Forschung/Effizienz/
- Lesosai: https://lesosai.com/tarifs/ ; https://lesosai.com/logiciel/bim-bem/ ; https://www.downloadsai.com/pdf/LESOSAI-BIM-gbXML-2025FR.pdf ; https://www.downloadsai.com/pdf/Lesosai2026fr.pdf ; https://lesosai.com/logiciel/versions/version-lesosai-2024/
- Training: https://www.houseoftraining.lu/en_GB/training/energiepass-wohngebaude-luxeeb-h-15095 ; https://eacademy.lu/fr/formations ; https://www.ifsb.lu/utilisation-du-logiciel-lesosai-creation-de-certificats-de-performance
- Software Informer (weak): https://luxeeb-tool.software.informer.com/
- BuiltWith redirect record (weak): https://builtwith.com/redirects/software.luxeeb.lu
- [RUN] PyPI JSON API, registry.npmjs.org, api.nuget.org, GitHub search API
