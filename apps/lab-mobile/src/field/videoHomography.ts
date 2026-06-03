// Field↔image homography for video reconciliation (see VIDEO_ANALYSIS.md).
//
// Every field landmark we use lies on the ground plane, so the mapping between
// field ground coordinates (x→1B, z→3B, feet) and image pixels (u, v) is a single
// 3×3 homography H. For the on-ground scope (no airborne 3D), this is ALL we need:
//   • fieldToImage(H, p)  — project a field point onto the frame (draw overlays)
//   • imageToField(Hinv, q) — back-project an on-ground pixel to field coords
// No camera intrinsics, no pose decomposition required — the homography captures
// both directions directly. (Pose/focal decomposition would only be needed for
// elevated geometry, which is out of scope.)
//
// H is fit from ≥4 correspondences by the normalized Direct Linear Transform
// (DLT) + a tiny Jacobi SVD for the null vector. Pure math, no deps →
// unit-tested in videoHomography.test.ts against synthetic homographies.

export interface Pt2 { x: number; y: number }
/** Ground point (user coords x,y meters) ↔ image pixel (u,v). */
export interface Correspondence {
  field: { x: number; y: number };
  image: { u: number; v: number };
}

/**
 * A field line ↔ image line correspondence. The line is given by TWO points on
 * it in each space — they need not be the line's true endpoints (e.g. tap any
 * two spots on the visible foul chalk; give two field points on that foul line,
 * like the apex (0,0) and 1B (basePath,0)). A line constrains the homography as
 * tightly as a point pair (2 DLT rows), and lets you register when a line's true
 * endpoints (plate apex, foul pole) aren't both in frame.
 */
export interface LineCorrespondence {
  /** Two distinct field points (x,z) lying on the field line. */
  field: [{ x: number; y: number }, { x: number; y: number }];
  /** Two distinct image points (u,v) lying on the observed image line (the taps). */
  image: [{ u: number; v: number }, { u: number; v: number }];
}

/** Row-major 3×3 homography (h[0..8]). Maps homogeneous [x z 1] → [u v 1]. */
export type Homography = number[];

export interface HomographyFit {
  H: Homography;
  Hinv: Homography;
  /** RMS reprojection error in pixels over the input correspondences. */
  rmsPx: number;
  /** Number of correspondences used. */
  count: number;
}

/** Apply a 3×3 (row-major) homography to a 2D point (with the homogeneous divide). */
export function applyHomography(H: Homography, x: number, y: number): Pt2 | null {
  const w = H[6]! * x + H[7]! * y + H[8]!;
  if (Math.abs(w) < 1e-12) return null;
  return {
    x: (H[0]! * x + H[1]! * y + H[2]!) / w,
    y: (H[3]! * x + H[4]! * y + H[5]!) / w,
  };
}

/** Project a field ground point (x,z) onto the image. */
export function fieldToImage(H: Homography, p: { x: number; y: number }): Pt2 | null {
  return applyHomography(H, p.x, p.y);
}

/** Back-project an on-ground image pixel (u,v) to field coords (x,z). */
export function imageToField(Hinv: Homography, q: { u: number; v: number }): { x: number; y: number } | null {
  const r = applyHomography(Hinv, q.u, q.v);
  return r ? { x: r.x, y: r.y } : null;
}

/**
 * Fit the field→image homography from point and/or line correspondences
 * (normalized DLT). Each point gives 2 equations; each line also gives 2 (via
 * its two defining points), so the constraint count is 2·(points + lines) and we
 * need ≥4 total (e.g. 4 points, or 2 lines + a point, or 2 lines + 2 points).
 *
 * Lines are handled by feeding their two defining points into the SAME point-DLT
 * — a homography that maps two field points onto two image points on the
 * observed line necessarily maps the field line onto the image line. Since the
 * defining points are arbitrary points on each line (not matched endpoints),
 * this is exactly a line constraint, and the apex etc. come out as intersections
 * for free. Returns null if degenerate (too few constraints, collinear, singular).
 */
export function fitHomography(
  corr: Correspondence[],
  lines: LineCorrespondence[] = [],
): HomographyFit | null {
  // Expand each line into its two point pairs for the DLT. (These extra points
  // are used only to constrain the fit; RMS is still reported on the real point
  // correspondences plus a line-distance term below.)
  const pointPairs: Correspondence[] = [...corr];
  for (const ln of lines) {
    pointPairs.push({ field: ln.field[0], image: ln.image[0] });
    pointPairs.push({ field: ln.field[1], image: ln.image[1] });
  }
  if (pointPairs.length < 4) return null;

  const src = pointPairs.map((c) => ({ x: c.field.x, y: c.field.y }));
  const dst = pointPairs.map((c) => ({ x: c.image.u, y: c.image.v }));

  // Normalize both point sets (Hartley): translate to centroid, scale so mean
  // distance is √2. Greatly improves DLT conditioning.
  const Ns = normalizer(src);
  const Nd = normalizer(dst);
  if (!Ns || !Nd) return null;
  const sn = src.map((p) => applyAffine(Ns.T, p));
  const dn = dst.map((p) => applyAffine(Nd.T, p));

  // Build the 2N×9 DLT matrix A; solve A h = 0 via the smallest singular vector.
  const A: number[][] = [];
  for (let i = 0; i < sn.length; i++) {
    const { x, y } = sn[i]!;
    const { x: u, y: v } = dn[i]!;
    A.push([-x, -y, -1, 0, 0, 0, u * x, u * y, u]);
    A.push([0, 0, 0, -x, -y, -1, v * x, v * y, v]);
  }
  const h = smallestSingularVector(A); // length-9
  if (!h) return null;

  // Hn maps normalized-src → normalized-dst. Denormalize: H = Nd^-1 · Hn · Ns.
  const Hn = [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!, h[8]!];
  const H = mul3(mul3(inv3(Nd.T)!, Hn), Ns.T);
  // Scale so H[8] = 1 (when non-degenerate) for stable comparison.
  const s = Math.abs(H[8]!) > 1e-12 ? 1 / H[8]! : 1;
  for (let i = 0; i < 9; i++) H[i]! *= s;

  const Hinv = inv3(H);
  if (!Hinv) return null;

  // RMS: point reprojection error, plus for each line the perpendicular distance
  // of each projected field-line point to the observed image line (so the metric
  // reflects line fit, not the arbitrary chosen points).
  let se = 0;
  let terms = 0;
  for (const c of corr) {
    const p = fieldToImage(H, c.field);
    if (!p) return null;
    se += (p.x - c.image.u) ** 2 + (p.y - c.image.v) ** 2;
    terms++;
  }
  for (const ln of lines) {
    const line = lineThrough(ln.image[0], ln.image[1]); // image line a·u+b·v+c=0, (a,b) unit
    if (!line) continue;
    for (const fp of ln.field) {
      const p = fieldToImage(H, fp);
      if (!p) return null;
      const d = line.a * p.x + line.b * p.y + line.c; // signed perp distance
      se += d * d;
      terms++;
    }
  }
  if (terms === 0) return null;
  const rmsPx = Math.sqrt(se / terms);

  return { H, Hinv, rmsPx, count: corr.length + lines.length };
}

/** Image line through two points, normal form a·u+b·v+c=0 with (a,b) unit. Null if coincident. */
function lineThrough(p: { u: number; v: number }, q: { u: number; v: number }): { a: number; b: number; c: number } | null {
  let a = q.v - p.v;
  let b = p.u - q.u;
  const n = Math.hypot(a, b);
  if (n < 1e-12) return null;
  a /= n; b /= n;
  return { a, b, c: -(a * p.u + b * p.v) };
}

// ── linear-algebra helpers (3×3 + small SVD) ───────────────────────────────

interface Norm { T: number[] } // row-major 3×3 similarity (normalization) matrix

function normalizer(pts: Pt2[]): Norm | null {
  const n = pts.length;
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p.x; cy += p.y; }
  cx /= n; cy /= n;
  let meanDist = 0;
  for (const p of pts) meanDist += Math.hypot(p.x - cx, p.y - cy);
  meanDist /= n;
  if (meanDist < 1e-12) return null;
  const s = Math.SQRT2 / meanDist;
  // T = [[s,0,-s*cx],[0,s,-s*cy],[0,0,1]]
  return { T: [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1] };
}

function applyAffine(T: number[], p: Pt2): Pt2 {
  return { x: T[0]! * p.x + T[1]! * p.y + T[2]!, y: T[3]! * p.x + T[4]! * p.y + T[5]! };
}

function mul3(A: number[], B: number[]): number[] {
  const C = new Array(9).fill(0);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      for (let k = 0; k < 3; k++)
        C[r * 3 + c] += A[r * 3 + k]! * B[k * 3 + c]!;
  return C;
}

function inv3(m: number[]): number[] | null {
  const [a, b, c, d, e, f, g, h, i] = m as [number, number, number, number, number, number, number, number, number];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-15) return null;
  const id = 1 / det;
  return [
    A * id, (c * h - b * i) * id, (b * f - c * e) * id,
    B * id, (a * i - c * g) * id, (c * d - a * f) * id,
    C * id, (b * g - a * h) * id, (a * e - b * d) * id,
  ];
}

/**
 * Smallest singular vector of A (the null-space direction), via eigen-decomposition
 * of AᵀA by cyclic Jacobi rotation. A is 2N×9 → AᵀA is 9×9 symmetric. Returns the
 * eigenvector of the smallest eigenvalue (length 9), or null.
 */
function smallestSingularVector(A: number[][]): number[] | null {
  const n = 9;
  // M = AᵀA  (9×9 symmetric)
  const M: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (const row of A) {
    for (let i = 0; i < n; i++) {
      if (row[i] === 0) continue;
      for (let j = i; j < n; j++) {
        const val = row[i]! * row[j]!;
        M[i]![j]! += val;
        if (i !== j) M[j]![i]! += val;
      }
    }
  }
  // V accumulates eigenvectors.
  const V: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));

  for (let sweep = 0; sweep < 100; sweep++) {
    // Largest off-diagonal magnitude.
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += M[p]![q]! * M[p]![q]!;
    if (off < 1e-20) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = M[p]![q]!;
        if (Math.abs(apq) < 1e-18) continue;
        const app = M[p]![p]!, aqq = M[q]![q]!;
        const phi = 0.5 * Math.atan2(2 * apq, aqq - app);
        const c = Math.cos(phi), s = Math.sin(phi);
        for (let k = 0; k < n; k++) {
          const mkp = M[k]![p]!, mkq = M[k]![q]!;
          M[k]![p]! = c * mkp - s * mkq;
          M[k]![q]! = s * mkp + c * mkq;
        }
        for (let k = 0; k < n; k++) {
          const mpk = M[p]![k]!, mqk = M[q]![k]!;
          M[p]![k]! = c * mpk - s * mqk;
          M[q]![k]! = s * mpk + c * mqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k]![p]!, vkq = V[k]![q]!;
          V[k]![p]! = c * vkp - s * vkq;
          V[k]![q]! = s * vkp + c * vkq;
        }
      }
    }
  }
  // Smallest eigenvalue = smallest diagonal of M; its eigenvector = that column of V.
  let minIdx = 0, minVal = Infinity;
  for (let i = 0; i < n; i++) {
    if (M[i]![i]! < minVal) { minVal = M[i]![i]!; minIdx = i; }
  }
  const v = V.map((row) => row[minIdx]!);
  const norm = Math.hypot(...v);
  if (norm < 1e-15) return null;
  return v.map((x) => x / norm);
}
