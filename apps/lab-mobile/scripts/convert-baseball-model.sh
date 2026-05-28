#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MODEL_PT="$PROJECT_DIR/baseball-detector-260527.pt"
OUTPUT_DIR="$PROJECT_DIR/modules/expo-baseball/ios"
OUTPUT_NAME="BaseballDetector"

if [ -d "$OUTPUT_DIR/$OUTPUT_NAME.mlpackage" ]; then
  echo "[convert] $OUTPUT_NAME.mlpackage exists, skipping"
  exit 0
fi

if [ ! -f "$MODEL_PT" ]; then
  echo "[convert] ERROR: $MODEL_PT not found"
  exit 1
fi

echo "[convert] Installing ultralytics..."
pip3 install ultralytics 2>&1 || pip3 install --break-system-packages ultralytics 2>&1

echo "[convert] Exporting to CoreML..."
python3 -c "
from ultralytics import YOLO
import shutil, os
model = YOLO('$MODEL_PT')
result = model.export(format='coreml', nms=False)
dst = os.path.join('$OUTPUT_DIR', '$OUTPUT_NAME.mlpackage')
if os.path.exists(dst):
    shutil.rmtree(dst)
shutil.move(result, dst)
print('Done:', dst)
"
