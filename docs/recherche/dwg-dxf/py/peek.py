"""Peek at layers / texts / inserts / extents of a DXF (ezdxf). usage: python -I peek.py file.dxf"""
import sys
from collections import Counter, defaultdict
import ezdxf
from ezdxf import recover, bbox

path = sys.argv[1]
try:
    doc = ezdxf.readfile(path)
except Exception:
    doc, _ = recover.readfile(path)
msp = doc.modelspace()
per_layer = defaultdict(Counter)
for e in msp:
    per_layer[e.dxf.layer][e.dxftype()] += 1
print("LAYERS (entities in modelspace):")
for name, c in sorted(per_layer.items(), key=lambda kv: -sum(kv[1].values())):
    print(f"  {name!r:40} {dict(c)}")
print("unused layers:", [l.dxf.name for l in doc.layers if l.dxf.name not in per_layer])
print("TEXTS:")
n = 0
for t in msp.query("TEXT MTEXT"):
    s = t.plain_text() if t.dxftype() == "MTEXT" else t.dxf.text
    h = t.dxf.char_height if t.dxftype() == "MTEXT" else t.dxf.height
    print(f"  [{t.dxf.layer}] h={h:.1f} {s!r}"[:140])
    n += 1
    if n > int(sys.argv[2]) if len(sys.argv) > 2 else n > 60:
        print("  ..."); break
print("INSERTS:", Counter(i.dxf.name for i in msp.query("INSERT")))
ext = bbox.extents(msp, fast=True)
print("extents:", ext.extmin, ext.extmax, "size:", ext.size if ext.has_data else None)
print("header EXTMIN/EXTMAX:", doc.header.get("$EXTMIN"), doc.header.get("$EXTMAX"))
dims = msp.query("DIMENSION")
vals = []
for d in dims[:8]:
    vals.append((d.dimtype & 7, round(d.dxf.get("actual_measurement", -1), 2), d.dxf.get("text", "")))
print("DIMENSIONS (type, actual_measurement, text override):", vals)
print("closed LWPOLYLINE:", sum(1 for p in msp.query("LWPOLYLINE") if p.closed), "/", len(msp.query("LWPOLYLINE")))
