# Video Field Analysis — Implementation Plan

**Goal:** Take an ordinary (non-AR) video clip — including zoomed/telephoto
footage, or clips recorded before this feature existed — and reconcile it to the
**field** so you can overlay field geometry and analyze 2D ball/player motion in
real field coordinates. Decoupled from any live AR session.

> **Scope boundary (set by the user):** we are **never** trying to recover 3D
> ball position from a single camera. Everything here lives on or near the
> **ground plane**, which a single view reconciles exactly. That removes the one
> hard ambiguity (depth along the view ray) and makes this a well-posed problem.

-----

## 1. Why this fits the real use case

Live AR turned out to be the wrong primary mode: the app won't stay open a whole
game, you can't return to the plate mid-game, and from a seat you see a changing
subset of landmarks. **Video analysis sidesteps all of that** — record normally
(zoom freely; ARKit's no-zoom constraint doesn't apply to plain video), then
analyze later. Each clip is reconciled to the field on its own.

This is **not** the same as AR world tracking. There's no LiDAR, no metric depth,
no motion sensors. What makes it work is that the **field is a known rigid
template**: given enough known landmarks visible in a frame, the camera's pose
relative to the field is recoverable, and from there anything on the ground plane
projects cleanly both ways.

-----

## 2. Core method: PnP camera pose from known field landmarks

The one genuinely new piece of math. Everything else reuses existing parts.

**Perspective-n-Point (PnP):** given ≥4 correspondences between **known 3D field
points** (apex, bases, rubber, foul-pole bases, points along the foul lines —
all at known field coordinates for the chosen level of play) and their **2D pixel
locations** in the video frame, solve for the camera's position + orientation
relative to the field, plus focal length if unknown.

Once we have that camera pose + the field plane:

- **Field → image** (projection): draw the strike zone, base paths, foul lines,
  distance rings, the 17″ plate, etc., correctly onto the footage.
- **Image → field** (ground-plane back-projection): any pixel known to lie on the
  ground (a base, a fielder's feet, where a grounder is) maps to a real field
  coordinate. This is exact for on-ground points because the ray from the camera
  through the pixel intersects the known ground plane at one point.

**What is deliberately NOT attempted:** back-projecting an *airborne* ball to a
3D position. A single camera gives the ball's image-ray direction but not its
depth along that ray, and per the scope boundary we don't try. Ball work stays
**2D image-space tracking** (pixel path), optionally annotated where it crosses a
known plane (e.g. the strike-zone plane) if that's ever wanted.

### Why PnP and not raycast
The live-AR path raycasts landmark pixels onto ARKit's detected ground plane to
get world coordinates. A plain video has no ARKit session, so there's no plane to
raycast against — PnP recovers the camera↔field relationship instead, from the
known geometry alone. It's the standard tool for exactly this ("known object,
find the camera"). Same spirit as the Procrustes fit in `fitPlateTemplate`, but
solving camera extrinsics rather than a similarity between two 3D point sets.

-----

## 3. Landmark identification — the crux (same fork as before)

PnP needs to know *which* field point each clicked/detected pixel is. Two paths,
and we should start with the robust one:

- **Tap-and-label (start here).** Scrub to a clear frame, tap a landmark, pick
  what it is from a list (1B, 3B, apex, rubber, RF pole, a point on the 1B foul
  line…). 4+ labeled points → solve. Robust to clutter (players, shadows), no
  fragile detection, you resolve all ambiguity. Mostly **JS logic, testable
  here**. Best first version.
- **Auto-detect + classify (later accelerator).** Detect bases/plate/lines
  automatically and label them. Much harder (occlusion, players, the
  classification problem), heavy native CV. Feeds the *same* PnP solve, so it's a
  drop-in upgrade per-landmark-type if/when wanted. The existing plate detector
  is one such provider already.

The whole thing is built so the **solver doesn't care** how the correspondences
were obtained — taps now, detections later, mixed.

-----

## 4. Dimensions / scale (already-solved concern)

The field template needs correct **proportions** for the level of play (Little
League 60/46 ft vs 90/60.5 ft, outfield depth, etc.) — a preset the user picks.
PnP with enough points effectively measures the actual field, so non-nominal
dimensions (e.g. 61-ft basepaths) are absorbed: the solve fits the field as it
actually is. The nominal template is a starting shape, not a hard assumption.
Fewer/closer-together landmarks → looser scale → more reliance on the nominal.

-----

## 5. Pipeline

```
import clip (expo-image-picker)            [exists]
   │
   ├─ scrub to frame(s)  ──────────────────  frameAtTime() base64 JPEG   [exists]
   │
   ├─ LABEL landmarks on the frame:
   │     tap pixel + choose field-point id  →  (fieldPoint3D ↔ pixel)    [new JS UI]
   │
   ├─ solvePnP(correspondences, fieldTemplate, imageSize)
   │     → camera pose (R, t) + focal (if unknown)                       [new — core]
   │
   ├─ project field model → overlay on the frame (lines, zones, rings)   [new JS, SVG]
   │
   └─ 2D ball detection per frame  ──────────  Yolo.detect()             [exists]
         → pixel path overlay; optional ground-plane back-projection for
           on-ground points via the recovered pose                        [new JS]
```

-----

## 6. What's buildable/testable here vs. native

**Pure-JS + unit-testable now (the bulk of the value):**
- The field template (known 3D landmark coordinates per level of play).
- The PnP solve. A planar-target PnP (homography decomposition, since all field
  landmarks are coplanar on the ground) is implementable and testable in JS with
  synthetic correspondences — same discipline as `coordinateFrame`/`plateDetect`:
  generate a known camera pose, project the field points, recover the pose, assert
  it round-trips. **This is the high-value, low-risk core to build first.**
- Field→image projection and image→ground back-projection (matrix math).
- Correspondence/label data model.

**Native / device-only (later, build-gated):**
- The label-on-frame UI (taps over a video frame) — RN, but needs a device to use.
- Auto-detection of non-plate landmarks (bases, lines, poles) — Vision/Accelerate.
- Any high-res still use (`captureHighResolutionFrame`, already added) if pulling
  frames from a live capture rather than an imported file.

**Reused as-is:** video import, `frameAtTime`, YOLO ball detection, the
SVG overlay approach (`PlateDebugOverlay` pattern), the field template idea.

-----

## 7. Suggested build order

1. **Field template** — known landmark coordinates for one level of play
   (parameterized so others drop in). Pure data + helpers. Tested.
2. **Planar PnP solver** — coplanar-landmark camera-pose recovery + projection
   helpers. Pure math. Tested against synthetic poses (round-trip).
3. **Back-projection helpers** — pixel→ground-field and field→pixel. Tested.
4. **Label-on-frame UI** — scrub, tap, choose landmark id; runs the solve; draws
   the projected field overlay. (Device to use; logic from 1–3 already tested.)
5. **Ball overlay** — run YOLO per frame, draw the 2D pixel path on the clip.
6. *(Optional, later)* auto-detect landmarks to reduce manual labeling.

-----

## 8. Open decisions

- **Level(s) of play** for the template proportions (and whether it's a per-clip
  picker or a setting).
- **Minimum landmark UX:** how many taps feel acceptable; whether to support
  labeling across multiple frames (e.g. a base visible in one frame, a pole in
  another, if the camera is static).
- **Where this lives:** a new mode in the Tracker tab, or its own screen.
- **PnP library vs. hand-rolled:** a coplanar/homography solve is small enough to
  hand-roll in JS (preferred — testable here, no dependency); full non-planar PnP
  would argue for a native/OpenCV path, but we don't need it since landmarks are
  coplanar on the ground.

-----

## 9. Honest limitations

- **On-ground only.** Overlays and measurements are exact on the field plane;
  anything above it (ball in flight) is image-space 2D only, by design.
- **Needs enough landmarks in one (or a few static) frames.** A tight zoom on the
  outfield with no identifiable field reference can't be reconciled — there must
  be known geometry in view.
- **Camera assumed static (or pose re-solved per frame).** If the operator pans/
  zooms during the clip, the pose changes; either re-solve on keyframes or label
  a static segment. (Panning is fine if landmarks stay visible to re-solve.)
- **Accuracy degrades with few/cramped landmarks** — same scale caveat as §4.
