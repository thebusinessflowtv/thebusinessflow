from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from pathlib import Path
from typing import Any

from anthropic import Anthropic

try:
    from production.anthropic_budget import estimate_cost_usd, safe_response_snapshot, usage_dict
except ModuleNotFoundError:
    from anthropic_budget import estimate_cost_usd, safe_response_snapshot, usage_dict

ROOT = Path(__file__).resolve().parents[1]
TOPICS_PATH = ROOT / "production" / "topics.json"
EDITORIAL_PATH = ROOT / "channel" / "editorial.json"
RESEARCH_ROOT = ROOT / "production" / "research-cache"
PACKAGE_CACHE_ROOT = ROOT / "production" / "package-cache"
OUTPUT_ROOT = ROOT / "production" / "output"

STOPWORDS = {
    "about", "after", "again", "against", "because", "before", "being", "between", "could", "every",
    "first", "from", "have", "into", "just", "more", "most", "other", "over", "same", "some", "than",
    "that", "their", "them", "then", "there", "these", "they", "this", "those", "through", "under", "very",
    "what", "when", "where", "which", "while", "with", "would", "your", "company", "business",
}

EPISODE_TOOL_NAME = "submit_episode_package"
EPISODE_TOOL = {
    "name": EPISODE_TOOL_NAME,
    "description": "Submit the finished documentary script and YouTube packaging using only the supplied research brief.",
    "input_schema": {
        "type": "object",
        "properties": {
            "selected_title": {"type": "string"},
            "title_candidates": {"type": "array", "items": {"type": "string"}},
            "thumbnail_variants": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "text": {"type": "string"},
                        "concept": {"type": "string"},
                        "asset_query": {"type": "string"},
                    },
                    "required": ["text", "concept", "asset_query"],
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
        },
        "required": [
            "selected_title", "title_candidates", "thumbnail_variants", "description",
            "tags", "hook", "script", "chapters"
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
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise RuntimeError("Sonnet response did not contain JSON")
    return json.loads(text[start : end + 1])


def research_sha256(research: dict[str, Any]) -> str:
    payload = json.dumps(research, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


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
    return f"{topic} {' '.join(candidates[:5])}".strip()


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
        count = len(sentence.split())
        if current and current_words + count > 32:
            chunks.append(" ".join(current))
            current, current_words = [], 0
        current.append(sentence)
        current_words += count
        if current_words >= 20:
            chunks.append(" ".join(current))
            current, current_words = [], 0
    if current:
        chunks.append(" ".join(current))

    while len(chunks) < 50:
        idx = next((i for i, value in enumerate(chunks) if len(value.split()) > 22), None)
        if idx is None:
            break
        words = chunks.pop(idx).split()
        mid = len(words) // 2
        chunks[idx:idx] = [" ".join(words[:mid]), " ".join(words[mid:])]
    while len(chunks) > 120:
        chunks = [" ".join(chunks[i:i + 2]) for i in range(0, len(chunks), 2)]

    company = str(topic.get("topic") or "business")
    categories = preferred_categories(topic)
    return [
        {
            "scene": i,
            "narration_excerpt": chunk[:420],
            "visual_query": scene_keywords(chunk, company),
            "company": company,
            "preferred_categories": categories,
            "duration_sec": max(5, min(12, round(len(chunk.split()) / 2.45))),
        }
        for i, chunk in enumerate(chunks[:120], 1)
    ]


def validate_package(data: dict[str, Any], topic: dict[str, Any]) -> None:
    required = ["selected_title", "title_candidates", "thumbnail_variants", "description", "tags", "hook", "script", "chapters"]
    missing = [key for key in required if not data.get(key)]
    if missing:
        raise RuntimeError(f"Episode package missing: {', '.join(missing)}")

    title = str(data["selected_title"]).strip()
    if len(title) > 100:
        raise RuntimeError(f"YouTube title exceeds 100 chars: {len(title)}")
    brand = str(topic.get("topic") or "").strip()
    if brand and brand.lower() not in title.lower():
        raise RuntimeError(f"Selected title must name '{brand}'")

    titles = data.get("title_candidates") or []
    if len(titles) != 6:
        raise RuntimeError(f"Need exactly 6 title candidates, got {len(titles)}")
    thumbs = data.get("thumbnail_variants") or []
    if len(thumbs) != 3:
        raise RuntimeError(f"Need exactly 3 thumbnail variants, got {len(thumbs)}")
    for thumb in thumbs:
        if len(str(thumb.get("text") or "").split()) > 4:
            raise RuntimeError(f"Thumbnail text exceeds 4 words: {thumb.get('text')}")

    script_words = len(str(data["script"]).split())
    if not 1750 <= script_words <= 2150:
        raise RuntimeError(f"Script must be 1750-2150 words; got {script_words}")
    if len(str(data["description"])) > 5000:
        raise RuntimeError("YouTube description exceeds 5000 chars")

    storyboard = build_storyboard(str(data["script"]), topic)
    if len(storyboard) < 40:
        raise RuntimeError(f"Locally generated storyboard too short: {len(storyboard)} scenes")

    data["topic_id"] = topic["id"]
    data["topic"] = topic["topic"]
    data["script_word_count"] = script_words
    data["storyboard"] = storyboard


def parse_snapshot(snapshot: dict[str, Any]) -> dict[str, Any]:
    for block in snapshot.get("content") or []:
        if block.get("type") == "tool_use" and block.get("name") == EPISODE_TOOL_NAME:
            value = block.get("input")
            if isinstance(value, dict):
                return value
    text = "\n".join(
        str(block.get("text") or "")
        for block in snapshot.get("content") or []
        if block.get("type") == "text"
    )
    return extract_json(text)


def concise_editorial(editorial: dict[str, Any]) -> dict[str, Any]:
    return {
        "packaging_strategy": editorial.get("packaging_strategy") or {},
        "rules": editorial.get("rules") or editorial.get("editorial_rules") or [],
    }


def build_prompt(topic: dict[str, Any], research: dict[str, Any], editorial: dict[str, Any]) -> str:
    research_for_prompt = {
        "thesis": research.get("thesis"),
        "facts": research.get("facts"),
        "verified_numbers": research.get("verified_numbers"),
        "timeline": research.get("timeline"),
        "sources": research.get("sources"),
        "risk_flags": research.get("risk_flags"),
    }
    return f"""
You are the documentary writer and YouTube packaging strategist for The Business Flow.
Write for a United States audience in natural American English.

TOPIC
{json.dumps(topic, ensure_ascii=False)}

CACHED RESEARCH BRIEF — THIS IS YOUR ONLY FACTUAL SOURCE
{json.dumps(research_for_prompt, ensure_ascii=False)}

EDITORIAL PACKAGING RULES
{json.dumps(concise_editorial(editorial), ensure_ascii=False)}

COST / SCOPE RULES
- DO NOT browse, search, fetch URLs, or ask for tools other than {EPISODE_TOOL_NAME}.
- Use only claims supported by the cached research brief. If a detail is absent, do not invent it.
- Keep administrative prose extremely short so the output budget goes to narration.

MANDATORY OUTPUT
1. Exactly 6 title candidates; every title must name the company/brand.
2. Select one truthful high-curiosity title. Factual clickbait is encouraged; unsupported clickbait is forbidden.
3. Exactly 3 thumbnail concepts, each with 0-4 words of thumbnail text.
4. A complete 1,800-2,000 word narration with a strong opening tension, an open loop in the first 30 seconds, renewed tension every 45-90 seconds, and a resolved ending.
5. A concise YouTube description, tags, hook, and concise chapter list.
6. Do not repeat citations inside the narration. Source metadata is attached automatically from the cached research after you finish.

Call {EPISODE_TOOL_NAME} exactly once. Do not emit extra prose.
""".strip()


def write_outputs(package: dict[str, Any]) -> Path:
    output_dir = OUTPUT_ROOT / str(package["topic_id"])
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "episode-package.json").write_text(json.dumps(package, ensure_ascii=False, indent=2), encoding="utf-8")
    (output_dir / "script.txt").write_text(str(package["script"]).strip() + "\n", encoding="utf-8")
    (output_dir / "metadata.json").write_text(
        json.dumps({
            "title": package["selected_title"],
            "description": package["description"],
            "tags": package["tags"],
            "category_id": "27",
        }, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    (output_dir / "storyboard.json").write_text(json.dumps(package["storyboard"], ensure_ascii=False, indent=2), encoding="utf-8")
    (output_dir / "thumbnail.json").write_text(
        json.dumps({"selected_title": package["selected_title"], "variants": package["thumbnail_variants"]}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return output_dir


def finalize_package(package: dict[str, Any], topic: dict[str, Any], research: dict[str, Any], script_usage: dict[str, int], model: str) -> dict[str, Any]:
    validate_package(package, topic)
    package["sources"] = research.get("sources") or []
    package["risk_flags"] = research.get("risk_flags") or []
    package["research_summary"] = research.get("thesis") or ""
    package["research_sha256"] = research_sha256(research)
    research_cost = float(research.get("estimated_cost_usd") or 0)
    script_cost = estimate_cost_usd(model, script_usage)
    package["anthropic_models"] = {
        "research": research.get("research_model"),
        "script": model,
    }
    package["anthropic_usage"] = {
        "research": research.get("anthropic_usage") or {},
        "script": script_usage,
    }
    package["anthropic_cost"] = {
        "research_usd": round(research_cost, 6),
        "script_usd": round(script_cost, 6),
        "total_usd": round(research_cost + script_cost, 6),
    }
    return package


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--topic-id", default=None)
    parser.add_argument("--force-new-script", action="store_true")
    args = parser.parse_args()

    topic = select_topic(args.topic_id)
    topic_id = str(topic["id"])
    research_path = RESEARCH_ROOT / topic_id / "research.json"
    if not research_path.exists():
        raise RuntimeError(f"Missing cached research: {research_path}. Run production/research_episode.py first.")
    research = load_json(research_path)
    current_research_hash = research_sha256(research)
    editorial = load_json(EDITORIAL_PATH)

    cache_dir = PACKAGE_CACHE_ROOT / topic_id
    package_path = cache_dir / "episode-package.json"
    snapshot_path = cache_dir / "sonnet-response.json"

    if args.force_new_script:
        package_path.unlink(missing_ok=True)
        snapshot_path.unlink(missing_ok=True)

    if package_path.exists():
        package = load_json(package_path)
        if package.get("research_sha256") != current_research_hash:
            raise RuntimeError(
                "Cached Sonnet package belongs to a different research revision. "
                "Refusing to spend again automatically; use --force-new-script only after deliberate review."
            )
        validate_package(package, topic)
        output_dir = write_outputs(package)
        print(json.dumps({
            "topic_id": topic_id,
            "cache_hit": True,
            "selected_title": package["selected_title"],
            "anthropic_cost": package.get("anthropic_cost") or {},
            "output_dir": str(output_dir),
        }, indent=2))
        return

    model = os.getenv("ANTHROPIC_SCRIPT_MODEL", "claude-sonnet-5").strip() or "claude-sonnet-5"

    # Recover a completed paid response before ever considering another Sonnet call.
    if snapshot_path.exists():
        snapshot = load_json(snapshot_path)
        try:
            package = parse_snapshot(snapshot)
            package = finalize_package(package, topic, research, snapshot.get("usage") or {}, model)
            cache_dir.mkdir(parents=True, exist_ok=True)
            package_path.write_text(json.dumps(package, ensure_ascii=False, indent=2), encoding="utf-8")
            output_dir = write_outputs(package)
            print(json.dumps({
                "topic_id": topic_id,
                "cache_hit": True,
                "recovered_response": True,
                "anthropic_cost": package["anthropic_cost"],
                "output_dir": str(output_dir),
            }, indent=2))
            return
        except Exception as exc:
            raise RuntimeError(
                "A previous paid Sonnet response exists but could not be recovered. "
                "Refusing to spend again automatically. Fix/review the cached response or rerun explicitly with --force-new-script."
            ) from exc

    prompt = build_prompt(topic, research, editorial)
    total_budget = float(os.getenv("ANTHROPIC_TOTAL_BUDGET_USD", "0.080"))
    research_cost = float(research.get("estimated_cost_usd") or 0)
    max_output_tokens = 4000
    # Conservative local preflight: include prompt + tool schema at ~2.5 chars/token and the full output cap.
    input_chars = len(prompt) + len(json.dumps(EPISODE_TOOL, ensure_ascii=False))
    estimated_input_tokens = max(1, int(input_chars / 2.5))
    conservative_total = research_cost + estimated_input_tokens / 1_000_000 * 2.0 + max_output_tokens / 1_000_000 * 10.0
    if conservative_total > total_budget:
        raise RuntimeError(
            f"Anthropic preflight budget guard: worst-case ${conservative_total:.4f} > ${total_budget:.4f}. "
            "No Sonnet call was made. Research remains cached."
        )

    client = Anthropic(api_key=required_env("ANTHROPIC_API_KEY"), max_retries=0)
    response = client.messages.create(
        model=model,
        max_tokens=max_output_tokens,
        thinking={"type": "disabled"},
        tools=[EPISODE_TOOL],
        tool_choice={"type": "tool", "name": EPISODE_TOOL_NAME},
        messages=[{"role": "user", "content": prompt}],
    )

    # Persist the paid model output before parsing/validation. Never repay because of our own downstream bug.
    cache_dir.mkdir(parents=True, exist_ok=True)
    snapshot = safe_response_snapshot(response, {EPISODE_TOOL_NAME})
    snapshot_path.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2), encoding="utf-8")

    package = parse_snapshot(snapshot)
    package = finalize_package(package, topic, research, usage_dict(response), model)
    package_path.write_text(json.dumps(package, ensure_ascii=False, indent=2), encoding="utf-8")
    output_dir = write_outputs(package)

    print(json.dumps({
        "topic_id": topic_id,
        "topic": package["topic"],
        "cache_hit": False,
        "selected_title": package["selected_title"],
        "script_word_count": package["script_word_count"],
        "source_count": len(package["sources"]),
        "storyboard_scene_count": len(package["storyboard"]),
        "anthropic_usage": package["anthropic_usage"],
        "anthropic_cost": package["anthropic_cost"],
        "budget_usd": total_budget,
        "output_dir": str(output_dir),
    }, indent=2))


if __name__ == "__main__":
    main()
