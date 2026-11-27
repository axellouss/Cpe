/**
 * Banc d'essai de l'éditeur de plan (développement uniquement, hors build de production).
 * Ouvrir /src/ui/plan/dev/harness.html avec le serveur Vite. Paramètres d'URL :
 *   tool=pan|scale|outline|boundary|opening|north|rooms   lang=fr|de
 *   sheet=demo|noscale|blank|image|stress   n=150000 (traits de l'essai de charge)
 *   outline=none (étage sans contour : le contour détecté est seulement proposé)   ghost=1   north=30
 * L'état courant est exposé dans window.__p2c pour les essais automatisés.
 */
import { StrictMode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Lang, PlanSheet, Storey } from '../../../core/types';
import { createEmptyProject, createStorey } from '../../../engine';
import { PlanEditor } from '../index';
import type { PlanTool } from '../index';
import { DEMO_OUTLINE, demoSheet } from './demoSheet';

const TOOLS: PlanTool[] = ['pan', 'scale', 'outline', 'boundary', 'opening', 'north', 'rooms'];

interface Exposed {
  storey: Storey;
  northAngle: number;
  done: PlanTool[];
  changes: number;
  northChanges: number;
}

declare global {
  interface Window {
    __p2c?: Exposed;
  }
}

/** Rend les traits dans une image (fond matriciel de l'essai « image »). */
function rasterise(sheet: PlanSheet): string {
  const w = sheet.bbox.maxX - sheet.bbox.minX;
  const h = sheet.bbox.maxY - sheet.bbox.minY;
  const k = 1.2;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * k);
  canvas.height = Math.round(h * k);
  const c = canvas.getContext('2d')!;
  c.fillStyle = '#fffdf6';
  c.fillRect(0, 0, canvas.width, canvas.height);
  c.strokeStyle = '#222';
  c.lineWidth = 2;
  c.beginPath();
  const s = sheet.segments ?? new Float32Array();
  for (let i = 0; i + 3 < s.length; i += 4) {
    c.moveTo((s[i]! - sheet.bbox.minX) * k, (s[i + 1]! - sheet.bbox.minY) * k);
    c.lineTo((s[i + 2]! - sheet.bbox.minX) * k, (s[i + 3]! - sheet.bbox.minY) * k);
  }
  c.stroke();
  c.fillStyle = '#222';
  for (const t of sheet.texts ?? []) {
    c.font = `${(t.height ?? 20) * k}px sans-serif`;
    c.fillText(t.text, (t.x - sheet.bbox.minX) * k, (t.y - sheet.bbox.minY) * k);
  }
  return canvas.toDataURL('image/png');
}

function buildSheet(kind: string, n: number): PlanSheet | null {
  if (kind === 'blank') return null;
  if (kind === 'noscale') return demoSheet({ scaleKnown: false });
  if (kind === 'stress') return demoSheet({ extraSegments: n });
  if (kind === 'image') {
    const sheet = demoSheet({ scaleKnown: false });
    const { minX, minY, maxX, maxY } = sheet.bbox;
    // Image seule, sans traits ni textes : comme un plan scanné.
    return { ...sheet, id: 'demo-image', image: { url: rasterise(sheet), x: minX, y: minY, width: maxX - minX, height: maxY - minY }, segments: undefined, texts: undefined };
  }
  if (kind === 'imagevec') {
    const sheet = demoSheet();
    const { minX, minY, maxX, maxY } = sheet.bbox;
    return { ...sheet, id: 'demo-imagevec', image: { url: rasterise(sheet), x: minX, y: minY, width: maxX - minX, height: maxY - minY } };
  }
  return demoSheet();
}

function Harness() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const [lang, setLang] = useState<Lang>(params.get('lang') === 'de' ? 'de' : 'fr');
  const [tool, setTool] = useState<PlanTool>((TOOLS.find((x) => x === params.get('tool')) ?? 'outline') as PlanTool);
  const sheet = useMemo(() => buildSheet(params.get('sheet') ?? 'demo', Number(params.get('n') ?? 150000)), [params]);
  const model = useMemo(() => {
    const m = createEmptyProject('fr').model;
    // Un second type de fenêtre, pour voir la liste de choix.
    return { ...m, windowTypes: [...m.windowTypes, { id: 'window-roof', name: 'Fenêtre de toit', uw: null, g: null }] };
  }, []);
  const initial = useMemo(() => {
    const s = createStorey(sheet, 'Rez-de-chaussée', model);
    return params.get('outline') === 'none' ? { ...s, outline: [], edges: [], openings: [] } : s;
  }, [sheet, model, params]);
  const [history, setHistory] = useState<Storey[]>([initial]);
  const [north, setNorth] = useState(Number(params.get('north') ?? 0));
  const [done, setDone] = useState<PlanTool[]>([]);
  const [northChanges, setNorthChanges] = useState(0);
  const storey = history[history.length - 1]!;

  const ghosts = useMemo<Storey[]>(
    () =>
      params.get('ghost') === '1'
        ? [{ ...initial, id: 'ghost', name: 'Étage', outline: DEMO_OUTLINE.slice(0, 2).concat([{ x: DEMO_OUTLINE[1]!.x, y: DEMO_OUTLINE[5]!.y }, DEMO_OUTLINE[5]!]) }]
        : [],
    [initial, params],
  );

  useEffect(() => {
    window.__p2c = { storey, northAngle: north, done, changes: history.length - 1, northChanges };
  });

  const bar: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 4, padding: 6, alignItems: 'center' };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={bar} data-testid="harness-bar">
        {TOOLS.map((x) => (
          <button key={x} type="button" onClick={() => setTool(x)} data-testid={`tool-${x}`} style={{ fontWeight: x === tool ? 700 : 400 }}>
            {x}
          </button>
        ))}
        <button type="button" onClick={() => setLang(lang === 'fr' ? 'de' : 'fr')} data-testid="lang">
          {lang}
        </button>
        <button type="button" onClick={() => setHistory(history.length > 1 ? history.slice(0, -1) : history)} data-testid="undo">
          annuler ({history.length - 1})
        </button>
        <span data-testid="log" style={{ fontSize: 12, opacity: 0.75 }}>
          fait : {done.join(', ') || '—'}
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <PlanEditor
          sheet={sheet}
          storey={storey}
          ghostStoreys={ghosts}
          northAngle={north}
          tool={tool}
          lang={lang}
          constructions={model.constructions}
          windowTypes={model.windowTypes}
          onStoreyChange={(next) => setHistory((h) => [...h, next])}
          onNorthChange={(a) => {
            setNorth(a);
            setNorthChanges((n) => n + 1);
          }}
          onToolDone={(x) => setDone((d) => [...d, x])}
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
