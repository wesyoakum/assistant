import { requireNativeModule } from "expo-modules-core";
import type { EventSubscription } from "expo-modules-core";

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

export interface DetectInVideoOptions {
  startTimeSec: number;
  endTimeSec: number;
  stepSec: number;
  maxFrames?: number;
  maxMisses?: number;
  minConfidence?: number;
  labelFilter?: string[];
  roi?: YoloBox;
  preprocess?: { grayscale: boolean; contrast: number };
  realTime?: boolean;
}

export interface DetectInVideoFrame {
  frameIndex: number;
  timeSec: number;
  box: YoloBox | null;
  confidence: number;
  lost: boolean;
}

export interface DetectInVideoResult {
  frames: DetectInVideoFrame[];
  videoWidth: number;
  videoHeight: number;
  frameRate: number;
  elapsedMs: number;
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
  detectInVideo(uri: string, opts: DetectInVideoOptions): Promise<DetectInVideoResult>;
  addListener: (event: string, callback: (payload: DetectInVideoFrame) => void) => EventSubscription;
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
    if (!Native || typeof Native.currentModel !== "function") return "";
    try { return Native.currentModel(); } catch { return ""; }
  },
  availableModels(): string[] {
    if (!Native || typeof Native.availableModels !== "function") return [];
    try { return Native.availableModels(); } catch { return []; }
  },
  switchModel(name: string): Promise<boolean> {
    if (!Native || typeof Native.switchModel !== "function") return Promise.resolve(false);
    return Native.switchModel(name);
  },
  downloadModel(url: string, name: string): Promise<string> {
    if (!Native || typeof Native.downloadModel !== "function") return Promise.reject(new Error("Not available in this build"));
    return Native.downloadModel(url, name);
  },
  importModel(fileUri: string, name: string): Promise<string> {
    if (!Native || typeof Native.importModel !== "function") return Promise.reject(new Error("Not available in this build"));
    return Native.importModel(fileUri, name);
  },
  deleteModel(name: string): boolean {
    if (!Native || typeof Native.deleteModel !== "function") return false;
    try { return Native.deleteModel(name); } catch { return false; }
  },
  detect(uri: string, opts: YoloDetectOptions = {}): Promise<YoloResult> {
    if (!Native) return Promise.reject(new Error("YOLO native module not in this build"));
    return Native.detect(uri, opts);
  },
  detectInVideo(uri: string, opts: DetectInVideoOptions): Promise<DetectInVideoResult> {
    if (!Native || typeof Native.detectInVideo !== "function")
      return Promise.reject(new Error("detectInVideo not available in this build"));
    return Native.detectInVideo(uri, opts);
  },
  onDetection(cb: (frame: DetectInVideoFrame) => void): EventSubscription {
    if (!Native) return { remove: () => {} } as EventSubscription;
    return Native.addListener("onDetection", cb);
  },
};
