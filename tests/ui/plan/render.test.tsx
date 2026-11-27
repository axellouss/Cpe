/**
 * Rendu statique (sans navigateur) de chaque outil : ce sont des tests de fumée — l'outil se monte, affiche ses
 * rappels obligatoires et ses compteurs, dans les deux langues. Les gestes sont vérifiés dans un vrai navigateur
 * (banc d'essai src/ui/plan/dev/harness.html piloté par Playwright), pas ici.
 */
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Lang, PlanSheet, Storey } from '../../../src/core/types';
import { createEmptyProject, createStorey } from '../../../src/engine';
import { t } from '../../../src/i18n';
import { PlanEditor } from '../../../src/ui/plan';
import type { PlanTool } from '../../../src/ui/plan';
import { demoSheet } from '../../../src/ui/plan/dev/demoSheet';
import '../../../src/ui/plan/messages';
import { buildSnapIndex } from '../../../src/ui/plan/snapIndex';
import type { ToolContext } from '../../../src/ui/plan/toolTypes';
import { BoundaryTool } from '../../../src/ui/plan/tools/BoundaryTool';
import { NorthTool } from '../../../src/ui/plan/tools/NorthTool';
import { OpeningTool } from '../../../src/ui/plan/tools/OpeningTool';
import { OutlineTool } from '../../../src/ui/plan/tools/OutlineTool';
import { PanTool } from '../../../src/ui/plan/tools/PanTool';
import { RoomsTool } from '../../../src/ui/plan/tools/RoomsTool';
import { ScaleTool } from '../../../src/ui/plan/tools/ScaleTool';
import { fitView } from '../../../src/ui/plan/view';

const model = createEmptyProject('fr').model;

function context(lang: Lang, sheet: PlanSheet | null, storey: Storey, size = { width: 900, height: 600 }): ToolContext {
  const box = sheet ? sheet.bbox : { minX: 0, minY: 0, maxX: 20, maxY: 14 };
  return {
    view: fitView(box, size),
    size,
    sheet,
    index: sheet?.segments ? buildSnapIndex(sheet.segments) : null,
    storey,
    ghostStoreys: [],
    northAngle: 225,
    lang,
    tr: (key, params) => t(lang, key, params),
    windowTypes: model.windowTypes,
    compact: size.width < 560,
    magnet: true,
    setMagnet: () => undefined,
    commit: () => undefined,
    done: () => undefined,
    changeNorth: () => undefined,
    coarse: false,
    aim: () => undefined,
    cover: () => undefined,
    reframe: () => undefined,
    controller: { current: null },
    focusSurface: () => undefined,
  };
}

/** Texte visible : balises retirées, entités courantes décodées. */
function text(html: string): string {
  return html
    .replace(/<title>[^<]*<\/title>/g, '')
    .replace(/<!-- -->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

const sheet = demoSheet();
// Ces rendus portent sur l'EMPRISE complète de la maison de démonstration (garage compris), telle que l'expert
// la retrouve s'il réintègre le garage : `createStorey` seul proposerait le contour chauffé, sans le garage.
const storey: Storey = {
  ...createStorey({ ...sheet, detected: { ...sheet.detected, rooms: [] } }, 'Rez-de-chaussée', model),
  rooms: createStorey(sheet, 'Rez-de-chaussée', model).rooms,
};

describe('rendu des outils', () => {
  it('contour (correction) : rappel « face extérieure », surface brute et périmètre de la maison de démonstration', () => {
    const html = text(renderToString(<OutlineTool ctx={context('fr', sheet, storey)} />));
    expect(html).toContain('FACE EXTÉRIEURE');
    expect(html).toContain('95,50');
    expect(html).toContain('44,00');
    expect(html).toContain('Le contour est bon');
    // Les six longueurs de façades de la maison en L.
    for (const length of ['13,50', '5,00', '5,50', '3,50', '8,00', '8,50']) expect(html).toContain(length);
  });

  it('contour : sans contour sur l’étage, celui du lecteur est seulement PROPOSÉ', () => {
    const empty: Storey = { ...storey, outline: [], edges: [], openings: [] };
    const html = text(renderToString(<OutlineTool ctx={context('fr', sheet, empty)} />));
    expect(html).toContain('Utiliser ce contour');
    expect(html).toContain('Tracer moi-même');
    expect(html).toContain('FACE EXTÉRIEURE');
  });

  it('contour : ni contour ni proposition → tracé direct, avec le rappel', () => {
    const bare = demoSheet({ withOutline: false });
    const empty: Storey = { ...createStorey(bare, 'RDC', model) };
    expect(empty.outline).toHaveLength(0);
    const html = text(renderToString(<OutlineTool ctx={context('de', bare, empty)} />));
    expect(html).toContain('AUSSENKANTE');
    expect(html).toContain('Umriss schließen');
  });

  it('règle : conseil de la plus longue cote ; échelle inconnue signalée', () => {
    const known = text(renderToString(<ScaleTool ctx={context('fr', sheet, storey)} />));
    expect(known).toContain('plus LONGUE cote');
    expect(known).toContain('lue sur le plan');
    expect(known).toContain('13,50 × 8,50 m');
    const unknownSheet = demoSheet({ scaleKnown: false });
    const unknown = text(renderToString(<ScaleTool ctx={context('fr', unknownSheet, createStorey(unknownSheet, 'RDC', model))} />));
    expect(unknown).toContain('inconnue');
    expect(unknown).not.toContain('13,50 × 8,50 m');
  });

  it('façades : légende des quatre états avec leurs longueurs', () => {
    const edited: Storey = { ...storey, edges: storey.edges.map((e, i) => (i === 1 ? { ...e, boundary: 'ground' } : e)) };
    const html = text(renderToString(<BoundaryTool ctx={context('fr', sheet, edited)} />));
    for (const label of ['Extérieur', 'Voisin chauffé', 'Local non chauffé', 'Terre']) expect(html).toContain(label);
    expect(html).toMatch(/Extérieur\s+39,00 m/);
    expect(html).toMatch(/Terre\s+5,00 m/);
  });

  it('ouvertures : marques avec dimensions, « ? » sur celles à confirmer, totaux', () => {
    const html = text(renderToString(<OpeningTool ctx={context('fr', sheet, storey)} />));
    expect(html).toContain('1,20 × 1,35');
    expect(html).toContain('1,80 × 1,35 ?');
    expect(html).toMatch(/Fenêtres\s+2 · 4,05/);
    expect(html).toMatch(/Portes\s+1 · 2,10/);
  });

  it('nord : secteur ET degrés sur chaque façade extérieure, phrase localisée', () => {
    const fr = text(renderToString(<NorthTool ctx={context('fr', sheet, storey)} />));
    // Haut de la feuille à 225° : la façade du haut regarde le SW, celle de droite le NW…
    for (const label of ['SW 225°', 'NW 315°', 'NE 45°', 'SE 135°']) expect(fr.replace(/\s+/g, ' ')).toContain(label);
    expect(fr).toContain('Le haut du plan regarde vers SW · 225° (Sud-ouest)');
    const de = text(renderToString(<NorthTool ctx={context('de', sheet, storey)} />));
    expect(de).toContain('Die Planoberkante zeigt nach SW · 225° (Südwesten)');
    // Jamais de « SO » : ambigu entre le français (sud-ouest) et l'allemand (Südost).
    expect(fr).not.toMatch(/\bSO\b/);
    expect(de).not.toMatch(/\bSO\b/);
  });

  it('nord : une façade mitoyenne ou contre terre ne porte pas d’orientation', () => {
    const edited: Storey = { ...storey, edges: storey.edges.map((e, i) => (i === 0 ? { ...e, boundary: 'heated' } : e)) };
    const html = text(renderToString(<NorthTool ctx={context('fr', sheet, edited)} />));
    expect(html).not.toContain('SW 225°');
    expect(html).toContain('NW 315°');
  });

  it('pièces : An en direct, pièce à trancher signalée, étiquette pour la pièce sans polygone', () => {
    const html = text(renderToString(<RoomsTool ctx={context('fr', sheet, storey)} />));
    // Séjour + Cuisine + Chambre + Hall = 19,32 + 11,76 + 15,64 + 2,25.
    expect(html).toContain('48,97');
    expect(html).toContain('? Buanderie');
    expect(html).toContain('Hall · 2,25 m²');
    expect(html).toContain('somme des pièces');
    expect(html).toMatch(/À trancher\s+1/);
  });

  it('se déplacer : compteurs conservés', () => {
    const html = text(renderToString(<PanTool ctx={context('fr', sheet, storey)} />));
    expect(html).toContain('95,50');
  });

  it('échelle non confirmée : les mètres sont précédés de « ≈ »', () => {
    const unknownSheet = demoSheet({ scaleKnown: false });
    const html = text(renderToString(<OutlineTool ctx={context('fr', unknownSheet, createStorey(unknownSheet, 'RDC', model))} />));
    expect(html).toContain('≈');
    expect(html).toContain('à confirmer');
  });

  it('feuille vierge (sheet = null) : chaque outil se monte', () => {
    const blank = createStorey(null, 'Étage', model);
    for (const Tool of [OutlineTool, ScaleTool, BoundaryTool, OpeningTool, NorthTool, RoomsTool, PanTool]) {
      expect(() => renderToString(<Tool ctx={context('fr', null, blank, { width: 360, height: 560 })} />)).not.toThrow();
    }
  });
});

describe('PlanEditor', () => {
  const tools: PlanTool[] = ['pan', 'scale', 'outline', 'boundary', 'opening', 'north', 'rooms'];

  it('se monte pour chaque outil, avec les boutons de navigation et un nom accessible', () => {
    for (const tool of tools) {
      for (const lang of ['fr', 'de'] as const) {
        const html = renderToString(
          <PlanEditor
            sheet={sheet}
            storey={storey}
            northAngle={0}
            tool={tool}
            lang={lang}
            constructions={model.constructions}
            windowTypes={model.windowTypes}
            onStoreyChange={() => undefined}
            onNorthChange={() => undefined}
            className="hote"
          />,
        );
        expect(html).toContain(`data-tool="${tool}"`);
        expect(html).toMatch(/class="p2c-plan[^"]* hote"/);
        expect(html).toContain(lang === 'fr' ? 'Plan interactif — Rez-de-chaussée' : 'Interaktiver Plan — Rez-de-chaussée');
        expect(html).toContain('data-testid="plan-zoom-in"');
        expect(html).toContain('data-testid="plan-fit"');
        expect(html).toContain('<canvas');
      }
    }
  });
});
