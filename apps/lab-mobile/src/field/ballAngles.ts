// Compute ball direction angles from tracked positions.
//
// Given a ball's pixel position and camera intrinsics, compute the angular
// direction from the camera to the ball: azimuth (horizontal, from center)
// and elevation (vertical, from center). These are the raw viewing angles
// independent of camera pose.
//
// With camera pose, we can also express the direction in the field frame:
// azimuth relative to the toward-2B axis (Y), elevation above the ground plane.

// @ts-ignore .ts extension needed for node test runner
import { type Homography } from "./videoHomography.ts";
import { type CameraIntrinsics } from "./cameraPoseDecompose.ts";

export interface BallDirection {
  /** Azimuth from image center in degrees. Positive = right (toward 1B side). */
  azimuthDeg: number;
  /** Elevation from image center in degrees. Positive = up. */
  elevationDeg: number;
  /** Whether this was an interpolated position. */
  interpolated: boolean;
}

/**
 * Compute the angular direction from the camera to a ball detection.
 *
 * @param normCx Normalized center X (0–1) in image coords.
 * @param normCy Normalized center Y (0–1) in image coords.
 * @param imageWidth Image width in pixels.
 * @param imageHeight Image height in pixels.
 * @param K Camera intrinsics.
 * @param interpolated Whether this is an interpolated position.
 */
export function computeBallDirection(
  normCx: number,
  normCy: number,
  imageWidth: number,
  imageHeight: number,
  K: CameraIntrinsics,
  interpolated: boolean,
): BallDirection {
  const u = normCx * imageWidth;
  const v = normCy * imageHeight;

  // Direction vector in camera frame (pinhole model):
  // dx = (u - cx) / fx, dy = (v - cy) / fy, dz = 1
  const dx = (u - K.cx) / K.fx;
  const dy = (v - K.cy) / K.fy;

  // Azimuth: horizontal angle from center (positive = right in image)
  const azimuthDeg = Math.atan2(dx, 1) * (180 / Math.PI);

  // Elevation: vertical angle from center (positive = up, image Y is down)
  const elevationDeg = Math.atan2(-dy, 1) * (180 / Math.PI);

  return { azimuthDeg, elevationDeg, interpolated };
}
