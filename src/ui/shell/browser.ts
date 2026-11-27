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

/** Issue d'un enregistrement : fait, refusé par la personne, contenu copié faute de mieux, ou impossible. */
export type SaveOutcome = 'saved' | 'declined' | 'copied' | 'failed';

/** Ce que la page hôte offre pour enregistrer un fichier quand le cadre interdit les téléchargements directs. */
interface HostDownloads {
  save(request: { filename: string; data: string }): Promise<unknown>;
}
interface HostBridge {
  use(name: string): Promise<unknown>;
}

function hostBridge(): HostBridge | null {
  const bridge = (globalThis as { claude?: { use?: unknown } }).claude;
  return bridge && typeof bridge.use === 'function' ? (bridge as HostBridge) : null;
}

/**
 * Vrai quand l'application est affichée dans un cadre hôte (page d'essai publiée) : les liens de téléchargement
 * et les nouvelles fenêtres y restent sans effet, et l'enregistrement passe par l'hôte, qui demande confirmation.
 */
export function isHosted(): boolean {
  return hostBridge() !== null;
}

let hostDownloadsOnce: { bridge: HostBridge; value: Promise<HostDownloads | null> } | null = null;

function hostDownloads(): Promise<HostDownloads | null> {
  const bridge = hostBridge();
  if (!bridge) return Promise.resolve(null);
  if (hostDownloadsOnce?.bridge !== bridge) {
    const value = Promise.resolve()
      .then(() => bridge.use('downloads'))
      .then((found) => (found && typeof (found as HostDownloads).save === 'function' ? (found as HostDownloads) : null))
      .catch(() => null);
    hostDownloadsOnce = { bridge, value };
  }
  return hostDownloadsOnce.value;
}

/**
 * Enregistre un fichier fabriqué dans la page, où que celle-ci soit affichée.
 * Dans un navigateur ordinaire : téléchargement direct. Dans un cadre hôte : enregistrement par l'hôte ; s'il
 * n'en propose pas, un lien de téléchargement ne ferait rien — le texte est alors copié si `copyFallback` le permet.
 */
export async function saveText(fileName: string, mime: string, content: string, copyFallback = false): Promise<SaveOutcome> {
  if (!isHosted()) return downloadText(fileName, mime, content) ? 'saved' : 'failed';
  const host = await hostDownloads();
  if (host) {
    try {
      await host.save({ filename: fileName, data: content });
      return 'saved';
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'declined') return 'declined';
    }
  }
  if (copyFallback && (await copyText(content))) return 'copied';
  return 'failed';
}

// La réponse de l'hôte peut tarder : on la demande dès le chargement pour qu'elle soit prête au premier clic.
if (isHosted()) void hostDownloads();

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
