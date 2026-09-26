from __future__ import annotations

import json
import sys
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from render_episode_hq import main

ROOT = Path(__file__).resolve().parents[1]
REGISTRY = ROOT / "production" / "used-visual-assets.json"
VISUAL_ROOT = ROOT / "production" / "visual-cache"


def canonical_url(value: str | None) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    try:
        parsed = urlsplit(raw)
        return urlunsplit((parsed.scheme.lower(), parsed.netloc.lower(), parsed.path, "", "")).rstrip("/")
    except Exception:
        return raw.lower().split("#", 1)[0].split("?", 1)[0].rstrip("/")


def phash_distance(a: str, b: str) -> int:
    try:
        return (int(a, 16) ^ int(b, 16)).bit_count()
    except Exception:
        return 64


def arg_value(flag: str) -> str:
    try:
        index = sys.argv.index(flag)
        return sys.argv[index + 1]
    except (ValueError, IndexError):
        return ""


def enforce_zero_cross_video_reuse() -> None:
    package_arg = arg_value("--package")
    if not package_arg:
        raise RuntimeError("Render blocked: --package is required for visual uniqueness validation")

    package_path = Path(package_arg)
    if not package_path.is_absolute():
        package_path = ROOT / package_path
    if not package_path.exists():
        raise RuntimeError(f"Render blocked: package not found: {package_path}")

    package = json.loads(package_path.read_text(encoding="utf-8"))
    topic_id = str(package.get("topic_id") or package_path.parent.name).strip()
    if not topic_id:
        raise RuntimeError("Render blocked: unable to resolve topic_id")

    manifest_path = VISUAL_ROOT / topic_id / "visual-assets.json"
    if not manifest_path.exists():
        raise RuntimeError(f"Render blocked: visual manifest not found: {manifest_path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assets = manifest.get("assets") or []

    if len(assets) < 40:
        raise RuntimeError(f"Render blocked: only {len(assets)} visual assets; minimum is 40")
    if manifest.get("fresh_only") is not True:
        raise RuntimeError("Render blocked: visual package is not marked fresh_only=true")
    if manifest.get("cross_video_reuse_allowed") is not False:
        raise RuntimeError("Render blocked: cross-video visual reuse policy is not disabled")

    registry = {"assets": []}
    if REGISTRY.exists():
        registry = json.loads(REGISTRY.read_text(encoding="utf-8"))

    used_hashes: set[str] = set()
    used_urls: set[str] = set()
    used_phashes: list[tuple[str, str]] = []
    for old in registry.get("assets") or []:
        digest = str(old.get("sha256") or "").lower()
        phash = str(old.get("perceptual_hash") or "").lower()
        if digest:
            used_hashes.add(digest)
        if phash:
            used_phashes.append((phash, str(old.get("topic_id") or "unknown")))
        for field in ("source_url", "download_url"):
            url = canonical_url(old.get(field))
            if url:
                used_urls.add(url)

    current_hashes: set[str] = set()
    current_urls: set[str] = set()
    current_phashes: list[str] = []
    collisions: list[str] = []

    for asset in assets:
        asset_id = str(asset.get("asset_id") or "unknown")
        digest = str(asset.get("sha256") or "").lower()
        phash = str(asset.get("perceptual_hash") or "").lower()
        urls = [canonical_url(asset.get("source_url")), canonical_url(asset.get("download_url"))]
        urls = [u for u in urls if u]

        if not digest or not phash:
            collisions.append(f"{asset_id}: missing fingerprint")
            continue

        if digest in current_hashes or any(u in current_urls for u in urls) or any(phash_distance(phash, p) <= 4 for p in current_phashes):
            collisions.append(f"{asset_id}: duplicate/near-duplicate inside current video")
            continue

        if digest in used_hashes:
            collisions.append(f"{asset_id}: SHA256 already used in another video")
        elif any(u in used_urls for u in urls):
            collisions.append(f"{asset_id}: source/download URL already used in another video")
        else:
            for old_phash, old_topic in used_phashes:
                if phash_distance(phash, old_phash) <= 4:
                    collisions.append(f"{asset_id}: perceptually same image already used by {old_topic}")
                    break

        current_hashes.add(digest)
        current_urls.update(urls)
        current_phashes.append(phash)

    if collisions:
        sample = "\n - ".join(collisions[:20])
        raise RuntimeError(
            "ZERO-REUSE POLICY VIOLATION. Render blocked because images are duplicated or were used in another video.\n - "
            + sample
            + (f"\n... and {len(collisions) - 20} more" if len(collisions) > 20 else "")
        )

    print(f"Zero-reuse pre-render gate passed: {len(assets)} fresh images for {topic_id}; no cross-video duplicates detected.")


if __name__ == "__main__":
    enforce_zero_cross_video_reuse()
    main()
