#!/bin/bash
# Run the voice service: Kokoro-82M for text-to-speech, optional RVC for voice conversion.
#
#   PORT=8100 DEVICE=cuda ./run.sh
#
# RVC models go in ./models/<name>/ as one .pth plus (optionally) one .index; a talent refers to
# them by <name>. Override the directory with RVC_MODELS.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
PORT=${PORT:-8100}
DEVICE=${DEVICE:-cuda}
RVC_MODELS=${RVC_MODELS:-"$SCRIPT_DIR/models"}
export DEVICE RVC_MODELS
if [ ! -d venv ]; then
  echo "Creating virtual environment..."
  if command -v uv >/dev/null; then
    uv venv --python 3.10 venv && uv pip install --python venv/bin/python -r requirements.txt
  else
    python3 -m venv venv && venv/bin/pip install --upgrade pip && venv/bin/pip install -r requirements.txt
  fi
fi
echo "Starting voice service on port $PORT ($DEVICE)..."
# Activate rather than call venv/bin/python directly: some deps (spaCy, huggingface_hub) shell out
# to pip/uv and look for VIRTUAL_ENV.
source venv/bin/activate
exec python server.py --port "$PORT" "$@"
