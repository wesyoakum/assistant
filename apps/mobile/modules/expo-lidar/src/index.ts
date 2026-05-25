import { requireNativeModule } from "expo-modules-core";
import type { EventSubscription } from "expo-modules-core";

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
