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
USER_AGENT = "TheBusinessFlow/1.1 (editorial visual research; thebusinessflowtv@gmail.com)"
SESSION = requests.Session()
SESSION.headers.update({"User-Agent": USER_AGENT, "Accept": "image/avif,image/webp,image/*,*/*;q=0.8"})
TOKEN_RE = re.compile(r"[a-z0-9]+")
LOGO_WORDS = {"logo", "logos", "wordmark", "logotype", "icon", "emblem", "brandmark", "trademark"}
ALLOWED_LICENSE_FRAGMENTS = ("public domain", "cc0", "cc by", "cc-by", "cc by-sa", "cc-by-sa", "pdm")
GENERIC_VISUAL_WORDS = {
    "headquarters", "office", "offices", "founder", "ceo", "historical", "history", "products", "product",
    "services", "customers", "customer", "factory", "warehouse", "operations", "employees", "workplace",
    "technology", "infrastructure", "company", "photos", "photo", "stores", "store", "facilities", "facility",
    "delivery", "logistics", "vehicles", "vehicle", "business", "executives", "executive", "event", "buildings",
    "building", "manufacturing", "people", "portrait", "campus", "network", "software", "energy", "electric",
    "automotive", "retail", "cloud", "advertising", "corporate", "service", "operations", "the", "and", "of",
}


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def tokenize(text: str) -> set[str]:
    return set(TOKEN_RE.findall(text.lower()))


def is_logoish(text: str) -> bool:
    return bool(tokenize(text) & LOGO_WORDS)


def license_allowed(value: str) -> bool:
    low = value.lower().strip()
    return any(fragment in low for fragment in ALLOWED_LICENSE_FRAGMENTS)


def proper_entities(research: dict[str, Any], topic: str) -> list[str]:
    text_parts = [str(research.get("thesis") or "")]
    for row in (research.get("facts") or [])[:10]:
        text_parts.append(str(row.get("claim") or ""))
    corpus = " ".join(text_parts)
    # Multiword proper nouns are much safer than arbitrary sentence-initial capitals.
    raw = re.findall(r"\b(?:[A-Z][A-Za-z0-9&.-]+\s+){1,2}[A-Z][A-Za-z0-9&.-]+\b", corpus)
    blocked = {"United States", "The Business", "This Tesla", "Tesla Tesla"}
    entities: list[str] = []
    for entity in raw:
        entity = entity.strip(" .,-")
        if entity in blocked or entity.lower() == topic.lower() or is_logoish(entity):
            continue
        words = tokenize(entity)
        if not words or words <= GENERIC_VISUAL_WORDS:
            continue
        if entity.lower() not in {e.lower() for e in entities}:
            entities.append(entity)
        if len(entities) >= 5:
            break
    return entities


def build_visual_queries(research: dict[str, Any], topic: str) -> list[dict[str, Any]]:
    """Build focused visual query groups from the already-paid Haiku factual brief.

    No extra model call occurs here. Each query carries strong relevance tokens so
    loose image-search results cannot enter the documentary simply because they are
    attractive stock imagery.
    """
    topic_tokens = tokenize(topic)
    specs: list[dict[str, Any]] = []
    suffixes = [
        "headquarters offices",
        "factory manufacturing",
        "products customers",
        "employees workplace",
        "technology infrastructure",
        "historical company",
        "facilities buildings",
        "vehicles operations",
    ]
    for suffix in suffixes:
        specs.append({"query": f"{topic} {suffix}", "required_tokens": sorted(topic_tokens)})

    for entity in proper_entities(research, topic):
        entity_tokens = tokenize(entity) - GENERIC_VISUAL_WORDS
        specs.insert(1, {
            "query": f"{topic} {entity}",
            "required_tokens": sorted(topic_tokens | entity_tokens),
            "entity_tokens": sorted(entity_tokens),
        })
        if len(specs) >= 12:
            break

    # Add a broad but exact-company query as final coverage source.
    specs.append({"query": f"{topic} company", "required_tokens": sorted(topic_tokens)})
    deduped: list[dict[str, Any]] = []
    seen: set[str] = set()
    for spec in specs:
        key = spec["query"].lower()
        if key not in seen:
            deduped.append(spec)
            seen.add(key)
    return deduped[:12]


def title_is_relevant(title: str, topic: str, spec: dict[str, Any]) -> bool:
    title_tokens = tokenize(title)
    topic_tokens = tokenize(topic)
    if topic_tokens and topic_tokens <= title_tokens:
        return True
    entity_tokens = set(spec.get("entity_tokens") or [])
    # Entity query may accept a visual without the company name, e.g. "Elon Musk...",
    # but only when the title directly names the distinctive researched entity.
    if entity_tokens and len(title_tokens & entity_tokens) >= min(2, len(entity_tokens)):
        return True
    return False


def wikimedia_candidates(topic: str, spec: dict[str, Any], limit: int = 30) -> list[dict[str, Any]]:
    query = str(spec["query"])
    # Quote the company name to keep Commons search anchored to the subject.
    remainder = query[len(topic):].strip() if query.lower().startswith(topic.lower()) else query
    search_text = f'"{topic}" {remainder} filetype:bitmap'.strip()
    params = {
        "action": "query",
        "generator": "search",
        "gsrsearch": search_text,
        "gsrnamespace": 6,
        "gsrlimit": min(limit, 50),
        "prop": "imageinfo",
        "iiprop": "url|size|extmetadata|mime",
        "iiurlwidth": 1280,
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
        if is_logoish(title) or not title_is_relevant(title, topic, spec) or not license_allowed(license_name):
            continue
        if str(info.get("mime") or "") not in {"image/jpeg", "image/png", "image/webp"}:
            continue
        width = int(info.get("width") or 0)
        height = int(info.get("height") or 0)
        if width < 640 or height < 360:
            continue
        # Prefer Wikimedia's server-generated 1280px thumbnail. This dramatically
        # reduces transfer size and avoids hammering original multi-megapixel files.
        thumb_url = str(info.get("thumburl") or "")
        original_url = str(info.get("url") or "")
        out.append({
            "source": "wikimedia_commons",
            "title": title,
            "url": thumb_url or original_url,
            "fallback_url": original_url if thumb_url else "",
            "landing_url": str(info.get("descriptionurl") or ""),
            "creator": re.sub(r"<[^>]+>", "", str((meta.get("Artist") or {}).get("value") or ""))[:300],
            "license": license_name,
            "width": int(info.get("thumbwidth") or width),
            "height": int(info.get("thumbheight") or height),
            "query": query,
            "required_tokens": spec.get("required_tokens") or [],
        })
    return out


def openverse_candidates(topic: str, spec: dict[str, Any], limit: int = 20) -> list[dict[str, Any]]:
    query = str(spec["query"])
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
        if is_logoish(title) or not title_is_relevant(title, topic, spec):
            continue
        width = int(item.get("width") or 0)
        height = int(item.get("height") or 0)
        if width and height and (width < 640 or height < 360):
            continue
        thumbnail = str(item.get("thumbnail") or "")
        original = str(item.get("url") or "")
        if not thumbnail and not original:
            continue
        license_name = " ".join(
            value for value in [str(item.get("license") or "").upper(), str(item.get("license_version") or "")] if value
        ).strip()
        out.append({
            "source": "openverse",
            "title": title,
            "url": thumbnail or original,
            "fallback_url": original if thumbnail else "",
            "landing_url": str(item.get("foreign_landing_url") or ""),
            "creator": str(item.get("creator") or "")[:300],
            "license": license_name,
            "width": width,
            "height": height,
            "query": query,
            "required_tokens": spec.get("required_tokens") or [],
        })
    return out


def candidate_score(candidate: dict[str, Any], query_index: int, topic: str) -> float:
    width = max(int(candidate.get("width") or 1), 1)
    height = max(int(candidate.get("height") or 1), 1)
    aspect = width / height
    aspect_score = max(0.0, 18.0 - abs(aspect - 16 / 9) * 14.0)
    megapixels = (width * height) / 1_000_000
    resolution_score = min(12.0, math.log2(max(megapixels, 0.25) + 1) * 5.0)
    title_tokens = tokenize(str(candidate.get("title") or ""))
    query_tokens = tokenize(str(candidate.get("query") or ""))
    overlap = len(query_tokens & title_tokens)
    relevance = min(24.0, overlap * 4.0)
    company_bonus = 22.0 if tokenize(topic) <= title_tokens else 0.0
    source_bonus = 4.0 if candidate.get("source") == "wikimedia_commons" else 2.0
    return aspect_score + resolution_score + relevance + company_bonus + source_bonus + max(0.0, 8.0 - query_index * 0.35)


def retry_delay(response: requests.Response | None, attempt: int) -> float:
    if response is not None:
        raw = response.headers.get("Retry-After")
        if raw:
            try:
                return min(15.0, max(1.0, float(raw)))
            except ValueError:
                try:
                    dt = parsedate_to_datetime(raw)
                    return min(15.0, max(1.0, dt.timestamp() - time.time()))
                except Exception:
                    pass
    return min(8.0, 1.5 * (2 ** attempt))


def download_bytes(candidate: dict[str, Any]) -> bytes:
    last_error: Exception | None = None
    urls = [str(candidate.get("url") or ""), str(candidate.get("fallback_url") or "")]
    for url in [u for i, u in enumerate(urls) if u and u not in urls[:i]]:
        for attempt in range(3):
            response: requests.Response | None = None
            try:
                response = SESSION.get(url, timeout=40)
                if response.status_code == 429:
                    delay = retry_delay(response, attempt)
                    print(f"Rate limited by {candidate.get('source')}; waiting {delay:.1f}s before retry")
                    time.sleep(delay)
                    continue
                response.raise_for_status()
                content = response.content
                if not 10_000 <= len(content) <= 25_000_000:
                    raise RuntimeError(f"unexpected image size {len(content)}")
                # Be deliberately polite to public media services. 50 images still
                # complete quickly, while avoiding the burst that caused 429s.
                time.sleep(0.35 if candidate.get("source") == "wikimedia_commons" else 0.20)
                return content
            except Exception as exc:
                last_error = exc
                if attempt < 2:
                    time.sleep(retry_delay(response, attempt))
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
        if path.is_file() and path.stat().st_size >= 10_000:
            valid.append(item)
    return valid


def cache_is_complete(manifest_path: Path, target: int) -> bool:
    return len(valid_cached_assets(manifest_path)) >= target


def collect(topic_id: str, research_path: Path, target: int) -> dict[str, Any]:
    research = load_json(research_path)
    topic = str(research.get("topic") or topic_id).strip()
    cache_dir = CACHE_ROOT / topic_id
    manifest_path = cache_dir / "visual-assets.json"
    if cache_is_complete(manifest_path, target):
        manifest = load_json(manifest_path)
        manifest["cache_hit"] = True
        return manifest

    query_specs = build_visual_queries(research, topic)
    candidates: list[dict[str, Any]] = []
    seen_urls: set[str] = set()
    seen_titles: set[str] = set()
    for idx, spec in enumerate(query_specs):
        batch: list[dict[str, Any]] = []
        try:
            batch.extend(wikimedia_candidates(topic, spec))
        except Exception as exc:
            print(f"Wikimedia query failed for {spec['query']!r}: {exc}")
        batch.extend(openverse_candidates(topic, spec))
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
        time.sleep(0.20)

    candidates.sort(key=lambda c: float(c.get("score") or 0), reverse=True)
    images_dir = cache_dir / "images"
    images_dir.mkdir(parents=True, exist_ok=True)

    # Continue from a partial Actions cache instead of starting over after a network
    # failure. Existing files keep their IDs and are never downloaded again.
    selected: list[dict[str, Any]] = valid_cached_assets(manifest_path)
    query_counts: dict[str, int] = {}
    digests: set[str] = set()
    attempted: set[str] = set()
    existing_source_urls: set[str] = set()
    for item in selected:
        query = str(item.get("query") or "")
        query_counts[query] = query_counts.get(query, 0) + 1
        if item.get("sha256"):
            digests.add(str(item["sha256"]))
        if item.get("download_url"):
            attempted.add(str(item["download_url"]))
        if item.get("source_url"):
            existing_source_urls.add(str(item["source_url"]))

    for per_query_limit in (MAX_PER_QUERY, 999):
        for candidate in candidates:
            if len(selected) >= target:
                break
            url = str(candidate.get("url") or "")
            query = str(candidate.get("query") or "")
            landing = str(candidate.get("landing_url") or candidate.get("url") or "")
            if url in attempted or landing in existing_source_urls or query_counts.get(query, 0) >= per_query_limit:
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
                existing_source_urls.add(landing)
                selected.append({
                    "asset_id": f"visual-{topic_id}-{len(selected)+1:03d}",
                    "type": "image",
                    "local_path": destination.relative_to(ROOT).as_posix(),
                    "width": 1280,
                    "height": 720,
                    "title": candidate.get("title"),
                    "query": query,
                    "source": candidate.get("source"),
                    "source_url": landing,
                    "download_url": url,
                    "creator": candidate.get("creator"),
                    "license": candidate.get("license"),
                    "sha256": digest,
                    "score": round(float(candidate.get("score") or 0), 3),
                })
                # Persist after every successful image. A killed runner or later
                # exception still leaves an exact resumable manifest for cache save.
                partial = {
                    "topic_id": topic_id,
                    "topic": topic,
                    "target_images": target,
                    "image_count": len(selected),
                    "normalized_format": "1280x720 JPEG (16:9)",
                    "logos_excluded": True,
                    "search_queries": [s["query"] for s in query_specs],
                    "assets": selected,
                    "collected_at": datetime.now(timezone.utc).isoformat(),
                    "anthropic_calls_for_visual_collection": 0,
                    "cache_hit": False,
                    "partial": len(selected) < target,
                }
                cache_dir.mkdir(parents=True, exist_ok=True)
                manifest_path.write_text(json.dumps(partial, ensure_ascii=False, indent=2), encoding="utf-8")
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
        "search_queries": [s["query"] for s in query_specs],
        "assets": selected,
        "collected_at": datetime.now(timezone.utc).isoformat(),
        "anthropic_calls_for_visual_collection": 0,
        "cache_hit": False,
        "partial": len(selected) < target,
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
