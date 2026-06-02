// JS frame-walker for detector-based tracker modes (YOLO sports-ball, Baseball).
//
// Unlike Template/Vision (which track from a user box) or TrackNet (one native
// pass), these run an existing per-frame object DETECTOR on each video frame.
// We already get a JPEG per frame from VisionTracker.frameAtTime(), and both
// Yolo.detect() and Baseball.detect() accept a base64 data-URI — so the whole
// loop is JS, no new native code. Output matches TrackedFrame[] so the existing
// review UI renders it unchanged.
//
// This file is kept free of native imports so it unit-tests under the node
// runner. The TrackedFrame shape is mirrored locally; the caller (TrackerTab)
// supplies the native frame-getter and detectors.

/** Mirror of expo-vision-tracker's TrackedFrame (kept local to avoid a native
 *  import here — the shapes must stay in sync). */
export interface TrackedFrame {
  frameIndex: number;
  timeSec: number;
  box: { x: number; y: number; width: number; height: number } | null;
  confidence: number;
  lost: boolean;
  error?: string;
  /** True if this detection was rejected by outlier filtering. */
  rejected?: boolean;
  /** Original box before outlier rejection nulled it out. */
  rejectedBox?: { x: number; y: number; width: number; height: number };
}

export interface DetectorBox {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface RawDetection {
  label: string;
  confidence: number;
  box: DetectorBox; // top-left normalized
}
/** A per-frame detector: image data-URI → detections. */
export type FrameDetector = (dataUri: string) => Promise<RawDetection[]>;

export interface DetectorWalkOptions {
  startTimeSec: number;
  /** Seconds between sampled frames (e.g. 1/fps). */
  stepSec: number;
  /** Total video duration; the walk stops at/after this. */
  durationSec: number;
  /** Hard cap on frames (0 = no cap). */
  maxFrames?: number;
  /** JPEG quality for frame extraction. Default 0.85. */
  jpegQuality?: number;
  /** Stop after this many consecutive frames with no detection. Default 12. */
  maxMisses?: number;
  /** Optional: keep only detections whose label is in this set. */
  labelFilter?: (label: string) => boolean;
}

export interface DetectorWalkResult {
  frames: TrackedFrame[];
  videoWidth: number;
  videoHeight: number;
  frameRate: number;
  elapsedMs: number;
}

/** Pick the best ball detection in a frame: highest confidence among the
 *  (optionally filtered) detections, preferring smaller boxes on ties (a ball
 *  is small — avoids latching onto a big mislabeled region). */
export function pickBall(
  dets: RawDetection[],
  labelFilter?: (label: string) => boolean,
): RawDetection | null {
  const pool = labelFilter ? dets.filter((d) => labelFilter(d.label)) : dets;
  if (pool.length === 0) return null;
  return pool.slice().sort((a, b) => {
    if (Math.abs(b.confidence - a.confidence) > 1e-3) return b.confidence - a.confidence;
    const areaA = a.box.width * a.box.height, areaB = b.box.width * b.box.height;
    return areaA - areaB;
  })[0]!;
}

/**
 * Walk the video frame-by-frame running `detect` on each, producing a
 * TrackedFrame per sampled frame. Requires a `getFrame` that returns the frame
 * JPEG (base64) at a timestamp — injected so this is testable without native.
 */
export async function detectorWalk(
  getFrame: (timeSec: number, jpegQuality: number) => Promise<{ imageBase64: string; imageWidth: number; imageHeight: number; frameRate: number }>,
  detect: FrameDetector,
  opts: DetectorWalkOptions,
): Promise<DetectorWalkResult> {
  const q = opts.jpegQuality ?? 0.85;
  const maxMisses = opts.maxMisses ?? 12;
  const started = Date.now();
  const frames: TrackedFrame[] = [];
  let videoWidth = 0, videoHeight = 0, frameRate = 0;
  let misses = 0;
  let frameIndex = 0;

  for (let t = opts.startTimeSec; t < opts.durationSec; t += opts.stepSec) {
    if (opts.maxFrames && frames.length >= opts.maxFrames) break;
    let frame;
    try {
      frame = await getFrame(t, q);
    } catch {
      break; // ran past the end / decode failure
    }
    videoWidth = frame.imageWidth;
    videoHeight = frame.imageHeight;
    frameRate = frame.frameRate || frameRate;

    let dets: RawDetection[] = [];
    try {
      dets = await detect(`data:image/jpeg;base64,${frame.imageBase64}`);
    } catch {
      dets = [];
    }
    const ball = pickBall(dets, opts.labelFilter);
    if (ball) {
      misses = 0;
      frames.push({ frameIndex, timeSec: t, box: ball.box, confidence: ball.confidence, lost: false });
    } else {
      misses++;
      frames.push({ frameIndex, timeSec: t, box: null, confidence: 0, lost: true });
      if (misses >= maxMisses) break;
    }
    frameIndex++;
  }

  return { frames, videoWidth, videoHeight, frameRate, elapsedMs: Date.now() - started };
}
