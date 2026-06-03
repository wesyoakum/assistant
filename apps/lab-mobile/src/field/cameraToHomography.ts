// Build a ground-plane homography from a known camera pose.
//
// All inputs and outputs are in user coordinates:
//   X→1B (parallel to front edge), Y→2B (along diagonal), Z→up.
//   Units: meters.
//
// H maps user ground (x, y meters) → image pixels (u, v).

export interface HomographyResult {
  H: number[];
  Hinv: number[];
  rmsPx: number;
  count: number;
}

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
 * Build H from camera pose, all in user coordinates (meters).
 *
 * @param camPos Camera position {x, y, z} in user coords.
 * @param focusPos Look-at point {x, y, z} in user coords.
 * @param hFovDeg Horizontal FOV in degrees.
 * @param imageWidth Image width in pixels.
 * @param imageHeight Image height in pixels.
 */
export function buildHomographyFromCamera(
  camPos: { x: number; y: number; z: number },
  focusPos: { x: number; y: number; z: number },
  hFovDeg: number,
  imageWidth: number,
  imageHeight: number,
): HomographyResult | null {
  // Camera axes in user frame.
  // Forward = normalize(focus - cam)
  const fwd = [focusPos.x - camPos.x, focusPos.y - camPos.y, focusPos.z - camPos.z];
  if (normalize3(fwd) < 1e-10) return null;

  // World up in user coords = (0, 0, 1)
  const worldUp = [0, 0, 1];

  // Right = forward × up
  const right = cross3(fwd, worldUp);
  if (normalize3(right) < 1e-10) return null;

  // Up = right × forward
  const up = cross3(right, fwd);
  normalize3(up);

  // Rotation matrix R: maps user-frame point to camera frame.
  // Camera frame: x=right, y=up, z=-forward.
  // R rows = [right, up, -fwd]
  const R = [
    right[0]!, right[1]!, right[2]!,
    up[0]!, up[1]!, up[2]!,
    -fwd[0]!, -fwd[1]!, -fwd[2]!,
  ];

  // Translation: t = -R * cam
  const t = [
    -(R[0]! * camPos.x + R[1]! * camPos.y + R[2]! * camPos.z),
    -(R[3]! * camPos.x + R[4]! * camPos.y + R[5]! * camPos.z),
    -(R[6]! * camPos.x + R[7]! * camPos.y + R[8]! * camPos.z),
  ];

  // Intrinsics K
  const fovRad = (hFovDeg > 0 ? hFovDeg : 69) * (Math.PI / 180);
  const fx = (imageWidth / 2) / Math.tan(fovRad / 2);
  const K = [fx, 0, imageWidth / 2, 0, fx, imageHeight / 2, 0, 0, 1];

  // Ground-plane homography: H maps user (x, y) → image (u, v).
  // For ground points, z = 0. Full projection: p = K * [R|t] * [x, y, z, 1]
  // With z=0: p = K * [R_col0 | R_col1 | t] * [x, y, 1]
  // R columns (from row-major R):
  //   col0 = [R[0], R[3], R[6]] — user X axis
  //   col1 = [R[1], R[4], R[7]] — user Y axis
  //   col2 = [R[2], R[5], R[8]] — user Z axis (skipped, z=0)
  const Rt_ground = [
    R[0]!, R[1]!, t[0]!,
    R[3]!, R[4]!, t[1]!,
    R[6]!, R[7]!, t[2]!,
  ];

  const H = mul3(K, Rt_ground);
  const h8 = H[8]!;
  if (Math.abs(h8) < 1e-15) return null;
  for (let i = 0; i < 9; i++) H[i]! /= h8;

  const Hinv = inv3(H);
  if (!Hinv) return null;

  return { H, Hinv, rmsPx: 0, count: 0 };
}

/**
 * Project a user ground point through H to image pixels.
 */
export function projectGroundPoint(
  H: number[],
  x: number,
  y: number,
): { u: number; v: number } | null {
  const w = H[6]! * x + H[7]! * y + H[8]!;
  if (Math.abs(w) < 1e-12) return null;
  return {
    u: (H[0]! * x + H[1]! * y + H[2]!) / w,
    v: (H[3]! * x + H[4]! * y + H[5]!) / w,
  };
}
