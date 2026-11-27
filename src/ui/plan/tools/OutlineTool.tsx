/**
 * Outil « contour » : accepter ou corriger le contour proposé, ou le tracer point par point.
 * Rappel permanent : le trait suit la FACE EXTÉRIEURE des murs (tracer la face intérieure coûte ~17 % de surface).
 *
 * Longueurs exactes (dès que l'échelle est connue ; sur la grille vierge, 1 unité = 1 m) :
 *  - pendant le tracé, taper des chiffres (virgule ou point) puis Entrée pose le point suivant à cette distance dans
 *    la direction pointée ; une flèche le pose dans la direction de la flèche (tracé possible sans souris) ;
 *  - le « dernier côté » du tracé se corrige d'un toucher (champ que le clavier du téléphone remplit) ;
 *  - en correction, chaque longueur est une pastille : un toucher, un clic ou Entrée ouvre la saisie ; le sommet
 *    suivant glisse le long du côté et les angles sont conservés (voir `resizeSide`).
 */
import { useId, useRef, useState } from 'react';
import { isSelfIntersecting, polygonArea } from '../../../core/geometry';
import type { Storey, Vec2 } from '../../../core/types';
import { MIDPOINT_MIN_EDGE_PX, hitMidpoint, hitRadius, hitVertex } from '../hitTest';
import { Button, Counter, CounterButton, Hint, Popover } from '../hud';
import { hitLengthLabel, lengthLabels } from '../labels';
import type { LengthLabel } from '../labels';
import { formatDecimal, parseLengthMetres } from '../numbers';
import { dedupeOutline, deleteVertex, insertVertex, moveVertex, replaceOutline, resizeSide, setEdgeLength } from '../outlineOps';
import {
  EdgeLines,
  GhostOutlines,
  Label,
  LengthPills,
  MidpointHandles,
  OutlineFill,
  RightAngleMarks,
  SnapOverlay,
  VertexHandles,
  WallBand,
  outsideLabel,
  toPoints,
} from '../shapes';
import { dragGuides, traceGuides } from '../snapping';
import type { SnapResult } from '../snapping';
import {
  Actions,
  AreaCounters,
  BottomBar,
  CounterRow,
  Overlay,
  ScaleWarning,
  TopBar,
  blankGridStep,
  scaleIsGuess,
  snapPointer,
  useController,
} from '../toolShared';
import type { DragSession, PointerInfo, ToolContext, Translate } from '../toolTypes';
import { screenToSheet, sheetToScreen } from '../view';

type Mode = 'edit' | 'trace' | 'proposal';

/** Saisie d'une longueur exacte : un côté du contour, ou le dernier côté posé pendant le tracé. */
type LengthEdit = { target: 'edge'; edge: number; text: string } | { target: 'last'; text: string };

/** Épaisseur de mur figurée par la bande intérieure (m). */
const WALL_BAND_METRES = 0.4;
/** Bornes d'une longueur de côté saisie (m). */
const SIDE_LIMITS = { min: 0.01, max: 500 };
/** Nombre maximal de caractères d'une longueur tapée au vol pendant le tracé. */
const TYPED_MAX = 8;

const ARROWS: Record<string, Vec2> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
};

/** Longueur de côté saisie (m) : « 9,24 », « 9.24 », « 924 cm » ; null si illisible ou hors bornes. */
export function parseSideLength(text: string): number | null {
  const v = parseLengthMetres(text);
  return v !== null && v >= SIDE_LIMITS.min && v <= SIDE_LIMITS.max ? v : null;
}

function snapHint(tr: Translate, snap: SnapResult | null): string | null {
  if (!snap) return null;
  const parts: string[] = [];
  if (snap.kind === 'close') parts.push(tr('plan.snap.close'));
  else if (snap.kind === 'endpoint') parts.push(tr('plan.snap.endpoint'));
  else if (snap.kind === 'intersection') parts.push(tr('plan.snap.intersection'));
  else if (snap.kind === 'vertex') parts.push(tr('plan.snap.vertex'));
  // Les guides sur lesquels tombe le point : « angle droit », « dans l'axe », « aligné ».
  const kinds = new Set(snap.guides.map((g) => g.kind));
  if (kinds.has('ortho')) parts.push(tr('plan.snap.ortho'));
  if (kinds.has('straight')) parts.push(tr('plan.snap.straight'));
  if (kinds.has('align')) parts.push(tr('plan.snap.align'));
  return parts.length > 0 ? parts.join(' · ') : null;
}

export function OutlineTool({ ctx }: { ctx: ToolContext }) {
  const { storey, view, sheet, tr } = ctx;
  const clipId = useId().replace(/:/g, '');
  const detected = sheet?.detected.outline && sheet.detected.outline.length >= 3 ? sheet.detected.outline : null;

  const [mode, setMode] = useState<Mode>(() => (storey.outline.length >= 3 ? 'edit' : detected ? 'proposal' : 'trace'));
  const [trace, setTrace] = useState<Vec2[]>([]);
  const [hover, setHoverState] = useState<SnapResult | null>(null);
  const [draft, setDraft] = useState<Storey | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [menu, setMenu] = useState(false);
  const [moving, setMoving] = useState<number | null>(null);
  /** Longueur tapée au vol pendant le tracé (« 9,24 »). */
  const [typed, setTyped] = useState('');
  const [lengthEdit, setLengthEdit] = useState<LengthEdit | null>(null);
  const [hotLength, setHotLength] = useState<number | null>(null);
  const nudging = useRef(false);
  /** Pastille atteinte au clavier : elle reprend le clavier quand la saisie se referme. */
  const returnFocus = useRef<Element | null>(null);

  /** Affiche le point d'accrochage et le signale à l'éditeur (loupe du pointage tactile). */
  const show = (snap: SnapResult | null): void => {
    setHoverState(snap);
    ctx.aim(snap ? snap.point : null);
  };

  const hasStoreyOutline = storey.outline.length >= 3;
  // L'étage peut changer sous nos pieds (annuler/rétablir du shell) : le mode suit ce qui existe réellement.
  const effMode: Mode = mode === 'trace' ? 'trace' : hasStoreyOutline || (draft?.outline.length ?? 0) >= 3 ? 'edit' : detected ? 'proposal' : 'trace';

  const ghostVertices = ctx.ghostStoreys.flatMap((g) => g.outline);
  const mpu = storey.metresPerUnit.value;
  const approx = scaleIsGuess(storey);
  /** Les mètres sont fiables : on peut saisir une longueur. Avec une échelle supposée, il faut d'abord poser la règle. */
  const canType = !approx && mpu > 0;

  // ───────────── Saisie d'une longueur exacte ─────────────

  const editEdge = lengthEdit?.target === 'edge' && effMode === 'edit' && lengthEdit.edge < storey.outline.length ? lengthEdit : null;
  const editLast = lengthEdit?.target === 'last' && effMode === 'trace' && trace.length >= 2 ? lengthEdit : null;
  const lengthOpen = editEdge ?? editLast;
  const lengthValue = lengthOpen ? parseSideLength(lengthOpen.text) : null;
  const edgePreview = editEdge && lengthValue !== null ? resizeSide(storey.outline, editEdge.edge, lengthValue / mpu, true) : null;
  const lastPreview = editLast && lengthValue !== null ? resizeSide(trace, trace.length - 2, lengthValue / mpu, false) : null;
  /** Longueur lisible mais qui replierait le contour. */
  const lengthImpossible = lengthOpen !== null && lengthValue !== null && (editEdge ? edgePreview === null : lastPreview === null);

  const shown: Storey = draft ?? (editEdge && edgePreview ? { ...storey, outline: edgePreview } : storey);
  const hasOutline = shown.outline.length >= 3;
  const selectedIndex = selected !== null && selected < shown.outline.length ? selected : null;
  const shownTrace = lastPreview ?? trace;

  const pillOptions = { approx, along: ctx.compact };
  /** Pastilles du contour ENREGISTRÉ : ce sont elles qu'on touche (l'aperçu d'une saisie ne déplace pas la cible). */
  const storeyPills: LengthLabel[] = effMode === 'edit' ? lengthLabels(storey.outline, view, mpu, pillOptions) : [];
  const shownPills: LengthLabel[] = effMode === 'edit' ? (shown === storey ? storeyPills : lengthLabels(shown.outline, view, mpu, pillOptions)) : [];

  const closeLength = (): void => {
    setLengthEdit(null);
    const el = returnFocus.current;
    returnFocus.current = null;
    if (el instanceof SVGElement && el.isConnected) el.focus({ preventScroll: true });
    else ctx.focusSurface();
  };

  const openEdgeLength = (edge: number, from: Element | null): void => {
    const pill = storeyPills.find((l) => l.edge === edge);
    if (!canType || !pill) return;
    returnFocus.current = from;
    setSelected(null);
    setMenu(false);
    setMoving(null);
    setDraft(null);
    setHotLength(null);
    setLengthEdit({ target: 'edge', edge, text: formatDecimal(pill.metres, 2) });
  };

  const lastSideMetres = trace.length >= 2 ? Math.hypot(trace[trace.length - 1]!.x - trace[trace.length - 2]!.x, trace[trace.length - 1]!.y - trace[trace.length - 2]!.y) * mpu : 0;

  const openLastLength = (): void => {
    if (!canType || trace.length < 2) return;
    returnFocus.current = null;
    setTyped('');
    setLengthEdit({ target: 'last', text: formatDecimal(lastSideMetres, 2) });
  };

  const applyLength = (): void => {
    if (!lengthOpen || lengthValue === null) return;
    if (editEdge) {
      const pill = storeyPills.find((l) => l.edge === editEdge.edge);
      const next = setEdgeLength(storey, editEdge.edge, lengthValue);
      if (next === storey) return;
      if (!pill || Math.abs(pill.metres - lengthValue) > 1e-6) ctx.commit(next);
    } else if (lastPreview) {
      setTrace(lastPreview);
      show(null);
    } else return;
    closeLength();
  };

  /** Pastille de longueur sous le pointeur, sauf si une poignée (sommet, « + ») est plus directement visée. */
  const pickLength = (p: PointerInfo): number | null => {
    if (!canType || effMode !== 'edit') return null;
    const hit = hitLengthLabel(storeyPills, p.screen, p.pointerType === 'touch' ? 10 : 4);
    if (!hit) return null;
    let handle = Infinity;
    const n = storey.outline.length;
    for (let i = 0; i < n; i++) {
      const a = sheetToScreen(view, storey.outline[i]!);
      const b = sheetToScreen(view, storey.outline[(i + 1) % n]!);
      handle = Math.min(handle, Math.hypot(a.x - p.screen.x, a.y - p.screen.y));
      if (Math.hypot(b.x - a.x, b.y - a.y) >= MIDPOINT_MIN_EDGE_PX) {
        handle = Math.min(handle, Math.hypot((a.x + b.x) / 2 - p.screen.x, (a.y + b.y) / 2 - p.screen.y));
      }
    }
    // 7 px : le dessin de la poignée. Sur elle, c'est elle ; à côté, c'est la pastille.
    return hit.distance < handle - 7 ? hit.edge : null;
  };

  // ───────────── Tracé ─────────────

  const traceSnap = (p: PointerInfo): SnapResult =>
    snapPointer(ctx, p, {
      guides: traceGuides(trace),
      vertices: [...storey.outline, ...ghostVertices],
      closePoint: trace.length >= 3 ? trace[0]! : null,
    });

  const finishTrace = (points: readonly Vec2[]): void => {
    const pts = dedupeOutline(points, 0.5 / view.scale);
    if (pts.length < 3 || !(polygonArea(pts) > 0)) return;
    ctx.commit(replaceOutline(storey, pts));
    setTrace([]);
    setTyped('');
    setLengthEdit(null);
    show(null);
    setMode('edit');
    setSelected(null);
    ctx.done();
  };

  const undoPoint = (): void => {
    if (trace.length > 0) setTrace(trace.slice(0, -1));
    else if (storey.outline.length >= 3) setMode('edit');
    setTyped('');
    show(null);
  };

  const startTrace = (): void => {
    setMode('trace');
    setTrace([]);
    setTyped('');
    setLengthEdit(null);
    show(null);
    setSelected(null);
    setMenu(false);
    setMoving(null);
    ctx.focusSurface();
  };

  const cancelTrace = (): void => {
    setTrace([]);
    setTyped('');
    setLengthEdit(null);
    show(null);
    setMode('edit');
    ctx.focusSurface();
  };

  const typedMetres = typed !== '' && canType ? parseSideLength(typed) : null;

  /** Direction (unitaire) du dernier point vers un point visé ; null s'ils sont confondus à l'écran. */
  const directionTo = (target: Vec2 | null | undefined): Vec2 | null => {
    const last = trace[trace.length - 1];
    if (!last || !target) return null;
    const d = Math.hypot(target.x - last.x, target.y - last.y);
    return d * view.scale < 2 ? null : { x: (target.x - last.x) / d, y: (target.y - last.y) / d };
  };

  /** Point situé à la longueur tapée du dernier point, dans la direction donnée. */
  const typedPoint = (dir: Vec2 | null): Vec2 | null => {
    const last = trace[trace.length - 1];
    if (!last || !dir || typedMetres === null) return null;
    const units = typedMetres / mpu;
    return { x: last.x + dir.x * units, y: last.y + dir.y * units };
  };

  /** Ajoute un point au tracé ; s'il retombe sur le premier, le contour se ferme. */
  const addTracePoint = (point: Vec2): void => {
    const first = trace[0];
    setTyped('');
    if (first && trace.length >= 3 && Math.hypot(first.x - point.x, first.y - point.y) * view.scale < 2) {
      finishTrace(trace);
      return;
    }
    setTrace([...trace, point]);
  };

  /** Pose le point visé (ou ferme le contour s'il s'agit du premier point). */
  const placeTracePoint = (p: PointerInfo): void => {
    const s = traceSnap(p);
    // Une longueur est tapée : le clic ne donne que la direction.
    const exact = typedPoint(directionTo(s.point));
    if (exact) {
      addTracePoint(exact);
      show(p.pointerType === 'mouse' ? s : null);
      return;
    }
    if (s.kind === 'close') {
      finishTrace(trace);
      return;
    }
    const last = trace[trace.length - 1];
    // Second clic au même endroit (double-clic) : ignoré.
    if (last && Math.hypot(last.x - s.point.x, last.y - s.point.y) * view.scale < 2) return;
    setTrace([...trace, s.point]);
    setTyped('');
    show(p.pointerType === 'mouse' ? s : null);
  };

  /** Au clavier seul : le premier point se pose au centre de la vue (sur la grille de la feuille vierge). */
  const placeFirstPoint = (): void => {
    const c = screenToSheet(view, { x: ctx.size.width / 2, y: ctx.size.height / 2 });
    const step = sheet ? null : blankGridStep(view.scale);
    setTrace([step ? { x: Math.round(c.x / step) * step, y: Math.round(c.y / step) * step } : c]);
  };

  /** Au doigt ou au stylet : poser, glisser pour viser (la loupe montre le point), relâcher pour poser. */
  const aimSession = (): DragSession => ({
    move(p) {
      show(traceSnap(p));
    },
    end(p) {
      placeTracePoint(p);
    },
    cancel() {
      show(null);
    },
  });

  const traceKey = (key: string): boolean => {
    if (canType && trace.length >= 1 && (/^[0-9]$/.test(key) || key === ',' || key === '.')) {
      const separator = key === ',' || key === '.';
      if (typed.length < TYPED_MAX && !(separator && /[.,]/.test(typed))) setTyped(typed + (separator ? ',' : key));
      return true;
    }
    if (typed !== '') {
      if (key === 'Backspace') {
        setTyped(typed.slice(0, -1));
        return true;
      }
      if (key === 'Escape') {
        setTyped('');
        return true;
      }
      const arrow = ARROWS[key];
      if (key === 'Enter' || arrow) {
        // Entrée : dans la direction pointée ; flèche : dans la direction de la flèche.
        const point = typedPoint(arrow ?? directionTo(hover?.point));
        if (point) addTracePoint(point);
        return true;
      }
      return false;
    }
    if (key === 'Enter') {
      if (trace.length === 0) placeFirstPoint();
      else finishTrace(trace);
      return true;
    }
    if (key === 'Escape' || key === 'Backspace') {
      undoPoint();
      return true;
    }
    return false;
  };

  // ───────────── Correction ─────────────

  const vertexSession = (base: Storey, index: number): DragSession => {
    const guides = dragGuides(base.outline, index);
    let current = base;
    const apply = (p: PointerInfo): void => {
      const s = snapPointer(ctx, p, { guides, vertices: ghostVertices });
      current = moveVertex(base, index, s.point);
      setDraft(current);
      show(s);
    };
    return {
      move(p) {
        setSelected(index);
        setMenu(false);
        apply(p);
      },
      end(p) {
        apply(p);
        ctx.commit(current);
        setDraft(null);
        show(null);
        setSelected(index);
      },
      cancel() {
        setDraft(null);
        show(null);
      },
    };
  };

  const removeVertex = (index: number): void => {
    const next = deleteVertex(storey, index);
    if (next !== storey) ctx.commit(next);
    setSelected(null);
    setMenu(false);
    ctx.focusSurface();
  };

  const insertAt = (edge: number): void => {
    ctx.commit(insertVertex(storey, edge));
    setSelected(edge + 1);
    setMenu(false);
  };

  const commitNudge = (): void => {
    if (nudging.current && draft) ctx.commit(draft);
    nudging.current = false;
    setDraft(null);
  };

  useController(ctx, {
    dragStart(p) {
      if (effMode === 'trace') return lengthOpen || p.pointerType === 'mouse' ? null : aimSession();
      if (effMode !== 'edit' || moving !== null || lengthOpen) return null;
      if (pickLength(p) !== null) return null;
      const r = hitRadius(p.pointerType);
      const v = hitVertex(storey.outline, view, p.screen, r);
      if (v !== null) return vertexSession(storey, v);
      const m = hitMidpoint(storey.outline, view, p.screen, r);
      if (m !== null) return vertexSession(insertVertex(storey, m), m + 1);
      return null;
    },
    tap(p) {
      if (lengthOpen) {
        // Toucher à côté de la saisie : on la referme, sans rien poser ni déplacer.
        closeLength();
        return;
      }
      if (effMode === 'trace') {
        placeTracePoint(p);
        return;
      }
      if (effMode !== 'edit') return;
      if (moving !== null) {
        const s = snapPointer(ctx, p, { guides: dragGuides(storey.outline, moving), vertices: ghostVertices });
        ctx.commit(moveVertex(storey, moving, s.point));
        setDraft(null);
        show(null);
        setSelected(moving);
        setMoving(null);
        return;
      }
      const length = pickLength(p);
      if (length !== null) {
        openEdgeLength(length, null);
        return;
      }
      const r = hitRadius(p.pointerType);
      const v = hitVertex(storey.outline, view, p.screen, r);
      if (v !== null) {
        setSelected(v);
        setMenu(true);
        return;
      }
      const m = hitMidpoint(storey.outline, view, p.screen, r);
      if (m !== null) {
        insertAt(m);
        return;
      }
      setSelected(null);
      setMenu(false);
    },
    hover(p) {
      if (!p) {
        show(null);
        setHotLength(null);
        if (moving !== null) setDraft(null);
        return;
      }
      if (lengthOpen) return;
      if (effMode === 'trace') {
        show(traceSnap(p));
      } else if (effMode === 'edit' && moving !== null) {
        const s = snapPointer(ctx, p, { guides: dragGuides(storey.outline, moving), vertices: ghostVertices });
        setDraft(moveVertex(storey, moving, s.point));
        show(s);
      } else if (effMode === 'edit') {
        setHotLength(pickLength(p));
      }
    },
    context(p) {
      if (effMode !== 'edit' || lengthOpen) return false;
      const v = hitVertex(storey.outline, view, p.screen, hitRadius(p.pointerType));
      if (v === null) return false;
      setSelected(v);
      setMenu(true);
      return true;
    },
    key(e) {
      if (lengthOpen) {
        if (e.key !== 'Escape') return false;
        closeLength();
        return true;
      }
      if (effMode === 'trace') return traceKey(e.key);
      if (effMode !== 'edit') return false;
      if (e.key === 'Escape') {
        if (moving !== null || selectedIndex !== null || menu) {
          setMoving(null);
          setDraft(null);
          show(null);
          setSelected(null);
          setMenu(false);
          return true;
        }
        return false;
      }
      if (selectedIndex === null) return false;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        removeVertex(selectedIndex);
        return true;
      }
      const d = ARROWS[e.key];
      if (!d) return false;
      // Pas : 1 px écran (10 avec Maj) ; sur la feuille vierge, le pas de la grille.
      const step = sheet ? (e.shiftKey ? 10 : 1) / view.scale : blankGridStep(view.scale) * (e.shiftKey ? 10 : 1);
      const base = draft ?? storey;
      const cur = base.outline[selectedIndex]!;
      nudging.current = true;
      setMenu(false);
      setDraft(moveVertex(base, selectedIndex, { x: cur.x + d.x * step, y: cur.y + d.y * step }));
      return true;
    },
    keyUp(e) {
      if (e.key.startsWith('Arrow')) commitNudge();
    },
    blur() {
      if (nudging.current) commitNudge();
    },
  });

  // ───────────── Affichage ─────────────

  const bandPx = Math.min(48, Math.max(4, approx || !(mpu > 0) ? 8 : (WALL_BAND_METRES / mpu) * view.scale));
  const crossing = hasOutline && isSelfIntersecting(shown.outline);
  const magnetButton = (
    <Button onClick={() => ctx.setMagnet(!ctx.magnet)} pressed={ctx.magnet} title={tr('plan.magnet.title')} testId="plan-magnet">
      {tr('plan.magnet')}
    </Button>
  );

  /** Milieu (unités de feuille) du côté en cours de saisie : ce que la feuille du téléphone ne doit pas cacher. */
  const lengthFocus = ((): Vec2 | null => {
    const pts = editEdge ? storey.outline : editLast ? trace : null;
    if (!pts) return null;
    const i = editEdge ? editEdge.edge : pts.length - 2;
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    return a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : null;
  })();

  /** Bulle de saisie d'une longueur (feuille en bas d'écran sur téléphone : le clavier du téléphone la remplit). */
  const lengthPopover = (anchor: Vec2 | null) =>
    lengthOpen ? (
      <Popover
        key={lengthOpen.target === 'edge' ? `edge-${lengthOpen.edge}` : 'last'}
        anchor={anchor}
        size={ctx.size}
        compact={ctx.compact}
        label={lengthOpen.target === 'edge' ? tr('plan.outline.lengthTitle', { n: lengthOpen.edge + 1 }) : tr('plan.outline.lastSideTitle')}
        onClose={closeLength}
        className="p2c-plan__popover--length"
        testId="plan-length-popover"
        focus={lengthFocus}
        cover={ctx.cover}
      >
        <form
          className="p2c-plan__form"
          onSubmit={(e) => {
            e.preventDefault();
            applyLength();
          }}
        >
          <label className="p2c-plan__field">
            <span className="p2c-plan__popover-title">
              {lengthOpen.target === 'edge' ? tr('plan.outline.lengthTitle', { n: lengthOpen.edge + 1 }) : tr('plan.outline.lastSideTitle')}
            </span>
            <span className="p2c-plan__input-row">
              <input
                className="p2c-plan__input"
                type="text"
                inputMode="decimal"
                autoComplete="off"
                enterKeyHint="done"
                value={lengthOpen.text}
                placeholder="9,24"
                onChange={(e) => setLengthEdit({ ...lengthOpen, text: e.target.value })}
                aria-invalid={lengthValue === null || lengthImpossible}
                data-autofocus=""
                data-testid="plan-length-input"
              />
              <span className="p2c-plan__unit">m</span>
            </span>
          </label>
          {lengthValue === null ? (
            <p className="p2c-plan__note is-warn" role="alert">
              {tr('plan.outline.lengthInvalid')}
            </p>
          ) : lengthImpossible ? (
            <p className="p2c-plan__note is-warn" role="alert">
              {tr('plan.outline.lengthImpossible')}
            </p>
          ) : (
            <p className="p2c-plan__note">{tr(lengthOpen.target === 'edge' ? 'plan.outline.lengthNote' : 'plan.outline.lastSideNote')}</p>
          )}
          <div className="p2c-plan__form-actions">
            <button type="submit" className="p2c-plan__btn p2c-plan__btn--primary" disabled={lengthValue === null || lengthImpossible} data-testid="plan-length-apply">
              {tr('plan.outline.lengthApply')}
            </button>
            <Button onClick={closeLength}>{tr('plan.cancel')}</Button>
          </div>
        </form>
      </Popover>
    ) : null;

  if (effMode === 'proposal' && detected) {
    return (
      <>
        <Overlay ctx={ctx}>
          <GhostOutlines ghosts={ctx.ghostStoreys} view={view} />
          <polygon className="p2c-plan__proposal" points={toPoints(view, detected)} />
        </Overlay>
        <TopBar>
          <Hint tone="warn">{tr('plan.outline.proposal')}</Hint>
          <Actions>
            <Button
              variant="primary"
              testId="plan-outline-use"
              onClick={() => {
                ctx.commit(replaceOutline(storey, detected));
                setMode('edit');
                ctx.done();
                ctx.focusSurface();
              }}
            >
              {tr('plan.outline.useProposal')}
            </Button>
            <Button onClick={startTrace} testId="plan-outline-trace">
              {tr('plan.outline.traceMyself')}
            </Button>
          </Actions>
        </TopBar>
      </>
    );
  }

  if (effMode === 'trace') {
    const points = shownTrace;
    const last = points[points.length - 1] ?? null;
    const pointed = directionTo(hover?.point);
    // Une longueur est tapée : le trait élastique montre exactement cette longueur dans la direction pointée.
    const exactTip = editLast ? null : typedPoint(pointed);
    const tip = editLast ? null : (exactTip ?? hover?.point ?? null);
    const preview = tip ? [...points, tip] : points;
    const previewStorey: Storey = { ...storey, outline: preview };
    const rubber =
      last && tip
        ? (() => {
            const a = sheetToScreen(view, last);
            const b = sheetToScreen(view, tip);
            const px = Math.hypot(b.x - a.x, b.y - a.y);
            const metres = (px / view.scale) * mpu;
            // Étiquette du côté « haut / gauche » du trait, pour ne pas la poser sur lui.
            let normal = px > 0 ? { x: (b.y - a.y) / px, y: -(b.x - a.x) / px } : { x: 0, y: -1 };
            if (normal.y > 0.01 || (Math.abs(normal.y) <= 0.01 && normal.x > 0)) normal = { x: -normal.x, y: -normal.y };
            return { a, b, px, metres, normal, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
          })()
        : null;
    const first = points[0] ? sheetToScreen(view, points[0]) : null;
    const tipScreen = tip ? sheetToScreen(view, tip) : null;
    const lastScreen = last ? sheetToScreen(view, last) : null;
    const placedPills = lengthLabels(points, view, mpu, { ...pillOptions, closed: false });
    const lastSegment = points.length >= 2 ? { a: sheetToScreen(view, points[points.length - 2]!), b: sheetToScreen(view, points[points.length - 1]!) } : null;
    return (
      <>
        <Overlay ctx={ctx}>
          <GhostOutlines ghosts={ctx.ghostStoreys} view={view} />
          {storey.outline.length >= 3 ? <polygon className="p2c-plan__previous" points={toPoints(view, storey.outline)} /> : null}
          {preview.length >= 3 ? <polygon className="p2c-plan__fill p2c-plan__fill--draft" points={toPoints(view, preview)} /> : null}
          {points.length >= 2 ? <polyline className="p2c-plan__edge p2c-plan__trace" points={toPoints(view, points)} /> : null}
          <RightAngleMarks outline={preview} view={view} closed={false} />
          <LengthPills labels={placedPills} active={editLast ? points.length - 2 : null} />
          {rubber ? <line className="p2c-plan__rubber" x1={rubber.a.x} y1={rubber.a.y} x2={rubber.b.x} y2={rubber.b.y} /> : null}
          {first && tipScreen && points.length >= 2 ? (
            <line className="p2c-plan__rubber p2c-plan__rubber--closing" x1={tipScreen.x} y1={tipScreen.y} x2={first.x} y2={first.y} />
          ) : null}
          {points.map((p, i) => {
            const s = sheetToScreen(view, p);
            const closing = i === 0 && points.length >= 3;
            return <circle key={i} className={`p2c-plan__vertex ${closing ? 'is-closing' : ''}`} cx={s.x} cy={s.y} r={closing ? 7.5 : 4.5} />;
          })}
          {editLast ? null : <SnapOverlay snap={hover} view={view} size={ctx.size} hint={typed === '' ? snapHint(tr, hover) : null} />}
          {typed !== '' && lastScreen ? (
            // Longueur en cours de frappe : près du trait élastique s'il y a une direction, sinon près du dernier point.
            rubber && exactTip ? (
              <Label {...outsideLabel(rubber.mid, rubber.normal, 10)} className="p2c-plan__label--live p2c-plan__label--typed">
                {tr('plan.outline.typedPointed', { length: typed })}
              </Label>
            ) : (
              <Label x={lastScreen.x + 12} y={lastScreen.y - 16} anchor="start" className="p2c-plan__label--live p2c-plan__label--typed">
                {tr(typedMetres === null ? 'plan.outline.typedInvalid' : 'plan.outline.typedArrow', { length: typed })}
              </Label>
            )
          ) : rubber && rubber.px > 28 ? (
            <Label {...outsideLabel(rubber.mid, rubber.normal, 10)} className="p2c-plan__label--live">
              {(approx ? '≈ ' : '') + formatDecimal(rubber.metres, 2) + ' m'}
            </Label>
          ) : null}
        </Overlay>
        <TopBar>
          <Hint tone="warn" icon="▣">
            <strong>{tr('plan.outline.outerFaceTrace')}</strong>
            {ctx.coarse ? (
              <span className="p2c-plan__hint-sub"> {tr(ctx.compact ? 'plan.touch.aimShort' : 'plan.touch.aim')}</span>
            ) : ctx.compact ? null : (
              <span className="p2c-plan__hint-sub">
                {' '}
                {tr(trace.length === 0 ? 'plan.outline.traceKeysFirst' : canType ? 'plan.outline.traceKeys' : 'plan.outline.traceKeysNoScale')}
              </span>
            )}
          </Hint>
          <Actions>
            <Button onClick={undoPoint} disabled={trace.length === 0} title={tr('plan.outline.undoPoint')} testId="plan-trace-undo">
              {tr(ctx.compact ? 'plan.outline.undoPointShort' : 'plan.outline.undoPoint')}
            </Button>
            <Button variant="primary" onClick={() => finishTrace(trace)} disabled={trace.length < 3} title={tr('plan.outline.close')} testId="plan-trace-close">
              {tr(ctx.compact ? 'plan.outline.closeShort' : 'plan.outline.close')}
            </Button>
            {storey.outline.length >= 3 ? (
              <Button onClick={cancelTrace} testId="plan-trace-cancel">
                {tr('plan.cancel')}
              </Button>
            ) : null}
            {magnetButton}
          </Actions>
        </TopBar>
        {lengthPopover(lastSegment ? { x: (lastSegment.a.x + lastSegment.b.x) / 2, y: (lastSegment.a.y + lastSegment.b.y) / 2 } : null)}
        <BottomBar>
          <CounterRow ctx={ctx}>
            <Counter label={tr('plan.counter.points')} value={String(points.length)} />
            {canType && trace.length >= 2 ? (
              <CounterButton
                label={tr('plan.outline.lastSide')}
                value={formatDecimal(lastSideMetres, 2)}
                unit="m"
                ariaLabel={tr('plan.outline.lastSideAria', { length: formatDecimal(lastSideMetres, 2) })}
                onClick={openLastLength}
                testId="plan-trace-last-length"
              />
            ) : null}
            <AreaCounters ctx={ctx} storey={previewStorey} secondary />
            <ScaleWarning ctx={ctx} storey={storey} />
          </CounterRow>
        </BottomBar>
      </>
    );
  }

  // Mode correction.
  const selectedScreen = selectedIndex !== null ? sheetToScreen(view, shown.outline[selectedIndex]!) : null;
  const editedPill = editEdge ? (storeyPills.find((l) => l.edge === editEdge.edge) ?? null) : null;
  const lengthHint = canType && storeyPills.length > 0;
  return (
    <>
      <Overlay ctx={ctx}>
        <GhostOutlines ghosts={ctx.ghostStoreys} view={view} />
        <OutlineFill outline={shown.outline} view={view} className={crossing ? 'is-invalid' : ''} />
        <WallBand outline={shown.outline} view={view} widthPx={bandPx} id={`p2c-band-${clipId}`} />
        <EdgeLines outline={shown.outline} edges={shown.edges} view={view} className="p2c-plan__edge--outline" highlight={editEdge ? editEdge.edge : null} />
        <RightAngleMarks outline={shown.outline} view={view} closed />
        {draft === null && moving === null && !editEdge ? (
          <MidpointHandles outline={shown.outline} view={view} label={(e) => tr('plan.outline.insertAria', { n: e + 1 })} activate={insertAt} />
        ) : null}
        <LengthPills
          labels={shownPills}
          hot={hotLength}
          active={editEdge ? editEdge.edge : null}
          interaction={
            canType
              ? {
                  label: (l) => tr('plan.outline.lengthAria', { n: l.edge + 1, length: formatDecimal(l.metres, 2) }),
                  activate: (edge) => openEdgeLength(edge, typeof document === 'undefined' ? null : document.activeElement),
                }
              : undefined
          }
        />
        <VertexHandles
          outline={shown.outline}
          view={view}
          selected={selectedIndex}
          label={(i) => tr('plan.outline.vertexAria', { n: i + 1, count: shown.outline.length })}
          onFocus={(i) => setSelected(i)}
        />
        <SnapOverlay snap={hover} view={view} size={ctx.size} hint={snapHint(tr, hover)} />
      </Overlay>
      <TopBar>
        <Hint tone="warn" icon="▣">
          {moving !== null ? (
            tr('plan.outline.moveHint')
          ) : (
            <>
              <strong>{tr(ctx.compact ? 'plan.outline.outerFaceShort' : 'plan.outline.outerFaceEdit')}</strong>
              {ctx.compact || ctx.coarse ? (
                // Sur la grille vierge, saisir les longueurs EST la façon de tracer juste : on le dit même sur téléphone.
                lengthHint && (!ctx.compact || !sheet) ? (
                  <span className="p2c-plan__hint-sub"> {tr('plan.outline.lengthTap')}</span>
                ) : null
              ) : (
                <span className="p2c-plan__hint-sub"> {tr(lengthHint ? 'plan.outline.editKeys' : 'plan.outline.editKeysNoScale')}</span>
              )}
            </>
          )}
        </Hint>
        <Actions>
          <Button variant="primary" onClick={() => ctx.done()} testId="plan-outline-accept">
            {tr('plan.outline.accept')}
          </Button>
          <Button onClick={startTrace} testId="plan-outline-redraw">
            {tr('plan.outline.redraw')}
          </Button>
          {magnetButton}
        </Actions>
      </TopBar>
      {menu && selectedIndex !== null && selectedScreen && moving === null && !editEdge ? (
        <Popover
          anchor={selectedScreen}
          size={ctx.size}
          compact={false}
          label={tr('plan.outline.vertexAria', { n: selectedIndex + 1, count: shown.outline.length })}
          onClose={() => setMenu(false)}
          className="p2c-plan__popover--menu"
          testId="plan-vertex-menu"
          passive
        >
          <Button
            onClick={() => {
              setMoving(selectedIndex);
              setMenu(false);
              ctx.focusSurface();
            }}
            testId="plan-vertex-move"
          >
            {tr('plan.outline.moveVertex')}
          </Button>
          <Button variant="danger" onClick={() => removeVertex(selectedIndex)} disabled={shown.outline.length <= 3} testId="plan-vertex-delete">
            {tr('plan.outline.deleteVertex')}
          </Button>
        </Popover>
      ) : null}
      {lengthPopover(editedPill ? { x: editedPill.x, y: editedPill.y } : null)}
      <BottomBar>
        {crossing ? <Hint tone="warn">{tr('plan.outline.selfIntersecting')}</Hint> : null}
        <CounterRow ctx={ctx}>
          <AreaCounters ctx={ctx} storey={shown} />
          <ScaleWarning ctx={ctx} storey={shown} />
        </CounterRow>
      </BottomBar>
    </>
  );
}
