// Run: node --experimental-strip-types --test src/field/foulLine.test.ts
//
// Foul-line yaw maintenance (foulLine.ts). Pure geometry, no native deps.

import { test } from "node:test";
import assert from "node:assert/strict";
import { type GroundPointXZ, fitFoulLines } from "./foulLine.ts";

/** Points along a ray from the origin at `angleRad`, from r0..r1 meters, with
 *  optional perpendicular jitter. Deterministic LCG. */
function ray(angleRad: number, r0: number, r1: number, n: number, jitter = 0, seed = 1): GroundPointXZ[] {
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return (s / 0xffffffff) * 2 - 1; };
  const dx = Math.cos(angleRad), dz = Math.sin(angleRad);
  const px = -dz, pz = dx; // perpendicular
  const out: GroundPointXZ[] = [];
  for (let i = 0; i < n; i++) {
    const r = r0 + ((r1 - r0) * i) / (n - 1);
    const j = jitter ? rnd() * jitter : 0;
    out.push({ x: dx * r + px * j, z: dz * r + pz * j });
  }
  return out;
}

const DEG = Math.PI / 180;

test("perfectly-aligned foul lines → ~zero yaw drift", () => {
  const pts = [...ray(0, 3, 25, 30), ...ray(Math.PI / 2, 3, 25, 30)];
  const fit = fitFoulLines(pts);
  assert.ok(fit.lineFirst && fit.lineThird, "both lines fit");
  assert.ok(Math.abs(fit.yawDriftRad) < 0.5 * DEG, `yaw drift ${(fit.yawDriftRad / DEG).toFixed(2)}°`);
  assert.ok(fit.orthogonalityErrorRad < 0.5 * DEG, "orthogonal");
  assert.ok(fit.confidence > 0.8, `confidence ${fit.confidence}`);
});

test("recovers a known yaw drift (lines rotated +5°)", () => {
  const d = 5 * DEG;
  const pts = [...ray(0 + d, 3, 25, 30, 0.02), ...ray(Math.PI / 2 + d, 3, 25, 30, 0.02)];
  const fit = fitFoulLines(pts);
  assert.ok(Math.abs(fit.yawDriftRad - d) < 1 * DEG, `recovered ${(fit.yawDriftRad / DEG).toFixed(2)}°, expected 5°`);
});

test("batter's-box chalk near the plate is excluded (does not corrupt the fit)", () => {
  // Real foul lines, rotated +4°, plus a dense batch of box chalk within 1m at a
  // wild angle that would wreck a naive fit.
  const d = 4 * DEG;
  const foul = [...ray(0 + d, 3, 25, 30), ...ray(Math.PI / 2 + d, 3, 25, 30)];
  const box: GroundPointXZ[] = [];
  for (let i = 0; i < 40; i++) {
    const a = 0.6 + (i / 40) * 0.4; // ~34-57°, nothing like the foul axes
    const r = 0.4 + (i % 5) * 0.1;  // 0.4-0.8m — well inside the 2m exclusion
    box.push({ x: Math.cos(a) * r, z: Math.sin(a) * r });
  }
  const withBox = fitFoulLines([...foul, ...box]);
  const withoutBox = fitFoulLines(foul);
  assert.ok(Math.abs(withBox.yawDriftRad - 4 * DEG) < 1 * DEG, `box corrupted yaw: ${(withBox.yawDriftRad / DEG).toFixed(2)}°`);
  // The exclusion means box points never entered either line's inlier set.
  assert.equal(withBox.firstInliers, withoutBox.firstInliers);
  assert.equal(withBox.thirdInliers, withoutBox.thirdInliers);
});

test("exclusion radius is honored (points inside 2m dropped, outside kept)", () => {
  const near = ray(0, 0.5, 1.8, 20);  // all inside 2m
  const far = ray(0, 2.5, 20, 20);    // all outside
  const fit = fitFoulLines([...near, ...far], { minInliers: 4 });
  // Only the far points should count toward the 1B line.
  assert.equal(fit.firstInliers, 20, `expected 20 far inliers, got ${fit.firstInliers}`);
});

test("one missing foul line still yields a yaw estimate (lower confidence)", () => {
  const d = -6 * DEG;
  const onlyFirst = ray(0 + d, 3, 25, 30); // 3B line absent
  const fit = fitFoulLines(onlyFirst);
  assert.ok(fit.lineFirst && !fit.lineThird, "only 1B line fit");
  assert.ok(Math.abs(fit.yawDriftRad - d) < 1.5 * DEG, `yaw ${(fit.yawDriftRad / DEG).toFixed(2)}°`);
  assert.ok(fit.confidence < 0.8, "single line → reduced confidence");
});

test("no usable points → zero drift, zero confidence, no throw", () => {
  const fit = fitFoulLines([{ x: 0.1, z: 0.1 }, { x: -0.2, z: 0.05 }]); // all inside exclusion
  assert.equal(fit.lineFirst, null);
  assert.equal(fit.lineThird, null);
  assert.equal(fit.yawDriftRad, 0);
  assert.equal(fit.confidence, 0);
});

test("points on the negative axes (behind the plate) are not treated as foul lines", () => {
  // The catcher side / behind-plate: bearings near π and -π/2. These must NOT be
  // assigned to the +X / +Z foul rays.
  const behind = [...ray(Math.PI, 3, 25, 30), ...ray(-Math.PI / 2, 3, 25, 30)];
  const fit = fitFoulLines(behind);
  assert.equal(fit.firstInliers, 0, "nothing assigned to 1B from behind");
  assert.equal(fit.thirdInliers, 0, "nothing assigned to 3B from behind");
});
