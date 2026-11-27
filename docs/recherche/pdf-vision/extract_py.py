#!/usr/bin/env python
"""extract_py.py - extract texts + vector segments from a PDF into a common JSON "IR".

Usage: extract_py.py <pdf> <backend: pymupdf|pdfplumber> <out.json>

IR (per page), all coordinates in PDF points, origin TOP-LEFT, y down:
  texts: [{s, x0, y0, x1, y1, cx, cy, angle (deg, 0 = left-to-right, 90 = bottom-to-top), size}]
  segs : [{x0, y0, x1, y1, w (stroke width pt, 0 for fill-only edges), kind: 'l'|'c', stroke, fill, pid}]
"""
import json
import math
import sys
import time


def bezier_pts(p0, p1, p2, p3, n=8):
    out = []
    for i in range(n + 1):
        t = i / n
        mt = 1 - t
        x = mt ** 3 * p0[0] + 3 * mt * mt * t * p1[0] + 3 * mt * t * t * p2[0] + t ** 3 * p3[0]
        y = mt ** 3 * p0[1] + 3 * mt * mt * t * p1[1] + 3 * mt * t * t * p2[1] + t ** 3 * p3[1]
        out.append((x, y))
    return out


def extract_pymupdf(path):
    import pymupdf
    doc = pymupdf.open(path)
    pages = []
    for page in doc:
        if page.rotation:
            # get_text()/get_drawings() return coordinates of the UNROTATED page while page.rect is rotated
            # (verified on fixtures/fr_A3_rot90.pdf). remove_rotation() bakes /Rotate into the content
            # so that everything is in the display frame, like pdf.js viewport and pdfplumber.
            page.remove_rotation()
        W, H = page.rect.width, page.rect.height
        texts = []
        d = page.get_text("dict", flags=pymupdf.TEXT_PRESERVE_WHITESPACE)
        for b in d["blocks"]:
            if b["type"] != 0:
                continue
            for ln in b["lines"]:
                dx, dy = ln["dir"]
                ang = round(math.degrees(math.atan2(-dy, dx)), 1)  # y down -> flip
                for sp in ln["spans"]:
                    s = sp["text"]
                    if not s.strip():
                        continue
                    x0, y0, x1, y1 = sp["bbox"]
                    texts.append({"s": s, "x0": x0, "y0": y0, "x1": x1, "y1": y1, "cx": (x0 + x1) / 2,
                                  "cy": (y0 + y1) / 2, "angle": ang, "size": sp["size"],
                                  "ox": sp["origin"][0], "oy": sp["origin"][1]})
        segs = []
        for pid, dr in enumerate(page.get_drawings()):
            w = dr.get("width") or 0.0
            stroke = dr.get("color") is not None
            fill = dr.get("fill") is not None
            if not stroke:
                w = 0.0
            dashed = bool(dr.get("dashes")) and dr.get("dashes") not in ("[] 0",)
            for it in dr["items"]:
                op = it[0]
                if op == "l":
                    a, b = it[1], it[2]
                    segs.append({"x0": a.x, "y0": a.y, "x1": b.x, "y1": b.y, "w": w, "kind": "l",
                                 "stroke": stroke, "fill": fill, "pid": pid, "dash": dashed})
                elif op == "c":
                    pts = bezier_pts(*[(p.x, p.y) for p in it[1:5]])
                    for a, b in zip(pts[:-1], pts[1:]):
                        segs.append({"x0": a[0], "y0": a[1], "x1": b[0], "y1": b[1], "w": w, "kind": "c",
                                     "stroke": stroke, "fill": fill, "pid": pid, "dash": dashed})
                elif op == "re":
                    r = it[1]
                    c = [(r.x0, r.y0), (r.x1, r.y0), (r.x1, r.y1), (r.x0, r.y1), (r.x0, r.y0)]
                    for a, b in zip(c[:-1], c[1:]):
                        segs.append({"x0": a[0], "y0": a[1], "x1": b[0], "y1": b[1], "w": w, "kind": "l",
                                     "stroke": stroke, "fill": fill, "pid": pid, "dash": dashed})
                elif op == "qu":
                    q = it[1]
                    c = [q.ul, q.ur, q.lr, q.ll, q.ul]
                    for a, b in zip(c[:-1], c[1:]):
                        segs.append({"x0": a.x, "y0": a.y, "x1": b.x, "y1": b.y, "w": w, "kind": "l",
                                     "stroke": stroke, "fill": fill, "pid": pid, "dash": dashed})
        pages.append({"width": W, "height": H, "texts": texts, "segs": segs})
    return pages


def group_chars(chars, page_rotation=0):
    """Group pdfplumber chars into text runs, for ANY axis-aligned rotation.
    (pdfplumber.extract_words() reverses 90-degree text by default and pdfminer's char 'size' is the
    glyph ADVANCE for rotated chars, so we do it ourselves from the char matrix.)
    A new run starts when: baseline changes, gap > 0.6*size, or font size changes > 15 % (superscripts)."""
    groups = {}
    for c in chars:
        a, b = c["matrix"][0], c["matrix"][1]
        ang = round(math.degrees(math.atan2(b, a)))  # PDF space (y up): 90 = reads bottom-to-top
        # NB: with /Rotate != 0 pdfminer already folds the rotation into the char matrix (verified on
        # fixtures/fr_A3_rot90.pdf), so bbox AND matrix are both in the display frame: nothing to correct.
        groups.setdefault(ang, []).append(c)
    out = []
    for ang, cs in groups.items():
        t = math.radians(ang)
        ux, uy = math.cos(t), -math.sin(t)  # reading direction in top-left coords
        nx, ny = -uy, ux                    # perpendicular (towards "below the baseline")
        items = []
        for c in cs:
            w, h = c["x1"] - c["x0"], c["bottom"] - c["top"]
            size = h if abs(ux) > 0.7 else w
            adv = w if abs(ux) > 0.7 else h
            cx, cy = (c["x0"] + c["x1"]) / 2, (c["top"] + c["bottom"]) / 2
            sc, pc = cx * ux + cy * uy, cx * nx + cy * ny
            # baseline position along n: bottom of the box in the rotated frame
            items.append({"c": c, "s0": sc - adv / 2, "s1": sc + adv / 2, "p": pc + size / 2, "size": size})
        items.sort(key=lambda i: (round(i["p"] / 0.8), i["s0"]))
        runs, cur = [], []
        for it in items:
            if cur:
                pr = cur[-1]
                same_line = abs(it["p"] - pr["p"]) < 0.25 * max(pr["size"], it["size"])
                near = -0.5 * pr["size"] < it["s0"] - pr["s1"] < 0.6 * pr["size"]
                same_size = abs(it["size"] - pr["size"]) < 0.15 * max(pr["size"], it["size"])
                if not (same_line and near and same_size):
                    runs.append(cur)
                    cur = []
            cur.append(it)
        if cur:
            runs.append(cur)
        for r in runs:
            s = "".join(i["c"]["text"] for i in r)
            if not s.strip():
                continue
            x0 = min(i["c"]["x0"] for i in r); x1 = max(i["c"]["x1"] for i in r)
            y0 = min(i["c"]["top"] for i in r); y1 = max(i["c"]["bottom"] for i in r)
            out.append({"s": s.strip(), "x0": x0, "y0": y0, "x1": x1, "y1": y1, "cx": (x0 + x1) / 2,
                        "cy": (y0 + y1) / 2, "angle": float(ang), "size": round(r[0]["size"], 2)})
    return out


def extract_pdfplumber(path):
    import pdfplumber
    pages = []
    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            W, H = float(page.width), float(page.height)
            texts = group_chars(page.chars, page.rotation or 0)
            segs = []
            pid = 0
            for ln in page.lines:
                segs.append({"x0": ln["x0"], "y0": ln["top"] if ln["pts"][0][1] <= ln["pts"][-1][1] else ln["bottom"],
                             "x1": ln["x1"], "y1": ln["bottom"] if ln["pts"][0][1] <= ln["pts"][-1][1] else ln["top"],
                             "w": ln["linewidth"] if ln["stroke"] else 0.0, "kind": "l",
                             "stroke": bool(ln["stroke"]), "fill": bool(ln["fill"]), "pid": pid,
                             "dash": bool(ln.get("dash") and ln["dash"][0])})
                # use exact pts (already top-left origin)
                (ax, ay), (bx, by) = ln["pts"][0], ln["pts"][-1]
                segs[-1].update({"x0": ax, "y0": ay, "x1": bx, "y1": by})
                pid += 1
            for r in page.rects:
                c = [(r["x0"], r["top"]), (r["x1"], r["top"]), (r["x1"], r["bottom"]), (r["x0"], r["bottom"]),
                     (r["x0"], r["top"])]
                for a, b in zip(c[:-1], c[1:]):
                    segs.append({"x0": a[0], "y0": a[1], "x1": b[0], "y1": b[1],
                                 "w": r["linewidth"] if r["stroke"] else 0.0, "kind": "l",
                                 "stroke": bool(r["stroke"]), "fill": bool(r["fill"]), "pid": pid, "dash": False})
                pid += 1
            for cv in page.curves:
                # cv['path'] = [('m',(x,y)), ('l',(x,y)), ('c',(c1),(c2),(p)), ('h',)]  (top-left origin)
                cur = start = None
                w = cv["linewidth"] if cv["stroke"] else 0.0
                base = {"w": w, "stroke": bool(cv["stroke"]), "fill": bool(cv["fill"]), "pid": pid,
                        "dash": bool(cv.get("dash") and cv["dash"][0])}
                path = cv.get("path")
                if path:
                    for it in path:
                        op = it[0]
                        if op == "m":
                            cur = start = it[1]
                        elif op == "l":
                            segs.append({"x0": cur[0], "y0": cur[1], "x1": it[1][0], "y1": it[1][1], "kind": "l", **base})
                            cur = it[1]
                        elif op == "c":
                            pts = bezier_pts(cur, it[1], it[2], it[3])
                            for a, b in zip(pts[:-1], pts[1:]):
                                segs.append({"x0": a[0], "y0": a[1], "x1": b[0], "y1": b[1], "kind": "c", **base})
                            cur = it[3]
                        elif op == "h" and cur is not None and start is not None and cur != start:
                            segs.append({"x0": cur[0], "y0": cur[1], "x1": start[0], "y1": start[1], "kind": "l", **base})
                            cur = start
                else:
                    pts = cv["pts"]
                    for a, b in zip(pts[:-1], pts[1:]):
                        segs.append({"x0": a[0], "y0": a[1], "x1": b[0], "y1": b[1], "kind": "l", **base})
                pid += 1
            pages.append({"width": W, "height": H, "texts": texts, "segs": segs})
    return pages


if __name__ == "__main__":
    pdf, backend, out = sys.argv[1:4]
    t0 = time.time()
    pages = extract_pymupdf(pdf) if backend == "pymupdf" else extract_pdfplumber(pdf)
    dt = time.time() - t0
    json.dump({"backend": backend, "file": pdf, "seconds": round(dt, 3), "pages": pages}, open(out, "w"))
    for i, p in enumerate(pages):
        ws = sorted({round(s["w"], 2) for s in p["segs"]})
        print(f"[{backend}] page {i + 1}: {len(p['texts'])} texts, {len(p['segs'])} segs, widths(pt)={ws}, "
              f"rotated texts={sum(1 for t in p['texts'] if abs(t['angle']) > 1)}")
    print(f"[{backend}] {dt:.3f}s")
