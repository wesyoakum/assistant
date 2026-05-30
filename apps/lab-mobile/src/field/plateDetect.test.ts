// Run: node --experimental-strip-types --test src/field/plateDetect.test.ts
//
// Geometry-only tests for the Phase A plate-polygon layer (plateDetect.ts).
// No native/React deps, mirroring coordinateFrame.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  type Point2,
  simplifyPolyline,
  simplifyClosed,
  signedArea,
  validatePentagon,
  detectPlatePentagon,
} from "./plateDetect.ts";

// A canonical home plate drawn in image space, centered at (0.5, 0.5), apex
// pointing "down" (+y, toward the catcher in a y-down image). Real plate:
// 17" front edge, two 8.5" sides, two 12" edges to the apex. We scale inches
// into a ~0.3-wide normalized footprint. Geometry (apex at the 90° point, the
// two front corners square, the two back/side corners at 135°):
//   front-left  (-8.5, -back)   front-right (+8.5, -back)
//   side-left   (-8.5, +0)      side-right  (+8.5, +0)   ... then apex (0, +tip)
// Using the standard construction: square front section 17 wide, 8.5 deep, then
// a triangular tip 8.5 deep to the apex.
const IN = 0.01; // inches → normalized units
function canonicalPlate(): Point2[] {
  const halfW = 8.5 * IN;
  const frontY = -8.5 * IN; // front edge (toward pitcher), y-up-negative
  const sideY = 0;
  const apexY = 8.5 * IN; // apex (toward catcher)
  const cx = 0.5, cy = 0.5;
  // Order around the ring: FL → FR → SR → apex → SL
  return [
    { x: cx - halfW, y: cy + frontY }, // front-left
    { x: cx + halfW, y: cy + frontY }, // front-right
    { x: cx + halfW, y: cy + sideY },  // side-right
    { x: cx, y: cy + apexY },          // apex
    { x: cx - halfW, y: cy + sideY },  // side-left
  ];
}

/** Densify a polygon by sampling N points along each edge (simulates a contour). */
function densify(ring: Point2[], perEdge: number): Point2[] {
  const out: Point2[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    for (let t = 0; t < perEdge; t++) {
      const f = t / perEdge;
      out.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
    }
  }
  return out;
}

/** Add uniform jitter to every point. Deterministic via a seeded LCG. */
function jitter(points: Point2[], amp: number, seed = 1): Point2[] {
  let s = seed >>> 0;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s / 0xffffffff) * 2 - 1;
  };
  return points.map((p) => ({ x: p.x + rnd() * amp, y: p.y + rnd() * amp }));
}

test("simplifyPolyline collapses collinear points", () => {
  const line: Point2[] = [
    { x: 0, y: 0 }, { x: 0.25, y: 0 }, { x: 0.5, y: 0 }, { x: 0.75, y: 0 }, { x: 1, y: 0 },
  ];
  const out = simplifyPolyline(line, 0.001);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { x: 0, y: 0 });
  assert.deepEqual(out[1], { x: 1, y: 0 });
});

test("simplifyPolyline keeps a vertex that deviates beyond epsilon", () => {
  const bent: Point2[] = [
    { x: 0, y: 0 }, { x: 0.5, y: 0.2 }, { x: 1, y: 0 },
  ];
  const out = simplifyPolyline(bent, 0.05);
  assert.equal(out.length, 3); // the peak survives
});

test("simplifyClosed recovers 5 corners from a dense clean plate contour", () => {
  const plate = canonicalPlate();
  const contour = densify(plate, 20); // 100-point contour
  const ring = simplifyClosed(contour, 0.01);
  assert.equal(ring.length, 5, `expected 5 corners, got ${ring.length}`);
});

test("validatePentagon accepts a canonical plate and labels the apex", () => {
  const plate = canonicalPlate();
  const pent = validatePentagon(plate);
  assert.ok(pent, "canonical plate should validate");
  assert.ok(pent!.confidence > 0.8, `confidence ${pent!.confidence} too low`);
  // The apex we constructed is at (0.5, 0.5 + apexY); it must be corner[0].
  assert.ok(Math.abs(pent!.corners[0].x - 0.5) < 1e-6, "apex should be x-centered");
  assert.ok(pent!.corners[0].y > 0.5, "apex should be on the catcher (+y) side");
});

test("validatePentagon is winding-independent (reversed ring → same apex)", () => {
  const plate = canonicalPlate();
  const fwd = validatePentagon(plate);
  const rev = validatePentagon([...plate].reverse());
  assert.ok(fwd && rev);
  assert.ok(Math.abs(fwd!.corners[0].x - rev!.corners[0].x) < 1e-6);
  assert.ok(Math.abs(fwd!.corners[0].y - rev!.corners[0].y) < 1e-6);
});

test("validatePentagon rejects a square (4 vertices)", () => {
  const square: Point2[] = [
    { x: 0.4, y: 0.4 }, { x: 0.6, y: 0.4 }, { x: 0.6, y: 0.6 }, { x: 0.4, y: 0.6 },
  ];
  assert.equal(validatePentagon(square), null);
});

test("validatePentagon rejects a wildly non-plate pentagon (low confidence)", () => {
  // A regular-ish star-skewed pentagon with edge lengths nothing like a plate.
  const weird: Point2[] = [
    { x: 0.5, y: 0.1 }, { x: 0.9, y: 0.5 }, { x: 0.7, y: 0.9 },
    { x: 0.3, y: 0.88 }, { x: 0.12, y: 0.45 },
  ];
  const pent = validatePentagon(weird, { minConfidence: 0.7 });
  assert.equal(pent, null, "a non-plate pentagon should fail a 0.7 gate");
});

test("validatePentagon rejects a non-convex (arrow) pentagon", () => {
  const arrow: Point2[] = [
    { x: 0.2, y: 0.2 }, { x: 0.5, y: 0.5 }, { x: 0.8, y: 0.2 },
    { x: 0.8, y: 0.8 }, { x: 0.2, y: 0.8 },
  ];
  assert.equal(validatePentagon(arrow), null);
});

test("detectPlatePentagon survives a dense, jittered contour", () => {
  const plate = canonicalPlate();
  const contour = jitter(densify(plate, 24), 0.0015, 42);
  const pent = detectPlatePentagon(contour, { minConfidence: 0.6 });
  assert.ok(pent, "should detect a plate from a noisy contour");
  assert.equal(pent!.corners.length, 5);
  // Apex still near the +y center despite noise.
  assert.ok(Math.abs(pent!.corners[0].x - 0.5) < 0.02);
  assert.ok(pent!.corners[0].y > 0.5);
});

test("detectPlatePentagon returns null for a circle (no stable 5-gon)", () => {
  const circle: Point2[] = [];
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * Math.PI * 2;
    circle.push({ x: 0.5 + 0.2 * Math.cos(a), y: 0.5 + 0.2 * Math.sin(a) });
  }
  const pent = detectPlatePentagon(circle, { minConfidence: 0.7 });
  assert.equal(pent, null);
});

test("signedArea sign flips with winding", () => {
  const plate = canonicalPlate();
  const a = signedArea(plate);
  const b = signedArea([...plate].reverse());
  assert.ok(a * b < 0, "reversed winding should flip the sign");
});
