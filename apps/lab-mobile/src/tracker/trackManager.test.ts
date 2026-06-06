import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TrackManager } from "./trackManager.ts";

interface Frame {
  frameIndex: number;
  timeSec: number;
  box: { x: number; y: number; width: number; height: number } | null;
  lost: boolean;
  confidence: number;
}

function makeParabola(
  startFrame: number, count: number, fps: number,
  x0: number, y0: number, vx: number, vy: number,
  ax = 0, ay = 0.5,
): Frame[] {
  const frames: Frame[] = [];
  for (let i = 0; i < count; i++) {
    const fi = startFrame + i;
    const dt = i / fps;
    const cx = x0 + vx * dt + 0.5 * ax * dt * dt;
    const cy = y0 + vy * dt + 0.5 * ay * dt * dt;
    const w = 0.02, h = 0.02;
    frames.push({
      frameIndex: fi, timeSec: fi / fps,
      box: { x: cx - w / 2, y: cy - h / 2, width: w, height: h },
      lost: false, confidence: 0.85,
    });
  }
  return frames;
}

function makeLost(fi: number, fps: number): Frame {
  return { frameIndex: fi, timeSec: fi / fps, box: null, lost: true, confidence: 0 };
}

describe("TrackManager", () => {
  it("single clean trajectory → 1 track", () => {
    const frames = makeParabola(0, 20, 30, 0.3, 0.2, 0.5, 0.3);
    const tm = new TrackManager({ frameRate: 30 });
    const tracks = tm.processFrames(frames);
    assert.equal(tracks.length, 1);
    assert.equal(tracks[0]!.detections.length, 20);
  });

  it("two trajectories with gap → 2 tracks", () => {
    const traj1 = makeParabola(0, 15, 30, 0.2, 0.3, 0.4, 0.2);
    const gap = Array.from({ length: 10 }, (_, i) => makeLost(15 + i, 30));
    const traj2 = makeParabola(25, 15, 30, 0.7, 0.2, -0.3, 0.4);
    const tm = new TrackManager({ frameRate: 30 });
    const tracks = tm.processFrames([...traj1, ...gap, ...traj2]);
    assert.equal(tracks.length, 2);
  });

  it("hit (direction change) → 2 tracks", () => {
    // Pitch moving right and slightly down
    const pitch = makeParabola(0, 15, 30, 0.2, 0.4, 0.8, 0.05, 0, 0.05);
    const last = pitch[pitch.length - 1]!;
    const hitX = last.box!.x + last.box!.width / 2;
    const hitY = last.box!.y + last.box!.height / 2;
    // Hit reverses direction sharply — going left and up
    const hit = makeParabola(15, 15, 30, hitX, hitY, -1.0, -0.8, 0, 0.4);
    const tm = new TrackManager({ frameRate: 30 });
    const tracks = tm.processFrames([...pitch, ...hit]);
    assert.equal(tracks.length, 2);
  });

  it("all lost frames → 0 tracks", () => {
    const frames = Array.from({ length: 20 }, (_, i) => makeLost(i, 30));
    const tm = new TrackManager({ frameRate: 30 });
    const tracks = tm.processFrames(frames);
    assert.equal(tracks.length, 0);
  });

  it("short clip backward compat → 1 track", () => {
    const frames = makeParabola(0, 8, 30, 0.5, 0.3, 0.2, 0.1);
    const tm = new TrackManager({ frameRate: 30 });
    const tracks = tm.processFrames(frames);
    assert.equal(tracks.length, 1);
    assert.equal(tracks[0]!.detections.length, 8);
  });

  it("logs track lifecycle events", () => {
    const frames = makeParabola(0, 10, 30, 0.3, 0.3, 0.4, 0.2);
    const tm = new TrackManager({ frameRate: 30 });
    tm.processFrames(frames);
    const log = tm.getLog();
    assert.ok(log.some((l) => l.includes("candidate started")));
    assert.ok(log.some((l) => l.includes("promoted to confirmed")));
    assert.ok(log.some((l) => l.includes("ended")));
  });

  it("reasonEnded is set", () => {
    const traj = makeParabola(0, 10, 30, 0.3, 0.3, 0.4, 0.2);
    const gap = Array.from({ length: 10 }, (_, i) => makeLost(10 + i, 30));
    const tm = new TrackManager({ frameRate: 30 });
    const tracks = tm.processFrames([...traj, ...gap]);
    assert.equal(tracks.length, 1);
    assert.ok(tracks[0]!.reasonEnded);
  });
});
