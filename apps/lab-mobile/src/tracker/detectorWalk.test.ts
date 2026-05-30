// Run: node --experimental-strip-types --test src/tracker/detectorWalk.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { type RawDetection, pickBall, detectorWalk } from "./detectorWalk.ts";

const box = (x: number, y: number, w = 0.05, h = 0.05) => ({ x, y, width: w, height: h });

test("pickBall takes the highest-confidence detection", () => {
  const dets: RawDetection[] = [
    { label: "sports ball", confidence: 0.4, box: box(0.1, 0.1) },
    { label: "sports ball", confidence: 0.9, box: box(0.5, 0.5) },
  ];
  assert.equal(pickBall(dets)!.confidence, 0.9);
});

test("pickBall prefers the smaller box on a confidence tie", () => {
  const dets: RawDetection[] = [
    { label: "ball", confidence: 0.8, box: box(0.1, 0.1, 0.2, 0.2) }, // big
    { label: "ball", confidence: 0.8, box: box(0.5, 0.5, 0.03, 0.03) }, // small
  ];
  assert.ok(pickBall(dets)!.box.width < 0.1, "smaller box wins the tie");
});

test("pickBall applies the label filter (COCO sports ball)", () => {
  const dets: RawDetection[] = [
    { label: "person", confidence: 0.99, box: box(0.1, 0.1) },
    { label: "sports ball", confidence: 0.3, box: box(0.5, 0.5) },
  ];
  const picked = pickBall(dets, (l) => l === "sports ball");
  assert.equal(picked!.label, "sports ball", "ignores person even though it's more confident");
});

test("pickBall returns null when nothing matches the filter", () => {
  const dets: RawDetection[] = [{ label: "person", confidence: 0.9, box: box(0.1, 0.1) }];
  assert.equal(pickBall(dets, (l) => l === "baseball"), null);
});

test("detectorWalk produces one frame per step and marks hits/misses", async () => {
  // Fake video: 5 frames at 0,0.1,...; ball present on frames 0,1,3.
  const getFrame = async (t: number) => ({
    imageBase64: `frame@${t.toFixed(2)}`,
    imageWidth: 100, imageHeight: 100, frameRate: 10,
  });
  const present = new Set(["0.00", "0.10", "0.30"]);
  const detect = async (uri: string): Promise<RawDetection[]> => {
    const tag = uri.split("@")[1]!.replace(/[^0-9.]/g, "");
    return present.has(Number(tag).toFixed(2))
      ? [{ label: "baseball", confidence: 0.7, box: box(0.5, 0.5) }]
      : [];
  };
  const res = await detectorWalk(getFrame, detect, {
    startTimeSec: 0, stepSec: 0.1, durationSec: 0.5, maxMisses: 99,
  });
  assert.equal(res.frames.length, 5);
  assert.deepEqual(res.frames.map((f) => !f.lost), [true, true, false, true, false]);
  assert.equal(res.videoWidth, 100);
  assert.equal(res.frameRate, 10);
});

test("detectorWalk stops after maxMisses consecutive empty frames", async () => {
  const getFrame = async (t: number) => ({ imageBase64: `f${t}`, imageWidth: 64, imageHeight: 64, frameRate: 30 });
  const detect = async (): Promise<RawDetection[]> => []; // never detects
  const res = await detectorWalk(getFrame, detect, {
    startTimeSec: 0, stepSec: 0.05, durationSec: 100, maxMisses: 4,
  });
  assert.equal(res.frames.length, 4, "should bail after 4 misses");
  assert.ok(res.frames.every((f) => f.lost));
});

test("detectorWalk stops gracefully when getFrame throws (end of video)", async () => {
  let n = 0;
  const getFrame = async () => {
    if (n++ >= 3) throw new Error("past end");
    return { imageBase64: "x", imageWidth: 10, imageHeight: 10, frameRate: 30 };
  };
  const detect = async (): Promise<RawDetection[]> => [{ label: "ball", confidence: 0.5, box: box(0, 0) }];
  const res = await detectorWalk(getFrame, detect, {
    startTimeSec: 0, stepSec: 0.1, durationSec: 100,
  });
  assert.equal(res.frames.length, 3, "stops when frames run out");
});

test("detectorWalk honors maxFrames cap", async () => {
  const getFrame = async () => ({ imageBase64: "x", imageWidth: 10, imageHeight: 10, frameRate: 30 });
  const detect = async (): Promise<RawDetection[]> => [{ label: "ball", confidence: 0.9, box: box(0, 0) }];
  const res = await detectorWalk(getFrame, detect, {
    startTimeSec: 0, stepSec: 0.01, durationSec: 100, maxFrames: 7,
  });
  assert.equal(res.frames.length, 7);
});
