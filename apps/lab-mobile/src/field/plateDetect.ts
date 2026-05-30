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
