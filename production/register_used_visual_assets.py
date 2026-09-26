from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_REGISTRY = ROOT / "production" / "used-visual-assets.json"


def load_json(path: Path, default: dict[str, Any]) -> dict[str, Any]:
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--registry", type=Path, default=DEFAULT_REGISTRY)
    parser.add_argument("--topic-id", required=True)
    parser.add_argument("--run-id", default="")
    args = parser.parse_args()

    manifest = load_json(args.manifest, {})
    assets = manifest.get("assets") or []
    if len(assets) < 40:
        raise RuntimeError(f"Refusing to register incomplete visual package: only {len(assets)} images")
    if manifest.get("cross_video_reuse_allowed") is not False or manifest.get("fresh_only") is not True:
        raise RuntimeError("Visual manifest was not produced under the zero-reuse policy")

    registry = load_json(
        args.registry,
        {"version": 1, "policy": "zero_cross_video_image_reuse", "assets": []},
    )
    existing = registry.setdefault("assets", [])
    existing_sha = {str(x.get("sha256") or "").lower() for x in existing if x.get("sha256")}
    existing_phash = {str(x.get("perceptual_hash") or "").lower() for x in existing if x.get("perceptual_hash")}
    existing_urls = {
        str(x.get(field) or "").strip().lower()
        for x in existing
        for field in ("source_url", "download_url")
        if x.get(field)
    }

    now = datetime.now(timezone.utc).isoformat()
    added = 0
    for asset in assets:
        digest = str(asset.get("sha256") or "").lower()
        phash = str(asset.get("perceptual_hash") or "").lower()
        source_url = str(asset.get("source_url") or "").strip()
        download_url = str(asset.get("download_url") or "").strip()
        if not digest or not phash:
            raise RuntimeError(f"Missing image fingerprint for {asset.get('asset_id')}")
        if digest in existing_sha or phash in existing_phash or source_url.lower() in existing_urls or download_url.lower() in existing_urls:
            raise RuntimeError(f"Cross-video reuse reached registration unexpectedly: {asset.get('asset_id')}")

        existing.append({
            "topic_id": args.topic_id,
            "run_id": str(args.run_id),
            "asset_id": asset.get("asset_id"),
            "title": asset.get("title"),
            "source": asset.get("source"),
            "source_url": source_url,
            "download_url": download_url,
            "sha256": digest,
            "perceptual_hash": phash,
            "used_at": now,
        })
        existing_sha.add(digest)
        existing_phash.add(phash)
        if source_url:
            existing_urls.add(source_url.lower())
        if download_url:
            existing_urls.add(download_url.lower())
        added += 1

    registry["version"] = 1
    registry["policy"] = "zero_cross_video_image_reuse"
    registry["updated_at"] = now
    registry["asset_count"] = len(existing)
    args.registry.write_text(json.dumps(registry, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Registered {added} permanently reserved images for {args.topic_id}. Total reserved: {len(existing)}")


if __name__ == "__main__":
    main()
