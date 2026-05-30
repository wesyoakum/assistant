# AR Baseball Field Registration — Implementation Plan

**Platform:** iOS app, iPhone 16 Pro (LiDAR + ARKit)
**Goal:** Anchor a known baseball-field model into the AR world and hold
registration accurately enough that content placed in the outfield (300+ ft)
stays aligned.

> **Status note (supersedes the earlier plan).** This document replaces the
> earlier "detect the plate with a trained YOLO-pose corner model" framing.
> The initial fix is now **automatic and training-free** (region → contour →
> polygon → raycast corners to the ground plane), and orientation at the
> operating position is owned by
> **foul-line vanishing points**, not the plate. The `training/plate-detector/`
> YOLO-pose scaffold is **deprioritized** — kept only as the §10 fallback if the
> classical region/line CV proves too brittle on real fields. See
> "Reconciliation with existing code" at the bottom.

-----

## 1. Core framing

This is a **registration** problem, not a detection problem. ARKit (VIO + LiDAR)
already provides a stable, metric, local coordinate frame, the ground plane, and
scale. The custom computer-vision work exists only to align the known field
model to that frame once, then correct drift over time.

Because SLAM gives us the **ground plane and metric scale for free**, the
registration collapses from full 6DoF to an in-plane **3-DoF fit: (x, y, yaw)**.

Each axis is owned by its most reliable source:

| Axis | Owner | Reliability | Notes |
|---|---|---|---|
| Scale + ground plane | ARKit SLAM / LiDAR | Strong | Free from VIO; LiDAR firms up the plane (range ~5 m). |
| Yaw (orientation) | Foul-line vanishing points | Strong | Also the axis SLAM drifts on worst — perfect complementarity. |
| Cross-range (lateral) | Apex ray-cast onto ground plane | Good | Apex is in frame at operating position; direct ray-cast, no extrapolation. |
| Along-range (distance to plate) | Initial PnP + SLAM carry-over | Weak from operating view | Grazing angle smears depth; preserved from the good-angle initial fix instead. |

**Key principle:** nothing critical rests on the foreshortened plate view at the
operating position. The squashed pentagon is never asked to provide what it's bad
at.

-----

## 2. Physical setup / assumptions

- **Initial fix:** captured from a good (less-steep) angle on home plate, once,
  deliberately.
- **Operating position:** near the dugout / on-deck circle. Both foul lines and
  the apex are in frame, but the angle is too grazing to cleanly resolve the
  sides/corners of the plate.
- Home plate is a standardized 17-inch pentagon (use as the metric model for PnP).
- Foul lines are long, high-contrast chalk lines — crisp even at grazing angles
  (the one thing the operating viewpoint is *good* for).

-----

## 3. Architecture

```
ARKit (ARWorldTrackingConfiguration, sceneReconstruction = .mesh)
   │  provides: world frame, ground plane, metric scale, VIO/LiDAR tracking
   │
   ├── PHASE A: Initial fix (one-time, good angle)
   │     5 corner pixels → raycast to ground plane → computeHomePlatePose → field anchor
   │
   ├── SLAM carries the anchor as user walks to operating position
   │
   └── PHASE B: Maintenance loop (operating position, every frame)
         foul-line detection → vanishing point (yaw) + apex ray-cast (x, y)
         → smoothed filter over (x, y, yaw) → update field anchor
         + opportunistic plate re-registration when briefly unoccluded
```

The field model is parented to a single `ARAnchor`. The maintenance loop updates
that anchor through a smoothing filter — never re-placed raw per frame (avoids
jitter).

-----

## 4. Phase A — Initial fix (calibration)

Goal: one clean, near-perfect pose from a good angle that SLAM will preserve.
**Fully automatic — no manual tapping.**

**Method: region → contour → polygon → raycast corners to ground plane.** Zero
training data; runs natively on iOS (no PnP/OpenCV — see CV-stack decision).

1. **Region.** Isolate the plate as a bright white blob on dirt. Threshold in a
   robust color space (HSV/Lab — high lightness, low saturation) rather than raw
   RGB, so shadows and dirt tone don't break it. Take the largest plausible
   connected component as the plate candidate.
2. **Contour.** `VNDetectContoursRequest` (Vision framework) finds the region's
   contour natively.
3. **Polygon.** Simplify the contour to a polygon with `approxPolyDP`
   (Douglas–Peucker). Tune epsilon so a clean plate resolves to **5 vertices**.
   Because it's a pentagon, you get semantically meaningful, *ordered* corners
   directly — not a pile of anonymous corners.
4. **Disambiguate + label.** Identify the apex vs. the two front-side and two
   back corners by geometry (the apex is the vertex pointing toward the catcher;
   the squared back edge anchors orientation). This gives a consistent
   correspondence order for PnP.
5. **Subpixel refine.** Run a `cornerSubPix`-equivalent on each of the 5 vertices
   before solving — this drives final accuracy more than the detector choice,
   since corner error amplifies into outfield pose error.
6. **Solve — by raycast, not PnP.** ARKit already gives the ground plane and
   metric scale, so rather than `solvePnP`, raycast each of the 5 refined corner
   pixels onto the ground plane (`raycastScreenPoint`) → 5 world points →
   `computeHomePlatePose()` (already implemented + tested) recovers plate origin,
   yaw, and a scale-check against the known 17″ edge. The good-angle requirement
   is exactly what makes ground-plane raycast accurate here. (See the CV-stack
   decision below for why PnP/OpenCV is avoided.)
7. Create the field `ARAnchor` at the resulting plate position + yaw; parent the
   field model to it.

The accurate **along-range distance** captured here is the value SLAM preserves
on the walk over — the whole point of doing the fix from a good angle.

**Validation gate before accepting a fix:** require exactly 5 vertices, a
plausible pentagon shape (edge-length ratios, apex angle), and a low scale error
from `computeHomePlatePose` (the recovered 17″ front edge vs. known). Reject and
re-capture otherwise rather than anchoring off a bad solve.

*Fallbacks:*

- *If the region threshold proves fragile* across lighting/wear: swap step 1 for
  a small Core ML plate segmentation mask (see §10), but keep steps 2–7 unchanged.
- *If a good angle is never available:* co-solve point-plus-line PnP from the
  first frame — fold the foul lines into the very first solve so the long line
  baseline corrects the orientation the squashed pentagon gets wrong. Do **not**
  do a plate-only fix at a steep angle and then switch.

-----

## 5. Phase B — Maintenance loop (operating position)

Run every frame:

1. **Line detection.** Start with classic CV: edge detection → Hough → RANSAC
   line fitting on the two foul lines. Cheap, runs every frame, robust at grazing
   angles. Apple's Vision framework has no direct line detector, so use MPS Sobel
   edges + RANSAC line fitting (Accelerate/Metal — see CV-stack decision). Reach
   for a small Core ML segmentation net **only if**
   shadows / chalk wear prove brutal in testing — don't build it preemptively.
2. **Yaw** from the lines' **vanishing points** (robust; does not require the apex).
3. **(x, y)** by `ARRaycastQuery` of the apex pixel onto the estimated ground
   plane. Trust this **direction strongly, distance weakly** — weight accordingly.
4. **Fuse** into a smoothing filter over (x, y, yaw). Update the field anchor from
   the filtered estimate.
5. **Opportunistic plate re-registration:** when the plate is briefly unoccluded
   and confidence is high, run a plate solve to correct accumulated drift.

-----

## 6. ARKit specifics

- `ARWorldTrackingConfiguration` with `sceneReconstruction = .mesh` (LiDAR scene
  mesh).
- `ARRaycastQuery` to drop the apex onto the estimated plane.
- Single `ARAnchor` for the field; field model parented to it.
- Smoothed (x, y, yaw) filter driving anchor updates — no raw per-frame
  replacement.
- LiDAR caveat: useful range ~5 m. It firms up the ground plane and the walk-over
  tracking; it does **not** range the plate from the dugout. Don't design around
  LiDAR depth at the plate.

-----

## 7. Critical early tests

1. **Yaw drift over a session.** Even ~1° uncorrected yaw throws outfield content
   off badly at 300+ ft. Measure accumulated drift over a realistic session —
   this number sets how aggressively the line correction must run.
2. **Along-range stability across the walk.** Verify SLAM preserves the
   initial-fix distance accurately from good-angle spot to operating position.
3. **Line robustness** under shadows, chalk wear, partial erasure, time-of-day
   lighting — decides whether classic CV suffices or a segmentation net is needed.
4. **Apex ray-cast accuracy** vs. ground-plane estimate quality at the operating
   distance.

-----

## 8. Build order (suggested)

1. ARKit session + ground plane + scene mesh; confirm stable world frame.
2. Tap-to-mark plate calibration → raycast corners → `computeHomePlatePose` →
   place field anchor (✅ already built as the Plate tab's manual capture).
   Validate with
   a good-angle test.
3. Walk-over test: does the anchor hold as you move to the dugout? (SLAM
   carry-over.)
4. Foul-line detection (classic CV) + vanishing-point yaw.
5. Apex ray-cast for (x, y).
6. Fusion filter over (x, y, yaw) + anchor update.
7. Opportunistic plate re-registration.
8. Drift instrumentation + the tests in §7.
9. Only if needed: Core ML line/plate segmentation to replace classic CV.

-----

## 9. Open decisions to revisit

- Field model source/dimensions per level of play (standardize on plate = 17″
  pentagon for metric anchor; everything else scales from the known field spec for
  the target level).
- Filter choice for (x, y, yaw) smoothing (simple complementary/Kalman vs.
  exponential smoothing) — start simple, tune against measured drift.
- Whether automated plate keypoint detection is worth building, or tap-to-mark
  calibration is sufficient for the product.

-----

## 10. Fallback: Core ML segmentation

Only if §4 step 1 (region threshold) or §5 step 1 (classic line CV) prove too
fragile on real fields. Swap the fragile stage for a small Core ML segmentation
mask (plate mask, or foul-line mask) and keep everything downstream unchanged.
The deprioritized `training/plate-detector/` Ultralytics→CoreML scaffold is where
that model would be trained if it comes to this.

-----

## Reconciliation with existing code

What in `apps/lab-mobile` this plan builds on, reuses, or retires:

| Plan element | Existing code | Action |
|---|---|---|
| World frame anchored at home plate (origin/axes, 4×4 transforms) | `src/field/coordinateFrame.ts` — `computeFieldFrame`, `computeHomePlatePose`, `transformPoint` (Phase 0, ✅ done + unit-tested) | **Reuse.** The 5 raycast corner points (§4.6) feed this unchanged. |
| ARKit session, ground raycast, anchors, world↔screen projection, aligned capture (image + depth + intrinsics + cam→world) | `modules/expo-lidar` — `raycastScreenPoint`, `addFieldLandmarkAtWorld`, `captureAlignedFrame`, `currentCameraTransform`, `resetSession`, `projectWorldPoint` | **Reuse + extend.** Needs: contour/polygon/subpixel CV (Vision + vImage), foul-line CV (MPS Sobel + RANSAC), `ARRaycastQuery`, scene-mesh reconstruction. (No PnP — raycast to plane instead.) |
| Manual 5-corner "Plate World" capture (AR tab page 0) | `app/(tabs)/ar.tsx` — `capturePlateCorner`, `establishPlateWorld` | **Repurpose** as the §8.2 tap-to-mark calibration stand-in / good-angle validation, ahead of the automatic §4 region→contour→raycast. Already uses raycast + `computeHomePlatePose` — the automatic path just replaces the 5 taps. |
| In-app training-frame capture ("Save Frame") | `app/(tabs)/ar.tsx` — `saveTrainingFrame`; `Lidar.saveImageToPhotos` | **Keep** — still useful for collecting test frames for the §10 fallback / line-robustness §7.3 testing. |
| Trained YOLO-pose corner model | `training/plate-detector/` scaffold | **Deprioritize** to §10 fallback. Not the primary path anymore. |
| `home_plate` + bases/rubber/foul-pole landmark kinds | `modules/expo-lidar` — `FieldLandmarkKind` | **Reuse** for rendering the anchored field model. |

### CV stack decision: Accelerate / Vision / Metal (not OpenCV)

**Chosen 2026-05.** All custom CV is built on Apple-native frameworks — Vision
(`VNDetectContoursRequest`), Accelerate/vImage, and MetalPerformanceShaders —
**not** OpenCV. Rationale:

- The one operation that would justify OpenCV — **`solvePnP`** — is **avoided**.
  ARKit already provides the ground plane and metric scale, so the Phase A fix
  raycasts the 5 detected corner pixels to the ground plane
  (`raycastScreenPoint`, already in `expo-lidar`) and feeds the 5 world points to
  **`computeHomePlatePose()`, which already exists and is unit-tested (11/11)**.
  No PnP solve, no OpenCV. The plan's "good angle" requirement for the initial fix
  is exactly the condition under which ground-plane raycast is accurate — so
  raycast replaces PnP precisely where it's reliable.
- Everything else is small or already native (see list below). OpenCV would mean a
  heavy C++ pod + config plugin + Swift↔C++ bridge + lockfile/pod churn, bolted
  onto an Expo setup where every existing native module is thin Swift over Apple
  frameworks — all to avoid ~250 lines of well-understood algorithms after the
  hard part is already dodged.
- **Revisit only if:** late Phase B wants `solvePnP`-based opportunistic
  re-registration (§5.5) at grazing angles where raycast is weak. If that ever
  matters, add OpenCV *then*, scoped to that single solve — don't take the
  dependency now for a maybe. The §10 Core ML fallback does **not** change this
  decision (Core ML is also native).

### New native work this plan requires (not yet built)

- **Phase A pose: raycast, not PnP.** 5 corner pixels → `raycastScreenPoint` each
  to the ground plane → existing `computeHomePlatePose()`. (No new solver.)
- Plate region (§4.1): HSV/Lab threshold → largest connected component.
  **vImage / Metal** (no OpenCV `inRange`).
- Contour (§4.2): **`VNDetectContoursRequest`** (Vision — native).
- Polygon (§4.3): Douglas–Peucker simplify to 5 vertices. Hand-rolled (~50 lines).
- Subpixel refine (§4.5): `cornerSubPix` equivalent on vImage gradients
  (~60 lines).
- Foul-line detection (§5.1): edges via **MPS Sobel** → RANSAC line fit
  (~100 lines) → vanishing-point yaw (§5.2, pure geometry). (Vision has no line
  detector; this replaces the OpenCV Hough path.)
- `ARWorldTrackingConfiguration.sceneReconstruction = .mesh` enablement +
  `ARRaycastQuery` apex drop.
- A smoothing filter over (x, y, yaw) and single-anchor update path.
- Drift instrumentation (§7).

-----

## Out of scope (for this work)

- Multi-phone / shared sessions. (The physical plate is the natural shared
  reference if revisited later — each phone registers into the same field frame.)
- Changes to the assistant app (`apps/mobile`). All work lives in
  `apps/lab-mobile`.
