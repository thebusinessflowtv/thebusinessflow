from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import time
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
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
MIN_SOURCE_WIDTH = int(os.getenv("VISUAL_MIN_SOURCE_WIDTH", "1920"))
MIN_SOURCE_HEIGHT = int(os.getenv("VISUAL_MIN_SOURCE_HEIGHT", "1080"))
OUTPUT_WIDTH = 3840
OUTPUT_HEIGHT = 2160
USER_AGENT = "TheBusinessFlow/2.0 (editorial visual research; thebusinessflowtv@gmail.com)"
SESSION = requests.Session()
SESSION.headers.update({"User-Agent": USER_AGENT, "Accept": "image/avif,image/webp,image/*,*/*;q=0.8"})
TOKEN_RE = re.compile(r"[a-z0-9]+")
LOGO_WORDS = {"logo", "logos", "wordmark", "logotype", "icon", "emblem", "brandmark", "trademark", "svg", "vector"}
ANIMAL_WORDS = {"dog", "dogs", "puppy", "cat", "cats", "kitten", "animal", "animals", "pet", "pets", "horse", "bird"}
ALLOWED_LICENSE_FRAGMENTS = ("public domain", "cc0", "cc by", "cc-by", "cc by-sa", "cc-by-sa", "pdm")

SUBJECT_PROFILES: dict[str, dict[str, Any]] = {
    "tesla": {
        "queries": [
            "Tesla Model 3 car",
            "Tesla Model Y car",
            "Tesla Model S car",
            "Tesla Model X car",
            "Tesla Cybertruck",
            "Tesla Roadster",
            "Tesla Supercharger charging station",
            "Tesla Gigafactory factory",
            "Tesla Fremont Factory",
            "Tesla Gigafactory Texas Austin",
            "Tesla Gigafactory Berlin",
            "Tesla showroom dealership",
            "Tesla vehicle interior touchscreen",
            "Tesla Energy Megapack Powerwall",
            "Elon Musk Tesla event",
        ],
        "allow_terms": {
            "tesla", "model 3", "model y", "model s", "model x", "cybertruck", "roadster",
            "supercharger", "gigafactory", "fremont", "giga texas", "megapack", "powerwall", "elon musk",
        },
        "block_terms": {"nikola tesla", "tesla coil", "tesla museum", "tesla monument", "tesla statue", "inventor"},
    }
}


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def tokenize(text: str) -> set[str]:
    return set(TOKEN_RE.findall(text.lower()))


def license_allowed(value: str) -> bool:
    low = value.lower().strip()
    return any(fragment in low for fragment in ALLOWED_LICENSE_FRAGMENTS)


def text_blocked(text: str, topic: str) -> bool:
    low = text.lower()
    tokens = tokenize(low)
    if tokens & LOGO_WORDS or tokens & ANIMAL_WORDS:
        return True
    profile = SUBJECT_PROFILES.get(topic.lower()) or {}
    return any(term in low for term in profile.get("block_terms", set()))


def strict_relevance(title: str, topic: str, query: str) -> bool:
    low = title.lower().strip()
    if not low or text_blocked(low, topic):
        return False
    profile = SUBJECT_PROFILES.get(topic.lower())
    if profile:
        if not any(term in low for term in profile.get("allow_terms", set())):
            return False
        # Tesla-specific safety: the famous inventor and unrelated items are rejected above.
        # The company name or a distinctive Tesla product/entity must be explicit in metadata.
        return True
    topic_tokens = tokenize(topic)
    title_tokens = tokenize(title)
    if not topic_tokens or not topic_tokens <= title_tokens:
        return False
    query_tokens = tokenize(query) - {"company", "business", "photo", "image", "headquarters", "factory"}
    return len(title_tokens & query_tokens) >= 1


def build_queries(research: dict[str, Any], topic: str) -> list[str]:
    profile = SUBJECT_PROFILES.get(topic.lower())
    if profile:
        return list(profile["queries"])
    queries = [
        f"{topic} headquarters",
        f"{topic} factory",
        f"{topic} products",
        f"{topic} offices",
        f"{topic} founder CEO",
        f"{topic} historical",
        f"{topic} facilities",
        f"{topic} operations",
    ]
    thesis = str(research.get("thesis") or "")
    entities = re.findall(r"\b(?:[A-Z][A-Za-z0-9&.-]+\s+){1,2}[A-Z][A-Za-z0-9&.-]+\b", thesis)
    for entity in entities[:4]:
        if topic.lower() not in entity.lower():
            queries.append(f"{topic} {entity}")
    return list(dict.fromkeys(queries))[:15]


def wikimedia_candidates(topic: str, query: str, limit: int = 50) -> list[dict[str, Any]]:
    params = {
        "action": "query",
        "generator": "search",
        "gsrsearch": f'"{topic}" {query[len(topic):].strip()} filetype:bitmap' if query.lower().startswith(topic.lower()) else query,
        "gsrnamespace": 6,
        "gsrlimit": min(limit, 50),
        "prop": "imageinfo",
        "iiprop": "url|size|extmetadata|mime",
        "iiurlwidth": OUTPUT_WIDTH,
        "format": "json",
        "formatversion": 2,
        "origin": "*",
    }
    response = SESSION.get("https://commons.wikimedia.org/w/api.php", params=params, timeout=30)
    response.raise_for_status()
    pages = (response.json().get("query") or {}).get("pages") or []
    out: list[dict[str, Any]] = []
    for page in pages:
        info = (page.get("imageinfo") or [{}])[0]
        meta = info.get("extmetadata") or {}
        title = str(page.get("title") or "").removeprefix("File:")
        license_name = str((meta.get("LicenseShortName") or {}).get("value") or "")
        source_width = int(info.get("width") or 0)
        source_height = int(info.get("height") or 0)
        if not strict_relevance(title, topic, query) or not license_allowed(license_name):
            continue
        if str(info.get("mime") or "") not in {"image/jpeg", "image/png", "image/webp"}:
            continue
        if source_width < MIN_SOURCE_WIDTH or source_height < MIN_SOURCE_HEIGHT:
            continue
        if source_width / max(source_height, 1) < 1.15:
            continue
        thumb_url = str(info.get("thumburl") or "")
        original_url = str(info.get("url") or "")
        if not thumb_url and not original_url:
            continue
        out.append({
            "source": "wikimedia_commons",
            "title": title,
            "url": thumb_url or original_url,
            "fallback_url": original_url if thumb_url else "",
            "landing_url": str(info.get("descriptionurl") or ""),
            "creator": re.sub(r"<[^>]+>", "", str((meta.get("Artist") or {}).get("value") or ""))[:300],
            "license": license_name,
            "source_width": source_width,
            "source_height": source_height,
            "download_width": int(info.get("thumbwidth") or source_width),
            "download_height": int(info.get("thumbheight") or source_height),
            "query": query,
        })
    return out


def openverse_candidates(topic: str, query: str, limit: int = 20) -> list[dict[str, Any]]:
    try:
        response = SESSION.get(
            "https://api.openverse.org/v1/images/",
            params={"q": query, "page_size": min(limit, 20), "license": "cc0,pdm,by,by-sa", "mature": "false"},
            timeout=30,
        )
        if response.status_code >= 400:
            return []
        data = response.json()
    except Exception:
        return []
    out: list[dict[str, Any]] = []
    for item in data.get("results") or []:
        title = str(item.get("title") or "")
        source_width = int(item.get("width") or 0)
        source_height = int(item.get("height") or 0)
        if not strict_relevance(title, topic, query):
            continue
        if source_width < MIN_SOURCE_WIDTH or source_height < MIN_SOURCE_HEIGHT:
            continue
        if source_width / max(source_height, 1) < 1.15:
            continue
        original = str(item.get("url") or "")
        if not original:
            continue
        license_name = " ".join(v for v in [str(item.get("license") or "").upper(), str(item.get("license_version") or "")] if v).strip()
        out.append({
            "source": "openverse",
            "title": title,
            "url": original,
            "fallback_url": "",
            "landing_url": str(item.get("foreign_landing_url") or ""),
            "creator": str(item.get("creator") or "")[:300],
            "license": license_name,
            "source_width": source_width,
            "source_height": source_height,
            "download_width": source_width,
            "download_height": source_height,
            "query": query,
        })
    return out


def google_cse_candidates(topic: str, query: str, limit: int = 10) -> list[dict[str, Any]]:
    """Optional Google Images discovery through the official Custom Search JSON API.

    It is intentionally disabled unless GOOGLE_CSE_API_KEY and GOOGLE_CSE_CX are provided.
    Results are only accepted when metadata indicates at least 1080p and the result is
    clearly about the target company. Licensing still has to be explicit; therefore
    Google-discovered images without reusable-rights metadata are not auto-ingested.
    """
    api_key = os.getenv("GOOGLE_CSE_API_KEY", "").strip()
    cx = os.getenv("GOOGLE_CSE_CX", "").strip()
    if not api_key or not cx:
        return []
    try:
        response = SESSION.get(
            "https://www.googleapis.com/customsearch/v1",
            params={"key": api_key, "cx": cx, "q": query, "searchType": "image", "num": min(limit, 10), "imgSize": "xxlarge", "safe": "active"},
            timeout=30,
        )
        response.raise_for_status()
        data = response.json()
    except Exception as exc:
        print(f"Google image discovery skipped for {query!r}: {exc}")
        return []
    # Discovery is logged but not downloaded automatically because Google indexes
    # third-party copyrighted images and does not itself grant reuse rights.
    for item in data.get("items") or []:
        title = str(item.get("title") or "")
        if strict_relevance(title, topic, query):
            print(f"Google discovery reference: {title} -> {item.get('image', {}).get('contextLink') or item.get('link')}")
    return []


def candidate_score(candidate: dict[str, Any], query_index: int, topic: str) -> float:
    width = max(int(candidate.get("source_width") or 1), 1)
    height = max(int(candidate.get("source_height") or 1), 1)
    aspect = width / height
    aspect_score = max(0.0, 20.0 - abs(aspect - 16 / 9) * 12.0)
    megapixels = (width * height) / 1_000_000
    resolution_score = min(30.0, math.log2(max(megapixels, 1.0)) * 6.0)
    four_k_bonus = 35.0 if width >= 3840 and height >= 2160 else 0.0
    title_tokens = tokenize(str(candidate.get("title") or ""))
    query_tokens = tokenize(str(candidate.get("query") or ""))
    relevance = min(28.0, len(title_tokens & query_tokens) * 5.0)
    company_bonus = 30.0 if tokenize(topic) <= title_tokens else 0.0
    source_bonus = 6.0 if candidate.get("source") == "wikimedia_commons" else 3.0
    return four_k_bonus + resolution_score + aspect_score + relevance + company_bonus + source_bonus + max(0.0, 6.0 - query_index * 0.2)


def retry_delay(response: requests.Response | None, attempt: int) -> float:
    if response is not None:
        raw = response.headers.get("Retry-After")
        if raw:
            try:
                return min(20.0, max(1.0, float(raw)))
            except ValueError:
                try:
                    dt = parsedate_to_datetime(raw)
                    return min(20.0, max(1.0, dt.timestamp() - time.time()))
                except Exception:
                    pass
    return min(10.0, 1.5 * (2 ** attempt))


def download_bytes(candidate: dict[str, Any]) -> bytes:
    last_error: Exception | None = None
    urls = [str(candidate.get("url") or ""), str(candidate.get("fallback_url") or "")]
    for url in [u for i, u in enumerate(urls) if u and u not in urls[:i]]:
        for attempt in range(3):
            response: requests.Response | None = None
            try:
                response = SESSION.get(url, timeout=60)
                if response.status_code == 429:
                    time.sleep(retry_delay(response, attempt))
                    continue
                response.raise_for_status()
                content = response.content
                if not 20_000 <= len(content) <= 35_000_000:
                    raise RuntimeError(f"unexpected image size {len(content)}")
                time.sleep(0.25)
                return content
            except Exception as exc:
                last_error = exc
                if attempt < 2:
                    time.sleep(retry_delay(response, attempt))
    raise RuntimeError(f"image download failed: {last_error}")


def normalize_image(content: bytes, destination: Path) -> tuple[str, int, int, bool]:
    with Image.open(BytesIO(content)) as raw:
        raw.load()
        image = ImageOps.exif_transpose(raw).convert("RGB")
        source_width, source_height = image.size
        if source_width < MIN_SOURCE_WIDTH or source_height < MIN_SOURCE_HEIGHT:
            raise RuntimeError(f"decoded source below 1080p minimum: {source_width}x{source_height}")
        if source_width / max(source_height, 1) < 1.15:
            raise RuntimeError("portrait/square source rejected for 16:9 documentary")
        is_native_4k = source_width >= 3840 and source_height >= 2160
        normalized = ImageOps.fit(image, (OUTPUT_WIDTH, OUTPUT_HEIGHT), method=Image.Resampling.LANCZOS, centering=(0.5, 0.5))
        destination.parent.mkdir(parents=True, exist_ok=True)
        normalized.save(destination, "JPEG", quality=95, optimize=True, progressive=True, subsampling=0)
    return hashlib.sha256(destination.read_bytes()).hexdigest(), source_width, source_height, is_native_4k


def valid_cached_assets(manifest_path: Path) -> list[dict[str, Any]]:
    if not manifest_path.exists():
        return []
    try:
        manifest = load_json(manifest_path)
    except Exception:
        return []
    valid: list[dict[str, Any]] = []
    for item in manifest.get("assets") or []:
        path = ROOT / str(item.get("local_path") or "")
        if not path.is_file() or path.stat().st_size < 20_000:
            continue
        if int(item.get("source_width") or 0) < MIN_SOURCE_WIDTH or int(item.get("source_height") or 0) < MIN_SOURCE_HEIGHT:
            continue
        if int(item.get("render_width") or 0) != OUTPUT_WIDTH or int(item.get("render_height") or 0) != OUTPUT_HEIGHT:
            continue
        valid.append(item)
    return valid


def write_manifest(path: Path, *, topic_id: str, topic: str, target: int, queries: list[str], assets: list[dict[str, Any]], partial: bool) -> dict[str, Any]:
    native_4k = sum(bool(a.get("native_4k")) for a in assets)
    manifest = {
        "profile_version": "hq-v2",
        "topic_id": topic_id,
        "topic": topic,
        "target_images": target,
        "image_count": len(assets),
        "native_4k_count": native_4k,
        "minimum_source_resolution": f"{MIN_SOURCE_WIDTH}x{MIN_SOURCE_HEIGHT}",
        "normalized_format": f"{OUTPUT_WIDTH}x{OUTPUT_HEIGHT} JPEG (16:9)",
        "logos_excluded": True,
        "off_topic_blocking": True,
        "search_queries": queries,
        "assets": assets,
        "collected_at": datetime.now(timezone.utc).isoformat(),
        "anthropic_calls_for_visual_collection": 0,
        "google_image_discovery_enabled": bool(os.getenv("GOOGLE_CSE_API_KEY") and os.getenv("GOOGLE_CSE_CX")),
        "cache_hit": False,
        "partial": partial,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest


def collect(topic_id: str, research_path: Path, target: int, force: bool = False) -> dict[str, Any]:
    research = load_json(research_path)
    topic = str(research.get("topic") or topic_id).strip()
    cache_dir = CACHE_ROOT / topic_id
    manifest_path = cache_dir / "visual-assets.json"
    if force and cache_dir.exists():
        import shutil
        shutil.rmtree(cache_dir)
    cached = valid_cached_assets(manifest_path)
    if len(cached) >= target:
        manifest = load_json(manifest_path)
        manifest["cache_hit"] = True
        return manifest

    queries = build_queries(research, topic)
    candidates: list[dict[str, Any]] = []
    seen_urls: set[str] = set()
    seen_titles: set[str] = set()
    for idx, query in enumerate(queries):
        batch: list[dict[str, Any]] = []
        try:
            batch.extend(wikimedia_candidates(topic, query))
        except Exception as exc:
            print(f"Wikimedia query failed for {query!r}: {exc}")
        batch.extend(openverse_candidates(topic, query))
        google_cse_candidates(topic, query)
        for candidate in batch:
            url = str(candidate.get("url") or "")
            title_key = str(candidate.get("title") or "").strip().lower()
            if not url or url in seen_urls or (title_key and title_key in seen_titles):
                continue
            candidate["score"] = candidate_score(candidate, idx, topic)
            candidates.append(candidate)
            seen_urls.add(url)
            if title_key:
                seen_titles.add(title_key)
        time.sleep(0.15)

    candidates.sort(key=lambda c: (int(c.get("source_width") or 0) >= 3840 and int(c.get("source_height") or 0) >= 2160, float(c.get("score") or 0)), reverse=True)
    images_dir = cache_dir / "images"
    images_dir.mkdir(parents=True, exist_ok=True)
    selected: list[dict[str, Any]] = valid_cached_assets(manifest_path)
    query_counts: dict[str, int] = {}
    digests: set[str] = {str(a.get("sha256")) for a in selected if a.get("sha256")}
    attempted: set[str] = {str(a.get("download_url")) for a in selected if a.get("download_url")}

    for per_query_limit in (MAX_PER_QUERY, 999):
        for candidate in candidates:
            if len(selected) >= target:
                break
            query = str(candidate.get("query") or "")
            url = str(candidate.get("url") or "")
            if not url or url in attempted or query_counts.get(query, 0) >= per_query_limit:
                continue
            attempted.add(url)
            try:
                content = download_bytes(candidate)
                destination = images_dir / f"image_{len(selected)+1:03d}.jpg"
                digest, source_width, source_height, native_4k = normalize_image(content, destination)
                if digest in digests:
                    destination.unlink(missing_ok=True)
                    continue
                digests.add(digest)
                query_counts[query] = query_counts.get(query, 0) + 1
                selected.append({
                    "asset_id": f"visual-{topic_id}-{len(selected)+1:03d}",
                    "type": "image",
                    "local_path": destination.relative_to(ROOT).as_posix(),
                    # Compatibility fields retained for the existing workflow verifier.
                    "width": 1280,
                    "height": 720,
                    "render_width": OUTPUT_WIDTH,
                    "render_height": OUTPUT_HEIGHT,
                    "source_width": source_width,
                    "source_height": source_height,
                    "native_4k": native_4k,
                    "quality_tier": "native_4k" if native_4k else "1080p_plus_fallback",
                    "title": candidate.get("title"),
                    "query": query,
                    "source": candidate.get("source"),
                    "source_url": candidate.get("landing_url") or candidate.get("url"),
                    "download_url": url,
                    "creator": candidate.get("creator"),
                    "license": candidate.get("license"),
                    "sha256": digest,
                    "score": round(float(candidate.get("score") or 0), 3),
                })
                write_manifest(manifest_path, topic_id=topic_id, topic=topic, target=target, queries=queries, assets=selected, partial=len(selected) < target)
            except Exception as exc:
                print(f"Skipping visual candidate {candidate.get('title')!r}: {exc}")
        if len(selected) >= target:
            break

    manifest = write_manifest(manifest_path, topic_id=topic_id, topic=topic, target=target, queries=queries, assets=selected, partial=len(selected) < target)
    if len(selected) < MIN_IMAGES:
        raise RuntimeError(f"HQ visual research found only {len(selected)} usable images; minimum is {MIN_IMAGES}. No source below 1080p is accepted.")
    if len(selected) < target:
        print(f"WARNING: collected {len(selected)} of target {target}; continuing above minimum {MIN_IMAGES}.")
    print(f"HQ visuals: {len(selected)} images, {manifest['native_4k_count']} native-4K, all sources >= {MIN_SOURCE_WIDTH}x{MIN_SOURCE_HEIGHT}")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--topic-id", required=True)
    parser.add_argument("--research", type=Path, default=None)
    parser.add_argument("--target", type=int, default=TARGET_IMAGES)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    research_path = args.research or (RESEARCH_ROOT / args.topic_id / "research.json")
    if not research_path.exists():
        raise RuntimeError(f"Missing research brief: {research_path}")
    manifest = collect(args.topic_id, research_path, max(1, args.target), force=args.force)
    print(json.dumps({
        "topic_id": args.topic_id,
        "image_count": manifest.get("image_count"),
        "native_4k_count": manifest.get("native_4k_count"),
        "minimum_source_resolution": manifest.get("minimum_source_resolution"),
        "cache_hit": manifest.get("cache_hit"),
        "manifest": str(CACHE_ROOT / args.topic_id / "visual-assets.json"),
    }, indent=2))


if __name__ == "__main__":
    main()
