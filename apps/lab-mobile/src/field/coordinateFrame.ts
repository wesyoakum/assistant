// Field coordinate frame computation.
// Given detected/placed landmark positions in ARKit world space,
// compute a transform from world coords to canonical field coords:
//   Origin = home plate
//   +X = toward first base (first-base foul line)
//   +Y = up (field normal)
//   +Z = toward third base (completing right-hand system)

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface FieldCoordinateFrame {
  /** 4x4 column-major matrix: world → field */
  worldToField: number[];
  /** 4x4 column-major matrix: field → world */
  fieldToWorld: number[];
  /** Angle between foul lines in degrees (should be ~90) */
  foulLineAngleDeg: number;
  /** Which landmarks were used */
  landmarksUsed: string[];
}

// Vec3 operations
function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function length(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

function normalize(v: Vec3): Vec3 {
  const len = length(v);
  if (len < 1e-10) return { x: 0, y: 0, z: 0 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

/** Build a 4x4 column-major matrix from 3 axis vectors + origin. */
function mat4FromAxes(x: Vec3, y: Vec3, z: Vec3, origin: Vec3): number[] {
  // Column-major: [col0.x, col0.y, col0.z, col0.w, col1.x, ...]
  return [
    x.x, x.y, x.z, 0,
    y.x, y.y, y.z, 0,
    z.x, z.y, z.z, 0,
    origin.x, origin.y, origin.z, 1,
  ];
}

/** Invert a 4x4 column-major affine matrix (orthonormal rotation + translation). */
function invertAffine(m: number[]): number[] {
  // For an affine matrix [R | t; 0 0 0 1], inverse is [R^T | -R^T * t; 0 0 0 1].
  // Column-major storage: element (row, col) lives at m[col * 4 + row], so the
  // rotation entries are R[row][col] = m[col*4 + row]. The transpose R^T, stored
  // column-major, is therefore just the rows of R read as columns.
  const tx = m[12]!, ty = m[13]!, tz = m[14]!;

  // -R^T * t  (R^T row i dotted with t uses column i of R, i.e. m[i], m[1+i*?]…)
  const itx = -(m[0]! * tx + m[1]! * ty + m[2]! * tz);
  const ity = -(m[4]! * tx + m[5]! * ty + m[6]! * tz);
  const itz = -(m[8]! * tx + m[9]! * ty + m[10]! * tz);

  return [
    m[0]!, m[4]!, m[8]!, 0,
    m[1]!, m[5]!, m[9]!, 0,
    m[2]!, m[6]!, m[10]!, 0,
    itx, ity, itz, 1,
  ];
}

/** Transform a world point to field coordinates using a 4x4 column-major matrix. */
export function transformPoint(point: Vec3, mat: number[]): Vec3 {
  return {
    x: mat[0] * point.x + mat[4] * point.y + mat[8] * point.z + mat[12],
    y: mat[1] * point.x + mat[5] * point.y + mat[9] * point.z + mat[13],
    z: mat[2] * point.x + mat[6] * point.y + mat[10] * point.z + mat[14],
  };
}

export interface LandmarkPositions {
  home_plate?: Vec3;
  first_base?: Vec3;
  second_base?: Vec3;
  third_base?: Vec3;
  rubber?: Vec3;
}

/**
 * Compute the field coordinate frame from placed landmarks.
 *
 * Minimum: home_plate + one of (first_base, third_base).
 * Preferred: home_plate + first_base + third_base.
 *
 * Returns null if insufficient landmarks.
 */
export function computeFieldFrame(landmarks: LandmarkPositions): FieldCoordinateFrame | null {
  const hp = landmarks.home_plate;
  if (!hp) return null;

  const fb = landmarks.first_base;
  const tb = landmarks.third_base;

  if (fb && tb) {
    // Best case: 3 landmarks
    return computeFromThree(hp, fb, tb);
  }

  if (fb) {
    // home + first only: assume 90° diamond, infer third base direction
    return computeFromTwo(hp, fb, "first");
  }

  if (tb) {
    // home + third only: assume 90° diamond, infer first base direction
    return computeFromTwo(hp, tb, "third");
  }

  return null;
}

function computeFromThree(hp: Vec3, fb: Vec3, tb: Vec3): FieldCoordinateFrame {
  const toFirst = normalize(sub(fb, hp));
  const toThird = normalize(sub(tb, hp));

  // Field normal: cross(toFirst, toThird) should point up
  let Y = normalize(cross(toFirst, toThird));
  // Ensure Y points up (positive world Y)
  if (Y.y < 0) {
    Y = { x: -Y.x, y: -Y.y, z: -Y.z };
  }

  // +X = toward first base
  const X = toFirst;

  // +Z = cross(X, Y) — should point toward third base
  const Z = cross(X, Y);

  const foulLineAngle = Math.acos(Math.max(-1, Math.min(1, dot(toFirst, toThird))));
  const foulLineAngleDeg = foulLineAngle * (180 / Math.PI);

  const fieldToWorld = mat4FromAxes(X, Y, Z, hp);
  const worldToField = invertAffine(fieldToWorld);

  return {
    worldToField,
    fieldToWorld,
    foulLineAngleDeg,
    landmarksUsed: ["home_plate", "first_base", "third_base"],
  };
}

// ─── Home plate pose from detected corners ──────────────────────────────────
//
// Phase 0 of the AR world-anchor work (see apps/lab-mobile/AR_WORLD_ANCHOR.md).
// Given the 5 corners of home plate in ARKit world space (from a corner
// detector — classical or learned — back-projected to 3D), recover the plate's
// pose purely from geometry: no model, no compass.
//
// Why no compass/camera hint is needed: home plate's apex (the back point that
// faces the catcher) is the single vertex opposite the 17" front edge, which is
// the longest of the five edges. The apex and the front-edge midpoint both lie
// ON the plate's mirror-symmetry axis, so "toward the pitcher" =
// apex → front-edge-midpoint is unambiguous and invariant under the plate's
// left/right symmetry. Given that forward direction and gravity-up, the
// first-base side is fixed by the world's handedness — matching the convention
// in field/templates.ts (right = toward 1B = cross(up, forward)).

/** Official home plate front edge: 17 inches. */
export const HOME_PLATE_FRONT_EDGE_M = 17 * 0.0254; // 0.4318 m

export interface HomePlatePose {
  /** Plate centroid in world space (used as the field origin). */
  center: Vec3;
  /** The back point of the plate (faces the catcher). */
  apex: Vec3;
  /** Unit vector toward the pitcher / center field (apex → front edge). */
  forward: Vec3;
  /** Unit vector toward first base (cross(up, forward)). */
  right: Vec3;
  /** Ground normal, oriented up. */
  up: Vec3;
  /** Measured length of the detected front (longest) edge, meters. */
  frontEdgeLengthM: number;
  /** |measured / expected − 1| for the front edge. Use to reject bad detections. */
  scaleError: number;
  /** Field coordinate frame anchored at the plate (origin = center, +X→1B, +Y up, +Z→3B). */
  frame: FieldCoordinateFrame;
}

function scale(v: Vec3, s: number): Vec3 {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

/** Component of v removed along n (n must be unit), then renormalized. */
function projectOntoPlane(v: Vec3, n: Vec3): Vec3 {
  const d = dot(v, n);
  return { x: v.x - d * n.x, y: v.y - d * n.y, z: v.z - d * n.z };
}

/** Best-fit plane normal for the (convex, ordered) ring via Newell's method. */
function newellNormal(ring: Vec3[]): Vec3 {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    nx += (a.y - b.y) * (a.z + b.z);
    ny += (a.z - b.z) * (a.x + b.x);
    nz += (a.x - b.x) * (a.y + b.y);
  }
  return normalize({ x: nx, y: ny, z: nz });
}

/** Order corners counter-clockwise (as seen from +normal) around their centroid. */
function orderAroundCentroid(corners: Vec3[], centroid: Vec3, normal: Vec3): Vec3[] {
  // In-plane basis from the first corner.
  let u = projectOntoPlane(sub(corners[0]!, centroid), normal);
  if (length(u) < 1e-9) u = projectOntoPlane(sub(corners[1]!, centroid), normal);
  u = normalize(u);
  const v = cross(normal, u);
  return [...corners].sort((a, b) => {
    const ra = sub(a, centroid);
    const rb = sub(b, centroid);
    const angA = Math.atan2(dot(ra, v), dot(ra, u));
    const angB = Math.atan2(dot(rb, v), dot(rb, u));
    return angA - angB;
  });
}

/**
 * Recover home plate's pose from its 5 detected corners in world space.
 *
 * @param corners exactly 5 world-space points, one per plate corner, in any order.
 * @param opts.groundNormal optional ARKit ground normal; defaults to world up (0,1,0).
 * @returns the plate pose + field frame, or null if the input is degenerate.
 */
export function computeHomePlatePose(
  corners: Vec3[],
  opts: { groundNormal?: Vec3 } = {},
): HomePlatePose | null {
  if (corners.length !== 5) return null;

  const centroid = scale(corners.reduce(add, { x: 0, y: 0, z: 0 }), 1 / 5);

  // Up: prefer the supplied ground normal; else fit the plate's plane.
  const worldUp: Vec3 = { x: 0, y: 1, z: 0 };
  let up = opts.groundNormal ? normalize(opts.groundNormal) : newellNormal(corners);
  if (length(up) < 1e-9) return null;
  if (dot(up, worldUp) < 0) up = scale(up, -1); // orient up

  const ring = orderAroundCentroid(corners, centroid, up);

  // Longest edge = 17" front edge. Track its lower ring index.
  let frontIdx = 0;
  let frontLen = -1;
  for (let i = 0; i < 5; i++) {
    const len = length(sub(ring[(i + 1) % 5]!, ring[i]!));
    if (len > frontLen) { frontLen = len; frontIdx = i; }
  }
  const fA = ring[frontIdx]!;
  const fB = ring[(frontIdx + 1) % 5]!;
  const apex = ring[(frontIdx + 3) % 5]!; // vertex opposite the front edge
  const frontMid = scale(add(fA, fB), 0.5);

  // Forward (toward pitcher) = apex → front-edge midpoint, flattened to ground.
  const forward = normalize(projectOntoPlane(sub(frontMid, apex), up));
  if (length(forward) < 1e-9) return null;
  const right = normalize(cross(up, forward)); // toward first base

  // Field axes match field/templates.ts: X→1B and Z→3B are the 45° diagonals.
  const X = normalize(add(forward, right)); // to1b
  const Z = normalize(sub(forward, right)); // to3b
  const fieldToWorld = mat4FromAxes(X, up, Z, centroid);
  const worldToField = invertAffine(fieldToWorld);

  return {
    center: centroid,
    apex,
    forward,
    right,
    up,
    frontEdgeLengthM: frontLen,
    scaleError: Math.abs(frontLen / HOME_PLATE_FRONT_EDGE_M - 1),
    frame: {
      worldToField,
      fieldToWorld,
      foulLineAngleDeg: 90,
      landmarksUsed: ["home_plate(corners)"],
    },
  };
}

/**
 * Convenience wrapper: the field coordinate frame from detected plate corners.
 * Returns null if the input is degenerate.
 */
export function computeFieldFrameFromCorners(
  corners: Vec3[],
  opts: { groundNormal?: Vec3 } = {},
): FieldCoordinateFrame | null {
  return computeHomePlatePose(corners, opts)?.frame ?? null;
}

function computeFromTwo(hp: Vec3, base: Vec3, which: "first" | "third"): FieldCoordinateFrame {
  const toBase = normalize(sub(base, hp));

  // Assume roughly flat ground: Y is world up
  const Y: Vec3 = { x: 0, y: 1, z: 0 };

  let X: Vec3;
  let Z: Vec3;

  if (which === "first") {
    X = toBase;
    Z = cross(X, Y);
  } else {
    // toBase points toward third; Z = toBase, X = cross(Y, Z)
    Z = toBase;
    X = normalize(cross(Y, Z));
  }

  // Re-orthogonalize
  Z = normalize(cross(X, Y));

  const fieldToWorld = mat4FromAxes(X, Y, Z, hp);
  const worldToField = invertAffine(fieldToWorld);

  return {
    worldToField,
    fieldToWorld,
    foulLineAngleDeg: 90, // assumed
    landmarksUsed: ["home_plate", which === "first" ? "first_base" : "third_base"],
  };
}
