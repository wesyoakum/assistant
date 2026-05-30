# Home-plate corner detector (CoreML training)

Trains a **YOLO-pose** model that finds home plate in a camera frame and predicts
its **5 corners** as keypoints. Those 5 points feed
`src/field/coordinateFrame.ts` → `computeHomePlatePose()`, which recovers the
plate's position, orientation, and scale to anchor the AR "world" (see
`apps/lab-mobile/AR_WORLD_ANCHOR.md`). This is the automatic replacement for the
manual 5-corner tapping.

Same pipeline as the baseball detector (Ultralytics YOLO26n → CoreML), but a
**pose** model (keypoints) instead of a plain box detector.

## Division of labor

- **You (on a machine with a GPU + the images, e.g. `C:\dev\vision\plate-detector`):**
  capture images, label the 5 corners, run `train.py`, run `export_coreml.py`.
- **In-repo (committed here):** `data.yaml`, `train.py`, `export_coreml.py`, this
  guide. Dataset images/labels and `runs/` are gitignored.
- **Then back in the app:** drop `PlateDetector.mlpackage` into
  `modules/expo-plate-detector/ios/`; the native module + Plate tab (built
  separately) run it and call `computeHomePlatePose`.

> Training can't run in CI / the cloud container — there's no dataset or GPU
> there. It runs on your box, exactly like the baseball model.

## Keypoint convention (label in THIS order, every image)

YOLO-pose needs the 5 keypoints in a **consistent order** across all labels.
Use, looking at the plate from above:

| idx | corner | where |
|----|--------|-------|
| 0 | front-left  | left end of the 17″ edge (the edge facing the pitcher) |
| 1 | front-right | right end of the 17″ edge |
| 2 | back-right  | where the right 8.5″ side meets the right 12″ edge |
| 3 | apex        | the back point (faces the catcher) |
| 4 | back-left   | where the left 8.5″ side meets the left 12″ edge |

"Left/right" = as seen by someone standing behind the plate looking at the
pitcher. Order 0→1→2→3→4 walks the perimeter. This matches `flip_idx` in
`data.yaml`. (The geometry solver re-derives the apex itself, so it's robust to
occasional mislabels — but consistent ordering makes the model train far better.)

## Data

- **How many:** aim for ~200–400 labeled images to start; more is better. Home
  plate is low-texture and near-symmetric, so *variety* matters more than count.
- **Vary:** angle (low/high, oblique), distance, lighting (sun/shade/dusk/lights),
  plate condition (clean, dirty, chalk-covered, worn), partial occlusion
  (bat, feet, dirt), and different fields/plates.
- **Capture options:**
  - Phone photos / video frames of real plates.
  - In-app frames from the AR view (`captureViewImage`) — best, since they match
    inference conditions. (Ask me to add a "capture training frames" button to
    the Plate tab if you want this.)
- Mark a corner visibility `1` (occluded) instead of `2` when you can infer it
  but can't see it; `0` if it's out of frame.

## Labeling

Label with any YOLO-pose-compatible tool (Roboflow, CVAT, label-studio, etc.).
Each `labels/<name>.txt` line is one instance:

```
<class> <cx> <cy> <w> <h> <px0> <py0> <v0> <px1> <py1> <v1> ... <px4> <py4> <v4>
```

all normalized 0–1: `class`=0, the plate bbox (`cx cy w h`), then the 5 keypoints
in the order above with visibility. Put images in `images/{train,val}` and
labels in `labels/{train,val}` (~85/15 split).

## Train

```bash
pip install ultralytics
python train.py --epochs 200          # uses data.yaml, yolo26n-pose base
```

Weights → `runs/pose/plate-pose/weights/best.pt`. Sanity-check predictions with
`yolo pose predict model=runs/pose/plate-pose/weights/best.pt source=<an image>`.

## Export to CoreML

```bash
python export_coreml.py --weights runs/pose/plate-pose/weights/best.pt
```

Then inspect the output tensor shapes (the Swift decoder must match them):

```bash
python -c "import coremltools as ct; print(ct.models.MLModel('runs/pose/plate-pose/weights/best.mlpackage').get_spec().description)"
```

Rename to `PlateDetector.mlpackage`, drop into `modules/expo-plate-detector/ios/`,
commit the `.pt` (like `baseball-detector-260527.pt`) for reproducibility, and
tell me the output description so I can finalize the Swift decoder.

## App integration (built once a model exists)

- **Native module `expo-plate-detector`** (mirrors `expo-baseball`): loads the
  `.mlpackage`, runs it, decodes boxes + 5 keypoints (threshold + NMS), returns:

  ```ts
  PlateDetector.detect(uri): Promise<{
    width: number; height: number; elapsedMs: number;
    plates: { confidence: number; box: {x,y,w,h};
              keypoints: { x: number; y: number; conf: number }[] /* len 5 */ }[];
  }>
  ```

- **Plate tab flow:** capture a frame → `PlateDetector.detect` → take the best
  plate's 5 keypoints → raycast each to the ground (`raycastScreenPoint`) →
  `computeHomePlatePose(corners)` → drop the `home_plate` marker. Same Stage 2 +
  geometry as the manual flow; only Stage 1 (the 5 points) changes from taps to
  model output.
