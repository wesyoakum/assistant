// Run: node --experimental-strip-types --test src/tracker/blobTrack.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { type GrayFrame, detectBlob } from "./blobTrack.ts";

/** Build a gray frame; `fill(x,y)` returns 0..255. */
function frame(W: number, H: number, fill: (x: number, y: number) => number): GrayFrame {
  const data = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data[y * W + x] = fill(x, y) | 0;
  return { data, width: W, height: H };
}

/** A bright disc of radius r at (cx,cy) on a dark field. */
function discFrame(W: number, H: number, cx: number, cy: number, r: number, bg = 30, fg = 240): GrayFrame {
  return frame(W, H, (x, y) => (Math.hypot(x - cx, y - cy) <= r ? fg : bg));
}

test("finds a bright moving disc and boxes it near the true center", () => {
  const W = 120, H = 90;
  const prev = discFrame(W, H, 40, 40, 4);   // ball was here
  const cur = discFrame(W, H, 80, 50, 4);    // ball moved here
  const d = detectBlob(cur, prev);
  assert.ok(d.box, "should detect a blob");
  assert.ok(d.confidence > 0.4, `confidence ${d.confidence}`);
  // Centroid near the new ball position (normalized).
  assert.ok(Math.abs(d.cx! - 80 / W) < 0.04, `cx ${d.cx}`);
  assert.ok(Math.abs(d.cy! - 50 / H) < 0.04, `cy ${d.cy}`);
});

test("ignores a bright region that did NOT move (static jersey/base)", () => {
  const W = 120, H = 90;
  // Same bright disc in both frames → no motion → rejected.
  const prev = discFrame(W, H, 60, 45, 4);
  const cur = discFrame(W, H, 60, 45, 4);
  const d = detectBlob(cur, prev);
  assert.equal(d.box, null, "static bright blob must be rejected by the motion cue");
});

test("rejects a huge bright region (sky / big jersey) via max area", () => {
  const W = 120, H = 90;
  const prev = frame(W, H, () => 20);
  // Top half suddenly bright and huge — exceeds maxAreaFrac.
  const cur = frame(W, H, (_, y) => (y < H / 2 ? 240 : 20));
  const d = detectBlob(cur, prev);
  assert.equal(d.box, null, "oversized bright region must be rejected");
});

test("rejects a non-round bright streak via fill ratio", () => {
  const W = 120, H = 90;
  const prev = frame(W, H, () => 20);
  // A thin 1px horizontal line: bbox is wide, fill ratio tiny.
  const cur = frame(W, H, (x, y) => (y === 45 && x >= 20 && x <= 70 ? 240 : 20));
  const d = detectBlob(cur, prev);
  assert.equal(d.box, null, "thin streak should fail the roundness/fill test");
});

test("first frame (no prev) still detects on brightness+shape, lower confidence", () => {
  const W = 120, H = 90;
  const cur = discFrame(W, H, 50, 50, 4);
  const withPrev = detectBlob(cur, discFrame(W, H, 10, 10, 4));
  const noPrev = detectBlob(cur, null);
  assert.ok(noPrev.box, "first frame should still find the disc");
  assert.ok(noPrev.confidence < withPrev.confidence, "no-motion confidence should be lower");
});

test("empty / mismatched frames are handled safely", () => {
  assert.equal(detectBlob({ data: [], width: 0, height: 0 }, null).box, null);
  const a = discFrame(10, 10, 5, 5, 2);
  const b = discFrame(12, 12, 5, 5, 2);
  assert.equal(detectBlob(a, b).box, null, "size mismatch → no crash, null box");
});

test("picks the larger valid ball when two moving blobs exist", () => {
  const W = 140, H = 100;
  const prev = frame(W, H, () => 20);
  // Small blob at (30,30) r=2, bigger ball at (100,60) r=5.
  const cur = frame(W, H, (x, y) => {
    if (Math.hypot(x - 30, y - 30) <= 2) return 240;
    if (Math.hypot(x - 100, y - 60) <= 5) return 240;
    return 20;
  });
  const d = detectBlob(cur, prev);
  assert.ok(d.box);
  assert.ok(Math.abs(d.cx! - 100 / W) < 0.05, `should pick the larger ball, cx ${d.cx}`);
});
