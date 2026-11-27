#!/usr/bin/env python3
"""
recon_windows.py - 10-minute reconnaissance of an installed LuxEeB-Tool on Windows.

STATUS: **UNTESTED**. Written in a Linux sandbox where the vendor site (luxeeb.lu) was blocked and no
Windows/Excel was available. Treat it as a checklist in code form; expect to fix small things on first run.

It answers the questions the web research could NOT answer:
  Q1  Is LuxEeB-Tool 6.x still an Excel/VBA workbook, or a standalone executable?
  Q2  Which files does it install (workbook? exe? dll? catalogues? templates?) and what are they (magic bytes)?
  Q3  What does a saved project look like (extension, text/binary)?  -> also run sniff_project_file.py on it
  Q4  Is the UI reachable through UI Automation (named controls) or only as an opaque grid/canvas?
  Q5  If Excel-hosted: which worksheets exist, are they protected, are there named ranges (stable anchors)?

It is strictly READ-ONLY: it lists files, reads window/control metadata and worksheet NAMES. It does not
unprotect sheets, does not read the VBA project, does not touch license.dat. Do not extend it to bypass
workbook/VBA protection - that is outside what the licence can be assumed to allow.

Setup (PowerShell):
    py -m venv .venv ; .venv\\Scripts\\pip install pywinauto pywin32 psutil
    # start LuxEeB-Tool by hand (demo mode: the ministry page says the demo password is "demo"), open any project
    .venv\\Scripts\\python recon_windows.py "C:\\Program Files (x86)\\LuxEeB-Tool" > recon.json
"""
import json
import os
import sys

MAGIC = {b"PK\x03\x04": "zip/ooxml", b"\xd0\xcf\x11\xe0": "ole2 (xls/xla/doc)", b"MZ": "exe/dll",
         b"SQLite format 3": "sqlite", b"%PDF": "pdf", b"<?xml": "xml"}


def list_install_dir(root):
    rows = []
    for dp, _dn, fns in os.walk(root):
        for fn in fns:
            p = os.path.join(dp, fn)
            try:
                with open(p, "rb") as fh:
                    head = fh.read(16)
                kind = next((v for k, v in MAGIC.items() if head.startswith(k)), "text/other")
                rows.append({"path": os.path.relpath(p, root), "size": os.path.getsize(p), "kind": kind})
            except OSError as e:
                rows.append({"path": os.path.relpath(p, root), "error": str(e)})
    return rows


def find_windows():
    """Top-level windows whose title or owning process looks like LuxEeB / Excel."""
    import psutil
    from pywinauto import Desktop
    hits = []
    for w in Desktop(backend="uia").windows():
        try:
            pid = w.process_id()
            pname = psutil.Process(pid).name()
            title = w.window_text()
        except Exception:
            continue
        if "luxeeb" in title.lower() or "luxeeb" in pname.lower() or pname.lower() == "excel.exe":
            hits.append((w, pid, pname, title))
    return hits


def dump_uia(wrapper, depth=0, max_depth=6, budget=None):
    """Compact UIA tree: control type, name, automation id, class. Budget caps the number of nodes."""
    budget = budget if budget is not None else [1500]
    if budget[0] <= 0 or depth > max_depth:
        return None
    budget[0] -= 1
    info = wrapper.element_info
    node = {"type": info.control_type, "name": (info.name or "")[:80], "auto_id": info.automation_id,
            "class": info.class_name}
    kids = []
    try:
        for ch in wrapper.children():
            sub = dump_uia(ch, depth + 1, max_depth, budget)
            if sub:
                kids.append(sub)
    except Exception as e:  # some Office panes throw on enumeration
        node["children_error"] = str(e)[:120]
    if kids:
        node["children"] = kids
    return node


def excel_com_overview():
    """If the tool is hosted in Excel, COM gives far more stable anchors than UIA. Names only, read-only."""
    try:
        import win32com.client
        xl = win32com.client.GetActiveObject("Excel.Application")
    except Exception as e:
        return {"excel_running": False, "detail": str(e)[:200]}
    out = {"excel_running": True, "version": xl.Version, "workbooks": []}
    for wb in xl.Workbooks:
        try:
            names = [n.Name for n in wb.Names][:400]
        except Exception:
            names = ["<not readable>"]
        out["workbooks"].append({
            "name": wb.Name, "path": wb.Path, "has_vba": bool(wb.HasVBProject), "structure_protected": bool(wb.ProtectStructure),
            "sheets": [{"name": sh.Name, "visible": int(sh.Visible), "protected": bool(getattr(sh, "ProtectContents", False))}
                       for sh in wb.Sheets],
            "defined_names_sample": names,
        })
    return out


def main():
    report = {}
    if len(sys.argv) > 1:
        report["install_dir"] = list_install_dir(sys.argv[1])
    try:
        wins = find_windows()
        report["windows"] = [{"pid": pid, "process": pname, "title": title} for _w, pid, pname, title in wins]
        report["Q1_hosted_in_excel"] = any(p.lower() == "excel.exe" for _w, _pid, p, _t in wins)
        report["uia_trees"] = [dump_uia(w) for w, *_ in wins[:2]]
    except Exception as e:
        report["uia_error"] = repr(e)
    report["excel_com"] = excel_com_overview()
    json.dump(report, sys.stdout, indent=1, ensure_ascii=False, default=str)


if __name__ == "__main__":
    main()
