import { create } from "zustand";

export interface TrackerSettings {
  preprocessBW: boolean;
  contrastLevel: number; // 1.0 = no change, 1.8 = default boost
  setPreprocessBW: (v: boolean) => void;
  setContrastLevel: (v: number) => void;
}

export const useTrackerSettings = create<TrackerSettings>((set) => ({
  preprocessBW: true,
  contrastLevel: 1.8,
  setPreprocessBW: (v) => set({ preprocessBW: v }),
  setContrastLevel: (v) => set({ contrastLevel: v }),
}));
