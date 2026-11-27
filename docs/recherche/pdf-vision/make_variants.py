#!/usr/bin/env python
"""make_variants.py - derived fixtures that emulate real-world accidents.
  fr_A4_fit.pdf      the 1:100 A3 sheet "printed to fit" on A4 (x0.7071): title block still says 1:100, truth 1:141.4
                     (the page becomes a Form XObject -> also tests XObject/CTM handling of the extractors)
  fr_A3_rot90.pdf    same sheet with /Rotate 90 (plotter drivers do this all the time)
"""
import pymupdf
src = pymupdf.open("fixtures/fr_A3_1-100.pdf")
# 1) fit to A4 landscape
out = pymupdf.open()
a4 = pymupdf.paper_rect("a4-l")
pg = out.new_page(width=a4.width, height=a4.height)
pg.show_pdf_page(pg.rect, src, 0)
out.save("fixtures/fr_A4_fit.pdf")
print("A4 fit factor", a4.width / src[0].rect.width, a4.height / src[0].rect.height)
# 2) /Rotate 90
src2 = pymupdf.open("fixtures/fr_A3_1-100.pdf")
src2[0].set_rotation(90)
src2.save("fixtures/fr_A3_rot90.pdf")
