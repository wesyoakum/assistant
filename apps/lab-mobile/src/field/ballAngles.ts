// Compute field-ground-plane angles for tracked ball positions.
//
// Back-projects a ball's normalized image position through Hinv to get
// its ground-plane projection in user coordinates, then computes
// the bearing angle from the plate apex.
//
// NOTE: The ball is airborne — this gives the ground "shadow" position,
// useful for direction/bearing but not true 3D location.

// @ts-ignore .ts extension needed for node test runner
import { type Homography } from "./videoHomography.ts";
// @ts-ignore
import { imageToField } from "./videoHomography.ts";
// @ts-ignore
import { groundFieldToUser } from "./userCoords.ts";

export interface BallFieldInfo {
  /** Ground-plane position in user coords (meters). */
  groundX: number;
  groundY: number;
  /** Bearing angle from plate apex: 0° = toward 2B, positive = toward 1B side. */
  bearingDeg: number;
  /** Distance from apex on the ground plane (meters). */
  distanceM: number;
  /** Whether this was an interpolated position. */
  interpolated: boolean;
}

/**
 * Compute ground-plane field info for a ball detection.
 *
 * @param normCx Normalized center X (0–1) in image coords.
 * @param normCy Normalized center Y (0–1) in image coords.
 * @param imageWidth Image width in pixels.
 * @param imageHeight Image height in pixels.
 * @param Hinv Image-to-field homography.
 * @param interpolated Whether this is an interpolated position.
 */
export function computeBallFieldInfo(
  normCx: number,
  normCy: number,
  imageWidth: number,
  imageHeight: number,
  Hinv: Homography,
  interpolated: boolean,
): BallFieldInfo | null {
  const u = normCx * imageWidth;
  const v = normCy * imageHeight;

  const fieldPt = imageToField(Hinv, { u, v });
  if (!fieldPt) return null;

  const userPt = groundFieldToUser(fieldPt);

  const distanceM = Math.hypot(userPt.x, userPt.y);

  // Bearing: angle from +Y (toward 2B) axis, positive toward +X (1B side).
  // atan2(x, y) gives angle from +Y, positive clockwise (toward +X).
  const bearingDeg = Math.atan2(userPt.x, userPt.y) * (180 / Math.PI);

  return {
    groundX: userPt.x,
    groundY: userPt.y,
    bearingDeg,
    distanceM,
    interpolated,
  };
}
