import { requireNativeModule } from "expo-modules-core";

export interface NormalizedBox {
  /** Top-left x, normalized to image width (0–1). */
  x: number;
  /** Top-left y, normalized to image height (0–1). */
  y: number;
  width: number;
  height: number;
}

export interface FirstFrameResult {
  imageBase64: string;
  imageWidth: number;
  imageHeight: number;
  naturalWidth: number;
  naturalHeight: number;
  durationSec: number;
  /** Nominal frame rate from the video track (0 if not reported). */
  frameRate: number;
  /** Time of this frame in seconds (0 for firstFrame, requested time for frameAtTime). */
  timeSec?: number;
  /** Horizontal field-of-view in degrees (0 if not available from video metadata). */
  hFovDeg?: number;
}

export interface TrackedFrame {
  frameIndex: number;
  timeSec: number;
  /** Top-left normalized box, or null if tracking was lost / failed. */
  box: NormalizedBox | null;
  confidence: number;
  lost: boolean;
  error?: string;
}

export interface TrackInVideoOptions {
  /** Process every Nth frame. 1 = every frame (default). */
  sampleStride?: number;
  /** Hard cap on total frames processed (0 = no cap). */
  maxFrames?: number;
  /** Confidence below this counts as "lost"; 5 consecutive lost frames ends tracking. */
  confidenceCutoff?: number;
  /** Skip the asset reader ahead to this video timestamp before tracking. */
  startTimeSec?: number;
}

export interface TrackInVideoResult {
  frames: TrackedFrame[];
  videoWidth: number;
  videoHeight: number;
  frameRate: number;
  /** Total wall-clock for the whole tracking pass. */
  elapsedMs: number;
}

interface NativeModule {
  firstFrame(uri: string, jpegQuality: number): Promise<FirstFrameResult>;
  frameAtTime(uri: string, timeSec: number, jpegQuality: number): Promise<FirstFrameResult>;
  preprocessFrame(base64: string, contrast: number, jpegQuality: number): Promise<string>;
  trackInVideo(
    uri: string,
    initialBox: NormalizedBox,
    opts: TrackInVideoOptions,
  ): Promise<TrackInVideoResult>;
  trackBlobInVideo(uri: string, opts: BlobTrackOptions): Promise<TrackInVideoResult>;
  exportVideo(uri: string, detections: Array<{ timeSec: number; cx: number; cy: number }>, dotRadius: number, dotColor: number[]): Promise<{ uri: string; frames: number }>;
  stitchVideos(uris: string[]): Promise<{ uri: string }>;
}

/** Options for the classical bright-moving-blob ball tracker. */
export interface BlobTrackOptions {
  sampleStride?: number;
  maxFrames?: number;
  startTimeSec?: number;
  /** Integer luma downsample (1 = native, 2 = half each axis). Default 2. */
  downsample?: number;
  /** Brightness floor 0–255 (default 170), motion delta (default 25), area
   *  fractions and fill — see src/tracker/blobTrack.ts. */
  brightness?: number;
  motionDelta?: number;
  minAreaFrac?: number;
  maxAreaFrac?: number;
  minFill?: number;
}

let Native: NativeModule | null = null;
try {
  Native = requireNativeModule<NativeModule>("ExpoVisionTracker");
} catch {
  Native = null;
}

export const VisionTracker = {
  available(): boolean {
    return Native !== null;
  },
  firstFrame(uri: string, jpegQuality = 0.85): Promise<FirstFrameResult> {
    if (!Native) return Promise.reject(new Error("expo-vision-tracker native module not in this build"));
    return Native.firstFrame(uri, jpegQuality);
  },
  frameAtTime(uri: string, timeSec: number, jpegQuality = 0.85): Promise<FirstFrameResult> {
    if (!Native) return Promise.reject(new Error("expo-vision-tracker native module not in this build"));
    return Native.frameAtTime(uri, timeSec, jpegQuality);
  },
  trackInVideo(uri: string, initialBox: NormalizedBox, opts: TrackInVideoOptions = {}): Promise<TrackInVideoResult> {
    if (!Native) return Promise.reject(new Error("expo-vision-tracker native module not in this build"));
    return Native.trackInVideo(uri, initialBox, opts);
  },
  /** Preprocess a base64 JPEG: grayscale + contrast boost. Returns new base64. */
  preprocessFrame(base64: string, contrast = 1.8, jpegQuality = 0.85): Promise<string> {
    if (!Native || typeof Native.preprocessFrame !== "function") {
      return Promise.reject(new Error("preprocessFrame not available in this build"));
    }
    return Native.preprocessFrame(base64, contrast, jpegQuality);
  },
  /** Classical bright-moving-blob ball tracker — no initial box needed. */
  trackBlobInVideo(uri: string, opts: BlobTrackOptions = {}): Promise<TrackInVideoResult> {
    if (!Native) return Promise.reject(new Error("expo-vision-tracker native module not in this build"));
    return Native.trackBlobInVideo(uri, opts);
  },

  /** Export video with detection dots composited onto each frame.
   *  detections: [{timeSec, cx, cy}] — normalized center coords.
   *  Returns {uri, frames} of the output video. */
  exportVideo(
    uri: string,
    detections: Array<{ timeSec: number; cx: number; cy: number }>,
    dotRadius = 4,
    dotColor: [number, number, number] = [1, 0.8, 0],
  ): Promise<{ uri: string; frames: number }> {
    if (!Native || typeof Native.exportVideo !== "function") {
      return Promise.reject(new Error("exportVideo not available in this build"));
    }
    return Native.exportVideo(uri, detections, dotRadius, dotColor);
  },
  stitchVideos(uris: string[]): Promise<{ uri: string }> {
    if (!Native || typeof Native.stitchVideos !== "function") {
      return Promise.reject(new Error("stitchVideos not available in this build"));
    }
    return Native.stitchVideos(uris);
  },
};
