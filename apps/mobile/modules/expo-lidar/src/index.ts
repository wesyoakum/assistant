import { requireNativeModule } from "expo-modules-core";
import type { EventSubscription } from "expo-modules-core";

interface NativeModule {
  isSupported(): boolean;
  startSession(gridW: number, gridH: number, throttleMs: number): Promise<void>;
  stopSession(): Promise<void>;
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
  /** Per-pixel depth in meters. Length = width * height. 0 = invalid. */
  depth: number[];
  minMeters: number;
  maxMeters: number;
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
  addDepthListener(cb: (frame: DepthFrame) => void): EventSubscription {
    if (!NativeLidar) return { remove: () => {} } as EventSubscription;
    return NativeLidar.addListener("onDepth", cb);
  },
};
