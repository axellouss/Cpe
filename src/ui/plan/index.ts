/**
 * Éditeur de plan interactif — point d'entrée du module (contrat des props : ./api.ts).
 *
 * Pour l'hôte :
 *  - L'éditeur remplit son conteneur (width / height 100 %, hauteur minimale 240 px) : donnez une hauteur au parent.
 *    En dessous de 560 px de large il passe de lui-même en présentation « téléphone » (bulles en bas d'écran,
 *    interface resserrée, contour cadré dans la place qu'elle laisse). Prévoir au moins 320 px de haut.
 *  - Il capte les gestes tactiles sur toute sa surface (touch-action: none) : la page ne défile pas à travers lui.
 *  - Thème : propriétés CSS --p2c-accent, --p2c-accent-contrast, --p2c-canvas, --p2c-paper, --p2c-surface,
 *    --p2c-ink, --p2c-muted, --p2c-border, --p2c-plan-ink, --p2c-warn, --p2c-warn-bg, --p2c-danger, --p2c-snap,
 *    --p2c-heated, --p2c-unheated, --p2c-boundary-outside / -heated / -unheated / -ground, --p2c-window, --p2c-door,
 *    --p2c-north. Sans elles : valeurs par défaut claires, et sombres sous prefers-color-scheme: dark.
 *  - Émissions (onStoreyChange, onNorthChange, onToolDone) : voir l'en-tête de ./PlanEditor.tsx.
 *  - Importer ce module enregistre ses textes FR / DE (« plan.* ») dans src/i18n et charge sa feuille de styles.
 *  - Banc d'essai (développement) : /src/ui/plan/dev/harness.html sous « vite ».
 */
export { PlanEditor } from './PlanEditor';
export type { PlanEditorProps, PlanTool } from './api';
