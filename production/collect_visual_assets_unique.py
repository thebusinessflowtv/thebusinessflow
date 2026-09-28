from __future__ import annotations

"""Active visual collector for The Business Flow.

Visual Intelligence V2 is installed before the proven zero-reuse collector is
loaded. This preserves the existing download/dedup/render contract while
upgrading discovery, query specificity and image ranking.
"""

import json
import re
from datetime import datetime, timezone

import collect_visual_assets as profiles
import visual_intelligence_v2

visual_intelligence_v2.install(profiles.core)
core = profiles.core

# Build an image pool from the same verified facts that will feed the narration.
# The collector runs before the final script is written, so research facts are the
# best deterministic proxy for scene-level intent (product, executive, factory,
# office, launch, facility, etc.).
_v2_build_queries = core.build_queries
_FACT_STOPWORDS = {
    "about", "after", "again", "because", "before", "being", "between", "could", "from", "have",
    "into", "more", "most", "other", "over", "that", "their", "them", "then", "there", "these", "they",
    "this", "those", "through", "under", "very", "what", "when", "where", "which", "while", "with", "would",
    "company", "business", "recorded", "reported", "approximately", "roughly", "million", "billion",
}
_VISUAL_SIGNAL_WORDS = {
    "factory", "manufacturing", "assembly", "office", "headquarters", "campus", "store", "warehouse",
    "facility", "facilities", "event", "keynote", "launch", "presentation", "product", "device", "phone",
    "smartphone", "glasses", "headset", "chip", "gpu", "server", "data", "center", "vehicle", "van", "truck",
    "robot", "robotics", "founder", "ceo", "executive", "production", "laboratory", "lab", "retail",
}


def _research_fact_query(topic: str, claim: str) -> str:
    words = re.findall(r"[A-Za-z0-9][A-Za-z0-9&.-]*", claim)
    named = []
    for match in re.finditer(r"\b(?:[A-Z][A-Za-z0-9&.-]+(?:\s+|$)){1,4}", claim):
        phrase = re.sub(r"\s+", " ", match.group(0)).strip(" .,;:-")
        if len(phrase) >= 3 and phrase.lower() not in {"the", "this", "that"}:
            named.append(phrase)
    signals = []
    for word in words:
        low = word.lower().strip(".-")
        if low in _VISUAL_SIGNAL_WORDS and low not in signals:
            signals.append(low)
    distinctive = []
    for word in words:
        low = word.lower().strip(".-")
        if len(low) >= 5 and low not in _FACT_STOPWORDS and low not in signals and not low.isdigit():
            distinctive.append(word)
    pieces = named[:2] + signals[:3] + distinctive[:2]
    deduped = []
    seen = set()
    for piece in pieces:
        key = piece.lower()
        if key not in seen and key not in topic.lower():
            seen.add(key)
            deduped.append(piece)
    return re.sub(r"\s+", " ", f"{topic} {' '.join(deduped[:6])}").strip()


def _build_queries_v2(research: dict, topic: str) -> list[str]:
    base = list(_v2_build_queries(research, topic))
    fact_queries = []
    for fact in research.get("facts") or []:
        claim = str(fact.get("claim") or "").strip()
        if not claim:
            continue
        query = _research_fact_query(topic, claim)
        if query and query.lower() != topic.lower():
            fact_queries.append(query)
    # Put research-derived visual intents before generic fallback queries so the
    # limited per-query quota is spent on scenes viewers can identify immediately.
    combined = base[:10] + fact_queries[:10] + base[10:]
    out, seen = [], set()
    for query in combined:
        clean = re.sub(r"\s+", " ", str(query)).strip()
        if clean and clean.lower() not in seen:
            seen.add(clean.lower())
            out.append(clean)
    return out[:32]


core.build_queries = _build_queries_v2

# For brand/company episodes that do not already have a curated subject profile,
# require identifiable visual evidence of the company/product AND meaningful
# overlap with the exact search intent. This prevents generic "technology",
# "office" or "factory" photos from filling the 40-image quota.
_original_strict_relevance = core.strict_relevance
_BRAND_TERMS = {
    "apple": {"apple", "iphone", "ipad", "mac", "macbook", "airpods", "cupertino", "foxconn", "tim", "cook"},
    "meta": {"meta", "facebook", "quest", "oculus", "zuckerberg", "reality", "ray-ban"},
    "nvidia": {"nvidia", "geforce", "rtx", "blackwell", "dgx", "jensen", "huang"},
    "amazon": {"amazon", "aws", "prime", "alexa", "rivian", "bezos"},
    "google": {"google", "alphabet", "googleplex", "android", "youtube", "pichai"},
    "microsoft": {"microsoft", "windows", "azure", "xbox", "nadella"},
    "tesla": {"tesla", "cybertruck", "supercharger", "gigafactory", "musk"},
}
_GENERIC_QUERY = {
    "official", "photo", "photos", "image", "images", "company", "business",
    "headquarters", "office", "offices", "factory", "facility", "product", "products",
    "launch", "event", "stage", "interior", "aerial", "manufacturing", "assembly", "line",
}


def _strict_relevance_v2(title: str, topic: str, query: str) -> bool:
    brand = visual_intelligence_v2._brand(topic)
    # Preserve carefully curated multi-subject profiles (Amazon drivers vs truckers,
    # Meta VR ecosystem, ranking episodes, etc.).
    if not brand or topic.lower() in core.SUBJECT_PROFILES:
        return _original_strict_relevance(title, topic, query)
    low = str(title or "").lower().strip()
    if not low or core.text_blocked(low, topic):
        return False
    title_tokens = core.tokenize(low)
    identity = _BRAND_TERMS.get(brand, {brand})
    if not (title_tokens & identity):
        return False
    query_tokens = core.tokenize(query) - _GENERIC_QUERY
    # One distinctive term is enough for a broad company query; specific product /
    # place queries need at least two matching terms when possible.
    overlap = title_tokens & query_tokens
    required = 1 if len(query_tokens) <= 2 else 2
    return len(overlap) >= required


core.strict_relevance = _strict_relevance_v2

# Extend freshness scoring to dated source URLs as well as titles. Old imagery is
# demoted unless the topic is explicitly historical.
_original_candidate_score = core.candidate_score


def _candidate_score_v2(candidate, query_index: int, topic: str) -> float:
    score = float(_original_candidate_score(candidate, query_index, topic))
    if not re.search(r"\b(history|historical|archive|founded|origin)\b", topic.lower()):
        date_text = " ".join(
            str(candidate.get(k) or "")
            for k in ("title", "landing_url", "url")
        )
        years = [int(y) for y in re.findall(r"\b(20\d{2})\b", date_text)]
        if years:
            current = datetime.now(timezone.utc).year
            age = current - max(years)
            if age > 2:
                score -= min(55.0, (age - 2) * 11.0)
    return score


core.candidate_score = _candidate_score_v2

import collect_visual_assets_unique_legacy as legacy

# The legacy collector resolves all candidate/search functions through ``core``.
# Point it at the now-patched core explicitly so every production run uses V2.
legacy.core = core

_original_write_manifest = legacy.write_manifest


def _write_manifest_v2(*args, **kwargs):
    manifest = _original_write_manifest(*args, **kwargs)
    manifest.update(
        {
            "profile_version": "hq-v4-visual-intelligence",
            "visual_intelligence": "v2",
            "exact_topic_queries": True,
            "research_fact_queries": True,
            "official_source_priority": True,
            "high_resolution_priority": True,
            "freshness_ranking": True,
            "generic_visual_penalty": True,
            "brand_identity_gate": True,
        }
    )
    path = args[0] if args else kwargs.get("path")
    if path is not None:
        path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest


legacy.write_manifest = _write_manifest_v2

# Re-export the stable public surface used by workflows/tests.
canonical_url = legacy.canonical_url
dhash = legacy.dhash
phash_distance = legacy.phash_distance
load_registry = legacy.load_registry
registry_index = legacy.registry_index
previously_used = legacy.previously_used
write_manifest = _write_manifest_v2
collect = legacy.collect
main = legacy.main


if __name__ == "__main__":
    main()
