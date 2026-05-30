import { requireNativeModule } from "expo-modules-core";
import type { EventSubscription } from "expo-modules-core";

export interface ControllerInfo {
  id: string;
  vendorName: string;
  productCategory: string;
  hasExtendedGamepad: boolean;
  isAttachedToDevice: boolean;
  playerIndex: number;
}

export interface ControllerInputFrame {
  id: string;
  buttonA: number;
  buttonB: number;
  buttonX: number;
  buttonY: number;
  dpadX: number;
  dpadY: number;
  leftX: number;
  leftY: number;
  rightX: number;
  rightY: number;
  leftTrigger: number;
  rightTrigger: number;
  leftShoulder: number;
  rightShoulder: number;
  leftThumbstickButton: number;
  rightThumbstickButton: number;
  buttonMenu: number;
  buttonOptions: number;
  buttonHome: number;
}

interface NativeModule {
  listControllers(): ControllerInfo[];
  startWatching(pollHz: number): Promise<void>;
  stopWatching(): Promise<void>;
  addListener: (event: "onControllers" | "onInput", cb: (payload: any) => void) => EventSubscription;
}

let Native: NativeModule | null = null;
try {
  Native = requireNativeModule<NativeModule>("ExpoGameController");
} catch {
  Native = null;
}

export const GameController = {
  available(): boolean { return Native !== null; },
  listControllers(): ControllerInfo[] {
    if (!Native) return [];
    try { return Native.listControllers(); } catch { return []; }
  },
  startWatching(pollHz = 30): Promise<void> {
    if (!Native) return Promise.reject(new Error("Game controller native module not in this build"));
    return Native.startWatching(pollHz);
  },
  stopWatching(): Promise<void> {
    if (!Native) return Promise.resolve();
    return Native.stopWatching();
  },
  addControllersListener(cb: (controllers: ControllerInfo[]) => void): EventSubscription {
    if (!Native) return { remove: () => {} } as EventSubscription;
    return Native.addListener("onControllers", (p: { controllers: ControllerInfo[] }) => cb(p.controllers));
  },
  addInputListener(cb: (frames: ControllerInputFrame[]) => void): EventSubscription {
    if (!Native) return { remove: () => {} } as EventSubscription;
    return Native.addListener("onInput", (p: { frames: ControllerInputFrame[] }) => cb(p.frames));
  },
};
