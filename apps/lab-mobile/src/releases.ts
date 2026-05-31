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
    version: "v1.8.3",
    title: "Tracker: interpolate missing detections (OTA)",
    notes: [
      "Frames where the tracker didn't find the ball now get a linearly-interpolated position between the nearest real detections, so the trail stays continuous through gaps.",
      "Visual distinction: real detections render as solid yellow dots / solid green box; interpolated positions render as hollow rings / dashed orange box. Edges (before the first or after the last real detection) stay empty.",
      "Copy trace JSON bumped to schema v2 — each frame now also carries an `ibox` field when its position was interpolated.",
      "JS-only — delivered over-the-air.",
    ],
  },
  {
    version: "v1.8.2",
    title: "Tracker: ball trail overlay (OTA)",
    notes: [
      "Tracker review now draws a fading dot at every prior frame's ball position, so as you scrub forward through the result the trajectory builds up on the displayed image. The current frame's box still renders as the green outline; older positions fade out behind it.",
      "JS-only — delivered over-the-air.",
    ],
  },
  {
    version: "v1.8.1",
    title: "Tracker: Copy trace JSON (OTA)",
    notes: [
      "New 'Copy trace' button in the tracker review section — copies the run as JSON (per-frame timestamps, boxes, confidences) to the clipboard so you can paste it back into chat for analysis.",
      "JS-only — delivered over-the-air.",
    ],
  },
  {
    version: "v1.8.0",
    title: "Field tab: reconcile video to the field (OTA)",
    notes: [
      "New Field tab: import a clip, scrub to a clear frame, tap field landmarks (home/bases/rubber/foul poles) and label each, then Solve to fit the ground homography.",
      "Once solved it overlays the projected field — foul lines, base path, rubber — onto the frame, and 'Detect ball path' runs YOLO across frames to draw the 2D ball track.",
      "Pick the level of play (Little League / Intermediate / High School) so the field proportions match; the fit absorbs small real-field size differences.",
      "All on-ground (no 3D ball from one camera, by design). JS-only — delivered over-the-air.",
    ],
    pr: 159,
  },
  {
    version: "v1.7.1",
    title: "Tracker: YOLO ball only (OTA)",
    notes: [
      "The Tracker now shows just the YOLO-ball mode — it was the only one that reliably tracked real pitch footage. Template, Apple Vision, TrackNet, Blob, and the custom Baseball model are hidden but still in the code (easy to bring back).",
      "JS-only change, delivered over-the-air — no rebuild needed.",
    ],
    pr: 155,
  },
  {
    version: "v1.7.0",
    title: "Slim to Plate + Tracker; auto-detect home plate (needs rebuild)",
    notes: [
      "App trimmed to two features: Plate and Tracker, plus a minimal Settings tab. The old Lab screen (Vision / Audio / Sensors / Device / Info) and the 7-page AR pager are archived — kept in the repo, out of the build",
      "Plate tab: new 'Auto' button auto-detects home plate from the camera (white-region contour → Douglas-Peucker pentagon → raycast the 5 corners to the ground plane → solve pose), replacing the 5 manual taps when it works. Manual capture, Reset, and Save Frame remain",
      "Plate detection is all Apple-native (Vision + Accelerate/Metal) — no OpenCV. The pose solve reuses ARKit's ground plane + the existing tested geometry, so no PnP solver is needed",
      "Dropped 4 unused native modules (YOLO, baseball, vision-detect, gamecontroller) and their bundled CoreML models from the build — smaller, faster builds. TrackNet and the tracker modules are unaffected",
      "Plate corner geometry is unit-tested (22 tests). First on-device test of the auto-detect: expect the white-mask thresholds to need field tuning",
    ],
    pr: 140,
  },
  {
    version: "v1.6.2",
    title: "Tracker: enable Run button in TrackNet mode",
    notes: [
      "runTracker bailed before checking which mode was selected, so even though TrackNet doesn't need a box the button silently did nothing. Now the no-box short-circuit only applies to Template / Apple Vision modes",
    ],
  },
  {
    version: "v1.6.1",
    title: "Tracker: TrackNet mode (needs rebuild)",
    notes: [
      "Third tracker mode added: TrackNet (academic CNN purpose-built for tracking small fast balls in sports video — takes 3 consecutive frames, outputs a heatmap)",
      "No initial bounding box needed — the model finds the ball itself per frame. (You can still pick a starting frame with the frame-step buttons.)",
      "Weights are tennis-trained (yastrebksv/TrackNet, public Google Drive). Baseball generalisation is unknown but the architecture's whole point is small fast targets — first real test for our use case",
      "Bundle gets +41 MB. Model runs at 360×640 internally. License is unclear so this is research/exploration only for now",
    ],
  },
  {
    version: "v1.6.0",
    title: "Plate World: anchor an AR world to home plate (needs rebuild)",
    notes: [
      "New 'Plate World' mode — now the first swipeable mode in the AR tab. Aim the crosshair at each of home plate's 5 corners and tap Capture; at 5 corners it solves the plate's position, orientation, and size purely from geometry and drops a virtual home plate onto the real one, oriented by the recovered heading",
      "Orientation comes from the plate's shape (the apex/back point vs the 17in front edge), not from which way the phone is pointed — so the world is anchored correctly regardless of where you stand",
      "Status bar reports the measured front-edge length vs the expected 17in (a built-in sanity check) and the heading. Reset clears and starts over",
      "Kept completely separate from the Field registration flow",
      "Fixed a latent bug in the field coordinate-frame inverse (worldToField) that produced wrong fair/foul/infield/outfield zoning on any field not aligned to ARKit's arbitrary world axes",
    ],
    pr: 138,
  },
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
