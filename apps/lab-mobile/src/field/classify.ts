// Ball zone classification using the field coordinate frame + boundary polygon.

import { transformPoint, type Vec3 } from "./coordinateFrame";
import { pointInPolygon } from "./pointInPolygon";

export type BallZone = "infield" | "outfield" | "foul";

export interface BallClassification {
  fieldX: number;
  fieldZ: number;
  zone: BallZone;
  distFromHomeFt: number;
}

const M_TO_FT = 3.28084;

/**
 * Classify a ball's location relative to the field.
 *
 * @param worldPos - ball position in ARKit world coordinates
 * @param worldToField - 4x4 column-major transform matrix
 * @param dirtBoundary - 2D polygon in field coordinates [x, z] pairs
 */
export function classifyBall(
  worldPos: Vec3,
  worldToField: number[],
  dirtBoundary: [number, number][]
): BallClassification {
  const fp = transformPoint(worldPos, worldToField);
  const fieldX = fp.x;
  const fieldZ = fp.z;
  const dist = Math.sqrt(fieldX * fieldX + fieldZ * fieldZ);

  let zone: BallZone;
  if (fieldX < 0 || fieldZ < 0) {
    zone = "foul";
  } else if (pointInPolygon(fieldX, fieldZ, dirtBoundary)) {
    zone = "infield";
  } else {
    zone = "outfield";
  }

  return {
    fieldX,
    fieldZ,
    zone,
    distFromHomeFt: dist * M_TO_FT,
  };
}
