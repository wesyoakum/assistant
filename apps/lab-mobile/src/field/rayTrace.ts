// Ray tracing from pixel positions through the camera.
//
// Given a pixel (u,v), camera intrinsics K, and the ground-plane homography
// Hinv (image→field), compute:
//   1. The ray from the camera through the pixel (origin + direction)
//   2. The intersection with the YZ plane (X=0 in user coords)
//      — the vertical plane through the plate apex and second base.
//      This gives Y (distance from plate) and Z (height), which is
//      exactly what's needed for strike zone analysis.

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
  /** YZ plane intersection (X=0) in user coords: Y (toward 2B), Z (height), meters. */
  yzY: number;
  yzZ: number;
  /** Ray direction from camera (unit vector in user coords). */
  rayDirX: number;
  rayDirY: number;
  rayDirZ: number;
  /** Ray line equation formatted for display. */
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
 *
 * The ray is cast from the camera through the pixel. We find where it
 * intersects the YZ plane (X=0), giving the ball's position in the
 * vertical plane that runs from plate apex toward second base.
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

  // Use the ground-plane homography to get a direction reference.
  // Back-project the pixel to the ground plane to establish the ray direction.
  const fieldPt = imageToField(Hinv, { u: pixelX, v: pixelY });
  if (!fieldPt) return null;
  const groundUser = groundFieldToUser(fieldPt);

  // Ray direction: from camera toward the ground intersection point.
  // Ground intersection is at (groundUser.x, groundUser.y, 0).
  const dx = groundUser.x - cameraPos.x;
  const dy = groundUser.y - cameraPos.y;
  const dz = 0 - cameraPos.z;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-10) return null;
  const rayDirX = dx / len;
  const rayDirY = dy / len;
  const rayDirZ = dz / len;

  // Intersect ray with the YZ plane (X=0 in user coords).
  // P(t) = cameraPos + t * rayDir
  // cameraPos.x + t * rayDirX = 0
  // t = -cameraPos.x / rayDirX
  let yzY = 0;
  let yzZ = 0;
  if (Math.abs(rayDirX) > 1e-10) {
    const t = -cameraPos.x / rayDirX;
    if (t > 0) { // intersection is in front of the camera
      yzY = cameraPos.y + t * rayDirY;
      yzZ = cameraPos.z + t * rayDirZ;
    }
  }

  const rayEquation = `P(t) = (${cameraPos.x.toFixed(2)}, ${cameraPos.y.toFixed(2)}, ${cameraPos.z.toFixed(2)}) + t·(${rayDirX.toFixed(4)}, ${rayDirY.toFixed(4)}, ${rayDirZ.toFixed(4)})`;

  return {
    pixelX, pixelY,
    yzY, yzZ,
    rayDirX, rayDirY, rayDirZ,
    rayEquation,
    interpolated,
    frameIndex,
    timeSec,
  };
}
