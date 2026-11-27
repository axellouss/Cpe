/**
 * Frontière avec web-ifc. Les lignes STEP renvoyées par la bibliothèque ne sont pas typées : tout passe ici par
 * `unknown` et par de petits accesseurs défensifs, pour que le reste du lecteur reste strictement typé.
 *
 * Rappels utiles (vérifiés sur web-ifc 0.0.81) :
 *  - un attribut est soit null, soit un objet { type, value } (les réels exposent `value` par un accesseur
 *    et `_representationValue` en clair), soit une liste ; une référence est { type: 5, value: expressID } ;
 *  - `GetTypeCodeFromName` attend le nom en MAJUSCULES, `GetNameFromTypeCode` le rend en casse mixte ;
 *  - la géométrie sort en MÈTRES, axe Y vers le haut : IFC (x, y, z) = (X, −Z, Y) ;
 *  - tampon de sommets = 6 flottants par sommet (position puis normale), matrice 4×4 rangée par colonnes.
 */
import type { IfcAPI } from 'web-ifc';

/** Une ligne STEP lue par web-ifc (attributs par nom). */
export type IfcLine = Readonly<Record<string, unknown>>;

/** Décalage d'origine appliqué aux coordonnées (m), décidé au premier sommet rencontré. */
export interface Origin {
  x: number;
  y: number;
  decided: boolean;
}

/** Au-delà de cette distance à l'origine (m), les coordonnées sont recentrées pour tenir dans des Float32. */
const FAR_FROM_ORIGIN = 5000;
const ORIGIN_STEP = 100;

const REF_TYPE = 5;

function unwrap(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'object') return v;
  const o = v as { value?: unknown; _representationValue?: unknown };
  if (o.value !== undefined) return o.value;
  if (o._representationValue !== undefined) return o._representationValue;
  return null;
}

/** Valeur numérique d'un attribut (null si absente ou non numérique). */
export function num(v: unknown): number | null {
  const raw = unwrap(v);
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Texte d'un attribut (null si absent ou vide). */
export function str(v: unknown): string | null {
  const raw = unwrap(v);
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  return s === '' ? null : s;
}

/** expressID visé par une référence (null sinon). */
export function ref(v: unknown): number | null {
  if (v === null || typeof v !== 'object') return null;
  const o = v as { type?: unknown; value?: unknown; expressID?: unknown };
  if (o.type === REF_TYPE && typeof o.value === 'number') return o.value;
  // Ligne déjà « aplatie » : on retrouve son identifiant.
  if (typeof o.expressID === 'number') return o.expressID;
  return null;
}

/** Éléments d'un attribut liste (liste vide sinon). */
export function items(v: unknown): readonly unknown[] {
  return Array.isArray(v) ? (v as readonly unknown[]) : [];
}

/** Liste de nombres (coordonnées, rapports de direction). */
export function numbers(v: unknown): number[] {
  const out: number[] = [];
  for (const it of items(v)) {
    const n = num(it);
    if (n !== null) out.push(n);
  }
  return out;
}

const STEP_HEADER = 'ISO-10303-21;';
const STEP_TRAILER = 'END-ISO-10303-21;';

function isPadding(b: number): boolean {
  // Blancs, NUL et SUB (bourrage de certains outils de copie) après la dernière ligne.
  return b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d || b === 0x00 || b === 0x1a;
}

function matchesAt(data: Uint8Array, at: number, text: string): boolean {
  if (at < 0 || at + text.length > data.length) return false;
  for (let i = 0; i < text.length; i++) {
    let b = data[at + i]!;
    if (b >= 0x61 && b <= 0x7a) b -= 0x20; // mots-clés STEP : casse indifférente
    if (b !== text.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * Forme d'un fichier STEP, vue à ses deux bouts sans le lire : « ISO-10303-21; » en tête (après un éventuel BOM
 * et des blancs), « END-ISO-10303-21; » en fin (blancs de fin ignorés). Un fichier qui a la tête sans la queue a
 * été tronqué : web-ifc l'ouvrirait quand même et l'on proposerait un bâtiment incomplet.
 */
/** Portion finale du fichier où l'on cherche « END-ISO-10303-21; » (un commentaire d'export peut la suivre). */
const TRAILER_SEARCH_BYTES = 256 * 1024;

export function stepShape(data: Uint8Array): { header: boolean; trailer: boolean } {
  let start = 0;
  if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) start = 3;
  while (start < data.length && start < 4096 && isPadding(data[start]!)) start++;
  // La fin se cherche dans la queue du fichier, quoi qui la suive : blancs, commentaire « /* … */ » d'un logiciel
  // d'export, octets de remplissage. Un fichier TRONQUÉ, lui, ne contient cette fin nulle part ; un fichier complet
  // suivi d'autre chose n'est pas « incomplet ».
  let trailer = false;
  const floor = Math.max(start, data.length - TRAILER_SEARCH_BYTES);
  for (let at = data.length - STEP_TRAILER.length; at >= floor; at--) {
    if (matchesAt(data, at, STEP_TRAILER)) {
      trailer = true;
      break;
    }
  }
  return { header: matchesAt(data, start, STEP_HEADER), trailer };
}

/** Modèle IFC ouvert dans une instance web-ifc déjà initialisée. */
export class IfcSource {
  private readonly codes = new Map<string, number>();
  private readonly names = new Map<number, string>();

  private constructor(
    private readonly api: IfcAPI,
    private readonly modelID: number,
  ) {}

  /** Ouvre le modèle ; null si web-ifc refuse le fichier (le message localisé est donné par l'appelant). */
  static open(api: IfcAPI, data: Uint8Array): IfcSource | null {
    let modelID = -1;
    try {
      modelID = api.OpenModel(data, { COORDINATE_TO_ORIGIN: false });
    } catch {
      modelID = -1;
    }
    if (typeof modelID !== 'number' || modelID < 0) return null;
    return new IfcSource(api, modelID);
  }

  close(): void {
    try {
      this.api.CloseModel(this.modelID);
    } catch {
      // Rien à faire : l'instance est jetée juste après.
    }
  }

  schema(): string {
    try {
      return String(this.api.GetModelSchema(this.modelID) ?? '');
    } catch {
      return '';
    }
  }

  private code(typeName: string): number {
    const key = typeName.toUpperCase();
    let c = this.codes.get(key);
    if (c === undefined) {
      c = this.api.GetTypeCodeFromName(key);
      this.codes.set(key, c);
    }
    return c;
  }

  /** expressID de toutes les lignes d'une classe (sous-classes comprises par défaut). */
  ids(typeName: string, inherited = true): number[] {
    const out: number[] = [];
    try {
      const v = this.api.GetLineIDsWithType(this.modelID, this.code(typeName), inherited);
      const n = v.size();
      for (let i = 0; i < n; i++) out.push(v.get(i));
    } catch {
      // Classe inconnue du schéma du fichier : aucune ligne.
    }
    return out;
  }

  line(id: number | null): IfcLine | null {
    if (id === null) return null;
    try {
      const l: unknown = this.api.GetLine(this.modelID, id);
      return l !== null && typeof l === 'object' ? (l as IfcLine) : null;
    } catch {
      return null;
    }
  }

  /** Nom de classe en MAJUSCULES d'une ligne déjà lue (« IFCWALLSTANDARDCASE »). */
  classOf(line: IfcLine | null): string {
    const code = line?.type;
    if (typeof code !== 'number') return '';
    let name = this.names.get(code);
    if (name === undefined) {
      try {
        name = String(this.api.GetNameFromTypeCode(code) ?? '').toUpperCase();
      } catch {
        name = '';
      }
      this.names.set(code, name);
    }
    return name;
  }

  classOfId(id: number): string {
    try {
      const code: unknown = this.api.GetLineType(this.modelID, id);
      if (typeof code !== 'number') return '';
      return this.classOf({ type: code });
    } catch {
      return '';
    }
  }

  /**
   * Triangule les éléments demandés et appelle `onMesh` avec une « soupe » de triangles
   * [x, y, z] × 3 par triangle, en mètres, dans le repère IFC (z vertical), origine décalée de `origin`.
   * Les éléments sans géométrie ne déclenchent aucun appel.
   */
  streamTriangles(ids: readonly number[], origin: Origin, onMesh: (expressID: number, soup: Float32Array) => void): void {
    if (ids.length === 0) return;
    const api = this.api;
    const modelID = this.modelID;
    api.StreamMeshes(modelID, [...ids], (mesh) => {
      const parts: Float32Array[] = [];
      let total = 0;
      const count = mesh.geometries.size();
      for (let g = 0; g < count; g++) {
        const placed = mesh.geometries.get(g);
        // 0 = triangles ; les polylignes et points (1, 2) ne nous intéressent pas.
        if (typeof placed.geomType === 'number' && placed.geomType !== 0) continue;
        const geometry = api.GetGeometry(modelID, placed.geometryExpressID);
        try {
          const verts = api.GetVertexArray(geometry.GetVertexData(), geometry.GetVertexDataSize());
          const index = api.GetIndexArray(geometry.GetIndexData(), geometry.GetIndexDataSize());
          const m = placed.flatTransformation;
          const m0 = m[0] ?? 1, m1 = m[1] ?? 0, m2 = m[2] ?? 0;
          const m4 = m[4] ?? 0, m5 = m[5] ?? 1, m6 = m[6] ?? 0;
          const m8 = m[8] ?? 0, m9 = m[9] ?? 0, m10 = m[10] ?? 1;
          const m12 = m[12] ?? 0, m13 = m[13] ?? 0, m14 = m[14] ?? 0;
          const n = index.length - (index.length % 3);
          const out = new Float32Array(n * 3);
          for (let k = 0; k < n; k++) {
            const o = (index[k] ?? 0) * 6;
            const x = verts[o] ?? 0;
            const y = verts[o + 1] ?? 0;
            const z = verts[o + 2] ?? 0;
            const wx = m0 * x + m4 * y + m8 * z + m12;
            const wy = m1 * x + m5 * y + m9 * z + m13;
            const wz = m2 * x + m6 * y + m10 * z + m14;
            // web-ifc : Y vers le haut → IFC : (X, −Z, Y).
            const ix = wx;
            const iy = -wz;
            if (!origin.decided) {
              origin.decided = true;
              if (Math.abs(ix) > FAR_FROM_ORIGIN || Math.abs(iy) > FAR_FROM_ORIGIN) {
                origin.x = Math.round(ix / ORIGIN_STEP) * ORIGIN_STEP;
                origin.y = Math.round(iy / ORIGIN_STEP) * ORIGIN_STEP;
              }
            }
            out[k * 3] = ix - origin.x;
            out[k * 3 + 1] = iy - origin.y;
            out[k * 3 + 2] = wy;
          }
          if (n > 0) {
            parts.push(out);
            total += out.length;
          }
        } finally {
          geometry.delete();
        }
      }
      if (total === 0) return;
      let soup: Float32Array;
      if (parts.length === 1) {
        soup = parts[0]!;
      } else {
        soup = new Float32Array(total);
        let offset = 0;
        for (const p of parts) {
          soup.set(p, offset);
          offset += p.length;
        }
      }
      onMesh(mesh.expressID, soup);
    });
  }
}
