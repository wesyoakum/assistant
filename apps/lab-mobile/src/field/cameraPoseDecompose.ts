// Decompose a ground-plane homography into a 3D camera position.
//
// H maps user ground coords (x→1B, y→2B, meters) → image pixels (u,v).
// Extract the camera's 3D position in user coords (x, y, z meters)
// where z is the height above the ground plane.

// @ts-ignore
import { type Homography } from "./videoHomography.ts";

export interface CameraIntrinsics {
  fx: number; fy: number;
  cx: number; cy: number;
}

export function intrinsicsFromFov(imageWidth: number, imageHeight: number, hFovDeg: number): CameraIntrinsics {
  const fovRad = (hFovDeg > 0 ? hFovDeg : 69) * (Math.PI / 180);
  const fx = (imageWidth / 2) / Math.tan(fovRad / 2);
  return { fx, fy: fx, cx: imageWidth / 2, cy: imageHeight / 2 };
}

export interface CameraPoseResult {
  /** Camera position in user coords (meters): x→1B, y→2B, z→up. */
  position: { x: number; y: number; z: number };
  panDeg: number;
  tiltDeg: number;
  rollDeg: number;
}

export function decomposeCameraPose(
  H: Homography,
  K: CameraIntrinsics,
): CameraPoseResult | null {
  const ifx = 1 / K.fx, ify = 1 / K.fy;
  const Kinv = [ifx, 0, -K.cx * ifx, 0, ify, -K.cy * ify, 0, 0, 1];
  const M = mul3(Kinv, H);
  const c0 = [M[0]!, M[3]!, M[6]!];
  const c1 = [M[1]!, M[4]!, M[7]!];
  const c2 = [M[2]!, M[5]!, M[8]!];

  let lambda = Math.sqrt(c0[0]! * c0[0]! + c0[1]! * c0[1]! + c0[2]! * c0[2]!);
  if (lambda < 1e-10) return null;

  // Sign: ensure origin is in front of camera (positive depth).
  const t2check = c2[2]! / lambda;
  if (t2check < 0) lambda = -lambda;

  const r1 = c0.map((v) => v / lambda);
  const r2 = c1.map((v) => v / lambda);
  const t = c2.map((v) => v / lambda);
  const r3 = cross3(r1, r2);

  // H maps user ground (x, y) → image. So:
  //   Column 0 of [r1|r2|t] corresponds to user X axis (→1B)
  //   Column 1 corresponds to user Y axis (→2B)
  //   r3 = r1 × r2 corresponds to user Z axis (up)
  //
  // Camera position = -R^T * t where R = [r1, r2, r3] as columns.
  const posX = -(r1[0]! * t[0]! + r1[1]! * t[1]! + r1[2]! * t[2]!);
  const posY = -(r2[0]! * t[0]! + r2[1]! * t[1]! + r2[2]! * t[2]!);
  const posZ = -(r3[0]! * t[0]! + r3[1]! * t[1]! + r3[2]! * t[2]!);

  // Camera forward direction in user coords.
  // Forward = r2 direction (maps user Y) — actually it's the camera's -Z axis
  // expressed in user coords. Camera -Z in user = R^T * [0,0,-1].
  // R^T rows = [r1, r2, r3], so camera -Z in user = [-r1[2], -r2[2], -r3[2]].
  const fwdX = -r1[2]!;
  const fwdY = -r2[2]!;
  const fwdZ = -r3[2]!;

  const groundLen = Math.hypot(fwdX, fwdY);
  const panDeg = Math.atan2(fwdX, fwdY) * (180 / Math.PI); // angle from +Y in ground plane
  const tiltDeg = Math.atan2(-fwdZ, groundLen) * (180 / Math.PI); // below horizontal

  const rightZ = -r3[0]!; // camera right's Z component in user coords — indicates roll
  const rightGround = Math.hypot(r1[0]!, r2[0]!);
  const rollDeg = Math.atan2(rightZ, rightGround) * (180 / Math.PI);

  return { position: { x: posX, y: posY, z: posZ }, panDeg, tiltDeg, rollDeg };
}

/**
 * Project a 3D point in user coords (x→1B, y→2B, z→up, meters) to image pixels.
 */
export function projectFieldPoint3D(
  pt: { x: number; y: number; z: number },
  H: Homography,
  K: CameraIntrinsics,
): { u: number; v: number } | null {
  const ifx = 1 / K.fx, ify = 1 / K.fy;
  const Kinv = [ifx, 0, -K.cx * ifx, 0, ify, -K.cy * ify, 0, 0, 1];
  const M = mul3(Kinv, H);
  const c0 = [M[0]!, M[3]!, M[6]!];
  const c1 = [M[1]!, M[4]!, M[7]!];
  const c2 = [M[2]!, M[5]!, M[8]!];

  const lambda1 = Math.sqrt(c0[0]! * c0[0]! + c0[1]! * c0[1]! + c0[2]! * c0[2]!);
  const lambda2 = Math.sqrt(c1[0]! * c1[0]! + c1[1]! * c1[1]! + c1[2]! * c1[2]!);
  if (lambda1 < 1e-10 || lambda2 < 1e-10) return null;
  let lambda = lambda1;
  const t2check = c2[2]! / lambda;
  if (t2check < 0) lambda = -lambda;
  const sign = lambda < 0 ? -1 : 1;

  const r1 = c0.map((v) => v / lambda);
  const r2 = c1.map((v) => v / (sign * lambda2));
  const t = c2.map((v) => v / lambda);
  const r3raw = cross3(r1, r2);
  // Normalize r3 to ensure unit length (compensates for numerical error in homography).
  const r3len = Math.sqrt(r3raw[0]! * r3raw[0]! + r3raw[1]! * r3raw[1]! + r3raw[2]! * r3raw[2]!);
  const r3 = r3len > 1e-10 ? r3raw.map((v) => v / r3len) : r3raw;

  // H maps user ground (x,y). Column 0 = user X, column 1 = user Y, r3 = user Z.
  // cam = R * [pt.x, pt.y, pt.z] + t
  const cx = r1[0]! * pt.x + r2[0]! * pt.y + r3[0]! * pt.z + t[0]!;
  const cy = r1[1]! * pt.x + r2[1]! * pt.y + r3[1]! * pt.z + t[1]!;
  const cz = r1[2]! * pt.x + r2[2]! * pt.y + r3[2]! * pt.z + t[2]!;

  if (cz < 1e-10) return null;
  return { u: K.fx * (cx / cz) + K.cx, v: K.fy * (cy / cz) + K.cy };
}

function mul3(A: number[], B: number[]): number[] {
  const C = new Array(9).fill(0);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      for (let k = 0; k < 3; k++)
        C[r * 3 + c] += A[r * 3 + k]! * B[k * 3 + c]!;
  return C;
}

function cross3(a: number[], b: number[]): number[] {
  return [
    a[1]! * b[2]! - a[2]! * b[1]!,
    a[2]! * b[0]! - a[0]! * b[2]!,
    a[0]! * b[1]! - a[1]! * b[0]!,
  ];
}
