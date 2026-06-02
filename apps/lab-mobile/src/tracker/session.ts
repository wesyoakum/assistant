// Full tracker session — everything needed to restore the tracker tab state.

import type { NormalizedBox, TrackedFrame } from "expo-vision-tracker";
import type { CameraPose } from "../field/batterBox";

export interface TrackerSession {
  version: 2;
  savedAt: string;

  // Video
  videoUri: string | null;
  frameTimeSec: number;

  // Tracker settings at time of save
  trackerMode: string;
  startTimeSec: number | null;
  endTimeSec: number | null;
  roi: NormalizedBox | null;

  // Calibration
  cameraPose: {
    fit: { H: number[]; Hinv: number[]; rmsPx: number; count: number };
    sides: string[];
  } | null;
  cameraXYZ: { x: number; y: number; z: number } | null;
  cameraAngles: { panDeg: number; tiltDeg: number; rollDeg: number } | null;
  // Anchored overlay handle positions (so calibration can be restored)
  overlayPositions: Record<string, { nx: number; ny: number }> | null;
  overlayAnchored: Record<string, boolean> | null;

  // Results
  result: {
    frames: TrackedFrame[];
    elapsedMs: number;
    videoWidth: number;
    videoHeight: number;
    frameRate: number;
    mode: string;
  } | null;
  reviewIdx: number;

  // Settings snapshot
  settings: {
    preprocessBW: boolean;
    contrastLevel: number;
    outlierRejection: boolean;
    outlierThreshold: number;
    roiSize: number;
    basepathFt: number;
  };
}
