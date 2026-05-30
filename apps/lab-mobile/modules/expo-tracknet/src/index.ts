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

export interface TrackNetOptions {
  sampleStride?: number;
  maxFrames?: number;
  startTimeSec?: number;
  /** Heatmap peak below this counts as lost; 8 consecutive lost frames ends tracking. */
  confidenceCutoff?: number;
}

export interface TrackInVideoResult {
  frames: TrackedFrame[];
  videoWidth: number;
  videoHeight: number;
  frameRate: number;
  elapsedMs: number;
}

interface NativeModule {
  isReady(): boolean;
  loadError(): string | null;
  trackInVideo(uri: string, opts: TrackNetOptions): Promise<TrackInVideoResult>;
}

let Native: NativeModule | null = null;
try {
  Native = requireNativeModule<NativeModule>("ExpoTrackNet");
} catch {
  Native = null;
}

export const TrackNet = {
  available(): boolean { return Native !== null; },
  isReady(): boolean {
    if (!Native) return false;
    try { return Native.isReady(); } catch { return false; }
  },
  loadError(): string | null {
    if (!Native) return "Native module not in this build";
    try { return Native.loadError(); } catch { return null; }
  },
  trackInVideo(uri: string, opts: TrackNetOptions = {}): Promise<TrackInVideoResult> {
    if (!Native) return Promise.reject(new Error("expo-tracknet native module not in this build"));
    return Native.trackInVideo(uri, opts);
  },
};
