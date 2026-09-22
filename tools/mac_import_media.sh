#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="${1:-$HOME/Downloads/Company Vault.zip}"
OUTPUT_DIR="$REPO_ROOT/media-library/generated"
MODE="${2:-build}"

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required." >&2
  exit 1
fi
if ! command -v git >/dev/null 2>&1; then
  echo "git is required." >&2
  exit 1
fi
if ! git lfs version >/dev/null 2>&1; then
  echo "Git LFS is required. Install it, then rerun." >&2
  exit 1
fi

VENV="$REPO_ROOT/.venv-media"
if [[ ! -d "$VENV" ]]; then
  python3 -m venv "$VENV"
fi
source "$VENV/bin/activate"
python -m pip install --quiet --upgrade pip
python -m pip install --quiet pillow

cd "$REPO_ROOT"

if [[ "$MODE" != "publish-only" ]]; then
  if [[ ! -e "$SOURCE" ]]; then
    echo "Source not found: $SOURCE" >&2
    exit 1
  fi
  if ! command -v ffprobe >/dev/null 2>&1; then
    echo "ffprobe is required for complete video metadata." >&2
    exit 1
  fi
  echo "==> Building and organizing The Business Flow media catalog..."
  python tools/build_media_catalog.py "$SOURCE" --output-dir "$OUTPUT_DIR"
else
  echo "==> Reusing the already-generated catalog and organized media..."
fi

python tools/publish_media_to_github.py "$OUTPUT_DIR" --repo-root "$REPO_ROOT"

git lfs install --local
git pull --rebase origin main
git add .gitattributes media-library/catalog.json media-library/summary.json media-library/assets

if [[ -n "$(git status --porcelain)" ]]; then
  git commit -m "Add The Business Flow reusable media library"
  git push origin main
else
  echo "GitHub media library is already up to date."
fi

echo "DONE. Media is stored only in thebusinessflowtv/thebusinessflow via Git LFS."
