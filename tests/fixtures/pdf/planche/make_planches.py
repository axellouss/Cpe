#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Générateur de planches d'autorisation de bâtir SYNTHÉTIQUES (PDF vectoriels) et de leur vérité de référence.

Les planches imitent la STRUCTURE d'une planche d'architecte luxembourgeoise exportée d'Archicad (plusieurs vues
sur une page, cadre de situation répété et découpé, murs hachurés sous chemin de découpe, isolant en bande jaune,
pièces en « zones » remplies avec nom et surface, cotes de baies largeur / hauteur superposées, demi-centimètres en
exposant, compositions de parois, coupes au terrain en pointillé de micro-traits, façades, tableau des surfaces,
nord tourné, cartouche). Toutes les données sont INVENTÉES : « Maison Exemple », « Lot 7 », « 12, rue des Essais »,
« L-0000 Exempleville », architecte « Atelier Modèle », maître d'ouvrage « M. et Mme Test ».

Usage : python3 tests/fixtures/pdf/planche/make_planches.py
Sorties (dans le dossier du script) : planche_*.pdf et planche_*.truth.json.

Repère de la vérité : points PDF, origine en haut à gauche de la page, y vers le bas (celui des lecteurs du dépôt).
Le script est déterministe : aucune date du jour, aléas semés, reportlab en mode « invariant ».
"""
import json
import math
import os
import random
from contextlib import contextmanager

from reportlab.lib.utils import ImageReader
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas as rl_canvas
from reportlab.pdfgen.canvas import FILL_EVEN_ODD, FILL_NON_ZERO

HERE = os.path.dirname(os.path.abspath(__file__))

PT_PER_M = 72 / 0.0254  # points par mètre de PAPIER
A1 = (2383.94, 1683.78)
A2 = (1683.78, 1190.55)
A3 = (1190.55, 841.89)

BLACK = (0, 0, 0)
WHITE = (1, 1, 1)
GREY_TXT = (0.55, 0.55, 0.55)
ROOM_FILL = (0.937, 0.937, 0.937)
INSUL_FILL = (0.98, 0.953, 0.76)
INSUL_HATCH = (0.45, 0.40, 0.20)
LAWN = (0.875, 0.925, 0.86)
PAVING = (0.86, 0.86, 0.86)
STREET = (0.80, 0.80, 0.80)
RED = (0.85, 0.08, 0.08)
VIOLET = (0.52, 0.18, 0.78)
BLUE = (0.05, 0.25, 0.85)
FACADE = (0.90, 0.90, 0.89)
GLASS = (0.78, 0.84, 0.88)
ROOF = (0.78, 0.78, 0.78)
ROOF_IN = (0.90, 0.90, 0.90)
DARK_WALL = (0.33, 0.33, 0.33)

FONT = 'Helvetica'
BOLD = 'Helvetica-Bold'


# ───────────────────────────── Petits outils ─────────────────────────────

def fr(v, nd=2):
    """Nombre à la française : 23.456 → « 23,46 »."""
    return f'{v:.{nd}f}'.replace('.', ',').replace('-', '-')


def poly_area(poly):
    s = 0.0
    for i in range(len(poly)):
        x0, y0 = poly[i]
        x1, y1 = poly[(i + 1) % len(poly)]
        s += x0 * y1 - x1 * y0
    return abs(s) / 2


def rect_poly(r):
    x0, y0, x1, y1 = r
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]


def rect_sub(r, cut):
    """Rectangle r privé du rectangle cut : liste de rectangles disjoints."""
    x0, y0, x1, y1 = r
    cx0, cy0, cx1, cy1 = cut
    if cx0 >= x1 - 1e-9 or cx1 <= x0 + 1e-9 or cy0 >= y1 - 1e-9 or cy1 <= y0 + 1e-9:
        return [r]
    out = []
    if cy0 > y0 + 1e-9:
        out.append((x0, y0, x1, cy0))
    if cy1 < y1 - 1e-9:
        out.append((x0, cy1, x1, y1))
    my0, my1 = max(y0, cy0), min(y1, cy1)
    if cx0 > x0 + 1e-9:
        out.append((x0, my0, cx0, my1))
    if cx1 < x1 - 1e-9:
        out.append((cx1, my0, x1, my1))
    return out


def rects_minus(rects, cuts):
    for cut in cuts:
        nxt = []
        for r in rects:
            nxt.extend(rect_sub(r, cut))
        rects = nxt
    return rects


def union_edges(rects):
    """Bord de l'union de rectangles axés : segments ((x0, y0), (x1, y1)) fusionnés."""
    if not rects:
        return []
    xs = sorted({round(v, 5) for r in rects for v in (r[0], r[2])})
    ys = sorted({round(v, 5) for r in rects for v in (r[1], r[3])})
    nx, ny = len(xs) - 1, len(ys) - 1

    def inside(cx, cy):
        for r in rects:
            if r[0] < cx < r[2] and r[1] < cy < r[3]:
                return True
        return False

    filled = [[inside((xs[i] + xs[i + 1]) / 2, (ys[j] + ys[j + 1]) / 2) for j in range(ny)] for i in range(nx)]

    def f(i, j):
        return 0 <= i < nx and 0 <= j < ny and filled[i][j]

    edges = []
    for i in range(nx + 1):  # bords verticaux à x = xs[i]
        start = None
        for j in range(ny + 1):
            b = j < ny and f(i - 1, j) != f(i, j)
            if b and start is None:
                start = j
            if not b and start is not None:
                edges.append(((xs[i], ys[start]), (xs[i], ys[j])))
                start = None
    for j in range(ny + 1):  # bords horizontaux à y = ys[j]
        start = None
        for i in range(nx + 1):
            b = i < nx and f(i, j - 1) != f(i, j)
            if b and start is None:
                start = i
            if not b and start is not None:
                edges.append(((xs[start], ys[j]), (xs[i], ys[j])))
                start = None
    return edges


def dim_parts(v):
    """Cote en mètres → (texte principal, exposant) : 0.785 → ('78', '5') ; 2.215 → ('2,21', '5') ; 4.0 → ('4,00', '')."""
    half = int(round(v * 200))  # demi-centimètres
    cm, h = divmod(half, 2)
    sup = '5' if h else ''
    if cm < 100:
        return str(cm), sup
    return f'{cm // 100},{cm % 100:02d}', sup


def level_text(z, z0):
    sign = '+' if z > 1e-9 else ('-' if z < -1e-9 else '±')
    return f'{sign}{fr(abs(z))}=+{fr(z0 + z)}'


# ───────────────────────────── Feuille (repère haut-bas) ─────────────────────────────

class Sheet:
    """Canevas reportlab en repère « y vers le bas » (bottomup=0), avec compteurs de traits."""

    def __init__(self, path, size, title, subject):
        self.path = path
        self.W, self.H = size
        self.c = rl_canvas.Canvas(path, pagesize=size, bottomup=0, invariant=1, pageCompression=1)
        self.c.setTitle(title)
        self.c.setAuthor('Atelier Modèle (données inventées)')
        self.c.setSubject(subject)
        self.c.setCreator('tests/fixtures/pdf/planche/make_planches.py')
        self.c.setLineCap(0)
        self.c.setLineJoin(0)
        self.counts = {'hatch_lines': 0, 'stipple_traits': 0, 'tile_lines': 0, 'clip_paths': 0}
        self.page_counts = []

    def new_page(self):
        self.page_counts.append(dict(self.counts))
        for k in self.counts:
            self.counts[k] = 0
        self.c.showPage()
        self.c.setLineCap(0)
        self.c.setLineJoin(0)

    def save(self):
        self.page_counts.append(dict(self.counts))
        self.c.save()

    # Traits et surfaces
    def line(self, x0, y0, x1, y1, w=0.25, col=BLACK, dash=None):
        c = self.c
        c.setLineWidth(w)
        c.setStrokeColorRGB(*col)
        c.setDash(dash or [])
        c.line(x0, y0, x1, y1)
        if dash:
            c.setDash([])

    def lines(self, segs, w=0.25, col=BLACK, dash=None):
        if not segs:
            return
        c = self.c
        c.setLineWidth(w)
        c.setStrokeColorRGB(*col)
        c.setDash(dash or [])
        p = c.beginPath()
        for (a, b) in segs:
            p.moveTo(*a)
            p.lineTo(*b)
        c.drawPath(p, stroke=1, fill=0)
        if dash:
            c.setDash([])

    def poly(self, pts, fill=None, stroke=None, w=0.25, dash=None, closed=True):
        c = self.c
        p = c.beginPath()
        p.moveTo(*pts[0])
        for q in pts[1:]:
            p.lineTo(*q)
        if closed:
            p.close()
        if fill is not None:
            c.setFillColorRGB(*fill)
        if stroke is not None:
            c.setStrokeColorRGB(*stroke)
            c.setLineWidth(w)
            c.setDash(dash or [])
        c.drawPath(p, stroke=1 if stroke is not None else 0, fill=1 if fill is not None else 0)
        if dash:
            c.setDash([])

    def rect(self, x0, y0, x1, y1, fill=None, stroke=None, w=0.25, dash=None):
        self.poly(rect_poly((x0, y0, x1, y1)), fill=fill, stroke=stroke, w=w, dash=dash)

    def circle(self, x, y, r, fill=None, stroke=BLACK, w=0.25):
        c = self.c
        if fill is not None:
            c.setFillColorRGB(*fill)
        if stroke is not None:
            c.setStrokeColorRGB(*stroke)
            c.setLineWidth(w)
        c.setDash([])
        c.circle(x, y, r, stroke=1 if stroke is not None else 0, fill=1 if fill is not None else 0)

    def arc(self, cx, cy, r, a0, a1, w=0.2, col=BLACK):
        """Arc de cercle (angles en degrés, repère de la feuille : 0 = droite, 90 = BAS)."""
        c = self.c
        c.setLineWidth(w)
        c.setStrokeColorRGB(*col)
        c.setDash([])
        p = c.beginPath()
        n = max(1, int(math.ceil(abs(a1 - a0) / 90 - 1e-9)))
        step = (a1 - a0) / n
        t0 = math.radians(a0)
        p.moveTo(cx + r * math.cos(t0), cy + r * math.sin(t0))
        for i in range(n):
            s0 = math.radians(a0 + i * step)
            s1 = math.radians(a0 + (i + 1) * step)
            k = 4 / 3 * math.tan((s1 - s0) / 4)
            p1 = (cx + r * (math.cos(s0) - k * math.sin(s0)), cy + r * (math.sin(s0) + k * math.cos(s0)))
            p2 = (cx + r * (math.cos(s1) + k * math.sin(s1)), cy + r * (math.sin(s1) - k * math.cos(s1)))
            p3 = (cx + r * math.cos(s1), cy + r * math.sin(s1))
            p.curveTo(p1[0], p1[1], p2[0], p2[1], p3[0], p3[1])
        c.drawPath(p, stroke=1, fill=0)

    # Texte
    def text(self, s, x, y, size=6, font=FONT, col=BLACK, anchor='l', angle=0):
        """Texte de ligne de base y. angle = 90 : lu de bas en haut. Renvoie la boîte (x0, y0, x1, y1)."""
        c = self.c
        w = stringWidth(s, font, size)
        dx = {'l': 0, 'c': -w / 2, 'r': -w}[anchor]
        c.setFont(font, size)
        c.setFillColorRGB(*col)
        if angle == 0:
            c.drawString(x + dx, y, s)
            return (x + dx, y - size, x + dx + w, y)
        c.saveState()
        c.translate(x, y)
        c.rotate(-angle)
        c.drawString(dx, 0, s)
        c.restoreState()
        if angle == 90:
            return (x - size, y - dx - w, x, y - dx)
        return None

    def text_sup(self, main, sup, x, y, size=6, font=FONT, col=BLACK, anchor='c', angle=0):
        """Texte avec petit exposant (« 78 » + « 5 ») ; ancrage sur l'ensemble."""
        w0 = stringWidth(main, font, size)
        ss = size * 0.62
        w1 = stringWidth(sup, font, ss) if sup else 0
        tot = w0 + w1
        start = {'l': 0, 'c': -tot / 2, 'r': -tot}[anchor]
        if angle == 0:
            self.text(main, x + start, y, size, font, col, 'l')
            if sup:
                self.text(sup, x + start + w0, y - size * 0.42, ss, font, col, 'l')
        else:  # 90° : la ligne de base monte, l'exposant se décale vers la gauche
            self.text(main, x, y - start, size, font, col, 'l', 90)
            if sup:
                self.text(sup, x - size * 0.42, y - start - w0, ss, font, col, 'l', 90)

    # Découpe, hachures, pointillé
    @contextmanager
    def clip(self, polys, eo=True):
        c = self.c
        c.saveState()
        p = c.beginPath()
        for pts in polys:
            p.moveTo(*pts[0])
            for q in pts[1:]:
                p.lineTo(*q)
            p.close()
        c.clipPath(p, stroke=0, fill=0, fillMode=FILL_EVEN_ODD if eo else FILL_NON_ZERO)
        self.counts['clip_paths'] += 1
        try:
            yield
        finally:
            c.restoreState()

    def hatch_lines(self, bbox, angle, spacing):
        """Traits parallèles couvrant bbox, de phase globale (les hachures de rectangles voisins se raccordent)."""
        x0, y0, x1, y1 = bbox
        a = math.radians(angle)
        d = (math.cos(a), -math.sin(a))  # direction (angle visuel, y vers le bas)
        n = (-d[1], d[0])
        corners = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
        proj = [n[0] * x + n[1] * y for x, y in corners]
        k0 = math.floor(min(proj) / spacing) + 1
        k1 = math.ceil(max(proj) / spacing) - 1
        segs = []
        for k in range(k0, k1 + 1):
            cval = k * spacing
            p0 = (n[0] * cval, n[1] * cval)
            t_lo, t_hi = -1e9, 1e9
            ok = True
            for (pi, di, lo, hi) in ((p0[0], d[0], x0, x1), (p0[1], d[1], y0, y1)):
                if abs(di) < 1e-12:
                    if pi < lo or pi > hi:
                        ok = False
                    continue
                ta, tb = (lo - pi) / di, (hi - pi) / di
                if ta > tb:
                    ta, tb = tb, ta
                t_lo, t_hi = max(t_lo, ta), min(t_hi, tb)
            if not ok or t_hi - t_lo < 1e-6:
                continue
            segs.append(((round(p0[0] + d[0] * t_lo, 2), round(p0[1] + d[1] * t_lo, 2)),
                         (round(p0[0] + d[0] * t_hi, 2), round(p0[1] + d[1] * t_hi, 2))))
        return segs

    def hatch(self, polys, angles, spacing, w=0.28, col=BLACK, counter='hatch_lines'):
        """Hachure de traits fins sous un chemin de découpe égal aux polygones."""
        xs = [p[0] for pts in polys for p in pts]
        ys = [p[1] for pts in polys for p in pts]
        bbox = (min(xs), min(ys), max(xs), max(ys))
        with self.clip(polys):
            for ang in angles:
                segs = self.hatch_lines(bbox, ang, spacing)
                self.lines(segs, w=w, col=col)
                self.counts[counter] += len(segs)

    def stipple(self, polys, bbox, pitch=0.8, seed=7, w=0.2, col=(0.35, 0.35, 0.35)):
        """Pointillé de terrain : des dizaines de milliers de micro-traits (≈ 0,15 pt) sous découpe pair-impair.
        Chaque rangée est le même tracé déplacé (cm), ce qui garde le fichier petit une fois compressé."""
        x0, y0, x1, y1 = bbox
        rng = random.Random(seed)
        row = []
        x = 0.0
        while x < (x1 - x0) + pitch:
            jx = rng.uniform(-0.3, 0.3) * pitch
            jy = rng.uniform(-0.35, 0.35) * pitch
            ang = rng.uniform(0, math.pi)
            dx, dy = 0.15 * math.cos(ang), 0.15 * math.sin(ang)
            row.append((round(x + jx, 2), round(jy, 2), round(x + jx + dx, 2), round(jy + dy, 2)))
            x += pitch
        c = self.c
        n = 0
        with self.clip(polys):
            c.setLineWidth(w)
            c.setStrokeColorRGB(*col)
            c.setDash([])
            j = 0
            y = y0 + pitch / 2
            while y < y1:
                c.saveState()
                c.translate(x0 + (pitch / 2 if j % 2 else 0), y)
                p = c.beginPath()
                for (a, b, cc, dd) in row:
                    p.moveTo(a, b)
                    p.lineTo(cc, dd)
                c.drawPath(p, stroke=1, fill=0)
                c.restoreState()
                n += len(row)
                y += pitch
                j += 1
        self.counts['stipple_traits'] += n
        return n


# ───────────────────────────── Bâtiment (mètres) → planche ─────────────────────────────

class View:
    """Correspondance mètres du bâtiment → points de la feuille (plan : x droite, y bas)."""

    def __init__(self, ox, oy, scale_den):
        self.ox, self.oy = ox, oy
        self.k = PT_PER_M / scale_den

    def p(self, x, y):
        return (round(self.ox + x * self.k, 3), round(self.oy + y * self.k, 3))

    def r(self, rect):
        a = self.p(rect[0], rect[1])
        b = self.p(rect[2], rect[3])
        return (a[0], a[1], b[0], b[1])

    def poly(self, pts):
        return [self.p(x, y) for x, y in pts]


class ElevView:
    """Coupe ou façade : u horizontal (m), z altitude relative (m, vers le haut)."""

    def __init__(self, ox, oy0, scale_den, u0=0.0):
        self.ox, self.oy0, self.u0 = ox, oy0, u0
        self.k = PT_PER_M / scale_den

    def p(self, u, z):
        return (round(self.ox + (u - self.u0) * self.k, 3), round(self.oy0 - z * self.k, 3))

    def r(self, u0, z0, u1, z1):
        a = self.p(u0, max(z0, z1))
        b = self.p(u1, min(z0, z1))
        return (a[0], a[1], b[0], b[1])


def draw_wall_set(sh, V, core, insul, style='archicad', outline_w=0.71):
    """Murs coupés : cœur porteur hachuré (ou plein), isolant (bande jaune + hachure croisée, ou hachure simple),
    contour épais de l'union. core / insul : rectangles en mètres (déjà percés des baies)."""
    core_pt = [V.r(r) for r in core]
    insul_pt = [V.r(r) for r in insul]
    if style == 'archicad':
        for r in core_pt:
            sh.rect(*r, fill=WHITE)
            sh.hatch([rect_poly(r)], [45], 1.7)
        for r in insul_pt:
            sh.rect(*r, fill=INSUL_FILL)
            sh.hatch([rect_poly(r)], [45, 135], 2.4, w=0.28, col=INSUL_HATCH)
    else:  # style « de » : cœur plein gris foncé, isolant en hachure simple sans fond
        for r in core_pt:
            sh.rect(*r, fill=DARK_WALL)
        for r in insul_pt:
            sh.hatch([rect_poly(r)], [135], 2.2, w=0.28)
    sh.lines(union_edges(insul_pt), w=0.25)
    sh.lines(union_edges(core_pt + insul_pt), w=outline_w)


def chain_h(sh, y, xs, labels, size=5.5, ext_to=None, col=BLACK):
    """Chaîne de cotes horizontale. labels[i] : (principal, exposant) ou ((l, ls), (h, hs)) pour une baie."""
    sh.line(xs[0] - 7, y, xs[-1] + 7, y, 0.25, col)
    for x in xs:
        sh.line(x - 2, y + 2, x + 2, y - 2, 0.5, col)
        sh.line(x, y - 3.5, x, (ext_to if ext_to is not None else y + 3.5), 0.15, col)
    out = []
    for i, lab in enumerate(labels):
        mid = (xs[i] + xs[i + 1]) / 2
        if isinstance(lab[0], tuple):
            (a, asup), (b, bsup) = lab
            sh.text_sup(a, asup, mid, y - 1.6, size, col=col)
            sh.text_sup(b, bsup, mid, y + 1.6 + size * 0.75, size, col=col)
            out.append({'width_text': a + asup, 'height_text': b + bsup})
        else:
            a, asup = lab
            sh.text_sup(a, asup, mid, y - 1.6, size, col=col)
            out.append({'text': a, 'sup': asup})
    return out


def chain_v(sh, x, ys, labels, size=5.5, ext_to=None, col=BLACK):
    """Chaîne de cotes verticale (textes lus de bas en haut, à gauche du trait)."""
    sh.line(x, ys[0] - 7, x, ys[-1] + 7, 0.25, col)
    for y in ys:
        sh.line(x - 2, y + 2, x + 2, y - 2, 0.5, col)
        sh.line(x - 3.5, y, (ext_to if ext_to is not None else x + 3.5), y, 0.15, col)
    out = []
    for i, lab in enumerate(labels):
        mid = (ys[i] + ys[i + 1]) / 2
        if isinstance(lab[0], tuple):
            (a, asup), (b, bsup) = lab
            sh.text_sup(a, asup, x - 1.6, mid, size, angle=90)
            sh.text_sup(b, bsup, x + 1.6 + size * 0.75, mid, size, angle=90)
            out.append({'width_text': a + asup, 'height_text': b + bsup})
        else:
            a, asup = lab
            sh.text_sup(a, asup, x - 1.6, mid, size, angle=90)
            out.append({'text': a, 'sup': asup})
    return out


def dims_of(values):
    return [dim_parts(v) for v in values]


def annotation_block(sh, title, lines, x, y, target, size=5.5, align='l', dot=True, col=BLACK):
    """Bloc « Composition … : » (titre gras + lignes) avec trait de rappel et point vers l'élément.
    (x, y) = coin haut-gauche (ou haut-droit si align='r'). Renvoie la boîte."""
    lh = size * 1.25
    w = max([stringWidth(title, BOLD, size)] + [stringWidth(s, FONT, size) for s in lines])
    bx0 = x if align == 'l' else x - w
    sh.text(title, bx0, y + size, size, BOLD, col)
    for i, s in enumerate(lines):
        sh.text(s, bx0, y + size + lh * (i + 1), size, FONT, col)
    bottom = y + size + lh * len(lines) + 1.5
    if target is not None:
        # trait de rappel : depuis le bord du bloc le plus proche jusqu'au point
        ax = bx0 + w + 2 if target[0] > bx0 + w else (bx0 - 2 if target[0] < bx0 else target[0])
        ay = y + size * 0.6
        sh.line(ax, ay, target[0], ay, 0.25, col)
        sh.line(target[0], ay, target[0], target[1], 0.25, col)
        if dot:
            sh.circle(target[0], target[1], 1.3, fill=col, stroke=None)
    return (bx0, y, bx0 + w, bottom)


def level_mark_plan(sh, x, y, label, size=5.5):
    """Cote de niveau en plan : croix cerclée + texte."""
    sh.circle(x, y, 2.2, stroke=BLACK, w=0.25)
    sh.line(x - 3.5, y, x + 3.5, y, 0.25)
    sh.line(x, y - 3.5, x, y + 3.5, 0.25)
    sh.text(label, x + 4.5, y + size * 0.35, size)


def level_mark_elev(sh, x, y, label, size=5.5, nf=True, side='r', col=BLACK):
    """Cote de niveau en coupe / façade : trait, triangle, « NF » au-dessus, valeur dessous ou à côté."""
    L = 46
    if side == 'r':
        x0, x1 = x, x + L
    else:
        x0, x1 = x - L, x
    sh.line(x0, y, x1, y, 0.25, col)
    tx = x0 + 6 if side == 'r' else x0
    sh.poly([(tx, y), (tx + 4, y - 4), (tx + 8, y)], fill=col)
    if nf:
        sh.text('NF', tx + 10, y - 1.5, size, col=col)
    sh.text(label, tx + 10 if nf else tx + 10, y + size + 1.2, size, col=col)


def north_arrow(sh, cx, cy, r, cw_from_up, label='NORD', size=7):
    """Flèche du nord : texte au-dessus, cercle, trait traversant, flèche tournée de cw_from_up degrés."""
    a = math.radians(cw_from_up)
    d = (math.sin(a), -math.cos(a))
    n = (-d[1], d[0])
    sh.text(label, cx, cy - r - 6, size, BOLD, anchor='c')
    sh.circle(cx, cy, r, stroke=BLACK, w=0.5)
    tip = (cx + d[0] * r * 1.15, cy + d[1] * r * 1.15)
    tail = (cx - d[0] * r * 1.15, cy - d[1] * r * 1.15)
    sh.line(tail[0], tail[1], tip[0], tip[1], 0.6)
    base = (cx + d[0] * r * 0.45, cy + d[1] * r * 0.45)
    sh.poly([tip, (base[0] + n[0] * r * 0.28, base[1] + n[1] * r * 0.28), (base[0] - n[0] * r * 0.28, base[1] - n[1] * r * 0.28)], fill=BLACK)
    return (cx - r * 1.2, cy - r - 6 - size, cx + r * 1.2, cy + r * 1.2)


def title_under(sh, text_parts, x, y, size=17, anchor='l'):
    """Titre de vue. text_parts : liste de (texte, 'n'|'sup'). Renvoie la boîte."""
    total = 0
    for s, kind in text_parts:
        total += stringWidth(s, FONT, size if kind == 'n' else size * 0.6)
    x0 = x if anchor == 'l' else x - total / 2
    cx = x0
    for s, kind in text_parts:
        if kind == 'n':
            sh.text(s, cx, y, size)
            cx += stringWidth(s, FONT, size)
        else:
            ss = size * 0.6
            sh.text(s, cx, y - size * 0.4, ss)
            cx += stringWidth(s, FONT, ss)
    return [round(x0, 2), round(y - size, 2), round(x0 + total, 2), round(y + size * 0.22, 2)]


def gray_photo(seed, w=96, h=72):
    """Petite image matricielle grise déterministe (fausse photo aérienne)."""
    from PIL import Image
    rng = random.Random(seed)
    img = Image.new('L', (w, h))
    px = img.load()
    for j in range(h):
        for i in range(w):
            v = 120 + 60 * math.sin(i / 9.0) * math.cos(j / 7.0) + rng.randint(-25, 25)
            if abs(j - h * 0.55 - (i - w / 2) * 0.3) < 3:
                v = 215
            px[i, j] = max(0, min(255, int(v)))
    return img


# ───────────────────────────── Modèle d'un niveau ─────────────────────────────

class Level:
    """Un niveau en plan, en mètres (x droite, y bas, origine = coin haut-gauche du bâtiment)."""

    def __init__(self, name, rank):
        self.name = name
        self.rank = rank
        self.core = []        # porteur / cloisons (hachure)
        self.insul = []       # isolant
        self.openings = []
        self.rooms = []
        self.outline = None
        self.heated_outline = None
        self.party_edges = []
        self.unheated_edges = []

    def opening(self, kind, rect, side, width, height, sill=0.0, exterior=True, to_unheated=False,
                hinge=None, swing=None, all_label=False, name=None, in_envelope=True, symbol=None):
        o = dict(kind=kind, rect=rect, side=side, width=width, height=height, sill=sill, exterior=exterior,
                 to_unheated=to_unheated, hinge=hinge, swing=swing, all_label=all_label, name=name,
                 in_envelope=in_envelope, symbol=symbol or kind)
        self.openings.append(o)
        return o

    def room(self, name, poly, label, heated=True, show=True, kind='room'):
        r = dict(name=name, poly=poly, label=label, heated=heated, show=show, kind=kind,
                 area=round(poly_area(poly), 4))
        self.rooms.append(r)
        return r


def opening_axis(o):
    """Axe de la baie : 'x' si le mur est horizontal (baie le long de x)."""
    x0, y0, x1, y1 = o['rect']
    return 'x' if (x1 - x0) >= (y1 - y0) else 'y'


def draw_opening_symbols(sh, V, o):
    x0, y0, x1, y1 = o['rect']
    ax = opening_axis(o)
    if o['symbol'] == 'window':
        if ax == 'x':
            ym = (y0 + y1) / 2
            for off in (-0.03, 0.03):
                a, b = V.p(x0, ym + off), V.p(x1, ym + off)
                sh.line(a[0], a[1], b[0], b[1], 0.2)
            sh.rect(*V.r((x0, ym - 0.07, x1, ym + 0.07)), stroke=BLACK, w=0.2)
            sh.rect(*V.r((x0, y0, x1, y1)), stroke=BLACK, w=0.15)
        else:
            xm = (x0 + x1) / 2
            for off in (-0.03, 0.03):
                a, b = V.p(xm + off, y0), V.p(xm + off, y1)
                sh.line(a[0], a[1], b[0], b[1], 0.2)
            sh.rect(*V.r((xm - 0.07, y0, xm + 0.07, y1)), stroke=BLACK, w=0.2)
            sh.rect(*V.r((x0, y0, x1, y1)), stroke=BLACK, w=0.15)
    elif o['symbol'] == 'door':
        w = o['width']
        hinge, swing = o['hinge'], o['swing']
        if ax == 'x':
            yface = y1 if swing > 0 else y0
            hx = x0 if hinge == 'a' else x1
            ox_ = x1 if hinge == 'a' else x0
            leaf = V.p(hx, yface + swing * w)
            h = V.p(hx, yface)
            sh.line(h[0], h[1], leaf[0], leaf[1], 0.35)
            a_leaf = 90 if swing > 0 else -90
            a_other = 0 if ox_ > hx else 180
            k = V.k
            a0, a1 = a_leaf, a_other
            if a1 - a0 > 180:
                a1 -= 360
            if a0 - a1 > 180:
                a1 += 360
            sh.arc(h[0], h[1], w * k, a0, a1, 0.2)
            sh.rect(*V.r((x0, y0, x1, y1)), stroke=BLACK, w=0.15)
        else:
            xface = x1 if swing > 0 else x0
            hy = y0 if hinge == 'a' else y1
            oy_ = y1 if hinge == 'a' else y0
            leaf = V.p(xface + swing * w, hy)
            h = V.p(xface, hy)
            sh.line(h[0], h[1], leaf[0], leaf[1], 0.35)
            a_leaf = 0 if swing > 0 else 180
            a_other = 90 if oy_ > hy else -90
            a0, a1 = a_leaf, a_other
            if a1 - a0 > 180:
                a1 -= 360
            if a0 - a1 > 180:
                a1 += 360
            sh.arc(h[0], h[1], w * V.k, a0, a1, 0.2)
            sh.rect(*V.r((x0, y0, x1, y1)), stroke=BLACK, w=0.15)
    elif o['symbol'] == 'garage':
        # porte sectionnelle : deux traits fins + rail en tireté dans le garage
        ym = (y0 + y1) / 2
        for off in (-0.04, 0.04):
            a, b = V.p(x0, ym + off), V.p(x1, ym + off)
            sh.line(a[0], a[1], b[0], b[1], 0.2)
        for xx in (x0 + 0.06, x1 - 0.06):
            a, b = V.p(xx, y0), V.p(xx, y0 - 2.6)
            sh.line(a[0], a[1], b[0], b[1], 0.2, dash=[3, 2])
    elif o['symbol'] == 'passage':
        pass


def opening_truth(V, o, facade_az=None):
    x0, y0, x1, y1 = o['rect']
    side = o['side']
    if side == 'rear':
        a, b = V.p(x0, y0), V.p(x1, y0)
    elif side == 'front':
        a, b = V.p(x0, y1), V.p(x1, y1)
    elif side == 'left':
        a, b = V.p(x0, y0), V.p(x0, y1)
    elif side == 'right':
        a, b = V.p(x1, y0), V.p(x1, y1)
    else:
        if opening_axis(o) == 'x':
            ym = (y0 + y1) / 2
            a, b = V.p(x0, ym), V.p(x1, ym)
        else:
            xm = (x0 + x1) / 2
            a, b = V.p(xm, y0), V.p(xm, y1)
    t = {'kind': o['kind'], 'side': side, 'a_pt': list(a), 'b_pt': list(b), 'width_m': o['width'],
         'height_m': o['height'], 'sill_m': o['sill'], 'exterior': o['exterior'], 'to_unheated': o['to_unheated'],
         'in_envelope': o['in_envelope']}
    if o['name']:
        t['name'] = o['name']
    if facade_az is not None and side in facade_az:
        t['azimuth_deg'] = facade_az[side]
    return t


def room_label(sh, V, r, size=6.2, area_size=5.4, area_prefix='S: ', area_fmt=None, bold=True):
    """Nom en gras + ligne grise de surface. Renvoie (label_pt, area_label)."""
    x, y = V.p(*r['label'])
    font = BOLD if bold else FONT
    box = sh.text(r['name'], x, y, size, font, anchor='c')
    area_txt = area_fmt(r) if area_fmt else f"{area_prefix}{fr(r['area'])} m²"
    sh.text(area_txt, x, y + area_size * 1.45, area_size, FONT, GREY_TXT, anchor='c')
    label_pt = [round((box[0] + box[2]) / 2, 2), round(y - size / 2, 2)]
    return label_pt, area_txt


def material_key(text):
    t = text.lower()
    table = [
        ('enduit de façade', 'render_exterior'), ('enduit plâtre', 'plaster'), ('plâtre', 'plaster'),
        ('revêtement', 'floor_finish'), ('chape', 'screed'), ('acoustique', 'impact_sound_insulation'),
        ('mousse pur', 'pur'), ('pir', 'pir'), ('xps', 'xps'), ('eps', 'eps'), ('radier', 'concrete'),
        ('dalle béton', 'concrete'), ('béton de propreté', 'lean_concrete'), ('béton', 'concrete'),
        ('empierrement', 'gravel'), ('film pe', 'pe_film'), ('étanchéité', 'waterproofing'),
        ('kalksandstein', 'sand_lime_brick'), ('wdvs', 'eps'), ('mineralwolle', 'mineral_wool'),
        ('außenputz', 'render_exterior'), ('innenputz', 'plaster'), ('estrich', 'screed'),
        ('trittschall', 'impact_sound_insulation'), ('stahlbeton', 'concrete'), ('dachziegel', 'roof_tiles'),
        ('lattung', 'battens'), ('sparren', 'rafters'), ('gipskarton', 'plasterboard'), ('bodenbelag', 'floor_finish'),
        ('dampfbremse', 'vapour_barrier'), ('holzfaser', 'wood_fibre'),
    ]
    for k, v in table:
        if k in t:
            return v
    return 'other'


def layers_of(lines):
    out = []
    for s in lines:
        th = None
        rest = s
        import re
        m = re.match(r'^\s*(\d+(?:[.,]\d+)?)\s*cm\s+(.*)$', s)
        if m:
            th = float(m.group(1).replace(',', '.'))
            rest = m.group(2)
        out.append({'thickness_cm': th, 'text': rest.strip(), 'material_key': material_key(rest)})
    return out


def write_truth(path, truth):
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(truth, f, ensure_ascii=False, indent=1, sort_keys=False)
        f.write('\n')


def az_name(az):
    names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
    return names[int(((az % 360) + 22.5) // 45) % 8]


def facade_azimuths(up_az):
    """Azimut de la normale extérieure de chaque côté du plan (rear = haut de la feuille)."""
    return {'rear': round(up_az % 360, 1), 'right': round((up_az + 90) % 360, 1),
            'front': round((up_az + 180) % 360, 1), 'left': round((up_az + 270) % 360, 1)}


# ═════════════════════════════ Planche principale : A1, 1/100, « Maison Exemple » ═════════════════════════════

Z0_A1 = 312.25          # altitude du ±0,00 (axe de la rue)
NORTH_CW_A1 = 110.0     # le nord est à 110° (sens horaire) du haut de la feuille : vers la droite et un peu vers le bas
UP_AZ_A1 = (360 - NORTH_CW_A1) % 360   # azimut du haut de la feuille = 250° (ouest-sud-ouest)

COMPO_A1 = {
    'mur': ('Composition mur :', 'wall', ['24cm Béton', '18cm Isolation type EPS', '2cm Enduit de façade']),
    'mur_garage': ('Composition mur garage :', 'wall', ['24cm Béton', '12cm Isolation type EPS']),
    'dalle_sol': ('Composition dalle :', 'ground-floor', [
        '2cm Revêtement de sol', '7cm Chape', '10cm Isolation mousse PUR', '25cm Radier béton',
        '8cm Isolation type XPS sous radier', 'Film PE', '5cm Béton de propreté', '25cm Empierrement']),
    'dalle_etage': ('Composition dalle :', 'intermediate-floor', [
        '2cm Revêtement de sol', '6cm Chape', '3cm Isolation acoustique', '20cm Dalle béton', '1cm Enduit plâtre']),
    'dalle_garage': ('Composition dalle :', 'floor-over-unheated', [
        '2cm Revêtement de sol', '6cm Chape', '3cm Isolation acoustique', '20cm Dalle béton',
        '10cm Isolation type EPS en sous-face']),
    'toiture': ('Composition toiture :', 'roof', [
        '2cm Étanchéité bitumineuse', '20cm Isolation type PIR', '22cm Dalle béton', '1cm Enduit plâtre']),
}


def maison_exemple():
    """Maison jumelée (mitoyen à droite), 9,20 × 12,40 m, garage non chauffé à l'avant droit du rez-de-chaussée."""
    W, D = 9.20, 12.40
    outline = rect_poly((0, 0, W, D))

    rdc = Level('Rez-de-chaussée', 0)
    rdc.core = [
        (0.20, 0.20, 0.44, 12.20), (0.44, 0.20, 8.90, 0.44), (8.90, 0.00, 9.20, 12.40),
        (0.44, 11.96, 5.60, 12.20), (5.60, 6.20, 5.84, 12.20), (5.84, 6.20, 8.90, 6.44), (5.96, 11.96, 8.90, 12.40),
        (0.44, 6.20, 5.60, 6.40), (2.40, 6.40, 2.52, 11.96), (0.44, 9.00, 2.40, 9.12), (0.44, 10.40, 2.40, 10.52),
        (4.00, 10.40, 5.60, 10.52), (4.00, 10.52, 4.12, 11.96)]
    rdc.insul = [(0.00, 0.00, 0.20, 12.40), (0.20, 0.00, 8.90, 0.20), (0.20, 12.20, 5.96, 12.40),
                 (5.84, 6.44, 8.90, 6.56), (5.84, 6.56, 5.96, 12.20)]
    o = rdc.opening
    o('window', (1.00, 0.00, 5.00, 0.44), 'rear', 4.00, 2.15, 0.00, all_label=True, name='F1')
    o('window', (5.785, 0.00, 6.985, 0.44), 'rear', 1.20, 2.15, 0.00, all_label=True, name='F2')
    o('window', (0.00, 1.80, 0.44, 3.00), 'left', 1.20, 1.25, 0.90, all_label=True, name='F3')
    o('window', (0.00, 9.465, 0.44, 10.065), 'left', 0.60, 0.60, 1.60, name='F4')
    o('window', (0.00, 10.90, 0.44, 11.50), 'left', 0.60, 0.80, 1.40, name='F5')
    o('door', (2.885, 11.96, 3.885, 12.40), 'front', 1.00, 2.20, 0.00, hinge='a', swing=-1, name="Porte d'entrée")
    o('door', (6.24, 11.96, 8.64, 12.40), 'front', 2.40, 2.10, 0.00, in_envelope=False, symbol='garage',
      name='Porte de garage')
    o('door', (5.60, 7.00, 5.96, 7.93), 'interior', 0.93, 2.10, 0.00, exterior=False, to_unheated=True,
      hinge='a', swing=-1, name='Porte garage / logement')
    o('door', (3.40, 6.20, 4.40, 6.40), 'interior', 1.00, 2.10, exterior=False, in_envelope=False, symbol='passage')
    o('door', (2.40, 7.00, 2.52, 8.40), 'interior', 1.40, 2.10, exterior=False, in_envelope=False, symbol='passage')
    o('door', (2.40, 9.40, 2.52, 10.20), 'interior', 0.80, 2.10, exterior=False, in_envelope=False, hinge='a', swing=1)
    o('door', (2.40, 10.85, 2.52, 11.55), 'interior', 0.70, 2.10, exterior=False, in_envelope=False, hinge='a', swing=-1)
    o('door', (4.40, 10.40, 5.20, 10.52), 'interior', 0.80, 2.10, exterior=False, in_envelope=False, hinge='b', swing=-1)
    r = rdc.room
    r('Séjour / Cuisine', rect_poly((0.44, 0.44, 8.90, 6.20)), (3.20, 4.90))
    r('Escalier', rect_poly((0.44, 6.40, 2.40, 9.00)), (1.42, 7.70), show=False, kind='stair')
    r('Buanderie', rect_poly((0.44, 9.12, 2.40, 10.40)), (1.50, 9.78))
    r('WC', rect_poly((0.44, 10.52, 2.40, 11.96)), (1.15, 11.40))
    r('Hall', [(2.52, 6.40), (5.60, 6.40), (5.60, 10.40), (4.00, 10.40), (4.00, 11.96), (2.52, 11.96)], (4.25, 8.55))
    r('Vestiaire', rect_poly((4.12, 10.52, 5.60, 11.96)), (4.86, 11.25))
    r('Garage', rect_poly((5.96, 6.56, 8.90, 11.96)), (7.43, 9.30), heated=False, kind='garage')
    r('Terrasse', rect_poly((0.44, -3.20, 6.44, 0.00)), (3.60, -1.75), heated=False, kind='exterior')
    rdc.outline = outline
    rdc.heated_outline = [(0, 0), (W, 0), (W, 6.56), (5.96, 6.56), (5.96, D), (0, D)]
    rdc.party_edges = [((W, 0), (W, D))]
    rdc.unheated_edges = [((W, 6.56), (5.96, 6.56)), ((5.96, 6.56), (5.96, D))]

    et = Level('1er étage', 1)
    et.core = [
        (0.20, 0.20, 0.44, 12.20), (0.44, 0.20, 8.90, 0.44), (8.90, 0.00, 9.20, 12.40), (0.44, 11.96, 8.90, 12.20),
        (0.44, 4.20, 8.90, 4.32), (4.40, 0.44, 4.52, 4.20), (2.40, 4.32, 2.52, 9.00), (0.44, 6.28, 2.40, 6.40),
        (5.40, 4.32, 5.52, 11.96), (5.52, 6.88, 8.90, 7.00), (0.44, 9.00, 5.40, 9.12), (3.20, 9.12, 3.32, 11.96)]
    et.insul = [(0.00, 0.00, 0.20, 12.40), (0.20, 0.00, 8.90, 0.20), (0.20, 12.20, 8.90, 12.40)]
    o = et.opening
    o('window', (1.40, 0.00, 3.40, 0.44), 'rear', 2.00, 1.25, 0.90, all_label=True, name='F6')
    o('window', (5.595, 0.00, 7.795, 0.44), 'rear', 2.20, 1.25, 0.90, all_label=True, name='F7')
    o('window', (0.00, 1.60, 0.44, 2.60), 'left', 1.00, 1.25, 0.90, all_label=True, name='F8')
    o('window', (0.00, 4.90, 0.44, 5.70), 'left', 0.80, 1.00, 1.20, name='F9')
    o('window', (0.00, 10.00, 0.44, 11.00), 'left', 1.00, 1.00, 1.20, name='F10')
    o('window', (3.90, 11.96, 4.50, 12.40), 'front', 0.60, 0.60, 1.60, name='F11')
    o('window', (6.20, 11.96, 8.20, 12.40), 'front', 2.00, 1.25, 0.90, all_label=True, name='F12')
    o('door', (2.62, 4.20, 3.42, 4.32), 'interior', 0.80, 2.10, exterior=False, in_envelope=False, hinge='a', swing=-1)
    o('door', (4.55, 4.20, 5.35, 4.32), 'interior', 0.80, 2.10, exterior=False, in_envelope=False, hinge='b', swing=-1)
    o('door', (2.40, 4.60, 2.52, 5.40), 'interior', 0.80, 2.10, exterior=False, in_envelope=False, hinge='a', swing=1)
    o('door', (2.40, 6.90, 2.52, 8.60), 'interior', 1.70, 2.10, exterior=False, in_envelope=False, symbol='passage')
    o('door', (5.40, 5.00, 5.52, 5.80), 'interior', 0.80, 2.10, exterior=False, in_envelope=False, hinge='a', swing=1)
    o('door', (5.40, 7.60, 5.52, 8.40), 'interior', 0.80, 2.10, exterior=False, in_envelope=False, hinge='b', swing=1)
    o('door', (2.56, 9.00, 3.16, 9.12), 'interior', 0.60, 2.10, exterior=False, in_envelope=False, hinge='a', swing=1)
    o('door', (3.80, 9.00, 4.60, 9.12), 'interior', 0.80, 2.10, exterior=False, in_envelope=False, hinge='b', swing=1)
    r = et.room
    r('Chambre 1', rect_poly((0.44, 0.44, 4.40, 4.20)), (1.45, 3.35))
    r('Chambre 2', rect_poly((4.52, 0.44, 8.90, 4.20)), (6.71, 3.00))
    r('Salle de bains', rect_poly((0.44, 4.32, 2.40, 6.28)), (1.42, 5.20))
    r('Escalier', rect_poly((0.44, 6.40, 2.40, 9.00)), (1.42, 7.70), show=False, kind='stair')
    r('Hall', rect_poly((2.52, 4.32, 5.40, 9.00)), (3.96, 7.90))
    r('Dressing', rect_poly((5.52, 4.32, 8.90, 6.88)), (7.21, 5.70))
    r('Chambre 3', rect_poly((5.52, 7.00, 8.90, 11.96)), (7.21, 9.60))
    r("Salle d'eau", rect_poly((0.44, 9.12, 3.20, 11.96)), (1.82, 10.75))
    r('Local technique', rect_poly((3.32, 9.12, 5.40, 11.96)), (4.36, 10.25))
    et.outline = outline
    et.heated_outline = outline
    et.party_edges = [((W, 0), (W, D))]
    et.unheated_edges = []
    return rdc, et


def cut_walls(level):
    cuts = [o['rect'] for o in level.openings]
    return rects_minus(level.core, cuts), rects_minus(level.insul, cuts)


def situation_a1(sh, V):
    """Cadre de situation (le même sous les trois plans) : terrains, parcelle, rue, trottoir, voisin."""
    sh.rect(*V.r((-12, -14, 24, 15.90)), fill=LAWN)
    sh.rect(*V.r((-12, 15.90, 24, 17.40)), fill=PAVING)
    sh.rect(*V.r((-12, 17.40, 24, 26.0)), fill=STREET)
    sh.line(*V.p(-12, 15.90), *V.p(24, 15.90), 0.35)
    sh.line(*V.p(-12, 17.40), *V.p(24, 17.40), 0.5)
    sh.text('Trottoir', *V.p(-1.2, 16.95), 6, col=(0.3, 0.3, 0.3))
    sh.text('Rue des Essais', *V.p(2.2, 19.4), 9, col=(0.3, 0.3, 0.3))
    # voisin jumelé à droite
    sh.rect(*V.r((9.20, 0.0, 18.4, 12.40)), fill=(0.93, 0.93, 0.93), stroke=(0.4, 0.4, 0.4), w=0.35)
    sh.text('Maison voisine', *V.p(9.5, 6.4), 5.5, col=(0.4, 0.4, 0.4))
    # aménagements de la parcelle
    sh.rect(*V.r((0.44, -3.20, 6.44, 0.0)), fill=PAVING, stroke=BLACK, w=0.25)
    sh.rect(*V.r((5.60, 12.40, 9.20, 15.90)), fill=PAVING, stroke=BLACK, w=0.25)
    sh.rect(*V.r((2.70, 12.40, 4.10, 15.90)), fill=PAVING, stroke=BLACK, w=0.25)
    # limites de parcelle (tireté rouge)
    dash = [6, 2, 1.5, 2]
    for a, b in (((-3.5, -9.0), (9.2, -9.0)), ((-3.5, -9.0), (-3.5, 15.9)), ((-3.5, 15.9), (9.2, 15.9)),
                 ((9.2, -9.0), (9.2, 15.9))):
        sh.line(*V.p(*a), *V.p(*b), 0.6, RED, dash=dash)
    sh.text('LOT 7', *V.p(-3.0, -7.9), 6.5, BOLD)
    sh.text('Contenance : 3a16ca', *V.p(-3.0, -7.4), 5.5)
    sh.text('Limite de parcelle', *V.p(-3.35, -2.0), 4.8, col=RED, angle=90)


def draw_stair(sh, V, x0, y0, x1, y1, dashed=False):
    n = int(round((y1 - y0) / 0.26))
    segs = []
    for i in range(1, n):
        y = y0 + i * (y1 - y0) / n
        segs.append((V.p(x0, y), V.p(x1, y)))
    sh.lines(segs, 0.2, dash=[2, 1.5] if dashed else None)
    xm = (x0 + x1) / 2
    sh.line(*V.p(xm, y1 - 0.2), *V.p(xm, y0 + 0.35), 0.25)
    tip = V.p(xm, y0 + 0.2)
    sh.poly([tip, V.p(xm - 0.10, y0 + 0.42), V.p(xm + 0.10, y0 + 0.42)], fill=BLACK)
    if dashed:
        sh.line(*V.p(x0, y1), *V.p(x1, y0), 0.2)


def furniture_a1(sh, V, level):
    """Mobilier schématique en traits fins (bruit pour le lecteur) : séjour au rez, chambre 1 à l'étage."""
    grey = (0.35, 0.35, 0.35)

    def box(x0, y0, x1, y1):
        sh.rect(*V.r((x0, y0, x1, y1)), stroke=grey, w=0.18)

    if level.rank == 0:
        box(1.40, 2.55, 2.90, 3.45)                       # table
        for cx in (1.70, 2.15, 2.60):
            box(cx - 0.18, 2.12, cx + 0.18, 2.48)
            box(cx - 0.18, 3.52, cx + 0.18, 3.88)
        box(4.80, 2.80, 7.40, 3.50)                       # canapé
        box(4.80, 2.80, 7.40, 2.98)
        box(8.30, 2.40, 8.90, 5.60)                       # plan de travail
        box(5.60, 4.70, 7.60, 5.40)                       # îlot
        sh.circle(*V.p(8.60, 3.10), 0.18 * V.k, stroke=grey, w=0.18)
        sh.circle(*V.p(8.60, 3.55), 0.18 * V.k, stroke=grey, w=0.18)
        box(8.40, 4.40, 8.85, 4.90)                       # évier
        box(0.52, 10.56, 1.02, 10.92)                     # cuvette WC
    else:
        box(2.50, 1.98, 4.40, 3.35)                       # lit
        box(4.02, 2.06, 4.35, 2.62)                       # oreillers
        box(4.02, 2.71, 4.35, 3.27)
        box(2.50, 1.98, 3.30, 3.35)                       # couette repliée


def tiles(sh, V, poly, step=0.30):
    """Carrelage : trame de traits fins sous découpe égale à la pièce."""
    pts = V.poly(poly)
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    bbox = (min(xs), min(ys), max(xs), max(ys))
    s = step * V.k
    with sh.clip([pts]):
        for ang in (0, 90):
            segs = sh.hatch_lines(bbox, ang, s)
            sh.lines(segs, 0.15, (0.45, 0.45, 0.45))
            sh.counts['tile_lines'] += len(segs)


def daylight_box(sh, V, x0, y0, x1, label, area, glazed, size=5.2):
    """Encadré violet d'éclairement naturel (surface vitrée, surface de la pièce, 1/8 de la surface)."""
    lines = [('Surface vitrée : ', f'{fr(glazed)}m²'), (f'{label} : ', f'{fr(area)}m²'),
             ('Coefficient selon règlement', ''), ('1/8 surface du plancher : ', f'{fr(area / 8)}m²')]
    a = V.p(x0, y0)
    b = V.p(x1, y0)
    lh = size * 1.3
    h = lh * len(lines) + 3
    sh.rect(a[0], a[1], b[0], a[1] + h, stroke=VIOLET, w=0.35)
    texts = []
    for i, (t, v) in enumerate(lines):
        y = a[1] + 1.5 + size + lh * i
        sh.text(t, a[0] + 2, y, size, FONT, VIOLET)
        if v:
            sh.text(v, a[0] + 2 + stringWidth(t, FONT, size), y, size, BOLD, VIOLET)
        texts.append(t + v)
    return {'texts': texts, 'bbox_pt': [round(a[0], 2), round(a[1], 2), round(b[0], 2), round(a[1] + h, 2)],
            'glazed_m2': round(glazed, 2), 'floor_m2': round(area, 2), 'required_m2': round(area / 8, 2)}


def section_marker(sh, x, y, letter, direction):
    """Repère de coupe : cercle, lettre, triangle tourné vers le regard."""
    r = 4.2
    sh.circle(x, y, r, fill=WHITE, stroke=BLACK, w=0.4)
    sh.text(letter, x, y + 2.3, 6.5, BOLD, anchor='c')
    dx, dy = direction
    tip = (x + dx * (r + 4), y + dy * (r + 4))
    nx, ny = -dy, dx
    sh.poly([tip, (x + dx * r + nx * 3, y + dy * r + ny * 3), (x + dx * r - nx * 3, y + dy * r - ny * 3)], fill=BLACK)


def plan_view_a1(sh, level, cx0, title_parts, title_text, kind='plan'):
    """Une vue en plan A1 : cadre de situation découpé + bâtiment + cotes + annotations. Renvoie la vérité de la vue."""
    clip = (cx0, 40, cx0 + 440, 880)
    V = View(cx0 + 140, 300, 100)
    fac_az = facade_azimuths(UP_AZ_A1)
    truth = {'kind': kind, 'title': title_text, 'level': level.rank if level else 2}
    with sh.clip([rect_poly(clip)]):
        situation_a1(sh, V)
        if kind == 'roof-plan':
            out_pt = V.poly(rect_poly((0, 0, 9.20, 12.40)))
            sh.poly(out_pt, fill=ROOF, stroke=BLACK, w=0.7)
            sh.poly(V.poly(rect_poly((0.30, 0.30, 8.90, 12.10))), fill=ROOF_IN, stroke=BLACK, w=0.35)
            sh.text('Toiture plate', *V.p(4.60, 5.4), 7, BOLD, anchor='c')
            sh.text('végétalisée extensive, pente 2 %', *V.p(4.60, 5.85), 5.5, anchor='c')
            for (x, y) in ((0.75, 0.75), (8.45, 0.75)):
                sh.circle(*V.p(x, y), 0.12 * V.k, stroke=BLACK, w=0.3)
                sh.text('E.P.', *V.p(x + 0.25, y + 0.1), 5)
            for (x0, y0, x1, y1) in ((4.6, 3.2, 4.6, 1.0), (4.6, 8.0, 4.6, 10.6)):
                sh.line(*V.p(x0, y0), *V.p(x1, y1), 0.3)
                tip = V.p(x1, y1)
                d = 1 if y1 > y0 else -1
                sh.poly([tip, V.p(x1 - 0.12, y1 - d * 0.3), V.p(x1 + 0.12, y1 - d * 0.3)], fill=BLACK)
            level_mark_plan(sh, *V.p(1.2, 2.2), level_text(6.40, Z0_A1) + ' (acrotère)')
            sh.text('Acrotère', *V.p(0.45, 11.85), 5)
            chain_h(sh, V.p(0, -5.0)[1], [V.p(0, 0)[0], V.p(9.20, 0)[0]], dims_of([9.20]))
            chain_v(sh, V.p(-2.6, 0)[0], [V.p(0, 0)[1], V.p(0, 12.40)[1]], dims_of([12.40]))
            truth['outline_pt'] = [list(p) for p in out_pt]
            truth['outline_area_m2'] = round(poly_area(rect_poly((0, 0, 9.20, 12.40))), 4)
            truth['roof_fill_bbox_pt'] = list(V.r((0, 0, 9.20, 12.40)))
            truth['roof'] = 'flat'
            truth['parapet_thickness_m'] = 0.30
        else:
            core, insul = cut_walls(level)
            for rm in level.rooms:
                if rm['kind'] in ('room', 'stair', 'garage'):
                    sh.poly(V.poly(rm['poly']), fill=ROOM_FILL)
            if level.rank == 1:
                tiles(sh, V, rect_poly((0.44, 9.12, 3.20, 11.96)))
            furniture_a1(sh, V, level)
            draw_wall_set(sh, V, core, insul)
            for op in level.openings:
                draw_opening_symbols(sh, V, op)
            draw_stair(sh, V, 0.44, 6.40, 2.40, 9.00, dashed=(level.rank == 1))
            rooms_truth = []
            for rm in level.rooms:
                t = {'name': rm['name'], 'area_true_m2': rm['area'], 'heated_true': rm['heated'], 'kind': rm['kind'],
                     'poly_pt': [list(p) for p in V.poly(rm['poly'])]}
                if rm['show']:
                    lp, at = room_label(sh, V, rm)
                    t['area_label'] = at
                    t['label_pt'] = lp
                else:
                    t['area_label'] = None
                    t['label_pt'] = None
                rooms_truth.append(t)
            # allèges
            for op in level.openings:
                if op['all_label']:
                    txt = f"ALL. {fr(op['sill'])}"
                    x0, y0, x1, y1 = op['rect']
                    if op['side'] == 'rear':
                        sh.text(txt, *V.p((x0 + x1) / 2, 0.72), 5, anchor='c')
                    elif op['side'] == 'front':
                        sh.text(txt, *V.p((x0 + x1) / 2, 11.82), 5, anchor='c')
                    elif op['side'] == 'left':
                        sh.text(txt, *V.p(0.66, (y0 + y1) / 2), 5, anchor='c', angle=90)
            daylight = []
            if level.rank == 0:
                daylight.append(daylight_box(sh, V, 4.70, 1.05, 8.20, 'Surface séjour', 48.7296,
                                             4.00 * 2.15 + 1.20 * 2.15 + 1.20 * 1.25))
                level_mark_plan(sh, *V.p(2.80, 6.75), level_text(0.20, Z0_A1))
                level_mark_plan(sh, *V.p(6.30, 10.90), level_text(0.05, Z0_A1))
                level_mark_plan(sh, *V.p(0.90, -0.65), level_text(-0.05, Z0_A1))
                sh.text('NF', *V.p(2.62, 6.58), 5)
                # unité extérieure de la pompe à chaleur
                sh.rect(*V.r((-1.05, 4.00, -0.55, 4.90)), fill=WHITE, stroke=BLACK, w=0.35)
                sh.text('PAC', *V.p(-0.74, 4.45), 5.5, anchor='c', angle=90)
                ttl, el, lines = COMPO_A1['mur_garage']
                annotation_block(sh, ttl, lines, *V.p(6.25, 6.95), target=V.p(5.90, 8.75))
            else:
                daylight.append(daylight_box(sh, V, 0.85, 0.95, 3.95, 'Surface chambre', 14.8896, 2.00 * 1.25 + 1.00 * 1.25))
                daylight.append(daylight_box(sh, V, 4.85, 0.95, 7.95, 'Surface chambre', 16.4688, 2.20 * 1.25))
                level_mark_plan(sh, *V.p(2.80, 6.20), level_text(3.10, Z0_A1))
                sh.text('NF', *V.p(2.62, 6.03), 5)
                sh.circle(*V.p(3.70, 11.50), 0.28 * V.k, stroke=BLACK, w=0.35)
                sh.text('Boiler', *V.p(3.70, 11.12), 5, anchor='c')
                sh.rect(*V.r((4.50, 11.30, 5.25, 11.85)), stroke=BLACK, w=0.35)
                sh.text('VMC', *V.p(4.875, 11.12), 5, anchor='c')
            # composition du mur (jardin avant), trait de rappel vers l'isolant de façade
            ttl, el, lines = COMPO_A1['mur']
            annotation_block(sh, ttl, lines, *V.p(-3.30, 13.05), target=V.p(1.20, 12.30))
            # chaînes de cotes : arrière (haut) et gauche
            if level.rank == 0:
                rear = ([0, 1.00, 5.00, 5.785, 6.985, 9.20], [dim_parts(1.00), (dim_parts(4.00), dim_parts(2.15)),
                        dim_parts(0.785), (dim_parts(1.20), dim_parts(2.15)), dim_parts(2.215)])
                rear2 = [0, 0.44, 8.90, 9.20]
                left = ([0, 1.80, 3.00, 9.465, 10.065, 10.90, 11.50, 12.40],
                        [dim_parts(1.80), (dim_parts(1.20), dim_parts(1.25)), dim_parts(6.465),
                         (dim_parts(0.60), dim_parts(0.60)), dim_parts(0.835), (dim_parts(0.60), dim_parts(0.80)),
                         dim_parts(0.90)])
                left2 = [0, 0.44, 6.20, 6.40, 11.96, 12.40]
            else:
                rear = ([0, 1.40, 3.40, 5.595, 7.795, 9.20], [dim_parts(1.40), (dim_parts(2.00), dim_parts(1.25)),
                        dim_parts(2.195), (dim_parts(2.20), dim_parts(1.25)), dim_parts(1.405)])
                rear2 = [0, 0.44, 4.40, 4.52, 8.90, 9.20]
                left = ([0, 1.60, 2.60, 4.90, 5.70, 10.00, 11.00, 12.40],
                        [dim_parts(1.60), (dim_parts(1.00), dim_parts(1.25)), dim_parts(2.30),
                         (dim_parts(0.80), dim_parts(1.00)), dim_parts(4.30), (dim_parts(1.00), dim_parts(1.00)),
                         dim_parts(1.40)])
                left2 = [0, 0.44, 4.20, 4.32, 9.00, 9.12, 11.96, 12.40]
            dims = []
            out = chain_h(sh, V.p(0, -3.8)[1], [V.p(x, 0)[0] for x in rear[0]], rear[1])
            dims += [dict(d, chain='rear-openings') for d in out]
            out = chain_h(sh, V.p(0, -4.4)[1], [V.p(x, 0)[0] for x in rear2],
                          dims_of([b - a for a, b in zip(rear2, rear2[1:])]))
            dims += [dict(d, chain='rear-walls') for d in out]
            out = chain_h(sh, V.p(0, -5.0)[1], [V.p(0, 0)[0], V.p(9.20, 0)[0]], dims_of([9.20]))
            dims += [dict(d, chain='rear-overall') for d in out]
            out = chain_v(sh, V.p(-1.4, 0)[0], [V.p(0, y)[1] for y in left[0]], left[1])
            dims += [dict(d, chain='left-openings') for d in out]
            out = chain_v(sh, V.p(-2.0, 0)[0], [V.p(0, y)[1] for y in left2],
                          dims_of([b - a for a, b in zip(left2, left2[1:])]))
            dims += [dict(d, chain='left-walls') for d in out]
            out = chain_v(sh, V.p(-2.6, 0)[0], [V.p(0, 0)[1], V.p(0, 12.40)[1]], dims_of([12.40]))
            dims += [dict(d, chain='left-overall') for d in out]
            truth['outline_pt'] = [list(p) for p in V.poly(level.outline)]
            truth['outline_area_m2'] = round(poly_area(level.outline), 4)
            truth['heated_outline_pt'] = [list(p) for p in V.poly(level.heated_outline)]
            truth['heated_outline_area_m2'] = round(poly_area(level.heated_outline), 4)
            truth['rooms'] = rooms_truth
            truth['openings'] = [opening_truth(V, op, fac_az) for op in level.openings if op['symbol'] != 'passage']
            truth['party_edges_pt'] = [[list(V.p(*a)), list(V.p(*b))] for a, b in level.party_edges]
            truth['party_wall_length_m'] = round(sum(math.dist(a, b) for a, b in level.party_edges), 3)
            truth['unheated_edges_pt'] = [[list(V.p(*a)), list(V.p(*b))] for a, b in level.unheated_edges]
            truth['wall_to_unheated_length_m'] = round(sum(math.dist(a, b) for a, b in level.unheated_edges), 3)
            truth['dims'] = dims
            truth['daylight_boxes'] = daylight
        # repères de coupe
        section_marker(sh, *V.p(7.20, -6.2), 'A', (-1, 0))
        section_marker(sh, *V.p(7.20, 15.25), 'A', (-1, 0))
        section_marker(sh, *V.p(-3.10, 2.40), 'B', (0, -1))
        section_marker(sh, *V.p(9.90, 2.40), 'B', (0, -1))
        sh.line(*V.p(7.20, -5.9), *V.p(7.20, -5.3), 0.4, dash=[4, 1.5, 1, 1.5])
        sh.line(*V.p(7.20, 13.6), *V.p(7.20, 14.95), 0.4, dash=[4, 1.5, 1, 1.5])
    tb = title_under(sh, title_parts, cx0, 915)
    truth['title_parts'] = [p for p, _ in title_parts]
    truth['title_bbox_pt'] = tb
    truth['bbox_pt'] = list(clip)
    truth['clip_pt'] = list(clip)
    truth['building_bbox_pt'] = list(V.r((0, 0, 9.20, 12.40)))
    truth['scale_den'] = 100
    return truth


def elev_window(sh, E, u0, u1, z0, z1, kind='window'):
    """Baie en façade, à l'échelle : cadre, vitrage, montant central au-delà de 1,80 m."""
    r = E.r(u0, z0, u1, z1)
    if kind == 'window':
        sh.rect(*r, fill=WHITE, stroke=BLACK, w=0.45)
        sh.rect(*E.r(u0 + 0.06, z0 + 0.06, u1 - 0.06, z1 - 0.06), fill=GLASS, stroke=BLACK, w=0.2)
        if u1 - u0 >= 1.8:
            m = (u0 + u1) / 2
            sh.line(*E.p(m, z0 + 0.06), *E.p(m, z1 - 0.06), 0.45)
    elif kind == 'door':
        sh.rect(*r, fill=(0.55, 0.55, 0.55), stroke=BLACK, w=0.45)
        sh.rect(*E.r(u0 + 0.12, z0 + 0.12, u0 + 0.38, z1 - 0.12), fill=GLASS, stroke=BLACK, w=0.2)
    elif kind == 'garage':
        sh.rect(*r, fill=(0.68, 0.68, 0.68), stroke=BLACK, w=0.45)
        z = z0 + 0.5
        while z < z1 - 0.1:
            sh.line(*E.p(u0, z), *E.p(u1, z), 0.2)
            z += 0.5
    return [round(v, 2) for v in r]


def level_mark_elev2(sh, x, y, label, nf=True, side='r', size=5.2):
    """Cote de niveau en coupe / façade : trait, triangle, « NF » au-dessus du trait, valeur dessous."""
    L = 62
    x0, x1 = (x, x + L) if side == 'r' else (x - L, x)
    sh.line(x0, y, x1, y, 0.25)
    tx = x0 + 2
    sh.poly([(tx, y), (tx + 3.5, y - 4), (tx + 7, y)], fill=BLACK)
    if nf:
        sh.text('NF', tx + 9, y - 1.3, size)
    sh.text(label, tx, y + size + 1.0, size)


def facade_a1(sh, E, length, openings, title, tx, ty, level_side, neighbour=None, extras=None, z0=Z0_A1,
              top=6.40, marks=((0.20, True), (3.10, True), (6.40, False)), title_anchor='l'):
    """Façade : enveloppe remplie, baies à l'échelle, sol, cotes de niveau, titre."""
    if neighbour is not None:
        a, b = neighbour
        for seg in ((E.p(a, -0.05), E.p(a, top)), (E.p(a, top), E.p(b, top))):
            sh.line(*seg[0], *seg[1], 0.3, (0.45, 0.45, 0.45), dash=[3, 2])
        sh.text('Voisin', *E.p((a + b) / 2, 3.0), 5.5, col=(0.45, 0.45, 0.45), anchor='c')
    sh.rect(*E.r(0, -0.05, length, top), fill=FACADE, stroke=BLACK, w=0.7)
    sh.rect(*E.r(-0.03, top, length + 0.03, top + 0.05), fill=(0.6, 0.6, 0.6), stroke=BLACK, w=0.3)
    wins = []
    for (u0, u1, za, zb, kind, label) in openings:
        r = elev_window(sh, E, u0, u1, za, zb, kind)
        wins.append({'kind': 'door' if kind in ('door', 'garage') else 'window', 'name': label, 'rect_pt': r,
                     'width_m': round(u1 - u0, 3), 'height_m': round(zb - za, 3)})
    if extras:
        extras()
    sh.line(*E.p(-2.0, -0.05), *E.p(length + 2.0, -0.05), 0.9)
    for z, nf in marks:
        if level_side == 'l':
            level_mark_elev2(sh, *E.p(-0.25, z), level_text(z, z0), nf, 'l')
        else:
            level_mark_elev2(sh, *E.p(length + 0.25, z), level_text(z, z0), nf, 'r')
    tb = title_under(sh, [(title, 'n')], tx, ty, anchor=title_anchor) if title else None
    return wins, tb


class _EV:
    """Adaptateur (u, z) → interface « View » de draw_wall_set."""

    def __init__(self, E):
        self.E = E
        self.k = E.k

    def r(self, rc):
        return self.E.r(rc[0], rc[1], rc[2], rc[3])


def draw_section(sh, E, core, insul, win, u_range, hole, slabs, plaster, length, membrane=None, caps=True,
                 garage_door=None, neighbour=None, style='archicad', ground=-0.05, depth=-2.00, seed=7,
                 gravel=(-0.62, -0.37), lean=(-0.37, -0.32)):
    """Coupe : terrain en pointillé (micro-traits) sous découpe, empierrement, parois coupées, baies, membrane."""
    u0, u1 = u_range
    ter = E.r(u0, depth, u1, ground)
    hl = E.r(*hole)
    n = sh.stipple([rect_poly(ter), rect_poly(hl)], ter, pitch=0.8, seed=seed)
    if gravel:
        emp = E.r(-0.20, gravel[0], length + 0.20, gravel[1])
        sh.rect(*emp, fill=(0.93, 0.93, 0.90), stroke=BLACK, w=0.25)
        sh.hatch([rect_poly(emp)], [0, 90], 2.6, w=0.2, col=(0.6, 0.6, 0.6))
    if lean:
        sh.rect(*E.r(0, lean[0], length, lean[1]), stroke=BLACK, w=0.25)
    if neighbour:
        a, b = neighbour
        sh.rect(*E.r(a, ground, b, 6.40), fill=(0.95, 0.95, 0.95), stroke=(0.45, 0.45, 0.45), w=0.3)
        sh.text('Voisin', *E.p((a + b) / 2, 3.0), 5.5, col=(0.45, 0.45, 0.45), anchor='c')
    for (a, b, za, zb) in slabs:
        sh.rect(*E.r(a, za, b, zb), stroke=BLACK, w=0.25)
    for (a, b, z) in plaster:
        sh.line(*E.p(a, z), *E.p(b, z), 0.3)
    draw_wall_set(sh, _EV(E), rects_minus(core, win), rects_minus(insul, win), style=style)
    for (a, za, b, zb) in win:
        m = (a + b) / 2
        for off in (-0.03, 0.03):
            sh.line(*E.p(m + off, za), *E.p(m + off, zb), 0.2)
        sh.rect(*E.r(m - 0.07, za, m + 0.07, zb), stroke=BLACK, w=0.2)
    if membrane:
        sh.rect(*E.r(*membrane), fill=BLACK)
    if caps:
        sh.rect(*E.r(-0.03, 6.40, 0.47, 6.45), fill=(0.6, 0.6, 0.6), stroke=BLACK, w=0.25)
        sh.rect(*E.r(length - 0.47, 6.40, length + 0.03, 6.45), fill=(0.6, 0.6, 0.6), stroke=BLACK, w=0.25)
    if garage_door:
        u, za, zb = garage_door
        sh.line(*E.p(u, za), *E.p(u, zb), 0.6)
    sh.line(*E.p(u0, ground), *E.p(0, ground), 0.9)
    sh.line(*E.p(length, ground), *E.p(u1, ground), 0.9)
    return n


def section_a1_AA(sh, E):
    """Coupe AA (x = 7,20 m ; u = y) : radier, séjour, dalle sur garage, étage, toiture, acrotère, terrain."""
    core = [(0, -0.24, 12.40, 0.01), (0.20, 0.01, 0.44, 6.40), (6.20, 0.01, 6.44, 2.79), (0.44, 2.79, 11.96, 2.99),
            (11.96, 2.10, 12.40, 2.79), (11.96, 2.79, 12.20, 6.40), (4.20, 2.99, 4.32, 5.69), (6.88, 2.99, 7.00, 5.69),
            (0.44, 5.69, 11.96, 5.91)]
    insul = [(0.00, -0.24, 0.20, 6.40), (0.44, 0.01, 6.20, 0.11), (0.00, -0.32, 6.56, -0.24), (6.44, 0.01, 6.56, 2.79),
             (6.56, 2.69, 11.96, 2.79), (12.20, 2.69, 12.40, 6.40), (0.44, 5.91, 11.96, 6.11)]
    win = [(0.0, 4.00, 0.44, 5.25), (11.96, 4.00, 12.40, 5.25)]
    return draw_section(sh, E, core, insul, win, u_range=(-5.0, 17.4), hole=(-0.20, -0.62, 12.60, -0.05),
                        slabs=[(0.44, 6.20, 0.11, 0.20), (6.56, 11.96, 0.01, 0.05), (0.44, 11.96, 2.99, 3.10)],
                        plaster=[(0.44, 6.20, 2.78), (0.44, 11.96, 5.68)], length=12.40,
                        membrane=(0.44, 6.11, 11.96, 6.13), garage_door=(12.18, 0.05, 2.10), seed=11)


def section_a1_BB(sh, E):
    """Coupe BB (y = 2,40 m ; u = x) : mur gauche isolé, mur mitoyen non isolé, voisin accolé."""
    core = [(0, -0.24, 9.20, 0.01), (0.20, 0.01, 0.44, 6.40), (8.90, 0.01, 9.20, 6.40), (0.44, 2.79, 8.90, 2.99),
            (4.40, 2.99, 4.52, 5.69), (0.44, 5.69, 8.90, 5.91)]
    insul = [(0.00, -0.24, 0.20, 6.40), (0.44, 0.01, 8.90, 0.11), (0.00, -0.32, 8.90, -0.24), (0.44, 5.91, 8.90, 6.11)]
    win = [(0.0, 1.10, 0.44, 2.35), (0.0, 4.00, 0.44, 5.25)]
    return draw_section(sh, E, core, insul, win, u_range=(-4.0, 13.2), hole=(-0.20, -0.62, 13.2, -0.05),
                        slabs=[(0.44, 8.90, 0.11, 0.20), (0.44, 8.90, 2.99, 3.10)],
                        plaster=[(0.44, 8.90, 2.78), (0.44, 8.90, 5.68)], length=9.20,
                        membrane=(0.44, 6.11, 8.90, 6.13), neighbour=(9.20, 13.2), seed=13)


def cartouche_fr(sh, x0, y0, x1, y1, fmt, scale, titles, big=True):
    """Cartouche : objet, phase, adresse, commune, date, format, échelle, indice et trois blocs d'adresses."""
    sh.rect(x0, y0, x1, y1, stroke=BLACK, w=0.6)
    g = GREY_TXT
    s = 1.0 if big else 0.8

    def lab(t, x, y):
        sh.text(t, x, y, 4.8 * s, FONT, g)

    X = x0 + 10 * s
    Y = lambda v: y0 + v * s  # noqa: E731
    lab('PROJET :', X, Y(16))
    sh.text("Construction d'une", X, Y(36), 13 * s, BOLD)
    sh.text('maison unifamiliale', X, Y(52), 13 * s, BOLD)
    cols = [x1 - 200 * s, x1 - 130 * s, x1 - 65 * s]
    lab('N° DE PROJET :', cols[0], Y(16))
    sh.text('EX-007', cols[0], Y(27), 6.5 * s)
    for cx, l, v in zip(cols, ('DATE :', 'FORMAT :', 'ÉCHELLE :'), ('15.01.2026', fmt, scale)):
        lab(l, cx, Y(42))
        sh.text(v, cx, Y(53), 6.5 * s)
    sh.line(x0 + 8, Y(66), x1 - 8, Y(66), 0.3)
    lab('PHASE :', X, Y(78))
    sh.text('Autorisation de bâtir', X, Y(90), 7 * s, BOLD)
    lab('ADRESSE :', X + 140 * s, Y(78))
    sh.text('Maison Exemple – Lot 7', X + 140 * s, Y(90), 7 * s, BOLD)
    sh.text('12, rue des Essais', X + 140 * s, Y(100), 6.5 * s)
    sh.text('L-0000 Exempleville', X + 140 * s, Y(110), 6.5 * s)
    lab('COMMUNE :', X + 320 * s, Y(78))
    sh.text('Exempleville', X + 320 * s, Y(90), 7 * s, BOLD)
    sh.line(x0 + 8, Y(122), x1 - 8, Y(122), 0.3)
    lab('TITRES :', X, Y(134))
    sh.text(titles, X, Y(146), 6.2 * s, BOLD)
    sh.line(x0 + 8, Y(158), x1 - 8, Y(158), 0.3)
    lab('INDICE :', X, Y(170))
    sh.text('A', X, Y(196), 22 * s, BOLD)
    lab('MODIFICATIONS :', X + 70 * s, Y(170))
    sh.text('A. Autorisation de bâtir', X + 70 * s, Y(184), 6.5 * s, BOLD)
    lab('DATE :', x1 - 70 * s, Y(170))
    sh.text('15.01.2026', x1 - 70 * s, Y(184), 6.5 * s, BOLD)
    sh.line(x0 + 8, Y(210), x1 - 8, Y(210), 0.3)
    lab('DESSINATEUR(TRICE) :', X, Y(222))
    sh.text('AM', X, Y(234), 6.5 * s)
    sh.line(x0 + 8, Y(246), x1 - 8, Y(246), 0.3)
    blocks = [
        ("MAÎTRE D'OUVRAGE :", ['M. et Mme Test'], ['3, allée du Modèle', 'L-0001 Fictiveville', '+352 00 00 00']),
        ('ADMINISTRATION :', ['Administration communale', "d'Exempleville"], ['1, place de la Mairie', 'L-0000 Exempleville']),
        ('ARCHITECTE :', ['Atelier Modèle'], ['5, avenue des Plans', 'L-0002 Démoville', '+352 00 00 01', 'N° OAI : 0000']),
    ]
    bw = (x1 - x0 - 20 * s) / 3
    out = []
    for i, (head, bold, rest) in enumerate(blocks):
        bx = X + i * bw
        lab(head, bx, Y(258))
        yy = Y(271)
        for t in bold:
            sh.text(t, bx, yy, 6.5 * s, BOLD)
            yy += 9 * s
        for t in rest:
            sh.text(t, bx, yy, 6.2 * s)
            yy += 8.5 * s
        if big:
            sh.rect(bx, Y(330), bx + bw - 12, Y(410), stroke=BLACK, w=0.3)
        out.append({'role': head.rstrip(' :'), 'lines': bold + rest})
    if big:
        sh.line(x0 + 8, Y(430), x1 - 8, Y(430), 0.3)
        sh.text('ATELIER MODÈLE', X, y1 - 18, 40, BOLD)
    return out


def titleblock_truth(blocks, fmt, scale, bbox):
    return {
        'object': "Construction d'une maison unifamiliale", 'phase': 'Autorisation de bâtir',
        'project_name': 'Maison Exemple', 'lot': 'Lot 7', 'street': '12, rue des Essais',
        'postcode_locality': 'L-0000 Exempleville', 'commune': 'Exempleville', 'date': '15.01.2026',
        'format': fmt, 'scale': scale, 'index': 'A', 'project_number': 'EX-007',
        'owner': blocks[0]['lines'], 'administration': blocks[1]['lines'], 'architect': blocks[2]['lines'],
        'bbox_pt': bbox,
    }


def notes_fr(sh, x, y, width=250):
    """Notes générales en petit texte, numérotées."""
    notes = [
        "Plan établi pour la demande d'autorisation de bâtir ; il ne vaut pas plan d'exécution.",
        'Toutes les cotes sont à vérifier sur place avant toute commande ou fabrication.',
        'Les surfaces sont des surfaces nettes au sol, mesurées entre faces finies des murs.',
        'Niveaux rapportés au ±0,00 = +312,25 (axe de la rue des Essais).',
        "Les épaisseurs d'isolant indiquées sont des valeurs minimales.",
        'Chaque nouvel indice annule et remplace le précédent.',
    ]
    yy = y
    for i, s in enumerate(notes, 1):
        cur = f'{i}. '
        first = True
        for w_ in s.split():
            if stringWidth(cur + w_, FONT, 5.4) > width:
                sh.text(cur.strip(), x if first else x + 7, yy, 5.4)
                yy += 7
                cur = ''
                first = False
            cur += w_ + ' '
        sh.text(cur.strip(), x if first else x + 7, yy, 5.4)
        yy += 9
    return [x, y - 6, x + width + 10, yy - 4], notes


def surface_table(sh, tx0, ty0, rows, w=240):
    sh.rect(tx0, ty0, tx0 + w, ty0 + 12 + 18 * len(rows), stroke=BLACK, w=0.5)
    for i, (a, b, c) in enumerate(rows):
        y = ty0 + 20 + i * 18
        sh.text(a, tx0 + 6, y, 6.5)
        sh.text(b, tx0 + w * 0.625, y, 6.5, BOLD if i else FONT, anchor='r')
        if c:
            sh.text(c, tx0 + w - 8, y, 6.5, anchor='r')
    return [tx0, ty0, tx0 + w, ty0 + 12 + 18 * len(rows)]


def make_a1():
    name = 'planche_A1_archicad'
    path = os.path.join(HERE, name + '.pdf')
    sh = Sheet(path, A1, 'Maison Exemple – Lot 7 – Autorisation de bâtir (planche synthétique)',
               "Planche d'essai synthétique : données inventées")
    W, H = A1
    sh.rect(28, 28, W - 28, H - 28, stroke=BLACK, w=0.6)
    rdc, et = maison_exemple()
    fac = facade_azimuths(UP_AZ_A1)
    views = []
    views.append(plan_view_a1(sh, rdc, 60, [('PLAN REZ-DE-CHAUSSÉE', 'n')], 'PLAN REZ-DE-CHAUSSÉE'))
    views.append(plan_view_a1(sh, et, 545, [('PLAN 1', 'n'), ('ER', 'sup'), (' ÉTAGE', 'n')], 'PLAN 1ER ÉTAGE'))
    views.append(plan_view_a1(sh, None, 1030, [('PLAN TOITURE', 'n')], 'PLAN TOITURE', kind='roof-plan'))

    # ── Façades avant et arrière (colonne de droite) ──
    fa = ElevView(1620, 345, 100)
    front_open = [(2.885, 3.885, 0.20, 2.40, 'door', "Porte d'entrée"), (6.24, 8.64, 0.05, 2.15, 'garage', 'Porte de garage'),
                  (3.90, 4.50, 4.70, 5.30, 'window', 'F11'), (6.20, 8.20, 4.00, 5.25, 'window', 'F12')]
    wins, tb = facade_a1(sh, fa, 9.20, front_open, 'FAÇADE AVANT', 1560, 410, 'l', neighbour=(9.20, 10.4))
    views.append({'kind': 'elevation', 'title': 'FAÇADE AVANT', 'name': 'front', 'azimuth_deg': fac['front'],
                  'bbox_pt': [1540, 140, 1960, 370], 'building_bbox_pt': list(fa.r(0, -0.05, 9.20, 6.45)),
                  'title_bbox_pt': tb, 'openings': wins, 'scale_den': 100})
    fr_ = ElevView(2000, 345, 100)
    rear_open = [(9.20 - 5.00, 9.20 - 1.00, 0.20, 2.35, 'window', 'F1'), (9.20 - 6.985, 9.20 - 5.785, 0.20, 2.35, 'window', 'F2'),
                 (9.20 - 3.40, 9.20 - 1.40, 4.00, 5.25, 'window', 'F6'), (9.20 - 7.795, 9.20 - 5.595, 4.00, 5.25, 'window', 'F7')]

    def terrace_rear():
        sh.rect(*fr_.r(9.20 - 6.44, -0.05, 9.20 - 0.44, 0.15), fill=PAVING, stroke=BLACK, w=0.3)

    wins, tb = facade_a1(sh, fr_, 9.20, rear_open, 'FAÇADE ARRIÈRE', 1985, 410, 'r', neighbour=(-1.2, 0.0),
                         extras=terrace_rear)
    views.append({'kind': 'elevation', 'title': 'FAÇADE ARRIÈRE', 'name': 'rear', 'azimuth_deg': fac['rear'],
                  'bbox_pt': [1940, 140, 2340, 370], 'building_bbox_pt': list(fr_.r(0, -0.05, 9.20, 6.45)),
                  'title_bbox_pt': tb, 'openings': wins, 'scale_den': 100})

    # ── Coupe BB ──
    bb = ElevView(1560, 740, 100, u0=-4.0)
    n_bb = section_a1_BB(sh, bb)
    for z, nf in ((0.20, True), (3.10, True), (6.40, False)):
        level_mark_elev2(sh, *bb.p(-0.25, z), level_text(z, Z0_A1), nf, 'l')
    ttl, el, lines = COMPO_A1['mur']
    annotation_block(sh, ttl, lines, *bb.p(-3.85, 5.30), target=bb.p(0.10, 4.70))
    tb = title_under(sh, [('COUPE BB', 'n')], 1560, 840)
    views.append({'kind': 'section', 'title': 'COUPE BB', 'name': 'BB', 'cut': {'axis': 'y', 'at_m': 2.40},
                  'bbox_pt': [1560, 530, 2050, 800], 'building_bbox_pt': list(bb.r(0, -0.62, 9.20, 6.45)),
                  'title_bbox_pt': tb, 'scale_den': 100, 'stipple_traits': n_bb})

    # ── Tableau des surfaces ──
    rows = [('Surface terrain :', '316,23m²', ''), ('Surface scellée :', '150,78m²', 'max 190m²'),
            ('Surface emprise au sol :', '114,08m²', 'max 120m²'), ('Surface construite brute :', '228,16m²', 'max 240m²')]
    tbb = surface_table(sh, 2100, 470, rows)
    tb_tab = title_under(sh, [('CALCULS DES SURFACES', 'n')], 2100, 582)
    views.append({'kind': 'table', 'title': 'CALCULS DES SURFACES', 'bbox_pt': tbb, 'title_bbox_pt': tb_tab})

    # ── Photo, nord ──
    sh.c.drawImage(ImageReader(gray_photo(11)), 2100, 620, width=120, height=90)
    tb_ph = title_under(sh, [('PHOTO AÉRIENNE', 'n')], 2100, 740)
    views.append({'kind': 'photo', 'title': 'PHOTO AÉRIENNE', 'bbox_pt': [2100, 620, 2220, 710], 'title_bbox_pt': tb_ph})
    nb = north_arrow(sh, 2305, 680, 22, NORTH_CW_A1)
    views.append({'kind': 'north', 'title': 'NORD', 'bbox_pt': [round(v, 2) for v in nb]})

    # ── Notes, cartouche ──
    nbx, notes = notes_fr(sh, 1560, 890)
    views.append({'kind': 'notes', 'title': None, 'bbox_pt': [round(v, 2) for v in nbx]})
    blocks = cartouche_fr(sh, 1860, 880, 2340, 1640, 'A1', '1/100',
                          'Plan rez-de-chaussée / 1er étage / Toiture / Coupes AA-BB / Façades / Calculs des surfaces')
    views.append({'kind': 'titleblock', 'title': None, 'bbox_pt': [1860, 880, 2340, 1640]})

    # ── Coupe AA et façade latérale (bande du bas) ──
    aa = ElevView(70, 1470, 100, u0=-5.0)
    n_aa = section_a1_AA(sh, aa)
    for z, nf in ((0.20, True), (3.10, True), (6.40, False)):
        level_mark_elev2(sh, *aa.p(-0.25, z), level_text(z, Z0_A1), nf, 'l')
    level_mark_elev2(sh, *aa.p(15.2, -0.05), level_text(0.0, Z0_A1) + ' axe rue', False, 'r')
    compos = []

    def compo(key, u, z, target):
        ttl, el, lines = COMPO_A1[key]
        b = annotation_block(sh, ttl, lines, *aa.p(u, z), target=aa.p(*target))
        compos.append({'key': key, 'title': ttl, 'element': el, 'view': 'COUPE AA', 'bbox_pt': [round(v, 2) for v in b],
                       'target_pt': list(aa.p(*target)), 'layers': layers_of(lines)})

    compo('dalle_sol', 0.70, 2.50, (4.60, 0.15))
    compo('dalle_etage', 0.70, 5.45, (3.60, 3.05))
    compo('dalle_garage', 7.10, 2.42, (10.90, 2.74))
    compo('toiture', 7.40, 5.42, (10.70, 6.00))
    ys = [0.20, 2.78, 3.10, 5.68, 6.40]
    chain_v(sh, aa.p(13.8, 0)[0], [aa.p(0, z)[1] for z in ys], dims_of([b - a for a, b in zip(ys, ys[1:])]))
    tb = title_under(sh, [('COUPE AA', 'n')], 80, 1590)
    views.append({'kind': 'section', 'title': 'COUPE AA', 'name': 'AA', 'cut': {'axis': 'x', 'at_m': 7.20},
                  'bbox_pt': [70, 1270, 720, 1535], 'building_bbox_pt': list(aa.r(0, -0.62, 12.40, 6.45)),
                  'title_bbox_pt': tb, 'scale_den': 100, 'stipple_traits': n_aa})

    fl = ElevView(840, 1470, 100, u0=-4.0)
    side_open = [(1.80, 3.00, 1.10, 2.35, 'window', 'F3'), (9.465, 10.065, 1.80, 2.40, 'window', 'F4'),
                 (10.90, 11.50, 1.60, 2.40, 'window', 'F5'), (1.60, 2.60, 4.00, 5.25, 'window', 'F8'),
                 (4.90, 5.70, 4.30, 5.30, 'window', 'F9'), (10.00, 11.00, 4.30, 5.30, 'window', 'F10')]

    def side_extras():
        sh.rect(*fl.r(-3.20, -0.05, 0.0, 0.15), fill=PAVING, stroke=BLACK, w=0.3)
        sh.rect(*fl.r(4.00, -0.05, 4.90, 0.75), fill=WHITE, stroke=BLACK, w=0.35)
        sh.text('PAC', *fl.p(4.45, 0.25), 5.5, anchor='c')

    wins, tb = facade_a1(sh, fl, 12.40, side_open, 'FAÇADE LATÉRALE', 840, 1590, 'r', extras=side_extras)
    views.append({'kind': 'elevation', 'title': 'FAÇADE LATÉRALE', 'name': 'side', 'azimuth_deg': fac['left'],
                  'bbox_pt': [840, 1270, 1400, 1500], 'building_bbox_pt': list(fl.r(0, -0.05, 12.40, 6.45)),
                  'title_bbox_pt': tb, 'openings': wins, 'scale_den': 100})
    sh.save()

    compos_all = [
        {'key': 'mur', 'title': COMPO_A1['mur'][0], 'element': 'wall', 'to_unheated': False,
         'view': 'PLAN REZ-DE-CHAUSSÉE, PLAN 1ER ÉTAGE, COUPE BB', 'layers': layers_of(COMPO_A1['mur'][2])},
        {'key': 'mur_garage', 'title': COMPO_A1['mur_garage'][0], 'element': 'wall', 'to_unheated': True,
         'view': 'PLAN REZ-DE-CHAUSSÉE', 'layers': layers_of(COMPO_A1['mur_garage'][2])},
    ] + compos
    truth = {
        'file': name + '.pdf',
        'synthetic': True,
        'generator': 'tests/fixtures/pdf/planche/make_planches.py',
        'style': 'archicad',
        'language': 'fr',
        'scale_den': 100,
        'north_azimuth_deg': UP_AZ_A1,
        'north_cw_from_up_deg': NORTH_CW_A1,
        'facade_azimuth_deg': {'front': fac['front'], 'rear': fac['rear'], 'side': fac['left'], 'party': fac['right']},
        'building': building_summary_a1(rdc, et),
        'pages': [{
            'number': 1, 'width_pt': W, 'height_pt': H, 'format': 'A1', 'orientation': 'landscape', 'scale_den': 100,
            'views': views,
            'levels': [
                {'label': '±0,00=+312,25', 'value_m': 0.0, 'altitude_m': 312.25, 'what': 'axe de la rue'},
                {'label': '-0,05=+312,20', 'value_m': -0.05, 'altitude_m': 312.20, 'what': 'terrain / terrasse'},
                {'label': '+0,05=+312,30', 'value_m': 0.05, 'altitude_m': 312.30, 'what': 'NF garage'},
                {'label': '+0,20=+312,45', 'value_m': 0.20, 'altitude_m': 312.45, 'what': 'NF rez-de-chaussée'},
                {'label': '+3,10=+315,35', 'value_m': 3.10, 'altitude_m': 315.35, 'what': 'NF 1er étage'},
                {'label': '+6,40=+318,65', 'value_m': 6.40, 'altitude_m': 318.65, 'what': 'acrotère'},
            ],
            'storeys': [
                {'level': 0, 'floor_m': 0.20, 'storey_height_m': 2.90, 'clear_height_m': 2.58},
                {'level': 1, 'floor_m': 3.10, 'storey_height_m': 3.03, 'clear_height_m': 2.58},
            ],
            'compositions': compos_all,
            'surface_table': {'terrain_m2': 316.23, 'sealed_m2': 150.78, 'sealed_max_m2': 190,
                              'footprint_m2': 114.08, 'footprint_max_m2': 120, 'gross_floor_m2': 228.16,
                              'gross_floor_max_m2': 240},
            'titleblock': titleblock_truth(blocks, 'A1', '1/100', [1860, 880, 2340, 1640]),
            'equipment': [
                {'text': 'PAC', 'level': 0, 'where': 'extérieur, côté façade latérale', 'meaning': 'pompe à chaleur (unité extérieure)'},
                {'text': 'Boiler', 'level': 1, 'where': 'Local technique', 'meaning': "ballon d'eau chaude"},
                {'text': 'VMC', 'level': 1, 'where': 'Local technique', 'meaning': 'ventilation mécanique contrôlée'},
            ],
            'notes': notes,
            'counts': sh.page_counts[0],
        }],
    }
    write_truth(os.path.join(HERE, name + '.truth.json'), truth)
    return path


def building_summary_a1(rdc, et):
    def heated(level):
        return round(sum(r['area'] for r in level.rooms if r['heated']), 4)

    def labelled(level):
        return round(sum(round(r['area'], 2) for r in level.rooms if r['heated'] and r['show']), 2)

    return {
        'name': 'Maison Exemple', 'footprint_m': [9.20, 12.40], 'footprint_area_m2': 114.08,
        'attachment': 'semi-detached', 'party_side': 'right', 'storeys_heated': 2, 'basement': False, 'roof': 'flat',
        'garage': {'level': 0, 'heated': False, 'area_m2': 15.876, 'inside_footprint': True,
                   'envelope': "isolant entre garage et logement, pas autour du garage ; dalle d'étage isolée en sous-face"},
        'heated_area_by_level_m2': {'0': heated(rdc), '1': heated(et)},
        'labelled_heated_area_by_level_m2': {'0': labelled(rdc), '1': labelled(et)},
        'escalier_non_etiquete_m2': 5.096,
    }


def main():
    paths = [make_a1()]
    for p in paths:
        print(os.path.basename(p), os.path.getsize(p))


if __name__ == '__main__':
    main()
