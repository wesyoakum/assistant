// Decompose a ground-plane homography into a 3D camera position.
//
// Given H that maps field ground coords (x,z) feet → image pixels (u,v),
// and estimated camera intrinsics K, extract the camera's 3D position
// in the internal field frame (X→1B, Y→up, Z→3B, feet).
//
// Standard approach: H ~ K [r1 | r2 | t] where r1,r2 are rotation columns.
// Camera position in world = -R^T * t.

// @ts-ignore .ts extension needed for node test runner
import { type Homography } from "./videoHomography.ts";

export interface CameraIntrinsics {
  fx: number; fy: number;
  cx: number; cy: number;
}

/**
 * Build intrinsics from image dimensions and horizontal FOV.
 * @param hFovDeg Horizontal field-of-view in degrees (0 = use default ~69° estimate).
 */
export function intrinsicsFromFov(imageWidth: number, imageHeight: number, hFovDeg: number): CameraIntrinsics {
  const fovRad = (hFovDeg > 0 ? hFovDeg : 69) * (Math.PI / 180);
  const fx = (imageWidth / 2) / Math.tan(fovRad / 2);
  return { fx, fy: fx, cx: imageWidth / 2, cy: imageHeight / 2 };
}

export interface CameraPoseResult {
  /** Camera position in internal field frame (feet). */
  position: { x: number; y: number; z: number };
  /** Camera orientation angles in degrees.
   *  pan: horizontal angle of the camera's forward direction projected onto
   *       the ground plane, measured from the field +X axis (→1B foul line).
   *       0° = looking along +X, 90° = looking along +Z (→3B).
   *  tilt: angle below the horizontal (positive = looking down).
   *  roll: rotation around the viewing axis (positive = CW from camera's POV). */
  panDeg: number;
  tiltDeg: number;
  rollDeg: number;
}

/** Decompose the ground-plane homography to get camera position and orientation. */
export function decomposeCameraPose(
  H: Homography,
  K: CameraIntrinsics,
): CameraPoseResult | null {
  // K^-1 (3x3, simplified for our diagonal+translation K)
  const ifx = 1 / K.fx, ify = 1 / K.fy;
  const Kinv = [
    ifx, 0,   -K.cx * ifx,
    0,   ify, -K.cy * ify,
    0,   0,   1,
  ];

  // M = Kinv * H  (3x3)
  const M = mul3(Kinv, H);

  // Columns of M
  const c0 = [M[0]!, M[3]!, M[6]!];
  const c1 = [M[1]!, M[4]!, M[7]!];
  const c2 = [M[2]!, M[5]!, M[8]!];

  // Normalization: lambda = ||c0||
  const lambda = Math.sqrt(c0[0]! * c0[0]! + c0[1]! * c0[1]! + c0[2]! * c0[2]!);
  if (lambda < 1e-10) return null;

  // r1 = c0 / lambda, r2 = c1 / lambda, t = c2 / lambda
  const r1 = c0.map((v) => v / lambda);
  const r2 = c1.map((v) => v / lambda);
  const t  = c2.map((v) => v / lambda);

  // r3 = r1 × r2
  const r3 = cross3(r1, r2);

  // Ensure positive depth: if t[2] (camera Z in camera frame) suggests
  // the scene is behind the camera, flip sign.
  // The ground plane should be in front of the camera, so the translation
  // component along the camera's forward (r3 direction) should put the
  // origin in front. A simple heuristic: the camera should be above the
  // ground plane, i.e., the Y component (up) of the world position should
  // be positive.
  //
  // Camera position in world = -R^T * t where R = [r1 r2 r3] as columns.
  // R^T has r1,r2,r3 as rows.
  // pos = -[r1·t, r2·t, r3·t]  where · is dot product
  //
  // But wait: our H maps field (x,z) → image, so the "world" is 2D.
  // The R we reconstruct maps (field_x, field_z, field_y_up) → camera.
  // Column 0 of R corresponds to the field X axis (→1B)
  // Column 1 of R corresponds to the field Z axis (→3B)
  // Column 2 = r3 corresponds to the field Y axis (up)
  //
  // Camera world position:
  //   field_x = -(r1[0]*t[0] + r1[1]*t[1] + r1[2]*t[2])
  //   field_z = -(r2[0]*t[0] + r2[1]*t[1] + r2[2]*t[2])
  //   field_y = -(r3[0]*t[0] + r3[1]*t[1] + r3[2]*t[2])

  let posX = -(r1[0]! * t[0]! + r1[1]! * t[1]! + r1[2]! * t[2]!);
  let posZ = -(r2[0]! * t[0]! + r2[1]! * t[1]! + r2[2]! * t[2]!);
  let posY = -(r3[0]! * t[0]! + r3[1]! * t[1]! + r3[2]! * t[2]!);

  // Camera should be above the ground (posY > 0). If not, flip.
  let sign = 1;
  if (posY < 0) {
    posX = -posX; posY = -posY; posZ = -posZ;
    sign = -1;
  }

  // R maps world → camera. R = [r1 r2 r3] as columns, but our columns
  // correspond to (field_X, field_Z, field_Y) axes. Reorder to get the
  // standard world→camera rotation with world axes (X=1B, Y=up, Z=3B):
  //   Rw = [r1 | r3 | r2] (swap cols 1,2 to put Y-up in the middle)
  // Camera forward in world = Rw^T * [0,0,1] = third row of Rw = r2 (scaled by sign)
  // Camera right in world = Rw^T * [1,0,0] = first row of Rw = r1
  // Camera down in world = Rw^T * [0,1,0] = second row of Rw = r3

  const fwd = r2.map((v) => v * sign);  // camera forward in world
  const right = r1.map((v) => v * sign); // camera right in world
  const down = r3.map((v) => v * sign);  // camera down in world

  // fwd is in (camera_x, camera_y, camera_z) space of the world.
  // Our world: index 0 = field X (→1B), index 1 = field Z (→3B), index 2 = field Y (up)
  // So fwd in field 3D: fwd_fieldX = fwd[0], fwd_fieldZ = fwd[1], fwd_fieldY = fwd[2]

  const fwdFieldX = fwd[0]!;
  const fwdFieldZ = fwd[1]!;
  const fwdFieldY = fwd[2]!; // up component

  // Pan: horizontal angle of forward direction on the ground plane,
  // measured from field +X axis. atan2(Z, X) in field coords.
  const panDeg = Math.atan2(fwdFieldZ, fwdFieldX) * (180 / Math.PI);

  // Tilt: angle below horizontal. The ground component magnitude vs the up component.
  const groundLen = Math.hypot(fwdFieldX, fwdFieldZ);
  const tiltDeg = Math.atan2(-fwdFieldY, groundLen) * (180 / Math.PI);

  // Roll: angle of camera's "right" vector relative to the ground plane.
  // Project camera-right onto the field Y (up) axis.
  const rightFieldY = right[2]!;
  const rightGround = Math.hypot(right[0]!, right[1]!);
  const rollDeg = Math.atan2(rightFieldY, rightGround) * (180 / Math.PI);

  return { position: { x: posX, y: posY, z: posZ }, panDeg, tiltDeg, rollDeg };
}

/**
 * Project a 3D field point (internal frame: X→1B, Y→up, Z→3B, feet)
 * to image pixel coordinates using the decomposed camera pose.
 *
 * The homography only handles ground-plane points. This function handles
 * any 3D point (e.g., the strike zone which is above the ground).
 */
export function projectFieldPoint3D(
  pt: { x: number; y: number; z: number },
  H: Homography,
  K: CameraIntrinsics,
): { u: number; v: number } | null {
  const ifx = 1 / K.fx, ify = 1 / K.fy;
  const Kinv = [
    ifx, 0,   -K.cx * ifx,
    0,   ify, -K.cy * ify,
    0,   0,   1,
  ];

  const M = mul3(Kinv, H);
  const c0 = [M[0]!, M[3]!, M[6]!];
  const c1 = [M[1]!, M[4]!, M[7]!];
  const c2 = [M[2]!, M[5]!, M[8]!];

  const lambda = Math.sqrt(c0[0]! * c0[0]! + c0[1]! * c0[1]! + c0[2]! * c0[2]!);
  if (lambda < 1e-10) return null;

  const r1 = c0.map((v) => v / lambda);
  const r2 = c1.map((v) => v / lambda);
  const t  = c2.map((v) => v / lambda);
  const r3 = cross3(r1, r2);

  // R maps (field_X, field_Z, field_Y) → camera. Our 3D point is in
  // (field_X, field_Y, field_Z). Rearrange: cam = R * [pt.x, pt.z, pt.y] + t
  const wx = pt.x;
  const wy = pt.z;  // field Z → second column of R
  const wz = pt.y;  // field Y (up) → third column of R (r3)

  const cx = r1[0]! * wx + r2[0]! * wy + r3[0]! * wz + t[0]!;
  const cy = r1[1]! * wx + r2[1]! * wy + r3[1]! * wz + t[1]!;
  const cz = r1[2]! * wx + r2[2]! * wy + r3[2]! * wz + t[2]!;

  if (Math.abs(cz) < 1e-10) return null;
  // Ensure positive depth
  if (cz < 0) return null;

  const u = K.fx * (cx / cz) + K.cx;
  const v = K.fy * (cy / cz) + K.cy;

  return { u, v };
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
