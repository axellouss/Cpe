#!/usr/bin/env python
"""perf_test.py - a 'heavy' sheet: A1, 200 000 separate stroked segments (hatching) + 3 000 text runs."""
import random, time
from reportlab.pdfgen import canvas
from reportlab.lib.units import mm
random.seed(3)
W, H = 841 * mm, 594 * mm
c = canvas.Canvas("fixtures/heavy_A1.pdf", pagesize=(W, H), pageCompression=1)
c.setLineWidth(0.25)
for i in range(200_000):
    x, y = random.uniform(20, W - 20), random.uniform(20, H - 20)
    c.line(x, y, x + random.uniform(-15, 15), y + random.uniform(-15, 15))
c.setFont("Helvetica", 6)
for i in range(3000):
    c.drawString(random.uniform(20, W - 60), random.uniform(20, H - 20), f"{random.randint(10, 999)}")
c.save()
