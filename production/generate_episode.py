from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path
from typing import Any

from anthropic import Anthropic

ROOT = Path(__file__).resolve().parents[1]
TOPICS_PATH = ROOT / "production" / "topics.json"
EDITORIAL_PATH = ROOT / "channel" / "editorial.json"
OUTPUT_ROOT = ROOT / "production" / "output"

STOPWORDS = {
    "about", "after", "again", "against", "because", "before", "being", "between", "could", "every",
    "first", "from", "have", "into", "just", "more", "most", "other", "over", "same", "some", "than",
    "that", "their", "them", "then", "there", "these", "they", "this", "those", "through", "under", "very",
    "what", "when", "where", "which", "while", "with", "would", "your", "company", "business",
}

EPISODE_TOOL = {
    "name": "submit_episode_package",
    "description": "Submit the fully researched, publication-ready editorial package for one The Business Flow documentary.",
    "input_schema": {
        "type": "object",
        "properties": {
            "research_summary": {"type": "string"},
            "selected_title": {"type": "string"},
            "title_candidates": {
                "type": "array",
                "minItems": 6,
                "maxItems": 6,
                "items": {"type": "string"},
            },
            "packaging_reasoning": {"type": "string"},
            "thumbnail_variants": {
                "type": "array",
                "minItems": 3,
                "maxItems": 3,
                "items": {
                    "type": "object",
                    "properties": {
                        "text": {"type": "string"},
                        "concept": {"type": "string"},
                        "asset_query": {"type": "string"},
                        "visual_tension": {"type": "string"},
                    },
                    "required": ["text", "concept", "asset_query", "visual_tension"],
                    "additionalProperties": False,
                },
            },
            "description": {"type": "string"},
            "tags": {"type": "array", "items": {"type": "string"}},
            "hook": {"type": "string"},
            "script": {"type": "string"},
            "chapters": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "title": {"type": "string"},
                        "summary": {"type": "string"},
                    },
                    "required": ["title", "summary"],
                    "additionalProperties": False,
                },
            },
            "sources": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "title": {"type": "string"},
                        "url": {"type": "string"},
                        "source_type": {"type": "string"},
                        "claims_supported": {"type": "array", "items": {"type": "string"}},
                    },
                    "required": ["title", "url", "source_type", "claims_supported"],
                    "additionalProperties": False,
                },
            },
            "risk_flags": {"type": "array", "items": {"type": "string"}},
        },
        "required": [
            "research_summary", "selected_title", "title_candidates", "packaging_reasoning",
            "thumbnail_variants", "description", "tags", "hook", "script", "chapters", "sources", "risk_flags"
        ],
        "additionalProperties": False,
    },
}


def required_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def select_topic(topic_id: str | None) -> dict[str, Any]:
    data = load_json(TOPICS_PATH)
    topics = data.get("topics") or []
    if topic_id:
        for topic in topics:
            if str(topic.get("id")) == topic_id:
                return topic
        raise RuntimeError(f"Topic not found: {topic_id}")
    for topic in topics:
        if topic.get("status") == "ready":
            return topic
    raise RuntimeError("No ready topic remains in production/topics.json")


def extract_json(text: str) -> dict[str, Any]:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        raise RuntimeError("Claude response did not contain a JSON object")
    return json.loads(text[start : end + 1])


def scene_keywords(text: str, topic: str) -> str:
    words = re.findall(r"[A-Za-z0-9][A-Za-z0-9'’-]+", text)
    candidates: list[str] = []
    seen: set[str] = set()
    for word in words:
        clean = word.strip("'’-")
        low = clean.lower()
        if len(clean) < 4 or low in STOPWORDS or low in seen:
            continue
        seen.add(low)
        candidates.append(clean)
    candidates.sort(key=lambda w: (-len(w), w.lower()))
    extra = " ".join(candidates[:5])
    return f"{topic} {extra}".strip()


def preferred_categories(topic: dict[str, Any]) -> list[str]:
    raw = str(topic.get("category") or "").lower()
    mapping = {
        "retail": "retail", "cloud": "technology", "ads": "corporate", "advertising": "corporate",
        "automotive": "automotive", "energy": "manufacturing", "software": "technology", "technology": "technology",
        "space": "manufacturing", "launch": "manufacturing", "beverage": "retail", "distribution": "corporate",
        "social": "technology", "media": "technology", "chips": "technology", "ai": "technology",
        "logistics": "corporate", "restaurant": "retail", "real estate": "real-estate", "finance": "finance",
        "bank": "finance", "luxury": "luxury", "manufacturing": "manufacturing",
    }
    result: list[str] = []
    for token, category in mapping.items():
        if token in raw and category not in result:
            result.append(category)
    return result[:3]


def build_storyboard(script: str, topic: dict[str, Any]) -> list[dict[str, Any]]:
    sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+", script.strip()) if s.strip()]
    chunks: list[str] = []
    current: list[str] = []
    current_words = 0
    for sentence in sentences:
        n = len(sentence.split())
        if current and current_words + n > 32:
            chunks.append(" ".join(current))
            current = []
            current_words = 0
        current.append(sentence)
        current_words += n
        if current_words >= 20:
            chunks.append(" ".join(current))
            current = []
            current_words = 0
    if current:
        chunks.append(" ".join(current))

    # Keep scene count inside the renderer's practical long-form range.
    while len(chunks) < 50:
        idx = next((i for i, c in enumerate(chunks) if len(c.split()) > 22), None)
        if idx is None:
            break
        words = chunks.pop(idx).split()
        mid = len(words) // 2
        chunks[idx:idx] = [" ".join(words[:mid]), " ".join(words[mid:])]
    if len(chunks) > 120:
        merged: list[str] = []
        for i in range(0, len(chunks), 2):
            merged.append(" ".join(chunks[i:i + 2]))
        chunks = merged[:120]

    company = str(topic.get("topic") or "business")
    categories = preferred_categories(topic)
    storyboard = []
    for i, chunk in enumerate(chunks, 1):
        words = len(chunk.split())
        seconds = max(5, min(12, round(words / 2.45)))
        storyboard.append({
            "scene": i,
            "narration_excerpt": chunk[:420],
            "visual_query": scene_keywords(chunk, company),
            "company": company,
            "preferred_categories": categories,
            "duration_sec": seconds,
        })
    return storyboard


def validate_package(data: dict[str, Any], topic: dict[str, Any]) -> None:
    required = [
        "selected_title", "title_candidates", "thumbnail_variants", "description", "tags",
        "hook", "script", "chapters", "sources",
    ]
    missing = [key for key in required if not data.get(key)]
    if missing:
        raise RuntimeError(f"Episode package missing: {', '.join(missing)}")

    title = str(data["selected_title"]).strip()
    if len(title) > 100:
        raise RuntimeError(f"YouTube title exceeds 100 chars: {len(title)}")
    brand = str(topic.get("topic") or "").strip()
    if brand and brand.lower() not in title.lower():
        raise RuntimeError(f"Selected title must name the famous company '{brand}'")

    description = str(data["description"]).strip()
    if len(description) > 5000:
        raise RuntimeError(f"YouTube description exceeds 5000 chars: {len(description)}")

    titles = data.get("title_candidates") or []
    if len(titles) != 6:
        raise RuntimeError(f"Need exactly 6 title candidates, got {len(titles)}")

    thumbs = data.get("thumbnail_variants") or []
    if len(thumbs) != 3:
        raise RuntimeError(f"Need exactly 3 thumbnail variants, got {len(thumbs)}")
    for thumb in thumbs:
        words = str(thumb.get("text") or "").split()
        if len(words) > 4:
            raise RuntimeError(f"Thumbnail text exceeds 4 words: {thumb.get('text')}")

    script_words = len(str(data["script"]).split())
    if script_words < 1800:
        raise RuntimeError(f"Script too short for long-form production: {script_words} words")
    if script_words > 3000:
        raise RuntimeError(f"Script too long for efficient long-form production: {script_words} words")

    sources = data.get("sources") or []
    if len(sources) < 5:
        raise RuntimeError("Research pack requires at least 5 sources")

    storyboard = build_storyboard(str(data["script"]), topic)
    if len(storyboard) < 40:
        raise RuntimeError(f"Locally generated storyboard too short: {len(storyboard)} scenes")

    data["topic_id"] = topic["id"]
    data["topic"] = topic["topic"]
    data["script_word_count"] = script_words
    data["storyboard"] = storyboard


def build_prompt(topic: dict[str, Any], editorial: dict[str, Any]) -> str:
    return f"""
You are the senior research lead, documentary writer and YouTube packaging strategist for The Business Flow.
The channel publishes cinematic, faceless, English-language business documentaries for a United States audience.

TODAY'S TOPIC
{json.dumps(topic, ensure_ascii=False)}

EDITORIAL RULES
{json.dumps(editorial, ensure_ascii=False)}

COST-EFFICIENT RESEARCH RULE
Use web search selectively, not exhaustively. Search only what is needed to verify the central thesis, important numbers, current facts and potentially disputed claims. Prefer high-information primary sources and reputable financial journalism. Do not waste searches on basic evergreen facts that are already well established.

MANDATORY EDITORIAL RULES
1. The company/brand name MUST appear in every title candidate and in selected_title.
2. Treat title seeds as hypotheses, not facts. Replace unsupported drama with a supported angle.
3. Packaging should be aggressively curiosity-driven and click-oriented, but factual.
4. Verify every important number, date and causal claim used in the title, thumbnail concept, hook or central thesis.
5. Crime/fraud/illegal language requires a court, regulator or equivalent authoritative source.
6. Write a complete 1,900-2,800 word documentary narration with a strong narrative arc, not a listicle.
7. The first 30 seconds must establish tension, stakes and an open loop.
8. Refresh tension or introduce a new question every 45-90 seconds.
9. End by resolving the promise of the title and opening hook.
10. Narration must sound natural in American English and must not speak citations aloud.
11. Produce exactly 6 strong original title candidates and select the strongest truthful one.
12. Produce exactly 3 thumbnail variants. Thumbnail text is 0-4 words and must complement the title, not repeat it. The concept should use an instantly recognizable brand element (logo, product, storefront, founder/CEO, app icon, vehicle, packaging, etc.).
13. Supply at least 5 sources, prioritizing primary/company filings/regulators and established journalism.
14. Keep description, tags, chapter summaries and packaging reasoning concise. Spend the output budget on the script, not administrative prose.
15. DO NOT create a scene-by-scene storyboard. The renderer creates it locally at zero API cost.

After research, call submit_episode_package exactly once with the complete package.
""".strip()


def generate(topic: dict[str, Any], editorial: dict[str, Any]) -> tuple[dict[str, Any], Any]:
    client = Anthropic(api_key=required_env("ANTHROPIC_API_KEY"))
    model = os.getenv("ANTHROPIC_MODEL", "claude-sonnet-5").strip() or "claude-sonnet-5"
    response = client.messages.create(
        model=model,
        max_tokens=9000,
        tools=[
            {
                "type": "web_search_20260318",
                "name": "web_search",
                "max_uses": 6,
                "user_location": {
                    "type": "approximate",
                    "country": "US",
                    "timezone": "America/New_York",
                },
            },
            EPISODE_TOOL,
        ],
        messages=[{"role": "user", "content": build_prompt(topic, editorial)}],
    )

    calls = [
        block for block in response.content
        if getattr(block, "type", None) == "tool_use"
        and getattr(block, "name", None) == "submit_episode_package"
    ]
    if calls:
        package = calls[-1].input
    else:
        # Compatibility fallback if the model returns a JSON text block rather than the structured tool.
        text = "\n".join(
            block.text for block in response.content if getattr(block, "type", None) == "text"
        )
        package = extract_json(text)

    validate_package(package, topic)
    package["anthropic_model"] = model
    usage = getattr(response, "usage", None)
    package["anthropic_usage"] = {
        "input_tokens": int(getattr(usage, "input_tokens", 0) or 0),
        "output_tokens": int(getattr(usage, "output_tokens", 0) or 0),
    }
    return package, response


def write_outputs(package: dict[str, Any]) -> Path:
    topic_id = package["topic_id"]
    output_dir = OUTPUT_ROOT / topic_id
    output_dir.mkdir(parents=True, exist_ok=True)

    (output_dir / "episode-package.json").write_text(
        json.dumps(package, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (output_dir / "script.txt").write_text(str(package["script"]).strip() + "\n", encoding="utf-8")
    (output_dir / "metadata.json").write_text(
        json.dumps(
            {
                "title": package["selected_title"],
                "description": package["description"],
                "tags": package["tags"],
                "category_id": "27",
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    (output_dir / "storyboard.json").write_text(
        json.dumps(package["storyboard"], ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (output_dir / "thumbnail.json").write_text(
        json.dumps(
            {
                "selected_title": package["selected_title"],
                "variants": package["thumbnail_variants"],
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    return output_dir


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--topic-id", default=None)
    args = parser.parse_args()

    topic = select_topic(args.topic_id)
    editorial = load_json(EDITORIAL_PATH)
    package, _ = generate(topic, editorial)
    output_dir = write_outputs(package)
    print(json.dumps({
        "topic_id": package["topic_id"],
        "topic": package["topic"],
        "selected_title": package["selected_title"],
        "script_word_count": package["script_word_count"],
        "source_count": len(package["sources"]),
        "storyboard_scene_count": len(package["storyboard"]),
        "anthropic_usage": package["anthropic_usage"],
        "output_dir": str(output_dir),
    }, indent=2))


if __name__ == "__main__":
    main()
