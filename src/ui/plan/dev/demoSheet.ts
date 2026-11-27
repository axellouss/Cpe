/**
 * Feuille de démonstration synthétique (banc d'essai et tests de l'éditeur) : une maison en L de 13,50 × 8,50 m,
 * murs de 40 cm, dessinée en CENTIMÈTRES (1 unité de feuille = 1 cm). Rien ici n'est utilisé en production.
 */
import type { DetectedOpening, DetectedRoom, PlanSheet, PlanText, Vec2 } from '../../../core/types';

/** Décalage de la maison dans la feuille (cm). */
export const DEMO_ORIGIN: Vec2 = { x: 300, y: 260 };
export const DEMO_METRES_PER_UNIT = 0.01;

function at(x: number, y: number): Vec2 {
  return { x: x + DEMO_ORIGIN.x, y: y + DEMO_ORIGIN.y };
}

/** Face EXTÉRIEURE des murs (cm, sens horaire à l'écran). Surface brute : 13,5 × 5 + 8 × 3,5 = 95,50 m². */
export const DEMO_OUTLINE: Vec2[] = [at(0, 0), at(1350, 0), at(1350, 500), at(800, 500), at(800, 850), at(0, 850)];

/** Face intérieure (le piège : la tracer à la place de l'extérieure fait perdre ~17 % de surface). */
export const DEMO_INNER: Vec2[] = [at(40, 40), at(1310, 40), at(1310, 460), at(760, 460), at(760, 810), at(40, 810)];

function rectangle(x0: number, y0: number, x1: number, y1: number): Vec2[] {
  return [at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1)];
}

export const DEMO_ROOMS: DetectedRoom[] = [
  { name: 'Séjour', statedArea: 19.32, polygon: rectangle(40, 40, 500, 460), at: at(270, 250), heatedGuess: 'yes' },
  { name: 'Cuisine', statedArea: 11.76, polygon: rectangle(510, 40, 790, 460), at: at(650, 250), heatedGuess: 'yes' },
  { name: 'Garage', statedArea: 21.42, polygon: rectangle(800, 40, 1310, 460), at: at(1055, 250), heatedGuess: 'no' },
  { name: 'Chambre', statedArea: 15.64, polygon: rectangle(40, 470, 500, 810), at: at(270, 640), heatedGuess: 'yes' },
  { name: 'Buanderie', statedArea: 6.25, polygon: rectangle(510, 560, 760, 810), at: at(635, 685), heatedGuess: 'ask' },
  { name: 'Hall', statedArea: 2.25, at: at(635, 512), heatedGuess: 'yes' },
];

export const DEMO_OPENINGS: DetectedOpening[] = [
  { kind: 'window', a: at(160, 0), b: at(340, 0), width: 1.8, exterior: true },
  { kind: 'window', a: at(580, 0), b: at(700, 0), width: 1.2, height: 1.35, exterior: true },
  { kind: 'door', a: at(600, 850), b: at(700, 850), width: 1.0, exterior: true },
];

function pushLine(out: number[], a: Vec2, b: Vec2): void {
  out.push(a.x, a.y, b.x, b.y);
}

function pushLoop(out: number[], pts: readonly Vec2[]): void {
  for (let i = 0; i < pts.length; i++) pushLine(out, pts[i]!, pts[(i + 1) % pts.length]!);
}

/** Traits de la maison : deux faces de murs, cloisons, fenêtres, cotes, un peu de mobilier. */
export function demoSegments(): Float32Array {
  const s: number[] = [];
  pushLoop(s, DEMO_OUTLINE);
  pushLoop(s, DEMO_INNER);
  // Cloisons (deux faces, 10 cm).
  pushLine(s, at(500, 40), at(500, 810));
  pushLine(s, at(510, 40), at(510, 810));
  pushLine(s, at(790, 40), at(790, 460));
  pushLine(s, at(800, 40), at(800, 460));
  pushLine(s, at(40, 460), at(500, 460));
  pushLine(s, at(40, 470), at(500, 470));
  pushLine(s, at(510, 550), at(760, 550));
  pushLine(s, at(510, 560), at(760, 560));
  // Fenêtres : deux tableaux et un trait de vitrage au milieu du mur.
  for (const o of DEMO_OPENINGS) {
    const horizontal = Math.abs(o.a.y - o.b.y) < 1e-6;
    const inward = o.a.y - DEMO_ORIGIN.y < 1 ? 40 : -40;
    if (!horizontal) continue;
    pushLine(s, o.a, { x: o.a.x, y: o.a.y + inward });
    pushLine(s, o.b, { x: o.b.x, y: o.b.y + inward });
    if (o.kind === 'window') pushLine(s, { x: o.a.x, y: o.a.y + inward / 2 }, { x: o.b.x, y: o.b.y + inward / 2 });
  }
  // Cotes extérieures : 13,50 en haut, 8,50 à gauche, 5,50 (aile) en bas à droite.
  const dim = (a: Vec2, b: Vec2, tick: Vec2): void => {
    pushLine(s, a, b);
    pushLine(s, { x: a.x - tick.x, y: a.y - tick.y }, { x: a.x + tick.x, y: a.y + tick.y });
    pushLine(s, { x: b.x - tick.x, y: b.y - tick.y }, { x: b.x + tick.x, y: b.y + tick.y });
  };
  dim(at(0, -110), at(1350, -110), { x: 0, y: 14 });
  dim(at(-110, 0), at(-110, 850), { x: 14, y: 0 });
  dim(at(800, 610), at(1350, 610), { x: 0, y: 14 });
  // Mobilier : un lit, une table, un escalier (traits parasites pour l'accrochage).
  pushLoop(s, rectangle(70, 600, 270, 790));
  pushLoop(s, rectangle(180, 170, 360, 290));
  for (let i = 0; i <= 8; i++) pushLine(s, at(540 + i * 22, 470), at(540 + i * 22, 545));
  // Battant de porte (arc discrétisé).
  const hinge = at(600, 810);
  let prev: Vec2 | null = null;
  for (let k = 0; k <= 10; k++) {
    const a = (k / 10) * (Math.PI / 2);
    const p = { x: hinge.x + Math.cos(a) * 100, y: hinge.y - Math.sin(a) * 100 };
    if (prev) pushLine(s, prev, p);
    prev = p;
  }
  return new Float32Array(s);
}

export function demoTexts(): PlanText[] {
  const texts: PlanText[] = [
    { text: 'REZ-DE-CHAUSSÉE — Échelle 1:100', x: DEMO_ORIGIN.x, y: DEMO_ORIGIN.y - 190, height: 34 },
    { text: '13.50', x: DEMO_ORIGIN.x + 640, y: DEMO_ORIGIN.y - 122, height: 22 },
    { text: '8.50', x: DEMO_ORIGIN.x - 190, y: DEMO_ORIGIN.y + 430, height: 22 },
    { text: '5.50', x: DEMO_ORIGIN.x + 1040, y: DEMO_ORIGIN.y + 598, height: 22 },
  ];
  for (const r of DEMO_ROOMS) {
    if (!r.at) continue;
    texts.push({ text: r.name, x: r.at.x - 60, y: r.at.y - 40, height: 24 });
    if (r.statedArea) texts.push({ text: `${r.statedArea.toFixed(2).replace('.', ',')} m²`, x: r.at.x - 60, y: r.at.y - 10, height: 18 });
  }
  return texts;
}

export interface DemoOptions {
  /** Échelle connue du lecteur (défaut : oui, « lue sur le plan »). */
  scaleKnown?: boolean;
  /** Le lecteur propose un contour (défaut : oui). */
  withOutline?: boolean;
  /** Nombre de traits parasites supplémentaires (essai de charge). */
  extraSegments?: number;
}

/** Petit générateur pseudo-aléatoire déterministe (mulberry32). */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function demoSheet(options: DemoOptions = {}): PlanSheet {
  const base = demoSegments();
  const extra = Math.max(0, options.extraSegments ?? 0);
  let segments = base;
  let bbox = { minX: 0, minY: 0, maxX: DEMO_ORIGIN.x + 1350 + 300, maxY: DEMO_ORIGIN.y + 850 + 260 };
  if (extra > 0) {
    // Essai de charge : hachures et détails répartis sur une grande feuille autour de la maison.
    const rnd = random(42);
    bbox = { minX: 0, minY: 0, maxX: 6000, maxY: 4200 };
    segments = new Float32Array(base.length + extra * 4);
    segments.set(base, 0);
    for (let i = 0; i < extra; i++) {
      const x = rnd() * 6000;
      const y = rnd() * 4200;
      const len = 6 + rnd() * 50;
      const horizontal = rnd() < 0.5;
      const o = base.length + i * 4;
      segments[o] = x;
      segments[o + 1] = y;
      segments[o + 2] = horizontal ? x + len : x + (rnd() - 0.5) * 8;
      segments[o + 3] = horizontal ? y + (rnd() - 0.5) * 8 : y + len;
    }
  }
  return {
    id: extra > 0 ? `demo-stress-${extra}` : 'demo',
    name: 'Rez-de-chaussée',
    bbox,
    segments,
    texts: demoTexts(),
    metresPerUnit: options.scaleKnown === false ? null : { value: DEMO_METRES_PER_UNIT, from: 'plan', note: 'Échelle 1:100 lue dans le titre' },
    detected: {
      ...(options.withOutline === false ? {} : { outline: DEMO_OUTLINE.map((p) => ({ ...p })) }),
      rooms: DEMO_ROOMS.map((r) => ({ ...r })),
      openings: DEMO_OPENINGS.map((o) => ({ ...o })),
      notes: [],
    },
  };
}
