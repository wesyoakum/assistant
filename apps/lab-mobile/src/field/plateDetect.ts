// Home-plate polygon geometry — Phase A, steps 3–4 of the field-registration
// plan (see apps/lab-mobile/AR_WORLD_ANCHOR.md §4).
//
// This is the pure-geometry layer between the native plate-region detector and
// the existing 3D pose recovery:
//
//   native: region threshold → VNDetectContoursRequest        (image contour)
//      │                                                       ┌─ this file ─┐
//      └─→ simplifyPolygon (Douglas–Peucker)  →  validatePentagon / orderPentagon
//                                                                      │
//      native: raycast each ordered corner to the ground plane  ←──────┘
//                                                                      │
//                          src/field/coordinateFrame.ts → computeHomePlatePose
//
// Everything here works in normalized image space (x, y ∈ [0,1]) and has no
// native or React dependency, so it is unit-tested under Node's built-in runner
// (see plateDetect.test.ts), the same way coordinateFrame.ts is.
//
// The output — 5 ordered, apex-first corners — is exactly the `PlateCorners`
// Stage-1 contract in AR_WORLD_ANCHOR.md. Whatever produces the contour
// (classical region CV now, a Core ML mask later per §10) feeds this unchanged.

export interface Point2 {
  x: number;
  y: number;
}

export interface PlatePentagon {
  /** The 5 corners, ordered apex-first then clockwise in image space. */
  corners: [Point2, Point2, Point2, Point2, Point2];
  /** Index into the *input* polygon of the apex vertex (the catcher-facing point). */
  apexIndex: number;
  /** 0–1 plausibility score from the validation gate (1 = perfect pentagon). */
  confidence: number;
}

// Home plate (MLB/NFHS): 17" front edge, two 8.5" sides, two 12" edges to the
// apex. Both the edge-length profile and the interior-angle profile are strong,
// complementary shape descriptors — the angles in particular separate a plate
// (three ~90° corners + two ~135°) from a near-regular pentagon (five ~108°),
// which the edge lengths alone do not.
//
// Both profiles are written in **apex-first ring order** — apex, then walking the
// ring: apex → side → front-corner → front-corner → side. Perimeter = 58".
const PERIM_IN = 17 + 2 * 8.5 + 2 * 12;
//                                    apex  side  front front side
const CANONICAL_EDGE_FRACS = [12, 8.5, 17, 8.5, 12].map((e) => e / PERIM_IN);
//                                  apex  side front front side   (degrees)
const CANONICAL_ANGLES_DEG = [90, 135, 90, 90, 135];
// Sorted angle multiset — the strongest plate signature: three right angles and
// two 135° corners. Rotation- and winding-invariant, so it cleanly separates a
// plate from a near-regular pentagon (whose angles cluster near 108°). The
// normalizing divisor sets how much angle deviation costs (30° error → ~full).
const CANONICAL_ANGLES_SORTED = [...CANONICAL_ANGLES_DEG].sort((a, b) => a - b);
const ANGLE_ERR_DIVISOR_DEG = 30;

/** Perpendicular distance from point p to the line through a→b. */
function perpDistance(p: Point2, a: Point2, b: Point2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
  // |cross((b-a), (p-a))| / |b-a|
  return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
}

/**
 * Douglas–Peucker polygon simplification (the `approxPolyDP` of AR_WORLD_ANCHOR
 * §4.3). Reduces a dense contour to its salient vertices. `epsilon` is the max
 * allowed perpendicular deviation, in the same units as the points (normalized
 * image space → try ~0.01–0.03).
 *
 * Operates on an open polyline. For a closed contour, see `simplifyClosed`.
 */
export function simplifyPolyline(points: Point2[], epsilon: number): Point2[] {
  if (points.length <= 2) return [...points];
  const first = 0;
  const last = points.length - 1;

  // Find the vertex farthest from the first→last chord.
  let maxDist = -1;
  let maxIdx = -1;
  for (let i = first + 1; i < last; i++) {
    const d = perpDistance(points[i]!, points[first]!, points[last]!);
    if (d > maxDist) { maxDist = d; maxIdx = i; }
  }

  if (maxDist > epsilon && maxIdx > 0) {
    // Recurse on both halves, sharing the split vertex.
    const left = simplifyPolyline(points.slice(first, maxIdx + 1), epsilon);
    const right = simplifyPolyline(points.slice(maxIdx, last + 1), epsilon);
    return [...left.slice(0, -1), ...right];
  }
  // Everything between is within epsilon of the chord — drop it.
  return [points[first]!, points[last]!];
}

/**
 * Douglas–Peucker for a *closed* contour (the plate is a loop). Anchors the
 * simplification at the contour's two extreme points so the result doesn't
 * depend on where the contour list happens to start, then simplifies each arc.
 * Returns the simplified ring (no duplicated closing vertex).
 */
export function simplifyClosed(points: Point2[], epsilon: number): Point2[] {
  if (points.length <= 3) return dedupeRing(points);

  // Anchor 1: farthest point from the centroid. Anchor 2: farthest from anchor 1.
  const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
  const cy = points.reduce((s, p) => s + p.y, 0) / points.length;
  let a = 0;
  let aDist = -1;
  for (let i = 0; i < points.length; i++) {
    const d = Math.hypot(points[i]!.x - cx, points[i]!.y - cy);
    if (d > aDist) { aDist = d; a = i; }
  }
  let b = 0;
  let bDist = -1;
  for (let i = 0; i < points.length; i++) {
    const d = Math.hypot(points[i]!.x - points[a]!.x, points[i]!.y - points[a]!.y);
    if (d > bDist) { bDist = d; b = i; }
  }

  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  // Arc 1: lo → hi. Arc 2: hi → end → lo (wrap).
  const arc1 = points.slice(lo, hi + 1);
  const arc2 = [...points.slice(hi), ...points.slice(0, lo + 1)];
  const s1 = simplifyPolyline(arc1, epsilon);
  const s2 = simplifyPolyline(arc2, epsilon);
  // Stitch, dropping the shared endpoints (lo appears in both, hi appears in both).
  return dedupeRing([...s1.slice(0, -1), ...s2.slice(0, -1)]);
}

/** Remove consecutive (and wrap-around) duplicate points from a ring. */
function dedupeRing(points: Point2[]): Point2[] {
  const out: Point2[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const prev = out[out.length - 1];
    if (!prev || Math.hypot(p.x - prev.x, p.y - prev.y) > 1e-9) out.push(p);
  }
  while (
    out.length > 1 &&
    Math.hypot(out[0]!.x - out[out.length - 1]!.x, out[0]!.y - out[out.length - 1]!.y) < 1e-9
  ) {
    out.pop();
  }
  return out;
}

/** Signed area of a ring (>0 → counter-clockwise in a y-down image is CW visually). */
export function signedArea(ring: Point2[]): number {
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

/** Interior angle (radians) at vertex `i` of the ring. */
function interiorAngle(ring: Point2[], i: number): number {
  const n = ring.length;
  const prev = ring[(i - 1 + n) % n]!;
  const cur = ring[i]!;
  const next = ring[(i + 1) % n]!;
  const v1x = prev.x - cur.x, v1y = prev.y - cur.y;
  const v2x = next.x - cur.x, v2y = next.y - cur.y;
  const dot = v1x * v2x + v1y * v2y;
  const det = v1x * v2y - v1y * v2x;
  return Math.abs(Math.atan2(det, dot));
}

/**
 * Validate that a 5-vertex ring is a plausible home plate and label its apex,
 * the disambiguation/validation gate of AR_WORLD_ANCHOR §4.4 + the accept gate.
 *
 * The apex is the vertex whose interior angle is closest to 90° **and** which sits
 * opposite the longest (front, 17") edge — home plate's apex is the right-angle
 * point between the two 12" edges, diagonally across from the front edge. We pick
 * the longest edge, take the vertex two steps away as the apex candidate, and
 * score the whole shape against the canonical edge-length profile.
 *
 * @returns the ordered pentagon (apex first) + confidence, or null if it fails
 *          the gate (not 5 vertices, non-convex, or shape too far from a plate).
 */
export function validatePentagon(
  ring: Point2[],
  opts: { minConfidence?: number } = {},
): PlatePentagon | null {
  const minConfidence = opts.minConfidence ?? 0.5;
  if (ring.length !== 5) return null;

  // Normalize winding to a consistent orientation (CCW in math coords).
  const oriented = signedArea(ring) < 0 ? [...ring].reverse() : ring;

  // Convexity: every cross product of consecutive edges must share a sign.
  if (!isConvex(oriented)) return null;

  // Edge lengths around the ring; perimeter for normalization.
  const edges: number[] = [];
  for (let i = 0; i < 5; i++) {
    edges.push(Math.hypot(
      oriented[(i + 1) % 5]!.x - oriented[i]!.x,
      oriented[(i + 1) % 5]!.y - oriented[i]!.y,
    ));
  }
  const perim = edges.reduce((s, e) => s + e, 0);
  if (perim < 1e-9) return null;

  // Longest edge = front (17"). Apex = vertex opposite it (index + 3 from the
  // edge's lower endpoint, mirroring computeHomePlatePose's ring math).
  let frontEdge = 0;
  let frontLen = -1;
  for (let i = 0; i < 5; i++) {
    if (edges[i]! > frontLen) { frontLen = edges[i]!; frontEdge = i; }
  }
  const apexIdx = (frontEdge + 3) % 5;

  // Interior angles around the ring (degrees), used as the primary shape
  // descriptor — they separate a plate from a near-regular pentagon, which edge
  // lengths alone do not.
  const anglesDeg: number[] = [];
  for (let i = 0; i < 5; i++) anglesDeg.push((interiorAngle(oriented, i) * 180) / Math.PI);

  // Score the apex-first profiles against canonical, trying both walk directions
  // (the contour winding may run either way) and taking the better match.
  const edgeFracs = edges.map((e) => e / perim);
  const profErr = (dir: 1 | -1) => {
    let edgeErr = 0;
    let angErr = 0;
    for (let k = 0; k < 5; k++) {
      const idx = (((apexIdx + dir * k) % 5) + 5) % 5;
      edgeErr += Math.abs(edgeFracs[idx]! - CANONICAL_EDGE_FRACS[k]!);
      angErr += Math.abs(anglesDeg[idx]! - CANONICAL_ANGLES_DEG[k]!) / 180;
    }
    return { edgeErr: edgeErr / 5, angErr: angErr / 5 };
  };
  const a = profErr(1);
  const b = profErr(-1);
  const best = a.edgeErr + a.angErr <= b.edgeErr + b.angErr ? a : b;

  // Sorted-angle-multiset error — the dominant discriminator. Mean per-corner
  // angle deviation (deg) between this candidate and the plate signature
  // [90,90,90,135,135], normalized by ANGLE_ERR_DIVISOR_DEG.
  const sortedAngles = [...anglesDeg].sort((x, y) => x - y);
  let angSetErr = 0;
  for (let i = 0; i < 5; i++) {
    angSetErr += Math.abs(sortedAngles[i]! - CANONICAL_ANGLES_SORTED[i]!);
  }
  angSetErr = angSetErr / 5 / ANGLE_ERR_DIVISOR_DEG;

  // Confidence: the angle multiset dominates (0.55), ordered angle profile and
  // edge profile refine it.
  const confidence = clamp01(
    1 - (0.55 * angSetErr + 0.25 * best.angErr + 0.2 * best.edgeErr),
  );
  if (confidence < minConfidence) return null;

  // Order apex-first, walking the direction that matched canonical best so the
  // output order is consistent (apex, side, front, front, side).
  const dir = a.edgeErr + a.angErr <= b.edgeErr + b.angErr ? 1 : -1;
  const ordered: Point2[] = [];
  for (let k = 0; k < 5; k++) ordered.push(oriented[(((apexIdx + dir * k) % 5) + 5) % 5]!);

  return {
    corners: ordered as PlatePentagon["corners"],
    apexIndex: apexIdx,
    confidence,
  };
}

function isConvex(ring: Point2[]): boolean {
  let sign = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % n]!;
    const c = ring[(i + 2) % n]!;
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-12) continue; // collinear, ignore
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Full pipeline from a raw contour to an ordered, validated plate pentagon.
 * Tries a small ladder of epsilons (as a fraction of the contour's bounding-box
 * diagonal) until the simplified ring has exactly 5 vertices and passes the gate.
 * Returns null if no epsilon yields a valid plate.
 */
export function detectPlatePentagon(
  contour: Point2[],
  opts: { minConfidence?: number; epsilonFracs?: number[] } = {},
): PlatePentagon | null {
  if (contour.length < 5) return null;
  const diag = boundingDiagonal(contour);
  if (diag < 1e-9) return null;
  const fracs = opts.epsilonFracs ?? [0.02, 0.03, 0.04, 0.05, 0.015, 0.06, 0.08];

  let best: PlatePentagon | null = null;
  for (const f of fracs) {
    const ring = simplifyClosed(contour, f * diag);
    if (ring.length !== 5) continue;
    const pent = validatePentagon(ring, { minConfidence: opts.minConfidence });
    if (pent && (!best || pent.confidence > best.confidence)) best = pent;
  }
  return best;
}

function boundingDiagonal(points: Point2[]): number {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return Math.hypot(maxX - minX, maxY - minY);
}

// ===========================================================================
// Edge-line fitting → corner-by-intersection  (AR_WORLD_ANCHOR §4.5, revised)
// ===========================================================================
//
// A polygon corner is one fragile pixel — blur, dirt, rounding, or a batter's
// foot destroys it. An *edge* is defined by dozens of pixels, so a line fit
// averages out the noise, and the corner we actually want is the **intersection
// of two fitted edge lines** — which stays sharp even when the literal corner is
// mush or fully occluded. This is the document-scanner / fiducial approach and
// it's the key to *re*-establishing the anchor when the plate is partly hidden:
// fit lines to whatever edge segments are visible, intersect, recover corners
// you can't even see.
//
// These operate on 2D points in any single consistent frame. Use them in
// ground-plane metric coords (raycast the contour to the plane first — the plate
// is planar there, no perspective distortion) for the initial fix, or in image
// space for a quick re-lock. Pure geometry → unit-tested in plateFit.test.ts.

/** A 2D line in normal form a·x + b·y = c, with (a,b) a unit normal. */
export interface Line2 {
  a: number;
  b: number;
  c: number;
}

export interface EdgeFit {
  /** The fitted line, or null if too few points to fit. */
  line: Line2 | null;
  /** RMS perpendicular residual of the inlier points (frame units). */
  rms: number;
  /** Number of points the line was fit to (after corner-trim + outlier reject). */
  pointCount: number;
}

export interface CornerRecovery {
  /** 5 corners (apex-first, matching the seed order), each from a line
   *  intersection where possible, else the seed corner as fallback. */
  corners: [Point2, Point2, Point2, Point2, Point2];
  /** Fit for each of the 5 edges; edge i runs from corner i to corner (i+1)%5. */
  edgeFits: EdgeFit[];
  /** Whether each corner came from a confident two-line intersection (vs seed
   *  fallback because an adjacent edge was missing/occluded). */
  cornerOk: [boolean, boolean, boolean, boolean, boolean];
}

/** Total-least-squares (PCA) line fit. Returns the line + RMS perpendicular
 *  residual, or null for < 2 points or a degenerate (point-like) cluster. */
export function fitLineTLS(points: Point2[]): { line: Line2; rms: number } | null {
  const n = points.length;
  if (n < 2) return null;
  let cx = 0, cy = 0;
  for (const p of points) { cx += p.x; cy += p.y; }
  cx /= n; cy /= n;
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of points) {
    const dx = p.x - cx, dy = p.y - cy;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  if (sxx + syy < 1e-18) return null; // all points coincident
  // Major-axis angle (largest-variance direction); normal is perpendicular.
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const nx = -Math.sin(theta);
  const ny = Math.cos(theta);
  const c = nx * cx + ny * cy;
  // Smaller eigenvalue = variance perpendicular to the line.
  const tr = sxx + syy;
  const det = sxx * syy - sxy * sxy;
  const disc = Math.max(0, (tr * 0.5) * (tr * 0.5) - det);
  const lambdaMin = tr * 0.5 - Math.sqrt(disc);
  const rms = Math.sqrt(Math.max(0, lambdaMin) / n);
  return { line: { a: nx, b: ny, c }, rms };
}

/** TLS fit with one robust pass: fit, drop the worst `trimFrac` by perpendicular
 *  residual, refit. Cheap defense against a few stray contour points. */
export function fitLineRobust(points: Point2[], trimFrac = 0.2): { line: Line2; rms: number } | null {
  const first = fitLineTLS(points);
  if (!first || points.length < 5 || trimFrac <= 0) return first;
  const withResid = points
    .map((p) => ({ p, r: Math.abs(first.line.a * p.x + first.line.b * p.y - first.line.c) }))
    .sort((u, v) => u.r - v.r);
  const keep = Math.max(2, Math.floor(points.length * (1 - trimFrac)));
  return fitLineTLS(withResid.slice(0, keep).map((u) => u.p)) ?? first;
}

/** Intersect two lines. Returns null if near-parallel. */
export function intersectLines(l1: Line2, l2: Line2): Point2 | null {
  const det = l1.a * l2.b - l2.a * l1.b;
  if (Math.abs(det) < 1e-9) return null;
  return {
    x: (l1.c * l2.b - l2.c * l1.b) / det,
    y: (l1.a * l2.c - l2.a * l1.c) / det,
  };
}

/** Perpendicular distance from a point to a segment [a,b], plus the projection
 *  parameter t (0 at a, 1 at b). Used to assign contour points to edges. */
function pointToSegment(p: Point2, a: Point2, b: Point2): { dist: number; t: number } {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-18) return { dist: Math.hypot(p.x - a.x, p.y - a.y), t: 0 };
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  const tc = t < 0 ? 0 : t > 1 ? 1 : t;
  const cxp = a.x + tc * dx, cyp = a.y + tc * dy;
  return { dist: Math.hypot(p.x - cxp, p.y - cyp), t };
}

/**
 * Recover corners by fitting the 5 edge lines and intersecting adjacent ones.
 *
 * @param contour dense boundary points (e.g. from VNDetectContours, or raycast
 *                onto the ground plane).
 * @param seedCorners 5 ordered corners (apex-first) — e.g. from
 *                    `detectPlatePentagon`. Used only to segment the contour
 *                    into edges and as fallbacks; the returned corners are the
 *                    refined line intersections.
 * @param opts.cornerTrimFrac fraction of each edge near its endpoints to ignore
 *               (corner rounding/blur contaminates the fit). Default 0.15.
 * @param opts.minEdgePoints minimum inlier points to trust an edge. Default 4.
 * @param opts.maxDriftFrac reject an intersection that lands further than this
 *               fraction of the shape's diagonal from its seed (guards against
 *               near-parallel blow-ups). Default 0.25.
 */
export function fitEdgesAndIntersect(
  contour: Point2[],
  seedCorners: Point2[],
  opts: { cornerTrimFrac?: number; minEdgePoints?: number; maxDriftFrac?: number } = {},
): CornerRecovery | null {
  if (seedCorners.length !== 5 || contour.length < 10) return null;
  const trim = opts.cornerTrimFrac ?? 0.15;
  const minPts = opts.minEdgePoints ?? 4;
  const maxDrift = (opts.maxDriftFrac ?? 0.25) * boundingDiagonal(seedCorners);

  // Assign each contour point to its nearest edge (direction-agnostic), keeping
  // only the central part of the edge (corner-trimmed).
  const edgePoints: Point2[][] = [[], [], [], [], []];
  for (const p of contour) {
    let bestEdge = -1, bestDist = Infinity, bestT = 0;
    for (let e = 0; e < 5; e++) {
      const a = seedCorners[e]!;
      const b = seedCorners[(e + 1) % 5]!;
      const { dist, t } = pointToSegment(p, a, b);
      if (dist < bestDist) { bestDist = dist; bestEdge = e; bestT = t; }
    }
    if (bestEdge >= 0 && bestT >= trim && bestT <= 1 - trim) {
      edgePoints[bestEdge]!.push(p);
    }
  }

  const edgeFits: EdgeFit[] = edgePoints.map((pts) => {
    if (pts.length < minPts) return { line: null, rms: Infinity, pointCount: pts.length };
    const fit = fitLineRobust(pts);
    return fit
      ? { line: fit.line, rms: fit.rms, pointCount: pts.length }
      : { line: null, rms: Infinity, pointCount: pts.length };
  });

  // Corner i is where edge (i-1) meets edge i. Fall back to the seed corner if
  // either edge is missing or the intersection is implausibly far.
  const corners: Point2[] = [];
  const cornerOk: boolean[] = [];
  for (let i = 0; i < 5; i++) {
    const lPrev = edgeFits[(i + 4) % 5]!.line;
    const lCur = edgeFits[i]!.line;
    let corner: Point2 | null = lPrev && lCur ? intersectLines(lPrev, lCur) : null;
    if (corner && Math.hypot(corner.x - seedCorners[i]!.x, corner.y - seedCorners[i]!.y) > maxDrift) {
      corner = null; // near-parallel blow-up
    }
    if (corner) { corners.push(corner); cornerOk.push(true); }
    else { corners.push({ ...seedCorners[i]! }); cornerOk.push(false); }
  }

  return {
    corners: corners as CornerRecovery["corners"],
    edgeFits,
    cornerOk: cornerOk as CornerRecovery["cornerOk"],
  };
}

// ===========================================================================
// Template fit — snap the KNOWN plate onto the observed corners
// ===========================================================================
//
// Philosophy (per the product call): the plate is a *known rigid shape*, so we
// don't gate on "is this shape close enough" — we fit the known pentagon to
// whatever we observed by least squares and ALWAYS return a pose, reporting the
// residual as a soft quality score. A reasonably-close observation places the
// known plate as closely as possible; a rough one still places it, just with a
// higher residual the caller can choose to act on (or not).
//
// Because the plate is planar and we fit on the ground plane, a 2D similarity
// (translate + rotate + uniform scale, 4 DOF) is the exact right model.

/** Canonical home plate in plate-local inches, apex-first to match the ring
 *  order [apex, side, front, front, side]. Apex points +y (toward the catcher);
 *  the 17" front edge lies on y=0 (toward the pitcher). */
const APEX_Y_IN = 8.5 + Math.sqrt(144 - 8.5 * 8.5); // 12" slant edges → ≈16.97"
export const CANONICAL_PLATE_CORNERS_IN: [Point2, Point2, Point2, Point2, Point2] = [
  { x: 0, y: APEX_Y_IN },   // apex   (toward catcher)
  { x: 8.5, y: 8.5 },       // side   (right)
  { x: 8.5, y: 0 },         // front  (right, toward pitcher)
  { x: -8.5, y: 0 },        // front  (left)
  { x: -8.5, y: 8.5 },      // side   (left)
];

export interface PlateTemplateFit {
  /** Centroid of the snapped plate, in the observation frame. */
  center: Point2;
  /** Rotation applied to the canonical template (radians). */
  rotationRad: number;
  /** Uniform scale: observation-frame units per inch. */
  scale: number;
  /** RMS corner residual in the observation frame. */
  rms: number;
  /** RMS residual expressed in inches (rms / scale) — frame-independent quality. */
  rmsInches: number;
  /** The known plate snapped into the frame (apex-first). Guaranteed
   *  plate-shaped regardless of how noisy the observation was. */
  snappedCorners: [Point2, Point2, Point2, Point2, Point2];
  /** Forward direction (toward the pitcher) = front-edge midpoint − apex,
   *  unit-length, consistent with computeHomePlatePose. */
  forward: Point2;
  /** Soft, lenient quality score in (0,1]; advisory, not a gate. */
  confidence: number;
}

/** Weighted 2D similarity (Umeyama) mapping `from` onto `to`. Returns the
 *  transform parameters + RMS residual, or null if degenerate. */
function fitSimilarity(
  from: Point2[],
  to: Point2[],
  weights?: number[],
): { scale: number; rotationRad: number; fromC: Point2; toC: Point2; rms: number } | null {
  const n = from.length;
  if (n < 2 || to.length !== n) return null;
  const w = weights ?? from.map(() => 1);
  let sw = 0;
  for (let i = 0; i < n; i++) sw += w[i]!;
  if (sw < 1e-12) return null;
  let fcx = 0, fcy = 0, tcx = 0, tcy = 0;
  for (let i = 0; i < n; i++) {
    fcx += w[i]! * from[i]!.x; fcy += w[i]! * from[i]!.y;
    tcx += w[i]! * to[i]!.x; tcy += w[i]! * to[i]!.y;
  }
  fcx /= sw; fcy /= sw; tcx /= sw; tcy /= sw;
  let dot = 0, cross = 0, denom = 0;
  for (let i = 0; i < n; i++) {
    const fx = from[i]!.x - fcx, fy = from[i]!.y - fcy;
    const tx = to[i]!.x - tcx, ty = to[i]!.y - tcy;
    dot += w[i]! * (fx * tx + fy * ty);
    cross += w[i]! * (fx * ty - fy * tx);
    denom += w[i]! * (fx * fx + fy * fy);
  }
  if (denom < 1e-18) return null;
  const rotationRad = Math.atan2(cross, dot);
  const scale = Math.hypot(dot, cross) / denom;
  // Residual.
  const cosT = Math.cos(rotationRad), sinT = Math.sin(rotationRad);
  let se = 0;
  for (let i = 0; i < n; i++) {
    const fx = from[i]!.x - fcx, fy = from[i]!.y - fcy;
    const mx = scale * (cosT * fx - sinT * fy) + tcx;
    const my = scale * (sinT * fx + cosT * fy) + tcy;
    se += w[i]! * ((mx - to[i]!.x) ** 2 + (my - to[i]!.y) ** 2);
  }
  return { scale, rotationRad, fromC: { x: fcx, y: fcy }, toC: { x: tcx, y: tcy }, rms: Math.sqrt(se / sw) };
}

/**
 * Fit the known home-plate shape to observed corners and ALWAYS return a pose
 * (no shape gate). Works with as few as 2 valid corners, so an occluded plate
 * still places — the more/better the corners, the lower the residual.
 *
 * @param observed corners in apex-first order, corresponding 1:1 to the
 *                 canonical template. Entries may be null/omitted for missing
 *                 corners; pass `weights` to down-weight low-confidence ones
 *                 (e.g. seed-fallback corners from fitEdgesAndIntersect).
 * @param opts.weights per-corner weights (length 5). Default all 1.
 * @param opts.leniencyInches residual (inches) at which confidence ≈ 0.37.
 *                 Larger = more forgiving. Default 4".
 */
/** Fit one specific template (canonical or mirrored) to the observation. */
function fitOneTemplate(
  template: Point2[],
  observed: (Point2 | null)[],
  idx: number[],
  weights: number[] | undefined,
  leniency: number,
): PlateTemplateFit | null {
  const from = idx.map((i) => template[i]!);
  const to = idx.map((i) => observed[i]!);
  const w = weights ? idx.map((i) => weights[i] ?? 1) : undefined;
  const sim = fitSimilarity(from, to, w);
  if (!sim || sim.scale < 1e-9) return null;

  const cosT = Math.cos(sim.rotationRad), sinT = Math.sin(sim.rotationRad);
  const map = (q: Point2): Point2 => {
    const fx = q.x - sim.fromC.x, fy = q.y - sim.fromC.y;
    return {
      x: sim.scale * (cosT * fx - sinT * fy) + sim.toC.x,
      y: sim.scale * (sinT * fx + cosT * fy) + sim.toC.y,
    };
  };
  const snapped = template.map(map) as PlateTemplateFit["snappedCorners"];

  // Center, and forward = front-edge midpoint − apex (toward pitcher).
  let cx = 0, cy = 0;
  for (const p of snapped) { cx += p.x; cy += p.y; }
  cx /= 5; cy /= 5;
  const apex = snapped[0]!;
  const frontMid = { x: (snapped[2]!.x + snapped[3]!.x) / 2, y: (snapped[2]!.y + snapped[3]!.y) / 2 };
  let fwdx = frontMid.x - apex.x, fwdy = frontMid.y - apex.y;
  const fl = Math.hypot(fwdx, fwdy) || 1;
  fwdx /= fl; fwdy /= fl;

  const rmsInches = sim.rms / sim.scale;
  const confidence = Math.exp(-rmsInches / leniency);

  return {
    center: { x: cx, y: cy },
    rotationRad: sim.rotationRad,
    scale: sim.scale,
    rms: sim.rms,
    rmsInches,
    snappedCorners: snapped,
    forward: { x: fwdx, y: fwdy },
    confidence,
  };
}

/** Canonical plate mirrored across the apex (y) axis — the other valid winding. */
const CANONICAL_PLATE_MIRRORED_IN: Point2[] =
  CANONICAL_PLATE_CORNERS_IN.map((p) => ({ x: -p.x, y: p.y }));

export function fitPlateTemplate(
  observed: (Point2 | null)[],
  opts: { weights?: number[]; leniencyInches?: number } = {},
): PlateTemplateFit | null {
  const idx: number[] = [];
  for (let i = 0; i < 5; i++) if (observed[i]) idx.push(i);
  if (idx.length < 2) return null;
  const leniency = opts.leniencyInches ?? 4;

  // A 2D similarity has no reflection, so a clockwise-vs-CCW winding mismatch
  // between the observed corners and the template would force a mirrored, garbage
  // fit. Try both windings and keep the lower-residual one.
  const a = fitOneTemplate(CANONICAL_PLATE_CORNERS_IN, observed, idx, opts.weights, leniency);
  const b = fitOneTemplate(CANONICAL_PLATE_MIRRORED_IN, observed, idx, opts.weights, leniency);
  if (!a) return b;
  if (!b) return a;
  return a.rmsInches <= b.rmsInches ? a : b;
}

// ===========================================================================
// Pipeline aggregator — every intermediate, for the debug overlay
// ===========================================================================
//
// Runs the full classical detect path on one contour and returns each stage's
// output so a UI can draw them as toggleable layers:
//   region/outline (the input contour) · DP seed corners · 5 edge lines ·
//   line intersections (recovered corners) · snapped known-plate outline.
// Pure function (no native/React) — unit-tested in plateFit.test.ts. The
// `endpoints` on each edge line are just the segment between its two adjacent
// recovered corners, so the UI can draw a finite blue segment instead of an
// infinite line.

export interface EdgeLineViz {
  line: Line2;
  /** Segment endpoints for drawing (between adjacent recovered corners). */
  from: Point2;
  to: Point2;
  rms: number;
  pointCount: number;
}

export interface PlatePipelineDebug {
  /** The traced region boundary (input contour) — draw filled + stroked. */
  contour: Point2[];
  /** Douglas–Peucker seed corners (rough), or null if no clean 5-gon found. */
  seedCorners: Point2[] | null;
  /** Confidence of the DP pentagon gate (0–1), if seedCorners exists. */
  seedConfidence: number | null;
  /** The 5 fitted edge lines with drawable endpoints (only those that fit). */
  edgeLines: EdgeLineViz[];
  /** Recovered corners from line intersection (apex-first), or null. */
  intersections: Point2[] | null;
  /** Which recovered corners came from a real intersection vs seed fallback. */
  cornerOk: boolean[] | null;
  /** The known plate snapped onto the recovered (or seed) corners, or null. */
  snappedCorners: Point2[] | null;
  /** Snap residual in inches (lower = better), advisory only. */
  snappedRmsInches: number | null;
  /** Soft overall confidence from the template fit (0–1), advisory. */
  confidence: number | null;
}

/**
 * Run region→DP→edge-fit→intersect→template-snap on one contour, capturing
 * every intermediate for visualization. Never throws; fills as much as it can
 * and leaves later stages null if an earlier one can't produce input.
 */
export function runPlatePipelineDebug(
  contour: Point2[],
  opts: {
    minConfidence?: number;
    epsilonFracs?: number[];
    cornerTrimFrac?: number;
    minEdgePoints?: number;
    leniencyInches?: number;
  } = {},
): PlatePipelineDebug {
  const result: PlatePipelineDebug = {
    contour,
    seedCorners: null,
    seedConfidence: null,
    edgeLines: [],
    intersections: null,
    cornerOk: null,
    snappedCorners: null,
    snappedRmsInches: null,
    confidence: null,
  };
  if (contour.length < 5) return result;

  // Stage: DP seed corners (minConfidence 0 — we want the seeds even for a rough
  // shape; the template fit, not a gate, decides final quality).
  const pent = detectPlatePentagon(contour, {
    minConfidence: opts.minConfidence ?? 0,
    epsilonFracs: opts.epsilonFracs,
  });
  if (!pent) return result;
  result.seedCorners = pent.corners;
  result.seedConfidence = pent.confidence;

  // Stage: edge-line fit + intersection.
  const rec = fitEdgesAndIntersect(contour, pent.corners, {
    cornerTrimFrac: opts.cornerTrimFrac,
    minEdgePoints: opts.minEdgePoints,
  });

  // Determine the corner set to draw lines/snap against.
  const cornerSet = rec ? rec.corners : pent.corners;

  if (rec) {
    result.intersections = rec.corners;
    result.cornerOk = rec.cornerOk;
    // Build drawable segments for each fitted edge (corner i → corner i+1).
    rec.edgeFits.forEach((ef, i) => {
      if (!ef.line) return;
      result.edgeLines.push({
        line: ef.line,
        from: cornerSet[i]!,
        to: cornerSet[(i + 1) % 5]!,
        rms: ef.rms,
        pointCount: ef.pointCount,
      });
    });
  }

  // Stage: snap the known plate. Weight intersection-backed corners fully,
  // seed-fallback corners lightly (they're less trustworthy).
  const weights = rec ? rec.cornerOk.map((ok) => (ok ? 1 : 0.25)) : undefined;
  const fit = fitPlateTemplate(cornerSet, {
    weights,
    leniencyInches: opts.leniencyInches,
  });
  if (fit) {
    result.snappedCorners = fit.snappedCorners;
    result.snappedRmsInches = fit.rmsInches;
    result.confidence = fit.confidence;
  }
  return result;
}
