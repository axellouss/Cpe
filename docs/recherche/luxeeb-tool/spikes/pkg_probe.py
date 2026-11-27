"""Probe package registries for the Windows UI-automation / Excel-automation libraries
we would depend on. Records latest version, upload date, python requirement and OS classifiers.
Run:  python3 spikes/pkg_probe.py > out/pkg_probe.json
"""
import json, sys, urllib.request, ssl, os

PYPI = ["pywinauto", "pywin32", "comtypes", "uiautomation", "xlwings", "pyautogui",
        "openpyxl", "rapidocr-onnxruntime", "luxeeb", "lesosai", "robotframework-flaui", "pywinauto-recorder"]
NPM = ["@nut-tree/nut-js", "@nut-tree-fork/nut-js", "robotjs", "winax", "luxeeb"]
NUGET = ["flaui.core", "flaui.uia3", "flaui.uia2"]

ctx = ssl.create_default_context()
def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "pkg-probe/0.1"})
    with urllib.request.urlopen(req, timeout=30, context=ctx) as r:
        return json.load(r)

out = {"pypi": {}, "npm": {}, "nuget": {}}
for name in PYPI:
    try:
        d = get(f"https://pypi.org/pypi/{name}/json")
        info = d["info"]; ver = info["version"]
        files = d["releases"].get(ver, [])
        up = sorted(f["upload_time_iso_8601"] for f in files)[:1]
        out["pypi"][name] = {
            "latest": ver, "uploaded": up[0] if up else None,
            "requires_python": info.get("requires_python"),
            "os_classifiers": [c for c in info.get("classifiers", []) if c.startswith("Operating System")],
            "n_releases": len(d["releases"]),
            "wheels": sorted({f["filename"].rsplit("-",1)[-1] for f in files})[:8],
            "summary": info.get("summary"),
        }
    except Exception as e:
        out["pypi"][name] = {"error": repr(e)}
for name in NPM:
    try:
        d = get("https://registry.npmjs.org/" + name.replace("/", "%2F"))
        latest = d.get("dist-tags", {}).get("latest")
        out["npm"][name] = {"latest": latest, "published": d.get("time", {}).get(latest),
                             "modified": d.get("time", {}).get("modified"),
                             "deprecated": d.get("versions", {}).get(latest, {}).get("deprecated"),
                             "description": d.get("description")}
    except Exception as e:
        out["npm"][name] = {"error": repr(e)}
for name in NUGET:
    try:
        d = get(f"https://api.nuget.org/v3-flatcontainer/{name}/index.json")
        out["nuget"][name] = {"latest": d["versions"][-1], "n_versions": len(d["versions"])}
    except Exception as e:
        out["nuget"][name] = {"error": repr(e)}
json.dump(out, sys.stdout, indent=1)
