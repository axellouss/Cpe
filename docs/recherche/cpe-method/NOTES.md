# Luxembourg residential CPE - which inputs are needed, and which can come from plans

Research notes, 2026-11-27. Topic: the calculation method behind the residential energy performance certificate
(CPE / Energiepass, "batiments d'habitation" / "Wohngebaeude"), i.e. what LuxEeB-Tool has to be fed with.

Confidence tags used everywhere below:

- **[RUN]** proved by running code in this directory (script + output named)
- **[OFF-x]** official source (Mémorial/Legilux, ministry, guichet.lu, Chambre des députés, Conseil d'Etat, Chambre de
  commerce dossier), but read ONLY as WebSearch excerpts - I could not open a single one of these documents (see section 1)
- **[SEC]** secondary source (commercial sites, training material, papers) through WebSearch excerpts
- **[MEM]** recalled from model memory (mainly the German DIN V 4108-6 / EnEV / IWU base the Luxembourg method was
  built on). NOT verified for Luxembourg. Treat as a hypothesis to check, never as a number to ship.
- **[UNK]** not found / could not confirm

---

## 0. TL;DR for product decisions

1. **The method is a "German-family" energy balance** (IWU advised the ministry 2005-2011 on the calculation
   approach; the tool manual and the typology note were produced with Goblet Lavandier & Associés; that the balance
   is monthly is [MEM], not confirmed). Inputs are: 4 geometry aggregates (An, Vn, Ve, A), a list of envelope elements
   (area, orientation, inclination, U, boundary type -> temperature correction factor), windows (area as rough opening,
   Uw, g, shading), one thermal-bridge surcharge, n50 + ventilation system, heating / hot-water / auxiliary system
   descriptors, renewables. [OFF-x] for the structure, details partly [MEM].
2. **Everything geometric is defined so that a plan reader can compute it**: An = *net* conditioned floor area inside
   the thermal + airtight envelope, only where clear height > 1.0 m; Ve and A = *external* dimensions; windows = rough
   opening ("dimensions brutes (gros-oeuvre)"). So one drawing set gives two different measurement conventions
   (inside faces for An, outside faces for A and Ve). [OFF-x]
3. **What plans do NOT tell is exactly what dominates the result for existing buildings**: element U-values
   (age class, later-added insulation), which rooms are really heated, where the thermal envelope runs (cellar, attic,
   neighbour), air-tightness, heating system. My sensitivity spike: an unnoticed 8 cm wall retrofit = -17..-29 % on
   heating demand, An from gross instead of net dimensions = -17..-18 %, one age class wrong on the wall = +-7..17 %,
   a party wall treated as outside wall = +11..13 %; window orientation / window area / g-value errors stay below ~2 %
   for uninsulated houses. [RUN, simplified stand-in model, see section 9]
4. **Official defaults exist and are the key to "ask the minimum"** for existing buildings: the ministry note
   "U-Wert-Typologien für bestehende Gebäude" (U-value by element x construction x age class x cm of added
   insulation, lambda 0.04; windows by frame/glazing/period; 60 % glass share), an indicative n50 table, default
   temperature-correction factors, a flat thermal-bridge surcharge (0.10 W/m²K), a simplified shading rule and a
   simplified An rule for apartment buildings (annex I ch. 5.7). I got the *existence* and *structure* of all of
   these from official excerpts, but **the numeric tables only partially** (section 6). They must be transcribed from
   the PDFs by a human before any coding.
5. **Class thresholds are printed as images ("Illustrations") in the annex**, which is why no text search returns them.
   2007-regulation thresholds are confirmed from a ministry report; the 2021 ones only from a commercial site. [OFF-x]/[SEC]
6. **Automation limit**: only OAI architects / consulting engineers and ministry-approved experts may issue a CPE;
   an approved expert *must visit* an existing building; the ministry audits a statistically significant sample every
   year and checks precisely the *input data*; the expert carries professional liability (approved experts: insurance
   >= 1 240 000 EUR). The product must therefore be an assistant that proposes values with their provenance and lets
   the expert confirm - never a black box that "produces the CPE". [OFF-x]
7. **I could not read any primary document.** All government and mirror hosts are outside the network allowlist, and
   the shared WebSearch budget ran out after 55 queries. Section 12 lists what is still unconfirmed and the exact
   URLs to open on an unrestricted machine (2-3 hours of reading would close most gaps).

---

## 1. Method and limits - read before trusting anything

- `curl` to conseil-etat.public.lu, meco.gouvernement.lu, cdn1.gopublic.dk, www.cc.lu, wdocs-pub.chd.lu,
  legilux.public.lu, guichet.public.lu, web.archive.org, orbilu.uni.lu -> all `000` (blocked by the proxy). [RUN]
- WebFetch: `ENOTFOUND` for www.cc.lu, meco.gouvernement.lu, cdn1.gopublic.dk. The tool itself says to stop trying
  after such failures, so I did. No document was ever opened.
- GitHub code search (`gh search code`) for "surface de référence énergétique", "Energiebezugsfläche An",
  "facteur de correction de température", "LuxEeB", ... -> no mirror of the regulation, no open-source
  implementation of the Luxembourg method (`gh/search1.txt`). [RUN]
- Therefore every regulatory fact below comes from **WebSearch result excerpts** (the search tool summarises the
  indexed page and quotes fragments). Fragments were consistent across queries, but: tables come back truncated,
  several *versions* of the annex are indexed side by side (2007 text consolidated 2010/2016, the 2020 draft of the
  2021 regulation, the 2022 amendment), and table/chapter numbers differ between versions.
- The WebSearch budget is shared by all agents of this run ("limit: 200 WebSearch calls per turn"). It was exhausted
  after my 55th query; my last two queries (exact thermal-bridge wording; uni.lu study on calculated vs measured
  consumption) were not executed. I did not work around the limit.
- Beware of one recurring confusion in the search summaries: the Chambre des députés file
  `wdocs-pub.chd.lu/docs/Dossiers_parlementaires/7668/20250515_Dépôt.pdf` is **dossier 7668, session 2019-2020 =
  the draft of the regulation that became the RGD of 9 June 2021**. The "2025" in the URL is a publication date of
  the scan; the summaries wrongly call it "a 2025 draft".

---

## 2. Legal map

| Text | What it is | Status |
|---|---|---|
| Loi modifiée du 5 août 1993 concernant l'utilisation rationnelle de l'énergie | enabling law | [MEM] - not checked |
| RGD du 30 novembre 2007 concernant la performance énergétique des bâtiments d'habitation (in force 1.1.2008), amended several times; guichet.lu still hosts "Règlement grand-ducal modifié du 30 novembre 2007" FAQ and a consolidated annex | first residential regulation; introduced the Energiepass, classes A-I, LuxEeB-Tool | [OFF-x] |
| RGD du 31 août 2010 (bâtiments fonctionnels) | non-residential | [OFF-x] |
| RGD du 23 juillet 2016 (amendment; new-build requirements from 1.1.2017: wall 0.13, roof 0.11, floor 0.17, window 0.9, door 1.35 W/m²K per IEA summary) | nZEB step | [SEC] IEA policy page |
| **RGD du 9 juin 2021 concernant la performance énergétique des bâtiments** (Mémorial A439) - merges both; **Annexe I = bâtiments d'habitation**, Annexe II = bâtiments fonctionnels, Annexe III = common | current base; "RGD modifié du 9 juin 2021" after the 2022 amendment (Legilux consolidated version applicable 09/07/2022; Chambre dossier 7946; Conseil d'Etat 60890) | [OFF-x] |
| FAQ RGD 2021 - Bâtiments d'habitation (ministry PDF, mirrored on readkong) | interpretation | [OFF-x] existence only |
| "Contrôle des certificats de performance énergétique ... récapitulatif" (guichet.lu) | typical errors found in audits | [OFF-x] excerpt |
| "U-Wert-Typologien für bestehende Gebäude" v1.1, 12.11.2007 (ministry; Goblet Lavandier & Associés + IWU) | default U-values for existing buildings | [OFF-x] excerpt |
| Manuel du LuxEeB-Tool / Handbuch (ministry) | tool manual, FR + DE | [OFF-x] excerpt |

Chapter map of **Annexe I** as far as excerpts show (2021 numbering; the consolidated 2007 annex uses the same
chapter numbers but different table numbers) [OFF-x]:

- ch. 1 minimum requirements: max U-values per element (Tableau 1), summer comfort, air-tightness (ch. 1.3; limit
  values "Tableau 7 - Valeurs limites pour n50"), ventilation, pipes ...
- ch. 2 requirements on specific heating demand and primary energy for new buildings / extensions (2.1 ...)
- ch. 3 the "calcul de performance énergétique" (the calculation document that accompanies a building permit)
- ch. 4 the certificate; **4.2 = classes**
- ch. 5 calculation rules: **5.1 geometry** (5.1.2 An, 5.1.3 Vn, 5.1.4 Ve, 5.1.5 A, 5.1.6 A/Ve); 5.2 heating demand
  (5.2.1 transmission: 5.2.1.3 temperature correction factors - 5.2.1.3.1 / 5.2.1.3.2 with Tableaux 12 and 13 in the
  2021 numbering, Tableaux 9 and 10 in the 2016 consolidated text; 5.2.1.4 thermal bridges ΔU_WB); solar gains;
  ventilation; 5.3-5.6 final energy heating, hot water, auxiliary, primary energy, CO2;
  **5.7 = provisions for existing buildings** (5.7.1 simplified An, ..., 5.7.5 simplified final energy for heating);
  a table of contents excerpt also shows a "simplified U-value method" at 5.9.8.
- Legilux excerpt: for a building that is extended or substantially modified the certificate covers the whole
  building and follows "annexe I, chapitres 3 et 5.1 à 5.6, avec prise en compte des dispositions de l'annexe I,
  chapitre 5.7".

Scope facts [OFF-x]: residential = >= 90 % of An used for housing; independent buildings with An < 50 m² are
excluded; extension thresholds Ve > 75 m³ and "<= 80 m² / > 80 m²" (two different guichet calculation guides);
"10 % rule" - works on >= 10 % of an envelope element's area trigger a new/updated certificate; validity 10 years.

What changed 2007 -> 2021 (only what excerpts show - I could not diff the texts): class A+ added; An definition now
also names the "enveloppe d'étanchéité à l'air"; tables renumbered; primary-energy class limits for houses appear
slightly lower (section 7); pre-cabling for e-mobility / PV for new buildings; one regulation for both building types.

---

## 3. Geometry definitions (Annexe I ch. 5.1)

| Quantity | FR (official) | DE | Definition | Conf. |
|---|---|---|---|---|
| An [m²] | surface de référence énergétique An (SRE) | Energiebezugsfläche An | "la partie conditionnée (pour laquelle le chauffage ou la climatisation est nécessaire) de la surface de plancher nette à l'intérieur de l'enveloppe thermique et à l'intérieur de l'enveloppe d'étanchéité à l'air" (ch. 5.1.2). DE: "der konditionierte Teil der Nettogrundfläche innerhalb der thermischen Hülle" | [OFF-x] |
| Vn [m³] | volume d'air chauffé Vn | (beheiztes Luftvolumen) | sum over the rooms that count in An of area x clear height (5.1.3) | [OFF-x] |
| Ve [m³] | volume bâti chauffé brut / volume brut chauffé Ve (older: "volume conditionné brut") | (beheiztes Bruttovolumen / Gebäudevolumen) | "le volume de construction compris dans la surface de l'enveloppe thermique" (5.1.4) | [OFF-x] |
| A [m²] | surface de l'enveloppe thermique A | Gebäudehüllfläche A / thermische Hülle | determined "avec les dimensions extérieures"; envelope must be insulated and airtight (5.1.5) | [OFF-x] |
| A/Ve [1/m] | rapport A/Ve | A/Ve-Verhältnis | 5.1.6; a draft mentions the range 0.2 < A/Ve < 0.8 in a requirement formula | [OFF-x] |

Rules for **An** [OFF-x unless noted]:

- Net floor area, i.e. measured between the inner faces of walls and partitions (OAI note FC04 "Calcul surfaces
  volumes": NRF = surface de plancher nette "mesurée au nu intérieur des murs et cloisons" = useful + circulation +
  technical area). A classic audit finding is "An calculated from gross dimensions".
- A "conditioned room" is one whose **standard use requires heating or cooling** (DE: "Ein konditionierter Raum ist
  ein Raum, für dessen Standardnutzung ein Beheizen oder Klimatisieren erforderlich ist"). A radiator alone does not
  make a room count. "La surface d'un local non conditionné, compris dans l'enveloppe thermique du bâtiment, n'est
  toutefois pas intégrée dans la surface de référence énergétique An."
- Excluded "parce que leur utilisation ne nécessite pas de conditionnement (exemples: chaufferie, garage, ...)" or
  "parce qu'ils sont situés à l'extérieur de l'enveloppe thermique" (audit recap).
- The annex contains a room-assignment table ("Tableau 8" in the consolidated 2007 text): "locaux faisant partie de
  la surface de référence énergétique" (living rooms, bedrooms ...) vs not; one row reads "cages d'escalier et
  couloirs, s'ils ne sont pas en contact avec l'air extérieur" - excerpt truncated, so the exact status of stairs is
  **medium confidence**: internal stairs/corridors count; a stair part that lies outside the envelope (basement) does not.
- Height rule: for rooms with varying height "seule la partie de la surface dont la hauteur est supérieure à 1,0 m"
  counts (DE: "nur der Teil, bei welchem die lichte Raumhöhe größer als 1,0 m ist"). There is **no** 1-2 m
  half-counting as in the German Wohnflächenverordnung, as far as the excerpts show.
- Existing apartment buildings: An "peut être déterminée de manière simplifiée" (ch. 5.7.1; a related fragment says
  only the area usable for housing counts as floor area). Formula not retrieved. [UNK]
- A Luxembourg sustainability document (LENOZ context) converts An to gross area as An x 1.18. [SEC]
- The 2026 aid law (Legilux "Loi du 24 juillet 2026 relative au régime d'aides ...") excludes from the SRE garages
  for vehicles, bin rooms, technical shafts and fuel-supply rooms even if inside the envelope - that is the aid
  scheme, not the CPE annex. [OFF-x, different text]

Rules for **A / Ve** [OFF-x]: external dimensions; "en présence de greniers chauffés (chiens-assis), il faut prendre
en considération les surfaces extérieures réelles dans la surface de l'enveloppe du bâtiment et le volume réel dans
le volume brut" (dormers are measured as built, not simplified away).
Storey-height convention, where exactly the external dimension ends at ground slab / roof (top of insulation?
finished face?), and how element areas are split at junctions: **not retrieved** [UNK]. German practice [MEM]:
outer face of the insulated construction, floor slab on ground to its lower edge, top-floor ceiling to its upper edge.

**Windows** [OFF-x]: areas are taken as "dimensions brutes (gros-oeuvre)" (rough/structural opening; DE practice
"lichtes Rohbaumaß"). U_w "généralement calculé selon EN ISO 10077-1; LuxEeB-Tool peut l'estimer".

---

## 4. What must be entered per envelope element

| Input | What the excerpts establish | Conf. |
|---|---|---|
| Area, per element | gross outside area for opaque parts minus openings; windows at rough opening | [OFF-x] |
| Orientation | solar radiation is tabulated for **9 orientations: 4 cardinal + 4 intermediate (+ horizontal)** | [OFF-x] |
| Inclination | needed for roofs/roof windows (radiation tables by inclination) - table not retrieved | [MEM]/[UNK] |
| U-value opaque | EN ISO 6946 from layers (LuxEeB has a materials database, "Materialdatenbank"); new build must respect Tableau 1 max values; existing: typology defaults (section 6) or measured values | [OFF-x] |
| Temperature correction factor Fϑ,i ("facteur de correction de la température" / Temperaturkorrekturfaktor) | "En l'absence d'un calcul justificatif, il y a lieu d'appliquer les valeurs par défaut" of the table "Facteurs de correction de la température Fϑ,i des éléments en contact avec l'extérieur ou des locaux non chauffés" and of the ground-contact table. One row seen: "plancher en contact avec un local tampon (cage d'escalier, atrium) 0,50". Functional-building annex points to DIN V 18599-2 for flat factors. In LuxEeB the factor is picked automatically from the boundary type; for manually entered elements the user reads it from the tables | [OFF-x] structure; values [UNK] |
| ... likely values (German DIN V 4108-6 Tab. 3 basis) | outside air 1.0; top ceiling to unheated attic 0.8; knee walls 0.8; walls/ceilings to unheated rooms 0.5; to low-heated rooms 0.35; unheated glazed porch 0.5-0.8; ground contact 0.2-0.6 depending on B' = A_G/(0.5 P) and R; heated neighbour 0 | [MEM] |
| Thermal bridges ΔU_WB (ch. 5.2.1.4) | flat **0.10 W/(m²K)** on the whole envelope; a reduced flat value **0.05** under conditions (excerpts mention execution to DIN 4108 Supplement 2 in the functional annex and calculation to EN ISO 10211); a later version mentions 0.05 or **0.03** with a restriction for passive-house standard; an earlier version mentions **0.15** for special cases; or detailed calculation | [OFF-x], exact conditions [UNK] |
| Window U_w, g | per window type; existing: typology (section 6) | [OFF-x] |
| Glass / frame share | existing windows: glass share for solar gains "pauschal 60 %" (typology note). New: from EN ISO 10077 geometry | [OFF-x] |
| Shading / reduction factors | symbols seen: F_S (shading by surroundings), F_0 ("facteur d'ombrage partiel dû à des éléments en surplomb horizontal", own table), F_C (solar protection device), F_W (non-perpendicular incidence), F_V (dirt). LuxEeB has an "outil d'analyse" for the shading factor (manual 2.5.2). For existing buildings a **simplified determination of shading factors is allowed** under conditions | [OFF-x]; default numbers [UNK] |
| Summer rule | solar protection required above a 30 % window share; the excerpt defines the share as sum of window areas (rough opening) divided by net floor area but also speaks of facade area - internally inconsistent, check | [OFF-x] |

---

## 5. Non-geometry inputs

- **Air-tightness n50** [OFF-x]: limit values for new buildings in "Tableau 7" (excerpt: without ventilation system
  <= 3.0 1/h; with ventilation system <= 1.5; class B with heat recovery <= 1.0; a trainer site gives a stricter
  current scale from 1.5 without ventilation down to 0.6 for class A/A+ with heat recovery - **the two excerpts
  conflict**, check the table). Measured value per EN ISO 9972 / annex ch. 1.3 can be used for existing buildings.
  Extensions without their own test take the n50 of the building.
  For existing buildings without a measurement: "il convient d'utiliser, comme valeur indicative, des valeurs de
  l'étanchéité à l'air n50" from a table ("Tableau 18" in the certinergie copy); "for existing buildings of recent
  construction better values may be used". **Values not retrieved** [UNK].
- **Ventilation** [OFF-x]: manual ch. 2.7 "Installation de ventilation et pertes de ventilation"; requirement tables
  distinguish with / without ventilation system and with heat recovery. Expected options [MEM]: window ventilation,
  exhaust-only, balanced with heat recovery (efficiency, fan power), optional ground heat exchanger.
- **Heating / DHW / auxiliary** [OFF-x]: systems are characterised by "facteurs de dépense" (inverse efficiency;
  e_E,H heating, e_E,WW hot water), separate table sets for existing buildings ("production d'eau chaude sanitaire
  pour les bâtiments existants"); manual ch. 3 "Calcul des installations" (3.3 auxiliary energy, 3.4 summary);
  LuxEeB applies a **simplified calculation for heating systems of existing buildings** and asks for the *year of
  construction of the heating installation*. The generator/distribution/emission option lists and their factors
  were **not retrieved** [UNK]. (A draft ministerial regulation on standardised energy savings has a table with
  e.g. district heating 1.01, pellet boiler 1.48 and An-dependent formulas for constant/low-temperature boilers -
  that is the savings-obligation scheme, not the CPE.)
- **Energy carriers, primary-energy and CO2 factors**: tables exist in the annex; not retrieved [UNK].
- **Renewables / PV**: not retrieved how PV is credited in the residential class [UNK].
- **Measured consumption** (existing buildings only) [OFF-x]: billing year + quantity in billing unit; the
  consumption record goes on page 4 of the certificate, modernisation recommendations on page 5; audits flag
  missing consumption data and implausible values.

---

## 6. Simplifications and defaults for EXISTING buildings

### 6.1 What officially exists [OFF-x]

1. **Annexe I ch. 5.7** - provisions for existing buildings: 5.7.1 simplified An (apartment buildings), simplified
   shading factors, indicative n50 values, 5.7.5 simplified final energy demand for heating, existing-building
   hot-water tables; a simplified U-value method (TOC entry 5.9.8).
2. **"U-Wert-Typologien für bestehende Gebäude"** - "Leitfaden zur Anwendung der U-Wert-Typologien bei der
   Energiepasserstellung für bestehende Gebäude", v1.1 of 12.11.2007, Ministère de l'Economie et du Commerce
   extérieur, authors Goblet Lavandier & Associés and Institut Wohnen und Umwelt (IWU).
   URL: guichet.public.lu/dam-assets/catalogue-pdf/urbanisme/experts-habitation/notes-informations/typologie-bat-hab-existants.pdf
   - opaque elements by element / construction type / "Baualtersklasse"; an age class may be chosen by the typical
     occurrence of the construction, "auch Baualtersklassen ..., die nicht dem Baujahr des Gebäudes entsprechen";
   - later insulation is "pauschal in Form der Dämmstärke erfasst", insulation taken with lambda = 0.04 W/(mK);
   - quoted row: "Dach - massive Konstruktion (insbes. Flachdächer) - 1984 bis 1994 | 0,40 | 0,33 | 0,29 | 0,25 |
     0,22 | 0,20 | 0,18 | 0,17 | 0,15";
   - other cells seen: massive external wall "bis 1918" 0.92 and "ab 1995" 0.40 (second column), timber wall
     "ab 1995" 0.40; timber rows have separate classes 1949-1957 and 1958-1968;
   - transparent elements: single glazing in wooden frame until 1968; double insulating glazing in aluminium frame
     without thermal break 1969-1983, with thermal break 1984-1994; PVC frame 1969-1994; wooden frame with insulating
     glazing / coupled / box windows until 1994; low-e glazing in improved PVC or aluminium frame from 1995; columns
     U and g (values not retrieved); glass share for solar gains flat 60 %.
3. A University of Luxembourg study (Merzkirch/Hoos et al., Bauphysik 2015, orbilu 10993/23050) measured wall
   U-values in old Luxembourg houses and found them **clearly below** the typology values (typology 1.7 for
   sandstone/limestone walls up to the 1950s, 1.4 for hollow concrete block from the 1960s). The defaults are
   conservative: a tool that offers "measured / calculated from layers" as an upgrade path gives better classes. [SEC]
4. Existing-building relaxation: max U may be multiplied by 1.25 when interior insulation is added later (not for
   roofs). [OFF-x]

### 6.2 Reconstructed typology table [RUN for the column logic, MEM for the base values]

`spikes/typology_check.py` -> `out/typology_check.txt`, `out/typology_reconstructed.json`

- Proven by arithmetic: the 9 quoted cells are exactly U(d) = 1/(1/U0 + d/0.04) for d = 0, 2, 4, ... 16 cm of added
  insulation (each cell has a unique integer-cm solution except the last two, and the regular 2 cm grid fits all 9).
  So the Luxembourg table = base U-value per age class x 9 insulation-thickness columns, and can be generated.
- The base values below are the German IWU / BMVBS-2009 "Datenaufnahme Wohngebäudebestand" table **from memory**.
  All 6 cells I could cross-check against Luxembourg excerpts match (roof massive 1984-94 = 0.40; wall massive
  <=1918 = 1.7 and 0.92 at 2 cm; wall massive 1958-68 = 1.4; wall massive >=1995 -> 0.40 at 2 cm; timber wall >=1995 = 0.40).
  6 of 64 cells is evidence, not proof.

| Element | Construction | <=1918 | 1919-48 | 1949-57 | 1958-68 | 1969-78 | 1979-83 | 1984-94 | >=1995 |
|---|---|---|---|---|---|---|---|---|---|
| Roof | massive (flat) | 2.1 | 2.1 | 2.1 | 2.1 | 0.6 | 0.5 | 0.4 | 0.3 |
| Roof | timber (pitched) | 2.6 | 1.4 | 1.4 | 1.4 | 0.8 | 0.5 | 0.4 | 0.3 |
| Top-floor ceiling | massive | 2.1 | 2.1 | 2.1 | 2.1 | 0.6 | 0.5 | 0.4 | 0.3 |
| Top-floor ceiling | timber joists | 1.0 | 0.8 | 0.8 | 0.8 | 0.6 | 0.4 | 0.3 | 0.3 |
| External wall | massive | 1.7 | 1.7 | 1.4 | 1.4 | 1.0 | 0.8 | 0.6 | 0.5 |
| External wall | timber | 2.0 | 2.0 | 1.4 | 1.4 | 0.6 | 0.5 | 0.4 | 0.4 |
| To ground / unheated cellar | massive | 1.2 | 1.2 | 1.5 | 1.0 | 1.0 | 0.8 | 0.6 | 0.6 |
| To ground / unheated cellar | timber joists | 1.0 | 0.8 | 0.8 | 0.8 | 0.6 | 0.6 | 0.4 | 0.4 |

Windows, German base [MEM], to compare with the Luxembourg categories above: wood single glazing U 5.0 / g 0.87;
wood double (insulating, coupled, box) 2.7 / 0.75; PVC insulating glazing 3.0 / 0.75; aluminium/steel insulating
glazing 4.3 / 0.75 (3.2 with thermal break); from 1995 low-e about 1.8-1.9 / 0.60.

**Do not ship any of 6.2 without checking it against the PDF** (it is a two-page table; transcription takes minutes).

### 6.3 Not retrieved [UNK]

Indicative n50 table for existing buildings; simplified An formula for apartment buildings; simplified shading
values; existing-building heating/hot-water factor tables; whether a simplified *geometry* survey (envelope
estimated from few inputs, as in the German "Kurzverfahren Energieprofil") is allowed for the CPE. Hint: luxeeb.lu
offers a separate `Setup_BuildingEnvelopeEstimator.exe`, and ingefo.de (Dr. Lichtmeß, original author of the tool)
describes a method that estimates the envelope "from few inputs" for the Luxembourg renovation simulator (found by
the sibling "luxeeb-tool" research). Whether that estimator's output is admissible for a CPE is unknown and matters
a lot for the product: if it is, the "no plan at all" path already has an official precedent.

---

## 7. Result indicators and classes

- The certificate shows **three independent classes** (FR terms official): "classe de performance énergétique"
  (specific total primary energy demand, kWh/m²a of An), "classe d'isolation thermique" (specific heating demand,
  kWh/m²a), "classe de performance environnementale" (CO2, kg/m²a). German pass wording: Energieeffizienzklasse /
  Wärmeschutzklasse / CO2- or Umweltklasse - exact German labels not confirmed. Scale **A+ ... I** in the 2021
  regulation (one excerpt of the draft still says "neuf classes", i.e. A-I). All values relate to An. [OFF-x]
- The thresholds are in Annexe I ch. 4.2 as **"Illustration 4 - Classes de performance énergétique, valeurs en
  [kWh/m²a]", "Illustration 5 - ... isolation thermique"** etc. - images, hence not text-searchable. [OFF-x]
- "For residential buildings there is a single type of EPC" (EPBD Concerted Action, status 2020): the residential
  class is read from fixed absolute thresholds; requirements for new buildings are expressed as heating-energy and
  primary-energy needs. CA-EED: "energy performance class A = NZEB for Luxembourg"; Klima-Agence speaks of "AAA";
  class A+ was added in 2021 for buildings beyond that. That the new-build limit is derived from a reference
  building since the 2016 amendment is [MEM]; the reference-building recipe for residential buildings was
  **not retrieved** [UNK].

Primary energy, RGD 2007 scale, kWh/(m²a) - from the ministry's national nZEB plan [OFF-x]:

| | A | B | C | D | E | F | G | H | I |
|---|---|---|---|---|---|---|---|---|---|
| Single-family (EFH) | <=45 | <=95 | <=125 | <=145 | <=210 | <=295 | <=395 | <=530 | >530 |
| Apartment building (MFH) | <=45 | <=75 | <=85 | <=100 | <=155 | <=225 | <=280 | <=355 | >355 |

Heating demand (thermal-insulation class), RGD 2007 scale [MEM, partly corroborated: A = 22 / 14 by the CA-EED
table excerpt, D(EFH) = 86 by the nZEB plan's "Höchstwert 86 kWh/(m²a)"]:
EFH 22 / 43 / 69 / 86 / 130 / 170 / 230 / 295; MFH 14 / 27 / 43 / 54 / 85 / 115 / 150 / 185.

Current scale (RGD 2021), single-family, primary energy - **only from renov.lu** [SEC]: A <= 41, B <= 90, C <= 123,
D <= 142, E <= 208, F <= 295, G <= 395, H <= 530, I > 530, and "A+ <= 22" (suspicious: 22 is the class-A heating
limit; verify). certinergie.lu publishes yet another scale (45/75/110/150/210/285/375/480) without saying what it
applies to; renov.lu calls such tables obsolete. CO2 thresholds: not retrieved [UNK].
=> The class tables must be typed in from the Mémorial PDF; do not trust any website.

---

## 8. Who may issue a CPE, and what the expert stays responsible for [OFF-x unless noted]

- Residential CPEs are established by (a) **architects or consulting engineers who are members of the OAI** (no
  prior approval needed) or (b) **experts approved by the minister** ("experts agréés", numbers `LUXEEB.R.xxxxx`).
  The client chooses the expert. A directory site counts 480 authorised professionals (320 OAI architects, 95 OAI
  consulting engineers, 59 approved experts, 6 OAI engineers) [SEC].
- Approval conditions (guichet form): diplomas, >= 5 years professional experience, >= 200 h of relevant courses
  with exams (or an adapted course record), independence from the commissioned work, professional liability
  insurance (contractual and extra-contractual) of at least 1 240 000 EUR, renewal with proof of insurance;
  validity reported as 5 years (one excerpt says yearly renewal - check). The ministry's LuxEeB training for
  residential buildings is optional. The LuxEeB licence is personal and prints the expert number on every CPE
  (from the sibling "luxeeb-tool" research notes).
- "Dans le cas d'un bâtiment existant, un expert agréé doit également faire une visite du bâtiment."
- The minister selects a statistically significant share of certificates each year and verifies "la validité des
  données d'entrée du bâtiment employées pour établir le certificat", the results and the recommendations.
- Audit recap, typical findings: An from gross dimensions; rooms counted that should not be; wrong encoding of
  envelope surfaces; inconsistent heating / hot-water entries; missing consumption data; implausible values.
- OAI model contract (2014): the architect/engineer bears the professional liability imposed by law, not the
  faults of others, and the mission ends with the certificate.
- Sanctions / withdrawal of approval for wrong certificates: not retrieved [UNK].

Consequences for the product: (1) every pre-filled value needs a visible provenance ("measured on plan p.3",
"typology default 1969-78", "typed by expert") and an explicit confirmation; (2) defaults must be the official
ones, version-tagged; (3) keep an exportable audit trail - it is exactly what the ministry audit asks for;
(4) the tool can save the expert the plan take-off, it cannot replace the site visit for existing buildings;
(5) never present the output as a CPE - LuxEeB-Tool (or Lesosai) with the expert's licence issues it.

---

## 9. Spikes (all run in this sandbox, Python 3.13 stdlib only)

```
cd <this dir>
python3 spikes/typology_check.py out/typology_reconstructed.json   # -> out/typology_check.txt
python3 spikes/sensitivity.py   out/sensitivity.json               # -> out/sensitivity.txt
python3 spikes/an_rules.py                                         # -> out/an_rules.txt
```

### 9.1 typology_check.py - see 6.2.

### 9.2 sensitivity.py - which inputs deserve a question? [RUN]

Stand-in model = German EnEV-2002 simplified heating-period balance (Qh = 66(HT+HV) - 0.95(Qs+Qi)), NOT the
Luxembourg monthly method; a 10 x 9 m detached house, 2 storeys, unheated attic and cellar, typology defaults.
Absolute numbers are indicative only, the ranking is the result. One-at-a-time errors:

| Mistake | kind | 1970s house (192.8 kWh/m²a, class G) | post-1995 house (122.4, class E) |
|---|---|---|---|
| unnoticed retrofit: +8 cm wall insulation | default | -28.6 % (class changes) | -16.9 % |
| An from gross dimensions (+18 %) | geometry | -16.9 % (class changes) | -17.9 % |
| wall U one age class older / newer | default | +17.2 % / -8.6 % | +6.8 % (class changes) / -6.8 % |
| a 9 m gable is really a heated neighbour | boundary | -13.2 % (class changes) | -11.3 % |
| attic treated as heated (ceiling dropped) | boundary | -10.3 % | -8.1 % |
| air change 0.7 -> 1.0 1/h | default | +9.8 % | +15.4 % (class changes) |
| cellar ceiling treated as outside air | boundary | +8.6 % | +8.1 % (class changes) |
| windows replaced, not noticed | default | -8.3 % | -5.6 % |
| storey height +10 % | geometry | +7.8 % | +8.4 % (class changes) |
| +12 cm top-ceiling insulation not noticed | default | -6.6 % | -3.8 % |
| An -5 % (one room wrongly excluded) | geometry | +5.8 % | +6.2 % |
| thermal bridges 0.10 -> 0.05 / 0.15 | default | -/+4.7 % | -/+7.4 % (class changes at 0.15) |
| footprint scale error +5 % per side | geometry | -3.5 % | -3.2 % |
| window g -20 % | default | +1.7 % | +2.1 % |
| north arrow wrong by 180° / 90° | geometry | +1.5 % / +1.0 % | +1.9 % / +1.3 % |
| window area +-20 % | geometry | +-0.8 % | +-0.8 % |

Reading: (a) the questions worth asking are about **insulation state, heated/unheated zones, neighbours and An**,
not about window details; (b) a uniform scale error of the plan almost cancels out (areas and An move together),
whereas mixing gross and net does not; (c) class limits are wide for old houses, so most single errors keep the
class, but two errors in the same direction will not. Limits of the spike: no system side (primary energy), no
utilisation factor, so it must not be extrapolated to class A/B new buildings, where windows, orientation,
shading, n50 and heat recovery dominate.

### 9.3 an_rules.py - An as a rule engine over a room schedule [RUN]

Implements the rules of section 3 on a toy house (16 rooms). Results: automatic An = 125.7 m²; only 2 rooms
(cellar, laundry) need a question; before the answers An is bracketed to 125.7 .. 147.7 m² (+18 %); summing every
room would be +59 %. An attic bedroom 4.5 x 4.0 m under a 40° roof with a 0.6 m knee wall keeps 89 % of its floor
area under the 1.0 m rule (16.09 of 18.00 m²) - `area_above_height()`.
Two bugs found by running the FR/DE label classifier, worth remembering: "Waschküche" matched "küche" and
"Chambre 1 (combles)" matched "combles" -> rule order / word boundaries matter; test with a real label corpus.

---

## 10. Master table: input field -> from plans? -> default? -> ask?

"IFC" assumes an architect's model with IfcSpace and IfcWindow objects; "DWG" a 2D plan set with layers and room
texts; "PDF" a vector PDF (raster scans are one level worse everywhere). Auto = computable without the user;
semi = computed, user confirms on screen; no = not on the document.

| # | Input field (LuxEeB side) | IFC | DWG/DXF | PDF | Sensible default | Ask the user? |
|---|---|---|---|---|---|---|
| 1 | Address, cadastre, owner, object name | semi (IfcSite/IfcBuilding, often empty) | semi (title block text) | semi (title block) | - | confirm once |
| 2 | Building category (single-family / apartment), number of dwellings | semi | semi | semi | from number of kitchens / entrance doors | 1 click |
| 3 | New build / existing; year of construction; year of major renovations | no | no (date of the drawing is a hint) | no | - | **yes** (drives all defaults) |
| 4 | Room list with net areas | **auto** (IfcSpace NetFloorArea, names) | semi (closed room outlines + labels; often only printed m² texts) | semi (room stamps "Séjour 32,40 m²" via text extraction) | - | confirm |
| 5 | Which rooms are conditioned / inside the envelope | semi (space names; IsExternal unreliable) | semi (labels) | semi (labels) | rule engine by room label (spike 9.3) | **yes, only for ambiguous rooms** (cellar, laundry, hobby, attic, stairs to basement) |
| 6 | An (net, height > 1.0 m rule) | auto from 4+5 with 3D heights | semi; attic rule needs knee-wall height + roof pitch | semi | - | attic: 2 numbers if no section |
| 7 | Clear room heights -> Vn | auto | no in plan view; from sections (semi) or dimension texts | same | one height per storey | 1 number per storey |
| 8 | Outer footprint per storey | auto | **auto/semi** (outer contour of the wall layer) | semi | - | confirm outline |
| 9 | Gross storey heights, roof shape/pitch -> Ve, roof areas | auto | semi (sections/elevations) | semi | flat ceiling under unheated attic | pick roof type + pitch |
| 10 | Envelope area A by element (walls per facade, roof, top ceiling, floor) | auto (if the model is clean) | semi (8+9) | semi | - | review in a 3D/unfolded view |
| 11 | Boundary type of each element (outside / ground / unheated room / heated neighbour) -> Fϑ | semi (space boundaries rarely exported well) | semi (basement level, neighbour hatch) | semi | detached, unheated cellar and attic outside the envelope | **yes**: "paint" the envelope: neighbours? cellar heated? attic heated? |
| 12 | Orientation of facades (8 sectors) | semi (TrueNorth often missing or wrong) | no (north arrow is just a drawing) | no | - | **yes**: one compass gesture, or address + site plan |
| 13 | Inclination | auto | semi | semi | 90° walls, 0° flat roof | with roof type |
| 14 | Windows/doors: count, rough-opening size, host facade | auto (IfcWindow OverallWidth/Height, host wall; frame size vs rough opening differs by a few cm) | semi (blocks; width from plan, height from "width/height" annotations or elevations) | semi (symbol recognition, weakest link) | - | review list per facade |
| 15 | U-values of opaque elements - new build | semi (IfcMaterialLayerSet thicknesses; lambda almost never) | no (thickness measurable, layers from legend text) | no | - | **yes**: pick build-ups from a catalogue / import U-value sheet |
| 16 | U-values of opaque elements - existing | no | no | no | **official typology by age class + construction** | **yes**: 1 question per element group: "insulated later? how many cm?" |
| 17 | Window Uw, g, frame share | semi (Pset_WindowCommon ThermalTransmittance, rarely filled) | no | no | existing: typology by frame/glazing/period, 60 % glass; new: product data | 1 question: glazing/frame generation |
| 18 | Shading factors | semi (overhangs, balconies from geometry) | semi | no | simplified/default factor (allowed for existing) | optional |
| 19 | Solar protection (shutters, blinds) | no | no | no | none | optional |
| 20 | Thermal bridges ΔU_WB | no | no | no | **0.10 W/m²K flat** | only if the expert has a proof for a better value |
| 21 | Air-tightness n50 | no | no | no | indicative table (existing) / planned limit (new) | "blower-door report?" yes -> value |
| 22 | Ventilation system, heat-recovery efficiency | semi (MEP model only) | no (unless HVAC plans) | no | window ventilation (existing) | **yes** (1 choice) |
| 23 | Heating: generator type, energy carrier, year, inside/outside envelope, distribution, emitters | no | no (symbols at best) | no | - | **yes** (3-4 choices; photo of the boiler plate helps) |
| 24 | Hot water: with heating / separate, storage, circulation, solar thermal | no | no | no | combined with heating | **yes** (1-2 choices) |
| 25 | Auxiliary energy | no | no | no | computed by LuxEeB from system type | no |
| 26 | Renewables: PV (kWp/area, orientation, tilt), solar thermal area | semi | semi (roof plan) | semi | none | yes if present |
| 27 | Measured consumption (existing): year, quantity, unit, carrier | no | no | no | - | **yes** (upload bills) |
| 28 | Modernisation recommendations (existing, page 5) | no | no | no | suggestions from the weakest elements | expert writes/validates |

Minimal wizard for an existing single-family house, derived from the table (about a dozen interactions):
year built -> drop the plans -> confirm outline + storeys -> compass -> click neighbours / heated cellar / heated
attic -> confirm the 2-4 ambiguous rooms -> roof type and pitch -> "insulated later?" for wall / roof / cellar
ceiling -> window generation -> heating (carrier, type, year) -> hot water -> ventilation -> upload bills.
Everything else is a default the expert can open and override.

---

## 11. Glossary FR / DE (as used in the official texts where confirmed)

| FR | DE | Note |
|---|---|---|
| certificat de performance énergétique (CPE), passeport énergétique | Energiepass, Ausweis über die Gesamtenergieeffizienz | [OFF-x] |
| calcul de performance énergétique | Berechnung der Gesamtenergieeffizienz | the permit-stage document [OFF-x] |
| bâtiment d'habitation / fonctionnel | Wohngebäude / Zweckbau (Nichtwohngebäude) | [OFF-x] |
| surface de référence énergétique An | Energiebezugsfläche An | [OFF-x] |
| surface de plancher nette | Nettogrundfläche | [OFF-x] |
| enveloppe thermique; surface de l'enveloppe thermique A | thermische Hülle; Gebäudehüllfläche A | [OFF-x] |
| volume bâti chauffé brut Ve | beheiztes (Brutto-)Gebäudevolumen Ve | DE wording not confirmed |
| facteur de correction de la température Fϑ,i | Temperaturkorrekturfaktor | DE wording [MEM] |
| ponts thermiques, facteur de correction ΔU_WB | Wärmebrücken(zuschlag) | DE wording [MEM] |
| étanchéité à l'air n50 | Luftdichtheit n50 | [OFF-x] |
| facteur de dépense | Aufwandszahl | DE wording [MEM] |
| besoin en chaleur de chauffage / besoin en énergie primaire | Heizwärmebedarf / Primärenergiebedarf | [OFF-x] |
| classe d'isolation thermique | Wärmeschutzklasse | [OFF-x]/[SEC] |
| classe de performance énergétique | (Gesamt-)Energieeffizienzklasse | [OFF-x]/[SEC] |
| bâtiment existant; classe d'âge | bestehendes Gebäude; Baualtersklasse | [OFF-x] |
| épaisseur d'isolation | Dämmstärke | [OFF-x] |
| expert agréé | zugelassener Experte | [OFF-x] |

---

## 12. Not confirmed from an official source - checklist for a follow-up with open network

1. Full text of Annexe I ch. 5.1 (room table, stairs, storey-height / external-dimension conventions).
2. Temperature-correction tables (values), ground-contact table.
3. Exact conditions of the thermal-bridge options (0.10 / 0.05 / 0.03 / 0.15).
4. Orientation/inclination radiation tables, default shading factors, frame-share rules for new windows.
5. n50: limit table for new buildings (conflicting excerpts) and the indicative table for existing buildings.
6. Ventilation and heating / hot-water option lists with their factor tables; existing-building simplifications.
7. Ch. 5.7 in full (simplified An for apartment buildings, simplified shading, 5.7.5).
8. Typology note: full tables (opaque + windows) to replace my reconstruction in 6.2.
9. Class thresholds of ch. 4.2 for the 2021 regulation (three indicators, EFH and MFH, A+).
10. Primary-energy and CO2 factors; how PV is credited.
11. Reference-building definition for new residential buildings.
12. Sanctions and correction procedure for wrong certificates; whether a plan-only survey is acceptable for OAI
    members on existing buildings (the "must visit" sentence names approved experts).
13. Whether BuildingEnvelopeEstimator results are admissible in a CPE.
14. Differences 2007 text vs 2021 text beyond what section 2 lists.

URLs to open (all returned by the search engine, none fetched):

- https://data.legilux.public.lu/filestore/eli/etat/leg/rgd/2021/06/09/a439/jo/fr/html/eli-etat-leg-rgd-2021-06-09-a439-jo-fr-html.html
- https://legilux.public.lu/eli/etat/leg/rgd/2021/06/09/a439/consolide/20220709
- https://www.cc.lu/fileadmin/user_upload/tx_ccavis/5586_PRGD_Performance_energetique_des_batiments_-_Annexe_I_PRGD_5586MLE.pdf (draft Annexe I, text PDF)
- https://www.certinergie.lu/wp-content/uploads/2023/02/reglement-grand-ducal-concernant-la-performance-energetique-des-batiments-dhabitation.pdf (annex copy)
- https://guichet.public.lu/dam-assets/catalogue-pdf/urbanisme/experts-habitation/legislation/annexe-rgd-fr.pdf (consolidated 2007 annex)
- https://guichet.public.lu/dam-assets/catalogue-pdf/urbanisme/experts-habitation/notes-informations/typologie-bat-hab-existants.pdf
- https://guichet.public.lu/dam-assets/catalogue-pdf/urbanisme/experts-habitation/faq/controle-cpe-recapitulatif.pdf
- https://guichet.public.lu/dam-assets/catalogue-pdf/urbanisme/experts-habitation/faq/faq-rgd-30-11-2007.pdf
- https://meco.gouvernement.lu/dam-assets/le-ministere/fonctions/energie/efficacite-energetique/FAQ-RGD-2021-Batiments-d-habitation.pdf
- https://meco.gouvernement.lu/dam-assets/le-ministere/fonctions/energie/efficacite-energetique/manuel.pdf and .../handbuch.pdf
- https://guichet.public.lu/dam-assets/catalogue-pdf/logement/performances-energie/demande-passeport-energetique-fr/specimen-calcul-performance-habitation-neufs-et-extensions-sup80m2.pdf (specimen calculation = the complete field list)
- https://www.mycon.lu/wp-content/uploads/2019/10/LuxEeB-Tool-Mustermann-Pass-A-A.pdf (sample pass printed by LuxEeB-Tool)
- https://www.oai.lu/files/Collaboration_entre_membres_OAI/2025/FC04_Calcul_surfaces_volumes-250124.pdf (OAI area/volume conventions)
- https://meco.gouvernement.lu/dam-assets/publications/rapport-etude-analyse/minist-economie/domaine-energie/nationaler-plan-Luxembourg/nationaler-plan.pdf (class table 2007)
- https://cdn1.gopublic.dk/epbd/Media/638373598207645919/Implementation-of-the-EPBD-in-Luxembourg--Status-in-2020.pdf
- https://www.ca-eed.eu/ia-document/energy-performance-of-buildings-regulation-luxembourg/
- https://orbilu.uni.lu/bitstream/10993/23050/1/Paper%20U-Werte.pdf
- https://www.iwu.de/forschung/gebaeudebestand/energieeinsparverordnung-luxemburg/
- https://docplayer.org/20324029-Neue-energieeinsparverordnung-in-luxemburg-luxeeb-chaux-de-contern-09-mai-2008.html (Lichtmeß slides 2008)
- https://guichet.public.lu/fr/entreprises/urbanisme-environnement/energie/audits-performances-energetiques/agrement-expert-cpe.html
- https://guichet.public.lu/fr/citoyens/logement/construction-renovation-transformation/certificats-energiepass/demande-passeport-energetique.html
- https://renov.lu/en/energy-performance-certificate/ (secondary; 2021 class limits)

Hosts that would have to be allowed: legilux.public.lu, data.legilux.public.lu, guichet.public.lu,
meco.gouvernement.lu, www.cc.lu, wdocs-pub.chd.lu, www.certinergie.lu, www.oai.lu, orbilu.uni.lu, cdn1.gopublic.dk.

---

## 13. Files in this directory

- `NOTES.md` - this file
- `spikes/typology_check.py`, `out/typology_check.txt`, `out/typology_reconstructed.json`
- `spikes/sensitivity.py`, `out/sensitivity.txt`, `out/sensitivity.json`
- `spikes/an_rules.py`, `out/an_rules.txt`
- `gh/search1.txt` - GitHub code-search result (no mirrors)
