#!/usr/bin/env python
"""raster_tests.py - what can be done WITHOUT a paid API on a scanned plan.

 1. make synthetic scans of the FR fixture (200 dpi and 100 dpi; skew 0.6 deg, blur, noise, JPEG q=50)
 2. OCR with RapidOCR (PP-OCR ONNX models bundled in the wheel, CPU, offline) with tiling + 90 deg pass
    -> recall of room names / area labels / dimension numbers / scale text
 3. classical-CV building outline (Otsu -> keep thick strokes -> closing -> external contour)
    -> area error with the scale taken from (dpi, declared scale)
 4. corner candidates for snapping (goodFeaturesToTrack on the thick-stroke mask)
"""
import json
import math
import re
import sys
import time
import unicodedata

import cv2
import numpy as np
import pymupdf

FIX = "fixtures/fr_A3_1-100"
truth = json.load(open(FIX + ".truth.json"))


def norm(s):
    return unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower().replace(" ", "")


def make_scan(pdf, dpi, skew_deg=0.6, noise=10, blur=0.8, jpeg_q=50, out=None, seed=0):
    pg = pymupdf.open(pdf)[0]
    pix = pg.get_pixmap(dpi=dpi, colorspace=pymupdf.csGRAY)
    img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width).copy()
    h, w = img.shape
    M = cv2.getRotationMatrix2D((w / 2, h / 2), skew_deg, 1.0)
    img = cv2.warpAffine(img, M, (w, h), flags=cv2.INTER_LINEAR, borderValue=255)
    if blur:
        img = cv2.GaussianBlur(img, (0, 0), blur * dpi / 200)
    rng = np.random.default_rng(seed)
    img = np.clip(img.astype(np.float32) * 0.92 + 12 + rng.normal(0, noise, img.shape), 0, 255).astype(np.uint8)
    ok, enc = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, jpeg_q])
    img = cv2.imdecode(enc, cv2.IMREAD_GRAYSCALE)
    if out:
        cv2.imwrite(out, img)
    return img, M


# ------------------------------------------------------------------ OCR
def ocr_tiles(img, engine, tile=1100, overlap=220, upscale=1.0):
    """Run OCR on overlapping tiles (plans are huge and text is tiny), plus a 90-degree-rotated pass for
    vertical dimension texts. Returns list of (text, score, orientation)."""
    res = []
    for rot in (0, 90):
        im = img if rot == 0 else cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE)
        H, W = im.shape[:2]
        step = tile - overlap
        for y in range(0, max(1, H - overlap), step):
            for x in range(0, max(1, W - overlap), step):
                t = im[y:y + tile, x:x + tile]
                if t.mean() > 253:
                    continue
                if upscale != 1.0:
                    t = cv2.resize(t, None, fx=upscale, fy=upscale, interpolation=cv2.INTER_CUBIC)
                out, _ = engine(cv2.cvtColor(t, cv2.COLOR_GRAY2BGR))
                for box, txt, sc in (out or []):
                    res.append((txt, float(sc), rot))
    return res


def eval_ocr(res, label):
    texts = [r[0] for r in res]
    ntexts = [norm(t) for t in texts]
    rooms = [r for v in truth["pages"][0]["views"] for r in v.get("rooms", [])]
    names_ok = sum(1 for r in rooms if any(norm(r["name"]) in t for t in ntexts))
    names_exact = sum(1 for r in rooms if any(r["name"].replace(" ", "") in t.replace(" ", "") for t in texts))
    areas = [r for r in rooms if r["area_label"]]
    area_vals = set()
    for t in texts:
        for m in re.finditer(r"(\d{1,3})[.,](\d{2})\s*m", t):
            area_vals.add(f"{m.group(1)},{m.group(2)}")
    areas_ok = sum(1 for r in areas if re.search(r"\d+,\d+", r["area_label"]).group(0) in area_vals)
    dims = [d for v in truth["pages"][0]["views"] for d in v.get("dims", [])]
    from collections import Counter
    have = Counter()
    for t, sc, rot in res:
        tt = t.strip()
        if re.fullmatch(r"\d{2,4}", tt):
            have[(tt, "x" if rot == 0 else "y")] += 1
    want = Counter((d["text"], d["axis"]) for d in dims)
    # tiles overlap => the same text can be seen twice; count a truth dim as found if its value was read at all
    hx = sum(c for (v, a), c in want.items() if a == "x" and have[(v, "x")] > 0)
    hy = sum(c for (v, a), c in want.items() if a == "y" and have[(v, "y")] > 0)
    nx = sum(c for (v, a), c in want.items() if a == "x")
    ny = sum(c for (v, a), c in want.items() if a == "y")
    wrong_nums = sorted({v for (v, a) in have if v not in {d["text"] for d in dims}})
    scale = any(re.search(r"1\s*[:/]\s*100", t) for t in texts)
    levels = sum(1 for lv in ("0,00", "2,80", "5,60") if any(lv in t.replace(".", ",") for t in texts))
    print(f"  [{label}] {len(res)} OCR strings | room names {names_ok}/{len(rooms)} (with correct accents {names_exact}/{len(rooms)})"
          f" | area labels {areas_ok}/{len(areas)} | horizontal dims {hx}/{nx} | vertical dims {hy}/{ny}"
          f" | scale text {'yes' if scale else 'NO'} | level marks {levels}/3")
    print(f"       numeric strings read that are NOT a true dimension value (false readings): {wrong_nums[:25]}")
    return texts


# ------------------------------------------------------------------ classical CV outline
def outline_cv(img, dpi, scale_den, thick_mm=0.35, close_m=1.3, min_len_m=0.5):
    px_per_m = dpi / 0.0254 / scale_den
    _, bw = cv2.threshold(img, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    k = max(2, int(round(thick_mm / 25.4 * dpi)))  # strokes thinner than ~thick_mm disappear
    thick = cv2.morphologyEx(bw, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (k, k)))
    r = int(round(close_m * px_per_m))
    pad = r + 5
    t2 = cv2.copyMakeBorder(thick, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=0)
    # drop the sheet frame / title block: components whose bbox spans > 60 % of the sheet
    n, lab, stats, _ = cv2.connectedComponentsWithStats(t2, 8)
    H, W = t2.shape
    small = int(round(min_len_m * px_per_m))
    for i in range(1, n):
        if stats[i, cv2.CC_STAT_WIDTH] > 0.6 * W or stats[i, cv2.CC_STAT_HEIGHT] > 0.6 * H:
            t2[lab == i] = 0
        # v2: drop small blobs (tick/extension-line crossings, bold titles, arrow heads). Without this the
        # closing glues the dimension chains to the building (measured: +23 % .. +147 % area error).
        elif max(stats[i, cv2.CC_STAT_WIDTH], stats[i, cv2.CC_STAT_HEIGHT]) < small:
            t2[lab == i] = 0
    se = cv2.getStructuringElement(cv2.MORPH_RECT, (2 * r + 1, 2 * r + 1))  # square SE keeps right angles exact
    dil = cv2.dilate(t2, se)
    cnts, _ = cv2.findContours(dil, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    fill = np.zeros_like(dil)
    cv2.drawContours(fill, cnts, -1, 255, -1)
    ero = cv2.erode(fill, se)
    cnts, _ = cv2.findContours(ero, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    out = []
    for c in cnts:
        a = cv2.contourArea(c)
        if a > (3 * px_per_m) ** 2:
            x, y, w, h = cv2.boundingRect(c)
            out.append({"area_m2": a / px_per_m ** 2, "bbox": (x - pad, y - pad, w, h), "contour": c - pad})
    return out, thick, px_per_m


if __name__ == "__main__":
    from rapidocr_onnxruntime import RapidOCR
    engine = RapidOCR()
    tv = {v["view"]: v for v in truth["pages"][0]["views"]}
    for dpi, noise in ((200, 10), (100, 10)):
        img, M = make_scan(FIX + ".pdf", dpi, noise=noise, out=f"fixtures/scan_fr_{dpi}dpi.png")
        print(f"=== synthetic scan {dpi} dpi  {img.shape[1]}x{img.shape[0]} px  (1 m = {dpi / 0.0254 / 100:.1f} px, 6 pt text = {6 / 72 * dpi:.0f} px high)")
        if "--no-ocr" not in sys.argv:
            t0 = time.time()
            res = ocr_tiles(img, engine)
            print(f"  OCR time {time.time() - t0:.1f} s on CPU")
            eval_ocr(res, "tiles 1x")
        if dpi == 100 and "--no-ocr" not in sys.argv:
            t0 = time.time()
            res = ocr_tiles(img, engine, tile=700, overlap=150, upscale=2.0)
            print(f"  OCR time {time.time() - t0:.1f} s on CPU")
            eval_ocr(res, "tiles 2x upscaled")
        outs, thick, ppm = outline_cv(img, dpi, 100)
        for o in sorted(outs, key=lambda o: -o["area_m2"]):
            cx = (o["bbox"][0] + o["bbox"][2] / 2) * 72 / dpi  # match by position (pt)
            best = min(((abs(cx - sum(p[0] for p in v["outline_pt"][:-1]) / (len(v["outline_pt"]) - 1)), n, v["outline_area_m2"]) for n, v in tv.items() if "outline_area_m2" in v))
            print(f"  CV outline: {o['area_m2']:.2f} m²  (closest truth: {best[1]} {best[2]:.2f} m² -> {100 * (o['area_m2'] / best[2] - 1):+.2f} %)  bbox={o['bbox']}")
        # snapping candidates: are the true outline corners close to a detected corner?
        corners = cv2.goodFeaturesToTrack(thick, maxCorners=4000, qualityLevel=0.05, minDistance=3, blockSize=5)
        corners = corners.reshape(-1, 2) if corners is not None else np.zeros((0, 2))
        ds = []
        for v in truth["pages"][0]["views"]:
            if "outline_pt" not in v:
                continue
            for x, y in v["outline_pt"][:-1]:
                p = np.array([x * dpi / 72, y * dpi / 72, 1.0])
                q = M @ p
                d = np.min(np.hypot(corners[:, 0] - q[0], corners[:, 1] - q[1])) if len(corners) else 99
                ds.append(d)
        ds = np.array(ds)
        print(f"  snapping: {len(corners)} corner candidates; true outline corners with a candidate within 3 px: {(ds < 3).sum()}/{len(ds)}"
              f" (median distance {np.median(ds):.2f} px = {np.median(ds) / ppm * 100:.1f} cm)")
    if "--no-ocr" in sys.argv:
        sys.exit()
    # OCR as a fallback for vector PDFs whose text is outlines (CAD plot through ezdxf)
    pg = pymupdf.open("fixtures/cad_plot_ezdxf.pdf")[0]
    pix = pg.get_pixmap(dpi=200, colorspace=pymupdf.csGRAY)
    img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width).copy()
    res = ocr_tiles(img, engine)
    print("=== outlined-text CAD plot rendered at 200 dpi, OCR strings:", sorted({(t, r) for t, s, r in res}))
