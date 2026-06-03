// Batter's box geometry in user coordinates (meters).
//
// Coordinate system: X→1B, Y→2B, Z→up. Origin = plate apex.

// @ts-ignore
import { type GroundPoint } from "./fieldTemplate.ts";
import {
  fitHomography,
  type Correspondence,
  type HomographyFit,
// @ts-ignore
} from "./videoHomography.ts";

const FT_TO_M = 0.3048;
const DIAG = Math.SQRT1_2;

// MLB dimensions
const PLATE_WIDTH_FT = 17 / 12;
const PLATE_DEPTH_FT = 17 / 12;
export const BOX_WIDTH_FT = 4;
export const BOX_LENGTH_FT = 6;
const BOX_INSIDE_GAP_FT = 6 / 12;
const BOX_FRONT_FROM_CENTER_FT = 3;

function toUser(fx: number, fz: number): GroundPoint {
  return { x: (fx - fz) * DIAG * FT_TO_M, y: (fx + fz) * DIAG * FT_TO_M };
}

export type BoxSide = "left" | "right";
export type CornerLabel = "frontInside" | "frontOutside" | "backOutside" | "backInside";

export interface BatterBoxCorners {
  corners: Record<CornerLabel, GroundPoint>;
  ordered: [GroundPoint, GroundPoint, GroundPoint, GroundPoint];
  side: BoxSide;
}

export function batterBoxCorners(side: BoxSide = "left"): BatterBoxCorners {
  const fwd = { x: DIAG, z: DIAG };
  const right = { x: DIAG, z: -DIAG };
  const frontDist = BOX_FRONT_FROM_CENTER_FT;
  const backDist = frontDist - BOX_LENGTH_FT;
  const pcx = (PLATE_DEPTH_FT / 2) * DIAG;
  const pcz = (PLATE_DEPTH_FT / 2) * DIAG;
  const frontCenter = { x: pcx + frontDist * fwd.x, z: pcz + frontDist * fwd.z };
  const backCenter = { x: pcx + backDist * fwd.x, z: pcz + backDist * fwd.z };
  const insideOffset = PLATE_WIDTH_FT / 2 + BOX_INSIDE_GAP_FT;
  const outsideOffset = insideOffset + BOX_WIDTH_FT;
  const sign = side === "left" ? 1 : -1;

  const fi = toUser(frontCenter.x + sign * insideOffset * right.x, frontCenter.z + sign * insideOffset * right.z);
  const fo = toUser(frontCenter.x + sign * outsideOffset * right.x, frontCenter.z + sign * outsideOffset * right.z);
  const bi = toUser(backCenter.x + sign * insideOffset * right.x, backCenter.z + sign * insideOffset * right.z);
  const bo = toUser(backCenter.x + sign * outsideOffset * right.x, backCenter.z + sign * outsideOffset * right.z);

  return {
    corners: { frontInside: fi, frontOutside: fo, backOutside: bo, backInside: bi },
    ordered: [fi, fo, bo, bi],
    side,
  };
}

export interface CameraPose {
  fit: HomographyFit;
  sides: BoxSide[];
}

export function solveFromBatterBox(
  imageCorners: [{ u: number; v: number }, { u: number; v: number }, { u: number; v: number }, { u: number; v: number }],
  side: BoxSide = "left",
): CameraPose | null {
  const box = batterBoxCorners(side);
  const corr: Correspondence[] = box.ordered.map((pt, i) => ({
    field: { x: pt.x, y: pt.y },
    image: imageCorners[i]!,
  }));
  const fit = fitHomography(corr);
  if (!fit) return null;
  return { fit, sides: [side] };
}

export interface OuterCorners {
  leftFrontOut: GroundPoint;
  rightFrontOut: GroundPoint;
  rightBackOut: GroundPoint;
  leftBackOut: GroundPoint;
}

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

export function allEightCorners(): { left: [GroundPoint, GroundPoint, GroundPoint, GroundPoint]; right: [GroundPoint, GroundPoint, GroundPoint, GroundPoint] } {
  return { left: batterBoxCorners("left").ordered, right: batterBoxCorners("right").ordered };
}

export function solveFromOuterCorners(
  imageCorners: [{ u: number; v: number }, { u: number; v: number }, { u: number; v: number }, { u: number; v: number }],
): CameraPose | null {
  const oc = outerCorners();
  const fieldPts = [oc.leftFrontOut, oc.rightFrontOut, oc.rightBackOut, oc.leftBackOut];
  const corr: Correspondence[] = fieldPts.map((fp, i) => ({
    field: { x: fp.x, y: fp.y },
    image: imageCorners[i]!,
  }));
  const fit = fitHomography(corr);
  if (!fit) return null;
  return { fit, sides: ["left", "right"] };
}
