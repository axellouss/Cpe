# Lecture automatique d'une planche d'autorisation

Ce document explique comment Plan2CPE lit une planche PDF et en tire le projet, puis les questions de doute. Il
s'adresse à qui veut comprendre, vérifier ou faire évoluer le code. Le [README](../README.md) dit ce que l'outil fait
du point de vue de l'utilisateur.

## Principes

- **Signaux par la structure du dessin**, jamais par une couleur ou une coordonnée d'une planche précise : « texte
  nettement plus gros que le corps courant », « bande mince à hachure croisée », « deux nombres superposés sur une
  chaîne de cotes ». Une couleur peut être *apprise* sur la page (vote des remplissages sous les zones d'isolant),
  jamais codée.
- **Chaque règle a un repli.** Quand un morceau ne donne rien, la feuille garde la lecture de l'ancien chemin
  (murs par épaisseur de trait, faces fermées) ; quand un morceau lève une erreur, il est noté au journal et laissé
  de côté.
- **Chaque résultat porte une confiance et une preuve** (page, endroit, signal). Les paliers sont ceux de
  [`src/core/reading.ts`](../src/core/reading.ts) :

  | Confiance | Lecture |
  | --- | --- |
  | ≥ 0,85 | lu et recoupé par deux signaux indépendants : pas de question |
  | ≥ 0,65 | lu, une seule source : pas de question si l'effet est faible |
  | < 0,65 | à confirmer : question |
  | 0 | hypothèse de l'outil (rien sur la planche) : toujours montrée comme telle |

- **Aucune valeur réglementaire inventée.** Les λ, Ug, Uf, Ψg proposés sont des valeurs d'usage relevées dans un
  CPE réel, toujours marquées hypothèses ; un matériau sans valeur d'usage reste vide.
- **Analyse pure.** Seuls `extract.ts`, `render.ts` et `init-*.ts` touchent pdf.js ou le DOM. Tout le reste reçoit
  la page brute ([`src/readers/pdf/raw.ts`](../src/readers/pdf/raw.ts)) et se teste sans navigateur.

## Les étapes

### 1. Extraction et allègement — `src/readers/pdf/extract.ts`, `hatch.ts`

pdf.js donne les textes (position, corps, sens de lecture) et les tracés. L'extraction suit les zones de découpe
(clip), les couleurs, l'opacité, et rend les remplissages. Une planche Archicad porte des centaines de milliers de
traits : pointillés de terrain dans les coupes, hachures des murs, de l'isolant, du carrelage. `hatch.ts` reconnaît
ces trames (sous-tracés minuscules, découpe commune, traits parallèles à pas régulier, épaisseur et couleur
homogènes), les retire de la liste des traits et n'en garde qu'un résumé (zone, directions, pas, couleur). Sur la
planche réelle d'essai, la page passe ainsi de 400 000 traits tronqués au plafond à environ 71 000 traits lus en
entier. Ce qui ne passe pas tous les critères reste un trait ordinaire.

### 2. Découpage en vues — `sheetviews.ts`, `titleblock.ts`

1. Corps courant = médiane des corps des textes horizontaux.
2. Titres = textes au moins 1,6 fois plus gros, ou 1,15 fois s'ils portent le vocabulaire des vues (français,
   allemand), recollés avec leurs morceaux (« PLAN 1 » + « ER » en exposant + « ÉTAGE »).
3. Blocs de contenu = zones de découpe chargées de dessin, images, paquets d'encre (dessin et cotes), paquets de
   texte, cartouche.
4. Association titre ↔ bloc (dessous, dessus, à côté, dedans), la convention majoritaire de la page l'emportant.
5. Genre de la vue d'après le titre et d'après le contenu : 0,9 s'ils s'accordent, 0,7 sur le titre seul, 0,5 sur le
   contenu seul, 0,4 s'ils se contredisent.

Un trait peint sous une découpe mais hors de sa boîte est invisible (le cadre de situation répété sous chaque plan) :
il n'est compté nulle part. Le cartouche se reconnaît à son vocabulaire et à sa place dans un angle du cadre ; il
s'étend aux traits de son cadre. Une page sans aucun titre se découpe d'après le contenu seul.

### 3. Emprise du bâtiment dans sa vue — `building.ts`

Un plan d'autorisation montre aussi la parcelle, la rue, les voisins. L'emprise part des zones de pièces (aplats
clairs avec un nom et une surface), s'étend aux murs de proche en proche, se reporte d'une vue à l'autre par le
cadre de situation répété, et se recoupe par les cotes hors tout. Largeur et profondeur sont retenues quand deux
sources concordent à 5 cm près ; sinon la confiance est basse et un doute est posé.

### 4. Textes — `textlines.ts`, `sheettext.ts`, `src/semantics/`

`textlines.ts` rattache les exposants (« m² », le « ⁵ » du demi-centimètre, « ER »), recolle les morceaux de ligne et
lit les paires de cotes de baies (largeur au-dessus, hauteur dessous, allège « ALL. »). `sheettext.ts` lit en une
fois, sur toutes les pages : cartouche, tableau des surfaces (`siteareas.ts`), niveaux (`levels.ts` : niveau fini,
altitude, acrotère, faîtage, égout ; recoupement « relatif + référence = altitude »), compositions
(`compositions.ts` : couches de l'intérieur vers l'extérieur, matériau, épaisseur, couches hors calcul comme le film
ou le béton de propreté, rôle de la paroi), équipements (`equipment.ts`), flèche du nord (`north.ts` : texte « N »,
cercle ajusté, forme pleine décentrée), encadrés d'éclairement, pièces par vue (`labels.ts`).

### 5. Géométrie de chaque plan d'étage — `geometry/`

- **Matières des murs** (`materials.ts`) : hachure simple → maçonnerie, hachure croisée → isolant ; repli : poché
  sombre en bandes minces → maçonnerie, et la hachure simple devient l'isolant. Seules les formes de 0,8 m
  d'épaisseur au plus comptent comme murs. Une maçonnerie atteinte seulement à travers un isolant est celle du
  voisin (mur mitoyen).
- **Pièces et échelle** (`rooms.ts`) : chaque étiquette (nom + surface) est appariée aux remplissages qui la
  contiennent ; chaque candidat donne une échelle √(surface écrite / aire dessinée), et l'échelle de la vue est le
  mode de ces valeurs à ±2 %. Repli sans remplissage : faces fermées par les murs et par des « ponts de portes ».
- **Emprise** (`footprint.ts`) : union des murs du bâtiment et des pièces, trous remplis, coupée sur la face du mur
  mitoyen, recoupée par les cotes hors tout.
- **Enveloppe** (`envelope.ts`, `grid.ts`) : croissance simultanée des zones chauffée et non chauffée sur une trame
  de 2 cm, l'isolant faisant barrière, les portes dans l'isolant pontées. Un local est une graine non chauffée si son
  nom le dit (garage, cave…) ; un local ainsi nommé que l'isolant ne sépare pas reste chauffé, avec une question.
  Puis la nature de chaque arête (façade, vers le non chauffé, mitoyenne) et les surfaces sans étiquette, classées
  par leur dessin : escalier (au moins cinq marches parallèles au pas de 0,15 à 0,40 m), trémie, passage.
- **Baies** (`bays.ts`) : trous de la maçonnerie et de l'isolant, tableaux, cote écrite en face, symbole dans le trou
  (vitrage, vantail, arc d'ouverture), pièce derrière (local non chauffé → porte de garage, hall → porte d'entrée).
  La largeur retenue est la cote écrite recoupée à 7 cm près ; sans cote, les tableaux et le trou d'isolant.

**Garde-fou.** La géométrie remplace la détection de l'ancien chemin seulement si elle donne un contour, une échelle
recoupée (≥ 0,85) d'accord avec celle de la feuille, des murs reconnus par leur matière, au moins autant de pièces
mesurées et au moins 75 % des baies (`geometryIsBetter` dans `integrate.ts`). Sinon la feuille garde l'ancienne
lecture : c'est ce qui protège les PDF d'essai plus anciens.

### 6. Bâtiment — `geometry/roof.ts`, `geometry/elevation.ts`, `clearheights.ts`

- **Toiture** : anneau extérieur du remplissage de toiture ; plate si un acrotère est dessiné (bande parallèle au
  bord, 0,1 à 0,8 m) ou si la pente écrite est de 5 % au plus.
- **Façades** : baies reconnues comme rectangles emboîtés (cadre, vitrage), sans supposer de couleur ; rattachement
  au côté du plan en comparant la position des baies, recoupé par le nord (façade nommée par son orientation) ou par
  le côté de l'entrée (façade « avant »).
- **Hauteurs de baies** : la cote du plan est confirmée par la façade à 5 cm près ; au-delà, les deux valeurs sont
  gardées et le moteur pose la question de convention.
- **Calage des plans** d'étage dans un repère commun, **plancher au-dessus d'un local non chauffé** (garage sous une
  chambre) ou de l'extérieur.
- **Hauteurs libres** : une cote de coupe posée entre deux niveaux finis, plus petite de 5 à 90 cm que la hauteur
  d'étage, ou la mention « HSP ». Lue deux fois : 0,85 ; une fois : 0,65 ; deux valeurs différentes : 0,5.

### 7. Recoupements — `integrate.ts`

Local technique ou buanderie dans l'isolant → chauffé ; surface vitrée écrite dans un encadré d'éclairement comparée
aux baies le long de la pièce ; emprise comparée au tableau des surfaces (confiance relevée sous 3 % d'écart, doute
au-delà) ; nord lu sur la flèche avec sa marge à la limite de secteur. Chaque désaccord devient un doute porté par la
donnée.

### 8. Projet automatique — `src/engine/auto.ts`

`buildAutoProject` construit les étages chauffés (du bas vers le haut), leurs contours et arêtes, pièces, baies,
hauteurs (convention extérieure par défaut, repli de niveau fini à niveau fini), toiture, plancher bas, nord, parois à
couches (`materials.ts`, U pré-calculé par `uvalue.ts`), types de fenêtres, identité et installations proposées.
Rien de ce qu'il met dans le projet ne porte la provenance « vous » ; une valeur déjà confirmée par l'utilisateur
n'est jamais écrasée par une nouvelle lecture.

Le parcours automatique est retenu (`sufficient`) s'il y a au moins un plan d'étage lu avec son contour et une échelle
sûre, une toiture et un plancher bas proposés, et au plus huit questions sur le plan (`MAX_AUTO_DOUBTS`). Sinon, la
première raison est montrée à l'utilisateur et le parcours guidé reprend la main.

### 9. Questions de doute — `src/engine/doubts.ts`, `doubtAnswer.ts`

Chaque donnée reçoit des signaux de groupes indépendants (texte, géométrie, coupe, façades, cartouche, IFC,
bibliothèque du bureau, hypothèse). Confiance = 1 − Π(1 − w), un signal par groupe, w = 0,7 (fort), 0,4 (faible),
0 (hypothèse) ; plafonnée à 0,4 si un signal fort la contredit, 0,6 si c'est un signal faible. Une question est
posée sous 0,85, 0,65 ou 0,35 selon l'impact de la donnée. Le catalogue (`DOUBT_CATALOG`) compte 21 questions ;
celles qui portent sur ce qu'aucun plan ne donne (matériaux, menuiseries, ventilation, chauffage, ponts thermiques,
solaire) ne comptent pas dans le plafond du parcours. « Je ne sais pas » garde la proposition, étiquetée hypothèse.

### 10. Dossier — `src/export/dossier.ts`

Une section par feuille de LuxEeB-Tool 6.25 (`SHEETS_625` dans `src/core/cpe.ts`), colonnes aux intitulés de l'outil,
chaque valeur avec sa provenance, sa confiance et sa source ; puis les pré-contrôles du « Plausibilitätscheck », les
hypothèses à confirmer (réponses proposées sous 0,65 et valeurs d'usage) et les questions déjà tranchées.

## Essais

- **Planches synthétiques** du dépôt : [`tests/fixtures/pdf/planche/`](../tests/fixtures/pdf/planche/LISEZMOI.txt).
  `tests/readers/pdf/planche-lecture.test.ts` les lit de bout en bout et compare chaque résultat à la vérité :
  pièces à 1 %, emprise et contour chauffé à 2 %, arêtes mitoyennes et vers le non chauffé à 5 %, baies à 3 cm, nord
  à 3°. `tests/engine/auto*.test.ts` vérifient le projet automatique et chaque réponse du catalogue ;
  `tests/ui/shell/autoflow-planches.test.tsx` fait tout le parcours dans l'interface.
- **Planche réelle** : une seule, privée, jamais copiée dans le dépôt ; les essais se font hors dépôt. Les écarts
  mesurés sont résumés dans le README, en pourcentages.

## Ce qui reste fragile

- Les seuils viennent d'une planche réelle (export Archicad) et de quatre planches synthétiques. Une autre chaîne
  d'export peut mettre en défaut l'opacité d'un voile, le contraste vitre / cadre, l'écart des exposants, la portée
  d'un vantail.
- Le garde-fou `geometryIsBetter` est tout ou rien : une géométrie meilleure sur un point et moins bonne sur un autre
  garde l'ancienne lecture en entier.
- Une cote de baie est rattachée au plan le plus proche (à 4 m) : deux plans très proches sur la page pourraient se
  voler une chaîne de cotes.
- Un local séparé par l'isolant mais sans nom de local non chauffé reste compté chauffé, sans question.
- La règle « maison isolée » demande au moins trois côtés, chacun avec une baie ou un isolant : un pignon aveugle
  sans isolant extérieur dessiné laisse la question de mitoyenneté.
- Durée : de 3 à 4 secondes pour une planche A1 chargée, dont environ la moitié pour l'extraction pdf.js.
