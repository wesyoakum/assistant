// Home plate pentagon geometry in internal field coordinates.
// Origin = apex, +X → 1B foul line, +Z → 3B foul line, feet.
//
// MLB Rule 2.02: Home base is a 17-inch square with two corners filled in
// so that one edge is 17 inches long, two adjacent sides are 8.5 inches,
// and the remaining two sides are 12 inches and set at an angle to make a point.

import { type GroundPoint } from "./fieldTemplate.ts";

const DIAG = Math.SQRT1_2;
const PLATE_FRONT_IN = 17 / 12;  // 17 inches in feet (front edge width AND depth)
const HALF_FRONT_FT = 8.5 / 12;  // half of 17" front edge
const SIDE_FT = 8.5 / 12;        // perpendicular side length

// Forward unit (toward 2B along diagonal)
const FWD = { x: DIAG, z: DIAG };
// Right unit (toward 1B side, perpendicular to forward)
const RGT = { x: DIAG, z: -DIAG };

/**
 * Returns the 5 corners of home plate in ground field coordinates,
 * ordered clockwise from the apex (as seen from above / catcher's view):
 *   apex → right-bevel → right-front → left-front → left-bevel
 */
export function homePlateCorners(): GroundPoint[] {
  // Front edge midpoint: PLATE_FRONT_IN along the diagonal from apex
  const fcx = PLATE_FRONT_IN * FWD.x;
  const fcz = PLATE_FRONT_IN * FWD.z;

  // Front-right and front-left corners: ± half front width laterally
  const frontRight: GroundPoint = { x: fcx + HALF_FRONT_FT * RGT.x, z: fcz + HALF_FRONT_FT * RGT.z };
  const frontLeft:  GroundPoint = { x: fcx - HALF_FRONT_FT * RGT.x, z: fcz - HALF_FRONT_FT * RGT.z };

  // Bevel corners: front corners moved backward by SIDE_FT along the diagonal
  const rightBevel: GroundPoint = { x: frontRight.x - SIDE_FT * FWD.x, z: frontRight.z - SIDE_FT * FWD.z };
  const leftBevel:  GroundPoint = { x: frontLeft.x  - SIDE_FT * FWD.x, z: frontLeft.z  - SIDE_FT * FWD.z };

  return [
    { x: 0, z: 0 },   // apex
    rightBevel,
    frontRight,
    frontLeft,
    leftBevel,
  ];
}
