// Release notes shown in the "What's new" banner. Newest first.

export interface Release {
  version: string;
  title: string;
  notes: string[];
  /** GitHub PR number, if applicable. Shown next to the version label. */
  pr?: number;
}

export const RELEASES: Release[] = [
  {
    version: "v1.4.0",
    title: "Lab → Tracker: VNTrackObjectRequest prototype (needs rebuild)",
    notes: [
      "Pick a video from the photo library, two-finger pinch + pan to zoom in, one-finger drag to draw an initial bounding box, run the tracker",
      "Uses Apple Vision's VNTrackObjectRequest + VNSequenceRequestHandler — no CoreML model, no bundle additions",
      "Per-frame results: bbox + confidence + timestamp, scrubable with Prev / Next",
      "Stops automatically after 5 consecutive low-confidence frames",
    ],
  },
  {
    version: "v1.3.1",
    title: "Lab sub-tabs: Vision back, reordered",
    notes: [
      "New order: Vision · Audio · Sensors · Device · Info. Default is Vision",
    ],
  },
  {
    version: "v1.3.0",
    title: "AR drawer · spectrum cleanup · lab tabs",
    notes: [
      "AR tab: swipe down from the top edge (or tap the grab handle) to open a settings drawer; first item is Exit AR — returns to the Lab tab",
      "Audio tab: removed the level meter + Start listening section; the spectrum is now the only thing there",
      "Spectrum chart taller by default and resizable — drag the handle right under the chart to grow or shrink",
      "Lab sub-tabs: removed the Vision entry (those live in the AR tab now)",
    ],
  },
  {
    version: "v1.2.0",
    title: "Spectrum chart: drag to pan, pinch to zoom",
    notes: [
      "Audio tab: drag the chart horizontally to pan the frequency window, vertically to pan the dB window",
      "Two-finger pinch zooms each axis around its centre",
      "Tap (no drag) still opens the fullscreen view",
      "Removed the redundant 'Microphone' header above the level meter",
    ],
  },
  {
    version: "v1.1.0",
    title: "Lab experiments migrated (needs rebuild)",
    notes: [
      "All 7 Lab sub-tabs: Motion, Audio, Vision, Env, Device, Health, Info",
      "Native modules: LiDAR, YOLO, Vision Detect, Game Controller",
      "Full Balls mode with ARKit ball tracking",
    ],
  },
  {
    version: "v1.0.0",
    title: "WHY Lab scaffold",
    notes: [
      "Standalone app shell with sign-in",
      "Lab experiments coming in Phase 2",
    ],
  },
];

/** Parse "v34" -> 34. Returns 0 if unparseable. */
export function parseVersion(v: string): number {
  const n = parseInt(v.replace(/^v/i, ""), 10);
  return Number.isFinite(n) ? n : 0;
}

/** Latest release (top of the list). */
export function currentRelease(): Release | null {
  return RELEASES[0] ?? null;
}
