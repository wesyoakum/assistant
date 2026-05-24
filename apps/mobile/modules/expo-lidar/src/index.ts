import { requireNativeModule } from "expo-modules-core";
import type { EventSubscription } from "expo-modules-core";

interface NativeModule {
  isSupported(): boolean;
  startSession(gridW: number, gridH: number, throttleMs: number): Promise<void>;
  stopSession(): Promise<void>;
  addListener: (event: string, callback: (payload: DepthFrame) => void) => EventSubscription;
}

const NativeLidar = requireNativeModule<NativeModule>("ExpoLidar");

export interface DepthFrame {
  width: number;
  height: number;
  /** Per-pixel depth in meters. Length = width * height. 0 = invalid. */
  depth: number[];
  minMeters: number;
  maxMeters: number;
}

export const Lidar = {
  isSupported(): boolean {
    try {
      return NativeLidar.isSupported();
    } catch {
      return false;
    }
  },
  startSession(opts: { width?: number; height?: number; throttleMs?: number } = {}): Promise<void> {
    return NativeLidar.startSession(opts.width ?? 32, opts.height ?? 24, opts.throttleMs ?? 100);
  },
  stopSession(): Promise<void> {
    return NativeLidar.stopSession();
  },
  addDepthListener(cb: (frame: DepthFrame) => void): EventSubscription {
    return NativeLidar.addListener("onDepth", cb);
  },
};
