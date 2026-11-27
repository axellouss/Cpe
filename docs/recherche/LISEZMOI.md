# Notes de recherche (novembre 2026)

Ces notes ont servi à concevoir Plan2CPE. Elles sont conservées telles quelles (en anglais) parce qu'elles
disent, pour chaque affirmation, si elle a été **prouvée en exécutant du code**, lue dans une source officielle,
tirée d'une source secondaire, ou **non vérifiée**.

| Dossier | Sujet |
|---|---|
| `luxeeb-tool/` | Ce qu'est LuxEeB-Tool (classeur Excel + VBA, projets en `.txt`, aucune fonction d'import connue), options pour y reporter des données |
| `cpe-method/` | Données d'entrée d'un CPE d'habitation (RGD 2021, annexe I) : définitions de An, Ve, A ; ce que les plans donnent ou non |
| `dwg-dxf/` | Lecture DWG/DXF dans le navigateur : bibliothèques testées, licences, algorithme d'extraction et ses limites |
| `ifc-pln/` | Fichiers Archicad `.pln` (illisibles hors d'Archicad) et lecture IFC avec vérifications chiffrées |
| `pdf-vision/` | Plans PDF vectoriels ou scannés : détection d'échelle, pièges (« ajusté à la page »), précision atteignable |
| `prior-art-ux/` | Outils existants et règles d'ergonomie ; script de questions minimal |

À savoir avant de s'y fier :

- Les chemins `/tmp/.../scratchpad/research/...` cités dans les notes correspondent à ce dossier ; les environnements
  virtuels, modules installés, fichiers d'exemple téléchargés et sorties volumineuses n'ont pas été conservés.
- Les essais portent surtout sur des plans **synthétiques** dessinés pour l'occasion : aucun plan réel d'architecte
  luxembourgeois n'a été testé.
- Les tableaux réglementaires chiffrés (typologie des valeurs U, facteurs de correction, classes) n'ont **pas** pu être
  vérifiés sur les textes officiels ; le tableau « reconstruit » de `cpe-method/NOTES.md` § 6.2 ne doit pas être utilisé.
- Documents officiels effectivement lus : le manuel de LuxEeB-Tool (version 1.7), la FAQ du RGD 2021 pour les bâtiments
  d'habitation (version du 20/12/2023), la notice du registre des CPE (v1.8) et la page « informations techniques » du
  ministère de l'Économie (mise à jour du 05.02.2025).
