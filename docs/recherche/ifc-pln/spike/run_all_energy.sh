#!/bin/bash
# runs the geometry first-cut on every sample; one log + json per file
cd "$(dirname "$0")/.."
for f in AC20-FZK-Haus AC11-FZK-Haus-IFC AC9R1-Haus-G-H-Ver2-2x3 Ifc2x3_Duplex_Architecture SampleHouse4 Ifc4_Revit_ARC AC11-Institute-Var-2-IFC BasicHouse AdvancedProject; do
  s=$(date +%s.%N)
  timeout 1500 ./venv/bin/python -I spike/energy_quantities.py samples/$f.ifc --json out/$f.energy.json > out/$f.energy.txt 2> out/$f.energy.err
  echo "$f exit=$? wall=$(echo "$(date +%s.%N) - $s" | bc)s" >> out/run_all_energy.log
done
echo DONE >> out/run_all_energy.log
