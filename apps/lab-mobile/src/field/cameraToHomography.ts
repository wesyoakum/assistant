// Build a ground-plane homography from a known camera pose.
//
// Given camera position, look-at point, and FOV, construct the
// homography H that maps field ground coordinates (internal frame:
// x→1B foul, z→3B foul, feet) to image pixels (u, v).
//
// User coordinate system: X→1B, Y→2B, Z→up (meters)
// Internal field frame: x→1B foul, y→up, z→3B foul (feet)
//
// The camera position and focus point are in USER coordinates (meters).
// We convert to internal field (feet) to build H.

const DIAG = Math.SQRT1_2;
const M_TO_FT = 1 / 0.3048;

export interface HomographyResult {
  H: number[];     // 3×3 row-major, maps field (x,z) → image (u,v)
  Hinv: number[];  // 3×3 row-major, maps image (u,v) → field (x,z)
  rmsPx: number;
  count: number;
}

/** Convert user coords (meters) to internal field frame (feet). */
function userToField(ux: number, uy: number, uz: number): { x: number; y: number; z: number } {
  // User X = (field_x - field_z) * DIAG * FT_TO_M → field_x - field_z = ux * M_TO_FT / DIAG
  // User Y = (field_x + field_z) * DIAG * FT_TO_M → field_x + field_z = uy * M_TO_FT / DIAG
  // User Z = field_y * FT_TO_M → field_y = uz * M_TO_FT
  const sum = uy * M_TO_FT / DIAG;   // field_x + field_z
  const diff = ux * M_TO_FT / DIAG;  // field_x - field_z
  return {
    x: (sum + diff) / 2,
    y: uz * M_TO_FT,
    z: (sum - diff) / 2,
  };
}

/** Normalize a 3-vector in place, return length. */
function normalize3(v: number[]): number {
  const len = Math.hypot(v[0]!, v[1]!, v[2]!);
  if (len > 1e-10) { v[0]! /= len; v[1]! /= len; v[2]! /= len; }
  return len;
}

function cross3(a: number[], b: number[]): number[] {
  return [
    a[1]! * b[2]! - a[2]! * b[1]!,
    a[2]! * b[0]! - a[0]! * b[2]!,
    a[0]! * b[1]! - a[1]! * b[0]!,
  ];
}

function dot3(a: number[], b: number[]): number {
  return a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
}

/** Multiply two 3×3 row-major matrices. */
function mul3(A: number[], B: number[]): number[] {
  const C = new Array(9).fill(0);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      for (let k = 0; k < 3; k++)
        C[r * 3 + c] += A[r * 3 + k]! * B[k * 3 + c]!;
  return C;
}

/** Invert a 3×3 row-major matrix. */
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
 * Build a ground-plane homography from camera pose.
 *
 * @param camUser Camera position in user coords (meters): {x, y, z}
 * @param focusUser Look-at point in user coords (meters): {x, y, z}
 * @param hFovDeg Horizontal field-of-view in degrees
 * @param imageWidth Image width in pixels
 * @param imageHeight Image height in pixels
 */
export function buildHomographyFromCamera(
  camUser: { x: number; y: number; z: number },
  focusUser: { x: number; y: number; z: number },
  hFovDeg: number,
  imageWidth: number,
  imageHeight: number,
): HomographyResult | null {
  // Convert to internal field frame (feet).
  const cam = userToField(camUser.x, camUser.y, camUser.z);
  const focus = userToField(focusUser.x, focusUser.y, focusUser.z);

  // Build camera coordinate axes in field frame.
  // Forward = normalize(focus - cam)
  const fwd = [focus.x - cam.x, focus.y - cam.y, focus.z - cam.z];
  if (normalize3(fwd) < 1e-10) return null;

  // World up in internal field = (0, 1, 0)
  const worldUp = [0, 1, 0];

  // Right = normalize(fwd × worldUp)
  const right = cross3(fwd, worldUp);
  if (normalize3(right) < 1e-10) return null;

  // Up = right × fwd (already orthogonal)
  const up = cross3(right, fwd);
  normalize3(up);

  // Rotation matrix R: maps world point to camera frame.
  // Camera frame: x=right, y=up, z=-forward (standard OpenGL/CV convention).
  // R rows = [right, up, -fwd]
  const R = [
    right[0]!, right[1]!, right[2]!,
    up[0]!, up[1]!, up[2]!,
    -fwd[0]!, -fwd[1]!, -fwd[2]!,
  ];

  // Translation: t = -R * cam
  const t = [
    -(R[0]! * cam.x + R[1]! * cam.y + R[2]! * cam.z),
    -(R[3]! * cam.x + R[4]! * cam.y + R[5]! * cam.z),
    -(R[6]! * cam.x + R[7]! * cam.y + R[8]! * cam.z),
  ];

  // Intrinsic matrix K.
  const fovRad = (hFovDeg > 0 ? hFovDeg : 69) * (Math.PI / 180);
  const fx = (imageWidth / 2) / Math.tan(fovRad / 2);
  const cx = imageWidth / 2;
  const cy = imageHeight / 2;
  const K = [
    fx, 0, cx,
    0, fx, cy,
    0, 0, 1,
  ];

  // Ground-plane homography: H maps field (x, z) → image (u, v).
  // For ground points, field_y = 0.
  // The full projection is: p = K * [R|t] * [x, y, z, 1]^T
  // With y=0: p = K * [r_col0 | r_col2 | t] * [x, z, 1]^T
  // (we skip column 1 of R since y=0 zeroes it out)
  //
  // R columns (in row-major R):
  //   col0 = [R[0], R[3], R[6]] — field X axis (→1B foul)
  //   col1 = [R[1], R[4], R[7]] — field Y axis (up) — skipped
  //   col2 = [R[2], R[5], R[8]] — field Z axis (→3B foul)

  const Rt_ground = [
    R[0]!, R[2]!, t[0]!,
    R[3]!, R[5]!, t[1]!,
    R[6]!, R[8]!, t[2]!,
  ];

  const H = mul3(K, Rt_ground);

  // Normalize so H[8] = 1.
  const h8 = H[8]!;
  if (Math.abs(h8) < 1e-15) return null;
  for (let i = 0; i < 9; i++) H[i]! /= h8;

  const Hinv = inv3(H);
  if (!Hinv) return null;

  return { H, Hinv, rmsPx: 0, count: 0 };
}

/**
 * Project a field ground point (internal x, z in feet) to image pixels
 * using the camera-derived homography.
 */
export function projectGroundPoint(
  H: number[],
  fieldX: number,
  fieldZ: number,
): { u: number; v: number } | null {
  const w = H[6]! * fieldX + H[7]! * fieldZ + H[8]!;
  if (Math.abs(w) < 1e-12) return null;
  return {
    u: (H[0]! * fieldX + H[1]! * fieldZ + H[2]!) / w,
    v: (H[3]! * fieldX + H[4]! * fieldZ + H[5]!) / w,
  };
}
