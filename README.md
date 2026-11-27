# Plan2CPE

Plan2CPE lit des plans de bâtiment et prépare les données géométriques à saisir dans **LuxEeB-Tool**, l'outil officiel
luxembourgeois de calcul du certificat de performance énergétique (CPE) des bâtiments d'habitation.

L'expert dépose ses plans, confirme en touchant ce que le logiciel a lu, répond à neuf questions au plus, et reçoit
chaque valeur **dans l'ordre de saisie de LuxEeB-Tool**, avec les intitulés allemands de l'outil, des blocs prêts à
copier et, pour chaque valeur, l'indication de sa provenance (lue sur le plan, calculée, par défaut, estimée, saisie).

Tout se passe dans le navigateur : aucun fichier ne quitte l'ordinateur, il n'y a ni serveur ni compte.

## Ce que le logiciel fait, et ce qu'il ne fait pas

| Il fait | Il ne fait pas |
| --- | --- |
| Lire IFC, DWG, DXF, PDF vectoriels ; afficher scans et images pour un relevé à la main | Lire les fichiers natifs Archicad (`.pln`), Revit (`.rvt`) ou SketchUp (`.skp`) : il explique comment exporter |
| Proposer échelle, contour, pièces, ouvertures, nord — à confirmer d'un toucher | Décider à la place de l'expert : chaque proposition reste « à confirmer » tant qu'elle n'est pas validée |
| Calculer An, Vn, Ve, l'enveloppe A par paroi et par orientation, les déductions de fenêtres | Calculer une classe énergétique, un besoin de chaleur ou un certificat |
| Présenter les valeurs dans l'ordre et le vocabulaire de LuxEeB-Tool, avec blocs à coller | Écrire dans LuxEeB-Tool : l'outil (classeur Excel) n'a pas d'interface d'import connue |
| Signaler les incohérences (échelle non confirmée, An proche du brut, fenêtres plus grandes que le mur…) | Fournir des valeurs U : elles se définissent dans LuxEeB-Tool, sous la responsabilité de l'expert |

Seuls les architectes et ingénieurs membres de l'OAI et les experts agréés peuvent établir un CPE. Plan2CPE est un
**assistant de relevé** : il fait gagner le temps du métré et de la mise en forme, pas celui du contrôle.

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

Pour essayer sans plan : bouton **« Essayer avec un exemple »** de l'écran d'accueil (une maison fictive de deux
niveaux avec garage accolé, en DXF).

## Le parcours

1. **Plans** — déposer un ou plusieurs fichiers (un PDF par étage, par exemple), ou continuer sans plan sur une grille.
2. **Lecture** — le logiciel montre ce qu'il a trouvé : feuilles, échelle, contour, pièces, ouvertures, nord.
3. **Plan** — six gestes par étage : échelle, contour chauffé, ce qu'il y a derrière chaque façade, fenêtres et portes,
   nord, pièces comptées dans An. Les hauteurs d'étage se saisissent à côté.
4. **Questions** — ce qu'un plan ne dit pas : occasion et type de bâtiment, année, toiture et plancher bas, isolation
   ajoutée, génération des fenêtres, chauffage, eau chaude, ventilation, solaire.
5. **Résultat** — le guide de saisie, section par section, avec les points à vérifier, un dossier imprimable, un relevé
   CSV et le projet enregistrable (`.json`).

Le « mode expert » donne accès à toutes les tables (pièces, ouvertures, types de parois et de fenêtres, lignes
ajoutées à la main pour ce que le plan ne montre pas : lucarnes, toitures complexes…).

## Fichiers lus

| Format | Ce qui est lu | Remarques |
| --- | --- | --- |
| IFC 2x3 / IFC4 | niveaux, emprise, pièces (IfcSpace), fenêtres et portes avec leurs dimensions, hauteurs, nord | la voie la plus fiable quand l'architecte travaille en maquette |
| DWG (R13 à 2018), DXF | unité du dessin, contour sur le calque des murs, pièces nommées, ouvertures, flèche du nord | un dessin peut contenir plusieurs plans : une feuille par plan |
| PDF vectoriel | échelle écrite et cotes, contour, pièces, ouvertures, titres de niveaux | un PDF « ajusté à la page » n'est plus à l'échelle : il faut poser la règle |
| PDF scanné, PNG, JPG | rien n'est lu automatiquement | l'image sert de fond : on pose la règle sur une cote, puis on trace |

**Archicad, Revit, SketchUp.** Leurs fichiers natifs ne se lisent que dans ces logiciels. L'application affiche la
marche à suivre et un courriel type pour l'architecte. En résumé : exporter un **IFC** (modèle entier, zones ou pièces
comprises, quantités de base activées) ; à défaut un DWG/DXF par niveau, ou des PDF vectoriels à l'échelle avec une
coupe.

## Conventions de mesure appliquées

Elles suivent le règlement grand-ducal du 9 juin 2021 et le manuel de LuxEeB-Tool.

- **An** : surface NETTE des pièces de la zone chauffée, là où la hauteur libre dépasse 1,00 m.
- **Ve** et **enveloppe A** : dimensions EXTÉRIEURES. Le contour d'un étage suit la face extérieure des murs.
- **Fenêtres et portes** : dimensions brutes du gros œuvre (Rohbaumaß), déduites de leur paroi (colonne « Abzug » :
  les lignes marquées « x » se déduisent de la prochaine ligne non marquée).
- **Orientation** : huit secteurs de 45° et « Horizontal ». Les azimuts sont affichés en degrés, parce que « O » veut
  dire ouest en français et est (Ost) en allemand.
- **Contour chauffé** : un garage accolé ou un abri est hors de l'enveloppe. Le logiciel le retire du contour qu'il
  propose et marque le mur de séparation « contre un local non chauffé » ; un geste suffit pour le réintégrer. Une
  chaufferie ou un local technique reste dans le contour : un local non conditionné situé dans l'enveloppe isolée
  compte dans A et Ve, pas dans An ; s'il est hors de l'enveloppe, l'expert le retire d'un geste.
- **Échelle** : l'échelle écrite dans un cartouche n'est qu'un indice (un PDF « ajusté à la page » la rend fausse).
  Poser la règle sur une cote connue fait foi, et tout ce qui a été mesuré sur le dessin suit la nouvelle échelle.

## Limites connues

À lire avant de faire confiance à un chiffre.

- **Le collage en bloc dans le classeur LuxEeB-Tool n'a pas été essayé dans Excel.** Le format (tabulations, virgule
  décimale, orientation en allemand) est préparé d'après le manuel ; si Excel refuse ou décale, il reste la copie ligne
  par ligne. Le premier essai réel dira ce qu'il faut ajuster.
- **Les intitulés allemands viennent du manuel v1.7**, dont les captures montrent une version ancienne de l'outil. La
  version actuelle (6.x) peut avoir renommé des feuilles ou des champs.
- **Les lecteurs ont été mis au point sur des plans que nous avons dessinés nous-mêmes** et sur quelques fichiers
  d'exemple publics. Sur de vrais plans d'architecte (hachures, mobilier, plusieurs bâtiments, calques exotiques), la
  lecture automatique échouera plus souvent : dans ce cas on pose la règle et on trace le contour à la main.
- **Pas de reconnaissance de caractères** : un scan ou un PDF dont le texte est vectorisé ne livre ni échelle ni pièces.
- **Les hauteurs se lisent rarement sur un plan.** Sans coupe ni maquette, les hauteurs d'étage sont des valeurs par
  défaut signalées comme telles.
- **Toitures** : toit plat, plafond sous grenier froid, toits à une, deux ou quatre pentes sur plan simple. Le sens
  du faîtage est proposé, jamais deviné en silence : tant qu'il n'est pas confirmé, les murs sous toiture, les pans et
  le volume sont marqués « estimation ». Sur un contour non rectangulaire ils restent approchés. Lucarnes, toits
  mansardés et toitures à plusieurs faîtages se saisissent en lignes manuelles. La règle du 1,00 m sous rampant n'est
  pas calculée géométriquement à partir d'un PDF ou d'un DXF (elle l'est à partir d'une maquette IFC).
- **Étages non superposables** (plans à des origines différentes) : les retraits et porte-à-faux sont estimés par
  différence de surfaces.
- **Textes allemands** : rédigés avec soin, pas encore relus par un expert germanophone.
- Vérifié dans Chromium (bureau et émulation mobile). Safari, Firefox et de vrais écrans tactiles restent à essayer.

## Pour aller jusqu'au remplissage direct de LuxEeB-Tool

LuxEeB-Tool enregistre ses projets dans un fichier texte dont le format n'est pas documenté. Pour écrire ce fichier
directement, il faut pouvoir l'étudier :

1. un projet enregistré par votre LuxEeB-Tool, presque vide ;
2. le même projet après saisie de quelques valeurs reconnaissables (un mur de 12,34 m, une fenêtre de 1,23 × 1,45 m…) ;
3. la version exacte de l'outil.

Avec ces deux fichiers, on peut vérifier si un fichier projet généré par Plan2CPE est relu correctement par l'outil.
Sans eux, toute écriture serait une supposition — et une donnée fausse dans un certificat coûte plus cher qu'une
saisie manuelle.

## Organisation du code

```
src/core        types partagés (contrat entre modules) et géométrie
src/semantics   lecture des étiquettes de plan (surfaces, échelles, noms de pièces et de niveaux)
src/readers     lecteurs IFC, DWG/DXF, PDF, image → une même description de feuille
src/engine      du modèle de bâtiment aux tableaux de LuxEeB-Tool, avec les contrôles de plausibilité
src/export      guide de saisie, blocs à coller, CSV, dossier imprimable, fichier projet
src/ui/plan     éditeur de plan (échelle, contour, façades, ouvertures, nord, pièces)
src/ui/shell    application : écrans, état, enregistrement automatique, annuler/rétablir
docs/recherche  notes d'étude : formats, méthode de calcul, LuxEeB-Tool, ergonomie
tests           tests unitaires et plans de test (tous dessinés pour ce projet)
```

Bibliothèques tierces : `web-ifc` (MPL-2.0), `@node-projects/acad-ts` (MIT), `pdfjs-dist` (Apache-2.0), `jsts`
(EDL/EPL), React et zustand (MIT).
