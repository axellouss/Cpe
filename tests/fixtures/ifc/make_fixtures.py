"""Génère les modèles IFC d'essai du lecteur IFC (tests/readers/ifc).

Les fichiers produits sont de PETITES maisons synthétiques aux dimensions connues, écrites entité par entité
(aucun modèle tiers n'est copié). Relancer après modification :

    python -I tests/fixtures/ifc/make_fixtures.py          (demande le paquet Python « ifcopenshell »)

Repère IFC : x vers la droite, y vers le haut, z vertical. Toutes les cotes ci-dessous sont en mètres ;
le second modèle est écrit en millimètres pour vérifier la conversion d'unités.

maison-test.ifc (IFC4, mètres, nord vrai tourné de 30° dans le sens horaire par rapport à +Y)
  Rez-de-chaussée (0,00) : plan en L, 10 × 8 m moins une encoche de 4 × 3 m → 68,00 m² (dimensions extérieures),
      décalé de (1,013 ; 2,007) pour ne pas tomber sur la trame du lecteur. Murs extérieurs 0,30 m, hauteur 2,80 m.
      Cloison 0,10 m. Locaux : « Séjour » 29,81 m², « Garage » 27,01 m² (hauteur libre 2,50 m).
      Fenêtres : 1,20 × 1,40 et 2,00 × 2,20 (sud), 0,80 × 0,60 (est), 1,00 × 1,20 (encoche, vers le nord).
      Portes : entrée 1,00 × 2,10 (ouest), garage 2,40 × 2,10 (sud), porte intérieure 0,90 × 2,00.
  Étage (2,80) : rectangle 6 × 8 m → 48,00 m². Murs 0,30 m, hauteur 2,60 m.
      Locaux : « Chambre 1 » 19,98 m² (surface déclarée 19,38 m²), « Salle de bain » 19,44 m² (sans quantité).
      « Débarras » : local SANS géométrie, 3,50 m² déclarés.
      Fenêtres : 1,20 × 1,40 (sud), 1,60 × 1,20 (nord), 0,90 × 1,20 (ouest).
  Niveau « Toiture » (5,40) sans mur : doit être ignoré. Dalle de toiture débordante : ne doit pas élargir le contour.
      Coupole de toit 1,00 × 1,00 horizontale, sans réservation : doit être signalée comme fenêtre de toit.

pavillon-mm.ifc (IFC2X3, millimètres, bâtiment tourné de 25°, nord par défaut, aucun local)
  RDC (0,00) : rectangle 9 × 7 m → 63,00 m², murs 0,365 m, hauteur 2,75 m ; niveau auxiliaire « Plafond » (2,50).
      Fenêtres : 1,50 × 1,30 (sud), 1,00 × 1,00 (nord). Porte : 1,00 × 2,10 (est).
  Abri séparé 3 × 5 m (15,00 m²) à 4 m du pavillon, avec une porte 0,90 × 2,00 → second volume.
"""
import math
import os
import uuid

import ifcopenshell
import ifcopenshell.guid

HERE = os.path.dirname(os.path.abspath(__file__))


class Builder:
    """Petit assistant d'écriture : `k` = facteur mètres → unité du fichier (1 ou 1000)."""

    def __init__(self, schema, k, name):
        self.f = ifcopenshell.file(schema=schema)
        self.k = k
        self.name = name
        self.n = 0
        f = self.f
        self.history = None
        if schema == "IFC2X3":
            person = f.create_entity("IfcPerson", FamilyName="Plan2CPE")
            org = f.create_entity("IfcOrganization", Name="Plan2CPE")
            pao = f.create_entity("IfcPersonAndOrganization", ThePerson=person, TheOrganization=org)
            app = f.create_entity("IfcApplication", ApplicationDeveloper=org, Version="1", ApplicationFullName="Plan2CPE fixtures", ApplicationIdentifier="plan2cpe-fixtures")
            self.history = f.create_entity("IfcOwnerHistory", OwningUser=pao, OwningApplication=app, ChangeAction="ADDED", CreationDate=0)
        self.origin = f.create_entity("IfcAxis2Placement3D", Location=self.pt(0, 0, 0))
        self.zdir = f.create_entity("IfcDirection", DirectionRatios=(0.0, 0.0, 1.0))

    # ── bases ──
    def guid(self):
        self.n += 1
        return ifcopenshell.guid.compress(uuid.uuid5(uuid.NAMESPACE_URL, f"plan2cpe/{self.name}/{self.n}").hex)

    def root(self, cls, **kw):
        if self.history is not None:
            kw["OwnerHistory"] = self.history
        return self.f.create_entity(cls, GlobalId=self.guid(), **kw)

    def pt(self, x, y, z=None):
        k = self.k
        coords = (float(x * k), float(y * k)) if z is None else (float(x * k), float(y * k), float(z * k))
        return self.f.create_entity("IfcCartesianPoint", Coordinates=coords)

    def direction(self, *v):
        return self.f.create_entity("IfcDirection", DirectionRatios=tuple(float(c) for c in v))

    def placement(self, relative_to, x, y, z, xdir=(1.0, 0.0, 0.0)):
        a = self.f.create_entity("IfcAxis2Placement3D", Location=self.pt(x, y, z), Axis=self.zdir, RefDirection=self.direction(*xdir))
        return self.f.create_entity("IfcLocalPlacement", PlacementRelTo=relative_to, RelativePlacement=a)

    # ── géométrie ──
    def box(self, x0, y0, z0, dx, dy, dz):
        """Pavé [x0, x0+dx] × [y0, y0+dy] × [z0, z0+dz] dans le repère local du produit."""
        f = self.f
        k = self.k
        centre = f.create_entity("IfcAxis2Placement2D", Location=self.pt(x0 + dx / 2, y0 + dy / 2))
        profile = f.create_entity("IfcRectangleProfileDef", ProfileType="AREA", Position=centre, XDim=float(dx * k), YDim=float(dy * k))
        pos = f.create_entity("IfcAxis2Placement3D", Location=self.pt(0, 0, z0))
        return f.create_entity("IfcExtrudedAreaSolid", SweptArea=profile, Position=pos, ExtrudedDirection=self.zdir, Depth=float(dz * k))

    def prism(self, points, z0, dz):
        f = self.f
        loop = [self.pt(x, y) for x, y in points]
        poly = f.create_entity("IfcPolyline", Points=loop + [loop[0]])
        profile = f.create_entity("IfcArbitraryClosedProfileDef", ProfileType="AREA", OuterCurve=poly)
        pos = f.create_entity("IfcAxis2Placement3D", Location=self.pt(0, 0, z0))
        return f.create_entity("IfcExtrudedAreaSolid", SweptArea=profile, Position=pos, ExtrudedDirection=self.zdir, Depth=float(dz * self.k))

    def shape(self, solid):
        rep = self.f.create_entity("IfcShapeRepresentation", ContextOfItems=self.body, RepresentationIdentifier="Body", RepresentationType="SweptSolid", Items=[solid])
        return self.f.create_entity("IfcProductDefinitionShape", Representations=[rep])

    # ── structure ──
    def project(self, title, true_north):
        f = self.f
        prefix = "MILLI" if self.k == 1000 else None
        units = f.create_entity(
            "IfcUnitAssignment",
            Units=[
                f.create_entity("IfcSIUnit", UnitType="LENGTHUNIT", Prefix=prefix, Name="METRE"),
                f.create_entity("IfcSIUnit", UnitType="AREAUNIT", Name="SQUARE_METRE"),
                f.create_entity("IfcSIUnit", UnitType="VOLUMEUNIT", Name="CUBIC_METRE"),
                f.create_entity("IfcSIUnit", UnitType="PLANEANGLEUNIT", Name="RADIAN"),
            ],
        )
        north = None if true_north is None else self.direction(*true_north)
        self.context = f.create_entity("IfcGeometricRepresentationContext", ContextType="Model", CoordinateSpaceDimension=3, Precision=1e-5, WorldCoordinateSystem=self.origin, TrueNorth=north)
        self.body = f.create_entity("IfcGeometricRepresentationSubContext", ContextIdentifier="Body", ContextType="Model", ParentContext=self.context, TargetView="MODEL_VIEW")
        self.proj = self.root("IfcProject", Name=title, RepresentationContexts=[self.context], UnitsInContext=units)
        self.site_pl = self.placement(None, 0, 0, 0)
        self.site = self.root("IfcSite", Name="Terrain", ObjectPlacement=self.site_pl, CompositionType="ELEMENT")
        self.root("IfcRelAggregates", RelatingObject=self.proj, RelatedObjects=[self.site])

    def building(self, name, x=0.0, y=0.0, angle_deg=0.0):
        a = math.radians(angle_deg)
        pl = self.placement(self.site_pl, x, y, 0, (math.cos(a), math.sin(a), 0.0))
        b = self.root("IfcBuilding", Name=name, ObjectPlacement=pl, CompositionType="ELEMENT")
        self.root("IfcRelAggregates", RelatingObject=self.site, RelatedObjects=[b])
        return b, pl

    def storeys(self, building, building_pl, levels):
        out = []
        for name, z in levels:
            pl = self.placement(building_pl, 0, 0, z)
            s = self.root("IfcBuildingStorey", Name=name, ObjectPlacement=pl, CompositionType="ELEMENT", Elevation=float(z * self.k))
            out.append({"entity": s, "placement": pl, "elements": [], "spaces": []})
        self.root("IfcRelAggregates", RelatingObject=building, RelatedObjects=[s["entity"] for s in out])
        return out

    def close_storeys(self, storeys):
        for s in storeys:
            if s["elements"]:
                self.root("IfcRelContainedInSpatialStructure", RelatedElements=s["elements"], RelatingStructure=s["entity"])
            if s["spaces"]:
                self.root("IfcRelAggregates", RelatingObject=s["entity"], RelatedObjects=s["spaces"])

    # ── éléments ──
    def wall(self, storey, name, x0, y0, x1, y1, height, z0=0.0):
        """Mur = pavé [x0, x1] × [y0, y1] (emprise au sol, repère de l'étage)."""
        cls = "IfcWallStandardCase" if self.f.schema == "IFC2X3" else "IfcWall"
        pl = self.placement(storey["placement"], x0, y0, z0)
        w = self.root(cls, Name=name, ObjectPlacement=pl, Representation=self.shape(self.box(0, 0, 0, x1 - x0, y1 - y0, height)))
        storey["elements"].append(w)
        return {"entity": w, "placement": pl, "x0": x0, "y0": y0, "x1": x1, "y1": y1}

    def slab(self, storey, name, kind, points, z0, thickness):
        pl = self.placement(storey["placement"], 0, 0, 0)
        s = self.root("IfcSlab", Name=name, ObjectPlacement=pl, Representation=self.shape(self.prism(points, z0, thickness)), PredefinedType=kind)
        storey["elements"].append(s)

    def filler(self, storey, wall, kind, name, centre, width, height, sill):
        """Fenêtre ou porte dans un mur droit parallèle à x ou à y. `centre` = abscisse (mur selon x) ou ordonnée (mur selon y)
        du milieu de la baie, dans le repère de l'étage. La baie brute dépasse la menuiserie de 2 cm de chaque côté."""
        along_x = (wall["x1"] - wall["x0"]) >= (wall["y1"] - wall["y0"])
        thick = (wall["y1"] - wall["y0"]) if along_x else (wall["x1"] - wall["x0"])
        m = 0.02
        if along_x:
            ox, oy, xdir = centre - width / 2 - wall["x0"], thick / 2, (1.0, 0.0, 0.0)
        else:
            ox, oy, xdir = thick / 2, centre - width / 2 - wall["y0"], (0.0, 1.0, 0.0)
        # Baie : repère local x le long du mur, origine au coin bas gauche de la menuiserie, sur l'axe du mur.
        opl = self.placement(wall["placement"], ox, oy, sill, xdir)
        opening = self.root("IfcOpeningElement", Name=f"Baie {name}", ObjectPlacement=opl, Representation=self.shape(self.box(-m, -thick / 2 - 0.05, -m if sill > 0 else 0.0, width + 2 * m, thick + 0.10, height + (2 * m if sill > 0 else m))))
        self.root("IfcRelVoidsElement", RelatingBuildingElement=wall["entity"], RelatedOpeningElement=opening)
        fpl = self.placement(opl, 0, 0, 0)
        cls = "IfcWindow" if kind == "window" else "IfcDoor"
        e = self.root(cls, Name=name, ObjectPlacement=fpl, Representation=self.shape(self.box(0, -0.03, 0, width, 0.06, height)), OverallHeight=float(height * self.k), OverallWidth=float(width * self.k))
        self.root("IfcRelFillsElement", RelatingOpeningElement=opening, RelatedBuildingElement=e)
        storey["elements"].append(e)

    def space(self, storey, number, long_name, points, height, net_floor_area=None):
        pl = self.placement(storey["placement"], 0, 0, 0)
        kw = {"InteriorOrExteriorSpace": "INTERNAL"} if self.f.schema == "IFC2X3" else {"PredefinedType": "INTERNAL"}
        s = self.root("IfcSpace", Name=number, LongName=long_name, ObjectPlacement=pl, Representation=self.shape(self.prism(points, 0, height)), CompositionType="ELEMENT", **kw)
        storey["spaces"].append(s)
        if net_floor_area is not None:
            f = self.f
            q = [
                f.create_entity("IfcQuantityArea", Name="NetFloorArea", AreaValue=float(net_floor_area)),
                f.create_entity("IfcQuantityLength", Name="Height", LengthValue=float(height * self.k)),
            ]
            qto = self.root("IfcElementQuantity", Name="Qto_SpaceBaseQuantities", Quantities=q)
            self.root("IfcRelDefinesByProperties", RelatedObjects=[s], RelatingPropertyDefinition=qto)

    def skylight(self, storey, name, x, y, z, width, length):
        """Fenêtre de toit horizontale SANS réservation ni mur porteur (comme les exports Revit) : son plan est couché,
        l'axe « hauteur » du placement est horizontal."""
        a = self.f.create_entity("IfcAxis2Placement3D", Location=self.pt(x, y, z), Axis=self.direction(0.0, 1.0, 0.0), RefDirection=self.direction(1.0, 0.0, 0.0))
        pl = self.f.create_entity("IfcLocalPlacement", PlacementRelTo=storey["placement"], RelativePlacement=a)
        e = self.root("IfcWindow", Name=name, ObjectPlacement=pl, Representation=self.shape(self.box(0, -0.03, 0, width, 0.06, length)), OverallHeight=float(length * self.k), OverallWidth=float(width * self.k))
        storey["elements"].append(e)

    def space_without_geometry(self, storey, number, long_name, net_floor_area):
        """Local décrit seulement par ses quantités (certains exports n'écrivent pas la géométrie des locaux)."""
        kw = {"InteriorOrExteriorSpace": "INTERNAL"} if self.f.schema == "IFC2X3" else {"PredefinedType": "INTERNAL"}
        s = self.root("IfcSpace", Name=number, LongName=long_name, CompositionType="ELEMENT", **kw)
        storey["spaces"].append(s)
        q = [self.f.create_entity("IfcQuantityArea", Name="NetFloorArea", AreaValue=float(net_floor_area))]
        qto = self.root("IfcElementQuantity", Name="Qto_SpaceBaseQuantities", Quantities=q)
        self.root("IfcRelDefinesByProperties", RelatedObjects=[s], RelatingPropertyDefinition=qto)

    def write(self, file_name):
        path = os.path.join(HERE, file_name)
        self.f.write(path)
        print(f"{file_name}: {os.path.getsize(path)} octets, {len(list(self.f))} entités")


def maison_test():
    b = Builder("IFC4", 1, "maison-test")
    a = math.radians(30)
    b.project("Maison d'essai Plan2CPE", (math.sin(a), math.cos(a)))
    building, bpl = b.building("Maison", 1.013, 2.007)
    rdc, etage, toit = b.storeys(building, bpl, [("Rez-de-chaussée", 0.0), ("Étage", 2.80), ("Toiture", 5.40)])
    t = 0.30

    # Rez-de-chaussée : L = 10 × 8 moins l'encoche [0, 4] × [5, 8].
    h = 2.80
    sud = b.wall(rdc, "Mur sud", 0, 0, 10, t, h)
    est = b.wall(rdc, "Mur est", 10 - t, 0, 10, 8, h)
    b.wall(rdc, "Mur nord", 4, 8 - t, 10, 8, h)
    b.wall(rdc, "Mur encoche ouest", 4, 5 - t, 4 + t, 8, h)
    encoche = b.wall(rdc, "Mur encoche nord", 0, 5 - t, 4 + t, 5, h)
    ouest = b.wall(rdc, "Mur ouest", 0, 0, t, 5, h)
    cloison = b.wall(rdc, "Cloison", 5.95, t, 6.05, 8 - t, 2.50)
    b.slab(rdc, "Dalle de sol", "BASESLAB", [(0, 0), (10, 0), (10, 8), (4, 8), (4, 5), (0, 5)], -0.25, 0.25)
    b.filler(rdc, sud, "window", "F1", 1.5, 1.20, 1.40, 0.90)
    b.filler(rdc, sud, "window", "F2 porte-fenêtre", 4.0, 2.00, 2.20, 0.0)
    b.filler(rdc, est, "window", "F3", 2.0, 0.80, 0.60, 1.60)
    b.filler(rdc, encoche, "window", "F4", 2.0, 1.00, 1.20, 0.90)
    b.filler(rdc, ouest, "door", "Porte d'entrée", 2.5, 1.00, 2.10, 0.0)
    b.filler(rdc, sud, "door", "Porte de garage", 8.0, 2.40, 2.10, 0.0)
    b.filler(rdc, cloison, "door", "Porte intérieure", 3.0, 0.90, 2.00, 0.0)
    b.space(rdc, "0.01", "Séjour", [(0.3, 0.3), (5.95, 0.3), (5.95, 7.7), (4.3, 7.7), (4.3, 4.7), (0.3, 4.7)], 2.50, 29.81)
    b.space(rdc, "0.02", "Garage", [(6.05, 0.3), (9.7, 0.3), (9.7, 7.7), (6.05, 7.7)], 2.50, 27.01)

    # Étage : rectangle [4, 10] × [0, 8].
    h = 2.60
    usud = b.wall(etage, "Mur sud étage", 4, 0, 10, t, h)
    b.wall(etage, "Mur est étage", 10 - t, 0, 10, 8, h)
    unord = b.wall(etage, "Mur nord étage", 4, 8 - t, 10, 8, h)
    uouest = b.wall(etage, "Mur ouest étage", 4, 0, 4 + t, 8, h)
    b.wall(etage, "Cloison étage", 4 + t, 4.0, 10 - t, 4.1, 2.40)
    b.slab(etage, "Plancher", "FLOOR", [(4, 0), (10, 0), (10, 8), (4, 8)], -0.25, 0.25)
    b.filler(etage, usud, "window", "F5", 7.0, 1.20, 1.40, 0.90)
    b.filler(etage, unord, "window", "F6", 7.0, 1.60, 1.20, 1.00)
    b.filler(etage, uouest, "window", "F7", 6.5, 0.90, 1.20, 0.90)
    b.space(etage, "1.01", "Chambre 1", [(4.3, 0.3), (9.7, 0.3), (9.7, 4.0), (4.3, 4.0)], 2.40, 19.38)
    b.space(etage, "1.02", "Salle de bain", [(4.3, 4.1), (9.7, 4.1), (9.7, 7.7), (4.3, 7.7)], 2.40, None)
    b.space_without_geometry(etage, "1.03", "Débarras", 3.50)

    # Toiture plate débordante de 0,50 m (ne doit pas compter dans le contour).
    b.slab(toit, "Toiture", "ROOF", [(3.5, -0.5), (10.5, -0.5), (10.5, 8.5), (3.5, 8.5)], 0.0, 0.25)
    b.skylight(toit, "Coupole", 6.5, 5.0, 0.30, 1.00, 1.00)
    b.close_storeys([rdc, etage, toit])
    b.write("maison-test.ifc")


def pavillon_mm():
    b = Builder("IFC2X3", 1000, "pavillon-mm")
    b.project("Pavillon d'essai Plan2CPE (mm)", (0.0, 1.0))
    building, bpl = b.building("Pavillon", 15.0, 8.0, 25.0)
    rdc, plafond = b.storeys(building, bpl, [("RDC", 0.0), ("Plafond", 2.50)])
    t = 0.365
    h = 2.75
    sud = b.wall(rdc, "Mur sud", 0, 0, 9, t, h)
    est = b.wall(rdc, "Mur est", 9 - t, 0, 9, 7, h)
    nord = b.wall(rdc, "Mur nord", 0, 7 - t, 9, 7, h)
    b.wall(rdc, "Mur ouest", 0, 0, t, 7, h)
    b.filler(rdc, sud, "window", "Fenêtre séjour", 3.0, 1.50, 1.30, 0.90)
    b.filler(rdc, nord, "window", "Fenêtre cuisine", 6.0, 1.00, 1.00, 1.10)
    b.filler(rdc, est, "door", "Porte d'entrée", 3.5, 1.00, 2.10, 0.0)
    # Abri de jardin séparé : [13, 16] × [1, 6], murs de 0,20 m.
    s = 0.20
    asud = b.wall(rdc, "Abri sud", 13, 1, 16, 1 + s, 2.30)
    b.wall(rdc, "Abri est", 16 - s, 1, 16, 6, 2.30)
    b.wall(rdc, "Abri nord", 13, 6 - s, 16, 6, 2.30)
    b.wall(rdc, "Abri ouest", 13, 1, 13 + s, 6, 2.30)
    b.filler(rdc, asud, "door", "Porte abri", 14.5, 0.90, 2.00, 0.0)
    b.close_storeys([rdc, plafond])
    b.write("pavillon-mm.ifc")


if __name__ == "__main__":
    maison_test()
    pavillon_mm()
