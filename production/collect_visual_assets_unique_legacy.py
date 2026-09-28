from __future__ import annotations

import argparse
import json
import shutil
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from PIL import Image

import collect_visual_assets as profiles

core = profiles.core
ROOT = core.ROOT
REGISTRY_PATH = ROOT / "production" / "used-visual-assets.json"


def canonical_url(value: str | None) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    try:
        p = urlsplit(raw)
        return urlunsplit((p.scheme.lower(), p.netloc.lower(), p.path, "", "")).rstrip("/")
    except Exception:
        return raw.lower().split("#", 1)[0].split("?", 1)[0].rstrip("/")


def dhash(path: Path) -> str:
    with Image.open(path) as image:
        gray = image.convert("L").resize((9, 8), Image.Resampling.LANCZOS)
        pixels = list(gray.getdata())
    bits = []
    for y in range(8):
        row = pixels[y * 9:(y + 1) * 9]
        bits.extend(row[x] > row[x + 1] for x in range(8))
    value = 0
    for bit in bits:
        value = (value << 1) | int(bit)
    return f"{value:016x}"


def phash_distance(a: str, b: str) -> int:
    try:
        return (int(a, 16) ^ int(b, 16)).bit_count()
    except Exception:
        return 64


def load_registry() -> dict[str, Any]:
    if not REGISTRY_PATH.exists():
        return {"version": 1, "policy": "zero_cross_video_image_reuse", "assets": []}
    data = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
    data.setdefault("assets", [])
    return data


def registry_index(registry: dict[str, Any]) -> tuple[set[str], set[str], list[str]]:
    hashes: set[str] = set()
    urls: set[str] = set()
    perceptual: list[str] = []
    for asset in registry.get("assets") or []:
        if asset.get("sha256"):
            hashes.add(str(asset["sha256"]).lower())
        if asset.get("perceptual_hash"):
            perceptual.append(str(asset["perceptual_hash"]).lower())
        for field in ("source_url", "download_url"):
            value = canonical_url(asset.get(field))
            if value:
                urls.add(value)
    return hashes, urls, perceptual


def previously_used(*, digest: str, perceptual_hash: str, source_url: str, download_url: str,
                    used_hashes: set[str], used_urls: set[str], used_perceptual: list[str]) -> tuple[bool, str]:
    if digest.lower() in used_hashes:
        return True, "sha256"
    for value in (canonical_url(source_url), canonical_url(download_url)):
        if value and value in used_urls:
            return True, "url"
    # Normalization makes the same photograph from different resolutions highly stable.
    # A small Hamming distance also catches recompressed/resized copies of the same image.
    if any(phash_distance(perceptual_hash, old) <= 4 for old in used_perceptual):
        return True, "perceptual_hash"
    return False, ""


def write_manifest(path: Path, *, topic_id: str, topic: str, target: int,
                   queries: list[str], assets: list[dict[str, Any]], partial: bool,
                   rejected_cross_video: int) -> dict[str, Any]:
    manifest = core.write_manifest(
        path,
        topic_id=topic_id,
        topic=topic,
        target=target,
        queries=queries,
        assets=assets,
        partial=partial,
    )
    manifest.update({
        "profile_version": "hq-v3-zero-reuse",
        "cache_hit": False,
        "fresh_only": True,
        "cross_video_reuse_allowed": False,
        "used_asset_registry": REGISTRY_PATH.relative_to(ROOT).as_posix(),
        "rejected_cross_video_assets": rejected_cross_video,
        "perceptual_hash_max_distance": 4,
    })
    path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest


def collect(topic_id: str, research_path: Path, target: int) -> dict[str, Any]:
    research = core.load_json(research_path)
    topic = str(research.get("topic") or topic_id).strip()
    cache_dir = core.CACHE_ROOT / topic_id
    manifest_path = cache_dir / "visual-assets.json"

    # Critical policy: never hydrate or reuse a previous visual package for a new render.
    # The topic workspace is disposable. Only the permanent global used-assets registry survives.
    if cache_dir.exists():
        shutil.rmtree(cache_dir)
    images_dir = cache_dir / "images"
    images_dir.mkdir(parents=True, exist_ok=True)

    registry = load_registry()
    used_hashes, used_urls, used_perceptual = registry_index(registry)

    queries = core.build_queries(research, topic)
    candidates: list[dict[str, Any]] = []
    seen_urls: set[str] = set()
    seen_titles: set[str] = set()
    for idx, query in enumerate(queries):
        batch: list[dict[str, Any]] = []
        try:
            batch.extend(core.wikimedia_candidates(topic, query))
        except Exception as exc:
            print(f"Wikimedia query failed for {query!r}: {exc}")
        batch.extend(core.openverse_candidates(topic, query))
        core.google_cse_candidates(topic, query)
        for candidate in batch:
            url = str(candidate.get("url") or "")
            url_key = canonical_url(url)
            title_key = str(candidate.get("title") or "").strip().lower()
            if not url or url_key in seen_urls or (title_key and title_key in seen_titles):
                continue
            candidate["score"] = core.candidate_score(candidate, idx, topic)
            candidates.append(candidate)
            seen_urls.add(url_key)
            if title_key:
                seen_titles.add(title_key)
        time.sleep(0.15)

    candidates.sort(
        key=lambda c: (
            int(c.get("source_width") or 0) >= 3840 and int(c.get("source_height") or 0) >= 2160,
            float(c.get("score") or 0),
        ),
        reverse=True,
    )

    selected: list[dict[str, Any]] = []
    current_hashes: set[str] = set()
    current_urls: set[str] = set()
    current_perceptual: list[str] = []
    attempted: set[str] = set()
    query_counts: dict[str, int] = {}
    rejected_cross_video = 0

    for per_query_limit in (core.MAX_PER_QUERY, 999):
        for candidate in candidates:
            if len(selected) >= target:
                break
            query = str(candidate.get("query") or "")
            url = str(candidate.get("url") or "")
            url_key = canonical_url(url)
            source_url = str(candidate.get("landing_url") or candidate.get("url") or "")
            if not url or url_key in attempted or query_counts.get(query, 0) >= per_query_limit:
                continue
            attempted.add(url_key)

            # Reject an already-used URL before downloading whenever possible.
            if canonical_url(source_url) in used_urls or url_key in used_urls:
                rejected_cross_video += 1
                print(f"Rejected previously used visual by URL: {source_url or url}")
                continue

            try:
                content = core.download_bytes(candidate)
                temp = images_dir / f"candidate_{len(attempted):04d}.jpg"
                digest, source_width, source_height, native_4k = core.normalize_image(content, temp)
                perceptual_hash = dhash(temp)

                is_used, reason = previously_used(
                    digest=digest,
                    perceptual_hash=perceptual_hash,
                    source_url=source_url,
                    download_url=url,
                    used_hashes=used_hashes,
                    used_urls=used_urls,
                    used_perceptual=used_perceptual,
                )
                if is_used:
                    rejected_cross_video += 1
                    temp.unlink(missing_ok=True)
                    print(f"Rejected previously used visual by {reason}: {candidate.get('title')!r}")
                    continue

                # Also forbid duplicate/near-duplicate photos inside the current video.
                if (
                    digest in current_hashes
                    or canonical_url(source_url) in current_urls
                    or url_key in current_urls
                    or any(phash_distance(perceptual_hash, old) <= 4 for old in current_perceptual)
                ):
                    temp.unlink(missing_ok=True)
                    continue

                destination = images_dir / f"image_{len(selected)+1:03d}.jpg"
                temp.replace(destination)
                current_hashes.add(digest)
                current_perceptual.append(perceptual_hash)
                current_urls.update(v for v in (canonical_url(source_url), url_key) if v)
                query_counts[query] = query_counts.get(query, 0) + 1

                selected.append({
                    "asset_id": f"visual-{topic_id}-{len(selected)+1:03d}",
                    "type": "image",
                    "local_path": destination.relative_to(ROOT).as_posix(),
                    "width": 1280,
                    "height": 720,
                    "render_width": core.OUTPUT_WIDTH,
                    "render_height": core.OUTPUT_HEIGHT,
                    "source_width": source_width,
                    "source_height": source_height,
                    "native_4k": native_4k,
                    "quality_tier": "native_4k" if native_4k else "1080p_plus_fallback",
                    "title": candidate.get("title"),
                    "query": query,
                    "source": candidate.get("source"),
                    "source_url": source_url,
                    "download_url": url,
                    "creator": candidate.get("creator"),
                    "license": candidate.get("license"),
                    "sha256": digest,
                    "perceptual_hash": perceptual_hash,
                    "score": round(float(candidate.get("score") or 0), 3),
                })
                write_manifest(
                    manifest_path,
                    topic_id=topic_id,
                    topic=topic,
                    target=target,
                    queries=queries,
                    assets=selected,
                    partial=len(selected) < target,
                    rejected_cross_video=rejected_cross_video,
                )
            except Exception as exc:
                print(f"Skipping visual candidate {candidate.get('title')!r}: {exc}")

        if len(selected) >= target:
            break

    manifest = write_manifest(
        manifest_path,
        topic_id=topic_id,
        topic=topic,
        target=target,
        queries=queries,
        assets=selected,
        partial=len(selected) < target,
        rejected_cross_video=rejected_cross_video,
    )
    if len(selected) < core.MIN_IMAGES:
        raise RuntimeError(
            f"Fresh-only visual research found only {len(selected)} unused images; minimum is {core.MIN_IMAGES}. "
            f"{rejected_cross_video} candidates were rejected because they were already used in another video."
        )
    if len(selected) < target:
        print(f"WARNING: collected {len(selected)} of target {target}; continuing above minimum {core.MIN_IMAGES}.")
    print(
        f"Fresh-only visuals: {len(selected)} images; {rejected_cross_video} cross-video reuses blocked; "
        "zero cached images accepted."
    )
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--topic-id", required=True)
    parser.add_argument("--research", type=Path, default=None)
    parser.add_argument("--target", type=int, default=core.TARGET_IMAGES)
    args = parser.parse_args()
    research_path = args.research or (core.RESEARCH_ROOT / args.topic_id / "research.json")
    if not research_path.exists():
        raise RuntimeError(f"Missing research brief: {research_path}")
    manifest = collect(args.topic_id, research_path, max(1, args.target))
    print(json.dumps({
        "topic_id": args.topic_id,
        "image_count": manifest.get("image_count"),
        "fresh_only": True,
        "cross_video_reuse_allowed": False,
        "rejected_cross_video_assets": manifest.get("rejected_cross_video_assets"),
        "manifest": str(core.CACHE_ROOT / args.topic_id / "visual-assets.json"),
    }, indent=2))


if __name__ == "__main__":
    main()
