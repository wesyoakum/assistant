import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BallisticTracker, type Observation3D } from "./ballisticTracker.ts";

const GRAVITY = 9.81; // m/s²

/** Generate a ballistic arc on the mid-plane (yzY, yzZ). */
function makeArc(
  startFrame: number, count: number, fps: number,
  y0: number, z0: number, vy: number, vz: number,
): Observation3D[] {
  const obs: Observation3D[] = [];
  for (let i = 0; i < count; i++) {
    const fi = startFrame + i;
    const dt = i / fps;
    obs.push({
      frameIndex: fi,
      timeSec: fi / fps,
      yzY: y0 + vy * dt,
      yzZ: z0 + vz * dt - 0.5 * GRAVITY * dt * dt,
      pixelX: 0.5, pixelY: 0.5,
      confidence: 0.85,
      rayDir: { x: 0, y: 1, z: 0 },
    });
  }
  return obs;
}

describe("BallisticTracker", () => {
  it("single ballistic arc → 1 validated track", () => {
    // Pitch: ~60mph, 0.5s flight
    const arc = makeArc(0, 15, 30, 0, 1.5, 25, 2);
    const bt = new BallisticTracker({ frameRate: 30, r2Threshold: 0.9 });
    for (const obs of arc) bt.addObservation(obs);
    const active = bt.getActiveTrack();
    assert.ok(active, "should have an active track");
    assert.equal(active.state, "validated");
    assert.ok(active.speedMph > 20, `speed ${active.speedMph.toFixed(0)}mph should be > 20`);
    assert.ok(active.r2 > 0.9, `R² ${active.r2.toFixed(3)} should be > 0.9`);
  });

  it("direction change → track closes, new track forms", () => {
    // Pitch coming in
    const pitch = makeArc(0, 12, 30, 0, 1.5, 25, 1);
    // Hit going out (different direction)
    const lastPitch = pitch[pitch.length - 1]!;
    const hit = makeArc(12, 12, 30, lastPitch.yzY, lastPitch.yzZ, -20, 10);
    const bt = new BallisticTracker({ frameRate: 30, r2Threshold: 0.8, maxMissedFrames: 5 });
    for (const obs of [...pitch, ...hit]) bt.addObservation(obs);
    // Should have closed tracks
    const closed = bt.getClosedTracks();
    assert.ok(closed.length >= 1, `should have ≥1 closed track, got ${closed.length}`);
  });

  it("gap within maxMissedFrames → track survives", () => {
    // Single continuous arc with a gap in the middle.
    const full = makeArc(0, 30, 30, 0, 1.5, 25, 2);
    const bt = new BallisticTracker({ frameRate: 30, r2Threshold: 0.8, gateThresholdM: 2.0 });
    // Feed first 10 frames.
    for (let i = 0; i < 10; i++) bt.addObservation(full[i]!);
    // Gap: 10 frames of ticks (within maxMissedFrames=15).
    for (let i = 10; i < 20; i++) bt.tick(i);
    // Resume with the same arc.
    for (let i = 20; i < 30; i++) bt.addObservation(full[i]!);
    const active = bt.getActiveTrack();
    assert.ok(active, "track should survive the gap");
    assert.ok(active.observations.length >= 15, `should have ≥15 obs, got ${active.observations.length}`);
  });

  it("random noise → no validated tracks", () => {
    const bt = new BallisticTracker({ frameRate: 30, r2Threshold: 0.9 });
    for (let i = 0; i < 30; i++) {
      if (i % 5 === 0) {
        bt.addObservation({
          frameIndex: i, timeSec: i / 30,
          yzY: Math.random() * 20, yzZ: Math.random() * 5,
          pixelX: Math.random(), pixelY: Math.random(),
          confidence: 0.5,
          rayDir: { x: 0, y: 1, z: 0 },
        });
      } else {
        bt.tick(i);
      }
    }
    const active = bt.getActiveTrack();
    assert.equal(active, null, "no track should validate from noise");
  });

  it("slow speed → candidate rejected", () => {
    // Very slow: 5 m/s ≈ 11mph < 20mph threshold
    const arc = makeArc(0, 15, 30, 0, 1.0, 5, 1);
    const bt = new BallisticTracker({ frameRate: 30, r2Threshold: 0.8, minSpeedMph: 20 });
    for (const obs of arc) bt.addObservation(obs);
    const active = bt.getActiveTrack();
    assert.equal(active, null, "slow track should not validate");
    const log = bt.getLog();
    assert.ok(log.some((l) => l.includes("rejected")), "log should mention rejection");
  });

  it("pending replacement handoff", () => {
    const pitch = makeArc(0, 10, 30, 0, 1.5, 25, 2);
    const bt = new BallisticTracker({ frameRate: 30, r2Threshold: 0.8, maxMissedFrames: 3, pendingConfirmCount: 4 });
    for (const obs of pitch) bt.addObservation(obs);
    assert.ok(bt.getActiveTrack(), "should have active track after pitch");

    // New trajectory that diverges
    const throwBack = makeArc(15, 10, 30, 10, 2, -20, 5);
    for (let i = 10; i < 15; i++) bt.tick(i); // gap to close first track
    for (const obs of throwBack) bt.addObservation(obs);

    const log = bt.getLog();
    // Should see track lifecycle events
    assert.ok(log.some((l) => l.includes("closed") || l.includes("validated")));
  });

  it("getFilteredFrameIndices returns correct frames", () => {
    const arc = makeArc(5, 10, 30, 0, 1.5, 25, 2);
    const bt = new BallisticTracker({ frameRate: 30, r2Threshold: 0.8 });
    for (const obs of arc) bt.addObservation(obs);
    const frames = bt.getFilteredFrameIndices();
    assert.ok(frames.size >= 10);
    assert.ok(frames.has(5));
    assert.ok(frames.has(14));
    assert.ok(!frames.has(0));
  });
});
