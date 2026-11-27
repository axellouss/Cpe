#!/usr/bin/env python3
"""
sniff_project_file.py - first-contact analysis of an UNKNOWN project file
(LuxEeB-Tool project/register ".txt", Lesosai ".bld", Excel workbook, ...).

Purpose: the format of the LuxEeB-Tool project file is NOT publicly documented and could not
be inspected in the research sandbox (vendor host blocked). Run this on a Windows PC that has
LuxEeB-Tool installed, on (a) a project saved from the tool in demo mode and (b) the file that
is uploaded to the register, and send back the JSON. Pure stdlib, read-only, cross-platform.

Usage:
    python sniff_project_file.py FILE [FILE ...]      # prints JSON report
    python sniff_project_file.py --selftest           # runs on synthetic samples

What it answers:
  - container: zip / OLE2 (xls, VBA-protected workbooks) / sqlite / xml / json / gzip / pdf / text / binary
  - for text: encoding (BOM, utf-8, utf-16, cp1252 fallback), newline style, delimiter guess,
    "key=value" / INI / tabular shape, decimal comma vs point, number of lines, sample lines
  - entropy (high entropy => compressed or encrypted => not hand-writable)
  - for zip: member list (xlsx/xlsm/docx-like detection, vbaProject.bin presence)
"""
import collections
import io
import json
import math
import re
import sys
import zipfile

MAGICS = [
    (b"PK\x03\x04", "zip"),
    (b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1", "ole2 (xls / doc / msi / password-protected OOXML)"),
    (b"SQLite format 3\x00", "sqlite3"),
    (b"\x1f\x8b", "gzip"),
    (b"%PDF", "pdf"),
    (b"MZ", "windows-executable (exe/dll)"),
    (b"\x00\x01\x00\x00Standard Jet DB", "ms-access mdb (Jet)"),
    (b"\x00\x01\x00\x00Standard ACE DB", "ms-access accdb (ACE)"),
    (b"7z\xbc\xaf\x27\x1c", "7zip"),
    (b"Rar!", "rar"),
]


def entropy(b: bytes) -> float:
    if not b:
        return 0.0
    c = collections.Counter(b)
    n = len(b)
    return -sum(v / n * math.log2(v / n) for v in c.values())


def decode_text(raw: bytes):
    """Return (text, encoding) or (None, None) if it does not look like text."""
    for bom, enc in ((b"\xef\xbb\xbf", "utf-8-sig"), (b"\xff\xfe", "utf-16-le"), (b"\xfe\xff", "utf-16-be")):
        if raw.startswith(bom):
            try:
                return raw.decode("utf-16" if enc.startswith("utf-16") else enc), enc + " (BOM)"
            except UnicodeDecodeError:
                pass
    # UTF-16 without BOM: every second byte is NUL for latin text
    if len(raw) >= 8 and raw[1:64:2].count(0) > 24:
        try:
            return raw.decode("utf-16-le"), "utf-16-le (no BOM, guessed)"
        except UnicodeDecodeError:
            pass
    ctrl = sum(1 for x in raw[:4096] if x < 9 or (13 < x < 32))
    if ctrl > max(2, len(raw[:4096]) // 100):
        return None, None
    try:
        return raw.decode("utf-8"), "utf-8" if any(x > 127 for x in raw) else "ascii"
    except UnicodeDecodeError:
        return raw.decode("cp1252", errors="replace"), "cp1252 (fallback; typical for VBA 'Print #' output on FR/DE Windows)"


def analyse_text(text: str) -> dict:
    lines = text.splitlines()
    nonempty = [ln for ln in lines if ln.strip()]
    rep = {
        "lines": len(lines),
        "newline": "CRLF" if "\r\n" in text else ("LF" if "\n" in text else "none/CR"),
        "first_lines": lines[:15],
        "last_lines": lines[-3:],
    }
    # delimiter guess: the candidate with the most stable, non-zero count per line
    best = None
    for name, d in (("tab", "\t"), ("semicolon", ";"), ("pipe", "|"), ("comma", ",")):
        counts = [ln.count(d) for ln in nonempty[:500]]
        if not counts or max(counts) == 0:
            continue
        mode, freq = collections.Counter(counts).most_common(1)[0]
        score = (freq / len(counts)) * (1 if mode > 0 else 0)
        if best is None or score > best[1]:
            best = (name, score, mode)
    if best:
        rep["delimiter_guess"] = {"delimiter": best[0], "share_of_lines_with_modal_count": round(best[1], 2),
                                  "modal_fields_per_line": best[2] + 1}
    kv = sum(1 for ln in nonempty if re.match(r"^\s*[^=\s][^=]{0,80}=", ln))
    sect = sum(1 for ln in nonempty if re.match(r"^\s*\[[^\]]+\]\s*$", ln))
    rep["key_value_lines_share"] = round(kv / max(1, len(nonempty)), 2)
    rep["ini_sections"] = sect
    rep["looks_like"] = ("xml" if text.lstrip().startswith("<") else
                         "json" if text.lstrip()[:1] in "{[" else
                         "ini/key=value" if rep["key_value_lines_share"] > 0.6 else
                         "delimited table" if best and best[1] > 0.6 else "free text / one value per line")
    rep["decimal_comma_numbers"] = len(re.findall(r"(?<![\d.])\d+,\d+(?![\d.])", text[:200000]))
    rep["decimal_point_numbers"] = len(re.findall(r"(?<![\d,])\d+\.\d+(?![\d,])", text[:200000]))
    # Excel-ish hints: cell addresses or sheet!range references => "dump of worksheet cells"
    rep["cell_address_tokens"] = len(re.findall(r"\b\$?[A-Z]{1,3}\$?\d{1,5}\b", text[:200000]))
    rep["hex_or_base64_blob_lines"] = sum(1 for ln in nonempty[:2000] if re.fullmatch(r"[A-Za-z0-9+/=]{60,}", ln.strip()))
    return rep


def sniff(raw: bytes, name: str = "") -> dict:
    rep = {"name": name, "size": len(raw), "entropy_bits_per_byte": round(entropy(raw[:1 << 20]), 3),
           "head_hex": raw[:16].hex(" ")}
    for magic, label in MAGICS:
        if raw.startswith(magic):
            rep["container"] = label
            break
    if rep.get("container") == "zip":
        try:
            with zipfile.ZipFile(io.BytesIO(raw)) as z:
                names = z.namelist()
            rep["zip_members"] = names[:60]
            rep["zip_kind"] = ("xlsm/xlsb with VBA" if any("vbaProject.bin" in n for n in names) else
                               "xlsx" if any(n.startswith("xl/") for n in names) else
                               "docx" if any(n.startswith("word/") for n in names) else "generic zip")
        except zipfile.BadZipFile as e:
            rep["zip_error"] = str(e)
        return rep
    if "container" in rep:
        return rep
    text, enc = decode_text(raw)
    if text is None:
        rep["container"] = "binary (unknown)"
        rep["printable_strings_sample"] = [s.decode("latin-1") for s in re.findall(rb"[\x20-\x7e]{6,}", raw[:65536])[:20]]
        rep["verdict"] = ("high entropy: compressed or encrypted - do not try to write it by hand"
                          if rep["entropy_bits_per_byte"] > 7.5 else "structured binary - needs reverse engineering")
        return rep
    rep["container"] = "text"
    rep["encoding"] = enc
    rep.update(analyse_text(text))
    rep["verdict"] = ("plain text - a third-party writer is technically plausible; next step = diff two saves that "
                      "differ by exactly one input to map fields" if rep["hex_or_base64_blob_lines"] == 0 else
                      "text wrapper around encoded blobs - check for checksum/signature lines")
    return rep


def selftest() -> int:
    import os
    import sqlite3
    import tempfile
    samples = {}
    samples["kv_cp1252.txt"] = "Projekt=Musterhaus\r\nStraße=Hauptstraße 1\r\nAn=152,4\r\nVe=612,0\r\n".encode("cp1252")
    samples["tab_table.txt"] = "".join(f"Wand{i}\tS\t{12.5 + i}\t0.24\r\n" for i in range(40)).encode("ascii")
    samples["utf16.txt"] = "﻿Nom;Surface;U\r\nMur nord;12,5;0,24\r\n".encode("utf-16-le")
    samples["doc.xml"] = b'<?xml version="1.0" encoding="UTF-8"?><building><wall u="0.24"/></building>'
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("xl/workbook.xml", "<workbook/>")
        z.writestr("xl/vbaProject.bin", b"\x00" * 16)
    samples["tool.xlsm"] = buf.getvalue()
    samples["legacy.xls"] = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\x00" * 504
    samples["random.bld"] = os.urandom(4096)
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "x.db")
        con = sqlite3.connect(p)
        con.execute("create table t(a)")
        con.commit()
        con.close()
        samples["db.sqlite"] = open(p, "rb").read()
    expect = {"kv_cp1252.txt": ("text", "ini/key=value"), "tab_table.txt": ("text", "delimited table"),
              "utf16.txt": ("text", "delimited table"), "doc.xml": ("text", "xml"),
              "tool.xlsm": ("zip", None), "legacy.xls": ("ole2", None), "random.bld": ("binary", None),
              "db.sqlite": ("sqlite3", None)}
    ok = True
    for name, raw in samples.items():
        r = sniff(raw, name)
        cont, kind = expect[name]
        good = r["container"].startswith(cont) and (kind is None or r.get("looks_like") == kind)
        ok &= good
        print(f"{'PASS' if good else 'FAIL'}  {name:16s} container={r['container']!r:55s} "
              f"looks_like={r.get('looks_like')!r} enc={r.get('encoding')!r} H={r['entropy_bits_per_byte']}")
    print("zip_kind for tool.xlsm:", sniff(samples["tool.xlsm"])["zip_kind"])
    print("decimal comma count in kv sample:", sniff(samples["kv_cp1252.txt"])["decimal_comma_numbers"])
    return 0 if ok else 1


if __name__ == "__main__":
    if len(sys.argv) == 2 and sys.argv[1] == "--selftest":
        sys.exit(selftest())
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    out = []
    for path in sys.argv[1:]:
        with open(path, "rb") as fh:
            out.append(sniff(fh.read(), path))
    json.dump(out, sys.stdout, indent=1, ensure_ascii=False)
    print()
