# Plan2CPE

Plan2CPE lit une planche d'autorisation de bâtir et prépare tout ce qu'il faut saisir dans **LuxEeB-Tool**, l'outil
officiel luxembourgeois de calcul du certificat de performance énergétique (CPE) des bâtiments d'habitation.

On dépose la planche. Le logiciel y reconnaît les plans, les coupes, les façades, le tableau des surfaces et le
cartouche, construit le bâtiment tout seul, puis ne pose que les questions où il a un doute. Il rend un dossier
rangé dans l'ordre des feuilles de LuxEeB-Tool 6.25, avec les intitulés de l'outil. Chaque valeur dit d'où elle
vient : lue et recoupée, lue, hypothèse, manquante, ou saisie par vous.

Tout se passe dans le navigateur : aucun fichier ne quitte l'ordinateur, il n'y a ni serveur ni compte.

Seuls les architectes et ingénieurs membres de l'OAI et les experts agréés peuvent établir un CPE. Plan2CPE prépare
la saisie et fait gagner le temps du métré et de la mise en forme. Il ne remplace ni le contrôle de l'expert ni la
visite du bâtiment.

## Ce que fait le logiciel

**Il lit la planche entière, même quand une seule page porte plusieurs vues.** Une planche d'autorisation réunit
souvent sur une page les plans de chaque niveau, le plan de toiture, des coupes, des façades, le tableau des surfaces,
une photo, la flèche du nord et le cartouche. Le logiciel découpe la page en vues d'après leurs titres (« PLAN
REZ-DE-CHAUSSÉE », « COUPE AA », « FAÇADE AVANT », « GRUNDRISS ERDGESCHOSS », « ANSICHT SÜD »…) et d'après leur
contenu (surfaces de pièces, cotes de niveau, grille d'un tableau). Une planche sur plusieurs pages se lit de la même
façon. Les titres en français et en allemand sont reconnus.

Sur chaque plan d'étage, il lit :

- **les pièces** et leur surface écrite (« S: 48,73 m² », « 21,95 m² »), comparée à la surface mesurée entre les
  murs ;
- **l'emprise** du bâtiment, recoupée par les cotes hors tout et par le tableau des surfaces ;
- **le contour chauffé** : un garage ou une cave que l'isolant dessiné sépare du logement est retiré du volume
  chauffé, et le mur qui les sépare devient un mur « vers un local non chauffé » ; un mur mitoyen est reconnu ;
- **les baies** avec leurs cotes : largeur et hauteur écrites l'une sous l'autre, allège (« ALL. 0,90 »), cotes au
  demi-centimètre (« 78⁵ »). La porte d'entrée, la porte de garage et la porte vers un local non chauffé sont
  distinguées des fenêtres ;
- **les surfaces sans étiquette** (escalier, dégagement) : elles sont mesurées mais jamais comptées sans votre
  accord.

Sur le reste de la planche, il lit :

- **les niveaux et les hauteurs** : cotes de niveau (« +0,20=+312,45 », « NF », acrotère, faîtage, égout) en plan et
  en coupe, et hauteurs libres cotées dans une coupe ou écrites (« HSP 2,45 ») ;
- **la toiture** : plate (acrotère dessiné, « pente 2 % ») ou inclinée, et ses dimensions sur le plan de toiture ;
- **les façades dessinées** : leurs baies, et le côté du plan qu'elles montrent. Elles confirment les hauteurs de
  baies lues sur les plans, ou les donnent quand le plan n'en écrit pas ;
- **les compositions de parois** annotées (« Composition mur : 24cm Béton / 18cm Isolation type EPS / 2cm Enduit de
  façade », « Wandaufbau », « Dachaufbau »…) : couches, épaisseurs, rôle de la paroi (mur extérieur, dalle sur sol,
  plancher au-dessus du garage, toiture) ;
- **les équipements écrits** (« PAC », « Boiler », « VMC », « Wärmepumpe »…), dont il tire une proposition de
  chauffage, d'eau chaude et de ventilation, toujours à confirmer ;
- **le nord**, sur la flèche dessinée ;
- **l'identité du projet** dans le cartouche : objet, type de bâtiment, nombre de logements, construction neuve ou
  existante, adresse, date, échelle.

**Il construit le projet tout seul** : étages chauffés, pièces comptées dans An, murs par orientation et par nature
(extérieur, mitoyen, vers le non chauffé), fenêtres et portes, planchers, toiture, volume.

**Il pré-calcule les valeurs U** à partir des couches lues (méthode simplifiée de la norme EN ISO 6946 pour les
parois, EN ISO 10077-1 pour les fenêtres). Une planche ne donne jamais les conductivités λ : le logiciel propose
des **valeurs d'usage**, relevées dans un CPE réel établi avec LuxEeB-Tool 6.25, et les affiche comme
**hypothèses** à remplacer par les valeurs déclarées des produits. Ce ne sont pas des valeurs réglementaires. Un
matériau sans valeur d'usage (brique, laine minérale, bois…) reste sans λ : il se choisit dans la base de LuxEeB-Tool.
Les menuiseries (Ug, Uf, Ψg, g, cadre) sont proposées de la même façon. LuxEeB-Tool fait foi : ces U servent à
contrôler la saisie et à voir l'effet d'une hypothèse.

**Il ne pose que les questions où il a un doute** (voir plus bas la règle), et présente le dossier dans l'ordre des
feuilles de LuxEeB-Tool 6.25.

**Le parcours guidé reste le repli.** Pour un DWG, un DXF, une maquette IFC, une image, un PDF scanné, plusieurs
fichiers déposés ensemble, ou une planche que la lecture automatique ne comprend pas assez, le logiciel propose le
relevé guidé sur le plan, étape par étape, et dit pourquoi.

## Ce qu'il ne fait pas

- **Le passeport officiel et ses classes sortent de LuxEeB-Tool** (ou d'un autre outil reconnu), établis et signés
  par l'expert habilité. Plan2CPE prépare les données, il ne produit pas de certificat.
- **Il n'estime aucune classe énergétique**, ni besoin de chaleur : afficher une classe avant le calcul officiel
  serait trompeur.
- **Il n'écrit pas directement dans LuxEeB-Tool.** Il prépare des valeurs à copier, ligne par ligne ou en bloc. Pour
  aller plus loin, il faudrait un fichier de projet enregistré par l'outil (voir
  [plus bas](#pour-aller-jusquau-remplissage-direct-de-luxeeb-tool)).
- **Ce qu'un plan ne porte pas reste une hypothèse à confirmer** : conductivités des matériaux, vitrages et cadres,
  ventilation (appareil, débit, rendement), détail des installations de chauffage et d'eau chaude, ponts thermiques.
  Le logiciel propose une valeur courante, l'étiquette comme telle, et la liste dans « Hypothèses à confirmer ».
- **Il ne lit pas les fichiers natifs** Archicad (`.pln`), Revit (`.rvt`) ou SketchUp (`.skp`) : il explique comment
  les exporter.

## Le parcours

### Parcours automatique (planche PDF)

1. **Dépôt** — on dépose la planche (un seul PDF, une ou plusieurs pages). Le logiciel montre où il en est : « J'ouvre
   la planche », « Je repère les vues », « Je lis les pièces », « Je mesure l'enveloppe », « Je lis les compositions
   des parois », « Je recoupe ce que j'ai lu », « Je prépare les questions ».
2. **« Voici ce que j'ai lu »** — les données lues, rangées en six groupes (projet, surfaces chauffées An, enveloppe,
   parois et couches, fenêtres et portes, installations), chacune avec son niveau de confiance. La miniature de la
   planche reste visible pendant qu'on fait défiler la liste : les vues reconnues y sont encadrées et « Voir sur la
   planche » entoure l'endroit d'où vient une donnée.
3. **Les questions de doute** — une carte par question, de la plus importante à la moins importante. Chaque carte
   donne la réponse proposée, la raison de la question (« je ne l'ai lu qu'à un seul endroit », « deux endroits de la
   planche ne disent pas la même chose », « le plan ne porte pas ces valeurs »…), l'extrait de la planche concerné et
   le temps estimé. On peut confirmer, choisir une autre réponse, répondre « Je ne sais pas » (la proposition est
   gardée et marquée hypothèse dans le dossier) ou **corriger sur le plan**. Les questions sur des valeurs d'usage
   (matériaux, menuiseries, ventilation, chauffage, ponts thermiques) se confirment toutes d'un seul geste.
4. **Le dossier** — un seul parcours : d'abord les chiffres clés, les questions encore ouvertes et les hypothèses à
   confirmer ; puis les feuilles de LuxEeB-Tool dans l'ordre de l'outil, chacune repliable, avec ses lignes à copier
   et à cocher « saisie » ; enfin « Ce qui reste à faire dans LuxEeB-Tool » (coller et relire, choisir les appareils
   réels, lancer le calcul, contrôler la plausibilité, signer). Les tableaux se copient aussi en bloc ; un relevé CSV,
   un dossier imprimable et le projet (`.json`) s'enregistrent.

**Corriger sur le plan.** Depuis une carte, ce bouton ouvre l'éditeur de plan sur l'étage et l'outil concernés
(contour, façades, baies, pièces, hauteur, nord, échelle). « Terminé, revenir » ramène à l'écran de départ, et les
questions sont recalculées avec la correction.

**Niveaux de confiance.** Ils suivent les mêmes paliers partout dans le logiciel :

| Étiquette | Ce qu'elle veut dire |
| --- | --- |
| lu et recoupé | lu sur la planche et confirmé par une deuxième source indépendante (confiance ≥ 0,85) |
| lu | lu sur la planche, à un seul endroit, ou calculé à partir de valeurs lues |
| hypothèse | rien sur la planche : valeur courante proposée par l'outil, à confirmer |
| manquant | ni lu ni proposé : à saisir |
| vous | saisi ou confirmé par vous |

Une donnée liée à une question encore ouverte porte en plus la mention « à vérifier ». Rien de ce que le logiciel
met dans le projet ne passe à « vous » sans un geste de votre part.

**La règle des questions de doute.** Chaque donnée reçoit des signaux de sources indépendantes : texte de la
planche, géométrie du plan, coupe, façades dessinées, cartouche, hypothèse de l'outil. Deux sources qui concordent
donnent une donnée sûre ; une seule source donne une donnée lue ; deux sources qui se contredisent font tomber la
confiance. Une question n'est posée que si la confiance reste sous un seuil qui dépend du poids de la donnée dans le
calcul : 0,85 pour ce qui pèse lourd (échelle, toiture, plancher bas, locaux non chauffés, An), 0,65 pour ce qui
pèse moins (hauteurs, pièces ambiguës), 0,35 pour le reste (nord, année). Ce que le plan ne peut pas dire
(λ, menuiseries, ventilation, chauffage, ponts thermiques) fait une seule question par feuille de LuxEeB-Tool, dont
les détails sont des lignes.

Si la lecture ne suffit pas — aucun plan d'étage avec un contour chauffé, échelle non recoupée, toiture ou plancher
bas non lus, plus de huit questions sur le plan lui-même — le logiciel le dit en une phrase et passe au parcours
guidé.

### Parcours guidé (repli)

1. **Plans** — déposer un ou plusieurs fichiers, ou continuer sans plan sur une grille.
2. **Lecture** — ce qui a été trouvé : feuilles, échelle, contour, pièces, ouvertures, nord.
3. **Plan** — sept gestes par étage : échelle, contour chauffé, hauteur d'étage, ce qu'il y a derrière chaque
   façade, fenêtres et portes, nord, pièces comptées dans An. Deux jauges disent ce qui est complet et ce qui est
   confirmé.
4. **Questions** — la toiture et le plancher bas, que le plan ne montre pas, puis des notes de visite facultatives.
5. **Résultat** — le guide de saisie section par section, avec les mêmes tableaux à copier et les mêmes
   téléchargements.

Dans les deux parcours, le projet s'enregistre tout seul dans le navigateur (jamais les fichiers de plans) :
« Reprendre » ramène là où l'on s'était arrêté. Pour revoir les vues et les endroits lus, il faut redéposer la
planche. Le « mode expert » donne accès à toutes les tables (pièces, ouvertures, types de parois et de fenêtres,
lignes ajoutées à la main pour ce que le plan ne montre pas).

Pour essayer sans plan : bouton **« Essayer avec un exemple »** de l'écran d'accueil. Il ouvre une planche
d'autorisation fictive en PDF (parcours automatique) ; un second exemple, une maison fictive en DXF, montre le
parcours guidé.

## Fichiers lus

| Format | Ce qui est lu | Parcours |
| --- | --- | --- |
| PDF vectoriel (planche d'autorisation) | vues, pièces, emprise, contour chauffé, baies, niveaux, coupes, façades, compositions, équipements, cartouche, nord | automatique si la lecture suffit, sinon guidé |
| IFC 2x3 / IFC4 | niveaux, emprise, pièces (IfcSpace), fenêtres et portes avec leurs dimensions, hauteurs, nord | guidé |
| DWG (R13 à 2018), DXF | unité du dessin, contour sur le calque des murs, pièces, ouvertures, flèche du nord ; un dessin peut contenir plusieurs plans | guidé |
| PDF scanné, PNG, JPG | rien n'est lu automatiquement : l'image sert de fond, on pose la règle sur une cote puis on trace | guidé |

**Archicad, Revit, SketchUp.** Leurs fichiers natifs ne se lisent que dans ces logiciels. L'application affiche la
marche à suivre et un courriel type pour l'architecte : un IFC (modèle entier, zones comprises, quantités de base
activées), à défaut un DWG/DXF par niveau ou des PDF vectoriels à l'échelle avec une coupe. Pour le parcours
automatique, le plus simple est de demander la planche d'autorisation elle-même, exportée en PDF vectoriel (pas
imprimée en image ni « ajustée à la page »).

### Ce qu'il faut sur une planche pour que la lecture automatique marche bien

- **Du texte réel**, pas du texte vectorisé ni un scan : sans reconnaissance de caractères, des lettres dessinées en
  traits ne se lisent pas.
- **Un titre par vue**, plus gros que le texte courant (« PLAN 1ER ÉTAGE », « COUPE A-A », « FAÇADE ARRIÈRE »).
  Sans titres, la page se découpe encore d'après le contenu (étiquettes de pièces, cotes, cartouche), avec moins
  d'assurance sur le niveau de chaque plan.
- **Les surfaces des pièces écrites** à côté de leur nom : elles fixent An et recoupent l'échelle.
- **L'échelle dans le cartouche** (« 1/100 »), ou des cotes lisibles.
- **Des murs dessinés avec leur matière** (hachure, remplissage) et **l'isolant visible** : c'est lui qui dit où
  passe l'enveloppe thermique, par exemple entre le garage et le logement.
- **Les baies cotées** (largeur et hauteur), ou des façades dessinées.
- **Une coupe cotée** avec les niveaux finis et l'acrotère ou le faîtage : sans elle, les hauteurs sont des valeurs
  par défaut.
- **Les compositions de parois annotées** (couches et épaisseurs) : sans elles, la paroi existe mais sa valeur U
  reste à définir.
- **Une flèche du nord** avec la lettre « N » ou le mot « NORD ».

La lecture retombe sur le parcours guidé quand aucun plan d'étage ne livre de contour chauffé sûr, quand l'échelle
ne se recoupe pas (PDF « ajusté à la page », pas de surfaces écrites), quand ni toiture ni plancher bas ne sont lus,
ou quand il resterait plus de huit questions sur le plan.

## Conventions de mesure appliquées

Elles suivent le règlement grand-ducal du 9 juin 2021 et le manuel de LuxEeB-Tool.

- **An** : surface NETTE des pièces de la zone chauffée. La surface écrite sur le plan est retenue quand elle
  concorde à 5 % près avec la surface mesurée ; au-delà, c'est la mesure qui compte, avec les deux valeurs en note
  (une surface écrite suit parfois une autre règle, comme la surface habitable sous rampant).
- **Escalier, dégagement sans étiquette** : mesurés, mais comptés dans An seulement si vous le dites (question
  « an-unlabelled », étage par étage si besoin).
- **Ve et enveloppe A** : dimensions EXTÉRIEURES. Le contour d'un étage suit la face extérieure des murs.
- **Hauteurs brutes** : par défaut, cotes extérieures, du dessous de l'isolant du plancher bas au-dessus de la
  toiture (niveau fini du dernier étage, plus hauteur libre lue, plus épaisseur de la toiture). Si la coupe ne donne
  pas de quoi faire ce calcul, de niveau fini à niveau fini puis jusqu'à l'acrotère ou au faîtage. La convention
  appliquée est écrite à côté de chaque hauteur. Sans hauteur libre lue, 2,50 m est pris et marqué valeur par défaut.
- **Fenêtres et portes** : dimensions brutes du gros œuvre (Rohbaumaß), déduites de leur paroi (colonne « Abzug »).
  Quand la hauteur écrite sur le plan et celle vue en façade diffèrent de plus de 5 cm, une seule question est posée
  pour tout le projet : cote du plan, cote du plan + 5 cm, ou hauteur vue en façade.
- **Orientation** : huit secteurs de 45° et « Horizontal ». Les azimuts sont affichés en degrés, parce que « O » veut
  dire ouest en français et est (Ost) en allemand. Une façade nommée « avant » ou « arrière » est rattachée au côté
  du plan d'après la position de ses baies.
- **Contour chauffé** : un garage accolé ou un abri est hors de l'enveloppe. Un local technique ou une buanderie
  dans l'isolant reste dans le volume chauffé : il compte dans A et Ve, et dans An s'il est chauffé. Une pièce
  ambiguë hors de l'isolant fait une question.
- **Mitoyenneté** : un mur mitoyen lu sur les plans fait proposer « accolé d'un côté » ; une maison dont tous les
  côtés portent des baies ou un isolant extérieur est proposée isolée.
- **Échelle** : l'échelle écrite dans un cartouche n'est qu'un indice (un PDF « ajusté à la page » la rend fausse).
  Elle est recoupée par les surfaces écrites et les cotes hors tout. Poser la règle sur une cote connue fait foi.

## Limites connues

À lire avant de faire confiance à un chiffre.

- **La lecture automatique a été mise au point sur UNE planche réelle** (export Archicad, maison unifamiliale,
  format A1, 1/100) **et sur quatre planches synthétiques** dessinées pour les tests. Ses seuils (finesse des
  hachures, écart des exposants, distance d'une baie à son mur, pas des marches d'escalier…) sont réglés sur ce petit
  échantillon. Une autre façon de dessiner, un autre logiciel d'export ou un autre bureau mettra des cas en défaut :
  le logiciel doit alors poser plus de questions ou passer au parcours guidé, mais il peut aussi se tromper sans le
  savoir.
- **Écarts mesurés sur cette planche réelle**, face au CPE établi par l'expert pour le même bâtiment : les 13 pièces
  à 0,2 % près ; la surface d'enveloppe environ 4 % au-dessus, le volume Ve environ 2 % au-dessus, les surfaces de
  fenêtres environ 2 % en dessous ; An à 7 % sous le CPE sans l'escalier et à 2 % au-dessus avec lui (l'expert en
  compte une partie). L'essentiel des écarts vient d'une **convention de hauteur différente** : l'expert a pris des
  hauteurs de façade plus basses d'environ 7 % que les cotes extérieures lues, des longueurs un peu plus courtes, et
  la cote du plan + 5 cm pour les fenêtres. Avec les λ d'usage, les U pré-calculés retombent à 1 % près pour la
  toiture et la dalle sur sol, à 6 % pour le mur extérieur (« béton » lu là où l'expert a pris des blocs) ; celui du
  plancher au-dessus du garage s'écarte de 26 % (couche mixte, signalée par la question des matériaux) et le mur vers
  le garage, sans composition sur la planche, reste sans U. Sur cette planche, il reste 7
  questions : 2 sur le plan (escalier sans étiquette, convention des hauteurs de baies) et 5 sur des valeurs
  d'usage.
- **Ce qui se lit mal ou pas** : la hauteur d'une porte vers un local non chauffé sans cote ni façade (2,10 m par
  défaut, marqué tel) ; une porte d'entrée dans un grand trou de maçonnerie (largeur prise entre les tableaux,
  confiance basse) ; un local séparé par l'isolant mais sans nom de local non chauffé (« Atelier ») reste compté
  chauffé sans question ; une toiture inclinée cachée derrière un acrotère coté peut être prise pour plate ; des
  annexes séparées (abri, garage détaché) peuvent faire croire à deux plans.
- **Le collage en bloc dans le classeur LuxEeB-Tool n'a pas été essayé dans Excel.** Le format (tabulations, virgule
  décimale, orientation en allemand) suit le manuel et une sortie de la version 6.25 ; si Excel refuse ou décale, il
  reste la copie ligne par ligne.
- **Intitulés allemands** : ceux des feuilles et colonnes viennent d'une sortie imprimée de LuxEeB-Tool 6.25 ;
  d'autres viennent du manuel v1.7, plus ancien.
- **Pas de reconnaissance de caractères** : un scan ou un PDF dont le texte est vectorisé ne livre ni échelle ni
  pièces, et passe au parcours guidé.
- **Durée** : une planche A1 chargée se lit en 3 à 4 secondes (mesuré sur une machine partagée), dont la moitié pour
  l'extraction du PDF ; les planches d'essai en moins de 1,5 seconde. Une grosse maquette IFC peut figer la page une
  à deux secondes à la fois.
- **Un seul PDF à la fois pour le parcours automatique.** Plusieurs fichiers déposés ensemble (un PDF par étage, par
  exemple) passent par le parcours guidé.
- **DWG, DXF, IFC** : leurs lecteurs n'ont pas changé ; sur de vrais plans (hachures, mobilier, calques exotiques)
  la lecture échouera plus souvent que sur nos plans d'essai, et l'on pose alors la règle et trace le contour à la
  main. Un DWG endommagé est refusé ou signalé ; un DWG dont quelques octets seulement ont changé peut encore se lire
  sans alerte.
- **Toitures complexes** : lucarnes, toits mansardés et toitures à plusieurs faîtages se saisissent en lignes
  manuelles. La règle du 1,00 m sous rampant n'est pas calculée géométriquement à partir d'un PDF ou d'un DXF.
- **Textes allemands** : rédigés avec soin, pas encore relus par un expert germanophone.
- **Étiquette d'une ligne de tableau** : elle donne la provenance la plus faible de ses valeurs.
- Vérifié dans Chromium (bureau et écran de téléphone). Safari, Firefox et de vrais écrans tactiles restent à
  essayer.
- **Page hébergée dans un cadre** (page d'essai) : l'enregistrement des fichiers passe par la page hôte quand elle le
  propose ; sinon le contenu est copié. Voir [`tools/page-essai/LISEZMOI.md`](tools/page-essai/LISEZMOI.md).

## Pour aller jusqu'au remplissage direct de LuxEeB-Tool

LuxEeB-Tool enregistre ses projets dans un fichier texte dont le format n'est pas documenté. Pour écrire ce fichier
directement, il faut pouvoir l'étudier :

1. un projet enregistré par votre LuxEeB-Tool, presque vide ;
2. le même projet après saisie de quelques valeurs reconnaissables (un mur de 12,34 m, une fenêtre de 1,23 × 1,45 m…) ;
3. la version exacte de l'outil.

Avec ces deux fichiers, on peut vérifier si un fichier projet généré par Plan2CPE est relu correctement par l'outil.
Sans eux, toute écriture serait une supposition — et une donnée fausse dans un certificat coûte plus cher qu'une
saisie manuelle.

## Démarrer

Il faut [Node.js](https://nodejs.org) 22 ou plus récent.

```bash
npm install
npm run dev        # ouvre l'application en développement
npm run build      # vérifie les types et construit dist/
npm run preview    # sert dist/ sur http://localhost:4173
npm test           # lance les tests
```

Le dossier `dist/` est un site statique : il se dépose tel quel sur n'importe quel hébergement, ou se sert en local.
Il ne s'ouvre pas par double-clic sur `index.html` (les navigateurs refusent de charger des modules depuis `file://`).

## Organisation du code

```
src/core            contrat entre modules : types du projet (types.ts), lecture d'une planche avec confiance et
                    preuve (reading.ts), feuilles et colonnes de LuxEeB-Tool 6.25 (cpe.ts), géométrie
src/semantics       sens des textes : surfaces, échelles, noms de pièces et de niveaux, cotes de niveau,
                    compositions de parois, équipements, tableau des surfaces
src/readers         lecteurs IFC, DWG/DXF, PDF, image → une même description de feuille
src/readers/pdf     extraction pdf.js (extract.ts, seul fichier qui touche pdf.js) et analyse pure de la page :
                    allègement des hachures (hatch.ts), découpage en vues (sheetviews.ts), emprise (building.ts),
                    textes (textlines.ts, sheettext.ts), cartouche, nord, hauteurs libres, lecture complète
                    (integrate.ts)
src/readers/pdf/geometry
                    géométrie d'un plan d'étage (pièces, emprise, contour chauffé, baies), toiture, façades
src/engine          du document lu au projet : projet automatique (auto.ts), questions de doute (doubts.ts) et
                    réponses (doubtAnswer.ts), matériaux et λ d'usage (materials.ts), pré-calcul U (uvalue.ts),
                    mitoyenneté (party.ts), tableaux de LuxEeB-Tool et contrôles (derive.ts)
src/export          dossier feuille par feuille (dossier.ts), guide de saisie, blocs à coller, CSV, dossier
                    imprimable, fichier projet
src/ui/plan         éditeur de plan (échelle, contour, façades, ouvertures, nord, pièces)
src/ui/shell        application : écrans des deux parcours, état, enregistrement automatique, annuler/rétablir
src/i18n            mécanique des textes français et allemands (chaque module a son messages.ts)
docs                fonctionnement de la lecture automatique ; notes d'étude (docs/recherche)
tests               tests unitaires, planches et plans d'essai (tous inventés pour ce projet)
tools               préparation de la page d'essai pour un hébergement en cadre restreint
```

Le détail de la lecture d'une planche (étapes, signaux, seuils, replis) est dans
[`docs/lecture-automatique.md`](docs/lecture-automatique.md). Les notes d'étude qui ont servi à concevoir l'outil
sont dans [`docs/recherche/`](docs/recherche/LISEZMOI.md).

Bibliothèques tierces : `web-ifc` (MPL-2.0), `@node-projects/acad-ts` (MIT), `pdfjs-dist` (Apache-2.0), `jsts`
(EDL/EPL), React et zustand (MIT).

## Tests

```bash
npm test                                            # toute la suite
npx vitest run tests/readers/pdf/planche-lecture.test.ts   # une planche de bout en bout
```

Les tests n'utilisent que des données inventées. Quatre **planches d'autorisation synthétiques** imitent la
structure d'une vraie planche (plusieurs vues par page, hachures, isolant, cotes, compositions, coupes, façades,
cartouche) : une A1 en français avec maison jumelée et garage, une A2 en allemand avec sous-sol non chauffé et
titres au-dessus des vues, une planche sur deux pages, une planche sans titres de vues. Chacune a sa vérité
(`*.truth.json` : vues, pièces, contours, baies, niveaux, compositions, cartouche, nord). Elles se régénèrent avec
un script Python déterministe ; voir [`tests/fixtures/pdf/planche/LISEZMOI.txt`](tests/fixtures/pdf/planche/LISEZMOI.txt).

Quelques tests sont marqués `it.fails` : ils décrivent ce que le logiciel ne sait pas encore faire (texte
vectorisé, scan, plan « tout en trait fin »…). Ils ne sont pas cachés : ils échouent comme prévu.

## Page d'essai hébergée

Le dossier `dist/` suffit pour un hébergement statique ordinaire. Pour un hébergement qui enveloppe la page dans son
propre squelette et filtre les fichiers servis, voir [`tools/page-essai/LISEZMOI.md`](tools/page-essai/LISEZMOI.md).
