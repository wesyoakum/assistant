import { create } from "zustand";

export interface TrackerSettings {
  preprocessBW: boolean;
  contrastLevel: number;
  outlierRejection: boolean;
  outlierThreshold: number;
  setPreprocessBW: (v: boolean) => void;
  setContrastLevel: (v: number) => void;
  setOutlierRejection: (v: boolean) => void;
  setOutlierThreshold: (v: number) => void;
}

export const useTrackerSettings = create<TrackerSettings>((set) => ({
  preprocessBW: false,
  contrastLevel: 1.0,
  outlierRejection: true,
  outlierThreshold: 0.03,
  setPreprocessBW: (v) => set({ preprocessBW: v }),
  setContrastLevel: (v) => set({ contrastLevel: v }),
  setOutlierRejection: (v) => set({ outlierRejection: v }),
  setOutlierThreshold: (v) => set({ outlierThreshold: v }),
}));
