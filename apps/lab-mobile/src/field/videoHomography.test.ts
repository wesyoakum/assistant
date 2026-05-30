// Run: node --experimental-strip-types --test src/field/videoHomography.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  type Correspondence,
  type Homography,
  fitHomography,
  applyHomography,
  fieldToImage,
  imageToField,
} from "./videoHomography.ts";
import { fieldLandmarks } from "./fieldTemplate.ts";

/** Apply a known homography to make synthetic correspondences from field points. */
function project(H: Homography, x: number, z: number) {
  const p = applyHomography(H, x, z)!;
  return { u: p.x, v: p.y };
}

// A plausible "camera looking at the field" homography (perspective-ish): some
// scale, a little projective foreshortening in the h6/h7 terms.
const H_TRUE: Homography = [
  6.0, 1.5, 320,
  0.4, 5.0, 240,
  0.0008, 0.0015, 1,
];

test("recovers a known homography from 4 clean correspondences", () => {
  const fieldPts = [
    { x: 0, z: 0 }, { x: 90, z: 0 }, { x: 0, z: 90 }, { x: 90, z: 90 },
  ];
  const corr: Correspondence[] = fieldPts.map((f) => ({ field: f, image: project(H_TRUE, f.x, f.z) }));
  const fit = fitHomography(corr);
  assert.ok(fit, "should fit");
  assert.ok(fit!.rmsPx < 1e-6, `rms ${fit!.rmsPx}`);
  // Reproject an unseen field point and compare against the true H.
  const test = { x: 45, z: 30 };
  const got = fieldToImage(fit!.H, test)!;
  const want = applyHomography(H_TRUE, test.x, test.z)!;
  assert.ok(Math.hypot(got.x - want.x, got.y - want.y) < 1e-4, "predicts unseen point");
});

test("fieldToImage and imageToField round-trip through the fitted H/Hinv", () => {
  const fieldPts = [
    { x: 0, z: 0 }, { x: 90, z: 0 }, { x: 0, z: 90 }, { x: 90, z: 90 }, { x: 60, z: 10 },
  ];
  const corr: Correspondence[] = fieldPts.map((f) => ({ field: f, image: project(H_TRUE, f.x, f.z) }));
  const fit = fitHomography(corr)!;
  const p = { x: 33.3, z: 71.2 };
  const img = fieldToImage(fit.H, p)!;
  const back = imageToField(fit.Hinv, { u: img.x, v: img.y })!;
  assert.ok(Math.abs(back.x - p.x) < 1e-4 && Math.abs(back.z - p.z) < 1e-4, `round-trip ${JSON.stringify(back)}`);
});

test("over-determined fit (more than 4 points) is robust and low-error", () => {
  const L = fieldLandmarks("highSchool");
  const ids = ["apex", "first_base", "second_base", "third_base", "rubber", "foul_pole_first"] as const;
  const corr: Correspondence[] = ids.map((id) => ({ field: L[id], image: project(H_TRUE, L[id].x, L[id].z) }));
  const fit = fitHomography(corr);
  assert.ok(fit, "fits from 6 real landmarks");
  assert.ok(fit!.rmsPx < 1e-3, `rms ${fit!.rmsPx}`);
  assert.equal(fit!.count, 6);
});

test("tolerates pixel noise — error stays bounded, not blown up", () => {
  const L = fieldLandmarks("highSchool");
  const ids = ["apex", "first_base", "second_base", "third_base", "rubber", "foul_pole_first", "foul_pole_third"] as const;
  let seed = 9;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return (seed / 0xffffffff) * 2 - 1; };
  const corr: Correspondence[] = ids.map((id) => {
    const t = project(H_TRUE, L[id].x, L[id].z);
    return { field: L[id], image: { u: t.u + rnd() * 1.5, v: t.v + rnd() * 1.5 } }; // ±1.5px
  });
  const fit = fitHomography(corr)!;
  // With ~1.5px input noise the reprojection RMS should be a few px, not huge.
  assert.ok(fit.rmsPx < 6, `rms under noise ${fit.rmsPx}`);
});

test("returns null with fewer than 4 correspondences", () => {
  const L = fieldLandmarks();
  const corr: Correspondence[] = [
    { field: L.apex, image: { u: 1, v: 2 } },
    { field: L.first_base, image: { u: 3, v: 4 } },
    { field: L.third_base, image: { u: 5, v: 6 } },
  ];
  assert.equal(fitHomography(corr), null);
});

test("returns null for degenerate (collinear) field points", () => {
  // All on the +x axis → can't define a 2D homography.
  const corr: Correspondence[] = [
    { field: { x: 0, z: 0 }, image: { u: 10, v: 10 } },
    { field: { x: 30, z: 0 }, image: { u: 40, v: 12 } },
    { field: { x: 60, z: 0 }, image: { u: 70, v: 14 } },
    { field: { x: 90, z: 0 }, image: { u: 100, v: 16 } },
  ];
  const fit = fitHomography(corr);
  // Degenerate input: either null, or a fit that fails to invert — both acceptable,
  // but it must not silently return a usable-looking mapping.
  if (fit) assert.ok(fit.rmsPx > 1 || !Number.isFinite(fit.rmsPx), "collinear should not yield a clean fit");
});

test("a real-ish field reconciliation: back-project a base pixel to field coords", () => {
  // Simulate: camera homography H_TRUE; we labeled apex/1B/3B/2B + rubber; then we
  // detect a player standing on 1B at its projected pixel and recover its field pos.
  const L = fieldLandmarks("highSchool");
  const labeled = ["apex", "first_base", "third_base", "second_base", "rubber"] as const;
  const corr: Correspondence[] = labeled.map((id) => ({ field: L[id], image: project(H_TRUE, L[id].x, L[id].z) }));
  const fit = fitHomography(corr)!;
  // The "detected" pixel of someone on first base:
  const firstBasePixel = project(H_TRUE, L.first_base.x, L.first_base.z);
  const recovered = imageToField(fit.Hinv, firstBasePixel)!;
  assert.ok(Math.hypot(recovered.x - L.first_base.x, recovered.z - L.first_base.z) < 0.01,
    `recovered ${JSON.stringify(recovered)} vs 1B ${JSON.stringify(L.first_base)}`);
});
