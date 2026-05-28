import { requireNativeModule, requireNativeViewManager } from "expo-modules-core";
import type { EventSubscription } from "expo-modules-core";
import * as React from "react";
import type { ViewProps } from "react-native";

export interface CameraIntrinsics {
  /** Focal length in pixels (x axis). */
  fx: number;
  /** Focal length in pixels (y axis). */
  fy: number;
  /** Principal point x in image pixels. */
  cx: number;
  /** Principal point y in image pixels. */
  cy: number;
  imageWidth: number;
  imageHeight: number;
}

export interface AlignedFrame {
  /** JPEG, base64-encoded. Camera image at native (landscape) orientation. */
  imageBase64: string;
  imageWidth: number;
  imageHeight: number;
  /** Float32 array of depths in meters, base64-encoded. Row-major, length = depthWidth × depthHeight. */
  depthBase64: string;
  depthWidth: number;
  depthHeight: number;
  intrinsics: CameraIntrinsics;
  /** Column-major 4×4 camera-to-world transform (16 floats). */
  transform4x4: number[];
  /** Device orientation in ARKit's world frame, radians. */
  eulerAngles: { pitch: number; yaw: number; roll: number };
  /** ARKit frame timestamp (seconds). */
  timestamp: number;
}

interface NativeModule {
  isSupported(): boolean;
  startSession(gridW: number, gridH: number, throttleMs: number): Promise<void>;
  stopSession(): Promise<void>;
  captureAlignedFrame(jpegQuality: number): Promise<AlignedFrame>;
  addListener: (event: string, callback: (payload: DepthFrame) => void) => EventSubscription;
}

// Wrap module load so an OTA that ships this JS to an older binary
// without the native module doesn't crash the entire screen.
let NativeLidar: NativeModule | null = null;
try {
  NativeLidar = requireNativeModule<NativeModule>("ExpoLidar");
} catch {
  NativeLidar = null;
}

export interface DepthFrame {
  width: number;
  height: number;
  minMeters: number;
  maxMeters: number;
  /** PNG, base64-encoded. Already colorized + rotated to portrait by native. */
  imageBase64: string;
}

export const Lidar = {
  available(): boolean { return NativeLidar !== null; },
  isSupported(): boolean {
    if (!NativeLidar) return false;
    try { return NativeLidar.isSupported(); } catch { return false; }
  },
  startSession(opts: { width?: number; height?: number; throttleMs?: number } = {}): Promise<void> {
    if (!NativeLidar) return Promise.reject(new Error("LiDAR native module not in this build"));
    return NativeLidar.startSession(opts.width ?? 32, opts.height ?? 24, opts.throttleMs ?? 100);
  },
  stopSession(): Promise<void> {
    if (!NativeLidar) return Promise.resolve();
    return NativeLidar.stopSession();
  },
  /** Capture one ARKit frame: camera image + scene depth + intrinsics + orientation, all from the same instant. Requires startSession() first. */
  captureAlignedFrame(jpegQuality = 0.7): Promise<AlignedFrame> {
    if (!NativeLidar) return Promise.reject(new Error("LiDAR native module not in this build"));
    return NativeLidar.captureAlignedFrame(jpegQuality);
  },
  addDepthListener(cb: (frame: DepthFrame) => void): EventSubscription {
    if (!NativeLidar) return { remove: () => {} } as EventSubscription;
    return NativeLidar.addListener("onDepth", cb);
  },
};

// ─── ARKit native view (ARSCNView wrapper) ──────────────────────────────────

export interface BallAnchor {
  id: string;
  number: number;
  worldX: number;
  worldY: number;
  worldZ: number;
}

export interface LidarARViewRef {
  /** Raycast from a screen point (normalized 0–1 to the view's bounds) onto
   *  the estimated horizontal plane and add a ball anchor at the hit.
   *  Returns the anchor's world position + assigned number, or null if no hit. */
  addBallAtScreenPoint: (nx: number, ny: number, radius?: number) => Promise<BallAnchor | null>;
  /** Current set of ball anchors with their tracked world positions. */
  listBalls: () => Promise<BallAnchor[]>;
  /** Remove a single ball anchor (and its rendered marker). */
  removeBall: (id: string) => Promise<void>;
  /** Remove all ball anchors. */
  clearBalls: () => Promise<void>;
  /** Current camera-to-world transform, column-major 16 floats. */
  currentCameraTransform: () => Promise<number[] | null>;
  /** Capture the current camera image (rotated to portrait, JPEG base64). */
  captureViewImage: (jpegQuality?: number) => Promise<{ imageBase64: string; imageWidth: number; imageHeight: number } | null>;
  /** Wipe the ARKit world map + every anchor (planes, mesh, balls). Use to start fresh. */
  resetSession: () => Promise<void>;
  /** Project a world point to view-bounds-normalized screen coords + a "behind camera" flag. */
  projectWorldPoint: (worldX: number, worldY: number, worldZ: number) => Promise<{ screenX: number; screenY: number; isInFront: boolean; depth: number } | null>;
  /** Update the rendered sphere color for one ball anchor. State = "candidate" | "probable" | "confirmed". */
  setBallState: (id: string, state: "candidate" | "probable" | "confirmed") => Promise<void>;

  // Field landmark methods
  /** Place a field landmark at a screen point. Returns anchor info or null if raycast misses. */
  addFieldLandmark: (nx: number, ny: number, kind: FieldLandmarkKind) => Promise<FieldLandmarkAnchor | null>;
  /** Place a field landmark directly at world coordinates (no raycast). Optional Y rotation in degrees. */
  addFieldLandmarkAtWorld: (x: number, y: number, z: number, kind: FieldLandmarkKind, yRotationDeg?: number) => Promise<FieldLandmarkAnchor>;
  /** Move an existing field landmark to a new screen point (re-raycasts to ground). */
  moveFieldLandmark: (id: string, nx: number, ny: number) => Promise<FieldLandmarkAnchor | null>;
  /** Rotate a field landmark around its Y axis by the given angle in degrees. */
  rotateFieldLandmark: (id: string, angleDeg: number) => Promise<void>;
  /** Remove a single field landmark. */
  removeFieldLandmark: (id: string) => Promise<void>;
  /** List all placed field landmarks. */
  listFieldLandmarks: () => Promise<FieldLandmarkAnchor[]>;
  /** Remove all field landmarks. */
  clearFieldLandmarks: () => Promise<void>;
  /** Raycast from a normalized screen point to the ground. Returns world position or null. */
  raycastScreenPoint: (nx: number, ny: number) => Promise<{ worldX: number; worldY: number; worldZ: number } | null>;
}

export type BallState = "candidate" | "probable" | "confirmed";

export type FieldLandmarkKind =
  | "home_plate" | "first_base" | "second_base" | "third_base" | "rubber"
  | "batters_box_left" | "batters_box_right"
  | "foul_line_1b" | "foul_line_3b"
  | "foul_pole_right" | "foul_pole_left";

export interface FieldLandmarkAnchor {
  id: string;
  kind: FieldLandmarkKind;
  worldX: number;
  worldY: number;
  worldZ: number;
}

let NativeARView: React.ComponentType<ViewProps> | null = null;
try {
  NativeARView = requireNativeViewManager("ExpoLidar");
} catch {
  NativeARView = null;
}

/** Returns true if the LidarARView native component is registered in this build. */
export function lidarARViewAvailable(): boolean {
  return NativeARView !== null;
}

export interface LidarARViewProps extends ViewProps {
  /** Render translucent quads on detected horizontal (blue) + vertical (purple) planes. */
  showPlanes?: boolean;
  /** Render the LiDAR scene reconstruction as a green wireframe overlay. */
  showMesh?: boolean;
  /** Toggle ARKit's built-in feature-point debug dots. */
  showFeaturePoints?: boolean;
}

/** ARSCNView wrapped as a React Native view. Imperative methods are exposed via ref. */
export const LidarARView = React.forwardRef<LidarARViewRef, LidarARViewProps>(function LidarARView(props, ref) {
  if (!NativeARView) return null;
  return React.createElement(NativeARView as React.ComponentType<LidarARViewProps & { ref?: React.Ref<unknown> }>, { ...props, ref: ref as unknown as React.Ref<unknown> });
});

/** Decode the base64 Float32 depth array from a captureAlignedFrame result. */
export function decodeDepthBuffer(depthBase64: string): Float32Array {
  // atob → binary string → byte array → Float32Array
  const binary = atob(depthBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

/** Median-sample depth in a small region around a normalized image point. Returns meters or null if no valid sample. */
export function sampleDepth(
  depth: Float32Array,
  depthWidth: number,
  depthHeight: number,
  nx: number,
  ny: number,
  windowFraction = 0.05,
): number | null {
  const cx = Math.max(0, Math.min(depthWidth - 1, Math.floor(nx * depthWidth)));
  const cy = Math.max(0, Math.min(depthHeight - 1, Math.floor(ny * depthHeight)));
  const wx = Math.max(1, Math.floor(depthWidth * windowFraction));
  const wy = Math.max(1, Math.floor(depthHeight * windowFraction));
  const samples: number[] = [];
  for (let y = Math.max(0, cy - wy); y <= Math.min(depthHeight - 1, cy + wy); y++) {
    for (let x = Math.max(0, cx - wx); x <= Math.min(depthWidth - 1, cx + wx); x++) {
      const v = depth[y * depthWidth + x];
      if (v > 0.01 && Number.isFinite(v)) samples.push(v);
    }
  }
  if (samples.length === 0) return null;
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)] ?? null;
}
