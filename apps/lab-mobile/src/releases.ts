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
    version: "v1.5.1",
    title: "Template tracker: tight crop + wider search (needs rebuild)",
    notes: [
      "Template now crops the central ~67% of the user-drawn box. Stops NCC locking onto background pixels around a small target",
      "Search window minimum is now image-relative (~6.5% of width, min 40 px) and 3× wider on the very first non-template frame where there's no velocity yet to predict from",
      "Confidence cutoff lowered to 0.15 so brief motion-blur dips don't end tracking",
    ],
  },
  {
    version: "v1.5.0",
    title: "Tracker: template-matching + motion prediction mode (needs rebuild)",
    notes: [
      "New 'Template' mode in the Tracker. After Apple Vision proved unable to keep up with fast small targets (confidence cratered by frame 10 on a pitch), the template approach we discussed: crop the user's box as a template, predict next-frame position from prior velocity, NCC-match in a small search window, repeat",
      "Toggle between Template and Apple Vision modes above the action row to A/B compare on the same video",
      "Result header tags which mode produced it. Frame-by-frame review unchanged",
      "Pure Accelerate / luma extraction from BGRA — no CoreML, no ML model. Runs on the downsampled (½×) luma plane for speed",
    ],
  },
  {
    version: "v1.4.3",
    title: "Tracker: always-reload review + visible errors",
    notes: [
      "Review panel always re-fetches the frame at each tracked timestamp — no caching short-circuit (the old check was sometimes skipping reloads even on timestamp change)",
      "Loading pill now shows the timestamp it's fetching",
      "frameAtTime errors surface as a red banner instead of failing silently",
      "(No-image / no-loading / no-error) shows a placeholder so the panel never looks blank for unknown reasons",
    ],
  },
  {
    version: "v1.4.2",
    title: "Tracker: clear box on frame step + load correct frame in review",
    notes: [
      "Stepping the main canvas to a new frame now clears the drawn box (it was visually pinned to the old frame's content)",
      "The review section under tracker results now actually loads the frame at each tracked timestamp instead of showing the initial still under every box",
    ],
  },
  {
    version: "v1.4.1",
    title: "Tracker fixes: gesture capture · frame stepping · start-time",
    notes: [
      "Canvas now captures touches so the page doesn't scroll while you pinch / pan / draw",
      "Frame stepping under the canvas — ‹frame · frame› step by 1/fps; «1s · 1s» jump a full second. Lets you advance to a frame where the ball is visible before drawing",
      "Drawing the box reliably commits — Run tracker un-greys as soon as a box is set",
      "Tracking now starts from whichever frame you drew the box on, not always from frame 0",
      "Native module gained frameAtTime + a startTimeSec option on trackInVideo",
    ],
  },
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
