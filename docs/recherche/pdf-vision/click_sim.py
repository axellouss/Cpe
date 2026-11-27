#!/usr/bin/env python
"""click_sim.py - Monte-Carlo of the human-in-the-loop raster tier.
User actions simulated:  (1) calibrate: click the 2 ends of ONE known dimension  (2) trace the heated outline polygon.
Each click = true position + isotropic Gaussian error sigma (pixels).  Output: area error (%), mean |err| and P95.
Not simulated (add on top!): paper/scan distortion, perspective of photos, tracing the wrong wall face.
"""
import numpy as np
rng = np.random.default_rng(42)
N = 20000

def area(P):  # P: (N, k, 2)
    x, y = P[..., 0], P[..., 1]
    return 0.5 * np.abs(np.sum(x * np.roll(y, -1, axis=-1) - np.roll(x, -1, axis=-1) * y, axis=-1))

shapes = {
    "rectangle 10 x 8.5 m (4 clicks)": [(0, 0), (10, 0), (10, 8.5), (0, 8.5)],
    "L-shape house+annex (6 clicks)": [(0, 0), (13.5, 0), (13.5, 6), (10, 6), (10, 8.5), (0, 8.5)],
    "12-vertex villa (12 clicks)": [(0, 0), (6, 0), (6, -1.5), (10, -1.5), (10, 0), (14, 0), (14, 7), (11, 7), (11, 10), (4, 10), (4, 8), (0, 8)],
}
print(f"{'case':46s} {'px/m':>6s} {'sigma':>5s} {'calib L':>8s} | {'calib only':>16s} | {'trace only':>16s} | {'both':>16s}   (mean|err| % / P95 %)")
for label, ppm in (("1:100 @ 100 dpi", 39.4), ("1:100 @ 150 dpi", 59.1), ("1:100 @ 300 dpi", 118.1), ("1:50  @ 150 dpi", 118.1), ("1:200 @ 150 dpi", 29.5)):
    for sigma in (0.7, 2.0, 5.0):
        for Lm in (13.5, 5.0, 1.0):
            if (sigma, Lm) not in ((0.7, 13.5), (2.0, 13.5), (2.0, 5.0), (2.0, 1.0), (5.0, 13.5), (5.0, 1.0)):
                continue
            name = "L-shape house+annex (6 clicks)"
            V = np.array(shapes[name]) * ppm
            A0 = area(V[None])[0]
            Lpx = Lm * ppm
            a = np.array([0, 0]) + rng.normal(0, sigma, (N, 2)); b = np.array([Lpx, 0]) + rng.normal(0, sigma, (N, 2))
            k = Lpx / np.hypot(*(b - a).T)  # scale factor error (1 = perfect)
            e_cal = (k ** 2 - 1) * 100
            Vn = V[None] + rng.normal(0, sigma, (N, len(V), 2))
            e_tr = (area(Vn) / A0 - 1) * 100
            e_both = (area(Vn) * k ** 2 / A0 - 1) * 100
            f = lambda e: f"{np.mean(np.abs(e)):6.2f} / {np.percentile(np.abs(e), 95):6.2f}"
            print(f"{label + ', ' + name[:20]:46s} {ppm:6.1f} {sigma:5.1f} {Lm:7.1f}m | {f(e_cal)} | {f(e_tr)} | {f(e_both)}")
print()
ppm, sigma = 59.1, 2.0
for name, pts in shapes.items():
    V = np.array(pts) * ppm; A0 = area(V[None])[0]
    Vn = V[None] + rng.normal(0, sigma, (N, len(V), 2))
    e = (area(Vn) / A0 - 1) * 100
    print(f"trace only, 1:100 @ 150 dpi, sigma 2 px, {name:34s}: mean|err| {np.mean(np.abs(e)):.2f} %  P95 {np.percentile(np.abs(e), 95):.2f} %")
# systematic errors, for scale
print()
A = 10 * 8.5
print(f"tracing the INNER wall face instead of the outer (40 cm walls): {((10 - .8) * (8.5 - .8) / A - 1) * 100:+.1f} % area")
print(f"tracing the wall AXIS instead of the outer face:               {((10 - .4) * (8.5 - .4) / A - 1) * 100:+.1f} % area")
for d in (0.5, 1.0, 2.0):
    print(f"uniform paper/scan/copy scaling error of {d:.1f} % in length -> {((1 + d / 100) ** 2 - 1) * 100:+.2f} % area")
print(f"'fit to page' A3 -> A4 print taken at its nominal scale (x0.7071): {(0.7071 ** 2 - 1) * 100:+.1f} % area")
