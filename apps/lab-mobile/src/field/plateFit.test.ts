// Run: node --experimental-strip-types --test src/field/plateFit.test.ts
//
// Edge-line fitting + corner-by-intersection + lenient template fit.
// Pure geometry, no native deps (like coordinateFrame.test.ts / plateDetect).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  type Point2,
  fitLineTLS,
  fitLineRobust,
  intersectLines,
  fitEdgesAndIntersect,
  fitPlateTemplate,
  CANONICAL_PLATE_CORNERS_IN,
} from "./plateDetect.ts";

// A plate placed/rotated/scaled into an arbitrary observation frame, apex-first.
function makePlate(cx: number, cy: number, scale: number, rotRad: number): Point2[] {
  const c = Math.cos(rotRad), s = Math.sin(rotRad);
  return CANONICAL_PLATE_CORNERS_IN.map((p) => ({
    x: cx + scale * (c * p.x - s * p.y),
    y: cy + scale * (s * p.x + c * p.y),
  }));
}

/** Densify a closed polygon edge-by-edge into a contour. */
function densify(ring: Point2[], perEdge: number): Point2[] {
  const out: Point2[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
    for (let t = 0; t < perEdge; t++) {
      const f = t / perEdge;
      out.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
    }
  }
  return out;
}

function jitter(points: Point2[], amp: number, seed = 7): Point2[] {
  let st = seed >>> 0;
  const rnd = () => { st = (st * 1664525 + 1013904223) >>> 0; return (st / 0xffffffff) * 2 - 1; };
  return points.map((p) => ({ x: p.x + rnd() * amp, y: p.y + rnd() * amp }));
}

test("fitLineTLS recovers a known line and reports ~0 residual", () => {
  const pts: Point2[] = [];
  for (let i = 0; i <= 10; i++) pts.push({ x: i, y: 3 * i + 5 }); // y = 3x + 5
  const fit = fitLineTLS(pts);
  assert.ok(fit);
  assert.ok(fit!.rms < 1e-6, `rms ${fit!.rms}`);
  // Point on the line satisfies a·x + b·y = c.
  const r = Math.abs(fit!.line.a * 2 + fit!.line.b * 11 - fit!.line.c);
  assert.ok(r < 1e-6, `residual ${r}`);
});

test("fitLineRobust ignores a gross outlier", () => {
  const pts: Point2[] = [];
  for (let i = 0; i <= 10; i++) pts.push({ x: i, y: 2 * i });
  pts.push({ x: 5, y: 50 }); // outlier
  const fit = fitLineRobust(pts, 0.2);
  assert.ok(fit);
  // Slope ~2 → normal ∝ (2,-1). Check a clean point is near the line.
  const r = Math.abs(fit!.line.a * 8 + fit!.line.b * 16 - fit!.line.c);
  assert.ok(r < 0.2, `residual ${r}`);
});

test("intersectLines returns the crossing point; null when parallel", () => {
  const l1 = { a: 0, b: 1, c: 0 };  // y = 0
  const l2 = { a: 1, b: 0, c: 4 };  // x = 4
  const p = intersectLines(l1, l2);
  assert.ok(p);
  assert.ok(Math.abs(p!.x - 4) < 1e-9 && Math.abs(p!.y) < 1e-9);
  assert.equal(intersectLines({ a: 0, b: 1, c: 0 }, { a: 0, b: 1, c: 3 }), null);
});

test("corner-by-intersection beats the seed when corners are blurred/missing", () => {
  // Truth plate in the frame.
  const truth = makePlate(100, 80, 2.0, 0.3);
  // Dense contour, jittered.
  const contour = jitter(densify(truth, 30), 0.4, 11);
  // Seeds: the true corners, deliberately knocked off (as if DP found rounded
  // corners) — pull each toward the centroid by 8%.
  const cx = truth.reduce((s, p) => s + p.x, 0) / 5;
  const cy = truth.reduce((s, p) => s + p.y, 0) / 5;
  const seeds = truth.map((p) => ({ x: p.x + (cx - p.x) * 0.08, y: p.y + (cy - p.y) * 0.08 }));

  const rec = fitEdgesAndIntersect(contour, seeds, { cornerTrimFrac: 0.2 });
  assert.ok(rec, "recovery should succeed");
  // Recovered corners should be closer to truth than the seeds were.
  let seedErr = 0, recErr = 0;
  for (let i = 0; i < 5; i++) {
    seedErr += Math.hypot(seeds[i]!.x - truth[i]!.x, seeds[i]!.y - truth[i]!.y);
    recErr += Math.hypot(rec!.corners[i]!.x - truth[i]!.x, rec!.corners[i]!.y - truth[i]!.y);
  }
  assert.ok(recErr < seedErr * 0.5, `recErr ${recErr.toFixed(2)} vs seedErr ${seedErr.toFixed(2)}`);
  assert.ok(rec!.cornerOk.every((ok) => ok), "all corners from intersection");
});

test("corner recovery works with one edge fully occluded (seed fallback there)", () => {
  const truth = makePlate(50, 50, 1.5, -0.4);
  let contour = densify(truth, 30);
  // Remove all points belonging to edge 0 (apex→side-right): drop points whose
  // nearest edge is that one. Simulate occlusion by filtering a band.
  const a = truth[0]!, b = truth[1]!;
  contour = contour.filter((p) => {
    const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
    const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    const cxp = a.x + t * dx, cyp = a.y + t * dy;
    const d = Math.hypot(p.x - cxp, p.y - cyp);
    return !(t > 0.05 && t < 0.95 && d < 0.5); // drop that edge's points
  });
  const seeds = truth.map((p) => ({ ...p }));
  const rec = fitEdgesAndIntersect(jitter(contour, 0.2), seeds, { minEdgePoints: 4 });
  assert.ok(rec);
  // Edge 0 should be unfittable; corners touching it fall back, others still OK.
  assert.equal(rec!.edgeFits[0]!.line, null);
  // Corners NOT adjacent to edge 0 (corner 2 and 3) should be confident.
  assert.ok(rec!.cornerOk[2] && rec!.cornerOk[3]);
});

test("fitPlateTemplate snaps the known plate and recovers pose exactly (clean)", () => {
  const truth = makePlate(200, 150, 3.0, 0.7);
  const fit = fitPlateTemplate(truth);
  assert.ok(fit);
  assert.ok(fit!.rmsInches < 1e-6, `rmsInches ${fit!.rmsInches}`);
  assert.ok(Math.abs(fit!.scale - 3.0) < 1e-6, `scale ${fit!.scale}`);
  assert.ok(Math.abs(fit!.rotationRad - 0.7) < 1e-6, `rot ${fit!.rotationRad}`);
  assert.ok(fit!.confidence > 0.99);
});

test("fitPlateTemplate ALWAYS returns a plate-shaped pose, even from a rough blob", () => {
  // A deliberately sloppy quad-ish set of 5 points nothing like exact plate.
  const sloppy: Point2[] = [
    { x: 0, y: 20 }, { x: 11, y: 9 }, { x: 9, y: -1 }, { x: -8, y: 0 }, { x: -10, y: 10 },
  ];
  const fit = fitPlateTemplate(sloppy);
  assert.ok(fit, "must still return a pose (no gate)");
  // Output is GUARANTEED a real plate: the snapped front edge is exactly 17·scale.
  const front = Math.hypot(
    fit!.snappedCorners[2]!.x - fit!.snappedCorners[3]!.x,
    fit!.snappedCorners[2]!.y - fit!.snappedCorners[3]!.y,
  );
  assert.ok(Math.abs(front / fit!.scale - 17) < 1e-6, "snapped front edge is exactly 17in");
  assert.ok(fit!.confidence > 0 && fit!.confidence <= 1);
});

test("fitPlateTemplate places from only 3 corners (2 occluded)", () => {
  const truth = makePlate(0, 0, 2.0, 0.2);
  const partial: (Point2 | null)[] = [truth[0]!, truth[1]!, truth[2]!, null, null];
  const fit = fitPlateTemplate(partial);
  assert.ok(fit, "3 corners is enough");
  assert.ok(fit!.rmsInches < 1e-6);
  // The snapped (missing) corner 4 should land on the true corner 4.
  const c4 = fit!.snappedCorners[4]!;
  assert.ok(Math.hypot(c4.x - truth[4]!.x, c4.y - truth[4]!.y) < 1e-6, "occluded corner reconstructed");
});

test("weights let low-confidence corners pull the fit less", () => {
  const truth = makePlate(10, 10, 1.0, 0);
  const obs = truth.map((p) => ({ ...p }));
  obs[0] = { x: obs[0]!.x + 6, y: obs[0]!.y + 6 }; // corrupt the apex badly
  const equal = fitPlateTemplate(obs)!;
  const downweighted = fitPlateTemplate(obs, { weights: [0.05, 1, 1, 1, 1] })!;
  // Down-weighting the bad apex should reduce residual on the good corners.
  assert.ok(downweighted.rmsInches < equal.rmsInches, `${downweighted.rmsInches} < ${equal.rmsInches}`);
});
