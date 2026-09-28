from __future__ import annotations

"""Active visual collector for The Business Flow.

Visual Intelligence V2 is installed before the proven zero-reuse collector is
loaded. This preserves the existing download/dedup/render contract while
upgrading discovery, query specificity and image ranking.

Dynamic-selection episodes (for example: "select one failed airline") receive a
research-derived subject profile before visual discovery. That lets the strict
collector search for the actual company selected by research instead of requiring
every image title to contain the generic topic seed.
"""

import json
import re
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

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
    "aircraft", "airline", "airport", "restaurant", "storefront", "menu", "fuel", "station",
}

# Generic words that must never become the identity gate for a dynamically selected
# company. The goal is to identify Pan Am / Boston Market / 7-Eleven-style entities,
# not words such as "American", "Chapter 11", or a sentence starter.
_DYNAMIC_ENTITY_STOPWORDS = {
    "the", "this", "that", "these", "those", "american", "america", "united", "states", "u.s", "us",
    "chapter", "bankruptcy", "bankrupt", "company", "companies", "business", "businesses", "chain", "chains",
    "airline", "airlines", "aviation", "restaurant", "restaurants", "fast-food", "fast", "food", "convenience",
    "store", "stores", "retail", "market", "markets", "according", "however", "after", "before", "during",
    "million", "billion", "year", "years", "federal", "court", "reuters", "bloomberg", "forbes", "sec",
}
_DYNAMIC_GENERIC_PHRASES = {
    "the company", "the business", "united states", "chapter 11", "chapter 7", "u.s", "us bankruptcy",
}


def _research_fact_query(topic: str, claim: str) -> str:
    words = re.findall(r"[A-Za-z0-9][A-Za-z0-9&.'’-]*", claim)
    named = []
    for match in re.finditer(r"\b(?:[A-Z0-9][A-Za-z0-9&.'’-]+(?:\s+|$)){1,4}", claim):
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
        if key not in seen:
            seen.add(key)
            deduped.append(piece)
    # For generic research-and-select topic seeds, prefixing the full seed makes
    # Wikimedia/Openverse queries effectively unsearchable. Use the concrete named
    # entities from the verified claim first; fall back to the topic only when the
    # claim does not expose anything useful.
    if deduped:
        return re.sub(r"\s+", " ", " ".join(deduped[:6])).strip()
    return re.sub(r"\s+", " ", topic).strip()


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
    combined = fact_queries[:12] + base[:10] + base[10:]
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
    # Preserve carefully curated and dynamically installed subject profiles.
    if topic.lower() in core.SUBJECT_PROFILES:
        return _original_strict_relevance(title, topic, query)
    if not brand:
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
        date_text = " ".join(str(candidate.get(k) or "") for k in ("title", "landing_url", "url"))
        years = [int(y) for y in re.findall(r"\b(20\d{2})\b", date_text)]
        if years:
            current = datetime.now(timezone.utc).year
            age = current - max(years)
            if age > 2:
                score -= min(55.0, (age - 2) * 11.0)
    return score


core.candidate_score = _candidate_score_v2


def _research_entity_candidates(research: dict) -> list[tuple[str, int]]:
    thesis = str(research.get("thesis") or "").strip()
    texts = [thesis]
    texts += [str(x.get("claim") or "") for x in research.get("facts") or []]
    texts += [str(x.get("event") or "") for x in research.get("timeline") or []]

    counts: Counter[str] = Counter()
    display: dict[str, str] = {}
    lead_bonus: Counter[str] = Counter()
    pattern = re.compile(r"(?<![A-Za-z0-9])(?:[A-Z0-9][A-Za-z0-9&.'’/-]*(?:\s+|$)){1,5}")

    for text_index, text in enumerate(texts):
        for match in pattern.finditer(text):
            phrase = re.sub(r"\s+", " ", match.group(0)).strip(" .,;:()[]{}-'\"")
            if len(phrase) < 2:
                continue
            low = phrase.lower()
            tokens = [t.lower().strip(".'’-") for t in re.findall(r"[A-Za-z0-9][A-Za-z0-9&.'’/-]*", phrase)]
            meaningful = [t for t in tokens if t and t not in _DYNAMIC_ENTITY_STOPWORDS and not t.isdigit()]
            if not meaningful or low in _DYNAMIC_GENERIC_PHRASES:
                continue
            if all(t in _DYNAMIC_ENTITY_STOPWORDS for t in tokens):
                continue
            # Avoid turning a full sentence prefix into an identity phrase.
            if len(tokens) > 4 and len(meaningful) < 2:
                continue
            key = low
            counts[key] += 1
            display.setdefault(key, phrase)
            if text_index == 0 and match.start() < 80:
                lead_bonus[key] += 3

    scored = []
    for key, count in counts.items():
        phrase = display[key]
        tokens = re.findall(r"[A-Za-z0-9&]+", phrase.lower())
        specificity = min(4, len(tokens))
        score = count * 5 + specificity + lead_bonus[key]
        scored.append((phrase, score))
    scored.sort(key=lambda x: (-x[1], -len(x[0])))
    return scored


def _install_dynamic_subject_profile(research: dict, topic: str) -> str | None:
    if topic.lower() in core.SUBJECT_PROFILES or visual_intelligence_v2._brand(topic):
        return None

    candidates = _research_entity_candidates(research)
    if not candidates:
        print("Dynamic visual subject: no reliable named entity found; using default profile.")
        return None

    subject = candidates[0][0]
    aliases: list[str] = []
    seen = set()
    subject_tokens = set(re.findall(r"[a-z0-9]+", subject.lower())) - _DYNAMIC_ENTITY_STOPWORDS

    for phrase, score in candidates[:12]:
        phrase_tokens = set(re.findall(r"[a-z0-9]+", phrase.lower())) - _DYNAMIC_ENTITY_STOPWORDS
        if not phrase_tokens:
            continue
        if phrase.lower() == subject.lower() or (subject_tokens and phrase_tokens & subject_tokens):
            clean = phrase.lower().strip()
            if clean not in seen and len(clean) >= 3:
                seen.add(clean)
                aliases.append(clean)
        if len(aliases) >= 6:
            break

    # Always retain the full selected identity as the strongest relevance gate.
    if subject.lower() not in seen:
        aliases.insert(0, subject.lower())

    low_topic = topic.lower()
    if "airline" in low_topic or "aviation" in low_topic:
        context_queries = [
            "aircraft", "airplane livery", "airport", "ticket counter", "employees", "advertisement",
            "historic aircraft", "bankruptcy", "headquarters",
        ]
        context_terms = {"aircraft", "airplane", "airport", "livery", "terminal"}
    elif "fast-food" in low_topic or "fast food" in low_topic or "restaurant" in low_topic:
        context_queries = [
            "restaurant storefront", "restaurant interior", "menu", "food", "advertisement", "historic restaurant",
            "closed restaurant", "bankruptcy", "headquarters",
        ]
        context_terms = {"restaurant", "menu", "storefront"}
    elif "convenience" in low_topic or "retail" in low_topic:
        context_queries = [
            "storefront", "store interior", "gas station", "fuel station", "products", "customers",
            "closed store", "headquarters", "retail locations",
        ]
        context_terms = {"store", "storefront", "station", "retail"}
    else:
        context_queries = ["headquarters", "products", "historical", "operations", "employees", "advertisement"]
        context_terms = set()

    queries = [subject]
    queries.extend(f"{subject} {suffix}" for suffix in context_queries)
    # Add a few research-derived entity aliases as direct searches.
    queries.extend(alias for alias in aliases[1:4])
    queries = list(dict.fromkeys(q.strip() for q in queries if q.strip()))[:20]

    allow_terms = set(aliases)
    # Short unique subject tokens are useful as aliases only when they are not
    # generic industry words. Keep a minimum length to avoid noisy matches.
    for token in subject_tokens:
        if len(token) >= 4 and token not in _DYNAMIC_ENTITY_STOPWORDS:
            allow_terms.add(token)
    # Context terms alone are intentionally NOT sufficient for relevance; images
    # still need the selected company identity in their metadata.

    core.SUBJECT_PROFILES[topic.lower()] = {
        "queries": queries,
        "allow_terms": allow_terms,
        "block_terms": {"ai generated", "concept render", "illustration", "unrelated"},
        "dynamic_subject": subject,
        "context_terms": context_terms,
    }
    print(f"Dynamic visual subject selected from research: {subject!r}; aliases={sorted(allow_terms)}")
    return subject


import collect_visual_assets_unique_legacy as legacy

# The legacy collector resolves all candidate/search functions through ``core``.
# Point it at the now-patched core explicitly so every production run uses V2.
legacy.core = core
_original_collect = legacy.collect
_original_write_manifest = legacy.write_manifest


def _write_manifest_v2(*args, **kwargs):
    manifest = _original_write_manifest(*args, **kwargs)
    profile = core.SUBJECT_PROFILES.get(str(manifest.get("topic") or "").lower()) or {}
    manifest.update(
        {
            "profile_version": "hq-v5-dynamic-subject-visual-intelligence",
            "visual_intelligence": "v2",
            "exact_topic_queries": True,
            "research_fact_queries": True,
            "official_source_priority": True,
            "high_resolution_priority": True,
            "freshness_ranking": True,
            "generic_visual_penalty": True,
            "brand_identity_gate": True,
            "dynamic_subject": profile.get("dynamic_subject"),
        }
    )
    path = args[0] if args else kwargs.get("path")
    if path is not None:
        path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest


legacy.write_manifest = _write_manifest_v2


def collect(topic_id: str, research_path: Path, target: int):
    research = json.loads(Path(research_path).read_text(encoding="utf-8"))
    topic = str(research.get("topic") or "").strip()
    if topic:
        _install_dynamic_subject_profile(research, topic)
    return _original_collect(topic_id, research_path, target)


# legacy.main looks up its module-global collect function at runtime, so patching
# it here makes both CLI workflow runs and imported callers use the same dynamic
# subject selection without changing the stable command-line contract.
legacy.collect = collect

# Re-export the stable public surface used by workflows/tests.
canonical_url = legacy.canonical_url
dhash = legacy.dhash
phash_distance = legacy.phash_distance
load_registry = legacy.load_registry
registry_index = legacy.registry_index
previously_used = legacy.previously_used
write_manifest = _write_manifest_v2
main = legacy.main


if __name__ == "__main__":
    main()
