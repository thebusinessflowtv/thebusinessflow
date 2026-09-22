from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import time
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from typing import Any

import requests
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parents[1]
CACHE_ROOT = ROOT / "production" / "visual-cache"
RESEARCH_ROOT = ROOT / "production" / "research-cache"
TARGET_IMAGES = int(os.getenv("VISUAL_IMAGE_TARGET", "50"))
MIN_IMAGES = int(os.getenv("VISUAL_IMAGE_MIN", "40"))
MAX_PER_QUERY = int(os.getenv("VISUAL_MAX_PER_QUERY", "7"))
USER_AGENT = "TheBusinessFlow/1.0 (editorial visual research; thebusinessflowtv@gmail.com)"
SESSION = requests.Session()
SESSION.headers.update({"User-Agent": USER_AGENT})
TOKEN_RE = re.compile(r"[a-z0-9]+")
LOGO_WORDS = {"logo", "logos", "wordmark", "logotype", "icon", "emblem", "brandmark"}
ALLOWED_LICENSE_FRAGMENTS = ("public domain", "cc0", "cc by", "cc-by", "cc by-sa", "cc-by-sa", "pdm")


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def tokenize(text: str) -> set[str]:
    return set(TOKEN_RE.findall(text.lower()))


def is_logoish(text: str) -> bool:
    return bool(tokenize(text) & LOGO_WORDS)


def license_allowed(value: str) -> bool:
    low = value.lower().strip()
    return any(fragment in low for fragment in ALLOWED_LICENSE_FRAGMENTS)


def build_visual_queries(research: dict[str, Any], topic: str) -> list[str]:
    """Turn the already-paid Haiku factual brief into visual search groups locally.

    This deliberately avoids another Anthropic call. The Haiku brief supplies the
    factual entities and themes; Python expands them into visual queries.
    """
    queries: list[str] = []
    generic = [
        "headquarters offices",
        "founder CEO historical",
        "products services customers",
        "factory warehouse operations",
        "employees workplace",
        "technology infrastructure",
        "historical company photos",
        "stores facilities",
        "delivery logistics vehicles",
        "business operations",
        "executives event",
        "buildings products customers",
    ]
    for suffix in generic:
        queries.append(f"{topic} {suffix}")

    # Add proper nouns/important entities from the Haiku brief without spending tokens.
    text_parts = [str(research.get("thesis") or "")]
    for row in (research.get("facts") or [])[:8]:
        text_parts.append(str(row.get("claim") or ""))
    corpus = " ".join(text_parts)
    entities = re.findall(r"\b(?:[A-Z][A-Za-z0-9&.-]+(?:\s+[A-Z][A-Za-z0-9&.-]+){0,2})\b", corpus)
    blocked = {"The", "This", "That", "United States"}
    for entity in entities:
        entity = entity.strip()
        if entity in blocked or entity.lower() == topic.lower() or is_logoish(entity):
            continue
        query = f"{topic} {entity}"
        if query.lower() not in {q.lower() for q in queries}:
            queries.insert(2, query)
        if len(queries) >= 12:
            break
    return queries[:12]


def wikimedia_candidates(query: str, limit: int = 24) -> list[dict[str, Any]]:
    params = {
        "action": "query",
        "generator": "search",
        "gsrsearch": f"{query} filetype:bitmap",
        "gsrnamespace": 6,
        "gsrlimit": min(limit, 50),
        "prop": "imageinfo",
        "iiprop": "url|size|extmetadata|mime",
        "format": "json",
        "formatversion": 2,
        "origin": "*",
    }
    response = SESSION.get("https://commons.wikimedia.org/w/api.php", params=params, timeout=25)
    response.raise_for_status()
    pages = (response.json().get("query") or {}).get("pages") or []
    out: list[dict[str, Any]] = []
    for page in pages:
        info = (page.get("imageinfo") or [{}])[0]
        meta = info.get("extmetadata") or {}
        title = str(page.get("title") or "").removeprefix("File:")
        license_name = str((meta.get("LicenseShortName") or {}).get("value") or "")
        if is_logoish(title) or not license_allowed(license_name):
            continue
        if str(info.get("mime") or "") not in {"image/jpeg", "image/png", "image/webp"}:
            continue
        width = int(info.get("width") or 0)
        height = int(info.get("height") or 0)
        if width < 640 or height < 360:
            continue
        out.append({
            "source": "wikimedia_commons",
            "title": title,
            "url": str(info.get("url") or ""),
            "landing_url": str(info.get("descriptionurl") or ""),
            "creator": re.sub(r"<[^>]+>", "", str((meta.get("Artist") or {}).get("value") or ""))[:300],
            "license": license_name,
            "width": width,
            "height": height,
            "query": query,
        })
    return out


def openverse_candidates(query: str, limit: int = 20) -> list[dict[str, Any]]:
    try:
        response = SESSION.get(
            "https://api.openverse.org/v1/images/",
            params={"q": query, "page_size": min(limit, 20), "license": "cc0,pdm,by,by-sa", "mature": "false"},
            timeout=25,
        )
        if response.status_code >= 400:
            return []
        data = response.json()
    except Exception:
        return []
    out: list[dict[str, Any]] = []
    for item in data.get("results") or []:
        title = str(item.get("title") or "")
        if is_logoish(title):
            continue
        width = int(item.get("width") or 0)
        height = int(item.get("height") or 0)
        if width and height and (width < 640 or height < 360):
            continue
        url = str(item.get("url") or item.get("thumbnail") or "")
        if not url:
            continue
        license_name = " ".join(
            value for value in [str(item.get("license") or "").upper(), str(item.get("license_version") or "")] if value
        ).strip()
        out.append({
            "source": "openverse",
            "title": title,
            "url": url,
            "fallback_url": str(item.get("thumbnail") or ""),
            "landing_url": str(item.get("foreign_landing_url") or ""),
            "creator": str(item.get("creator") or "")[:300],
            "license": license_name,
            "width": width,
            "height": height,
            "query": query,
        })
    return out


def candidate_score(candidate: dict[str, Any], query_index: int) -> float:
    width = max(int(candidate.get("width") or 1), 1)
    height = max(int(candidate.get("height") or 1), 1)
    aspect = width / height
    aspect_score = max(0.0, 18.0 - abs(aspect - 16 / 9) * 14.0)
    megapixels = (width * height) / 1_000_000
    resolution_score = min(12.0, math.log2(max(megapixels, 0.25) + 1) * 5.0)
    overlap = len(tokenize(str(candidate.get("query") or "")) & tokenize(str(candidate.get("title") or "")))
    relevance = min(20.0, overlap * 4.0)
    source_bonus = 4.0 if candidate.get("source") == "wikimedia_commons" else 2.0
    return aspect_score + resolution_score + relevance + source_bonus + max(0.0, 8.0 - query_index * 0.35)


def download_bytes(candidate: dict[str, Any]) -> bytes:
    last_error: Exception | None = None
    for url in [str(candidate.get("url") or ""), str(candidate.get("fallback_url") or "")]:
        if not url:
            continue
        try:
            response = SESSION.get(url, timeout=35)
            response.raise_for_status()
            content = response.content
            if not 10_000 <= len(content) <= 25_000_000:
                raise RuntimeError(f"unexpected image size {len(content)}")
            return content
        except Exception as exc:
            last_error = exc
    raise RuntimeError(f"image download failed: {last_error}")


def normalize_image(content: bytes, destination: Path) -> str:
    with Image.open(BytesIO(content)) as raw:
        raw.load()
        image = ImageOps.exif_transpose(raw).convert("RGB")
        if image.width < 640 or image.height < 360:
            raise RuntimeError("image too small after decode")
        normalized = ImageOps.fit(image, (1280, 720), method=Image.Resampling.LANCZOS, centering=(0.5, 0.5))
        destination.parent.mkdir(parents=True, exist_ok=True)
        normalized.save(destination, "JPEG", quality=89, optimize=True, progressive=True)
    return hashlib.sha256(destination.read_bytes()).hexdigest()


def cache_is_complete(manifest_path: Path, target: int) -> bool:
    if not manifest_path.exists():
        return False
    try:
        manifest = load_json(manifest_path)
    except Exception:
        return False
    assets = manifest.get("assets") or []
    if len(assets) < target:
        return False
    return all(
        (ROOT / str(item.get("local_path") or "")).is_file()
        and (ROOT / str(item.get("local_path") or "")).stat().st_size >= 10_000
        for item in assets[:target]
    )


def collect(topic_id: str, research_path: Path, target: int) -> dict[str, Any]:
    research = load_json(research_path)
    topic = str(research.get("topic") or topic_id).strip()
    cache_dir = CACHE_ROOT / topic_id
    manifest_path = cache_dir / "visual-assets.json"
    if cache_is_complete(manifest_path, target):
        manifest = load_json(manifest_path)
        manifest["cache_hit"] = True
        return manifest

    queries = build_visual_queries(research, topic)
    candidates: list[dict[str, Any]] = []
    seen_urls: set[str] = set()
    seen_titles: set[str] = set()
    for idx, query in enumerate(queries):
        batch: list[dict[str, Any]] = []
        try:
            batch.extend(wikimedia_candidates(query))
        except Exception as exc:
            print(f"Wikimedia query failed for {query!r}: {exc}")
        batch.extend(openverse_candidates(query))
        for candidate in batch:
            url = str(candidate.get("url") or "")
            title_key = str(candidate.get("title") or "").strip().lower()
            if not url or url in seen_urls or (title_key and title_key in seen_titles):
                continue
            candidate["score"] = candidate_score(candidate, idx)
            candidates.append(candidate)
            seen_urls.add(url)
            if title_key:
                seen_titles.add(title_key)
        time.sleep(0.1)

    candidates.sort(key=lambda c: float(c.get("score") or 0), reverse=True)
    images_dir = cache_dir / "images"
    images_dir.mkdir(parents=True, exist_ok=True)
    selected: list[dict[str, Any]] = []
    query_counts: dict[str, int] = {}
    digests: set[str] = set()
    attempted: set[str] = set()

    for per_query_limit in (MAX_PER_QUERY, 999):
        for candidate in candidates:
            if len(selected) >= target:
                break
            url = str(candidate.get("url") or "")
            query = str(candidate.get("query") or "")
            if url in attempted or query_counts.get(query, 0) >= per_query_limit:
                continue
            attempted.add(url)
            try:
                content = download_bytes(candidate)
                destination = images_dir / f"image_{len(selected)+1:03d}.jpg"
                digest = normalize_image(content, destination)
                if digest in digests:
                    destination.unlink(missing_ok=True)
                    continue
                digests.add(digest)
                query_counts[query] = query_counts.get(query, 0) + 1
                selected.append({
                    "asset_id": f"visual-{topic_id}-{len(selected)+1:03d}",
                    "type": "image",
                    "local_path": destination.relative_to(ROOT).as_posix(),
                    "width": 1280,
                    "height": 720,
                    "title": candidate.get("title"),
                    "query": query,
                    "source": candidate.get("source"),
                    "source_url": candidate.get("landing_url") or candidate.get("url"),
                    "creator": candidate.get("creator"),
                    "license": candidate.get("license"),
                    "sha256": digest,
                    "score": round(float(candidate.get("score") or 0), 3),
                })
            except Exception as exc:
                print(f"Skipping visual candidate {candidate.get('title')!r}: {exc}")
        if len(selected) >= target:
            break

    manifest = {
        "topic_id": topic_id,
        "topic": topic,
        "target_images": target,
        "image_count": len(selected),
        "normalized_format": "1280x720 JPEG (16:9)",
        "logos_excluded": True,
        "search_queries": queries,
        "assets": selected,
        "collected_at": datetime.now(timezone.utc).isoformat(),
        "anthropic_calls_for_visual_collection": 0,
        "cache_hit": False,
    }
    cache_dir.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    if len(selected) < MIN_IMAGES:
        raise RuntimeError(
            f"Visual research found only {len(selected)} usable licensed images; minimum is {MIN_IMAGES}. "
            "Downloaded work is cached and no new Anthropic call is required on retry."
        )
    if len(selected) < target:
        print(f"WARNING: collected {len(selected)} of target {target}; continuing above minimum {MIN_IMAGES}.")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--topic-id", required=True)
    parser.add_argument("--research", type=Path, default=None)
    parser.add_argument("--target", type=int, default=TARGET_IMAGES)
    args = parser.parse_args()
    research_path = args.research or (RESEARCH_ROOT / args.topic_id / "research.json")
    if not research_path.exists():
        raise RuntimeError(f"Missing research brief: {research_path}")
    manifest = collect(args.topic_id, research_path, max(1, args.target))
    print(json.dumps({
        "topic_id": args.topic_id,
        "image_count": manifest.get("image_count"),
        "target_images": manifest.get("target_images"),
        "cache_hit": manifest.get("cache_hit"),
        "manifest": str(CACHE_ROOT / args.topic_id / "visual-assets.json"),
    }, indent=2))


if __name__ == "__main__":
    main()
