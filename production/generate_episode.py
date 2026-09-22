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


def validate_package(data: dict[str, Any], topic: dict[str, Any]) -> None:
    required = [
        "selected_title",
        "title_candidates",
        "thumbnail_variants",
        "description",
        "tags",
        "hook",
        "script",
        "chapters",
        "storyboard",
        "sources",
    ]
    missing = [key for key in required if not data.get(key)]
    if missing:
        raise RuntimeError(f"Episode package missing: {', '.join(missing)}")

    title = str(data["selected_title"]).strip()
    if len(title) > 100:
        raise RuntimeError(f"YouTube title exceeds 100 chars: {len(title)}")

    description = str(data["description"]).strip()
    if len(description) > 5000:
        raise RuntimeError(f"YouTube description exceeds 5000 chars: {len(description)}")

    titles = data.get("title_candidates") or []
    if len(titles) < 5:
        raise RuntimeError("Need at least 5 title candidates")

    thumbs = data.get("thumbnail_variants") or []
    if len(thumbs) < 3:
        raise RuntimeError("Need 3 thumbnail variants")
    for thumb in thumbs:
        words = str(thumb.get("text") or "").split()
        if len(words) > 4:
            raise RuntimeError(f"Thumbnail text exceeds 4 words: {thumb.get('text')}")

    script_words = len(str(data["script"]).split())
    if script_words < 1700:
        raise RuntimeError(f"Script too short for long-form production: {script_words} words")
    if script_words > 4000:
        raise RuntimeError(f"Script too long for configured format: {script_words} words")

    sources = data.get("sources") or []
    if len(sources) < 5:
        raise RuntimeError("Research pack requires at least 5 sources")

    data["topic_id"] = topic["id"]
    data["topic"] = topic["topic"]
    data["script_word_count"] = script_words


def build_prompt(topic: dict[str, Any], editorial: dict[str, Any]) -> str:
    return f"""
You are the research lead, documentary writer and YouTube packaging strategist for The Business Flow.
The channel publishes cinematic, faceless, English-language business documentaries for a United States audience.

TODAY'S TOPIC SEED
{json.dumps(topic, ensure_ascii=False, indent=2)}

EDITORIAL CONFIG
{json.dumps(editorial, ensure_ascii=False, indent=2)}

MANDATORY WORKFLOW
1. Treat the topic seed and title seed as hypotheses, not facts.
2. Search the current web extensively before writing. Prefer primary sources, SEC/company filings, court/regulator records, official statements, reputable financial press and established journalism.
3. Verify every important number, date and causal claim. If a dramatic seed is unsupported, replace it with a supported angle.
4. Build a 12-25 minute documentary with a strong narrative arc, not a listicle.
5. Packaging should be aggressively curiosity-driven and click-oriented, but never deceptive.
6. Do not copy competitor titles verbatim. Create original packaging.
7. A title or thumbnail may use a large number only if a source in the research pack supports it.
8. Crime/fraud/illegal language requires a court, regulator or equivalent primary source.
9. The first 30 seconds must establish tension, stakes and an open loop.
10. Refresh tension or introduce a new question every 45-90 seconds.
11. The ending must resolve the promise of the title and opening hook.
12. Narration must sound natural in American English and must not include source citations spoken aloud.

CLICK PACKAGING
- Produce exactly 10 title candidates. Favor familiar brand + unexpected conflict, verified number + consequence, hidden economics, business-model contradiction, or rise-and-fall reversal.
- Select the strongest truthful title as selected_title.
- Produce exactly 3 thumbnail variants. Each thumbnail text must be 0-4 words, extremely readable, and must complement rather than repeat the title.
- Thumbnail concept should specify dominant subject, background, visual tension, and what asset the renderer should seek.

OUTPUT
Return one valid JSON object only. No markdown fences, no prose before or after it.
Use this schema:
{{
  "research_summary": "concise factual thesis",
  "selected_title": "...",
  "title_candidates": ["..."],
  "packaging_reasoning": "why the selected title + thumbnail pairing creates curiosity without overclaiming",
  "thumbnail_variants": [
    {{"text":"0-4 words","concept":"...","asset_query":"...","visual_tension":"..."}}
  ],
  "description": "YouTube description in English",
  "tags": ["..."],
  "hook": "first 20-30 seconds of narration",
  "script": "complete 1700-4000 word narration",
  "chapters": [{{"title":"...","summary":"..."}}],
  "storyboard": [
    {{"scene":1,"narration_excerpt":"...","visual_query":"...","company":"... or null","preferred_categories":["..."],"duration_sec":8}}
  ],
  "sources": [
    {{"title":"...","url":"https://...","source_type":"primary|filing|regulator|journalism|other","claims_supported":["..."]}}
  ],
  "risk_flags": ["unsupported or disputed points that must not appear as settled fact"]
}}

The storyboard should be detailed enough for automated B-roll selection, typically 70-140 scenes for a long-form episode, with scene durations usually 5-12 seconds.
""".strip()


def generate(topic: dict[str, Any], editorial: dict[str, Any]) -> tuple[dict[str, Any], Any]:
    client = Anthropic(api_key=required_env("ANTHROPIC_API_KEY"))
    model = os.getenv("ANTHROPIC_MODEL", "claude-sonnet-5").strip() or "claude-sonnet-5"
    response = client.messages.create(
        model=model,
        max_tokens=16000,
        temperature=0.7,
        tools=[
            {
                "type": "web_search_20260318",
                "name": "web_search",
                "max_uses": 12,
                "user_location": {
                    "type": "approximate",
                    "country": "US",
                    "timezone": "America/New_York",
                },
            }
        ],
        messages=[{"role": "user", "content": build_prompt(topic, editorial)}],
    )
    text = "\n".join(
        block.text for block in response.content if getattr(block, "type", None) == "text"
    )
    package = extract_json(text)
    validate_package(package, topic)
    package["anthropic_model"] = model
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
        "output_dir": str(output_dir),
    }, indent=2))


if __name__ == "__main__":
    main()
