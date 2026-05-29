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

// --- Body Pose ---

export interface JointPoint {
  x: number;
  y: number;
  confidence: number;
}

export interface BodyPoseObservation {
  joints: Record<string, JointPoint>;
}

export interface BodyPoseResult {
  width: number;
  height: number;
  elapsedMs: number;
  bodies: BodyPoseObservation[];
}

// --- Hand Pose ---

export interface HandPoseObservation {
  joints: Record<string, JointPoint>;
}

export interface HandPoseResult {
  width: number;
  height: number;
  elapsedMs: number;
  hands: HandPoseObservation[];
}

// --- Face Landmarks ---

export interface LandmarkPoint {
  x: number;
  y: number;
}

export interface FaceLandmarksObservation {
  box: BoundingBox;
  confidence: number;
  landmarks?: Record<string, LandmarkPoint[]>;
}

export interface FaceLandmarksResult {
  width: number;
  height: number;
  elapsedMs: number;
  faces: FaceLandmarksObservation[];
}

// --- Person Segmentation ---

export interface PersonSegmentationResult {
  width: number;
  height: number;
  elapsedMs: number;
  maskBase64: string;
  maskWidth: number;
  maskHeight: number;
}

interface NativeModule {
  detect(uri: string, opts: DetectOptions): Promise<DetectResult>;
  detectBodyPose(uri: string): Promise<BodyPoseResult>;
  detectHandPose(uri: string): Promise<HandPoseResult>;
  detectFaceLandmarks(uri: string): Promise<FaceLandmarksResult>;
  detectPersonSegmentation(uri: string): Promise<PersonSegmentationResult>;
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
  detectBodyPose(uri: string): Promise<BodyPoseResult> {
    if (!Native) return Promise.reject(new Error("Vision Detect native module not in this build"));
    return Native.detectBodyPose(uri);
  },
  detectHandPose(uri: string): Promise<HandPoseResult> {
    if (!Native) return Promise.reject(new Error("Vision Detect native module not in this build"));
    return Native.detectHandPose(uri);
  },
  detectFaceLandmarks(uri: string): Promise<FaceLandmarksResult> {
    if (!Native) return Promise.reject(new Error("Vision Detect native module not in this build"));
    return Native.detectFaceLandmarks(uri);
  },
  detectPersonSegmentation(uri: string): Promise<PersonSegmentationResult> {
    if (!Native) return Promise.reject(new Error("Vision Detect native module not in this build"));
    return Native.detectPersonSegmentation(uri);
  },
};
