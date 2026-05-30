# AR World Anchor — Home Plate as World Origin

Goal: establish an AR "world" anchored to a detected real-world object — **home
plate** — so that everything in the field is expressed in a stable, repeatable
coordinate frame. Single-phone for now; multi-phone sharing is explicitly out of
scope (but the design keeps the door open).

This document is the implementation plan. It builds on what already exists in
`apps/lab-mobile`; it does **not** start from scratch.

## TL;DR

- The "world anchored to home plate" coordinate frame **already exists** — see
  `src/field/coordinateFrame.ts` (`computeFieldFrame`) and the
  `FieldRegistration` store in `src/state/fields.ts`. Origin = home plate,
  +X → first base, +Y up, +Z → third base, with `worldToField` / `fieldToWorld`
  4×4 matrices.
- Placement is currently **manual** (aim crosshair, tap) and heading is taken
  from the **camera's forward vector**, not the plate's shape. Those are the two
  gaps.
- **Plan: detect the plate automatically and derive its pose from the pentagon's
  geometry**, then feed the existing coordinate-frame path unchanged.
- **No model is required to start.** Orientation is pure geometry. Detection
  starts classical (no training); we train a corner-keypoint model only if
  real-field conditions prove too brittle.

## Why orientation needs no model

Constraining the plate to the detected **ground plane** collapses the pose from
6 DOF to 3 (x, z, heading) — ARKit already gives the plane normal as "up". Home
plate's shape resolves the heading with **no 180° ambiguity**: the apex (point)
faces the catcher, the flat front edge faces the pitcher; these ends are
distinct. The only symmetry is a left/right mirror across the apex axis, which
doesn't affect a heading vector. So given the plate's corners, position +
heading + scale are a closed-form geometry problem. A model — if used at all —
only ever does Stage 1 (find the plate in the image).

## What already exists (do not rebuild)

| Capability | Location |
|---|---|
| ARKit session, ground raycast, anchors, world↔screen projection, world-map reset | `modules/expo-lidar` — `LidarARViewRef.raycastScreenPoint`, `addFieldLandmarkAtWorld`, `currentCameraTransform`, `resetSession`, `projectWorldPoint` |
| Single aligned capture: camera image + LiDAR depth + intrinsics + cam→world transform, same instant | `modules/expo-lidar` — `Lidar.captureAlignedFrame()`, `decodeDepthBuffer`, `sampleDepth` |
| `home_plate` (and bases, rubber, foul poles) as landmark kinds | `modules/expo-lidar` — `FieldLandmarkKind` |
| World frame anchored at home plate (origin/axes + 4×4 transforms) | `src/field/coordinateFrame.ts` — `computeFieldFrame`, `transformPoint` |
| Place HP → auto-derive whole field from known geometry | `app/experiments.tsx` — `placeAtCrosshairs`; `src/field/templates.ts` |
| Persisted field registrations | `src/state/fields.ts` — `FieldRegistration` |
| Proven YOLO training pipeline + on-device CoreML inference | `modules/expo-baseball` — Ultralytics YOLO26n (`BaseballDetector.mlpackage`, classes `{0: 'baseball'}`), `BaseballModule.swift` runs it via `VNCoreMLModel` |

## What's missing (the actual work)

1. **Automatic detection** of the plate (today: manual crosshair tap).
2. **Shape-derived orientation** (today: heading from camera forward vector in
   `placeAtCrosshairs`, which assumes the user stands behind the plate facing the
   pitcher).

## Architecture: two stages

```
Lidar.captureAlignedFrame()            // image + depth + intrinsics + cam→world  [exists]
      │
  ┌───┴── Stage 1 — find the 5 plate corners in the image (swappable)
  │        • prototype: classical CV, no training
  │        • production (only if needed): YOLO-pose 5-corner keypoint model
  │
  └── Stage 2 — pure geometry, no ML
        • back-project each corner via depth+intrinsics → 3D (LiDAR), or
          raycastScreenPoint each corner to the ground plane
        • apex vs front-edge ⇒ heading; ground normal ⇒ up; centroid ⇒ origin
        • validate scale vs known 17" front edge → reject bad detections
        • → computeFieldFrame() → FieldRegistration            [exists, unchanged]
```

Stage 2 and everything downstream already exist. Auto-detection replaces the
manual crosshair tap; shape-derived heading replaces the camera-forward
assumption. **Keep Stage 1 behind a stable interface so the detector is
swappable** (classical → model) with zero downstream rework:

```ts
// Stage 1 contract — returns 5 image-space corners (normalized 0–1) or null
type PlateCorners = { corners: { x: number; y: number }[]; confidence: number };
interface HomePlateDetector {
  detect(frame: AlignedFrame): Promise<PlateCorners | null>;
}
```

## Known geometry (for Stage 2 scale validation)

Home plate is a pentagon: 17" front edge (faces pitcher), two 8.5" sides, two
12" edges meeting at the apex (faces catcher). Use the 17" front edge and the
corner-to-corner distances as a scale sanity check to reject false positives
and bad depth.

## Phased plan

### Phase 0 — geometry helper (no ML, unit-testable) — ✅ DONE
`computeHomePlatePose(corners)` / `computeFieldFrameFromCorners(corners)` in
`src/field/coordinateFrame.ts`: take 5 world-space corners → order them, pick the
17" front edge (longest) → apex = vertex opposite it → return origin (plate
centroid), forward (apex → front-edge midpoint = toward pitcher, no compass
needed), up (ground normal), right (toward 1B), a scale-check against the known
17" edge (`scaleError`, to reject false positives), and a `FieldCoordinateFrame`
consistent with `field/templates.ts`. Pure function.

Tests: `src/field/coordinateFrame.test.ts` (Node's built-in runner, no new deps):

```
cd apps/lab-mobile
node --experimental-strip-types --test src/field/coordinateFrame.test.ts
```

**Bug fixed along the way:** `invertAffine` (used by both the existing
`computeFieldFrame` and the new code, and consumed by `field/classify.ts` for
foul/infield/outfield zoning) wrote the transposed rotation into the wrong
column-major slots. `worldToField` was only correct when the field happened to be
axis-aligned to ARKit's arbitrary world axes — i.e. wrong for essentially every
real field. Now a true inverse; covered by a round-trip regression test.

Output plugs straight into the existing `FieldRegistration` path.

### Phase 1 — standalone "Plate World" test + classical detection

**Phase 1a — standalone test screen (✅ DONE, manual corner capture).**
`app/plate-world.tsx` is a self-contained AR screen, **completely separate from
the Field registration flow** (which lives in `app/experiments.tsx`). Reached
from the AR tab's settings drawer ("Plate World test"). You aim the crosshair at
each of home plate's 5 corners and tap Capture; each capture raycasts to the
ground (`raycastScreenPoint`). At 5 corners it runs `computeHomePlatePose`
(Phase 0) and drops a virtual `home_plate` marker onto the real plate, oriented
by the recovered heading, with a pose/scale readout. This is the Stage 1 = manual
stand-in: the 5 taps are exactly the interface a detector will later fill.

**Phase 1b — classical (no-training) detector (next).** Replace the 5 manual taps
with an automatic corner finder (white-region/contour fit, or `expo-vision-detect`
rectangles as a starting point) feeding the same `computeHomePlatePose` → marker
path. Nothing downstream changes.

### Phase 2 — train YOLO-pose corner model (only if Phase 1 is too brittle)
If classical detection fails on dirt-covered/worn plates, shadows, night games,
or occlusion (batter's feet/bat): label ~150–300 frames with **5 corner
keypoints** and train a YOLO-pose model via the existing Ultralytics pipeline
(same flow that produced `BaseballDetector`). Ship as a new `.mlpackage` in a
module mirroring `expo-baseball`. **Train keypoints/segmentation, not a plain
box** — a box throws away the corners and orientation. Stage 2 is unchanged.

### Phase 3 — multi-phone (out of scope now; design keeps it open)
The *physical plate* is the shared reference. Each phone detects home plate and
localizes into the same `FieldRegistration` frame; only the registration +
field metadata need to be exchanged. This is the long-term reason to detect the
plate rather than tap it.

## Decision log

- **Detection approach:** classical first, train a YOLO-pose corner model only if
  real-field conditions prove too brittle. (Chosen over going straight to
  training, and over adding a `home_plate` box class — a box gives position only
  and leaves orientation camera-derived, which is the weakness this work fixes.)
- **Orientation source:** the plate's pentagon geometry (apex vs front edge), not
  the camera forward vector.

## Out of scope (for this work)

- Multi-phone / shared sessions (Phase 3 is design-only here).
- Changes to the assistant app (`apps/mobile`). All work lives in
  `apps/lab-mobile`.
