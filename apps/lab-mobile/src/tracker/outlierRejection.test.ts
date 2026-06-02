import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rejectOutliers, type TrackedFrameLike } from "./outlierRejection.ts";

function makeFrame(i: number, t: number, cx: number, cy: number): TrackedFrameLike {
  const hw = 0.02;
  return { frameIndex: i, timeSec: t, box: { x: cx - hw / 2, y: cy - hw / 2, width: hw, height: hw }, lost: false };
}
function lostFrame(i: number, t: number): TrackedFrameLike {
  return { frameIndex: i, timeSec: t, box: null, lost: true };
}

describe("rejectOutliers", () => {
  it("keeps all points on a clean parabola", () => {
    const frames: TrackedFrameLike[] = [];
    for (let i = 0; i < 30; i++) {
      const t = i / 30;
      const cx = 0.3 + t * 0.4;
      const cy = 0.5 - 0.1 * t + 0.15 * t * t;
      frames.push(makeFrame(i, t, cx, cy));
    }
    const r = rejectOutliers(frames);
    assert.ok(r.applied);
    assert.equal(r.outlierCount, 0);
    assert.equal(r.inlierCount, 30);
    assert.ok(r.r2 > 0.99);
  });

  it("rejects random outliers", () => {
    const frames: TrackedFrameLike[] = [];
    let trueCount = 0;
    for (let i = 0; i < 60; i++) {
      const t = i / 30;
      if (i % 4 === 0) {
        // Outlier: random position
        frames.push(makeFrame(i, t, Math.random(), Math.random()));
      } else {
        const u = i / 60;
        frames.push(makeFrame(i, t, 0.3 + u * 0.4, 0.5 - 0.1 * u + 0.15 * u * u));
        trueCount++;
      }
    }
    const r = rejectOutliers(frames);
    assert.ok(r.applied);
    assert.ok(r.outlierCount > 0, `should reject some outliers, got ${r.outlierCount}`);
    assert.ok(r.inlierCount >= trueCount * 0.8, `should keep most true points: ${r.inlierCount} vs ${trueCount}`);
  });

  it("rejects outliers all above the trajectory", () => {
    const frames: TrackedFrameLike[] = [];
    for (let i = 0; i < 50; i++) {
      const t = i / 30;
      const u = i / 50;
      if (i % 3 === 0) {
        // Outlier above: low cy values (top of image)
        frames.push(makeFrame(i, t, 0.3 + u * 0.4, 0.1 + Math.random() * 0.2));
      } else {
        // Real: in the lower part
        frames.push(makeFrame(i, t, 0.3 + u * 0.4, 0.6 + 0.05 * u + 0.1 * u * u));
      }
    }
    const r = rejectOutliers(frames);
    assert.ok(r.applied);
    assert.ok(r.outlierCount >= 10, `should reject above-trajectory outliers: ${r.outlierCount}`);
  });

  it("skips with fewer than 3 detections", () => {
    const frames = [makeFrame(0, 0, 0.5, 0.5), makeFrame(1, 0.03, 0.51, 0.51)];
    const r = rejectOutliers(frames);
    assert.equal(r.applied, false);
    assert.equal(r.inlierCount, 2);
  });

  it("handles lost frames gracefully", () => {
    const frames: TrackedFrameLike[] = [];
    for (let i = 0; i < 20; i++) {
      if (i % 3 === 0) frames.push(lostFrame(i, i / 30));
      else {
        const u = i / 20;
        frames.push(makeFrame(i, i / 30, 0.3 + u * 0.4, 0.5 + 0.1 * u * u));
      }
    }
    const r = rejectOutliers(frames);
    // Lost frames should have inlier=false, residual=null
    for (const label of r.labels) {
      const f = frames[label.frameIndex]!;
      if (f.lost) {
        assert.equal(label.residual, null);
      }
    }
  });

  it("keeps everything when all points are outliers (no consensus)", () => {
    const frames: TrackedFrameLike[] = [];
    for (let i = 0; i < 20; i++) {
      frames.push(makeFrame(i, i / 30, Math.random(), Math.random()));
    }
    const r = rejectOutliers(frames);
    // Should not apply (no coherent trajectory found)
    assert.equal(r.applied, false);
  });
});
