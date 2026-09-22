#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="${1:-$HOME/Downloads/Company Vault.zip}"
OUTPUT_DIR="$REPO_ROOT/media-library/generated"

if [[ ! -e "$SOURCE" ]]; then
  echo "Source not found: $SOURCE" >&2
  echo "Pass the ZIP/folder path as the first argument." >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required. Install Python 3 first (Homebrew: brew install python)." >&2
  exit 1
fi

if ! command -v ffprobe >/dev/null 2>&1; then
  echo "WARNING: ffprobe was not found. Video duration/resolution metadata may be incomplete." >&2
  echo "Install FFmpeg for full metadata (Homebrew: brew install ffmpeg)." >&2
fi

VENV="$REPO_ROOT/.venv-media"
if [[ ! -d "$VENV" ]]; then
  python3 -m venv "$VENV"
fi
# shellcheck disable=SC1091
source "$VENV/bin/activate"
python -m pip install --quiet --upgrade pip
python -m pip install --quiet requests pillow

cd "$REPO_ROOT"

echo "==> Building and organizing The Business Flow media catalog..."
python tools/build_media_catalog.py "$SOURCE" --output-dir "$OUTPUT_DIR"

echo
echo "==> Catalog summary"
cat "$OUTPUT_DIR/summary.json"
echo

export SUPABASE_URL="${SUPABASE_URL:-https://rhddgfvtrkmusbvphnlg.supabase.co}"

if [[ -z "${SUPABASE_SECRET_KEY:-}" && -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ]]; then
  printf "Paste the Supabase Secret Key (input will stay hidden), then press Enter: " >&2
  IFS= read -r -s SUPABASE_SECRET_KEY
  printf "\n" >&2
  export SUPABASE_SECRET_KEY
fi

echo "==> Uploading organized assets to mediaforge-assets/thebusinessflow/media-library/..."
python tools/upload_media_library.py "$OUTPUT_DIR"

echo
echo "DONE. The Business Flow media library is organized, cataloged and uploaded."
