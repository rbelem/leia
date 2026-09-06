#!/usr/bin/env sh
# No-container launcher for the leia local-model shims (Linux, macOS, WSL).
# Needs only uv (https://docs.astral.sh/uv/); it manages an isolated
# Python + the exact dependencies each model wants, per run.
#
# Usage: ./run.sh <model> [extra server.py args...]
#   ./run.sh kokoro        # best CPU quality  -> http://127.0.0.1:8880
#   ./run.sh piper         # fastest           -> http://127.0.0.1:8881
# Then open leia's options -> Local servers. See docs/local-tts.md.
set -eu

cd "$(dirname "$0")" # works from any cwd (repo root, shims/, elsewhere)

MODEL="${1:?usage: run.sh <kokoro|piper|kittentts|neutts|edge|stub> [extra server.py args...]}"
shift
# shellcheck disable=SC2086 # extra args are simple tokens (--port 8890)
EXTRA="$*"

case "$MODEL" in
  kokoro)    DEPS="kokoro-onnx onnxruntime" ;;
  piper)     DEPS="piper-tts" ;;
  kittentts) DEPS="kittentts==0.1.3 huggingface_hub" ;;
  neutts)    DEPS="neutts==1.4.1" ;;
  edge)      DEPS="edge-tts==7.2.8 miniaudio==1.71" ;;
  stub)      DEPS="" ;;
  *) echo "unknown model: $MODEL" >&2; exit 2 ;;
esac

if ! command -v uv >/dev/null 2>&1; then
  echo "uv not found - install it first:" >&2
  echo "  curl -LsSf https://astral.sh/uv/install.sh | sh   # Linux/macOS" >&2
  echo "  (or: pip install uv)" >&2
  exit 1
fi

set -- uv run --quiet
for dep in fastapi uvicorn $DEPS; do
  set -- "$@" --with "$dep"
done
# shellcheck disable=SC2086 # see EXTRA above
exec "$@" python server.py --model "$MODEL" $EXTRA
