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
  currentModel(): string;
  availableModels(): string[];
  switchModel(name: string): Promise<boolean>;
  downloadModel(url: string, name: string): Promise<string>;
  importModel(fileUri: string, name: string): Promise<string>;
  deleteModel(name: string): boolean;
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
  currentModel(): string {
    if (!Native) return "";
    try { return Native.currentModel(); } catch { return ""; }
  },
  availableModels(): string[] {
    if (!Native) return [];
    try { return Native.availableModels(); } catch { return []; }
  },
  switchModel(name: string): Promise<boolean> {
    if (!Native) return Promise.reject(new Error("YOLO native module not in this build"));
    return Native.switchModel(name);
  },
  /** Download a .mlmodel from a URL, compile on-device, and save. */
  downloadModel(url: string, name: string): Promise<string> {
    if (!Native) return Promise.reject(new Error("YOLO native module not in this build"));
    return Native.downloadModel(url, name);
  },
  /** Import a local .mlmodel file, compile on-device, and save. */
  importModel(fileUri: string, name: string): Promise<string> {
    if (!Native) return Promise.reject(new Error("YOLO native module not in this build"));
    return Native.importModel(fileUri, name);
  },
  /** Delete a downloaded model. */
  deleteModel(name: string): boolean {
    if (!Native) return false;
    try { return Native.deleteModel(name); } catch { return false; }
  },
  detect(uri: string, opts: YoloDetectOptions = {}): Promise<YoloResult> {
    if (!Native) return Promise.reject(new Error("YOLO native module not in this build"));
    return Native.detect(uri, opts);
  },
};
