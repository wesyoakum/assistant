// Convert between internal field coordinates and the user's output frame.
//
// Internal field frame (from coordinateFrame.ts):
//   Origin = plate apex, +X → 1B foul line, +Y → up, +Z → 3B foul line (feet)
//
// User output frame:
//   Origin = plate apex, +X → toward 1B (perpendicular to home-2B diagonal),
//   +Y → toward 2B (along diagonal), +Z → up (meters)

const DIAG = Math.SQRT1_2; // 1/√2
const FT_TO_M = 0.3048;

/** Convert a 3D point from internal field frame (feet) to user frame (meters). */
export function fieldToUser(pt: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  // Internal X is along 1B foul line = (1,0,0) in internal = (DIAG, DIAG, 0) in user ground plane
  // Internal Z is along 3B foul line = (0,0,1) in internal = (-DIAG, DIAG, 0) in user ground plane
  // Internal Y is up = user Z
  //
  // User X = (internal_x - internal_z) / √2   (perpendicular to diagonal, toward 1B side)
  // User Y = (internal_x + internal_z) / √2   (along diagonal, toward 2B)
  // User Z = internal_y                         (up)
  return {
    x: (pt.x - pt.z) * DIAG * FT_TO_M,
    y: (pt.x + pt.z) * DIAG * FT_TO_M,
    z: pt.y * FT_TO_M,
  };
}

/** Convert a 2D ground point from internal field (x,z) feet to user (x,y) meters. */
export function groundFieldToUser(pt: { x: number; z: number }): { x: number; y: number } {
  return {
    x: (pt.x - pt.z) * DIAG * FT_TO_M,
    y: (pt.x + pt.z) * DIAG * FT_TO_M,
  };
}

/** Format a 3D point for display. */
export function formatXYZ(pt: { x: number; y: number; z: number }): string {
  return `X=${pt.x.toFixed(2)}m  Y=${pt.y.toFixed(2)}m  Z=${pt.z.toFixed(2)}m`;
}
