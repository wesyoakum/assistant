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
  /** Distance from home plate to outfield fence in feet. */
  outfieldFenceFt: number;
}

export const FIELD_TEMPLATES: Record<string, FieldTemplate> = {
  tball: {
    name: "T-Ball (40ft)",
    basepathFt: 40,
    rubberDistFt: 30,
    dirtArcRadiusFt: 45,
    outfieldFenceFt: 135,
  },
  youth: {
    name: "Youth (60ft)",
    basepathFt: 60,
    rubberDistFt: 46,
    dirtArcRadiusFt: 65,
    outfieldFenceFt: 200,
  },
  intermediate: {
    name: "Intermediate (75ft)",
    basepathFt: 75,
    rubberDistFt: 54,
    dirtArcRadiusFt: 80,
    outfieldFenceFt: 275,
  },
  regulation: {
    name: "Regulation (90ft)",
    basepathFt: 90,
    rubberDistFt: 60.5,
    dirtArcRadiusFt: 95,
    outfieldFenceFt: 330,
  },
};

/** Foul pole distance scales proportionally: 60ft→200ft, 90ft→300ft */
export function foulPoleDistFt(basepathFt: number): number {
  return basepathFt * 10 / 3;
}

/** Batter's box offset from HP center along the 1B/3B axis, in meters */
const BATTERS_BOX_OFFSET_M = 0.381 / 2 + 0.1524 + 1.22 / 2; // half HP width + 6" gap + half box width

/**
 * Compute the field's forward direction and right vector from HP position
 * and a forward direction (toward center field / 2B).
 */
function fieldAxes(forwardX: number, forwardZ: number) {
  const fLen = Math.sqrt(forwardX * forwardX + forwardZ * forwardZ);
  if (fLen < 1e-6) return null;
  const fwdX = forwardX / fLen;
  const fwdZ = forwardZ / fLen;
  // Right vector (perpendicular, pointing toward 1B)
  const rightX = fwdZ;
  const rightZ = -fwdX;
  // Diagonal axes (45° from forward)
  const s = 1 / Math.SQRT2;
  return {
    fwdX, fwdZ, rightX, rightZ,
    to1bX: s * (fwdX + rightX), to1bZ: s * (fwdZ + rightZ),
    to3bX: s * (fwdX - rightX), to3bZ: s * (fwdZ - rightZ),
  };
}

/**
 * Compute world positions for all field landmarks given home plate position
 * and a forward direction (from home plate toward center field / 2nd base).
 */
export function computeLandmarkPositions(
  homeX: number, homeY: number, homeZ: number,
  forwardX: number, forwardZ: number,
  templateKey: string
): { kind: string; x: number; y: number; z: number }[] {
  const t = FIELD_TEMPLATES[templateKey] ?? FIELD_TEMPLATES.regulation;
  const bp = t.basepathFt * FT_TO_M;
  const rubberDist = t.rubberDistFt * FT_TO_M;
  const foulDist = foulPoleDistFt(t.basepathFt) * FT_TO_M;
  const axes = fieldAxes(forwardX, forwardZ);
  if (!axes) return [];

  const { fwdX, fwdZ, rightX, rightZ, to1bX, to1bZ, to3bX, to3bZ } = axes;

  return [
    { kind: "home_plate", x: homeX, y: homeY, z: homeZ },
    { kind: "first_base", x: homeX + to1bX * bp, y: homeY, z: homeZ + to1bZ * bp },
    { kind: "second_base", x: homeX + fwdX * bp * Math.SQRT2, y: homeY, z: homeZ + fwdZ * bp * Math.SQRT2 },
    { kind: "third_base", x: homeX + to3bX * bp, y: homeY, z: homeZ + to3bZ * bp },
    { kind: "rubber", x: homeX + fwdX * rubberDist, y: homeY, z: homeZ + fwdZ * rubberDist },
    // Batter's boxes: offset left/right of HP along the 1B-3B axis
    { kind: "batters_box_right", x: homeX + rightX * BATTERS_BOX_OFFSET_M, y: homeY, z: homeZ + rightZ * BATTERS_BOX_OFFSET_M },
    { kind: "batters_box_left", x: homeX - rightX * BATTERS_BOX_OFFSET_M, y: homeY, z: homeZ - rightZ * BATTERS_BOX_OFFSET_M },
    // Foul lines: placed at home plate, rendered extending toward 1B/3B directions
    // (The Swift viz offsets the geometry to extend from the anchor point outward)
    { kind: "foul_line_1b", x: homeX, y: homeY, z: homeZ },
    { kind: "foul_line_3b", x: homeX, y: homeY, z: homeZ },
    // Foul poles at the far end of each foul line
    { kind: "foul_pole_right", x: homeX + to1bX * foulDist, y: homeY, z: homeZ + to1bZ * foulDist },
    { kind: "foul_pole_left", x: homeX + to3bX * foulDist, y: homeY, z: homeZ + to3bZ * foulDist },
    // Outfield wall: semicircular arc centered at HP. Radius encoded in kind name for Swift.
    { kind: `outfield_wall-${(t.outfieldFenceFt * FT_TO_M).toFixed(1)}`, x: homeX, y: homeY, z: homeZ },
  ];
}

/**
 * Recompute all field positions after a base is moved.
 * HP stays fixed; new basepath = dist(HP, movedBase); new field rotation derived from HP→movedBase angle.
 */
export function recomputeFieldFromBase(
  hp: { x: number; y: number; z: number },
  movedBase: { x: number; y: number; z: number },
  movedKind: "first_base" | "second_base" | "third_base",
  templateKey: string,
  foulPoleRightDist?: number,  // custom foul pole distance if manually moved
  foulPoleLeftDist?: number,
): { kind: string; x: number; y: number; z: number }[] {
  const dx = movedBase.x - hp.x;
  const dz = movedBase.z - hp.z;
  const dist = Math.sqrt(dx * dx + dz * dz);

  // Derive basepath from the moved base
  let newBasepathM: number;
  if (movedKind === "second_base") {
    // 2B is at distance basepath * sqrt(2) from HP
    newBasepathM = dist / Math.SQRT2;
  } else {
    // 1B and 3B are at basepath distance from HP
    newBasepathM = dist;
  }

  // Derive forward direction (toward center field) from HP→movedBase
  let forwardX: number, forwardZ: number;
  if (movedKind === "first_base") {
    // 1B is 45° right of center field. Rotate HP→1B 45° left to get forward.
    const cos45 = Math.SQRT1_2;
    const sin45 = Math.SQRT1_2;
    forwardX = dx * cos45 + dz * sin45;
    forwardZ = -dx * sin45 + dz * cos45;
  } else if (movedKind === "third_base") {
    // 3B is 45° left of center field. Rotate HP→3B 45° right to get forward.
    const cos45 = Math.SQRT1_2;
    const sin45 = Math.SQRT1_2;
    forwardX = dx * cos45 - dz * sin45;
    forwardZ = dx * sin45 + dz * cos45;
  } else {
    // 2B is straight ahead (center field direction)
    forwardX = dx;
    forwardZ = dz;
  }

  // Create a temporary template with the new basepath
  const origTemplate = FIELD_TEMPLATES[templateKey] ?? FIELD_TEMPLATES.regulation;
  const newBasepathFt = newBasepathM / FT_TO_M;
  const scale = newBasepathFt / origTemplate.basepathFt;
  const newRubberDistFt = origTemplate.rubberDistFt * scale;

  // Compute all positions with the new scale and rotation
  const positions = computeLandmarkPositions(hp.x, hp.y, hp.z, forwardX, forwardZ, templateKey);

  // Override basepath-dependent positions with scaled values
  const axes = fieldAxes(forwardX, forwardZ);
  if (!axes) return positions;

  const { to1bX, to1bZ, to3bX, to3bZ, fwdX, fwdZ, rightX, rightZ } = axes;
  const foulDistDefault = foulPoleDistFt(newBasepathFt) * FT_TO_M;

  return positions.map((p) => {
    switch (p.kind) {
      case "first_base":
        return { ...p, x: hp.x + to1bX * newBasepathM, z: hp.z + to1bZ * newBasepathM };
      case "second_base":
        return { ...p, x: hp.x + fwdX * newBasepathM * Math.SQRT2, z: hp.z + fwdZ * newBasepathM * Math.SQRT2 };
      case "third_base":
        return { ...p, x: hp.x + to3bX * newBasepathM, z: hp.z + to3bZ * newBasepathM };
      case "rubber":
        return { ...p, x: hp.x + fwdX * newRubberDistFt * FT_TO_M, z: hp.z + fwdZ * newRubberDistFt * FT_TO_M };
      case "batters_box_right":
        return { ...p, x: hp.x + rightX * BATTERS_BOX_OFFSET_M, z: hp.z + rightZ * BATTERS_BOX_OFFSET_M };
      case "batters_box_left":
        return { ...p, x: hp.x - rightX * BATTERS_BOX_OFFSET_M, z: hp.z - rightZ * BATTERS_BOX_OFFSET_M };
      case "foul_pole_right": {
        const d = foulPoleRightDist ?? foulDistDefault;
        return { ...p, x: hp.x + to1bX * d, z: hp.z + to1bZ * d };
      }
      case "foul_pole_left": {
        const d = foulPoleLeftDist ?? foulDistDefault;
        return { ...p, x: hp.x + to3bX * d, z: hp.z + to3bZ * d };
      }
      default:
        return p;
    }
  });
}

/**
 * Generate the infield dirt boundary polygon in field coordinates (X, Z).
 * Field coords: origin at home plate, +X toward 1B, +Z toward 3B.
 */
export function generateDirtBoundary(
  templateKey: string
): [number, number][] {
  const t = FIELD_TEMPLATES[templateKey] ?? FIELD_TEMPLATES.regulation;
  const bp = t.basepathFt * FT_TO_M;
  const arcR = t.dirtArcRadiusFt * FT_TO_M;

  const diagDir = { x: 1 / Math.SQRT2, z: 1 / Math.SQRT2 };
  const moundX = t.rubberDistFt * FT_TO_M * diagDir.x;
  const moundZ = t.rubberDistFt * FT_TO_M * diagDir.z;

  const points: [number, number][] = [];
  const pastBase = 5 * FT_TO_M;

  points.push([0, -2 * FT_TO_M]);
  points.push([bp + pastBase, 0]);

  const arcSteps = 30;
  const startAngle = Math.atan2(0 - moundZ, (bp + pastBase) - moundX);
  const endAngle = Math.atan2((bp + pastBase) - moundZ, 0 - moundX);

  for (let i = 0; i <= arcSteps; i++) {
    const t_param = i / arcSteps;
    const angle = startAngle + t_param * (endAngle - startAngle);
    const x = moundX + arcR * Math.cos(angle);
    const z = moundZ + arcR * Math.sin(angle);
    points.push([x, z]);
  }

  points.push([0, bp + pastBase]);
  points.push([-2 * FT_TO_M, 0]);

  return points;
}
