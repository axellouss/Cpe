#!/usr/bin/env python
"""make_scan_variants.py - variantes « scan » des plans d'essai PDF (à relancer seulement pour les régénérer).

Entrée  : scan_fr_100dpi.png, le scan synthétique du plan fr_A3_1-100.pdf produit par raster_tests.py
          (notes de recherche pdf-vision : gris, biais de 0,6 degré, flou, bruit).
Sorties : scan_fr_100dpi_bilevel.png  même scan en noir et blanc (1 bit), 1654 x 1170 px, 100 dpi déclarés (pHYs)
          scan_fr_100dpi.jpg          même scan en JPEG, 100 dpi déclarés (JFIF)
          scan_only_A3.pdf            PDF d'une page A3 ne contenant QUE ce scan (aucun trait, aucun texte)

Usage : python make_scan_variants.py <scan_fr_100dpi.png> <dossier de sortie>
Dépendances : opencv-python-headless, pymupdf.
"""
import struct
import sys
import zlib

import cv2
import pymupdf

src, out = sys.argv[1], sys.argv[2].rstrip("/")
gray = cv2.imread(src, cv2.IMREAD_GRAYSCALE)
h, w = gray.shape
_, bw = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)


def with_phys(png: bytes, dpi: int) -> bytes:
    """Insère un bloc pHYs (pixels par mètre) juste après IHDR."""
    per_metre = round(dpi / 0.0254)
    data = struct.pack(">IIB", per_metre, per_metre, 1)
    chunk = struct.pack(">I", len(data)) + b"pHYs" + data + struct.pack(">I", zlib.crc32(b"pHYs" + data))
    end_ihdr = 8 + 12 + 13
    return png[:end_ihdr] + chunk + png[end_ihdr:]


ok, png = cv2.imencode(".png", bw, [cv2.IMWRITE_PNG_BILEVEL, 1, cv2.IMWRITE_PNG_COMPRESSION, 9])
assert ok
open(f"{out}/scan_fr_100dpi_bilevel.png", "wb").write(with_phys(png.tobytes(), 100))

ok, jpg = cv2.imencode(".jpg", gray, [cv2.IMWRITE_JPEG_QUALITY, 35])
assert ok
jpg = bytearray(jpg.tobytes())
# En-tête JFIF : unités = 1 (points par pouce), densité 100 x 100.
assert jpg[2:4] == b"\xff\xe0" and jpg[6:10] == b"JFIF"
jpg[13] = 1
jpg[14:16] = struct.pack(">H", 100)
jpg[16:18] = struct.pack(">H", 100)
open(f"{out}/scan_fr_100dpi.jpg", "wb").write(bytes(jpg))

doc = pymupdf.open()
a3 = pymupdf.paper_rect("a3-l")
page = doc.new_page(width=a3.width, height=a3.height)
page.insert_image(page.rect, stream=bytes(jpg))
doc.save(f"{out}/scan_only_A3.pdf", garbage=4, deflate=True)
print("ok", w, h)
