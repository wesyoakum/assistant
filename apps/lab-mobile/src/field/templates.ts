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
    name: "MLB / Regulation",
    basepathFt: 90,
    rubberDistFt: 60.5,
    dirtArcRadiusFt: 95,
  },
  college: {
    name: "College",
    basepathFt: 90,
    rubberDistFt: 60.5,
    dirtArcRadiusFt: 95,
  },
  youth70: {
    name: "Youth 70ft",
    basepathFt: 70,
    rubberDistFt: 50,
    dirtArcRadiusFt: 75,
  },
  youth60: {
    name: "Youth 60ft",
    basepathFt: 60,
    rubberDistFt: 46,
    dirtArcRadiusFt: 65,
  },
};

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
