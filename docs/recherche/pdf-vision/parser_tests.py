#!/usr/bin/env python
"""parser_tests.py - unit tests of the text parsers on strings the way FR/DE/LU offices write them."""
import analyze as A
T = lambda s: {"s": s, "cx": 0, "cy": 0, "size": 8, "angle": 0, "x0": 0, "x1": 10, "y0": 0, "y1": 8}
scale_cases = [("Échelle 1:100", [100]), ("ECHELLE : 1/50", [50]), ("Ech. 1/100e", [100]), ("Éch: 1/50ème", [50]),
               ("Maßstab 1:50", [50]), ("Massstab 1 : 200", [200]), ("M 1:100", [100]), ("M. 1:50", [50]), ("M=1:20", [20]),
               ("Plans 1:100 / Détails 1:20", [100, 20]), ("Date 1/12/2024", []), ("11:50", []), ("Index 1.50", []),
               ("1:100 (A3)", [100]), ("Echelle l:100", [100]), ("Maßstab 1:5O", [50]), ("ECH 1/75", [75]), ("1:33", [])]
ok = 0
for s, want in scale_cases:
    got = sorted(c["den"] for c in A.scale_from_text([T(s)]))
    good = got == sorted(want)
    ok += good
    if not good: print(f"  SCALE FAIL {s!r}: got {got} want {want}")
print(f"scale regex: {ok}/{len(scale_cases)} cases")
area_cases = [("32,45 m²", 32.45), ("28.10 m2", 28.10), ("S = 7,89 m²", 7.89), ("A: 3,92 m²", 3.92), ("13,71 qm", 13.71),
              ("NGF 7,74 m²", 7.74), ("SH: 12,5m²", 12.5), ("17 m²", 17.0), ("ca. 24 m2", 24.0), ("HSP 2,50 m", None),
              ("3,50 m", None), ("Fl. 21,30 m ²", 21.30), ("WF 18,25", None), ("45.2m2", 45.2), ("1 234,50 m²", 1234.5), ("12,27m2", 12.27)]
ok = 0
for s, want in area_cases:
    m = A.AREA_RE.search(s)
    got = float(m.group(1).replace(",", ".")) if m else None
    good = got == want
    ok += good
    if not good: print(f"  AREA FAIL {s!r}: got {got} want {want}")
print(f"area regex: {ok}/{len(area_cases)} cases")
room_cases = [("Séjour", "H"), ("Wohnzimmer", "H"), ("SdB", "H"), ("Chambre 1", "H"), ("Küche", "H"), ("Garage", "U"), ("Cave / Keller", "U"),
              ("Salle de bains", "H"), ("Wohnen/Essen", "H"), ("Kinderzimmer 2", "H"), ("Bad", "H"), ("Grenier", "U"), ("Speicher", "U"),
              ("Buanderie", "A"), ("Technik", "A"), ("Local technique", "A"), ("Abstellraum", "A"), ("Terrasse", "X"), ("Balkon", "X"),
              ("Hobbyraum", "A"), ("Cellier", "A"), ("Dégagement", "H"), ("Flur", "H"), ("Combles non aménagés", "U"), ("HWR", "A"),
              ("Chaufferie", "A"), ("Carport", "U"), ("Cage d'escalier", "A"), ("Treppenhaus", "A"), ("Kellerflur", "U"),
              ("Cave à vin", "U"), ("Salle de jeux", "H"), ("Schlafen", "H"), ("WC", "H"), ("Badewanne", None), ("Stuff", "H"),
              ("Kachen", "H"), ("Wintergarten", "A"), ("Vide sur séjour", None), ("Garagentor", None), ("Chambre froide", "U")]
ok = 0
for s, want in room_cases:
    typ, got = A.classify_room(s)
    good = got == want
    ok += good
    if not good: print(f"  ROOM FAIL {s!r}: got {got} ({typ}) want {want}")
print(f"room vocabulary: {ok}/{len(room_cases)} cases")
