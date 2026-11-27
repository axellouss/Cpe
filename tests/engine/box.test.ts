/**
 * Cas d'école : une « boîte » de 10 × 8 m sur un seul niveau, toiture plate, dalle sur terre-plein.
 * Tous les nombres attendus sont calculés à la main dans les commentaires.
 */
import { describe, expect, it } from 'vitest';
import { deriveSheets, storeyMetrics } from '../../src/engine';
import { EAST, NORTH, SOUTH, WEST, brief, codes, doorAt, project, rect, storey, windowAt } from './helpers';

/**
 * Plan (nord en haut) :            10,00 m
 *                         ┌──────── N : 1 fenêtre 1,20 × 1,35 ────────┐
 *                         │                                           │
 *   O : 1 porte 1,00×2,10 │   hauteur d'étage brute 3,00 m            │ E : 1 fenêtre 1,00 × 1,35     8,00 m
 *                         │   hauteur libre 2,50 m, An saisi 64 m²    │
 *                         └──────── S : 2 fenêtres 2,00 × 2,20 ───────┘
 */
function box() {
  return project([
    storey('rdc', 'Rez-de-chaussée', rect(10, 8), {
      grossHeight: 3,
      clearHeight: 2.5,
      netArea: 64,
      openings: [
        windowAt(NORTH, 1.2, 1.35),
        windowAt(EAST, 1.0, 1.35),
        windowAt(SOUTH, 2.0, 2.2), // deux fenêtres identiques saisies séparément…
        windowAt(SOUTH, 2.0, 2.2), // …doivent donner UNE ligne « 2 × »
        doorAt(WEST, 1.0, 2.1),
      ],
    }),
  ]);
}

describe('boîte 10 × 8 m, un niveau, 4 fenêtres et 1 porte', () => {
  const sheets = deriveSheets(box(), 'fr');

  it("donne les lignes dans l'ordre de saisie LuxEeB : N, E, S, O, puis toiture, puis plancher — chaque ouverture juste AVANT son mur", () => {
    expect(sheets.envelope.map(brief)).toEqual([
      'window N 1 × 1.20 × 1.35 Abzug',
      'wall N 1 × 10.00 × 3.00',
      'window E 1 × 1.00 × 1.35 Abzug',
      'wall E 1 × 8.00 × 3.00',
      'window S 2 × 2.00 × 2.20 Abzug',
      'wall S 1 × 10.00 × 3.00',
      'door W 1 × 1.00 × 2.10 Abzug',
      'wall W 1 × 8.00 × 3.00',
      'roof H 1 × 10.00 × 8.00',
      'floor H 1 × 10.00 × 8.00',
    ]);
  });

  it('calcule surfaces brutes et nettes (règle « Abzug » : déduit du mur qui suit)', () => {
    const rows = sheets.envelope;
    const gross = rows.map((r) => r.grossArea);
    const net = rows.map((r) => r.netArea);
    // Fenêtre N : 1,20 × 1,35 = 1,62 ; mur N : 10 × 3 = 30 → net 30 − 1,62 = 28,38
    // Fenêtre E : 1,00 × 1,35 = 1,35 ; mur E : 8 × 3 = 24 → net 22,65
    // Fenêtres S : 2 × 2,00 × 2,20 = 8,80 ; mur S : 30 → net 21,20
    // Porte O : 1,00 × 2,10 = 2,10 ; mur O : 24 → net 21,90
    // Toiture et dalle : 10 × 8 = 80
    expect(gross).toEqual([1.62, 30, 1.35, 24, 8.8, 30, 2.1, 24, 80, 80]);
    expect(net).toEqual([1.62, 28.38, 1.35, 22.65, 8.8, 21.2, 2.1, 21.9, 80, 80]);
    expect(rows.filter((r) => r.deduct).map((r) => r.kind)).toEqual(['window', 'window', 'window', 'door']);
  });

  it('range chaque paroi contre le bon milieu et le bon type', () => {
    const byKind = (kind: string) => sheets.envelope.filter((r) => r.kind === kind);
    expect(byKind('wall').every((r) => r.boundary === 'outside' && r.constructionId === 'wall-outside')).toBe(true);
    expect(byKind('wall').map((r) => r.elementName)).toEqual(['Mur extérieur', 'Mur extérieur', 'Mur extérieur', 'Mur extérieur']);
    expect(byKind('window').every((r) => r.windowTypeId === 'window-default' && r.constructionId === null)).toBe(true);
    expect(byKind('door')[0]).toMatchObject({ constructionId: 'door', elementName: 'Porte opaque', boundary: 'outside' });
    expect(byKind('roof')[0]).toMatchObject({ boundary: 'outside', constructionId: 'roof', orientation: 'H' });
    expect(byKind('floor')[0]).toMatchObject({ boundary: 'ground', constructionId: 'floor-ground', orientation: 'H' });
    expect(sheets.envelope.every((r) => !r.manual && r.storeyId === 'rdc')).toBe(true);
  });

  it('écrit des libellés lisibles', () => {
    expect(sheets.envelope.map((r) => r.label)).toEqual([
      'Fenêtre 1,20 × 1,35 m – Nord (Rez-de-chaussée)',
      'Mur extérieur – Nord (Rez-de-chaussée)',
      'Fenêtre 1,00 × 1,35 m – Est (Rez-de-chaussée)',
      'Mur extérieur – Est (Rez-de-chaussée)',
      'Fenêtre 2,00 × 2,20 m – Sud (Rez-de-chaussée)',
      'Mur extérieur – Sud (Rez-de-chaussée)',
      'Porte 1,00 × 2,10 m – Ouest (Rez-de-chaussée)',
      'Mur extérieur – Ouest (Rez-de-chaussée)',
      'Toiture plate (Rez-de-chaussée)',
      'Dalle sur terre-plein (Rez-de-chaussée)',
    ]);
    const german = deriveSheets(box(), 'de').envelope.map((r) => r.label);
    expect(german[0]).toBe('Fenster 1,20 × 1,35 m – Nord (Rez-de-chaussée)');
    expect(german[6]).toBe('Tür 1,00 × 2,10 m – West (Rez-de-chaussée)');
    expect(german[8]).toBe('Flachdach (Rez-de-chaussée)');
    expect(german[9]).toBe('Bodenplatte auf Erdreich (Rez-de-chaussée)');
  });

  it('calcule les zones (An, Vn) et le volume (Ve)', () => {
    // An = 64 m² saisi ; Vn = 64 × 2,50 = 160 m³
    expect(sheets.zones).toEqual([
      { id: 'zone:rdc', label: 'Rez-de-chaussée', area: 64, clearHeight: 2.5, airVolume: 160, from: 'user', storeyId: 'rdc' },
    ]);
    // Ve = 10 × 8 × 3,00 = 240 m³ (dimensions extérieures)
    expect(sheets.volumes).toEqual([
      { id: 'volume:rdc', label: 'Rez-de-chaussée', area: 80, height: 3, volume: 240, from: 'plan', storeyId: 'rdc' },
    ]);
  });

  it('calcule les totaux : A, Ve, An, A/Ve', () => {
    // A  = murs 30 + 24 + 30 + 24 = 108, toiture 80, dalle 80 → 268 m² (fenêtres comprises dans les murs)
    // Ve = 240 m³ ; A/Ve = 268 / 240 = 1,1167 → 1,117
    // Fenêtres = 1,62 + 1,35 + 8,80 = 11,77 m² (la porte opaque n'est pas une fenêtre)
    expect(sheets.totals).toEqual({
      an: 64,
      vn: 160,
      ve: 240,
      envelopeArea: 268,
      aOverVe: 1.117,
      grossFloorArea: 80,
      windowArea: 11.77,
      facadeArea: 108,
      anFrom: 'user',
      veFrom: 'plan',
    });
  });

  it('récapitule les types à créer dans LuxEeB-Tool', () => {
    // Mur extérieur net : 28,38 + 22,65 + 21,20 + 21,90 = 94,13 m²
    // Dalle sur terre-plein : A = 80 m², périmètre P = 2 × (10 + 8) = 36 m
    expect(sheets.constructions).toEqual([
      { constructionId: 'wall-outside', name: 'Mur extérieur', category: 'wall', boundary: 'outside', area: 94.13, u: null },
      { constructionId: 'roof', name: 'Toiture', category: 'roof', boundary: 'outside', area: 80, u: null },
      {
        constructionId: 'floor-ground',
        name: 'Dalle sur terre-plein',
        category: 'floor',
        boundary: 'ground',
        area: 80,
        u: null,
        ground: { slabArea: 80, perimeter: 36 },
      },
      { constructionId: 'door', name: 'Porte opaque', category: 'door', boundary: 'outside', area: 2.1, u: null },
    ]);
    // 4 fenêtres, 11,77 m² ; la dimension la plus fréquente est 2,00 × 2,20 (2 exemplaires)
    expect(sheets.windows).toEqual([
      { windowTypeId: 'window-default', name: 'Fenêtre', area: 11.77, count: 4, typicalWidth: 2, typicalHeight: 2.2, uw: null, g: null },
    ]);
  });

  it("ne signale rien d'autre que les valeurs U à définir dans LuxEeB-Tool", () => {
    // Types sans U : mur, toiture, dalle, porte + le type de fenêtre = 5
    expect(sheets.findings).toEqual([{ code: 'uvalues.missing', severity: 'info', params: { count: 5 } }]);
  });

  it('donne la provenance la plus faible des données utilisées', () => {
    const from = Object.fromEntries(sheets.envelope.map((r) => [brief(r), r.from]));
    // Mur : contour mesuré ('plan') + hauteur et nord confirmés ('user') → 'plan'
    expect(from['wall N 1 × 10.00 × 3.00']).toBe('plan');
    // Fenêtre saisie par l'expert, nord confirmé → 'user'
    expect(from['window N 1 × 1.20 × 1.35 Abzug']).toBe('user');
    expect(from['roof H 1 × 10.00 × 8.00']).toBe('plan');

    // Même boîte avec la hauteur d'étage par défaut : murs et volume deviennent « à confirmer »
    const p = box();
    p.model.storeys[0]!.grossHeight = { value: 2.8, from: 'default' };
    const d = deriveSheets(p, 'fr');
    expect(d.envelope.filter((r) => r.kind === 'wall').every((r) => r.from === 'default')).toBe(true);
    expect(d.envelope.find((r) => r.kind === 'roof')!.from).toBe('plan');
    expect(d.totals.veFrom).toBe('default');
    expect(codes(d)).toContain('height.default');

    // Nord non confirmé : toutes les lignes ORIENTÉES sont « à confirmer », pas les lignes horizontales
    const q = box();
    q.model.northAngle = { value: 0, from: 'default' };
    const e = deriveSheets(q, 'fr');
    expect(e.envelope.filter((r) => r.orientation !== 'H').every((r) => r.from === 'default')).toBe(true);
    expect(e.envelope.filter((r) => r.orientation === 'H').every((r) => r.from === 'plan')).toBe(true);
  });

  it('applique l’échelle : le même plan tracé en centimètres donne les mêmes tableaux', () => {
    const p = box();
    const s = p.model.storeys[0]!;
    s.outline = rect(1000, 800);
    s.metresPerUnit = { value: 0.01, from: 'user' };
    const scaled = deriveSheets(p, 'fr');
    expect(scaled.envelope.map(brief)).toEqual(sheets.envelope.map(brief));
    expect(scaled.totals).toEqual(sheets.totals);
  });

  it('ne dépend pas du sens de tracé du contour', () => {
    const p = box();
    const s = p.model.storeys[0]!;
    // Contour parcouru à l'envers : l'arête i relie désormais d'autres points → on replace les ouvertures.
    // Ordre inversé [(0,8), (10,8), (10,0), (0,0)] : arête 0 = Sud, 1 = Est, 2 = Nord, 3 = Ouest.
    s.outline = [...rect(10, 8)].reverse();
    s.openings = [windowAt(2, 1.2, 1.35), windowAt(1, 1.0, 1.35), windowAt(0, 2.0, 2.2, 2), doorAt(3, 1.0, 2.1)];
    expect(deriveSheets(p, 'fr').envelope.map(brief)).toEqual(sheets.envelope.map(brief));
  });
});

describe('mesures en direct pendant le tracé (storeyMetrics)', () => {
  it('donne surface, périmètre, volume et longueurs de façade', () => {
    const m = storeyMetrics(box().model.storeys[0]!);
    expect(m.grossArea).toBeCloseTo(80);
    expect(m.perimeter).toBeCloseTo(36);
    expect(m.grossVolume).toBeCloseTo(240);
    expect(m.edgeLengths).toEqual([10, 8, 10, 8]);
    expect(m.netArea).toBe(64);
    expect(m.netAreaFrom).toBe('override');
  });

  it('retient la somme des pièces chauffées, sinon 80 % du brut', () => {
    const s = box().model.storeys[0]!;
    s.netAreaOverride = null;
    expect(storeyMetrics(s)).toMatchObject({ netArea: 64, netAreaFrom: 'estimate' }); // 0,80 × 80
    s.rooms = [
      { id: 'a', name: 'Séjour', area: { value: 40, from: 'plan' }, heated: true, needsReview: false },
      { id: 'b', name: 'Cellier', area: { value: 8, from: 'plan' }, heated: false, needsReview: false },
    ];
    expect(storeyMetrics(s)).toMatchObject({ netArea: 40, netAreaFrom: 'rooms' });
  });
});
