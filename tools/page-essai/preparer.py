"""Prépare la page d'essai à partir du build Vite (voir LISEZMOI.md).

    python3 tools/page-essai/preparer.py <dist> <sortie>
"""
import json
import os
import re
import shutil
import sys

if len(sys.argv) != 3:
    raise SystemExit(__doc__)
DIST = os.path.abspath(sys.argv[1])
OUT = os.path.abspath(sys.argv[2])
COPY = os.path.join(OUT, 'copie')

# Fichiers que l'hébergeur ne sert pas, ou qui ne servent qu'au débogage.
LEFT_OUT = ('.map', '.pfb')

html = open(os.path.join(DIST, 'index.html'), encoding='utf-8').read()
script = re.search(r'<script type="module"[^>]*src="\./(assets/[^"]+)"', html)
style = re.search(r'<link rel="stylesheet"[^>]*href="\./(assets/[^"]+)"', html)
if not (script and style):
    raise SystemExit('script ou feuille de style introuvable dans index.html')

page = f"""<title>Plan2CPE</title>
<style>
/* Fond de départ, avant le chargement de la feuille de style de l'application (mêmes teintes que ses jetons). */
:root {{ --boot-bg: #f6f4ef; --boot-ink: #1f2a30; }}
@media (prefers-color-scheme: dark) {{ :root:not([data-theme="light"]) {{ --boot-bg: #12161a; --boot-ink: #e8ecee; color-scheme: dark; }} }}
:root[data-theme="dark"] {{ --boot-bg: #12161a; --boot-ink: #e8ecee; color-scheme: dark; }}
body {{ background: var(--boot-bg); color: var(--boot-ink); }}
</style>
<link rel="stylesheet" href="{style.group(1)}">
<div id="root"></div>
<script type="module" src="{script.group(1)}"></script>
"""

os.makedirs(OUT, exist_ok=True)
if os.path.isdir(COPY):
    shutil.rmtree(COPY)
open(os.path.join(OUT, 'plan2cpe.html'), 'w', encoding='utf-8').write(page)

files = []
total = 0
for root, _dirs, names in os.walk(DIST):
    for name in sorted(names):
        if name == 'index.html' or name.endswith(LEFT_OUT):
            continue
        full = os.path.join(root, name)
        rel = os.path.relpath(full, DIST).replace(os.sep, '/')
        target = os.path.join(COPY, rel)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.copyfile(full, target)
        files.append(rel)
        total += os.path.getsize(full)
files.sort()
json.dump(files, open(os.path.join(OUT, 'fichiers.json'), 'w', encoding='utf-8'), indent=1)

# Imitation locale du squelette ajouté par l'hébergeur.
local = os.path.join(OUT, 'essai-local')
os.makedirs(local, exist_ok=True)
skeleton = (
    '<!doctype html><html><head><meta charset=utf8>'
    '<meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover">'
    '<style>:root{color-scheme:light;padding:env(safe-area-inset-top,0px) 0 env(safe-area-inset-bottom,0px)}'
    'body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>'
    '</head><body>' + page + '</body></html>'
)
open(os.path.join(local, 'index.html'), 'w', encoding='utf-8').write(skeleton)

print(len(files), 'fichiers,', round(total / 1e6, 1), 'Mo ; page :', len(page), 'octets')
