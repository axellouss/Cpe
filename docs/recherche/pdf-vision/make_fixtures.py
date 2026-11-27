#!/usr/bin/env python
"""make_fixtures.py - synthetic but realistic architectural plan PDFs + ground-truth JSON.

Fixtures written to ./fixtures :
  fr_A3_1-100.pdf        A3 landscape, 1:100, French, "AutoCAD style" (walls = loose line segments,
                         one long dimension line per chain, cm dimensions, Type1 Helvetica text)
                         views: Rez-de-chaussee, Etage, Coupe A-A, north arrow, title block
  de_A3_1-50.pdf         A3 landscape, 1:50, German, 3 pages (EG, OG, Schnitt), "Archicad style"
                         (filled wall polygons + outlines, one dimension line per dimension,
                         German mixed m/cm dimensions with superscript 5, embedded TrueType subset)
  *.truth.json           ground truth (rooms, areas, outlines, dimensions, scale, north, levels)
Geometry is modelled in metres, walls are unioned with shapely so that ground truth areas are exact.
"""
import json
import math
from pathlib import Path

from reportlab.lib.pagesizes import A3, landscape
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from shapely.geometry import Point, box
from shapely.ops import unary_union

OUT = Path(__file__).parent / "fixtures"
OUT.mkdir(exist_ok=True)

pdfmetrics.registerFont(TTFont("DejaVu", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"))
pdfmetrics.registerFont(TTFont("DejaVu-Bold", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"))

PAGE_W, PAGE_H = landscape(A3)  # 1190.55 x 841.89 pt

# line weights in mm on paper
LW_FRAME, LW_WALL, LW_CUT, LW_THIN, LW_DIM, LW_TICK, LW_HAIR = 0.70, 0.50, 0.50, 0.18, 0.13, 0.25, 0.09


class View:
    """A drawing view: model metres -> page points."""

    def __init__(self, c, ox_mm, oy_mm, scale_den, font, name):
        self.c, self.ox, self.oy = c, ox_mm * mm, oy_mm * mm
        self.den = scale_den
        self.k = 1000.0 / scale_den * mm  # points per metre
        self.font = font
        self.name = name
        self.truth_dims = []

    def P(self, x, y):
        return self.ox + x * self.k, self.oy + y * self.k

    def line(self, x0, y0, x1, y1, w, dash=None, gray=0):
        c = self.c
        c.setLineWidth(w * mm)
        c.setStrokeGray(gray)
        c.setDash(dash or [])
        a, b = self.P(x0, y0), self.P(x1, y1)
        c.line(a[0], a[1], b[0], b[1])
        c.setDash([])

    def poly(self, pts, w, fill_gray=None, stroke=True, close=True):
        c = self.c
        p = c.beginPath()
        a = self.P(*pts[0])
        p.moveTo(*a)
        for q in pts[1:]:
            p.lineTo(*self.P(*q))
        if close:
            p.close()
        c.setLineWidth(w * mm)
        if fill_gray is not None:
            c.setFillGray(fill_gray)
        c.drawPath(p, stroke=1 if stroke else 0, fill=1 if fill_gray is not None else 0)
        c.setFillGray(0)

    def text(self, x, y, s, size, bold=False, center=True, dy_pt=0.0):
        c = self.c
        f = self.font + ("-Bold" if bold else "")
        c.setFont(f, size)
        px, py = self.P(x, y)
        if center:
            c.drawCentredString(px, py + dy_pt, s)
        else:
            c.drawString(px, py + dy_pt, s)
        w = pdfmetrics.stringWidth(s, f, size)
        return px, py + dy_pt, w


def fmt_cm(v):
    return str(int(round(v * 100))), ""


def fmt_de(v):
    """German building convention: < 1 m in cm, >= 1 m in m with 2 decimals, half-cm as superscript 5."""
    mm_ = int(round(v * 1000))
    half = "5" if mm_ % 10 == 5 else ""
    cm = mm_ // 10
    if mm_ < 1000:
        return str(cm), half
    return f"{cm / 100:.2f}".replace(".", ","), half


def dim_chain(v, axis, pts, at, fmt, per_dim=False, fs=6.0, record=True):
    """Dimension chain. axis 'x': horizontal chain at model y=at. axis 'y': vertical chain at x=at.
    Dimension line(s), extension lines, 45 degree ticks, centred text above the line (rotated for 'y')."""
    c = v.c
    font = v.font
    ext = 1.6 * mm  # half-length of extension line / tick
    pts = sorted(pts)

    def PP(t):  # point on the chain line in page pts
        return v.P(t, at) if axis == "x" else v.P(at, t)

    c.setStrokeGray(0)
    c.setLineWidth(LW_DIM * mm)
    if per_dim:
        for a, b in zip(pts[:-1], pts[1:]):
            A, B = PP(a), PP(b)
            c.line(A[0], A[1], B[0], B[1])
    else:
        A, B = PP(pts[0]), PP(pts[-1])
        if axis == "x":
            c.line(A[0] - ext, A[1], B[0] + ext, B[1])
        else:
            c.line(A[0], A[1] - ext, B[0], B[1] + ext)
    for t in pts:
        X, Y = PP(t)
        c.setLineWidth(LW_DIM * mm)
        if axis == "x":
            c.line(X, Y - ext, X, Y + ext)
        else:
            c.line(X - ext, Y, X + ext, Y)
        c.setLineWidth(LW_TICK * mm)
        d = ext * 0.7
        c.line(X - d, Y - d, X + d, Y + d)
    row = 0
    for a, b in zip(pts[:-1], pts[1:]):
        main, sup = fmt(b - a)
        A, B = PP(a), PP(b)
        mx, my = (A[0] + B[0]) / 2, (A[1] + B[1]) / 2
        seg = math.hypot(B[0] - A[0], B[1] - A[1])
        wmain = pdfmetrics.stringWidth(main, font, fs)
        wsup = pdfmetrics.stringWidth(sup, font, fs * 0.65) if sup else 0
        tw = wmain + wsup
        displaced = tw > seg - 0.5
        # narrow dimensions: lift the text to an alternating second row (classic CAD behaviour)
        lift = 0.8 * mm
        if displaced:
            row = 1 - row
            lift += (fs + 0.6) * (1 + row * 0) + (fs * 0.0)
        else:
            row = 0
        c.saveState()
        if axis == "x":
            c.translate(mx, my + lift)
        else:
            c.translate(mx - lift, my)
            c.rotate(90)
        c.setFont(font, fs)
        c.setFillGray(0)
        c.drawString(-tw / 2, 0, main)
        if sup:
            c.setFont(font, fs * 0.65)
            c.drawString(-tw / 2 + wmain, fs * 0.38, sup)
        c.restoreState()
        if record:
            v.truth_dims.append({"text": main + ("^" + sup if sup else ""), "true_m": round(b - a, 4),
                                 "axis": axis, "displaced": bool(displaced),
                                 "mid_pt": [round(mx, 2), round(PAGE_H - my, 2)]})


class Plan:
    """Floor plan: wall boxes (unioned), openings, rooms."""

    def __init__(self, view, style):
        self.v, self.style = view, style
        self.walls, self.wins, self.doors, self.rooms = [], [], [], []

    def wall(self, x0, y0, x1, y1):
        self.walls.append(box(min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)))

    def window(self, x0, y0, x1, y1):
        self.wins.append((x0, y0, x1, y1))

    def door(self, x0, y0, x1, y1, hinge, swing, garage=False):
        """Opening rect (x0,y0,x1,y1) through a wall. hinge: 'lo'|'hi' end along the wall axis.
        swing: +1/-1 = opens towards increasing / decreasing across-wall coordinate."""
        self.doors.append((x0, y0, x1, y1, hinge, swing, garage))

    def room(self, name, x, y, label_fmt="{a} m²", show_area=True, heated=True):
        self.rooms.append({"name": name, "x": x, "y": y, "fmt": label_fmt, "show_area": show_area,
                           "heated": heated})

    def draw(self):
        v, c = self.v, self.v.c
        U = unary_union(self.walls)  # uncut wall mass
        assert U.geom_type == "Polygon", U.geom_type
        cuts = [box(*w) for w in self.wins] + [box(d[0], d[1], d[2], d[3]) for d in self.doors]
        W = U.difference(unary_union(cuts)) if cuts else U
        pieces = list(W.geoms) if W.geom_type == "MultiPolygon" else [W]
        c.setStrokeGray(0)
        if self.style == "bim":  # filled poche + outline as closed paths
            for pc in pieces:
                # only pieces without holes are produced after cutting openings... handle holes anyway
                p = c.beginPath()
                for ring in [pc.exterior, *pc.interiors]:
                    co = list(ring.coords)
                    p.moveTo(*v.P(*co[0]))
                    for q in co[1:-1]:
                        p.lineTo(*v.P(*q))
                    p.close()
                c.setFillGray(0.80)
                c.setLineWidth(LW_WALL * mm)
                c.drawPath(p, stroke=0, fill=1)  # fill first (even-odd not needed: rings oriented by shapely)
                c.setFillGray(0)
                for ring in [pc.exterior, *pc.interiors]:
                    co = list(ring.coords)
                    q = c.beginPath()
                    q.moveTo(*v.P(*co[0]))
                    for pt in co[1:-1]:
                        q.lineTo(*v.P(*pt))
                    q.close()
                    c.setLineWidth(0.35 * mm)
                    c.drawPath(q, stroke=1, fill=0)
        else:  # 'cad' : every wall face edge is a separate stroked line
            for pc in pieces:
                for ring in [pc.exterior, *pc.interiors]:
                    co = list(ring.coords)
                    for a, b in zip(co[:-1], co[1:]):
                        v.line(a[0], a[1], b[0], b[1], LW_WALL)
        # windows: frame rectangle + glass line
        for (x0, y0, x1, y1) in self.wins:
            v.poly([(x0, y0), (x1, y0), (x1, y1), (x0, y1)], LW_THIN)
            if (x1 - x0) > (y1 - y0):
                v.line(x0, (y0 + y1) / 2, x1, (y0 + y1) / 2, LW_THIN)
            else:
                v.line((x0 + x1) / 2, y0, (x0 + x1) / 2, y1, LW_THIN)
        # doors: leaf + quarter-circle swing (Bezier arc)
        for (x0, y0, x1, y1, hinge, swing, garage) in self.doors:
            horiz = (x1 - x0) > (y1 - y0)  # opening runs along x
            if garage:
                if horiz:
                    v.line(x0, (y0 + y1) / 2, x1, (y0 + y1) / 2, LW_THIN, dash=[3, 2])
                else:
                    v.line((x0 + x1) / 2, y0, (x0 + x1) / 2, y1, LW_THIN, dash=[3, 2])
                continue
            if horiz:
                wdt = x1 - x0
                hx = x0 if hinge == "lo" else x1
                fy = y1 if swing > 0 else y0
                v.line(hx, fy, hx, fy + swing * wdt, 0.25)
                cx, cy = v.P(hx, fy)
                r = wdt * v.k
                if hinge == "lo":
                    start, extent = (0, 90) if swing > 0 else (270, 90)
                else:
                    start, extent = (90, 90) if swing > 0 else (180, 90)
            else:
                wdt = y1 - y0
                hy = y0 if hinge == "lo" else y1
                fx = x1 if swing > 0 else x0
                v.line(fx, hy, fx + swing * wdt, hy, 0.25)
                cx, cy = v.P(fx, hy)
                r = wdt * v.k
                if hinge == "lo":
                    start, extent = (0, 90) if swing > 0 else (90, 90)
                else:
                    start, extent = (270, 90) if swing > 0 else (180, 90)
            c.setLineWidth(LW_HAIR * mm)
            c.arc(cx - r, cy - r, cx + r, cy + r, start, extent)
        # room labels
        truth_rooms = []
        holes = list(U.interiors)
        from shapely.geometry import Polygon
        for r in self.rooms:
            poly = None
            for h in holes:
                ph = Polygon(h)
                if ph.contains(Point(r["x"], r["y"])):
                    poly = ph
                    break
            assert poly is not None, r
            area = poly.area
            px, py, _ = v.text(r["x"], r["y"], r["name"], 8, bold=False)
            label = None
            if r["show_area"]:
                dec = "." if "{a.}" in r["fmt"] else ","
                a_txt = f"{area:.2f}".replace(".", dec)
                label = r["fmt"].replace("{a.}", a_txt).replace("{a}", a_txt)
                v.text(r["x"], r["y"], label, 7, dy_pt=-9.5)
            truth_rooms.append({"name": r["name"], "area_true_m2": round(area, 4), "area_label": label,
                                "heated_true": r["heated"], "label_pt": [round(px, 2), round(PAGE_H - py, 2)],
                                "poly_pt": [[round(v.P(x, y)[0], 2), round(PAGE_H - v.P(x, y)[1], 2)]
                                            for x, y in poly.exterior.coords]})
        ext = U.exterior
        return {"view": v.name, "outline_area_m2": round(Polygon(ext).area, 4),
                "outline_pt": [[round(v.P(x, y)[0], 2), round(PAGE_H - v.P(x, y)[1], 2)] for x, y in ext.coords],
                "rooms": truth_rooms}


def stairs(v, x0, y0, x1, y1, n=10):
    """Stair symbol: n treads across x, running along y."""
    v.poly([(x0, y0), (x1, y0), (x1, y1), (x0, y1)], LW_THIN)
    for i in range(1, n):
        y = y0 + (y1 - y0) * i / n
        v.line(x0, y, x1, y, LW_HAIR)
    v.line((x0 + x1) / 2, y0 + 0.1, (x0 + x1) / 2, y1 - 0.1, LW_HAIR)


def north_arrow(c, cx, cy, angle_cw_deg, font):
    """Circle + filled needle + 'N' at the tip. angle = clockwise from page-up."""
    r = 8 * mm
    c.setLineWidth(LW_THIN * mm)
    c.setStrokeGray(0)
    c.circle(cx, cy, r, stroke=1, fill=0)
    a = math.radians(angle_cw_deg)
    ux, uy = math.sin(a), math.cos(a)  # unit vector towards north
    px_, py_ = uy, -ux
    tip = (cx + ux * r * 0.95, cy + uy * r * 0.95)
    b1 = (cx - ux * r * 0.6 + px_ * r * 0.3, cy - uy * r * 0.6 + py_ * r * 0.3)
    b2 = (cx - ux * r * 0.6 - px_ * r * 0.3, cy - uy * r * 0.6 - py_ * r * 0.3)
    p = c.beginPath()
    p.moveTo(*tip)
    p.lineTo(*b1)
    p.lineTo(*b2)
    p.close()
    c.setFillGray(0)
    c.drawPath(p, stroke=1, fill=1)
    c.setFont(font + "-Bold", 10)
    c.drawCentredString(cx + ux * (r + 5 * mm), cy + uy * (r + 5 * mm) - 3.5, "N")


def frame_and_title(c, font, rows, tb_w=170, tb_h=48):
    c.setStrokeGray(0)
    c.setLineWidth(LW_FRAME * mm)
    c.rect(10 * mm, 10 * mm, PAGE_W - 20 * mm, PAGE_H - 20 * mm)
    x0 = PAGE_W - 10 * mm - tb_w * mm
    y0 = 10 * mm
    c.rect(x0, y0, tb_w * mm, tb_h * mm)
    n = len(rows)
    rh = tb_h * mm / n
    c.setLineWidth(LW_THIN * mm)
    for i, (key, val, big) in enumerate(rows):
        y = y0 + tb_h * mm - (i + 1) * rh
        if i < n - 1:
            c.line(x0, y, x0 + tb_w * mm, y)
        c.setFont(font, 5.5)
        c.drawString(x0 + 2 * mm, y + rh - 6.5, key)
        c.setFont(font + ("-Bold" if big else ""), 10 if big else 8)
        c.drawString(x0 + 34 * mm, y + rh * 0.3, val)
    c.line(x0 + 32 * mm, y0, x0 + 32 * mm, y0 + tb_h * mm)


def section(v, depth, t_out, lang, fmt, per_dim):
    """Cross-section: 2 storeys, clear height 2.50, slabs 0.30 -> storey height 2.80, pitched roof."""
    D = depth
    # ground slab + intermediate slabs (cut -> thick lines, light fill)
    for z0, z1, xa, xb in [(-0.30, 0.0, 0, D), (2.50, 2.80, t_out, D - t_out), (5.30, 5.60, t_out, D - t_out)]:
        v.poly([(xa, z0), (xb, z0), (xb, z1), (xa, z1)], LW_CUT, fill_gray=0.85)
    for xa, xb in [(0, t_out), (D - t_out, D)]:
        v.poly([(xa, 0), (xb, 0), (xb, 5.60), (xa, 5.60)], LW_CUT, fill_gray=0.85)
    # roof
    v.poly([(-0.40, 5.60), (D / 2, 8.20), (D + 0.40, 5.60)], LW_CUT, close=False)
    v.poly([(-0.10, 5.60), (D / 2, 7.90), (D + 0.10, 5.60)], LW_THIN, close=False)
    # terrain
    v.line(-1.5, -0.15, 0, -0.15, LW_THIN)
    v.line(D, -0.15, D + 1.5, -0.15, LW_THIN)
    # level markers on the right
    lv = [(0.0, "±0,00"), (2.80, "+2,80"), (5.60, "+5,60")]
    for z, s in lv:
        x = D + 1.2
        v.line(D + 0.5, z, D + 2.6, z, LW_DIM)
        v.poly([(x, z), (x - 0.15, z + 0.25), (x + 0.15, z + 0.25)], LW_DIM)
        v.text(x + 0.25, z, s, 6.5, center=False, dy_pt=2.0)
    names = {"fr": ("RDC", "Étage", "Grenier (non chauffé)", "HSP 2,50 m"),
             "de": ("EG", "OG", "Speicher (unbeheizt)", "RH 2,50 m")}[lang]
    v.text(D / 2, 1.3, names[0], 8)
    v.text(D / 2, 0.8, names[3], 6.5)
    v.text(D / 2, 4.1, names[1], 8)
    v.text(D / 2, 3.6, names[3], 6.5)
    v.text(D / 2, 6.3, names[2], 7)
    dim_chain(v, "y", [0, 2.50, 2.80, 5.30, 5.60], -1.2, fmt, per_dim=per_dim)
    dim_chain(v, "y", [0, 2.80, 5.60], -2.0, fmt, per_dim=per_dim)
    dim_chain(v, "x", [0, t_out, D - t_out, D], -1.0, fmt, per_dim=per_dim)
    return {"levels_m": [0.0, 2.80, 5.60], "storey_height_m": 2.80, "clear_height_m": 2.50}


# --------------------------------------------------------------------------------------------
def make_fr():
    path = OUT / "fr_A3_1-100.pdf"
    c = canvas.Canvas(str(path), pagesize=(PAGE_W, PAGE_H), pageCompression=1)
    c.setTitle("Maison unifamiliale - plans")
    font = "Helvetica"
    truth = {"file": path.name, "scale_den": 100, "unit_dims": "cm", "pages": []}
    pg = {"views": [], "dims": []}

    # ---------------- RDC ----------------
    v = View(c, 45, 165, 100, font, "Rez-de-chaussée")
    p = Plan(v, "cad")
    T = 0.40
    # main house 10.00 x 8.50, outer walls 0.40
    p.wall(0, 0, 10, T); p.wall(0, 8.5 - T, 10, 8.5); p.wall(0, 0, T, 8.5); p.wall(10 - T, 0, 10, 8.5)
    # partitions 0.12
    p.wall(6.30, T, 6.42, 8.10)            # vertical
    p.wall(T, 5.90, 6.30, 6.02)            # sejour / cuisine
    p.wall(6.42, 4.00, 9.60, 4.12)         # hall / wc
    p.wall(6.42, 5.50, 9.60, 5.62)         # wc / buanderie
    # annex (garage + cave) 3.50 x 8.50, walls 0.24
    p.wall(10, 0, 13.5, 0.24); p.wall(13.26, 0, 13.5, 8.5); p.wall(10, 8.26, 13.5, 8.5)
    p.wall(10, 5.76, 13.26, 6.00)
    # windows (outer walls)
    p.window(1.50, 0, 4.00, T)             # sejour south
    p.window(0, 2.00, T, 3.50)             # sejour west
    p.window(2.00, 8.10, 3.50, 8.50)       # cuisine north
    p.window(7.20, 8.10, 8.20, 8.50)       # buanderie north
    p.window(11.20, 8.26, 12.00, 8.50)     # cave north
    # doors
    p.door(7.50, 0, 8.50, T, "lo", +1)                 # entrance
    p.door(6.30, 1.50, 6.42, 2.40, "lo", -1)           # hall -> sejour
    p.door(2.00, 5.90, 2.90, 6.02, "lo", +1)           # sejour -> cuisine
    p.door(6.80, 4.00, 7.60, 4.12, "lo", +1)           # hall -> wc
    p.door(6.30, 6.60, 6.42, 7.40, "hi", +1)           # cuisine -> buanderie
    p.door(9.60, 2.00, 10.0, 2.90, "lo", +1)           # hall -> garage
    p.door(11.0, 5.76, 11.9, 6.00, "lo", +1)           # garage -> cave
    p.door(10.50, 0, 13.00, 0.24, "lo", +1, garage=True)
    p.room("Séjour", 3.3, 3.2)
    p.room("Cuisine", 3.3, 7.2)
    p.room("Hall", 8.3, 3.2)
    p.room("WC", 8.6, 4.95, label_fmt="{a} m2")
    p.room("Buanderie", 8.0, 7.0, label_fmt="S = {a} m²")
    p.room("Garage", 11.6, 3.2, heated=False)
    p.room("Cave / Keller", 11.63, 7.25, heated=False)
    t = p.draw()
    stairs(v, 8.55, 0.45, 9.55, 2.95 - 1.2, n=6)
    v.text(5.0, -3.6, "Rez-de-chaussée", 10, bold=True)
    dim_chain(v, "x", [0, 1.5, 4.0, 7.5, 8.5, 10.0, 10.5, 13.0, 13.5], -1.0, fmt_cm)
    dim_chain(v, "x", [0, 10.0, 13.5], -1.8, fmt_cm)
    dim_chain(v, "x", [0, 13.5], -2.6, fmt_cm)
    dim_chain(v, "y", [0, 2.0, 3.5, 8.5], -1.0, fmt_cm)
    dim_chain(v, "y", [0, 8.5], -1.8, fmt_cm)
    dim_chain(v, "x", [0, T, 6.30, 6.42, 9.60, 10.0, 13.26, 13.5], 9.3, fmt_cm)  # through-wall chain (top)
    t["heated_outline_area_m2"] = 85.0
    t["dims"] = v.truth_dims
    pg["views"].append(t)

    # ---------------- Etage ----------------
    v = View(c, 225, 165, 100, font, "Étage")
    p = Plan(v, "cad")
    p.wall(0, 0, 10, T); p.wall(0, 8.5 - T, 10, 8.5); p.wall(0, 0, T, 8.5); p.wall(10 - T, 0, 10, 8.5)
    p.wall(4.90, T, 5.02, 4.20)
    p.wall(T, 4.20, 9.60, 4.32)
    p.wall(3.90, 4.32, 4.02, 8.10)
    p.wall(6.50, 4.32, 6.62, 8.10)
    p.window(1.50, 0, 3.00, T); p.window(6.50, 0, 8.00, T); p.window(9.60, 1.50, 10, 2.70)
    p.window(1.20, 8.10, 2.70, 8.50); p.window(7.50, 8.10, 8.50, 8.50); p.window(4.80, 8.10, 5.80, 8.50)
    p.door(4.05, 4.20, 4.85, 4.32, "lo", -1)
    p.door(5.20, 4.20, 6.10, 4.32, "hi", -1)
    p.door(3.90, 5.00, 4.02, 5.90, "lo", -1)
    p.door(6.50, 5.00, 6.62, 5.90, "lo", +1)
    p.room("Chambre 1", 2.6, 2.4)
    p.room("Chambre 2", 7.3, 2.4)
    p.room("Chambre 3", 2.1, 6.4)
    p.room("Palier", 5.25, 6.9)
    p.room("SdB", 8.1, 6.4, show_area=False)
    t = p.draw()
    stairs(v, 4.75, 4.40, 5.75, 6.10, n=6)
    v.text(5.0, -3.6, "Étage", 10, bold=True)
    dim_chain(v, "x", [0, 1.5, 3.0, 6.5, 8.0, 10.0], -1.0, fmt_cm)
    dim_chain(v, "x", [0, 10.0], -1.8, fmt_cm)
    dim_chain(v, "y", [0, 1.5, 2.7, 8.5], 11.0, fmt_cm)
    dim_chain(v, "y", [0, 8.5], 11.8, fmt_cm)
    t["heated_outline_area_m2"] = 85.0
    t["dims"] = v.truth_dims
    pg["views"].append(t)

    # ---------------- Coupe ----------------
    v = View(c, 60, 34, 100, font, "Coupe A-A")
    sec = section(v, 8.5, T, "fr", fmt_cm, per_dim=False)
    v.text(4.25, -1.75, "Coupe A-A", 10, bold=True)
    sec["view"] = "Coupe A-A"
    sec["dims"] = v.truth_dims
    pg["views"].append(sec)

    north_arrow(c, 215 * mm, 70 * mm, 25.0, font)
    truth["north_cw_from_up_deg"] = 25.0
    frame_and_title(c, font, [
        ("Projet", "Maison unifamiliale à Strassen", False),
        ("Maître d'ouvrage", "M. et Mme Exemple", False),
        ("Plan", "RDC - Étage - Coupe A-A", True),
        ("Phase", "Autorisation de bâtir", False),
        ("Échelle / Date", "Échelle 1:100        12.03.2024", True),
        ("Plan n° / Indice", "AB-101   ind. B", False),
    ])
    c.setFont(font, 6)
    c.drawString(180 * mm, 45 * mm, "Toutes les cotes sont en cm. Niveaux en m.")
    c.showPage()
    c.save()
    truth["pages"].append(pg)
    (OUT / "fr_A3_1-100.truth.json").write_text(json.dumps(truth, indent=1, ensure_ascii=False))
    return path


def make_de():
    path = OUT / "de_A3_1-50.pdf"
    c = canvas.Canvas(str(path), pagesize=(PAGE_W, PAGE_H), pageCompression=1)
    c.setTitle("Einfamilienhaus - Werkplan")
    font = "DejaVu"
    truth = {"file": path.name, "scale_den": 50, "unit_dims": "de-mixed", "pages": []}
    T = 0.42
    PW = 0.115
    W_, D_ = 9.84, 8.84

    def title(plan_name):
        frame_and_title(c, font, [
            ("Bauvorhaben", "Neubau Einfamilienhaus in Mersch", False),
            ("Bauherr", "Fam. Mustermann", False),
            ("Planinhalt", plan_name, True),
            ("Phase", "Ausführungsplanung", False),
            ("Maßstab / Datum", "Maßstab 1:50        05.11.2023", True),
            ("Plan-Nr. / Index", "W-201   Index c", False),
        ], tb_w=150, tb_h=40)

    # ---------- EG ----------
    pg = {"views": []}
    v = View(c, 110, 90, 50, font, "Grundriss Erdgeschoss")
    p = Plan(v, "bim")
    p.wall(0, 0, W_, T); p.wall(0, D_ - T, W_, D_); p.wall(0, 0, T, D_); p.wall(W_ - T, 0, W_, D_)
    p.wall(6.04, T, 6.155, D_ - T)
    p.wall(T, 5.42, 6.04, 5.535)
    p.wall(6.155, 4.62, 9.42, 4.735)
    p.wall(6.155, 5.935, 9.42, 6.05)
    # garage on the left
    p.wall(-3.50, 0, 0, 0.24); p.wall(-3.50, 0, -3.26, 6.0); p.wall(-3.50, 5.76, 0, 6.0)
    p.window(1.60, 0, 4.10, T); p.window(2.00, D_ - T, 3.50, D_); p.window(W_ - T, 1.50, W_, 2.76)
    p.window(7.30, D_ - T, 8.30, D_); p.window(0, 6.60, T, 7.80)
    p.door(7.40, 0, 8.41, T, "lo", +1)
    p.door(6.04, 1.60, 6.155, 2.485, "lo", -1)
    p.door(2.00, 5.42, 2.885, 5.535, "lo", +1)
    p.door(6.60, 4.62, 7.36, 4.735, "lo", +1)
    p.door(6.04, 6.80, 6.155, 7.685, "hi", +1)
    p.door(0, 2.00, T, 2.885, "lo", -1)
    p.door(-3.0, 0, -0.5, 0.24, "lo", +1, garage=True)
    p.room("Wohnzimmer", 3.2, 3.2, label_fmt="{a.} m2")
    p.room("Küche", 3.2, 7.2)
    p.room("Flur", 7.9, 3.4, label_fmt="{a} qm")
    p.room("WC", 8.3, 5.45, label_fmt="A: {a} m²")
    p.room("Technik", 7.8, 7.4, label_fmt="NGF {a} m²", heated=False)
    p.room("Garage", -1.63, 3.2, label_fmt="{a.} m2", heated=False)
    t = p.draw()
    stairs(v, 8.37, 0.47, 9.37, 2.47, n=8)
    v.text(3.2, -2.75, "Grundriss Erdgeschoss", 11, bold=True)
    dim_chain(v, "x", [-3.5, -3.0, -0.5, 0, 1.6, 4.1, 7.4, 8.41, W_], -0.7, fmt_de, per_dim=True)
    dim_chain(v, "x", [-3.5, 0, W_], -1.2, fmt_de, per_dim=True)
    dim_chain(v, "x", [-3.5, W_], -1.7, fmt_de, per_dim=True)
    dim_chain(v, "y", [0, 1.5, 2.76, D_], W_ + 0.7, fmt_de, per_dim=True)
    dim_chain(v, "y", [0, D_], W_ + 1.2, fmt_de, per_dim=True)
    dim_chain(v, "x", [0, T, 6.04, 6.155, 9.42, W_], D_ + 0.7, fmt_de, per_dim=True)  # with 11^5 and 3,26^5
    dim_chain(v, "y", [T, 4.62, 4.735, 5.935, 6.05, D_ - T], 9.0, fmt_de, per_dim=True)  # interior chain
    t["heated_outline_area_m2"] = round(W_ * D_, 4)
    t["dims"] = v.truth_dims
    pg["views"].append(t)
    north_arrow(c, 40 * mm, 250 * mm, -40.0, font)
    truth["north_cw_from_up_deg"] = -40.0
    title("Grundriss Erdgeschoss")
    c.showPage()
    truth["pages"].append(pg)

    # ---------- OG ----------
    pg = {"views": []}
    v = View(c, 60, 90, 50, font, "Grundriss Obergeschoss")
    p = Plan(v, "bim")
    p.wall(0, 0, W_, T); p.wall(0, D_ - T, W_, D_); p.wall(0, 0, T, D_); p.wall(W_ - T, 0, W_, D_)
    p.wall(4.92, T, 5.035, 4.42)
    p.wall(T, 4.42, 9.42, 4.535)
    p.wall(3.92, 4.535, 4.035, D_ - T)
    p.wall(6.42, 4.535, 6.535, D_ - T)
    p.window(1.60, 0, 3.10, T); p.window(6.40, 0, 7.90, T); p.window(W_ - T, 1.50, W_, 2.76)
    p.window(1.20, D_ - T, 2.70, D_); p.window(7.40, D_ - T, 8.40, D_); p.window(0, 1.50, T, 2.76)
    p.door(4.08, 4.42, 4.84, 4.535, "lo", -1)
    p.door(5.20, 4.42, 6.085, 4.535, "hi", -1)
    p.door(3.92, 5.20, 4.035, 6.085, "lo", -1)
    p.door(6.42, 5.20, 6.535, 6.085, "lo", +1)
    p.room("Schlafzimmer", 2.6, 2.5)
    p.room("Kinderzimmer 1", 7.3, 2.5)
    p.room("Kinderzimmer 2", 2.1, 6.6, label_fmt="{a.} m2")
    p.room("Flur", 5.25, 7.3, label_fmt="{a} qm")
    p.room("Bad", 8.0, 6.6, label_fmt="A: {a} m²")
    t = p.draw()
    stairs(v, 4.75, 4.6, 5.75, 6.6, n=8)
    v.text(4.9, -2.3, "Grundriss Obergeschoss", 11, bold=True)
    dim_chain(v, "x", [0, 1.6, 3.1, 6.4, 7.9, W_], -0.7, fmt_de, per_dim=True)
    dim_chain(v, "x", [0, W_], -1.2, fmt_de, per_dim=True)
    dim_chain(v, "y", [0, 1.5, 2.76, D_], W_ + 0.7, fmt_de, per_dim=True)
    dim_chain(v, "y", [0, D_], W_ + 1.2, fmt_de, per_dim=True)
    dim_chain(v, "x", [0, T, 4.92, 5.035, 9.42, W_], D_ + 0.7, fmt_de, per_dim=True)
    t["heated_outline_area_m2"] = round(W_ * D_, 4)
    t["dims"] = v.truth_dims
    pg["views"].append(t)
    title("Grundriss Obergeschoss")
    c.showPage()
    truth["pages"].append(pg)

    # ---------- Schnitt ----------
    pg = {"views": []}
    v = View(c, 90, 75, 50, font, "Schnitt A-A")
    sec = section(v, D_, T, "de", fmt_de, per_dim=True)
    v.text(D_ / 2, -1.7, "Schnitt A-A", 11, bold=True)
    sec["view"] = "Schnitt A-A"
    sec["dims"] = v.truth_dims
    pg["views"].append(sec)
    title("Schnitt A-A")
    c.showPage()
    truth["pages"].append(pg)
    c.save()
    (OUT / "de_A3_1-50.truth.json").write_text(json.dumps(truth, indent=1, ensure_ascii=False))
    return path


if __name__ == "__main__":
    print(make_fr())
    print(make_de())
