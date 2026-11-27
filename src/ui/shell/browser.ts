/**
 * Petits accès au navigateur, isolés ici : presse-papiers, téléchargement d'un fichier produit sur place,
 * fenêtre d'impression, lecture d'un fichier choisi. Rien ne part sur le réseau : tout reste sur le poste.
 */

/** Copie un texte dans le presse-papiers. Renvoie faux si le navigateur l'a refusé. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Presse-papiers refusé (page non sécurisée, permission) : on essaie l'ancienne méthode.
  }
  return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined') return false;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.left = '-9999px';
  area.style.top = '0';
  document.body.appendChild(area);
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  area.select();
  let ok = false;
  try {
    ok = typeof document.execCommand === 'function' && document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  active?.focus();
  return ok;
}

/** Propose à l'utilisateur d'enregistrer un fichier fabriqué dans la page. */
export function downloadText(fileName: string, mime: string, content: string): boolean {
  try {
    const url = URL.createObjectURL(new Blob([content], { type: mime }));
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.rel = 'noopener';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    // L'adresse n'est libérée qu'après le démarrage du téléchargement.
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ouvre une page HTML autonome dans une nouvelle fenêtre et lance l'impression (« enregistrer en PDF »).
 * Renvoie faux si le navigateur a bloqué la fenêtre : l'appelant propose alors le téléchargement du fichier.
 */
export function openPrintable(html: string): boolean {
  try {
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
    const opened = window.open(url, '_blank');
    if (!opened) {
      URL.revokeObjectURL(url);
      return false;
    }
    const print = (): void => {
      try {
        opened.focus();
        opened.print();
      } catch {
        // L'utilisateur imprimera lui-même depuis la fenêtre ouverte.
      }
    };
    opened.addEventListener('load', () => setTimeout(print, 150), { once: true });
    setTimeout(() => URL.revokeObjectURL(url), 120_000);
    return true;
  } catch {
    return false;
  }
}

/** Lit un fichier texte choisi par l'utilisateur (projet .json). */
export function readFileText(file: Blob): Promise<string> {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('read-failed'));
    reader.readAsText(file);
  });
}

/** Vrai si l'utilisateur a demandé moins d'animations. */
export function prefersReducedMotion(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}
