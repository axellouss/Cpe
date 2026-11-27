"""Render a DXF model space to PNG with ezdxf's drawing add-on (matplotlib backend). usage: python -I render_dxf.py in.dxf out.png [dpi]"""
import sys
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import ezdxf
from ezdxf import recover
from ezdxf.addons.drawing import Frontend, RenderContext
from ezdxf.addons.drawing.matplotlib import MatplotlibBackend
from ezdxf.addons.drawing.config import Configuration, BackgroundPolicy, ColorPolicy

src, dst = sys.argv[1], sys.argv[2]
dpi = int(sys.argv[3]) if len(sys.argv) > 3 else 110
try:
    doc = ezdxf.readfile(src)
except Exception:
    doc, _ = recover.readfile(src)
fig = plt.figure(figsize=(14, 9))
ax = fig.add_axes([0, 0, 1, 1])
ctx = RenderContext(doc)
cfg = Configuration(background_policy=BackgroundPolicy.WHITE, color_policy=ColorPolicy.BLACK)
Frontend(ctx, MatplotlibBackend(ax), config=cfg).draw_layout(doc.modelspace(), finalize=True)
fig.savefig(dst, dpi=dpi)
print("wrote", dst)
