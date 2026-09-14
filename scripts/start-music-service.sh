#!/usr/bin/env sh
set -eu

mkdir -p /data/tflite /data/huggingface /data/output
rm -rf /app/models/tflite /app/output
ln -s /data/tflite /app/models/tflite
ln -s /data/output /app/output

exec python /app/scripts/sa3_gradio.py \
  --no-share \
  --port "${PORT:-7871}" \
  --dit "${SA3_DIT:-sm-music}" \
  --decoder "${SA3_DECODER:-same-s}" \
  --precision "${SA3_PRECISION:-fp32}" \
  --threads "${SA3_THREADS:-4}" \
  --default-seconds "${SA3_DEFAULT_SECONDS:-20}" \
  --default-steps "${SA3_DEFAULT_STEPS:-8}"
