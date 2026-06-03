import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { batterBoxCorners, solveFromBatterBox, solveFromOuterCorners, outerCorners, BOX_WIDTH_FT, BOX_LENGTH_FT } from "./batterBox.ts";

const FT_TO_M = 0.3048;

describe("batterBoxCorners", () => {
  it("left box has correct dimensions (in meters)", () => {
    const box = batterBoxCorners("left");
    const { frontInside, frontOutside, backInside } = box.corners;

    // Width = 4 ft in meters
    const frontWidth = Math.hypot(frontOutside.x - frontInside.x, frontOutside.y - frontInside.y);
    const expectedWidth = BOX_WIDTH_FT * FT_TO_M;
    assert.ok(Math.abs(frontWidth - expectedWidth) < 0.02, `front width ${frontWidth} != ${expectedWidth}`);

    // Length = 6 ft in meters
    const insideLength = Math.hypot(frontInside.x - backInside.x, frontInside.y - backInside.y);
    const expectedLength = BOX_LENGTH_FT * FT_TO_M;
    assert.ok(Math.abs(insideLength - expectedLength) < 0.02, `inside length ${insideLength} != ${expectedLength}`);
  });

  it("left and right boxes are symmetric about the Y axis", () => {
    const left = batterBoxCorners("left");
    const right = batterBoxCorners("right");

    // Mirror across Y axis means x negates, y stays.
    for (const label of ["frontInside", "frontOutside", "backInside", "backOutside"] as const) {
      const lp = left.corners[label];
      const rp = right.corners[label];
      assert.ok(Math.abs(lp.x + rp.x) < 0.02, `${label} x not mirrored: ${lp.x} vs ${rp.x}`);
      assert.ok(Math.abs(lp.y - rp.y) < 0.02, `${label} y not equal: ${lp.y} vs ${rp.y}`);
    }
  });
});

describe("solveFromOuterCorners", () => {
  it("solves a synthetic projection", () => {
    const oc = outerCorners();
    const scale = 50;
    const ox = 200, oy = 400;
    const toImg = (p: { x: number; y: number }) => ({ u: ox + p.x * scale, v: oy + p.y * scale });
    const imgCorners = [
      toImg(oc.leftFrontOut), toImg(oc.rightFrontOut),
      toImg(oc.rightBackOut), toImg(oc.leftBackOut),
    ] as [{ u: number; v: number }, { u: number; v: number }, { u: number; v: number }, { u: number; v: number }];

    const pose = solveFromOuterCorners(imgCorners);
    assert.ok(pose, "solveFromOuterCorners returned null");
    assert.ok(pose.fit.rmsPx < 1, `RMS too high: ${pose.fit.rmsPx}`);
  });
});
