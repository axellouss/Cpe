/**
 * Contrat interne entre l'éditeur (navigation, pointeurs, clavier) et les outils (règle, contour, façades…).
 * L'éditeur transforme les événements bruts en gestes simples ; chaque outil publie un « contrôleur » qui y répond.
 */
import type { Lang, PlanSheet, Storey, Vec2, WindowType } from '../../core/types';
import type { SnapIndex } from './snapIndex';
import type { Size, View } from './view';

export interface PointerInfo {
  /** Position dans la zone de plan (px CSS). */
  screen: Vec2;
  /** Même point en unités de feuille. */
  sheet: Vec2;
  /** 'mouse' | 'pen' | 'touch'. */
  pointerType: string;
  altKey: boolean;
  shiftKey: boolean;
}

/** Glissement en cours (sommet, extrémité de règle…). `end` valide, `cancel` annule sans rien émettre. */
export interface DragSession {
  move(p: PointerInfo): void;
  end(p: PointerInfo): void;
  cancel(): void;
}

export interface KeyInfo {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  repeat: boolean;
}

export interface ToolController {
  /** Appui principal : renvoie une session si quelque chose de déplaçable est sous le pointeur. */
  dragStart?(p: PointerInfo): DragSession | null;
  /** Toucher / clic sans déplacement. */
  tap?(p: PointerInfo): void;
  /** Survol (souris) ou doigt posé ; null quand le pointeur quitte le plan. */
  hover?(p: PointerInfo | null): void;
  /** Touche enfoncée ; renvoie vrai si l'outil l'a traitée (l'éditeur n'en fait alors rien). */
  key?(e: KeyInfo): boolean;
  keyUp?(e: KeyInfo): void;
  /** Le plan perd le clavier : valider ce qui attendait un relâchement de touche. */
  blur?(): void;
  /** Clic droit / appui long : renvoie vrai si l'outil ouvre une action contextuelle. */
  context?(p: PointerInfo): boolean;
}

export type Translate = (key: string, params?: Record<string, string | number>) => string;

export interface ToolContext {
  view: View;
  size: Size;
  sheet: PlanSheet | null;
  index: SnapIndex | null;
  storey: Storey;
  ghostStoreys: readonly Storey[];
  northAngle: number;
  lang: Lang;
  tr: Translate;
  windowTypes: readonly WindowType[];
  /** Zone de plan étroite (téléphone) : les bulles deviennent des feuilles en bas d'écran. */
  compact: boolean;
  /** Aimant (accrochage) actif. */
  magnet: boolean;
  setMagnet(on: boolean): void;
  /** Émet l'étage modifié (une fois par action validée). */
  commit(next: Storey): void;
  /** Signale au shell que l'action de l'outil est terminée. */
  done(): void;
  changeNorth(angle: number): void;
  /** Vrai sur un appareil tactile (pointeur principal imprécis) : les rappels parlent de doigts, pas de touches. */
  coarse: boolean;
  /**
   * Indique le point visé (accroché) pendant un survol ou un glissement, null quand il n'y en a plus.
   * Avec un doigt ou un stylet posé, l'éditeur l'affiche dans une loupe — le doigt cache ce qu'il vise.
   */
  aim(point: Vec2 | null): void;
  /**
   * Une feuille posée en bas de l'écran (bulle en présentation téléphone) couvre `height` px du plan : l'éditeur
   * remonte le plan juste assez pour que `focus` (unités de feuille : la façade touchée, le côté saisi) reste visible
   * au-dessus d'elle. `null` à la fermeture : le plan reprend sa place. Sans effet s'il n'y a pas la place.
   */
  cover(focus: Vec2 | null, height: number): void;
  /**
   * À appeler juste avant `commit` quand une SAISIE (pas un geste) change la taille du contour : si l'utilisateur
   * n'a pas bougé la vue, l'éditeur la recadre sur le nouveau contour, pour que rien ne glisse sous l'interface.
   */
  reframe(): void;
  /** L'outil y dépose son contrôleur. */
  controller: { current: ToolController | null };
  /** Rend le clavier à la zone de plan (après un bouton, une bulle…). */
  focusSurface(): void;
}
