from __future__ import annotations

import html
import os
import re
from datetime import datetime, timezone
from urllib.parse import urljoin, urlsplit

import requests

_INSTALLED = False
_OFFICIAL: list[dict] = []
_OFFICIAL_EMITTED = False

BAD_RE = re.compile(
    r"(?:logo|icon|avatar|sprite|favicon|badge|emoji|placeholder|spacer|tracking|pixel|"
    r"thumbnail|thumb-|1x1|social-share|qr-code|chart|diagram|infographic)",
    re.I,
)
IMG_EXT_RE = re.compile(r"\.(?:jpe?g|png|webp)(?:$|[?#])", re.I)
META_RE = re.compile(
    r'<meta[^>]+(?:property|name)=["\'](?:og:image(?::secure_url)?|twitter:image)["\'][^>]+content=["\']([^"\']+)["\']',
    re.I,
)
META_REV_RE = re.compile(
    r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+(?:property|name)=["\'](?:og:image(?::secure_url)?|twitter:image)["\']',
    re.I,
)
IMG_TAG_RE = re.compile(r"<img\b[^>]*>", re.I)
ATTR_RE = re.compile(r'([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*["\']([^"\']*)["\']')
TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.I | re.S)
YEAR_RE = re.compile(r"\b(20\d{2})\b")

BRANDS = {
    "apple": {
        "domains": ("apple.com",),
        "queries": (
            "Apple Park Cupertino headquarters",
            "Apple Park office interior",
            "Apple Park aerial",
            "Apple keynote event stage",
            "Apple Store interior",
            "Apple iPhone assembly Foxconn factory",
            "iPhone manufacturing assembly line",
        ),
    },
    "meta": {
        "domains": ("about.fb.com", "meta.com", "investor.atmeta.com"),
        "queries": (
            "Meta headquarters Menlo Park",
            "Meta Connect event",
            "Meta Reality Labs office",
            "Meta VR Glasses official",
            "Meta Quest headset official",
        ),
    },
    "nvidia": {
        "domains": ("nvidia.com",),
        "queries": (
            "NVIDIA headquarters Santa Clara",
            "Jensen Huang NVIDIA GTC",
            "NVIDIA Blackwell GPU",
            "NVIDIA DGX server",
            "NVIDIA data center GPU",
        ),
    },
    "amazon": {
        "domains": ("aboutamazon.com", "amazon.com"),
        "queries": (
            "Amazon headquarters Seattle",
            "Amazon fulfillment center",
            "Amazon warehouse robotics",
            "Amazon delivery van Rivian",
            "Amazon logistics delivery station",
        ),
    },
    "google": {
        "domains": ("blog.google", "about.google", "google.com"),
        "queries": (
            "Googleplex Mountain View",
            "Google office interior",
            "Google data center",
            "Sundar Pichai Google event",
        ),
    },
    "microsoft": {
        "domains": ("news.microsoft.com", "microsoft.com"),
        "queries": (
            "Microsoft Redmond campus",
            "Microsoft office interior",
            "Microsoft data center",
            "Satya Nadella Microsoft event",
        ),
    },
    "tesla": {
        "domains": ("tesla.com",),
        "queries": (
            "Tesla Gigafactory Texas",
            "Tesla Fremont Factory",
            "Tesla Model Y production line",
            "Tesla Supercharger station",
        ),
    },
}

PRODUCT_RES = (
    re.compile(r"\biPhone\s+\d+(?:\s+(?:Pro|Pro Max|Plus|Air|Max))*\b", re.I),
    re.compile(r"\bApple\s+Watch(?:\s+Ultra)?(?:\s+\d+)?\b", re.I),
    re.compile(r"\bAirPods(?:\s+Pro)?(?:\s+\d+)?\b", re.I),
    re.compile(r"\bVision\s+Pro\b", re.I),
    re.compile(r"\bMacBook\s+(?:Air|Pro)(?:\s+\w+)?\b", re.I),
    re.compile(r"\bMeta\s+VR\s+Glasses\b", re.I),
    re.compile(r"\bMeta\s+Quest(?:\s+\d+|\s+Pro)?\b", re.I),
    re.compile(r"\bRay-Ban\s+Meta\b", re.I),
    re.compile(r"\bBlackwell\b", re.I),
    re.compile(r"\bGeForce\s+RTX\s+\d+\b", re.I),
    re.compile(r"\bDGX\b", re.I),
)
GENERIC = {
    "company", "business", "technology", "tech", "office", "factory", "products",
    "headquarters", "corporate", "industry", "operations", "facility", "facilities",
}


def _tokens(value: str) -> set[str]:
    return set(re.findall(r"[a-z0-9]+", str(value).lower()))


def _domain(url: str) -> str:
    try:
        return urlsplit(url).netloc.lower().removeprefix("www.")
    except Exception:
        return ""


def _brand(topic: str) -> str | None:
    low = topic.lower()
    for name in BRANDS:
        if name in low:
            return name
    if any(x in low for x in ("iphone", "macbook", "airpods", "apple watch", "vision pro")):
        return "apple"
    if any(x in low for x in ("quest", "vr glasses", "reality labs")):
        return "meta"
    if any(x in low for x in ("geforce", "blackwell", "jensen huang", "dgx")):
        return "nvidia"
    return None


def _products(research: dict, topic: str) -> list[str]:
    parts = [topic, str(research.get("thesis") or "")]
    parts += [str(x.get("claim") or "") for x in research.get("facts") or []]
    parts += [str(x.get("event") or "") for x in research.get("timeline") or []]
    blob = "\n".join(parts)
    out, seen = [], set()
    for pattern in PRODUCT_RES:
        for match in pattern.finditer(blob):
            value = re.sub(r"\s+", " ", match.group(0)).strip()
            if value.lower() not in seen:
                seen.add(value.lower())
                out.append(value)
    return out[:10]


def _official_urls(research: dict) -> list[tuple[str, str]]:
    out, seen = [], set()
    for source in research.get("sources") or []:
        url = str(source.get("url") or "").strip()
        kind = str(source.get("source_type") or "").lower()
        if url and url not in seen and kind in {"official", "investor_relations"}:
            seen.add(url)
            out.append((url, kind))
    for fact in research.get("facts") or []:
        url = str(fact.get("source_url") or "").strip()
        domain = _domain(url)
        if url and url not in seen and any(
            domain == d or domain.endswith("." + d)
            for cfg in BRANDS.values() for d in cfg["domains"]
        ):
            seen.add(url)
            out.append((url, "official"))
    return out[:8]


def _best_srcset(value: str, base: str) -> tuple[str, int]:
    best, best_w = "", 0
    for part in value.split(","):
        bits = part.strip().split()
        if not bits:
            continue
        width = 0
        if len(bits) > 1 and bits[1].endswith("w"):
            try:
                width = int(bits[1][:-1])
            except ValueError:
                pass
        if width >= best_w:
            best, best_w = urljoin(base, html.unescape(bits[0])), width
    return best, best_w


def _page_images(page_url: str, topic: str, kind: str, limit: int = 24) -> list[dict]:
    try:
        r = requests.get(
            page_url, timeout=25,
            headers={"User-Agent": "TheBusinessFlow/2.1 editorial visual research"},
        )
        r.raise_for_status()
        if "html" not in r.headers.get("content-type", "").lower():
            return []
        body = r.text
    except Exception as exc:
        print(f"Official source skipped {page_url!r}: {exc}")
        return []

    title_match = TITLE_RE.search(body)
    page_title = html.unescape(re.sub(r"\s+", " ", title_match.group(1)).strip()) if title_match else topic
    out, seen = [], set()

    def add(raw: str, alt: str = "", width: int = 0, height: int = 0) -> None:
        if len(out) >= limit:
            return
        url = urljoin(page_url, html.unescape(str(raw).strip()))
        low = url.lower()
        if not url.startswith(("http://", "https://")) or url in seen:
            return
        if BAD_RE.search(low) or low.endswith((".svg", ".gif")):
            return
        if not IMG_EXT_RE.search(low) and "image" not in low and "cdn" not in low:
            return
        seen.add(url)
        label = re.sub(r"\s+", " ", html.unescape(alt or "")).strip()
        out.append({
            "source": "official_page",
            "title": (label if len(label) >= 5 else page_title)[:300],
            "url": url,
            "fallback_url": "",
            "landing_url": page_url,
            "creator": _domain(page_url),
            "license": "official_source_review_required",
            "rights_review_required": True,
            "source_width": width or 1920,
            "source_height": height or 1080,
            "download_width": width or 1920,
            "download_height": height or 1080,
            "query": f"{topic} official source",
            "source_domain": _domain(page_url),
            "source_type": kind,
        })

    for regex in (META_RE, META_REV_RE):
        for raw in regex.findall(body):
            add(raw)

    for tag in IMG_TAG_RE.findall(body):
        attrs = {k.lower(): v for k, v in ATTR_RE.findall(tag)}
        src = attrs.get("src") or attrs.get("data-src") or attrs.get("data-original") or ""
        width = int(attrs.get("width") or 0) if str(attrs.get("width") or "").isdigit() else 0
        height = int(attrs.get("height") or 0) if str(attrs.get("height") or "").isdigit() else 0
        srcset = attrs.get("srcset") or attrs.get("data-srcset") or ""
        if srcset:
            best, best_w = _best_srcset(srcset, page_url)
            if best:
                src, width = best, max(width, best_w)
        if src:
            add(src, attrs.get("alt", ""), width, height)
    return out


def _official_candidates(research: dict, topic: str) -> list[dict]:
    out, seen = [], set()
    for url, kind in _official_urls(research):
        for item in _page_images(url, topic, kind):
            if item["url"] not in seen:
                seen.add(item["url"])
                out.append(item)
    print(f"Visual Intelligence V2: {len(out)} official image candidates.")
    return out


def _google(core, topic: str, query: str, limit: int = 10) -> list[dict]:
    key = os.getenv("GOOGLE_CSE_API_KEY", "").strip()
    cx = os.getenv("GOOGLE_CSE_CX", "").strip()
    if not key or not cx:
        return []
    brand = _brand(topic)
    official_only = os.getenv("VISUAL_GOOGLE_OFFICIAL_ONLY", "true").lower() not in {"0", "false", "no"}
    q = query
    if official_only and brand:
        q += " " + " OR ".join(f"site:{d}" for d in BRANDS[brand]["domains"])
    try:
        r = core.SESSION.get(
            "https://www.googleapis.com/customsearch/v1",
            params={
                "key": key, "cx": cx, "q": q, "searchType": "image",
                "num": min(limit, 10), "imgSize": "xxlarge", "safe": "active",
            },
            timeout=30,
        )
        r.raise_for_status()
        data = r.json()
    except Exception as exc:
        print(f"Google Images skipped for {query!r}: {exc}")
        return []

    out = []
    for item in data.get("items") or []:
        meta = item.get("image") or {}
        url = str(item.get("link") or "")
        landing = str(meta.get("contextLink") or "")
        width, height = int(meta.get("width") or 0), int(meta.get("height") or 0)
        domain = _domain(landing or url)
        if not url or BAD_RE.search(url) or url.lower().endswith((".svg", ".gif")):
            continue
        if width and width < core.MIN_SOURCE_WIDTH:
            continue
        if height and height < core.MIN_SOURCE_HEIGHT:
            continue
        if official_only and brand and not any(
            domain == d or domain.endswith("." + d) for d in BRANDS[brand]["domains"]
        ):
            continue
        out.append({
            "source": "google_cse_official" if official_only else "google_cse",
            "title": str(item.get("title") or "")[:300],
            "url": url,
            "fallback_url": "",
            "landing_url": landing,
            "creator": domain,
            "license": "source_review_required",
            "rights_review_required": True,
            "source_width": width or 1920,
            "source_height": height or 1080,
            "download_width": width or 1920,
            "download_height": height or 1080,
            "query": query,
            "source_domain": domain,
        })
    return out


def install(core) -> None:
    global _INSTALLED
    if _INSTALLED:
        return
    _INSTALLED = True

    original_build = core.build_queries
    original_wikimedia = core.wikimedia_candidates
    original_openverse = core.openverse_candidates
    original_score = core.candidate_score

    def build_queries(research: dict, topic: str) -> list[str]:
        global _OFFICIAL, _OFFICIAL_EMITTED
        _OFFICIAL = _official_candidates(research, topic)
        _OFFICIAL_EMITTED = False

        exact = re.sub(r"\s+", " ", topic).strip()
        queries = [
            exact,
            f"{exact} official",
            f"{exact} launch",
            f"{exact} event",
            f"{exact} product photos",
        ] if exact else []

        brand = _brand(topic)
        if brand:
            queries.extend(BRANDS[brand]["queries"])
        for product in _products(research, topic):
            queries.extend((product, f"{product} official", f"{product} launch event", f"{product} hands on"))
        for item in research.get("timeline") or []:
            event = re.sub(r"\s+", " ", str(item.get("event") or "")).strip()
            date = str(item.get("date") or "").strip()
            if event:
                queries.extend((f"{event} {date}".strip(), event))
        for q in original_build(research, topic):
            if " historical" in q.lower() and not re.search(r"\b(history|historical|founded|origin)\b", exact.lower()):
                continue
            queries.append(q)

        out, seen = [], set()
        for q in queries:
            q = re.sub(r"\s+", " ", str(q)).strip()
            if q and q.lower() not in seen:
                seen.add(q.lower())
                out.append(q)
        return out[:28]

    def wikimedia(topic: str, query: str, limit: int = 50) -> list[dict]:
        global _OFFICIAL_EMITTED
        out = []
        if _OFFICIAL and not _OFFICIAL_EMITTED:
            out.extend(_OFFICIAL)
            _OFFICIAL_EMITTED = True
        out.extend(original_wikimedia(topic, query, limit))
        return out

    def openverse(topic: str, query: str, limit: int = 20) -> list[dict]:
        out = original_openverse(topic, query, limit)
        out.extend(_google(core, topic, query, min(limit, 10)))
        return out

    def score(candidate: dict, query_index: int, topic: str) -> float:
        value = float(original_score(candidate, query_index, topic))
        source = str(candidate.get("source") or "")
        title = str(candidate.get("title") or "")
        title_tokens, query_tokens = _tokens(title), _tokens(candidate.get("query") or "")
        if source == "official_page":
            value += 70
        elif source == "google_cse_official":
            value += 55
        elif source == "google_cse":
            value += 18
        value += min(35, len((query_tokens - GENERIC) & title_tokens) * 7)
        if _tokens(topic) and _tokens(topic) <= title_tokens:
            value += 20
        years = [int(x) for x in YEAR_RE.findall(title)]
        current = datetime.now(timezone.utc).year
        if years and not re.search(r"\b(history|historical|archive|founded)\b", topic.lower()):
            if max(years) < current - 2:
                value -= min(45, (current - max(years) - 2) * 9)
        if re.search(r"\b(stock photo|generic|illustration|render|concept|wallpaper)\b", title.lower()):
            value -= 45
        width, height = int(candidate.get("source_width") or 0), int(candidate.get("source_height") or 0)
        if width >= 2560 and height >= 1440:
            value += 15
        if width >= 3840 and height >= 2160:
            value += 20
        return value

    core.build_queries = build_queries
    core.wikimedia_candidates = wikimedia
    core.openverse_candidates = openverse
    core.candidate_score = score
    core.google_cse_candidates = lambda topic, query, limit=10: []
    print("Visual Intelligence V2 installed: exact queries, official sources, high-res/freshness ranking.")
