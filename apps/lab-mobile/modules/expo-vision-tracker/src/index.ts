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
  trackInVideo(
    uri: string,
    initialBox: NormalizedBox,
    opts: TrackInVideoOptions,
  ): Promise<TrackInVideoResult>;
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
};
