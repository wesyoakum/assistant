// Field geometry — landmark positions in USER coordinates (meters).
//
// Coordinate system:
//   Origin = home plate apex
//   +X = toward 1B (parallel to front edge of plate)
//   +Y = toward 2B (along home→2B diagonal)
//   +Z = up
//
// All positions are on the ground plane (z = 0), so we use { x, y }.

const FT_TO_M = 0.3048;
const DIAG = Math.SQRT1_2; // 1/√2

export interface GroundPoint {
  /** Meters toward 1B (parallel to front edge). */
  x: number;
  /** Meters toward 2B (along diagonal). */
  y: number;
}

export type LandmarkId =
  | "apex"
  | "plate_front"
  | "first_base"
  | "second_base"
  | "third_base"
  | "rubber"
  | "mound_center"
  | "foul_pole_first"
  | "foul_pole_third";

/** Home plate depth (apex to front edge) = 17 inches. */
const PLATE_DEPTH_FT = 17 / 12;

/**
 * Build landmark positions in user coordinates (meters) for a given basepath.
 *
 * The diamond is a square rotated 45° — in the internal field frame,
 * 1B is along one foul line and 3B along the other. In user coords:
 *   1B: x = basepath * DIAG * FT_TO_M,  y = basepath * DIAG * FT_TO_M
 *   3B: x = -basepath * DIAG * FT_TO_M, y = basepath * DIAG * FT_TO_M
 *   2B: x = 0,                           y = basepath * 2 * DIAG * FT_TO_M
 *
 * @param basepathFt Base distance in feet (e.g. 60 for Little League, 90 for MLB).
 * @param pitchingDistanceFt Pitching distance in feet (default: derived from basepath).
 */
export function buildFieldLandmarks(
  basepathFt: number,
  pitchingDistanceFt?: number,
): Record<LandmarkId, GroundPoint> {
  const bp = basepathFt;
  const pd = pitchingDistanceFt ?? (bp <= 50 ? 35 : bp <= 60 ? 46 : bp <= 70 ? 50 : 60.5);
  const foulLineFt = bp + 2.5 * bp; // foul line extends past bases

  // Conversion: internal field (fx, fz) in feet → user (x, y) in meters:
  //   user_x = (fx - fz) * DIAG * FT_TO_M
  //   user_y = (fx + fz) * DIAG * FT_TO_M
  const toUser = (fx: number, fz: number): GroundPoint => ({
    x: (fx - fz) * DIAG * FT_TO_M,
    y: (fx + fz) * DIAG * FT_TO_M,
  });

  return {
    apex: { x: 0, y: 0 },
    plate_front: toUser(PLATE_DEPTH_FT * DIAG, PLATE_DEPTH_FT * DIAG),
    first_base: toUser(bp, 0),
    third_base: toUser(0, bp),
    second_base: toUser(bp, bp),
    rubber: toUser(pd * DIAG, pd * DIAG),
    mound_center: toUser(pd * DIAG, pd * DIAG),
    foul_pole_first: toUser(foulLineFt, 0),
    foul_pole_third: toUser(0, foulLineFt),
  };
}

/** Convenience: landmark coords for a given basepath (default 60ft). */
export function fieldLandmarks(basepathFt: number = 60): Record<LandmarkId, GroundPoint> {
  return buildFieldLandmarks(basepathFt);
}
