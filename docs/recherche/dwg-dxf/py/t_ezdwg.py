"""Spike: read DWG in Python with ezdwg (MIT, Rust core) and convert DWG->DXF, then verify with ezdxf.
usage: python -I t_ezdwg.py <outdir> file1.dwg ...
"""
import os, sys, time, inspect
from collections import Counter
import ezdwg, ezdxf
from ezdxf import recover

outdir = sys.argv[1]
os.makedirs(outdir, exist_ok=True)
print("ezdwg", getattr(ezdwg, "__version__", "?"))
print("read sig:", inspect.signature(ezdwg.read))
print("to_dxf sig:", inspect.signature(ezdwg.to_dxf))
for path in sys.argv[2:]:
    name = os.path.basename(path)
    t0 = time.perf_counter()
    try:
        doc = ezdwg.read(path)
        msp = doc.modelspace()
        counts = Counter(e.dxftype for e in msp)
        dt = time.perf_counter() - t0
        print(f"\n=== {name}: read {dt*1000:.0f} ms version={getattr(doc,'version',None)} n={sum(counts.values())} {dict(counts)}"[:900])
    except Exception as e:
        print(f"\n=== {name}: read FAILED {type(e).__name__}: {str(e)[:200]}")
    out = os.path.join(outdir, name.replace(".dwg", ".ezdwg.dxf"))
    t0 = time.perf_counter()
    try:
        res = ezdwg.to_dxf(path, out)
        dt = time.perf_counter() - t0
        try:
            d2 = ezdxf.readfile(out); mode = "readfile"
        except Exception as e1:
            d2, aud = recover.readfile(out); mode = f"recover({type(e1).__name__})"
        c2 = Counter(e.dxftype() for e in d2.modelspace())
        print(f"    to_dxf {dt*1000:.0f} ms -> {os.path.getsize(out)} bytes; ezdxf {mode}: INSUNITS={d2.header.get('$INSUNITS')} MEAS={d2.header.get('$MEASUREMENT')} n={sum(c2.values())} {dict(c2)}"[:900])
    except Exception as e:
        print(f"    to_dxf FAILED {type(e).__name__}: {str(e)[:200]}")
