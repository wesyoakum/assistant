// Home plate pentagon in user coordinates (meters).
//
// Coordinate system: X→1B, Y→2B, Z→up. Origin = plate apex.

// @ts-ignore
import { type GroundPoint } from "./fieldTemplate.ts";

const FT_TO_M = 0.3048;
const DIAG = Math.SQRT1_2;

const PLATE_DEPTH_FT = 17 / 12;
const HALF_FRONT_FT = 8.5 / 12;
const SIDE_FT = 8.5 / 12;

// In user coords:
//   "forward" (toward pitcher) = +Y direction
//   "right" (toward 1B) = +X direction
const FWD_X = 0;
const FWD_Y = 1;
const RGT_X = 1;
const RGT_Y = 0;

function toUser(fx: number, fz: number): GroundPoint {
  return { x: (fx - fz) * DIAG * FT_TO_M, y: (fx + fz) * DIAG * FT_TO_M };
}

/**
 * Returns the 5 corners of home plate in user coordinates (meters),
 * ordered clockwise from apex (as seen from above):
 *   apex → right bevel → front right → front left → left bevel
 */
export function homePlateCorners(): GroundPoint[] {
  // Internal field forward = (DIAG, DIAG), right = (DIAG, -DIAG)
  const fwd = { x: DIAG, z: DIAG };
  const rgt = { x: DIAG, z: -DIAG };

  const fc = { x: PLATE_DEPTH_FT * fwd.x, z: PLATE_DEPTH_FT * fwd.z };

  const frontRight = { x: fc.x + HALF_FRONT_FT * rgt.x, z: fc.z + HALF_FRONT_FT * rgt.z };
  const frontLeft = { x: fc.x - HALF_FRONT_FT * rgt.x, z: fc.z - HALF_FRONT_FT * rgt.z };
  const rightBevel = { x: frontRight.x - SIDE_FT * fwd.x, z: frontRight.z - SIDE_FT * fwd.z };
  const leftBevel = { x: frontLeft.x - SIDE_FT * fwd.x, z: frontLeft.z - SIDE_FT * fwd.z };

  return [
    { x: 0, y: 0 },         // apex
    toUser(rightBevel.x, rightBevel.z),
    toUser(frontRight.x, frontRight.z),
    toUser(frontLeft.x, frontLeft.z),
    toUser(leftBevel.x, leftBevel.z),
  ];
}
