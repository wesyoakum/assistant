// Known field geometry — landmark positions on the ground plane, in field
// coordinates, for video reconciliation (see VIDEO_ANALYSIS.md).
//
// Convention matches src/field/coordinateFrame.ts and foulLine.ts:
//   origin = home-plate APEX, +x → first base, +z → third base, units = feet.
// Everything here is on the ground (y = 0), so we work in 2D (x, z).
//
// These are the KNOWN 3D points whose pixels you label in a video frame; the
// homography solver (videoHomography.ts) fits the field↔image mapping to them.
// Dimensions vary by level of play, so the template is parameterized — PnP/
// homography with enough points absorbs small real-field deviations (a 61-ft
// basepath fits as 61 ft); the spec only needs correct proportions.
//
// Pure data + geometry. No native/React deps → unit-tested in fieldTemplate.test.ts.

export interface GroundPoint {
  /** Feet toward first base from the apex. */
  x: number;
  /** Feet toward third base from the apex. */
  z: number;
}

/** A named, known landmark location on the field (ground plane, feet). */
export type LandmarkId =
  | "apex"            // home-plate rear point = origin
  | "plate_front"     // front edge midpoint of home plate (toward pitcher)
  | "first_base"
  | "second_base"
  | "third_base"
  | "rubber"          // pitching rubber center
  | "mound_center"    // center of the pitching mound (≈ rubber, kept distinct)
  | "foul_pole_first" // right-field foul pole base (down the 1B line)
  | "foul_pole_third";// left-field foul pole base (down the 3B line)

export interface FieldSpec {
  /** Human label, e.g. "Little League (60/46)". */
  name: string;
  /** Base-path length, feet (apex→1B, etc.). */
  basePath: number;
  /** Pitching distance: apex → front edge of rubber, feet. */
  pitchingDistance: number;
  /** Foul-line length from apex to the foul pole, feet (outfield distance). */
  foulLineLength: number;
}

// Common levels of play. foulLineLength is the down-the-line fence distance.
export const FIELD_SPECS: Record<string, FieldSpec> = {
  littleLeague: { name: "Little League (60/46)", basePath: 60, pitchingDistance: 46, foulLineLength: 200 },
  intermediate46_60: { name: "Intermediate (70/50)", basePath: 70, pitchingDistance: 50, foulLineLength: 250 },
  highSchool: { name: "High School / MLB (90/60.5)", basePath: 90, pitchingDistance: 60.5, foulLineLength: 320 },
};

// Home plate is a 17" front edge; the apex→front-edge depth is ~8.5+12-derived.
// In feet, the front-edge midpoint sits ~1.41 ft toward the pitcher from the apex
// (8.5in back rectangle + the apex triangle ≈ 17in total depth → 17in = 1.417ft).
const PLATE_DEPTH_FT = 17 / 12;

/**
 * Build the known ground-plane landmark coordinates for a field spec.
 *
 * Geometry: the foul lines run from the apex at ±45° to the +x (1B) / +z (3B)
 * axes... actually by our convention +x IS toward first base and +z toward third,
 * and the bases sit on those lines. The infield is a square rotated so home→2B is
 * the diagonal. Standard layout:
 *   - 1B at (basePath, 0)              [straight down +x]
 *   - 3B at (0, basePath)              [straight down +z]
 *   - 2B at (basePath, basePath)       [far corner of the square]
 *   - rubber/mound along the home→2B diagonal at pitchingDistance from apex
 *   - foul poles at (foulLineLength, 0) and (0, foulLineLength)
 *
 * (This places the two foul lines exactly on the +x and +z axes, matching
 * coordinateFrame.ts where X→1B and Z→3B are the field axes.)
 */
export function buildFieldLandmarks(spec: FieldSpec): Record<LandmarkId, GroundPoint> {
  const bp = spec.basePath;
  // Home→2B diagonal bisects the 1B/3B axes (unit vector (1,1)/√2).
  const diag = Math.SQRT1_2;
  const pd = spec.pitchingDistance;
  return {
    apex: { x: 0, z: 0 },
    plate_front: { x: PLATE_DEPTH_FT * diag, z: PLATE_DEPTH_FT * diag },
    first_base: { x: bp, z: 0 },
    third_base: { x: 0, z: bp },
    second_base: { x: bp, z: bp },
    rubber: { x: pd * diag, z: pd * diag },
    mound_center: { x: pd * diag, z: pd * diag },
    foul_pole_first: { x: spec.foulLineLength, z: 0 },
    foul_pole_third: { x: 0, z: spec.foulLineLength },
  };
}

/** Convenience: landmark coords for a named spec key (defaults to high school). */
export function fieldLandmarks(specKey: keyof typeof FIELD_SPECS = "highSchool"): Record<LandmarkId, GroundPoint> {
  return buildFieldLandmarks(FIELD_SPECS[specKey]!);
}
