#!/usr/bin/env python3
"""Train the home-plate 5-keypoint pose model (Ultralytics YOLO-pose).

Mirrors the baseball detector workflow. Run on a machine with the dataset +
a GPU (e.g. your C:\\dev\\vision box), not in CI.

    pip install ultralytics
    python train.py --epochs 200

Output weights land in runs/pose/<name>/weights/best.pt — then run
export_coreml.py on that file.
"""
import argparse

from ultralytics import YOLO


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    # yolo26n-pose matches the baseball detector's YOLO26n backbone. If that
    # checkpoint isn't available in your Ultralytics version, fall back to
    # yolo11n-pose.pt — same training/label format.
    ap.add_argument("--model", default="yolo26n-pose.pt",
                    help="base pose weights (fallback: yolo11n-pose.pt)")
    ap.add_argument("--data", default="data.yaml")
    ap.add_argument("--epochs", type=int, default=200)
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--name", default="plate-pose")
    args = ap.parse_args()

    model = YOLO(args.model)
    model.train(
        data=args.data,
        epochs=args.epochs,
        imgsz=args.imgsz,
        batch=args.batch,
        name=args.name,
        # A near-symmetric, low-texture white pentagon benefits from generous
        # geometric aug but little color distortion.
        degrees=180.0,     # plates appear at any in-plane rotation
        fliplr=0.5,        # uses flip_idx from data.yaml
        scale=0.5,
        mosaic=1.0,
        hsv_s=0.3,
        hsv_v=0.4,
    )


if __name__ == "__main__":
    main()
