"""ezdwg: native read API + stricter to_dxf options. usage: python -I t_ezdwg2.py <outdir> files..."""
import os, sys, time
from collections import Counter
import ezdwg, ezdxf
from ezdxf import recover
outdir = sys.argv[1]
doc = ezdwg.read(sys.argv[2])
msp = doc.modelspace()
print("Document attrs:", [n for n in dir(doc) if not n.startswith("_")])
print("Layout attrs:", [n for n in dir(msp) if not n.startswith("_")])
for path in sys.argv[2:]:
    name = os.path.basename(path)
    t0 = time.perf_counter()
    doc = ezdwg.read(path)
    msp = doc.modelspace()
    ents = list(msp.query()) if hasattr(msp, "query") else []
    dt = time.perf_counter() - t0
    c = Counter(e.dxftype for e in ents)
    print(f"\n=== {name}: native read {dt*1000:.0f} ms version={getattr(doc,'version',None)} n={len(ents)} {dict(c)}"[:700])
    for T in ("INSERT", "DIMENSION", "HATCH"):
        for e in ents:
            if e.dxftype == T:
                print(f"   {T}: layer={getattr(e,'layer',None)!r} dxf={str(getattr(e,'dxf',None))[:420]}")
                break
    try:
        hdr = getattr(doc, "header", None)
        print("   header:", str(hdr)[:300])
    except Exception as ex:
        print("   header ERR", ex)
    out = os.path.join(outdir, name.replace(".dwg", ".ezdwg2.dxf"))
    t0 = time.perf_counter()
    try:
        ezdwg.to_dxf(path, out, explode_dimensions=False, modelspace_only=True, include_unsupported=True)
        dt = time.perf_counter() - t0
        try:
            d2 = ezdxf.readfile(out); mode = "readfile"
        except Exception as e1:
            d2, aud = recover.readfile(out); mode = f"recover({type(e1).__name__})"
        c2 = Counter(e.dxftype() for e in d2.modelspace())
        print(f"   to_dxf(explode_dimensions=False, modelspace_only=True) {dt*1000:.0f} ms; ezdxf {mode}: INSUNITS={d2.header.get('$INSUNITS')} n={sum(c2.values())} {dict(c2)}"[:700])
    except Exception as e:
        print(f"   to_dxf FAILED {type(e).__name__}: {str(e)[:300]}")
