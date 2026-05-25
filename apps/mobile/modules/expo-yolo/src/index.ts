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

interface NativeModule {
  isReady(): boolean;
  loadError(): string | null;
  detect(uri: string, opts: { minConfidence?: number }): Promise<YoloResult>;
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
  detect(uri: string, opts: { minConfidence?: number } = {}): Promise<YoloResult> {
    if (!Native) return Promise.reject(new Error("YOLO native module not in this build"));
    return Native.detect(uri, opts);
  },
};
