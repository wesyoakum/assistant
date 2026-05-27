// Standard baseball field geometry templates.
// All distances in feet (converted to meters for AR use).

const FT_TO_M = 0.3048;

export interface FieldTemplate {
  name: string;
  basepathFt: number;
  /** Distance from home plate to pitcher's rubber in feet. */
  rubberDistFt: number;
  /** Radius of the infield dirt arc in feet (from pitcher's mound center). */
  dirtArcRadiusFt: number;
}

export const FIELD_TEMPLATES: Record<string, FieldTemplate> = {
  regulation: {
    name: "Regulation (90ft)",
    basepathFt: 90,
    rubberDistFt: 60.5,
    dirtArcRadiusFt: 95,
  },
  intermediate: {
    name: "Intermediate (75ft)",
    basepathFt: 75,
    rubberDistFt: 54,
    dirtArcRadiusFt: 80,
  },
  youth: {
    name: "Youth (60ft)",
    basepathFt: 60,
    rubberDistFt: 46,
    dirtArcRadiusFt: 65,
  },
};

/**
 * Compute world positions for all 5 field landmarks given home plate position
 * and a forward direction (from home plate toward center field / 2nd base).
 *
 * The forward direction is typically the camera's forward vector projected
 * onto the ground plane at the time home plate is placed.
 */
export function computeLandmarkPositions(
  homeX: number, homeY: number, homeZ: number,
  forwardX: number, forwardZ: number,
  templateKey: string
): { kind: string; x: number; y: number; z: number }[] {
  const t = FIELD_TEMPLATES[templateKey] ?? FIELD_TEMPLATES.regulation;
  const bp = t.basepathFt * FT_TO_M;
  const rubberDist = t.rubberDistFt * FT_TO_M;

  // Normalize forward direction on the ground plane (XZ)
  const fLen = Math.sqrt(forwardX * forwardX + forwardZ * forwardZ);
  if (fLen < 1e-6) return [];
  const fwdX = forwardX / fLen;
  const fwdZ = forwardZ / fLen;

  // Right vector (perpendicular to forward on ground plane, pointing toward 1B)
  // For a standard field: standing at HP looking toward 2B, 1B is to the right
  const rightX = fwdZ;   // rotate forward 90° CW on XZ plane
  const rightZ = -fwdX;

  // Field coordinate axes in world space:
  // +X (toward 1B) = (forward + right) / sqrt(2)  (45° right of center field)
  // +Z (toward 3B) = (forward - right) / sqrt(2)  (45° left of center field)
  const s = 1 / Math.SQRT2;
  const to1bX = s * (fwdX + rightX);
  const to1bZ = s * (fwdZ + rightZ);
  const to3bX = s * (fwdX - rightX);
  const to3bZ = s * (fwdZ - rightZ);

  // Toward 2B = forward direction (already normalized)
  const to2bX = fwdX;
  const to2bZ = fwdZ;

  return [
    { kind: "home_plate", x: homeX, y: homeY, z: homeZ },
    { kind: "first_base", x: homeX + to1bX * bp, y: homeY, z: homeZ + to1bZ * bp },
    { kind: "second_base", x: homeX + to2bX * bp * Math.SQRT2, y: homeY, z: homeZ + to2bZ * bp * Math.SQRT2 },
    { kind: "third_base", x: homeX + to3bX * bp, y: homeY, z: homeZ + to3bZ * bp },
    { kind: "rubber", x: homeX + to2bX * rubberDist, y: homeY, z: homeZ + to2bZ * rubberDist },
  ];
}

/**
 * Generate the infield dirt boundary polygon in field coordinates (X, Z).
 * Field coords: origin at home plate, +X toward 1B, +Z toward 3B.
 *
 * The infield dirt is a diamond + curved arc behind the basepaths.
 * Returns an array of [x, z] points tracing the boundary.
 */
export function generateDirtBoundary(
  templateKey: string
): [number, number][] {
  const t = FIELD_TEMPLATES[templateKey] ?? FIELD_TEMPLATES.regulation;
  const bp = t.basepathFt * FT_TO_M;
  const arcR = t.dirtArcRadiusFt * FT_TO_M;

  // Key positions in field coords (feet → meters):
  // Home plate: (0, 0)
  // First base: (bp, 0)  — along +X
  // Third base: (0, bp)  — along +Z
  // Second base: (bp, bp) — diagonal

  // Pitcher's mound center (along the home→2B diagonal):
  // The diagonal from home to 2B has length bp * sqrt(2).
  // Mound is at rubberDistFt along this diagonal.
  const diagDir = { x: 1 / Math.SQRT2, z: 1 / Math.SQRT2 };
  const moundX = t.rubberDistFt * FT_TO_M * diagDir.x;
  const moundZ = t.rubberDistFt * FT_TO_M * diagDir.z;

  // Build the boundary:
  // Start at home plate, trace along the 1B foul line to just past 1B,
  // then arc around behind 1B/2B/3B, then back along the 3B foul line to home.

  const points: [number, number][] = [];

  // Home plate corner (slightly behind home on the 1B side)
  points.push([0, -2 * FT_TO_M]);  // small extension behind home

  // Along the first-base foul line to first base area
  // The dirt extends a bit past the base
  const pastBase = 5 * FT_TO_M;  // 5 feet past the base
  points.push([bp + pastBase, 0]);

  // Arc from first base side to third base side, centered on the mound.
  // The arc goes from approximately the angle of first base to third base,
  // sweeping through second base.
  const arcSteps = 30;
  // Angle from mound to first base area
  const startAngle = Math.atan2(0 - moundZ, (bp + pastBase) - moundX);
  // Angle from mound to third base area
  const endAngle = Math.atan2((bp + pastBase) - moundZ, 0 - moundX);

  for (let i = 0; i <= arcSteps; i++) {
    const t_param = i / arcSteps;
    const angle = startAngle + t_param * (endAngle - startAngle);
    const x = moundX + arcR * Math.cos(angle);
    const z = moundZ + arcR * Math.sin(angle);
    points.push([x, z]);
  }

  // Third base area back to home along the third-base foul line
  points.push([0, bp + pastBase]);
  points.push([-2 * FT_TO_M, 0]);  // small extension behind home on 3B side

  return points;
}
