#!/usr/bin/env python3
"""Export the trained home-plate pose model to CoreML for the iOS app.

    python export_coreml.py --weights runs/pose/plate-pose/weights/best.pt

Produces best.mlpackage next to the weights. Rename it to
PlateDetector.mlpackage and drop it into the native module
(modules/expo-plate-detector/ios/), mirroring BaseballDetector.mlpackage.

Note: a pose model's CoreML output is raw tensors (boxes + keypoints), not the
VNRecognizedObjectObservation the baseball detector gets. The Swift side decodes
those tensors (confidence threshold + NMS + keypoint extraction). After export,
print the model's output description so the Swift decoder matches the shape:

    python -c "import coremltools as ct; print(ct.models.MLModel('best.mlpackage').get_spec().description)"
"""
import argparse

from ultralytics import YOLO


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--weights", required=True,
                    help="best.pt from the training run")
    ap.add_argument("--imgsz", type=int, default=640)
    args = ap.parse_args()

    model = YOLO(args.weights)
    out = model.export(format="coreml", imgsz=args.imgsz)
    print("Exported CoreML model to:", out)
    print("Rename to PlateDetector.mlpackage and place in "
          "modules/expo-plate-detector/ios/")


if __name__ == "__main__":
    main()
