#!/bin/bash
# run_all.sh - regenerate fixtures, extract with the 3 backends, analyse, print the EVAL rows side by side
cd "$(dirname "$0")"
PY=.venv/bin/python
$PY make_fixtures.py > /dev/null
mkdir -p ir out
for f in fr_A3_1-100 de_A3_1-50; do
  $PY extract_py.py fixtures/$f.pdf pymupdf ir/$f.pymupdf.json > /dev/null 2>&1
  $PY extract_py.py fixtures/$f.pdf pdfplumber ir/$f.pdfplumber.json > /dev/null 2>&1
  node extract_pdfjs.mjs fixtures/$f.pdf ir/$f.pdfjs.json > /dev/null 2>&1
  for b in pymupdf pdfplumber pdfjs; do
    $PY analyze.py ir/$f.$b.json fixtures/$f.truth.json > out/$f.$b.txt 2>&1
  done
done
