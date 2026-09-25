from __future__ import annotations

import argparse
import json
import os
import re
from typing import Any

from anthropic import Anthropic

try:
    from production import generate_episode as core
    from production.anthropic_budget import safe_response_snapshot, usage_dict
except ModuleNotFoundError:
    import generate_episode as core
    from anthropic_budget import safe_response_snapshot, usage_dict

# Keep references to the original core functions before installing V3 overrides.
# Without this, the wrapper's build_prompt would call itself recursively.
_original_build_prompt = core.build_prompt

# V3 makes the long narration the first tool field so a max-token stop cannot
# consume the output budget on packaging metadata before the actual script exists.
_original_properties = core.EPISODE_TOOL["input_schema"]["properties"]
core.EPISODE_TOOL["input_schema"]["properties"] = {
    "script": _original_properties["script"],
    "selected_title": _original_properties["selected_title"],
    "title_candidates": _original_properties["title_candidates"],
    "thumbnail_variants": _original_properties["thumbnail_variants"],
    "description": _original_properties["description"],
    "tags": _original_properties["tags"],
    "hook": _original_properties["hook"],
    "chapters": _original_properties["chapters"],
}
core.EPISODE_TOOL["input_schema"]["required"] = [
    "script", "selected_title", "title_candidates", "thumbnail_variants",
    "description", "tags", "hook", "chapters"
]

GENERIC_TOPIC_WORDS = {
    "the", "and", "company", "companies", "business", "drivers", "driver", "truckers", "trucker",
    "trucks", "truck", "glasses", "vr", "us", "usa", "u", "s", "jobs", "pay", "wages",
    "american", "america", "americas", "richest", "valuable", "industries", "industry", "market",
    "markets", "world", "global", "family", "families", "infrastructure", "billion", "billions",
}

NON_BRAND_EXPLICIT = {"u.s.", "u.s", "us", "usa", "united states", "american", "america"}
GENERAL_TOPIC_MARKERS = {
    "companies", "industries", "industry", "family", "families", "infrastructure", "markets", "market",
    "sectors", "sector", "richest", "valuable", "global", "world"
}


def required_brand_token(topic: dict[str, Any]) -> str:
    """Return a brand token only for genuine single-entity episodes.

    Ranking/list topics used to infer a bogus brand from the first meaningful word
    (for example "American" in "10 American Billion-Dollar Companies"). That made
    otherwise valid paid scripts impossible to recover. Explicit company/brand fields
    still win, but geography labels are not treated as brands. General/list topics do
    not require a brand token in the selected title.
    """
    explicit = str(topic.get("brand") or topic.get("company") or "").strip()
    if explicit and explicit.lower() not in NON_BRAND_EXPLICIT:
        return explicit

    raw = str(topic.get("topic") or "").strip()
    low = raw.lower()
    words = re.findall(r"[A-Za-z0-9][A-Za-z0-9&.-]*", raw)
    if not words:
        return ""

    # Numeric/list/ranking/editorial-category topics are not single brands.
    if re.match(r"^\d+\b", raw) or any(re.search(rf"\b{re.escape(marker)}\b", low) for marker in GENERAL_TOPIC_MARKERS):
        return ""

    for word in words:
        if word.lower() not in GENERIC_TOPIC_WORDS and len(word) >= 3:
            return word
    return ""


def validate_package(data: dict[str, Any], topic: dict[str, Any]) -> None:
    required = ["selected_title", "title_candidates", "thumbnail_variants", "description", "tags", "hook", "script", "chapters"]
    missing = [key for key in required if not data.get(key)]
    if missing:
        raise RuntimeError(f"Episode package missing: {', '.join(missing)}")

    title = str(data["selected_title"]).strip()
    if len(title) > 100:
        raise RuntimeError(f"YouTube title exceeds 100 chars: {len(title)}")
    brand = required_brand_token(topic)
    if brand and brand.lower() not in title.lower():
        raise RuntimeError(f"Selected title must name brand token '{brand}'")

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

    storyboard = core.build_storyboard(str(data["script"]), topic)
    if len(storyboard) < 40:
        raise RuntimeError(f"Locally generated storyboard too short: {len(storyboard)} scenes")

    data["topic_id"] = topic["id"]
    data["topic"] = topic["topic"]
    data["script_word_count"] = script_words
    data["storyboard"] = storyboard


def repair_paid_package(package: dict[str, Any], topic: dict[str, Any], research: dict[str, Any]) -> dict[str, Any]:
    """Repair non-factual packaging omissions locally without another model call."""
    try:
        from production import recover_paid_episode as recovery
    except ModuleNotFoundError:
        import recover_paid_episode as recovery
    return recovery.repair_package(package, topic, research)


def build_prompt(topic: dict[str, Any], research: dict[str, Any], editorial: dict[str, Any]) -> str:
    base = _original_build_prompt(topic, research, editorial)
    return base + f"""

OUTPUT ORDER — CRITICAL
- In the {core.EPISODE_TOOL_NAME} tool input, write `script` FIRST and finish the full narration before any title, thumbnail, description, tags, hook, or chapter metadata.
- Keep all non-script fields concise. The narration is the primary deliverable and must never be omitted because packaging used the output budget first.
- For a single-company episode, selected title and title candidates must contain the core brand/company name. For ranking/list/general-market episodes, do not force a fake brand token from the editorial topic label.
"""


core.validate_package = validate_package
core.build_prompt = build_prompt


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--topic-id", default=None)
    parser.add_argument("--force-new-script", action="store_true")
    args = parser.parse_args()

    topic = core.select_topic(args.topic_id)
    topic_id = str(topic["id"])
    research_path = core.RESEARCH_ROOT / topic_id / "research.json"
    if not research_path.exists():
        raise RuntimeError(f"Missing cached research: {research_path}. Run production/research_episode.py first.")
    research = core.load_json(research_path)
    current_research_hash = core.research_sha256(research)
    editorial = core.load_json(core.EDITORIAL_PATH)

    cache_dir = core.PACKAGE_CACHE_ROOT / topic_id
    package_path = cache_dir / "episode-package.json"
    snapshot_path = cache_dir / "sonnet-response.json"

    if args.force_new_script:
        package_path.unlink(missing_ok=True)
        snapshot_path.unlink(missing_ok=True)

    if package_path.exists():
        package = core.load_json(package_path)
        if package.get("research_sha256") != current_research_hash:
            raise RuntimeError(
                "Cached Sonnet package belongs to a different research revision. "
                "Refusing to spend again automatically; use --force-new-script only after deliberate review."
            )
        package = repair_paid_package(package, topic, research)
        validate_package(package, topic)
        package_path.write_text(json.dumps(package, ensure_ascii=False, indent=2), encoding="utf-8")
        output_dir = core.write_outputs(package)
        print(json.dumps({
            "topic_id": topic_id,
            "cache_hit": True,
            "selected_title": package["selected_title"],
            "anthropic_cost": package.get("anthropic_cost") or {},
            "output_dir": str(output_dir),
        }, indent=2))
        return

    model = os.getenv("ANTHROPIC_SCRIPT_MODEL", "claude-sonnet-5").strip() or "claude-sonnet-5"

    if snapshot_path.exists():
        snapshot = core.load_json(snapshot_path)
        package = repair_paid_package(core.parse_snapshot(snapshot), topic, research)
        if package.get("script"):
            package = core.finalize_package(package, topic, research, snapshot.get("usage") or {}, model)
            cache_dir.mkdir(parents=True, exist_ok=True)
            package_path.write_text(json.dumps(package, ensure_ascii=False, indent=2), encoding="utf-8")
            output_dir = core.write_outputs(package)
            print(json.dumps({
                "topic_id": topic_id,
                "cache_hit": True,
                "recovered_response": True,
                "anthropic_cost": package["anthropic_cost"],
                "output_dir": str(output_dir),
            }, indent=2))
            return
        raise RuntimeError("V3 cache contains an incomplete Sonnet snapshot without script; invalidate the cache before retrying.")

    prompt = build_prompt(topic, research, editorial)
    total_budget = float(os.getenv("ANTHROPIC_TOTAL_BUDGET_USD", "0.100"))
    research_cost = float(research.get("estimated_cost_usd") or 0)
    max_output_tokens = 4800
    input_chars = len(prompt) + len(json.dumps(core.EPISODE_TOOL, ensure_ascii=False))
    estimated_input_tokens = max(1, int(input_chars / 2.5))
    conservative_total = research_cost + estimated_input_tokens / 1_000_000 * 2.0 + max_output_tokens / 1_000_000 * 10.0
    if conservative_total > total_budget:
        raise RuntimeError(
            f"Anthropic preflight budget guard: worst-case ${conservative_total:.4f} > ${total_budget:.4f}. "
            "No Sonnet call was made. Research remains cached."
        )

    client = Anthropic(api_key=core.required_env("ANTHROPIC_API_KEY"), max_retries=0)
    response = client.messages.create(
        model=model,
        max_tokens=max_output_tokens,
        thinking={"type": "disabled"},
        tools=[core.EPISODE_TOOL],
        tool_choice={"type": "tool", "name": core.EPISODE_TOOL_NAME},
        messages=[{"role": "user", "content": prompt}],
    )

    cache_dir.mkdir(parents=True, exist_ok=True)
    snapshot = safe_response_snapshot(response, {core.EPISODE_TOOL_NAME})
    snapshot_path.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2), encoding="utf-8")

    package = repair_paid_package(core.parse_snapshot(snapshot), topic, research)
    package = core.finalize_package(package, topic, research, usage_dict(response), model)
    package_path.write_text(json.dumps(package, ensure_ascii=False, indent=2), encoding="utf-8")
    output_dir = core.write_outputs(package)

    print(json.dumps({
        "topic_id": topic_id,
        "topic": package["topic"],
        "cache_hit": False,
        "stop_reason": snapshot.get("stop_reason"),
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
