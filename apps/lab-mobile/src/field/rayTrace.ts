// Ray tracing from pixel positions through the camera to the ground plane.
//
// Given a pixel (u,v), camera intrinsics K, and the ground-plane homography
// Hinv (image→field), compute:
//   1. The ray from the camera through the pixel (origin + direction)
//   2. The intersection of that ray with the ground plane (z=0 in user coords)

// @ts-ignore
import { type Homography } from "./videoHomography.ts";
// @ts-ignore
import { imageToField } from "./videoHomography.ts";
// @ts-ignore
import { type CameraIntrinsics } from "./cameraPoseDecompose.ts";
// @ts-ignore
import { groundFieldToUser } from "./userCoords.ts";

export interface RayInfo {
  /** Pixel position on screen. */
  pixelX: number;
  pixelY: number;
  /** Ground intersection in user coords (X ∥ front edge, Y → 2B), meters. */
  groundX: number;
  groundY: number;
  /** Ray direction from camera (unit vector in user coords). */
  rayDirX: number;
  rayDirY: number;
  rayDirZ: number;
  /** Ray line equation: P(t) = origin + t * dir.
   *  Formatted as string for display. */
  rayEquation: string;
  /** Whether this is an interpolated detection. */
  interpolated: boolean;
  /** Frame index. */
  frameIndex: number;
  /** Time in seconds. */
  timeSec: number;
}

/**
 * Compute ray info for a ball detection.
 */
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

  // Ground intersection via Hinv.
  const fieldPt = imageToField(Hinv, { u: pixelX, v: pixelY });
  if (!fieldPt) return null;
  const groundUser = groundFieldToUser(fieldPt);

  // Ray direction: from camera position toward the ground intersection point.
  // Ground is at z=0 in user coords, camera is at cameraPos.
  const dx = groundUser.x - cameraPos.x;
  const dy = groundUser.y - cameraPos.y;
  const dz = 0 - cameraPos.z; // ground is z=0
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-10) return null;
  const rayDirX = dx / len;
  const rayDirY = dy / len;
  const rayDirZ = dz / len;

  const rayEquation = `P(t) = (${cameraPos.x.toFixed(2)}, ${cameraPos.y.toFixed(2)}, ${cameraPos.z.toFixed(2)}) + t·(${rayDirX.toFixed(4)}, ${rayDirY.toFixed(4)}, ${rayDirZ.toFixed(4)})`;

  return {
    pixelX, pixelY,
    groundX: groundUser.x, groundY: groundUser.y,
    rayDirX, rayDirY, rayDirZ,
    rayEquation,
    interpolated,
    frameIndex,
    timeSec,
  };
}
