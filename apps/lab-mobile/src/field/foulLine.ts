// Foul-line geometry — Phase B, AR_WORLD_ANCHOR §5 (yaw maintenance).
//
// Once the plate anchor is set, the two foul lines are NOT unknowns: in the
// field frame they are the +X axis (toward 1B) and the +Z axis (toward 3B),
// both radiating from the plate origin on the ground, 90° apart. So foul-line
// detection reduces to: take ground edge points (already raycast to the ground
// and expressed in the field frame), drop everything near the plate — the
// batter's-box chalk lives within ~2m and would otherwise be mistaken for foul
// lines — fit the two expected lines, and measure how far they've rotated from
// the axes. That rotation IS the yaw-drift correction.
//
// Pure geometry (no native/React) → unit-tested in foulLine.test.ts. The native
// edge-point extraction + raycast-to-ground + world→field transform are wired
// later; this module is the analysis core they feed.

// A 2D line in normal form a·x + b·y = c, with (a,b) a unit normal. (Same shape
// as plateDetect's Line2; defined locally so this geometry file stays
// self-contained — matching the repo convention that unit-tested field/*.ts
// files have no sibling-source imports, so they run cleanly under both Metro and
// node --experimental-strip-types.)
export interface Line2 {
  a: number;
  b: number;
  c: number;
}

interface Point2 {
  x: number;
  y: number;
}

/** Total-least-squares (PCA) line fit. Null for < 2 or degenerate points. */
function fitLineTLS(points: Point2[]): { line: Line2; rms: number } | null {
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
  if (sxx + syy < 1e-18) return null;
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const nx = -Math.sin(theta);
  const ny = Math.cos(theta);
  const c = nx * cx + ny * cy;
  const tr = sxx + syy;
  const det = sxx * syy - sxy * sxy;
  const disc = Math.max(0, (tr * 0.5) * (tr * 0.5) - det);
  const lambdaMin = tr * 0.5 - Math.sqrt(disc);
  return { line: { a: nx, b: ny, c }, rms: Math.sqrt(Math.max(0, lambdaMin) / n) };
}

/** TLS fit with one robust pass: fit, drop the worst `trimFrac` by residual, refit. */
function fitLineRobust(points: Point2[], trimFrac = 0.2): { line: Line2; rms: number } | null {
  const first = fitLineTLS(points);
  if (!first || points.length < 5 || trimFrac <= 0) return first;
  const withResid = points
    .map((p) => ({ p, r: Math.abs(first.line.a * p.x + first.line.b * p.y - first.line.c) }))
    .sort((u, v) => u.r - v.r);
  const keep = Math.max(2, Math.floor(points.length * (1 - trimFrac)));
  return fitLineTLS(withResid.slice(0, keep).map((u) => u.p)) ?? first;
}

/** A point on the ground in FIELD-frame meters: x → 1B, z → 3B (y is ~0). */
export interface GroundPointXZ {
  x: number;
  z: number;
}

export interface FoulLineFit {
  /** Fitted 1B foul line (field XZ, mapped as Point2 x=x, y=z), or null. */
  lineFirst: Line2 | null;
  /** Fitted 3B foul line, or null. */
  lineThird: Line2 | null;
  /** Inlier counts per line (points that fit it after the near-plate cut). */
  firstInliers: number;
  thirdInliers: number;
  /**
   * Yaw correction (radians) to rotate the anchor by so its foul-line axes line
   * up with the observed chalk. Positive = counter-clockwise about +Y (up).
   * 0 when neither line is usable.
   */
  yawDriftRad: number;
  /** How close the two observed lines are to the expected 90° apart (radians,
   *  0 = perfectly orthogonal). Large → a bad/ambiguous fit. */
  orthogonalityErrorRad: number;
  /** Soft 0–1 confidence (inlier support × orthogonality), advisory not a gate. */
  confidence: number;
}

/** Map a field ground point to the Point2 plane used by the line fitter. */
function toPlane(p: GroundPointXZ): Point2 {
  return { x: p.x, y: p.z };
}

/** Direction angle (radians) of a line from its normal (a,b): dir ⟂ normal. */
function lineAngle(line: Line2): number {
  // Normal is (a,b); a direction along the line is (-b, a).
  return Math.atan2(line.a, -line.b);
}

/** Wrap an angle difference into (-π/2, π/2] — lines are undirected (θ ≡ θ+π). */
function wrapToHalfPi(d: number): number {
  let x = d;
  while (x > Math.PI / 2) x -= Math.PI;
  while (x <= -Math.PI / 2) x += Math.PI;
  return x;
}

/**
 * Fit the two foul lines from field-frame ground points and recover the yaw
 * drift of the anchor.
 *
 * @param points ground edge points in field-frame meters (x→1B, z→3B).
 * @param opts.excludeRadiusM ignore points within this distance of the plate
 *        (batter's box). Default 2.
 * @param opts.maxRadiusM ignore points beyond this (far noise). Default 40.
 * @param opts.assignToleranceDeg a point is assigned to a foul line only if its
 *        bearing from the plate is within this of the expected axis (0° for 1B,
 *        90° for 3B). Default 25.
 * @param opts.minInliers minimum points to trust a line. Default 6.
 */
export function fitFoulLines(
  points: GroundPointXZ[],
  opts: {
    excludeRadiusM?: number;
    maxRadiusM?: number;
    assignToleranceDeg?: number;
    minInliers?: number;
  } = {},
): FoulLineFit {
  const exclude = opts.excludeRadiusM ?? 2;
  const maxR = opts.maxRadiusM ?? 40;
  const tol = ((opts.assignToleranceDeg ?? 25) * Math.PI) / 180;
  const minInliers = opts.minInliers ?? 6;

  const firstPts: Point2[] = []; // near the +X (1B) axis, bearing ~0
  const thirdPts: Point2[] = []; // near the +Z (3B) axis, bearing ~90°

  for (const p of points) {
    const r = Math.hypot(p.x, p.z);
    if (r < exclude || r > maxR) continue; // drop batter's box + far noise
    // Foul lines are RAYS from the plate toward 1B (+X) and 3B (+Z), so a valid
    // point must lie on the POSITIVE side of the axis (not behind the plate) and
    // within `tol` of it. Use the angle off each axis via dot/cross, which —
    // unlike a wrapped line-angle — distinguishes +X from −X.
    const ux = p.x / r, uz = p.z / r;            // unit bearing
    // Angle from +X axis (1B): cos = ux. Positive side requires ux > 0.
    const offFirst = Math.acos(Math.max(-1, Math.min(1, ux)));
    // Angle from +Z axis (3B): cos = uz. Positive side requires uz > 0.
    const offThird = Math.acos(Math.max(-1, Math.min(1, uz)));
    if (offFirst <= tol) {
      firstPts.push(toPlane(p));
    } else if (offThird <= tol) {
      thirdPts.push(toPlane(p));
    }
  }

  const firstFit = firstPts.length >= minInliers ? fitLineRobust(firstPts) : null;
  const thirdFit = thirdPts.length >= minInliers ? fitLineRobust(thirdPts) : null;

  // Per-line yaw drift: how far the fitted line rotated from its expected axis.
  // 1B line expected along +X (angle 0); 3B line expected along +Z (angle π/2).
  const drifts: { d: number; w: number }[] = [];
  if (firstFit) drifts.push({ d: wrapToHalfPi(lineAngle(firstFit.line) - 0), w: firstPts.length });
  if (thirdFit) drifts.push({ d: wrapToHalfPi(lineAngle(thirdFit.line) - Math.PI / 2), w: thirdPts.length });

  let yawDriftRad = 0;
  if (drifts.length > 0) {
    const wsum = drifts.reduce((s, x) => s + x.w, 0);
    yawDriftRad = drifts.reduce((s, x) => s + x.d * x.w, 0) / wsum;
  }

  // Orthogonality: observed angle between the two lines vs the true 90°.
  let orthogonalityErrorRad = 0;
  if (firstFit && thirdFit) {
    const between = wrapToHalfPi(lineAngle(thirdFit.line) - lineAngle(firstFit.line));
    orthogonalityErrorRad = Math.abs(Math.abs(between) - Math.PI / 2);
  }

  // Confidence: support from both lines + orthogonality. One line alone still
  // gives a yaw estimate but lower confidence.
  const support = Math.min(1, (firstPts.length + thirdPts.length) / (4 * minInliers));
  const bothLines = firstFit && thirdFit ? 1 : 0.5;
  const ortho = firstFit && thirdFit ? Math.max(0, 1 - orthogonalityErrorRad / (15 * Math.PI / 180)) : 1;
  const confidence = clamp01(support * bothLines * ortho);

  return {
    lineFirst: firstFit?.line ?? null,
    lineThird: thirdFit?.line ?? null,
    firstInliers: firstPts.length,
    thirdInliers: thirdPts.length,
    yawDriftRad,
    orthogonalityErrorRad,
    confidence,
  };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
