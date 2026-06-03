// Ray tracing from pixel positions through the camera.
//
// All coordinates are in user frame: X→1B, Y→2B, Z→up (meters).
// H now maps user ground (x,y) → image pixels directly.

// @ts-ignore
import { type Homography } from "./videoHomography.ts";
// @ts-ignore
import { imageToField } from "./videoHomography.ts";
// @ts-ignore
import { type CameraIntrinsics } from "./cameraPoseDecompose.ts";

export interface RayInfo {
  pixelX: number;
  pixelY: number;
  /** YZ plane intersection (X=0): Y (toward 2B), Z (height), meters. */
  yzY: number;
  yzZ: number;
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

  // Back-project pixel to ground plane — now returns user coords directly.
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

  // Intersect ray with YZ plane (X=0).
  let yzY = 0, yzZ = 0;
  if (Math.abs(rayDirX) > 1e-10) {
    const t = -cameraPos.x / rayDirX;
    if (t > 0) {
      yzY = cameraPos.y + t * rayDirY;
      yzZ = cameraPos.z + t * rayDirZ;
    }
  }

  const rayEquation = `P(t) = (${cameraPos.x.toFixed(2)}, ${cameraPos.y.toFixed(2)}, ${cameraPos.z.toFixed(2)}) + t·(${rayDirX.toFixed(4)}, ${rayDirY.toFixed(4)}, ${rayDirZ.toFixed(4)})`;

  return { pixelX, pixelY, yzY, yzZ, rayDirX, rayDirY, rayDirZ, rayEquation, interpolated, frameIndex, timeSec };
}
