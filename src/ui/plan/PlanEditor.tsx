/**
 * Éditeur de plan interactif (contrat : ./api.ts).
 *
 * Ce fichier gère ce qui est commun à tous les outils : la vue (zoom, déplacement, ajustement), le fond en <canvas>,
 * la traduction des pointeurs (souris, stylet, doigts) et du clavier en gestes simples. Chaque outil (dossier
 * ./tools) dessine son calque SVG, ses bulles, et répond aux gestes par son « contrôleur » (voir ./toolTypes.ts).
 *
 * Règle d'or des gestes : un TOUCHER agit, un GLISSER sur le vide déplace le plan, un glisser sur une poignée
 * la déplace. Tout glissement a son alternative sans glisser (boutons, clavier, « toucher puis toucher »).
 * Exception assumée, au doigt ou au stylet, quand il faut POSER UN POINT (règle, tracé) : glisser sert à viser
 * dans la loupe et relâcher pose le point ; on déplace alors le plan à deux doigts.
 *
 * Émissions vers le shell :
 *  - onStoreyChange / onNorthChange : une fois par action VALIDÉE (relâchement, bouton, Entrée), jamais pendant
 *    un glissement ; l'éditeur n'a pas d'historique, « annuler » appartient au shell.
 *  - onToolDone(outil) seulement sur une fin d'action sans ambiguïté :
 *      scale    → échelle appliquée ;
 *      outline  → contour fermé, contour proposé accepté, ou bouton « Le contour est bon » ;
 *      north    → bouton « Le nord est bon » ;
 *      rooms    → la dernière pièce « à trancher » vient d'être décidée ;
 *      boundary, opening, pan → jamais (on y enchaîne les retouches : c'est le shell qui propose de continuer).
 *
 * La prop `constructions` du contrat n'est pas utilisée ici : le choix du type de mur par façade se fait ailleurs.
 *
 * Cadrage : tant que l'utilisateur n'a ni zoomé ni déplacé le plan, la vue reste « automatique » — elle se recadre
 * au changement d'outil, de taille, et après une saisie qui change la taille du contour (`reframe`). Sur un écran
 * étroit (téléphone), le contour est cadré dans la place que l'interface de l'outil laisse RÉELLEMENT (mesurée dans
 * le DOM), avec la marge de ce que l'outil écrit autour de lui : le plan occupe l'écran, rien ne le recouvre.
 * Une bulle ouverte en feuille au bas de l'écran remonte le plan le temps de la saisie (`cover`).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import { bboxOf, polygonArea } from '../../core/geometry';
import type { BBox, Vec2 } from '../../core/types';
import { t } from '../../i18n';
import type { PlanEditorProps, PlanTool } from './api';
import { PlanCanvas } from './canvasLayer';
import type { CanvasColors } from './canvasLayer';
import { Loupe } from './Loupe';
import './messages';
import './plan-editor.css';
import { buildSnapIndex } from './snapIndex';
import type { DragSession, KeyInfo, PointerInfo, ToolContext, ToolController } from './toolTypes';
import { BoundaryTool } from './tools/BoundaryTool';
import { NorthTool } from './tools/NorthTool';
import { OpeningTool } from './tools/OpeningTool';
import { OutlineTool } from './tools/OutlineTool';
import { PanTool } from './tools/PanTool';
import { RoomsTool } from './tools/RoomsTool';
import { ScaleTool } from './tools/ScaleTool';
import type { Insets, ScreenBox, Size, View, ZoomLimits } from './view';
import {
  COMPACT_MARGIN,
  fitViewInsets,
  fitViewMargins,
  hudInsets,
  inflateBBox,
  isUsableBBox,
  panBy,
  pinch,
  sameView,
  screenToSheet,
  sheetToScreen,
  unionBBox,
  wheelZoomFactor,
  zoomAt,
} from './view';

/** Feuille vierge : étendue montrée au départ (m). */
const BLANK_BOX: BBox = { minX: 0, minY: 0, maxX: 20, maxY: 14 };
/** Largeur de la zone de plan en dessous de laquelle l'interface passe en mode téléphone. */
const COMPACT_WIDTH = 560;
/**
 * Hauteur en dessous de laquelle elle y passe aussi, quelle que soit la largeur : dans 340 px de haut, l'interface
 * de bureau (boussole en carte de 344 px, bandeaux de deux lignes) ne laisse pas de place au plan.
 */
const COMPACT_HEIGHT = 420;
/** Déplacement (px) au-delà duquel un appui devient un glissement. */
const DRAG_THRESHOLD = { mouse: 4, other: 9 };

type Gesture =
  | { kind: 'pending'; id: number; start: Vec2; session: DragSession | null }
  | { kind: 'pan'; id: number; last: Vec2 }
  | { kind: 'drag'; id: number; session: DragSession }
  | { kind: 'pinch'; a: number; b: number; centre: Vec2; distance: number };

function isUiTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[data-p2c-ui]') !== null;
}

function readColors(el: HTMLElement): CanvasColors {
  const cs = getComputedStyle(el);
  const v = (name: string, fallback: string): string => cs.getPropertyValue(name).trim() || fallback;
  return {
    background: v('--_canvas', '#eeece4'),
    paper: v('--_paper', '#ffffff'),
    paperEdge: v('--_border', '#d6d2c4'),
    ink: v('--_plan-ink', '#2c3338'),
    magnet: v('--_accent', '#0f6b62'),
    grid: v('--_grid', '#e6e3d8'),
    gridStrong: v('--_grid-strong', '#cfcabb'),
  };
}

function ToolView({ tool, ctx }: { tool: PlanTool; ctx: ToolContext }) {
  switch (tool) {
    case 'scale':
      return <ScaleTool ctx={ctx} />;
    case 'outline':
      return <OutlineTool ctx={ctx} />;
    case 'boundary':
      return <BoundaryTool ctx={ctx} />;
    case 'opening':
      return <OpeningTool ctx={ctx} />;
    case 'north':
      return <NorthTool ctx={ctx} />;
    case 'rooms':
      return <RoomsTool ctx={ctx} />;
    case 'pan':
      return <PanTool ctx={ctx} />;
  }
}

/** En dessous de cette largeur de la zone de plan (px), la vue s'ouvre de préférence sur le contour. */
const NARROW_STAGE_PX = 640;

/** Ce que la vue cadre tant que l'utilisateur ne l'a pas bougée : au mieux (règle d'ouverture), le contour, ou tout. */
type AutoFit = 'auto' | 'focus' | 'all';

function sameInsets(a: Insets | null, b: Insets | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a.top - b.top) < 1 && Math.abs(a.right - b.right) < 1 && Math.abs(a.bottom - b.bottom) < 1 && Math.abs(a.left - b.left) < 1;
}

/**
 * Place réellement prise par l'interface posée sur le plan (bandeau, boutons, compteurs, navigation, boussole),
 * mesurée dans le DOM (règle de rattachement aux bords : `hudInsets`). null si rien n'est mesurable (rendu hors
 * navigateur) ou si l'interface ne laisserait pas de place au plan. Les bulles, passagères, ne comptent pas.
 */
function measureHud(root: HTMLElement): Insets | null {
  const frame = root.getBoundingClientRect();
  const boxes: ScreenBox[] = [];
  for (const el of root.querySelectorAll('.p2c-plan__top > *, .p2c-plan__bottom > *, .p2c-plan__nav, .p2c-plan__compass')) {
    const r = el.getBoundingClientRect();
    boxes.push({ left: r.left - frame.left, top: r.top - frame.top, right: r.right - frame.left, bottom: r.bottom - frame.top });
  }
  return hudInsets({ width: frame.width, height: frame.height }, boxes);
}

export function PlanEditor(props: PlanEditorProps) {
  const { sheet, storey, tool, lang, onStoreyChange, onNorthChange, onToolDone } = props;
  const ghostStoreys = props.ghostStoreys;

  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasLayer = useRef<PlanCanvas | null>(null);
  const controller = useRef<ToolController | null>(null);
  const pointers = useRef(new Map<number, Vec2>());
  const gesture = useRef<Gesture | null>(null);
  const viewRef = useRef<View | null>(null);
  const frame = useRef(0);
  const lastDrawn = useRef<View | null>(null);
  const fitted = useRef<string | null>(null);
  const previousSize = useRef<Size | null>(null);
  const spaceRef = useRef(false);
  /** Position du doigt (ou du stylet) posé sur le plan ; null avec une souris ou quand rien n'est posé. */
  const coarseDown = useRef<Vec2 | null>(null);

  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  const [view, setViewState] = useState<View | null>(null);
  const [dpr, setDpr] = useState(1);
  const [redraw, setRedraw] = useState(0);
  const [magnet, setMagnet] = useState(true);
  const [panning, setPanning] = useState(false);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [showPad, setShowPad] = useState(false);
  const [coarse, setCoarse] = useState(false);
  const [loupe, setLoupe] = useState<{ finger: Vec2; point: Vec2 } | null>(null);

  const tr = useCallback((key: string, params?: Record<string, string | number>) => t(lang, key, params), [lang]);
  // Présentation resserrée : zone étroite (téléphone) ou basse (téléphone couché, tablette debout dans l'application).
  const compact = size.width > 0 && (size.width < COMPACT_WIDTH || size.height < COMPACT_HEIGHT);

  // ───────────── Index spatial des traits ─────────────

  const segments = sheet?.segments;
  const index = useMemo(() => (segments && segments.length >= 4 ? buildSnapIndex(segments) : null), [segments]);

  // ───────────── Étendues et ajustement de la vue ─────────────

  const allBox = useMemo<BBox>(() => {
    let box: BBox | null = null;
    if (sheet) {
      if (isUsableBBox(sheet.bbox) && (sheet.bbox.maxX > sheet.bbox.minX || sheet.bbox.maxY > sheet.bbox.minY)) box = sheet.bbox;
      if (sheet.image) {
        const im = sheet.image;
        box = unionBBox(box, { minX: im.x, minY: im.y, maxX: im.x + im.width, maxY: im.y + im.height });
      }
    }
    if (storey.outline.length > 0) box = unionBBox(box, bboxOf(storey.outline));
    for (const g of ghostStoreys ?? []) if (g.outline.length > 0) box = unionBBox(box, bboxOf(g.outline));
    if (!box) return BLANK_BOX;
    // Sans feuille, on laisse de la place autour du contour pour continuer à dessiner.
    return sheet ? box : inflateBBox(box, 0.35);
  }, [sheet, storey.outline, ghostStoreys]);

  // Ce que « cadrer le contour » doit montrer : le contour, et pour l'outil « pièces » les pièces dessinées juste à
  // côté (garage hors de l'enveloppe) — elles se touchent aussi.
  const focusBox = useMemo<BBox | null>(() => {
    if (storey.outline.length < 3) return null;
    let box = bboxOf(storey.outline);
    if (tool === 'rooms') {
      const near = inflateBBox(box, 0.5);
      for (const room of storey.rooms) {
        if (!room.polygon || room.polygon.length < 3) continue;
        const rb = bboxOf(room.polygon);
        if (rb.maxX < near.minX || rb.minX > near.maxX || rb.maxY < near.minY || rb.minY > near.maxY) continue;
        box = unionBBox(box, rb) ?? box;
      }
    }
    return box;
  }, [storey.outline, storey.rooms, tool]);

  // Place laissée libre par l'interface. Grand écran : marges fixes (le plan ne change pas de taille d'une étape à
  // l'autre) ; l'outil « nord » réserve en plus la boussole. Écran étroit : chaque pixel compte, on MESURE ce que
  // l'interface de l'outil occupe réellement (voir `measureHud`) ; les valeurs ci-dessous ne servent qu'en attendant.
  const north = tool === 'north';
  const staticInsets = useMemo<Insets>(
    () => (compact ? { top: 50, right: 56, bottom: north ? 96 : 44, left: 8 } : { top: 92, right: north ? 256 : 60, bottom: 64, left: 16 }),
    [compact, north],
  );
  const [hud, setHud] = useState<Insets | null>(null);
  const insets = compact && hud ? hud : staticInsets;

  /** Vue qui cadre le contour (`focus`) ou tout le dessin (`all`) dans la place laissée libre. */
  const fitOf = useCallback(
    (kind: 'focus' | 'all', free: Insets): View | null => {
      if (!(size.width > 0) || !(size.height > 0)) return null;
      if (kind === 'all' || !focusBox) return fitViewInsets(allBox, size, free);
      if (!compact) return fitViewInsets(inflateBBox(focusBox, 0.1), size, free);
      return fitViewMargins(focusBox, size, free, COMPACT_MARGIN[tool]);
    },
    [allBox, focusBox, size, compact, tool],
  );

  const fitAll = useMemo(() => fitOf('all', insets), [fitOf, insets]);
  const fitFocus = useMemo(() => (focusBox ? fitOf('focus', insets) : null), [fitOf, focusBox, insets]);
  const limits = useMemo<ZoomLimits | undefined>(
    () => (fitAll ? { min: fitAll.scale * 0.2, max: fitAll.scale * 800 } : undefined),
    [fitAll],
  );
  const limitsRef = useRef(limits);
  limitsRef.current = limits;

  /**
   * Règle d'ouverture : si le contour n'occupe qu'un coin de la feuille (plan avec cartouche, plusieurs vues), on
   * s'ouvre sur lui. Sur un écran étroit ou bas, on le cadre dès qu'il laisse une large marge autour de lui.
   */
  const preferFocus = (): boolean => {
    if (!focusBox) return false;
    const allArea = (allBox.maxX - allBox.minX) * (allBox.maxY - allBox.minY);
    const share = compact || (size.width > 0 && size.width < NARROW_STAGE_PX) ? 0.6 : 0.2;
    return allArea > 0 && polygonArea(storey.outline) < share * allArea;
  };

  /**
   * Tant que l'utilisateur n'a pas bougé la vue, elle reste « automatique » : elle suit les changements d'outil,
   * de marges et de taille. Un zoom ou un déplacement à la main y met fin (null).
   */
  const autoFit = useRef<AutoFit | null>(null);

  /** Applique une vue ; les changements d'une même image sont regroupés (un seul rendu React par image). */
  const scheduleView = useCallback((next: View, auto: AutoFit | null = null) => {
    viewRef.current = next;
    autoFit.current = auto;
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      setViewState(viewRef.current);
    });
  }, []);

  const setViewNow = useCallback((next: View, auto: AutoFit | null = null) => {
    viewRef.current = next;
    autoFit.current = auto;
    setViewState(next);
  }, []);

  // Feuille en bas d'écran (bulle d'un outil sur téléphone) : le plan remonte de `coverLift` px pour que ce dont elle
  // parle reste visible, et redescend à sa fermeture. Ce décalage n'est pas un geste de l'utilisateur : la vue reste
  // « automatique » si elle l'était.
  const coverLift = useRef(0);
  const coverKey = useRef<string | null>(null);
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const insetsRef = useRef(insets);
  insetsRef.current = insets;
  const cover = useCallback(
    (focus: Vec2 | null, height: number) => {
      const current = viewRef.current;
      if (!current) return;
      // Une seule décision par feuille et par point : on ne lutte pas contre un déplacement fait entre-temps.
      const key = focus ? `${focus.x.toFixed(6)}|${focus.y.toFixed(6)}|${Math.round(height)}` : null;
      if (key === coverKey.current) return;
      coverKey.current = key;
      let lift = 0;
      if (focus) {
        // Bande où le point doit se trouver : sous le bandeau du haut, à 44 px au-dessus de la feuille.
        const upper = insetsRef.current.top + 20;
        const lower = sizeRef.current.height - height - 44;
        const y = sheetToScreen(current, focus).y + coverLift.current;
        if (lower >= upper && y > lower) lift = y - lower;
      }
      const delta = lift - coverLift.current;
      coverLift.current = lift;
      if (Math.abs(delta) > 0.5) setViewNow(panBy(current, 0, -delta), autoFit.current);
    },
    [setViewNow],
  );

  // Taille de la zone de plan.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = (): void => {
      const w = Math.round(el.clientWidth);
      const h = Math.round(el.clientHeight);
      setSize((prev) => (prev.width === w && prev.height === h ? prev : { width: w, height: h }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Premier ajustement, puis à chaque changement de feuille ou d'étage. Un simple redimensionnement garde le centre.
  const fitKey = `${sheet?.id ?? 'blank'}|${storey.id}`;
  useLayoutEffect(() => {
    if (!fitAll) return;
    const prev = previousSize.current;
    previousSize.current = size;
    if (fitted.current !== fitKey || !viewRef.current) {
      fitted.current = fitKey;
      coverLift.current = 0;
      setViewNow(preferFocus() && fitFocus ? fitFocus : fitAll, 'auto');
      return;
    }
    // Vue encore automatique : l'effet suivant la recadre dans la nouvelle taille. Sinon on garde le centre.
    if (!autoFit.current && prev && (prev.width !== size.width || prev.height !== size.height)) {
      setViewNow(panBy(viewRef.current, (size.width - prev.width) / 2, (size.height - prev.height) / 2));
    }
    // `fitAll` suit le contour pendant l'édition : seuls la feuille, l'étage et la taille doivent relancer cet effet.
  }, [fitKey, size.width, size.height, fitAll === null]);

  // L'outil, la taille ou la présentation (téléphone) changent : on mesure la place prise par l'interface du nouvel
  // outil, et si la vue était encore automatique — l'utilisateur ne l'a pas bougée — elle se recadre dans la place
  // libre ; sinon on n'y touche pas. Rien d'autre ne relance cet effet (pas les retouches du contour, ni un bandeau
  // qui change de hauteur en cours de geste : le plan ne doit pas bouger sous le doigt).
  const hasView = view !== null;
  const hudKey = `${tool}|${storey.id}|${sheet?.id ?? ''}`;
  const reframeNow = (): void => {
    const root = rootRef.current;
    if (!root || !hasView) return;
    const measured = compact ? measureHud(root) : null;
    setHud((prev) => (sameInsets(prev, measured) ? prev : measured));
    const kind = autoFit.current;
    const current = viewRef.current;
    if (!kind || !current) return;
    const focus = kind === 'focus' || (kind === 'auto' && preferFocus());
    const framed = fitOf(focus ? 'focus' : 'all', measured ?? staticInsets);
    // Une feuille ouverte en bas d'écran garde son décalage (voir `cover`).
    const target = framed ? panBy(framed, 0, -coverLift.current) : null;
    if (target && !sameView(current, target, 0.5)) setViewNow(target, kind);
  };
  const previousTool = useRef(tool);
  useLayoutEffect(() => {
    // Sur un écran étroit, chaque étape repart d'un plan cadré : un zoom fait à l'étape précédente laisserait
    // les façades hors de l'écran, sous une interface qui n'est plus la même. Sur un grand écran, la vue choisie
    // par l'utilisateur est gardée d'un outil à l'autre.
    if (compact && previousTool.current !== tool && autoFit.current === null) autoFit.current = 'auto';
    previousTool.current = tool;
    reframeNow();
  }, [hudKey, compact, size.width, size.height, hasView, staticInsets]);

  // Un outil vient de changer la TAILLE du contour par une saisie (longueur exacte d'un côté), pas par un geste :
  // il le signale (`reframe`), et la vue — si elle est encore automatique — se recadre dès que le nouveau contour
  // arrive, pour que rien ne passe sous l'interface.
  const reframeAsked = useRef(0);
  const reframe = useCallback(() => {
    reframeAsked.current = Date.now();
  }, []);
  useLayoutEffect(() => {
    const asked = reframeAsked.current;
    reframeAsked.current = 0;
    if (asked > 0 && Date.now() - asked < 1000) reframeNow();
    // Seul un nouveau contour doit relancer cet effet.
  }, [storey.outline]);

  useEffect(
    () => () => {
      if (frame.current) cancelAnimationFrame(frame.current);
    },
    [],
  );

  // ───────────── Fond <canvas> ─────────────

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const update = (): void => setDpr(window.devicePixelRatio || 1);
    update();
    const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    const scheme = window.matchMedia('(prefers-color-scheme: dark)');
    const pointer = window.matchMedia('(pointer: coarse)');
    const bump = (): void => setRedraw((n) => n + 1);
    const touch = (): void => setCoarse(pointer.matches);
    touch();
    mq.addEventListener('change', update);
    scheme.addEventListener('change', bump);
    pointer.addEventListener('change', touch);
    // Thème imposé par la page (data-theme sur la racine) : le fond dessiné relit ses couleurs quand il change.
    const themed = typeof MutationObserver === 'function' ? new MutationObserver(bump) : null;
    themed?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      mq.removeEventListener('change', update);
      scheme.removeEventListener('change', bump);
      pointer.removeEventListener('change', touch);
      themed?.disconnect();
    };
  }, [dpr]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const layer = new PlanCanvas(canvas);
    layer.onImageReady = () => setRedraw((n) => n + 1);
    canvasLayer.current = layer;
    return () => {
      layer.dispose();
      canvasLayer.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    const layer = canvasLayer.current;
    const root = rootRef.current;
    if (!layer || !root || !view || size.width <= 0 || size.height <= 0) return;
    layer.setSheet(sheet, index);
    layer.resize(size, dpr);
    const colors = readColors(root);
    // Même vue qu'au dernier dessin : autre chose a changé (feuille, thème, taille) → rendu complet d'emblée.
    const moving = lastDrawn.current !== null && lastDrawn.current !== view;
    lastDrawn.current = view;
    const pending = layer.draw(view, colors, moving);
    if (!pending) return;
    const timer = setTimeout(() => {
      if (viewRef.current) layer.draw(viewRef.current, readColors(root), false);
    }, 140);
    return () => clearTimeout(timer);
  }, [view, size, dpr, sheet, index, redraw]);

  const currentColors = useCallback((): CanvasColors => readColors(rootRef.current!), []);

  // ───────────── Navigation ─────────────

  const centre = (): Vec2 => ({ x: size.width / 2, y: size.height / 2 });

  const zoomBy = (factor: number, at?: Vec2): void => {
    if (viewRef.current) scheduleView(zoomAt(viewRef.current, at ?? centre(), factor, limitsRef.current));
  };

  const moveBy = (dx: number, dy: number): void => {
    if (viewRef.current) scheduleView(panBy(viewRef.current, dx, dy));
  };

  /** « Ajuster » : cadre le contour ; un second appui montre toute la feuille. */
  const fit = (): void => {
    const root = rootRef.current;
    if (!root || !viewRef.current) return;
    // Mesure fraîche : l'interface de l'outil a pu changer de hauteur depuis le dernier cadrage.
    const free = (compact ? measureHud(root) : null) ?? staticInsets;
    const all = fitOf('all', free);
    const focus = focusBox ? fitOf('focus', free) : null;
    if (!all) return;
    // « Ajuster » repart d'une vue propre : le décalage d'une feuille ouverte n'a plus à être rendu.
    coverLift.current = 0;
    if (focus && !sameView(viewRef.current, focus)) scheduleView(focus, 'focus');
    else scheduleView(all, 'all');
  };

  const focusSurface = useCallback(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  /** Les outils signalent le point visé : on ne montre la loupe que si un doigt ou un stylet est posé. */
  const aim = useCallback((point: Vec2 | null) => {
    const finger = coarseDown.current;
    setLoupe((prev) => {
      if (!point || !finger) return prev === null ? prev : null;
      if (prev && prev.point.x === point.x && prev.point.y === point.y && prev.finger.x === finger.x && prev.finger.y === finger.y) return prev;
      return { finger: { x: finger.x, y: finger.y }, point };
    });
  }, []);

  const endCoarse = (): void => {
    coarseDown.current = null;
    setLoupe(null);
  };

  // Molette et fin de toucher : écouteurs natifs non passifs (preventDefault doit pouvoir agir).
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent): void => {
      if (isUiTarget(e.target) || !viewRef.current) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const at = { x: e.clientX - r.left, y: e.clientY - r.top };
      scheduleView(zoomAt(viewRef.current, at, wheelZoomFactor(e.deltaY, e.deltaMode, e.ctrlKey), limitsRef.current));
    };
    // Toucher sur le plan : on annule le « clic fantôme » que le navigateur synthétise après le doigt levé —
    // il tomberait sur la bulle qui vient de s'ouvrir sous le doigt. Les événements de pointeur ne sont pas concernés.
    const onTouchEnd = (e: TouchEvent): void => {
      if (!isUiTarget(e.target) && e.cancelable) e.preventDefault();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchend', onTouchEnd);
    };
  }, [scheduleView]);

  // ───────────── Pointeurs ─────────────

  const localPoint = (e: { clientX: number; clientY: number }): Vec2 => {
    const r = rootRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const infoOf = (e: { pointerType?: string; altKey: boolean; shiftKey: boolean }, screen: Vec2): PointerInfo => ({
    screen,
    sheet: screenToSheet(viewRef.current!, screen),
    pointerType: e.pointerType ?? 'mouse',
    altKey: e.altKey,
    shiftKey: e.shiftKey,
  });

  const pinchState = (): { centre: Vec2; distance: number; a: number; b: number } | null => {
    const entries = [...pointers.current.entries()];
    if (entries.length < 2) return null;
    const [ia, pa] = entries[0]!;
    const [ib, pb] = entries[1]!;
    return { a: ia, b: ib, centre: { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 }, distance: Math.hypot(pa.x - pb.x, pa.y - pb.y) };
  };

  const abandonGesture = (): void => {
    const g = gesture.current;
    if (g && (g.kind === 'pending' || g.kind === 'drag')) g.session?.cancel();
    gesture.current = null;
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (isUiTarget(e.target) || !viewRef.current) return;
    const pt = localPoint(e);
    pointers.current.set(e.pointerId, pt);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Pointeur déjà relâché : sans conséquence.
    }
    // Le clavier suit le plan, sauf si le focus est déjà sur un élément du plan (façade, sommet…).
    const active = document.activeElement;
    if (!(active instanceof Element) || !e.currentTarget.contains(active) || isUiTarget(active)) focusSurface();

    if (pointers.current.size === 2) {
      // Deuxième doigt : tout geste en cours est abandonné, on pince.
      abandonGesture();
      endCoarse();
      controller.current?.hover?.(null);
      const p = pinchState();
      if (p) gesture.current = { kind: 'pinch', ...p };
      setPanning(true);
      return;
    }
    if (pointers.current.size > 2) return;

    if (e.button === 1 || (e.button === 0 && (spaceRef.current || tool === 'pan'))) {
      e.preventDefault();
      gesture.current = { kind: 'pan', id: e.pointerId, last: pt };
      setPanning(true);
      return;
    }
    if (e.button !== 0) return;
    const info = infoOf(e, pt);
    coarseDown.current = e.pointerType === 'mouse' ? null : pt;
    const session = controller.current?.dragStart?.(info) ?? null;
    gesture.current = { kind: 'pending', id: e.pointerId, start: pt, session };
    // Doigt ou stylet posé : on montre déjà où le point s'accrocherait.
    if (e.pointerType !== 'mouse') controller.current?.hover?.(info);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const current = viewRef.current;
    if (!current) return;
    const pt = localPoint(e);
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, pt);
    if (coarseDown.current && pointers.current.size === 1 && pointers.current.has(e.pointerId)) coarseDown.current = pt;
    const g = gesture.current;
    if (!g) {
      if (e.pointerType === 'mouse' && e.buttons === 0) controller.current?.hover?.(isUiTarget(e.target) ? null : infoOf(e, pt));
      return;
    }
    switch (g.kind) {
      case 'pinch': {
        const p = pinchState();
        if (!p) return;
        scheduleView(pinch(current, g, p, limitsRef.current));
        g.centre = p.centre;
        g.distance = p.distance;
        return;
      }
      case 'pan':
        if (e.pointerId !== g.id) return;
        scheduleView(panBy(current, pt.x - g.last.x, pt.y - g.last.y));
        g.last = pt;
        return;
      case 'pending': {
        if (e.pointerId !== g.id) return;
        const moved = Math.hypot(pt.x - g.start.x, pt.y - g.start.y);
        const threshold = e.pointerType === 'mouse' ? DRAG_THRESHOLD.mouse : DRAG_THRESHOLD.other;
        if (moved < threshold) {
          if (e.pointerType !== 'mouse') controller.current?.hover?.(infoOf(e, pt));
          return;
        }
        if (g.session) {
          gesture.current = { kind: 'drag', id: g.id, session: g.session };
          g.session.move(infoOf(e, pt));
        } else {
          // Glisser sur le vide : on déplace le plan.
          endCoarse();
          controller.current?.hover?.(null);
          gesture.current = { kind: 'pan', id: g.id, last: pt };
          setPanning(true);
          scheduleView(panBy(current, pt.x - g.start.x, pt.y - g.start.y));
        }
        return;
      }
      case 'drag':
        if (e.pointerId === g.id) g.session.move(infoOf(e, pt));
        return;
    }
  };

  const finishPointer = (e: ReactPointerEvent<HTMLDivElement>, cancelled: boolean): void => {
    const known = pointers.current.delete(e.pointerId);
    if (pointers.current.size === 0) endCoarse();
    const g = gesture.current;
    if (!g || !viewRef.current) return;
    const pt = localPoint(e);
    switch (g.kind) {
      case 'pinch': {
        if (!known) return;
        // Un doigt se lève : l'autre continue à déplacer le plan.
        const rest = [...pointers.current.entries()][0];
        gesture.current = rest ? { kind: 'pan', id: rest[0], last: rest[1] } : null;
        if (!rest) setPanning(false);
        return;
      }
      case 'pan':
        if (e.pointerId !== g.id) return;
        gesture.current = null;
        setPanning(false);
        return;
      case 'pending': {
        if (e.pointerId !== g.id) return;
        gesture.current = null;
        g.session?.cancel();
        if (e.pointerType !== 'mouse') controller.current?.hover?.(null);
        if (!cancelled) controller.current?.tap?.(infoOf(e, pt));
        return;
      }
      case 'drag':
        if (e.pointerId !== g.id) return;
        gesture.current = null;
        if (cancelled) g.session.cancel();
        else g.session.end(infoOf(e, pt));
        return;
    }
  };

  const onPointerLeave = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!gesture.current && e.pointerType === 'mouse') controller.current?.hover?.(null);
  };

  const onContextMenu = (e: ReactMouseEvent<HTMLDivElement>): void => {
    if (isUiTarget(e.target) || !viewRef.current) return;
    const handled = controller.current?.context?.(infoOf({ altKey: e.altKey, shiftKey: e.shiftKey }, localPoint(e))) ?? false;
    if (handled) {
      e.preventDefault();
      // Un appui long (tactile) ouvre l'action contextuelle : il ne doit pas compter en plus comme un toucher.
      abandonGesture();
    }
  };

  const onDoubleClick = (e: ReactMouseEvent<HTMLDivElement>): void => {
    if (tool !== 'pan' || isUiTarget(e.target)) return;
    zoomBy(e.shiftKey ? 0.5 : 2, localPoint(e));
  };

  // ───────────── Clavier ─────────────

  const keyInfo = (e: ReactKeyboardEvent): KeyInfo => ({ key: e.key, shiftKey: e.shiftKey, altKey: e.altKey, ctrlKey: e.ctrlKey || e.metaKey, repeat: e.repeat });

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (isUiTarget(e.target) || e.ctrlKey || e.metaKey) return;
    if (controller.current?.key?.(keyInfo(e))) {
      e.preventDefault();
      return;
    }
    const step = e.shiftKey ? 240 : 60;
    switch (e.key) {
      case 'ArrowLeft':
        moveBy(step, 0);
        break;
      case 'ArrowRight':
        moveBy(-step, 0);
        break;
      case 'ArrowUp':
        moveBy(0, step);
        break;
      case 'ArrowDown':
        moveBy(0, -step);
        break;
      case '+':
      case '=':
        zoomBy(1.4);
        break;
      case '-':
      case '_':
        zoomBy(1 / 1.4);
        break;
      case '0':
        fit();
        break;
      case ' ':
        spaceRef.current = true;
        setSpaceHeld(true);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const onKeyUp = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === ' ') {
      spaceRef.current = false;
      setSpaceHeld(false);
    }
    if (isUiTarget(e.target)) return;
    controller.current?.keyUp?.(keyInfo(e));
  };

  const onBlur = (): void => {
    spaceRef.current = false;
    setSpaceHeld(false);
    controller.current?.blur?.();
  };

  // ───────────── Rendu ─────────────

  const ghosts = useMemo(() => ghostStoreys ?? [], [ghostStoreys]);
  const toolKey = `${tool}|${storey.id}|${sheet?.id ?? ''}`;
  const ctx: ToolContext | null = view
    ? {
        view,
        size,
        sheet,
        index,
        storey,
        ghostStoreys: ghosts,
        northAngle: props.northAngle,
        lang,
        tr,
        windowTypes: props.windowTypes,
        compact,
        magnet,
        setMagnet,
        commit: onStoreyChange,
        done: () => onToolDone?.(tool),
        changeNorth: onNorthChange,
        coarse,
        aim,
        cover,
        reframe,
        controller,
        focusSurface,
      }
    : null;

  const classes = [
    'p2c-plan',
    compact ? 'is-compact' : '',
    panning ? 'is-panning' : '',
    spaceHeld || tool === 'pan' ? 'is-pan-ready' : '',
    props.className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      ref={rootRef}
      className={classes}
      data-tool={tool}
      data-testid="plan-editor"
      lang={lang}
      tabIndex={0}
      role="application"
      aria-label={tr('plan.aria.editor', { name: storey.name })}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => finishPointer(e, false)}
      onPointerCancel={(e) => finishPointer(e, true)}
      onPointerLeave={onPointerLeave}
      onContextMenu={onContextMenu}
      onDoubleClick={onDoubleClick}
      onMouseDown={(e) => {
        // Bouton du milieu : pas de défilement automatique du navigateur.
        if (e.button === 1 && !isUiTarget(e.target)) e.preventDefault();
      }}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onBlur={onBlur}
    >
      <canvas ref={canvasRef} className="p2c-plan__canvas" aria-hidden="true" />
      {ctx ? <ToolView key={toolKey} tool={tool} ctx={ctx} /> : null}
      {loupe && view ? (
        <Loupe sheet={sheet} index={index} colors={currentColors} finger={loupe.finger} point={loupe.point} view={view} size={size} dpr={dpr} />
      ) : null}
      <div className="p2c-plan__nav" data-p2c-ui="" role="group" aria-label={tr('plan.nav.group')}>
        {showPad ? (
          <div className="p2c-plan__pad">
            <button type="button" className="p2c-plan__navbtn p2c-plan__pad-up" onClick={() => moveBy(0, 120)} aria-label={tr('plan.nav.up')} title={tr('plan.nav.up')}>
              ↑
            </button>
            <button type="button" className="p2c-plan__navbtn p2c-plan__pad-left" onClick={() => moveBy(120, 0)} aria-label={tr('plan.nav.left')} title={tr('plan.nav.left')}>
              ←
            </button>
            <button type="button" className="p2c-plan__navbtn p2c-plan__pad-right" onClick={() => moveBy(-120, 0)} aria-label={tr('plan.nav.right')} title={tr('plan.nav.right')}>
              →
            </button>
            <button type="button" className="p2c-plan__navbtn p2c-plan__pad-down" onClick={() => moveBy(0, -120)} aria-label={tr('plan.nav.down')} title={tr('plan.nav.down')}>
              ↓
            </button>
          </div>
        ) : null}
        <div className="p2c-plan__navcol">
          <button type="button" className="p2c-plan__navbtn" onClick={() => zoomBy(1.4)} aria-label={tr('plan.nav.zoomIn')} title={tr('plan.nav.zoomIn')} data-testid="plan-zoom-in">
            +
          </button>
          <button type="button" className="p2c-plan__navbtn" onClick={() => zoomBy(1 / 1.4)} aria-label={tr('plan.nav.zoomOut')} title={tr('plan.nav.zoomOut')} data-testid="plan-zoom-out">
            −
          </button>
          <button type="button" className="p2c-plan__navbtn" onClick={fit} aria-label={tr('plan.nav.fit')} title={tr('plan.nav.fit')} data-testid="plan-fit">
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
              <path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            type="button"
            className="p2c-plan__navbtn"
            onClick={() => setShowPad((v) => !v)}
            aria-pressed={showPad}
            aria-label={tr('plan.nav.pad')}
            title={tr('plan.nav.pad')}
            data-testid="plan-pad"
          >
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
              <path d="M8 1.5v13M1.5 8h13M8 1.5 6 3.5M8 1.5l2 2M8 14.5l-2-2M8 14.5l2-2M1.5 8l2-2M1.5 8l2 2M14.5 8l-2-2M14.5 8l-2 2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
