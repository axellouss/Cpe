#!/usr/bin/env python
"""make_cad_plot.py - (1) DXF -> PDF through ezdxf's drawing add-on (PyMuPDF backend): a real CAD->PDF plot path.
Shows what happens to TEXT / DIMENSION entities (they become filled outlines => no extractable text).
(2) a tiny PDF with Optional Content Groups (PDF layers, like AutoCAD 'DWG To PDF' with layer info) to check
that layer names survive and can be read with PyMuPDF and pdf.js."""
import ezdxf, pymupdf
from ezdxf.addons.drawing import Frontend, RenderContext, layout, pymupdf as ez_pymupdf
from ezdxf.addons.drawing.config import Configuration

doc = ezdxf.new("R2018", setup=True)
doc.units = ezdxf.units.M
msp = doc.modelspace()
doc.layers.add("A-WALL", color=7, lineweight=50)
doc.layers.add("A-TEXT", color=7)
doc.layers.add("A-DIMS", color=1)
W, D, T = 10.0, 8.5, 0.40
msp.add_lwpolyline([(0, 0), (W, 0), (W, D), (0, D)], close=True, dxfattribs={"layer": "A-WALL"})
msp.add_lwpolyline([(T, T), (W - T, T), (W - T, D - T), (T, D - T)], close=True, dxfattribs={"layer": "A-WALL"})
msp.add_text("Séjour", height=0.25, dxfattribs={"layer": "A-TEXT"}).set_placement((4.2, 4.6))
msp.add_text("70,84 m²", height=0.20, dxfattribs={"layer": "A-TEXT"}).set_placement((4.2, 4.2))
msp.add_text("Échelle 1:100", height=0.30, dxfattribs={"layer": "A-TEXT"}).set_placement((6.5, -3.0))
dim = msp.add_linear_dim(base=(0, -1.2), p1=(0, 0), p2=(W, 0), dimstyle="EZDXF", override={"dimtxt": 0.2, "dimasz": 0.15, "dimlfac": 100, "dimdec": 0}, dxfattribs={"layer": "A-DIMS"})
dim.render()
dim = msp.add_linear_dim(base=(-1.2, 0), p1=(0, 0), p2=(0, D), angle=90, dimstyle="EZDXF", override={"dimtxt": 0.2, "dimasz": 0.15, "dimlfac": 100, "dimdec": 0}, dxfattribs={"layer": "A-DIMS"})
dim.render()
doc.saveas("fixtures/cad_plot.dxf")
ctx = RenderContext(doc)
backend = ez_pymupdf.PyMuPdfBackend()
Frontend(ctx, backend, config=Configuration(background_policy=ezdxf.addons.drawing.config.BackgroundPolicy.WHITE)).draw_layout(msp)
page = layout.Page(420, 297, layout.Units.mm, margins=layout.Margins.all(20))
pdf_bytes = backend.get_pdf_bytes(page, settings=layout.Settings(scale=10.0))  # 1 m (drawing unit) -> 10 mm  = 1:100
open("fixtures/cad_plot_ezdxf.pdf", "wb").write(pdf_bytes)
d = pymupdf.open("fixtures/cad_plot_ezdxf.pdf")
pg = d[0]
dr = pg.get_drawings()
print("ezdxf->PDF: page", pg.rect, "| text spans:", len(pg.get_text("words")), "| drawings:", len(dr),
      "| filled paths (glyph outlines):", sum(1 for x in dr if x.get("fill") is not None and x.get("color") is None),
      "| stroke widths:", sorted({round(x.get('width') or 0, 2) for x in dr}), "| layers:", sorted({str(x.get('layer')) for x in dr}))

# (2) OCG / PDF layers
d2 = pymupdf.open()
p2 = d2.new_page(width=400, height=300)
oc_w = d2.add_ocg("A-WALL (Murs)")
oc_d = d2.add_ocg("A-DIMS (Cotes)")
sh = p2.new_shape(); sh.draw_rect(pymupdf.Rect(50, 50, 300, 200)); sh.finish(color=(0, 0, 0), width=1.4, oc=oc_w); sh.commit()
sh = p2.new_shape(); sh.draw_line((50, 230), (300, 230)); sh.finish(color=(0, 0, 0), width=0.3, oc=oc_d); sh.commit()
p2.insert_text((150, 225), "1000", fontsize=6, oc=oc_d)
d2.save("fixtures/layers_ocg.pdf")
d3 = pymupdf.open("fixtures/layers_ocg.pdf")
print("OCG PDF via PyMuPDF: ocgs =", {k: v["name"] for k, v in d3.get_ocgs().items()}, "| drawings layers =", [(x["layer"], round(x["width"], 2)) for x in d3[0].get_drawings()])
