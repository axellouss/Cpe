/**
 * Tableau des surfaces et équipements écrits (avec installations proposées). Textes inventés, FR et DE.
 */
import { describe, expect, it } from 'vitest';
import { equipmentMentions, proposeSystems } from '../../src/semantics/equipment';
import { siteAreaTable } from '../../src/semantics/siteareas';
import { box, lines, mk, view } from './lines';

describe('siteAreaTable', () => {
  it('lit les quatre lignes et leurs maxima (cellules à droite de l’intitulé)', () => {
    const texts = [
      mk('Surface terrain :', 10, 10, 6), mk('412,50m²', 120, 10, 6),
      mk('Surface scellée :', 10, 20, 6), mk('160,10m²', 120, 20, 6), mk('max 200m²', 180, 20, 6),
      mk('Surface emprise au sol :', 10, 30, 6), mk('98,40m²', 120, 30, 6), mk('max 110m²', 180, 30, 6),
      mk('Surface construite brute :', 10, 40, 6), mk('196,80m²', 120, 40, 6), mk('max 250m²', 180, 40, 6),
    ];
    expect(siteAreaTable(lines(texts))).toEqual({
      terrain: { value: 412.5 },
      sealed: { value: 160.1, max: 200 },
      footprint: { value: 98.4, max: 110 },
      grossFloor: { value: 196.8, max: 250 },
      page: 1,
      box: expect.any(Object) as unknown,
    });
  });

  it('en allemand, valeur sur la même ligne que l’intitulé', () => {
    const t = siteAreaTable(lines([mk('Grundstücksfläche : 512,00 m²', 10, 10, 6), mk('Grundfläche :', 10, 20, 6), mk('140,25 m²', 100, 20, 6), mk('max 160,00 m²', 150, 20, 6)]));
    expect(t).toMatchObject({ terrain: { value: 512 }, footprint: { value: 140.25, max: 160 } });
    expect(t!.sealed).toBeUndefined();
  });

  it('valeur et maximum dans la même cellule ; une surface négative n’est pas lue', () => {
    const t = siteAreaTable(lines([
      mk('Surface du terrain : -5 m²', 10, 10, 6),
      mk('Surface scellée : 210,30 m² (max 300,00 m²)', 10, 20, 6),
      mk('Surface emprise au sol :', 10, 30, 6), mk('88,00 m² max 120,00 m²', 120, 30, 6),
      mk('Versiegelte Fläche: 99,50 m² (zulässig 150,00 m²)', 10, 40, 6),
    ]));
    expect(t!.terrain).toBeUndefined();
    expect(t!.sealed).toEqual({ value: 210.3, max: 300 });
    expect(t!.footprint).toEqual({ value: 88, max: 120 });
  });

  it('rien : null', () => {
    expect(siteAreaTable(lines([mk('Séjour', 0, 10), mk('S: 30,00 m²', 0, 17)]))).toBeNull();
  });
});

describe('equipmentMentions et proposeSystems', () => {
  const plan = view('plan', 'floor-plan', box(0, 0, 400, 400), { buildingBox: box(100, 100, 300, 300) });
  const facade = view('facade', 'elevation', box(500, 0, 900, 400));
  const coupe = view('coupe', 'section', box(1000, 0, 1400, 400));
  const tb = view('tb', 'title-block', box(1500, 0, 1900, 400));
  const views = [plan, facade, coupe, tb];

  it('repère les équipements, dit s’ils sont dessinés dehors, ignore couches de paroi et cartouche', () => {
    const eq = equipmentMentions(
      lines([mk('PAC', 60, 180, 4), mk('Boiler', 200, 250, 4), mk('VMC double flux', 200, 270, 4), mk('Hinterlüftung', 1100, 100, 4), mk('Wandaufbau Lüftungsebene:', 1100, 150, 4), mk('Bureau d’études chauffage gaz', 1600, 100, 4)]),
      views,
    );
    expect(eq.map((e) => [e.kind, e.outside, e.viewId])).toEqual([
      ['heat-pump', true, 'plan'],
      ['hot-water-tank', false, 'plan'],
      ['ventilation-unit', false, 'plan'],
    ]);
    const sys = proposeSystems(eq, views);
    expect(sys.heatGenerator).toMatchObject({ value: 'heat-pump-air', confidence: 0.75 });
    expect(sys.heatGenerator!.doubt).toMatch(/air\/eau/);
    expect(sys.hotWater).toMatchObject({ value: 'with-heating', confidence: 0.6 });
    expect(sys.ventilation).toMatchObject({ value: 'balanced-hr', confidence: 0.7 });
    expect(sys.photovoltaic).toMatchObject({ value: false, confidence: 0.5 });
  });

  it('en allemand : Wärmepumpe Sole-Wasser, Lüftungsgerät KWL, Warmwasserspeicher, Photovoltaik', () => {
    const eq = equipmentMentions(lines([mk('Wärmepumpe Sole-Wasser', 150, 150, 4), mk('Lüftungsgerät KWL', 150, 200, 4), mk('Warmwasserspeicher 300 l', 150, 250, 4), mk('PV-Anlage', 600, 100, 4)]), views);
    expect(eq.map((e) => e.kind).sort()).toEqual(['heat-pump', 'hot-water-tank', 'photovoltaic', 'ventilation-unit']);
    const sys = proposeSystems(eq, views, 'de');
    expect(sys.heatGenerator).toMatchObject({ value: 'heat-pump-ground', confidence: 0.9, doubt: null });
    expect(sys.photovoltaic).toMatchObject({ value: true });
    expect(sys.photovoltaic!.doubt).toMatch(/Spitzenleistung/);
  });

  it('une pompe à chaleur dessinée en façade est une unité extérieure', () => {
    const sys = proposeSystems(equipmentMentions(lines([mk('PAC', 600, 300, 4)]), views), views);
    expect(sys.heatGenerator).toMatchObject({ value: 'heat-pump-air', confidence: 0.75 });
  });

  it('PAC dans le bâtiment, sans type : air/eau proposé avec une question', () => {
    const sys = proposeSystems(equipmentMentions(lines([mk('PAC', 150, 150, 4)]), views), views);
    expect(sys.heatGenerator!.confidence).toBeLessThan(0.65);
  });

  it('rien d’écrit : aucune proposition de chauffage ni de ventilation', () => {
    const sys = proposeSystems([], views);
    expect(sys.heatGenerator).toBeNull();
    expect(sys.hotWater).toBeNull();
    expect(sys.ventilation).toBeNull();
    expect(sys.solarThermal).toMatchObject({ value: false, confidence: 0.5 });
  });

  it('chaudière gaz : proposition à confirmer', () => {
    const sys = proposeSystems(equipmentMentions(lines([mk('Chaudière gaz', 150, 150, 4)]), views), views);
    expect(sys.heatGenerator).toMatchObject({ value: 'gas-condensing' });
    expect(sys.heatGenerator!.confidence).toBeLessThan(0.65);
  });
});
