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

/** Invert a 4x4 column-major affine matrix (rotation + translation). */
function invertAffine(m: number[]): number[] {
  // For an affine matrix [R | t; 0 0 0 1], inverse is [R^T | -R^T * t; 0 0 0 1]
  const r00 = m[0], r10 = m[1], r20 = m[2];
  const r01 = m[4], r11 = m[5], r21 = m[6];
  const r02 = m[8], r12 = m[9], r22 = m[10];
  const tx = m[12], ty = m[13], tz = m[14];

  // R^T
  const it00 = r00, it01 = r10, it02 = r20;
  const it10 = r01, it11 = r11, it12 = r21;
  const it20 = r02, it21 = r12, it22 = r22;

  // -R^T * t
  const itx = -(it00 * tx + it10 * ty + it20 * tz);
  const ity = -(it01 * tx + it11 * ty + it21 * tz);
  const itz = -(it02 * tx + it12 * ty + it22 * tz);

  return [
    it00, it01, it02, 0,
    it10, it11, it12, 0,
    it20, it21, it22, 0,
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
