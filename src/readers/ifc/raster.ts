/**
 * Outils « trame » du lecteur IFC (portage de la maquette webifc_spike.mjs) : projection en plan des maillages
 * sur une grille d'occupation, fermeture des petits interstices, remplissage de l'extérieur par inondation,
 * composantes connexes et suivi de contour. Fonctions pures, tableaux typés uniquement.
 *
 * Repère : celui de l'IFC (x à droite, y vers le HAUT). La cellule (i, j) couvre
 * [minX + i·cell, minX + (i+1)·cell] × [minY + j·cell, minY + (j+1)·cell] ; son indice est i·ny + j.
 */

export interface Grid {
  minX: number;
  minY: number;
  cell: number;
  nx: number;
  ny: number;
}

export interface Extent {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Grille couvrant l'étendue + une marge ; la maille est grossie pour que nx·ny reste sous `maxCells`, QUELLES QUE
 * SOIENT les proportions (une étendue très allongée ne doit pas allouer des gigaoctets).
 * Lève une RangeError si l'étendue, la maille ou le plafond ne sont pas des nombres finis et positifs.
 */
export function makeGrid(extent: Extent, cell: number, maxCells: number, pad = 1): Grid {
  const values = [extent.minX, extent.minY, extent.maxX, extent.maxY, cell, maxCells, pad];
  if (!values.every((v) => Number.isFinite(v)) || !(cell > 0) || !(maxCells >= 1) || !(pad >= 0)) {
    throw new RangeError('makeGrid : étendue ou maille non finie');
  }
  const minX = extent.minX - pad;
  const minY = extent.minY - pad;
  const w = Math.max(extent.maxX - extent.minX, 0) + 2 * pad;
  const h = Math.max(extent.maxY - extent.minY, 0) + 2 * pad;
  if (!Number.isFinite(w) || !Number.isFinite(h)) throw new RangeError('makeGrid : étendue non finie');
  let c = cell;
  if ((w * h) / (c * c) > maxCells) c = Math.sqrt((w * h) / maxCells);
  // Proportions extrêmes : un côté tient dans une seule rangée, c'est l'autre qui doit rester sous le plafond.
  c = Math.max(c, w / maxCells, h / maxCells);
  const cells = (size: number): number => Math.max(1, Math.ceil(size / c));
  // Les arrondis par excès ajoutent au plus une rangée et une colonne (≈ 0,1 % pour une étendue ordinaire, toléré
  // tel quel pour ne rien changer aux résultats) ; sur une étendue très allongée ils peuvent tripler le compte :
  // on grossit alors un peu la maille jusqu'à revenir à 1 % du plafond.
  const limit = maxCells * 1.01;
  for (let guard = 0; guard < 200 && cells(w) * cells(h) > limit; guard++) c *= 1.01;
  if (cells(w) * cells(h) > limit) c = Math.max(w, h);
  return { minX, minY, cell: c, nx: cells(w), ny: cells(h) };
}

const EDGE_EPS = 1e-9;

/**
 * Marque les cellules dont le CENTRE tombe dans la projection en plan d'un triangle de la soupe
 * ([x, y, z] × 3 par triangle). Balayage colonne par colonne : coût proportionnel aux cellules couvertes.
 */
export function rasterizeOccupancy(grid: Grid, soup: Float32Array, occ: Uint8Array): void {
  const { minX, minY, cell, nx, ny } = grid;
  for (let t = 0; t + 8 < soup.length; t += 9) {
    const x0 = soup[t]!, y0 = soup[t + 1]!;
    const x1 = soup[t + 3]!, y1 = soup[t + 4]!;
    const x2 = soup[t + 6]!, y2 = soup[t + 7]!;
    const area2 = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (Math.abs(area2) < 1e-10) continue; // triangle vertical ou dégénéré : rien en plan
    const xa = Math.min(x0, x1, x2);
    const xb = Math.max(x0, x1, x2);
    const iFrom = Math.max(0, Math.ceil((xa - minX) / cell - 0.5 - EDGE_EPS));
    const iTo = Math.min(nx - 1, Math.floor((xb - minX) / cell - 0.5 + EDGE_EPS));
    for (let i = iFrom; i <= iTo; i++) {
      const x = minX + (i + 0.5) * cell;
      let lo = Infinity;
      let hi = -Infinity;
      // Intersection de la verticale x avec les trois arêtes.
      if ((x0 <= x && x <= x1) || (x1 <= x && x <= x0)) {
        if (x0 === x1) {
          lo = Math.min(lo, y0, y1);
          hi = Math.max(hi, y0, y1);
        } else {
          const y = y0 + ((x - x0) * (y1 - y0)) / (x1 - x0);
          if (y < lo) lo = y;
          if (y > hi) hi = y;
        }
      }
      if ((x1 <= x && x <= x2) || (x2 <= x && x <= x1)) {
        if (x1 === x2) {
          lo = Math.min(lo, y1, y2);
          hi = Math.max(hi, y1, y2);
        } else {
          const y = y1 + ((x - x1) * (y2 - y1)) / (x2 - x1);
          if (y < lo) lo = y;
          if (y > hi) hi = y;
        }
      }
      if ((x2 <= x && x <= x0) || (x0 <= x && x <= x2)) {
        if (x2 === x0) {
          lo = Math.min(lo, y2, y0);
          hi = Math.max(hi, y2, y0);
        } else {
          const y = y2 + ((x - x2) * (y0 - y2)) / (x0 - x2);
          if (y < lo) lo = y;
          if (y > hi) hi = y;
        }
      }
      if (hi < lo) continue;
      const jFrom = Math.max(0, Math.ceil((lo - minY) / cell - 0.5 - EDGE_EPS));
      const jTo = Math.min(ny - 1, Math.floor((hi - minY) / cell - 0.5 + EDGE_EPS));
      const base = i * ny;
      for (let j = jFrom; j <= jTo; j++) occ[base + j] = 1;
    }
  }
}

/**
 * Part des cellules couvertes par la projection d'un maillage qui sont marquées dans `flags` (0 si rien n'est couvert).
 * Les triangles superposés (dessus et dessous d'un mur) comptent plusieurs fois, ce qui ne change pas le rapport.
 */
export function flaggedShare(grid: Grid, soup: Float32Array, flags: Uint8Array): number {
  const { minX, minY, cell, nx, ny } = grid;
  let total = 0;
  let hit = 0;
  for (let t = 0; t + 8 < soup.length; t += 9) {
    const x0 = soup[t]!, y0 = soup[t + 1]!;
    const x1 = soup[t + 3]!, y1 = soup[t + 4]!;
    const x2 = soup[t + 6]!, y2 = soup[t + 7]!;
    const det = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
    if (Math.abs(det) < 1e-10) continue;
    const iFrom = Math.max(0, Math.ceil((Math.min(x0, x1, x2) - minX) / cell - 0.5 - EDGE_EPS));
    const iTo = Math.min(nx - 1, Math.floor((Math.max(x0, x1, x2) - minX) / cell - 0.5 + EDGE_EPS));
    const jFrom = Math.max(0, Math.ceil((Math.min(y0, y1, y2) - minY) / cell - 0.5 - EDGE_EPS));
    const jTo = Math.min(ny - 1, Math.floor((Math.max(y0, y1, y2) - minY) / cell - 0.5 + EDGE_EPS));
    for (let i = iFrom; i <= iTo; i++) {
      const x = minX + (i + 0.5) * cell;
      const base = i * ny;
      for (let j = jFrom; j <= jTo; j++) {
        const y = minY + (j + 0.5) * cell;
        const l0 = ((y1 - y2) * (x - x2) + (x2 - x1) * (y - y2)) / det;
        const l1 = ((y2 - y0) * (x - x2) + (x0 - x2) * (y - y2)) / det;
        if (l0 < -1e-7 || l1 < -1e-7 || 1 - l0 - l1 < -1e-7) continue;
        total++;
        if (flags[base + j] === 1) hit++;
      }
    }
  }
  return total > 0 ? hit / total : 0;
}

/**
 * Champ de hauteurs d'un volume : pour chaque cellule, cote la plus haute et la plus basse des triangles
 * NON verticaux qui la couvrent. `top` doit être initialisé à −∞ et `bottom` à +∞.
 */
export function rasterizeHeights(grid: Grid, soup: Float32Array, top: Float32Array, bottom: Float32Array): void {
  const { minX, minY, cell, nx, ny } = grid;
  for (let t = 0; t + 8 < soup.length; t += 9) {
    const x0 = soup[t]!, y0 = soup[t + 1]!, z0 = soup[t + 2]!;
    const x1 = soup[t + 3]!, y1 = soup[t + 4]!, z1 = soup[t + 5]!;
    const x2 = soup[t + 6]!, y2 = soup[t + 7]!, z2 = soup[t + 8]!;
    const det = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
    if (Math.abs(det) < 1e-10) continue;
    const iFrom = Math.max(0, Math.ceil((Math.min(x0, x1, x2) - minX) / cell - 0.5 - EDGE_EPS));
    const iTo = Math.min(nx - 1, Math.floor((Math.max(x0, x1, x2) - minX) / cell - 0.5 + EDGE_EPS));
    const jFrom = Math.max(0, Math.ceil((Math.min(y0, y1, y2) - minY) / cell - 0.5 - EDGE_EPS));
    const jTo = Math.min(ny - 1, Math.floor((Math.max(y0, y1, y2) - minY) / cell - 0.5 + EDGE_EPS));
    for (let i = iFrom; i <= iTo; i++) {
      const x = minX + (i + 0.5) * cell;
      const base = i * ny;
      for (let j = jFrom; j <= jTo; j++) {
        const y = minY + (j + 0.5) * cell;
        const l0 = ((y1 - y2) * (x - x2) + (x2 - x1) * (y - y2)) / det;
        const l1 = ((y2 - y0) * (x - x2) + (x0 - x2) * (y - y2)) / det;
        const l2 = 1 - l0 - l1;
        if (l0 < -1e-7 || l1 < -1e-7 || l2 < -1e-7) continue;
        const z = l0 * z0 + l1 * z1 + l2 * z2;
        const c = base + j;
        if (z > top[c]!) top[c] = z;
        if (z < bottom[c]!) bottom[c] = z;
      }
    }
  }
}

/** Dilatation (ou érosion) par un carré de (2k+1) cellules, séparable, à fenêtre glissante. Hors grille = vide. */
function boxMorph(grid: Grid, src: Uint8Array, k: number, dilate: boolean): Uint8Array {
  const { nx, ny } = grid;
  if (k <= 0) return src.slice();
  const full = 2 * k + 1;
  const tmp = new Uint8Array(src.length);
  // Passe selon j (cellules contiguës en mémoire).
  for (let i = 0; i < nx; i++) {
    const base = i * ny;
    let count = 0;
    for (let j = 0; j <= Math.min(k, ny - 1); j++) count += src[base + j]!;
    for (let j = 0; j < ny; j++) {
      tmp[base + j] = dilate ? (count > 0 ? 1 : 0) : count === full ? 1 : 0;
      const add = j + k + 1;
      if (add < ny) count += src[base + add]!;
      const sub = j - k;
      if (sub >= 0) count -= src[base + sub]!;
    }
  }
  // Passe selon i : un compteur glissant par colonne j, pour ne lire que des lignes contiguës en mémoire.
  const out = new Uint8Array(src.length);
  const counts = new Int32Array(ny);
  for (let i = 0; i <= Math.min(k, nx - 1); i++) {
    const row = i * ny;
    for (let j = 0; j < ny; j++) counts[j] = counts[j]! + tmp[row + j]!;
  }
  for (let i = 0; i < nx; i++) {
    const row = i * ny;
    if (dilate) {
      for (let j = 0; j < ny; j++) out[row + j] = counts[j]! > 0 ? 1 : 0;
    } else {
      for (let j = 0; j < ny; j++) out[row + j] = counts[j] === full ? 1 : 0;
    }
    const add = i + k + 1;
    if (add < nx) {
      const r = add * ny;
      for (let j = 0; j < ny; j++) counts[j] = counts[j]! + tmp[r + j]!;
    }
    const sub = i - k;
    if (sub >= 0) {
      const r = sub * ny;
      for (let j = 0; j < ny; j++) counts[j] = counts[j]! - tmp[r + j]!;
    }
  }
  return out;
}

/**
 * Emprise au sol à partir d'une grille d'occupation (murs + locaux) : interstices ≤ 2k cellules fermés,
 * trous intérieurs remplis (tout ce que l'extérieur n'atteint pas depuis le bord est « dedans »).
 */
export function footprintMask(grid: Grid, occ: Uint8Array, k: number): Uint8Array {
  const { nx, ny } = grid;
  const n = nx * ny;
  const dilated = boxMorph(grid, occ, k, true);
  // Inondation de l'extérieur depuis le bord ; file en tableau typé (chaque cellule y entre au plus une fois).
  const outside = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  const push = (c: number): void => {
    if (outside[c] === 0 && dilated[c] === 0) {
      outside[c] = 1;
      queue[tail++] = c;
    }
  };
  for (let i = 0; i < nx; i++) {
    push(i * ny);
    push(i * ny + ny - 1);
  }
  for (let j = 0; j < ny; j++) {
    push(j);
    push((nx - 1) * ny + j);
  }
  while (head < tail) {
    const c = queue[head++]!;
    const j = c % ny;
    if (c >= ny) push(c - ny);
    if (c < n - ny) push(c + ny);
    if (j > 0) push(c - 1);
    if (j < ny - 1) push(c + 1);
  }
  const inside = dilated; // réutilisation du tampon
  for (let c = 0; c < n; c++) inside[c] = outside[c] === 0 ? 1 : 0;
  return boxMorph(grid, inside, k, false);
}

/**
 * Retire de l'emprise les « bras » minces qui s'en détachent : murs de jardin ou de soutènement accolés à la
 * maison, murs en aile, pignons qui débordent du volume. Un bras est une partie de l'emprise où un carré de
 * (2k+1) cellules ne tient pas ET qui s'éloigne de plus de k cellules de la partie massive ; les petits éclats
 * laissés par l'ouverture morphologique aux angles saillants d'un bâtiment tourné ne sont pas touchés.
 * Renvoie le nombre de cellules retirées (le masque est modifié en place ; `removedFlags`, s'il est fourni,
 * reçoit 1 dans chaque cellule retirée).
 */
export function removeThinArms(grid: Grid, mask: Uint8Array, k: number, removedFlags?: Uint8Array): number {
  if (k <= 0) return 0;
  const n = grid.nx * grid.ny;
  const ny = grid.ny;
  const eroded = boxMorph(grid, mask, k, false);
  const opened = boxMorph(grid, eroded, k, true);
  // 1 = cellule de bras pas encore visitée.
  const arm = new Uint8Array(n);
  let any = false;
  for (let c = 0; c < n; c++) {
    if (mask[c] === 1 && opened[c] === 0) {
      arm[c] = 1;
      any = true;
    }
  }
  if (!any) return 0;
  const near = boxMorph(grid, eroded, 2 * k + 1, true);
  const queue = new Int32Array(n);
  let removed = 0;
  for (let start = 0; start < n; start++) {
    if (arm[start] !== 1) continue;
    let head = 0;
    let tail = 0;
    let long = false;
    arm[start] = 2;
    queue[tail++] = start;
    while (head < tail) {
      const c = queue[head++]!;
      if (near[c] === 0) long = true;
      const j = c % ny;
      if (c >= ny && arm[c - ny] === 1) {
        arm[c - ny] = 2;
        queue[tail++] = c - ny;
      }
      if (c < n - ny && arm[c + ny] === 1) {
        arm[c + ny] = 2;
        queue[tail++] = c + ny;
      }
      if (j > 0 && arm[c - 1] === 1) {
        arm[c - 1] = 2;
        queue[tail++] = c - 1;
      }
      if (j < ny - 1 && arm[c + 1] === 1) {
        arm[c + 1] = 2;
        queue[tail++] = c + 1;
      }
    }
    if (long) {
      for (let q = 0; q < tail; q++) {
        const c = queue[q]!;
        mask[c] = 0;
        if (removedFlags) removedFlags[c] = 1;
      }
      removed += tail;
    }
  }
  return removed;
}

export interface Pieces {
  /** 0 = hors emprise ; p ≥ 1 = numéro du morceau (1 = le plus grand). Les morceaux trop petits sont remis à 0. */
  labels: Uint16Array;
  /** Nombre de cellules de chaque morceau conservé, du plus grand au plus petit (areas[p − 1]). */
  cells: number[];
}

/** Érosion du masque par un carré de (2k+1) cellules : ne restent que les cellules à plus de k cellules de tout vide. */
export function erodeMask(grid: Grid, mask: Uint8Array, k: number): Uint8Array {
  return boxMorph(grid, mask, k, false);
}

/**
 * Composantes connexes (4-voisinage) du masque, triées par taille. Sont écartées celles de moins de `minCells`
 * et, si `core` est fourni, celles qui n'en contiennent aucune cellule (un mur isolé n'enferme aucun volume :
 * il n'a pas de « cœur » une fois le masque érodé d'une demi-largeur de pièce).
 */
export function labelPieces(grid: Grid, mask: Uint8Array, minCells: number, core?: Uint8Array): Pieces {
  const { nx, ny } = grid;
  const n = nx * ny;
  const raw = new Uint16Array(n);
  const queue = new Int32Array(n);
  const sizes: number[] = [0];
  const hasCore: boolean[] = [false];
  let next = 1;
  for (let start = 0; start < n; start++) {
    if (mask[start] === 0 || raw[start] !== 0) continue;
    if (next > 65535) break;
    const label = next++;
    let head = 0;
    let tail = 0;
    raw[start] = label;
    queue[tail++] = start;
    let cored = core === undefined;
    while (head < tail) {
      const c = queue[head++]!;
      if (!cored && core![c] === 1) cored = true;
      const j = c % ny;
      if (c >= ny && mask[c - ny] === 1 && raw[c - ny] === 0) {
        raw[c - ny] = label;
        queue[tail++] = c - ny;
      }
      if (c < n - ny && mask[c + ny] === 1 && raw[c + ny] === 0) {
        raw[c + ny] = label;
        queue[tail++] = c + ny;
      }
      if (j > 0 && mask[c - 1] === 1 && raw[c - 1] === 0) {
        raw[c - 1] = label;
        queue[tail++] = c - 1;
      }
      if (j < ny - 1 && mask[c + 1] === 1 && raw[c + 1] === 0) {
        raw[c + 1] = label;
        queue[tail++] = c + 1;
      }
    }
    sizes[label] = tail;
    hasCore[label] = cored;
  }
  const kept: number[] = [];
  for (let l = 1; l < sizes.length; l++) if ((sizes[l] ?? 0) >= minCells && hasCore[l] === true) kept.push(l);
  kept.sort((a, b) => (sizes[b] ?? 0) - (sizes[a] ?? 0));
  const remap = new Uint16Array(sizes.length);
  kept.forEach((l, rank) => {
    remap[l] = rank + 1;
  });
  for (let c = 0; c < n; c++) {
    const l = raw[c]!;
    if (l !== 0) raw[c] = remap[l]!;
  }
  return { labels: raw, cells: kept.map((l) => sizes[l] ?? 0) };
}

/** Numéro du morceau qui contient le point (x, y), ou 0. */
export function labelAt(grid: Grid, labels: Uint16Array, x: number, y: number): number {
  const i = Math.floor((x - grid.minX) / grid.cell);
  const j = Math.floor((y - grid.minY) / grid.cell);
  return i >= 0 && i < grid.nx && j >= 0 && j < grid.ny ? labels[i * grid.ny + j]! : 0;
}

/** Vrai si le point (x, y) tombe dans un morceau conservé. */
export function isInside(grid: Grid, labels: Uint16Array, x: number, y: number): boolean {
  const i = Math.floor((x - grid.minX) / grid.cell);
  const j = Math.floor((y - grid.minY) / grid.cell);
  return i >= 0 && i < grid.nx && j >= 0 && j < grid.ny && labels[i * grid.ny + j] !== 0;
}

/**
 * Contour EXTÉRIEUR d'un morceau, suivi le long des bords de cellules (les trous sont ignorés).
 * Renvoie les sommets [x, y, x, y, …] en mètres, dans le sens trigonométrique, un sommet par changement de direction.
 */
export function traceOuterBoundary(grid: Grid, labels: Uint16Array, piece: number): number[] {
  const { nx, ny, minX, minY, cell } = grid;
  const inside = (i: number, j: number): boolean => i >= 0 && i < nx && j >= 0 && j < ny && labels[i * ny + j] === piece;
  // Départ : cellule la plus basse, puis la plus à gauche ; on longe son bord bas vers l'est, l'intérieur à gauche.
  let si = -1;
  let sj = -1;
  for (let j = 0; j < ny && si < 0; j++) {
    for (let i = 0; i < nx; i++) {
      if (labels[i * ny + j] === piece) {
        si = i;
        sj = j;
        break;
      }
    }
  }
  if (si < 0) return [];
  const out: number[] = [];
  // Directions : 0 = est (+i), 1 = nord (+j), 2 = ouest (−i), 3 = sud (−j).
  const di = [1, 0, -1, 0];
  const dj = [0, 1, 0, -1];
  let vi = si;
  let vj = sj;
  let dir = 0;
  const limit = 4 * nx * ny + 16;
  for (let step = 0; step < limit; step++) {
    // Avance d'une arête.
    vi += di[dir]!;
    vj += dj[dir]!;
    // Cellules devant à gauche et devant à droite du sommet atteint.
    let aheadLeft: boolean;
    let aheadRight: boolean;
    if (dir === 0) {
      aheadLeft = inside(vi, vj);
      aheadRight = inside(vi, vj - 1);
    } else if (dir === 1) {
      aheadLeft = inside(vi - 1, vj);
      aheadRight = inside(vi, vj);
    } else if (dir === 2) {
      aheadLeft = inside(vi - 1, vj - 1);
      aheadRight = inside(vi - 1, vj);
    } else {
      aheadLeft = inside(vi, vj - 1);
      aheadRight = inside(vi - 1, vj - 1);
    }
    let nextDir = dir;
    if (!aheadLeft) nextDir = (dir + 1) % 4; // l'intérieur s'arrête : on tourne à gauche autour de la cellule
    else if (aheadRight) nextDir = (dir + 3) % 4; // l'intérieur déborde à droite : on tourne à droite
    if (nextDir !== dir) out.push(minX + vi * cell, minY + vj * cell);
    dir = nextDir;
    if (vi === si && vj === sj && dir === 0) break;
  }
  return out;
}
