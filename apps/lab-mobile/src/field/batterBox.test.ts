import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { batterBoxCorners, solveFromBatterBox, solveFromBothBoxes, solveFromOuterCorners, outerCorners, BOX_WIDTH_FT, BOX_LENGTH_FT } from "./batterBox.ts";

describe("batterBoxCorners", () => {
  it("left box has correct dimensions", () => {
    const box = batterBoxCorners("left");
    const { frontInside, frontOutside, backInside, backOutside } = box.corners;

    // Width = distance between inside and outside edges (should be 4 ft).
    const frontWidth = Math.hypot(frontOutside.x - frontInside.x, frontOutside.z - frontInside.z);
    assert.ok(Math.abs(frontWidth - BOX_WIDTH_FT) < 0.01, `front width ${frontWidth} != ${BOX_WIDTH_FT}`);

    const backWidth = Math.hypot(backOutside.x - backInside.x, backOutside.z - backInside.z);
    assert.ok(Math.abs(backWidth - BOX_WIDTH_FT) < 0.01, `back width ${backWidth} != ${BOX_WIDTH_FT}`);

    // Length = distance between front and back edges (should be 6 ft).
    const insideLength = Math.hypot(frontInside.x - backInside.x, frontInside.z - backInside.z);
    assert.ok(Math.abs(insideLength - BOX_LENGTH_FT) < 0.01, `inside length ${insideLength} != ${BOX_LENGTH_FT}`);

    const outsideLength = Math.hypot(frontOutside.x - backOutside.x, frontOutside.z - backOutside.z);
    assert.ok(Math.abs(outsideLength - BOX_LENGTH_FT) < 0.01, `outside length ${outsideLength} != ${BOX_LENGTH_FT}`);
  });

  it("right box has correct dimensions", () => {
    const box = batterBoxCorners("right");
    const { frontInside, frontOutside, backInside } = box.corners;

    const frontWidth = Math.hypot(frontOutside.x - frontInside.x, frontOutside.z - frontInside.z);
    assert.ok(Math.abs(frontWidth - BOX_WIDTH_FT) < 0.01, `front width ${frontWidth} != ${BOX_WIDTH_FT}`);

    const insideLength = Math.hypot(frontInside.x - backInside.x, frontInside.z - backInside.z);
    assert.ok(Math.abs(insideLength - BOX_LENGTH_FT) < 0.01, `inside length ${insideLength} != ${BOX_LENGTH_FT}`);
  });

  it("left and right boxes are mirror images across the diagonal", () => {
    const left = batterBoxCorners("left");
    const right = batterBoxCorners("right");

    // Mirror across the home→2B diagonal means swapping x and z.
    // frontInside of left box mirrored = frontInside of right box.
    for (const label of ["frontInside", "frontOutside", "backInside", "backOutside"] as const) {
      const lp = left.corners[label];
      const rp = right.corners[label];
      assert.ok(Math.abs(lp.x - rp.z) < 0.01, `${label} mirror x: ${lp.x} != ${rp.z}`);
      assert.ok(Math.abs(lp.z - rp.x) < 0.01, `${label} mirror z: ${lp.z} != ${rp.x}`);
    }
  });

  it("inside edge is 6 inches from the plate edge", () => {
    const box = batterBoxCorners("left");
    // The inside edge runs parallel to the diagonal. The perpendicular
    // distance from the plate edge to the inside edge should be 6".
    // Plate half-width = 17/12/2 ft. Inside offset = half-width + 0.5 ft.
    // We verify indirectly: the inside corners should be at the expected
    // lateral distance from the plate center line (the diagonal).
    const { frontInside, backInside } = box.corners;

    // Distance from the diagonal (x = z line) for a point (x, z):
    //   d = |x - z| / √2
    const dFront = Math.abs(frontInside.x - frontInside.z) / Math.SQRT2;
    const dBack = Math.abs(backInside.x - backInside.z) / Math.SQRT2;

    // Expected: PLATE_WIDTH/2 + 6" gap = (17/12)/2 + 0.5 = 1.208 ft
    const expected = (17 / 12) / 2 + 0.5;
    assert.ok(Math.abs(dFront - expected) < 0.01, `front inside dist ${dFront} != ${expected}`);
    assert.ok(Math.abs(dBack - expected) < 0.01, `back inside dist ${dBack} != ${expected}`);
  });
});

describe("solveFromBatterBox", () => {
  it("solves a synthetic perspective projection", () => {
    const box = batterBoxCorners("left");

    const scale = 50;
    const ox = 200, oy = 400;
    const imageCorners = box.ordered.map((p) => ({
      u: ox + p.x * scale,
      v: oy + p.z * scale,
    })) as [{ u: number; v: number }, { u: number; v: number }, { u: number; v: number }, { u: number; v: number }];

    const pose = solveFromBatterBox(imageCorners, "left");
    assert.ok(pose, "solveFromBatterBox returned null");
    assert.ok(pose.fit.rmsPx < 1, `RMS too high: ${pose.fit.rmsPx}`);
    assert.deepStrictEqual(pose.sides, ["left"]);
  });
});

describe("solveFromBothBoxes", () => {
  it("solves from 8 points (both boxes)", () => {
    const left = batterBoxCorners("left");
    const right = batterBoxCorners("right");

    const scale = 50;
    const ox = 200, oy = 400;
    const toImg = (p: { x: number; z: number }) => ({ u: ox + p.x * scale, v: oy + p.z * scale });
    const lc = left.ordered.map(toImg) as [{ u: number; v: number }, { u: number; v: number }, { u: number; v: number }, { u: number; v: number }];
    const rc = right.ordered.map(toImg) as [{ u: number; v: number }, { u: number; v: number }, { u: number; v: number }, { u: number; v: number }];

    const pose = solveFromBothBoxes(lc, rc);
    assert.ok(pose, "solveFromBothBoxes returned null");
    assert.ok(pose.fit.rmsPx < 1, `RMS too high: ${pose.fit.rmsPx}`);
    assert.deepStrictEqual(pose.sides, ["left", "right"]);
    assert.equal(pose.fit.count, 8);
  });
});

describe("solveFromOuterCorners", () => {
  it("solves from 4 outer corners", () => {
    const oc = outerCorners();
    const scale = 50;
    const ox = 200, oy = 400;
    const toImg = (p: { x: number; z: number }) => ({ u: ox + p.x * scale, v: oy + p.z * scale });
    const imgCorners = [
      toImg(oc.leftFrontOut),
      toImg(oc.rightFrontOut),
      toImg(oc.rightBackOut),
      toImg(oc.leftBackOut),
    ] as [{ u: number; v: number }, { u: number; v: number }, { u: number; v: number }, { u: number; v: number }];

    const pose = solveFromOuterCorners(imgCorners);
    assert.ok(pose, "solveFromOuterCorners returned null");
    assert.ok(pose.fit.rmsPx < 1, `RMS too high: ${pose.fit.rmsPx}`);
    assert.deepStrictEqual(pose.sides, ["left", "right"]);
  });
});
