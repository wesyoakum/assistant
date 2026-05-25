import { requireNativeModule } from "expo-modules-core";

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FaceObservation {
  box: BoundingBox;
  confidence: number;
}

export interface TextObservation {
  text: string;
  box: BoundingBox;
  confidence: number;
}

export interface BarcodeObservation {
  payload: string;
  symbology: string;
  box: BoundingBox;
  confidence: number;
}

export interface RectangleObservation {
  box: BoundingBox;
  confidence: number;
}

export interface DetectResult {
  width: number;
  height: number;
  elapsedMs: number;
  faces: FaceObservation[];
  textBlocks: TextObservation[];
  barcodes: BarcodeObservation[];
  rectangles: RectangleObservation[];
}

export interface DetectOptions {
  faces?: boolean;
  text?: boolean;
  barcodes?: boolean;
  rectangles?: boolean;
}

interface NativeModule {
  detect(uri: string, opts: DetectOptions): Promise<DetectResult>;
}

let Native: NativeModule | null = null;
try {
  Native = requireNativeModule<NativeModule>("ExpoVisionDetect");
} catch {
  Native = null;
}

export const VisionDetect = {
  available(): boolean { return Native !== null; },
  detect(uri: string, opts: DetectOptions = { faces: true, text: true, barcodes: true }): Promise<DetectResult> {
    if (!Native) return Promise.reject(new Error("Vision Detect native module not in this build"));
    return Native.detect(uri, opts);
  },
};
