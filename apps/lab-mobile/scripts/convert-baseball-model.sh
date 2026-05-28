#!/bin/bash
# EAS prebuild hook: converts baseball-detector .pt → CoreML .mlpackage
# Runs on macOS EAS build machine where coremltools works natively.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MODEL_PT="$PROJECT_DIR/baseball-detector-260527.pt"
OUTPUT_DIR="$PROJECT_DIR/modules/expo-baseball/ios"
OUTPUT_NAME="BaseballDetector"

if [ -d "$OUTPUT_DIR/$OUTPUT_NAME.mlpackage" ]; then
  echo "[convert-baseball-model] $OUTPUT_NAME.mlpackage already exists, skipping"
  exit 0
fi

if [ ! -f "$MODEL_PT" ]; then
  echo "[convert-baseball-model] ERROR: $MODEL_PT not found"
  exit 1
fi

echo "[convert-baseball-model] Installing ultralytics + coremltools..."
pip3 install --quiet --break-system-packages ultralytics coremltools 2>/dev/null || \
  pip3 install --quiet ultralytics coremltools

echo "[convert-baseball-model] Converting to CoreML..."
python3 << PYEOF
from ultralytics import YOLO
import shutil, os

model = YOLO("$MODEL_PT")
result = model.export(format="coreml", nms=False)
print(f"Exported to: {result}")

dst = os.path.join("$OUTPUT_DIR", "$OUTPUT_NAME.mlpackage")
if os.path.exists(dst):
    shutil.rmtree(dst)
shutil.move(result, dst)
print(f"Moved to: {dst}")
PYEOF

echo "[convert-baseball-model] Done — $OUTPUT_NAME.mlpackage ready"
