import { requireNativeModule } from "expo-modules-core";

export interface NormalizedBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TrackedFrame {
  frameIndex: number;
  timeSec: number;
  box: NormalizedBox | null;
  confidence: number;
  lost: boolean;
  error?: string;
}

export interface TemplateTrackOptions {
  sampleStride?: number;
  maxFrames?: number;
  /** Skip the reader ahead to this video timestamp before tracking. */
  startTimeSec?: number;
  /** NCC below this counts as lost; 8 consecutive lost frames ends tracking. */
  confidenceCutoff?: number;
  /** Search-window radius as a multiplier of the template half-dim. 3 ≈ 7× template. */
  searchPadding?: number;
  /** Integer downsample (1 = native, 2 = half, 4 = quarter). Default 2. */
  downsample?: number;
}

export interface TrackInVideoResult {
  frames: TrackedFrame[];
  videoWidth: number;
  videoHeight: number;
  frameRate: number;
  elapsedMs: number;
}

interface NativeModule {
  trackInVideo(uri: string, initialBox: NormalizedBox, opts: TemplateTrackOptions): Promise<TrackInVideoResult>;
}

let Native: NativeModule | null = null;
try {
  Native = requireNativeModule<NativeModule>("ExpoTemplateTracker");
} catch {
  Native = null;
}

export const TemplateTracker = {
  available(): boolean {
    return Native !== null;
  },
  trackInVideo(uri: string, initialBox: NormalizedBox, opts: TemplateTrackOptions = {}): Promise<TrackInVideoResult> {
    if (!Native) return Promise.reject(new Error("expo-template-tracker native module not in this build"));
    return Native.trackInVideo(uri, initialBox, opts);
  },
};
