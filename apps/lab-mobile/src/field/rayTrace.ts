// Ray tracing from pixel positions through the camera.
//
// Coordinate system: X→1B foul line, Y→3B foul line, Z→up (meters).
// Origin at home plate apex. Right-handed.
//
// The "mid-plane" is the vertical plane through the apex and 2B,
// bisecting the diamond at 45° between the foul lines. Its equation
// is x = y (normal (1,-1,0)). This is the natural cross-section for
// a pitch traveling from the mound to the plate.

// @ts-ignore
import { type Homography } from "./videoHomography.ts";
// @ts-ignore
import { imageToField } from "./videoHomography.ts";
// @ts-ignore
import { type CameraIntrinsics } from "./cameraPoseDecompose.ts";

export interface RayInfo {
  pixelX: number;
  pixelY: number;
  /** Mid-plane crossing: distance from apex toward 2B (meters). null if ray doesn't cross. */
  yzY: number | null;
  /** Mid-plane crossing: height above ground (meters). null if ray doesn't cross. */
  yzZ: number | null;
  rayDirX: number;
  rayDirY: number;
  rayDirZ: number;
  rayEquation: string;
  interpolated: boolean;
  frameIndex: number;
  timeSec: number;
}

export function computeRayInfo(
  normCx: number,
  normCy: number,
  imageWidth: number,
  imageHeight: number,
  K: CameraIntrinsics,
  Hinv: Homography,
  cameraPos: { x: number; y: number; z: number },
  interpolated: boolean,
  frameIndex: number,
  timeSec: number,
): RayInfo | null {
  const pixelX = normCx * imageWidth;
  const pixelY = normCy * imageHeight;

  // Back-project pixel to ground plane — returns user coords directly.
  const groundPt = imageToField(Hinv, { u: pixelX, v: pixelY });
  if (!groundPt) return null;

  // Ray from camera to ground intersection (ground is at z=0).
  const dx = groundPt.x - cameraPos.x;
  const dy = groundPt.y - cameraPos.y;
  const dz = 0 - cameraPos.z;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-10) return null;
  const rayDirX = dx / len;
  const rayDirY = dy / len;
  const rayDirZ = dz / len;

  // Intersect ray with the mid-plane (x = y).
  // The plane normal is (1, -1, 0). For a point on the plane, x - y = 0.
  // Ray: P(t) = camPos + t * rayDir
  // Solve: (camPos.x + t*rayDir.x) - (camPos.y + t*rayDir.y) = 0
  //   t * (rayDir.x - rayDir.y) = camPos.y - camPos.x
  //   t = (camPos.y - camPos.x) / (rayDir.x - rayDir.y)
  //
  // t > 0 means the crossing is in front of the camera.
  let yzY: number | null = null;
  let yzZ: number | null = null;
  const denom = rayDirX - rayDirY;
  if (Math.abs(denom) > 1e-10) {
    const t = (cameraPos.y - cameraPos.x) / denom;
    if (t > 0) {
      const ix = cameraPos.x + t * rayDirX;
      // Distance from apex toward 2B along the (1,1,0) direction:
      // the crossing point is (ix, ix, iz) so ground distance = ix * sqrt(2)
      yzY = ix * Math.SQRT2;
      yzZ = cameraPos.z + t * rayDirZ;
    }
  }

  const rayEquation = `P(t) = (${cameraPos.x.toFixed(2)}, ${cameraPos.y.toFixed(2)}, ${cameraPos.z.toFixed(2)}) + t·(${rayDirX.toFixed(4)}, ${rayDirY.toFixed(4)}, ${rayDirZ.toFixed(4)})`;

  return { pixelX, pixelY, yzY, yzZ, rayDirX, rayDirY, rayDirZ, rayEquation, interpolated, frameIndex, timeSec };
}
