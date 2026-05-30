// Unit tests for the home-plate-from-corners geometry (Phase 0 of the AR
// world-anchor work). No test framework dependency — uses Node's built-in
// runner. Run with:
//
//   node --experimental-strip-types --test src/field/coordinateFrame.test.ts
//
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeHomePlatePose,
  computeFieldFrameFromCorners,
  computeFieldFrame,
  transformPoint,
  HOME_PLATE_FRONT_EDGE_M,
  type Vec3,
} from "./coordinateFrame.ts";

const IN = 0.0254;

// Canonical home plate, flat on the XZ plane (y = 0), apex at the origin,
// "toward pitcher" pointing along +Z. Dimensions: 17" front edge, 8.5" sides,
// apex depth ~8.47" so the two back edges are 12" and meet at ~90°.
const HALF = 8.5 * IN; // half the front edge / half the side spacing
const APEX_DEPTH = Math.sqrt((12 * IN) ** 2 - HALF ** 2); // ~0.2151 m
const FRONT_Z = HALF + APEX_DEPTH;

const CANONICAL: Record<string, Vec3> = {
  apex: { x: 0, y: 0, z: 0 },
  sideL: { x: -HALF, y: 0, z: APEX_DEPTH },
  sideR: { x: +HALF, y: 0, z: APEX_DEPTH },
  frontL: { x: -HALF, y: 0, z: FRONT_Z },
  frontR: { x: +HALF, y: 0, z: FRONT_Z },
};
// Deliberately shuffled — the detector returns corners in arbitrary order.
const CANONICAL_CORNERS = [
  CANONICAL.frontR, CANONICAL.apex, CANONICAL.frontL, CANONICAL.sideR, CANONICAL.sideL,
];

function approx(a: number, b: number, eps = 1e-6) {
  assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b} (±${eps})`);
}
function approxVec(a: Vec3, b: Vec3, eps = 1e-6) {
  approx(a.x, b.x, eps); approx(a.y, b.y, eps); approx(a.z, b.z, eps);
}
function rotY(v: Vec3, rad: number): Vec3 {
  const c = Math.cos(rad), s = Math.sin(rad);
  return { x: c * v.x + s * v.z, y: v.y, z: -s * v.x + c * v.z };
}

test("recovers forward, up, right and apex from canonical corners", () => {
  const pose = computeHomePlatePose(CANONICAL_CORNERS);
  assert.ok(pose);
  approxVec(pose.forward, { x: 0, y: 0, z: 1 }, 1e-9); // toward pitcher = +Z
  approxVec(pose.up, { x: 0, y: 1, z: 0 }, 1e-9);
  approxVec(pose.right, { x: 1, y: 0, z: 0 }, 1e-9); // toward 1B = +X
  approxVec(pose.apex, CANONICAL.apex, 1e-9);
});

test("front edge length matches 17in and scaleError is ~0", () => {
  const pose = computeHomePlatePose(CANONICAL_CORNERS)!;
  approx(pose.frontEdgeLengthM, HOME_PLATE_FRONT_EDGE_M, 1e-9);
  approx(pose.scaleError, 0, 1e-9);
});

test("center field still reports the plate centroid (kept for reference)", () => {
  const pose = computeHomePlatePose(CANONICAL_CORNERS)!;
  const expected: Vec3 = {
    x: 0,
    y: 0,
    z: (FRONT_Z + FRONT_Z + 0 + APEX_DEPTH + APEX_DEPTH) / 5,
  };
  approxVec(pose.center, expected, 1e-9);
});

test("field origin is the APEX, not the centroid", () => {
  const pose = computeHomePlatePose(CANONICAL_CORNERS)!;
  // fieldToWorld translation column == origin == apex.
  approxVec(pose.apex, CANONICAL.apex, 1e-9);
  approx(pose.frame.fieldToWorld[12]!, pose.apex.x, 1e-9);
  approx(pose.frame.fieldToWorld[13]!, pose.apex.y, 1e-9);
  approx(pose.frame.fieldToWorld[14]!, pose.apex.z, 1e-9);
  // The apex maps to the field-frame origin.
  approxVec(transformPoint(pose.apex, pose.frame.worldToField), { x: 0, y: 0, z: 0 }, 1e-6);
});

test("worldToField maps a point 1B-ward of the apex onto the +X field axis", () => {
  const pose = computeHomePlatePose(CANONICAL_CORNERS)!;
  const d = 27.4; // arbitrary distance toward first base
  // The +X field basis in world coords is column 0 of fieldToWorld.
  const world: Vec3 = {
    x: pose.apex.x + pose.frame.fieldToWorld[0]! * d,
    y: pose.apex.y + pose.frame.fieldToWorld[1]! * d,
    z: pose.apex.z + pose.frame.fieldToWorld[2]! * d,
  };
  const field = transformPoint(world, pose.frame.worldToField);
  approxVec(field, { x: d, y: 0, z: 0 }, 1e-6);
});

test("worldToField and fieldToWorld are true inverses (round-trip)", () => {
  const pose = computeHomePlatePose(CANONICAL_CORNERS)!;
  const p: Vec3 = { x: 4.2, y: -0.3, z: -7.1 };
  const back = transformPoint(transformPoint(p, pose.frame.worldToField), pose.frame.fieldToWorld);
  approxVec(back, p, 1e-9);
});

// Regression for the invertAffine fix: on a rotated diamond (the realistic case,
// since ARKit's world axes are arbitrary) worldToField must still map toward-1B
// to field +X and round-trip cleanly. The old transpose bug failed both.
test("computeFieldFrame inverts correctly for a rotated (non-axis-aligned) field", () => {
  const s = Math.SQRT1_2;
  const hp: Vec3 = { x: 0, y: 0, z: 0 };
  const fb: Vec3 = { x: s, y: 0, z: s };   // toward first base, 45° in XZ
  const tb: Vec3 = { x: -s, y: 0, z: s };  // toward third base, perpendicular
  const f = computeFieldFrame({ home_plate: hp, first_base: fb, third_base: tb })!;
  approxVec(transformPoint(fb, f.worldToField), { x: 1, y: 0, z: 0 }, 1e-9);
  approxVec(transformPoint(tb, f.worldToField), { x: 0, y: 0, z: 1 }, 1e-9);
  approxVec(transformPoint(transformPoint(fb, f.worldToField), f.fieldToWorld), fb, 1e-9);
});

test("foul-line angle is 90 degrees and axes are right-handed (X×Y=Z)", () => {
  const f = computeFieldFrameFromCorners(CANONICAL_CORNERS)!;
  approx(f.foulLineAngleDeg, 90, 1e-9);
  const m = f.fieldToWorld;
  const X = { x: m[0]!, y: m[1]!, z: m[2]! };
  const Y = { x: m[4]!, y: m[5]!, z: m[6]! };
  const Z = { x: m[8]!, y: m[9]!, z: m[10]! };
  const XcrossY = {
    x: X.y * Y.z - X.z * Y.y,
    y: X.z * Y.x - X.x * Y.z,
    z: X.x * Y.y - X.y * Y.x,
  };
  approxVec(XcrossY, Z, 1e-9);
});

test("is invariant to world rotation + translation (apart from the rotated frame)", () => {
  const ang = 0.7; // radians
  const t: Vec3 = { x: 3, y: -1.5, z: 8 };
  const moved = CANONICAL_CORNERS.map((c) => {
    const r = rotY(c, ang);
    return { x: r.x + t.x, y: r.y + t.y, z: r.z + t.z };
  });
  const pose = computeHomePlatePose(moved)!;
  // forward should be +Z rotated by the same angle
  approxVec(pose.forward, rotY({ x: 0, y: 0, z: 1 }, ang), 1e-6);
  approxVec(pose.right, rotY({ x: 1, y: 0, z: 0 }, ang), 1e-6);
  approx(pose.scaleError, 0, 1e-9); // scale is rotation/translation invariant
});

test("scaleError flags an over-sized (false-positive) detection", () => {
  const bloated = CANONICAL_CORNERS.map((c) => ({ x: c.x * 1.5, y: c.y, z: c.z * 1.5 }));
  const pose = computeHomePlatePose(bloated)!;
  approx(pose.scaleError, 0.5, 1e-6);
});

test("honors a tilted ground normal", () => {
  // Tilt the plate 10° about the X axis and pass the matching normal.
  const tilt = (10 * Math.PI) / 180;
  const rotX = (v: Vec3): Vec3 => ({
    x: v.x,
    y: Math.cos(tilt) * v.y - Math.sin(tilt) * v.z,
    z: Math.sin(tilt) * v.y + Math.cos(tilt) * v.z,
  });
  const tilted = CANONICAL_CORNERS.map(rotX);
  const normal = rotX({ x: 0, y: 1, z: 0 });
  const pose = computeHomePlatePose(tilted, { groundNormal: normal })!;
  approxVec(pose.up, normal, 1e-9);
  approx(pose.scaleError, 0, 1e-9);
});

test("returns null for the wrong number of corners", () => {
  assert.equal(computeHomePlatePose(CANONICAL_CORNERS.slice(0, 4)), null);
  assert.equal(computeFieldFrameFromCorners([]), null);
});
