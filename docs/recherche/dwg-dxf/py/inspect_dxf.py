"""Spike: load DXF files with ezdxf (normal reader, falling back to the recover reader) and summarise them.
usage: python -I inspect_dxf.py file1.dxf file2.dxf ...   (set SAMPLE=1 to print example entities)
"""
import os
import sys
import time
from collections import Counter

import ezdxf
from ezdxf import recover


def load(path):
    t0 = time.perf_counter()
    mode = "readfile"
    try:
        doc = ezdxf.readfile(path)
        auditor = None
    except Exception as e1:  # structural problems or encoding trouble -> recover mode
        mode = f"recover (readfile failed: {type(e1).__name__}: {str(e1)[:80]})"
        doc, auditor = recover.readfile(path)
    return doc, auditor, mode, time.perf_counter() - t0


def summarize(path):
    try:
        doc, auditor, mode, dt = load(path)
    except Exception as e:
        print(f"{os.path.basename(path)}: FAILED {type(e).__name__}: {str(e)[:200]}")
        return
    msp = doc.modelspace()
    counts = Counter(e.dxftype() for e in msp)
    hdr = doc.header
    info = {
        "ver": doc.dxfversion,
        "INSUNITS": hdr.get("$INSUNITS"),
        "MEASUREMENT": hdr.get("$MEASUREMENT"),
        "LUNITS": hdr.get("$LUNITS"),
        "DIMSCALE": hdr.get("$DIMSCALE"),
        "layers": len(doc.layers),
        "blocks": len(doc.blocks),
        "layouts": doc.layout_names(),
        "msp_entities": len(msp),
    }
    print(f"\n=== {os.path.basename(path)} [{mode}] {dt*1000:.0f} ms")
    print("  ", info)
    print("  ", dict(counts))
    if auditor is not None:
        print(f"   recover: {len(auditor.errors)} errors, {len(auditor.fixes)} fixes")
    if os.environ.get("SAMPLE"):
        for ins in msp.query("INSERT"):
            print("   INSERT", ins.dxf.name, tuple(round(v, 2) for v in ins.dxf.insert), "attribs:",
                  [(a.dxf.tag, a.dxf.text) for a in ins.attribs])
            break
        for d in msp.query("DIMENSION"):
            try:
                m = d.get_measurement()
            except Exception as e:
                m = f"ERR {e}"
            print("   DIMENSION type", d.dimtype, "stored actual_measurement:", d.dxf.get("actual_measurement"), "computed:", m,
                  "text override:", repr(d.dxf.get("text")))
            break
        for h in msp.query("HATCH"):
            print("   HATCH", h.dxf.pattern_name, "paths:", len(h.paths), [type(p).__name__ for p in h.paths])
            break
        for t in msp.query("TEXT MTEXT"):
            print("   ", t.dxftype(), repr(t.plain_text() if t.dxftype() == "MTEXT" else t.dxf.text)[:80])


if __name__ == "__main__":
    for p in sys.argv[1:]:
        summarize(p)
