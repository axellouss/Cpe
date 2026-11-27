/**
 * Loupe du pointage tactile : le doigt cache le point qu'il vise, la loupe le montre agrandi, à côté.
 * Elle redessine le fond de plan autour du point ACCROCHÉ et y pose un réticule ; la recherche menée pour ce
 * projet chiffre à un facteur 3 le gain de précision de l'accrochage combiné à une loupe.
 */
import { useEffect, useRef, useState } from 'react';
import type { PlanSheet, Vec2 } from '../../core/types';
import { PlanCanvas } from './canvasLayer';
import type { CanvasColors } from './canvasLayer';
import type { SnapIndex } from './snapIndex';
import type { Size, View } from './view';

const DIAMETER = 128;
const MAGNIFICATION = 2.6;

/** Coin haut-gauche de la loupe : au-dessus du doigt si la place le permet, sinon sur le côté opposé au bord. */
export function loupePosition(finger: Vec2, size: Size, diameter = DIAMETER): Vec2 {
  const clampX = (x: number): number => Math.min(Math.max(4, x), Math.max(4, size.width - diameter - 4));
  const clampY = (y: number): number => Math.min(Math.max(4, y), Math.max(4, size.height - diameter - 4));
  const above = finger.y - diameter - 52;
  if (above >= 4) return { x: clampX(finger.x - diameter / 2), y: above };
  const side = finger.x > size.width / 2 ? finger.x - diameter - 56 : finger.x + 56;
  return { x: clampX(side), y: clampY(finger.y - diameter / 2) };
}

export function Loupe(props: {
  sheet: PlanSheet | null;
  index: SnapIndex | null;
  colors(): CanvasColors;
  finger: Vec2;
  point: Vec2;
  view: View;
  size: Size;
  dpr: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const layer = useRef<PlanCanvas | null>(null);
  const [, setLoaded] = useState(0);
  const { sheet, index, colors, finger, point, view, size, dpr } = props;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const created = new PlanCanvas(canvas);
    // Fond matriciel : la loupe se redessine dès que l'image est disponible.
    created.onImageReady = () => setLoaded((n) => n + 1);
    layer.current = created;
    return () => {
      created.dispose();
      layer.current = null;
    };
  }, []);

  useEffect(() => {
    const canvas = ref.current;
    const plan = layer.current;
    if (!canvas || !plan) return;
    // Le plan est REDESSINÉ à l'échelle de la loupe (traits nets), centré sur le point accroché.
    const scale = view.scale * MAGNIFICATION;
    const c = DIAMETER / 2;
    plan.setSheet(sheet, index);
    plan.resize({ width: DIAMETER, height: DIAMETER }, dpr);
    plan.draw({ scale, tx: c - point.x * scale, ty: c - point.y * scale }, colors(), false);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // Réticule : le centre de la loupe EST le point qui sera posé.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = getComputedStyle(canvas).getPropertyValue('--_snap').trim() || '#c2187a';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(c - 26, c);
    ctx.lineTo(c - 7, c);
    ctx.moveTo(c + 7, c);
    ctx.lineTo(c + 26, c);
    ctx.moveTo(c, c - 26);
    ctx.lineTo(c, c - 7);
    ctx.moveTo(c, c + 7);
    ctx.lineTo(c, c + 26);
    ctx.stroke();
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(c, c, 5, 0, Math.PI * 2);
    ctx.stroke();
  });

  const at = loupePosition(finger, size);
  return <canvas ref={ref} className="p2c-plan__loupe" style={{ left: at.x, top: at.y, width: DIAMETER, height: DIAMETER }} aria-hidden="true" />;
}
