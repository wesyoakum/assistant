// Batter's box geometry and camera-pose estimation.
//
// MLB Rule 2.01: each batter's box is 4 ft × 6 ft. The box is positioned so
// its inside edge is 6 inches from the nearest edge of home plate, and its
// front line is 3 ft forward of the center of home plate.
//
// We use the LEFT batter's box (first-base side as seen from the pitcher) as
// the default calibration target since it's typically more visible from a
// center-field or backstop camera angle. The user can flip to the right box.
//
// All coordinates are in the field frame established by coordinateFrame.ts:
//   origin = home plate apex, +x → first base, +z → third base, feet.
//
// Pure geometry — no native/React deps → unit-testable.

import { type GroundPoint } from "./fieldTemplate.ts";
import {
  fitHomography,
  applyHomography,
  type Correspondence,
  type Homography,
  type HomographyFit,
} from "./videoHomography.ts";

// ── MLB plate + box dimensions (feet) ────────────────────────────────────────

/** Home plate is 17" wide. Its center sits along the home→2B diagonal. */
const PLATE_WIDTH_FT = 17 / 12;

/** The plate's depth (apex to front edge) is 17" total. */
const PLATE_DEPTH_FT = 17 / 12;

/** Batter's box: 4 ft wide × 6 ft long. */
export const BOX_WIDTH_FT = 4;
export const BOX_LENGTH_FT = 6;

/** Inside edge of the box is 6 inches from the plate edge. */
const BOX_INSIDE_GAP_FT = 6 / 12;

/** Front line of the box is 3 ft forward of the CENTER of the plate.
 *  "Forward" = toward the pitcher = along the home→2B diagonal. */
const BOX_FRONT_FROM_CENTER_FT = 3;

// ── Derived geometry ─────────────────────────────────────────────────────────

// The plate center (geometric center of home plate) in field coords sits along
// the home→2B diagonal at half the plate depth from the apex.
//   diagonal unit = (1/√2, 1/√2) in (x, z)
const DIAG = Math.SQRT1_2;

// Plate center in field coords (x, z):
const PLATE_CENTER_X = (PLATE_DEPTH_FT / 2) * DIAG;
const PLATE_CENTER_Z = (PLATE_DEPTH_FT / 2) * DIAG;

// "Forward" (toward pitcher) is along the diagonal: unit = (DIAG, DIAG).
// "Right" (toward first base from the pitcher's perspective, i.e. toward 3B
// from the batter's view) is perpendicular: unit = (DIAG, -DIAG).
// "Left" (toward third base from the pitcher's perspective, i.e. toward 1B
// from the batter's view) is: unit = (-DIAG, DIAG).

// The plate's nearest edge on the first-base side is at +PLATE_WIDTH_FT/2
// in the "right" direction from the plate center, and on the third-base side
// at -PLATE_WIDTH_FT/2.

export type BoxSide = "left" | "right";

/** Corner labels, ordered for the overlay (clockwise from front-inside). */
export type CornerLabel = "frontInside" | "frontOutside" | "backOutside" | "backInside";

export interface BatterBoxCorners {
  /** The 4 corners in field ground coords (x, z) in feet, labeled. */
  corners: Record<CornerLabel, GroundPoint>;
  /** Same corners as an ordered array [frontInside, frontOutside, backOutside, backInside]. */
  ordered: [GroundPoint, GroundPoint, GroundPoint, GroundPoint];
  side: BoxSide;
}

/**
 * Compute the 4 corners of a batter's box in field coordinates.
 *
 * @param side "left" = first-base side box (batter faces pitcher, box is to
 *             the left of plate from catcher's view), "right" = third-base side.
 */
export function batterBoxCorners(side: BoxSide = "left"): BatterBoxCorners {
  // Forward unit (toward pitcher along diagonal)
  const fwd = { x: DIAG, z: DIAG };
  // Right unit (toward first base side, perpendicular to forward)
  const right = { x: DIAG, z: -DIAG };

  // The "front" of the box is 3ft forward of plate center.
  // The "back" is front - 6ft (toward the catcher).
  const frontDist = BOX_FRONT_FROM_CENTER_FT;
  const backDist = frontDist - BOX_LENGTH_FT; // negative = behind plate center

  // Front-center and back-center of the box (along the diagonal from plate center):
  const frontCenter = {
    x: PLATE_CENTER_X + frontDist * fwd.x,
    z: PLATE_CENTER_Z + frontDist * fwd.z,
  };
  const backCenter = {
    x: PLATE_CENTER_X + backDist * fwd.x,
    z: PLATE_CENTER_Z + backDist * fwd.z,
  };

  // The inside edge is 6" from the plate edge. The plate edge on the given
  // side is at PLATE_WIDTH_FT/2 from center in the lateral direction.
  // For the "left" box (first-base side from catcher's view):
  //   inside = plate center + (PLATE_WIDTH_FT/2 + BOX_INSIDE_GAP_FT) in +right
  //   outside = inside + BOX_WIDTH_FT in +right
  // For the "right" box (third-base side):
  //   inside = plate center - (PLATE_WIDTH_FT/2 + BOX_INSIDE_GAP_FT) in +right
  //   outside = inside - BOX_WIDTH_FT in +right

  const insideOffset = PLATE_WIDTH_FT / 2 + BOX_INSIDE_GAP_FT;
  const outsideOffset = insideOffset + BOX_WIDTH_FT;

  const sign = side === "left" ? 1 : -1;

  const frontInside: GroundPoint = {
    x: frontCenter.x + sign * insideOffset * right.x,
    z: frontCenter.z + sign * insideOffset * right.z,
  };
  const frontOutside: GroundPoint = {
    x: frontCenter.x + sign * outsideOffset * right.x,
    z: frontCenter.z + sign * outsideOffset * right.z,
  };
  const backInside: GroundPoint = {
    x: backCenter.x + sign * insideOffset * right.x,
    z: backCenter.z + sign * insideOffset * right.z,
  };
  const backOutside: GroundPoint = {
    x: backCenter.x + sign * outsideOffset * right.x,
    z: backCenter.z + sign * outsideOffset * right.z,
  };

  return {
    corners: { frontInside, frontOutside, backOutside, backInside },
    ordered: [frontInside, frontOutside, backOutside, backInside],
    side,
  };
}

// ── Camera pose from batter's box alignment ──────────────────────────────────

export interface CameraPose {
  /** The field→image homography (maps ground plane to pixels). */
  fit: HomographyFit;
  /** Which batter's box sides were used. */
  sides: BoxSide[];
}

/**
 * Solve the camera pose (as a ground-plane homography) from 4 image-space
 * corner positions matched to the known batter's box corners.
 *
 * @param imageCorners The 4 corners in image pixel coordinates, in the same
 *        order as BatterBoxCorners.ordered: [frontInside, frontOutside,
 *        backOutside, backInside].
 * @param side Which batter's box.
 */
export function solveFromBatterBox(
  imageCorners: [{ u: number; v: number }, { u: number; v: number }, { u: number; v: number }, { u: number; v: number }],
  side: BoxSide = "left",
): CameraPose | null {
  const box = batterBoxCorners(side);

  const corr: Correspondence[] = box.ordered.map((fieldPt, i) => ({
    field: { x: fieldPt.x, z: fieldPt.z },
    image: imageCorners[i]!,
  }));

  const fit = fitHomography(corr);
  if (!fit) return null;

  return { fit, sides: [side] };
}

/**
 * Solve camera pose from BOTH batter's boxes (8 points → better fit).
 *
 * @param leftCorners  4 image corners for the left box [FI, FO, BO, BI].
 * @param rightCorners 4 image corners for the right box [FI, FO, BO, BI].
 */
export function solveFromBothBoxes(
  leftCorners: [{ u: number; v: number }, { u: number; v: number }, { u: number; v: number }, { u: number; v: number }],
  rightCorners: [{ u: number; v: number }, { u: number; v: number }, { u: number; v: number }, { u: number; v: number }],
): CameraPose | null {
  const leftBox = batterBoxCorners("left");
  const rightBox = batterBoxCorners("right");

  const corr: Correspondence[] = [
    ...leftBox.ordered.map((fieldPt, i) => ({
      field: { x: fieldPt.x, z: fieldPt.z },
      image: leftCorners[i]!,
    })),
    ...rightBox.ordered.map((fieldPt, i) => ({
      field: { x: fieldPt.x, z: fieldPt.z },
      image: rightCorners[i]!,
    })),
  ];

  const fit = fitHomography(corr);
  if (!fit) return null;

  return { fit, sides: ["left", "right"] };
}

// ── 4-point outer-corner solve ───────────────────────────────────────────────

/** The 4 outer corners of the batter's box pair in field coords. */
export interface OuterCorners {
  /** Left box front-outside */
  leftFrontOut: GroundPoint;
  /** Right box front-outside */
  rightFrontOut: GroundPoint;
  /** Right box back-outside */
  rightBackOut: GroundPoint;
  /** Left box back-outside */
  leftBackOut: GroundPoint;
}

/** Get the 4 outer corners of both boxes in field coordinates. */
export function outerCorners(): OuterCorners {
  const left = batterBoxCorners("left");
  const right = batterBoxCorners("right");
  return {
    leftFrontOut: left.corners.frontOutside,
    rightFrontOut: right.corners.frontOutside,
    rightBackOut: right.corners.backOutside,
    leftBackOut: left.corners.backOutside,
  };
}

/** All 8 corners in field coords, for projecting once we have the homography. */
export function allEightCorners(): { left: [GroundPoint, GroundPoint, GroundPoint, GroundPoint]; right: [GroundPoint, GroundPoint, GroundPoint, GroundPoint] } {
  const left = batterBoxCorners("left");
  const right = batterBoxCorners("right");
  return { left: left.ordered, right: right.ordered };
}

/**
 * Solve camera pose from the 4 outer corners of both boxes.
 * The user drags these 4 points; the inner edges are derived via the
 * homography since all geometry is known.
 *
 * @param imageCorners 4 image-pixel positions in order:
 *        [leftFrontOut, rightFrontOut, rightBackOut, leftBackOut]
 */
export function solveFromOuterCorners(
  imageCorners: [{ u: number; v: number }, { u: number; v: number }, { u: number; v: number }, { u: number; v: number }],
): CameraPose | null {
  const oc = outerCorners();
  const fieldPts = [oc.leftFrontOut, oc.rightFrontOut, oc.rightBackOut, oc.leftBackOut];

  const corr: Correspondence[] = fieldPts.map((fp, i) => ({
    field: { x: fp.x, z: fp.z },
    image: imageCorners[i]!,
  }));

  const fit = fitHomography(corr);
  if (!fit) return null;

  return { fit, sides: ["left", "right"] };
}
