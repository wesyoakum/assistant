import { requireNativeModule } from "expo-modules-core";

export interface YoloBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface YoloDetection {
  label: string;
  confidence: number;
  box: YoloBox;
}

export interface YoloResult {
  width: number;
  height: number;
  elapsedMs: number;
  detections: YoloDetection[];
}

export interface YoloDetectOptions {
  minConfidence?: number;
  /**
   * Optional region of interest, normalized 0..1 with origin at the
   * top-left of the image. When set, Vision crops to this rectangle
   * before running the model. Returned bounding boxes are still
   * normalized to the FULL image, so callers don't need to remap.
   */
  roi?: { x: number; y: number; width: number; height: number };
}

interface NativeModule {
  isReady(): boolean;
  loadError(): string | null;
  detect(uri: string, opts: YoloDetectOptions): Promise<YoloResult>;
}

let Native: NativeModule | null = null;
try {
  Native = requireNativeModule<NativeModule>("ExpoYolo");
} catch {
  Native = null;
}

export const Yolo = {
  available(): boolean { return Native !== null; },
  isReady(): boolean {
    if (!Native) return false;
    try { return Native.isReady(); } catch { return false; }
  },
  loadError(): string | null {
    if (!Native) return "Native module not in this build";
    try { return Native.loadError(); } catch { return null; }
  },
  detect(uri: string, opts: YoloDetectOptions = {}): Promise<YoloResult> {
    if (!Native) return Promise.reject(new Error("YOLO native module not in this build"));
    return Native.detect(uri, opts);
  },
};
