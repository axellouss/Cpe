# Page d'essai (hébergement en cadre restreint)

Le dossier `dist/` produit par `npm run build` se dépose tel quel sur un hébergement statique ordinaire : rien de ce
dossier n'est alors nécessaire.

Ces deux scripts servent au cas particulier d'un hébergement qui **enveloppe la page dans son propre squelette** et
**filtre les fichiers servis** (c'est le cas de la page d'essai privée publiée pendant le développement) :

| Contrainte de l'hébergeur | Réponse |
| --- | --- |
| La page est fournie sans `<html>`, `<head>` ni `<body>` | `preparer.py` écrit `plan2cpe.html` : titre, fond de départ, feuille de styles, racine, script |
| Les polices Type 1 (`.pfb`) de pdf.js ne sont pas servies | elles sont laissées de côté : la lecture des PDF n'en dépend pas (seul l'affichage de textes en Times ou Courier non incorporés se rabat sur une autre police) |
| Un fichier texte ne doit contenir aucun octet de contrôle brut | `echapper_controles.cjs` les réécrit en séquences `\xNN` dans la copie à publier, et **vérifie** que l'arbre syntaxique du code est resté identique |
| Téléchargements directs et nouvelles fenêtres bloqués | l'application le détecte (`window.claude.use('downloads')`) : voir `src/ui/shell/browser.ts` |

## Utilisation

```sh
npm run build
python3 tools/page-essai/preparer.py dist /chemin/vers/sortie
node tools/page-essai/echapper_controles.cjs /chemin/vers/sortie/copie/assets/*.js /chemin/vers/sortie/copie/assets/*.mjs
```

`preparer.py` écrit dans le dossier de sortie :

- `plan2cpe.html` — la page, sans squelette ;
- `copie/` — les fichiers d'accompagnement à publier (sans `.map` ni `.pfb`), aux mêmes chemins relatifs ;
- `fichiers.json` — la liste de ces chemins ;
- `essai-local/index.html` — la même page dans un squelette imitant celui de l'hébergeur, à servir depuis `copie/`
  (`python3 -m http.server` après y avoir copié ce fichier) pour l'essayer avant de publier.
