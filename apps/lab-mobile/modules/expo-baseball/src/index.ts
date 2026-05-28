import { requireNativeModule } from "expo-modules-core";

export interface DetectionBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BaseballDetection {
  label: string;
  confidence: number;
  box: DetectionBox;
}

export interface BaseballResult {
  width: number;
  height: number;
  elapsedMs: number;
  detections: BaseballDetection[];
}

interface NativeModule {
  isReady(): boolean;
  loadError(): string | null;
  detect(uri: string, opts: { minConfidence?: number }): Promise<BaseballResult>;
}

let Native: NativeModule | null = null;
try {
  Native = requireNativeModule<NativeModule>("ExpoBaseball");
} catch {
  Native = null;
}

export const Baseball = {
  available(): boolean { return Native !== null; },
  isReady(): boolean {
    if (!Native) return false;
    try { return Native.isReady(); } catch { return false; }
  },
  loadError(): string | null {
    if (!Native) return "Native module not in this build";
    try { return Native.loadError(); } catch { return null; }
  },
  detect(uri: string, opts: { minConfidence?: number } = {}): Promise<BaseballResult> {
    if (!Native) return Promise.reject(new Error("Baseball native module not in this build"));
    return Native.detect(uri, opts);
  },
};
