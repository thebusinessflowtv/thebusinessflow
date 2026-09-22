from __future__ import annotations

import argparse
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from anthropic import Anthropic

from production.anthropic_budget import estimate_cost_usd, safe_response_snapshot, usage_dict

ROOT = Path(__file__).resolve().parents[1]
TOPICS_PATH = ROOT / "production" / "topics.json"
CACHE_ROOT = ROOT / "production" / "research-cache"

RESEARCH_TOOL_NAME = "submit_research_brief"
RESEARCH_TOOL = {
    "name": RESEARCH_TOOL_NAME,
    "description": "Submit a compact, source-backed research brief for one business documentary.",
    "input_schema": {
        "type": "object",
        "properties": {
            "thesis": {"type": "string"},
            "facts": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "claim": {"type": "string"},
                        "source_title": {"type": "string"},
                        "source_url": {"type": "string"},
                        "source_type": {"type": "string"},
                        "safe_for_packaging": {"type": "boolean"},
                    },
                    "required": ["claim", "source_title", "source_url", "source_type", "safe_for_packaging"],
                    "additionalProperties": False,
                },
            },
            "verified_numbers": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "value": {"type": "string"},
                        "context": {"type": "string"},
                        "source_url": {"type": "string"},
                    },
                    "required": ["value", "context", "source_url"],
                    "additionalProperties": False,
                },
            },
            "timeline": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "date": {"type": "string"},
                        "event": {"type": "string"},
                        "source_url": {"type": "string"},
                    },
                    "required": ["date", "event", "source_url"],
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
                    },
                    "required": ["title", "url", "source_type"],
                    "additionalProperties": False,
                },
            },
            "risk_flags": {"type": "array", "items": {"type": "string"}},
        },
        "required": ["thesis", "facts", "verified_numbers", "timeline", "sources", "risk_flags"],
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
        raise RuntimeError("Research response did not contain JSON")
    return json.loads(text[start : end + 1])


def validate_brief(brief: dict[str, Any], topic: dict[str, Any]) -> None:
    if not str(brief.get("thesis") or "").strip():
        raise RuntimeError("Research brief is missing thesis")
    facts = brief.get("facts") or []
    sources = brief.get("sources") or []
    if len(facts) < 6:
        raise RuntimeError(f"Research brief needs at least 6 sourced facts; got {len(facts)}")
    if len(sources) < 4:
        raise RuntimeError(f"Research brief needs at least 4 sources; got {len(sources)}")
    urls = {str(s.get("url") or "").strip() for s in sources}
    if not all(url.startswith(("http://", "https://")) for url in urls if url):
        raise RuntimeError("Research brief contains an invalid source URL")
    brief["topic_id"] = topic["id"]
    brief["topic"] = topic["topic"]


def parse_snapshot(snapshot: dict[str, Any]) -> dict[str, Any]:
    for block in snapshot.get("content") or []:
        if block.get("type") == "tool_use" and block.get("name") == RESEARCH_TOOL_NAME:
            value = block.get("input")
            if isinstance(value, dict):
                return value
    text = "\n".join(
        str(block.get("text") or "")
        for block in snapshot.get("content") or []
        if block.get("type") == "text"
    )
    return extract_json(text)


def build_prompt(topic: dict[str, Any]) -> str:
    return f"""
You are the low-cost research desk for The Business Flow, a US-focused business documentary channel.

TOPIC SEED
{json.dumps(topic, ensure_ascii=False)}

COST RULES — FOLLOW EXACTLY
- Perform EXACTLY ONE web search total. Never perform a second search.
- Make that one query broad and information-dense enough to surface primary/company filings or official material plus reputable financial journalism.
- Do not browse for trivia. We need only the facts necessary to support a 12-15 minute documentary.
- Keep your final research brief compact. Do not quote long passages.

RESEARCH RULES
- Treat the seed angle as a hypothesis, not a fact.
- Prefer annual reports, SEC/regulator/court/official sources and established financial journalism.
- Capture 6-10 high-value factual claims, at least 4 distinct sources, useful dates, and only the most important verified numbers.
- Mark a fact safe_for_packaging=true only when the cited source directly supports using it in a title/thumbnail/hook.
- Do not infer crimes, fraud, motives, or causation beyond the evidence.
- If a dramatic claim cannot be supported by the one search, omit it rather than spending another search.

After the single search, call {RESEARCH_TOOL_NAME} exactly once. Keep the tool payload concise.
""".strip()


def write_research(brief: dict[str, Any], cache_dir: Path) -> Path:
    cache_dir.mkdir(parents=True, exist_ok=True)
    path = cache_dir / "research.json"
    path.write_text(json.dumps(brief, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--topic-id", default=None)
    parser.add_argument("--force-new-research", action="store_true")
    args = parser.parse_args()

    topic = select_topic(args.topic_id)
    cache_dir = CACHE_ROOT / str(topic["id"])
    research_path = cache_dir / "research.json"
    snapshot_path = cache_dir / "haiku-response.json"

    if args.force_new_research:
        research_path.unlink(missing_ok=True)
        snapshot_path.unlink(missing_ok=True)

    if research_path.exists():
        brief = load_json(research_path)
        validate_brief(brief, topic)
        print(json.dumps({
            "topic_id": topic["id"],
            "research_path": str(research_path),
            "cache_hit": True,
            "estimated_cost_usd": float(brief.get("estimated_cost_usd") or 0),
        }, indent=2))
        return

    # If a paid call previously completed but validation/parsing failed, recover it for free.
    if snapshot_path.exists():
        snapshot = load_json(snapshot_path)
        try:
            brief = parse_snapshot(snapshot)
            validate_brief(brief, topic)
            usage = snapshot.get("usage") or {}
            model = str(snapshot.get("model") or os.getenv("ANTHROPIC_RESEARCH_MODEL") or "claude-haiku-4-5-20251001")
            brief["research_model"] = model
            brief["anthropic_usage"] = usage
            brief["estimated_cost_usd"] = estimate_cost_usd(model, usage)
            brief["recovered_from_paid_response"] = True
            brief["researched_at"] = datetime.now(timezone.utc).isoformat()
            write_research(brief, cache_dir)
            print(json.dumps({
                "topic_id": topic["id"],
                "research_path": str(research_path),
                "cache_hit": True,
                "recovered_response": True,
                "estimated_cost_usd": brief["estimated_cost_usd"],
            }, indent=2))
            return
        except Exception as exc:
            raise RuntimeError(
                "A previous paid Haiku response exists but could not be recovered. "
                "Refusing to spend again automatically. Fix/review the cached response or rerun explicitly with --force-new-research."
            ) from exc

    model = os.getenv("ANTHROPIC_RESEARCH_MODEL", "claude-haiku-4-5-20251001").strip() or "claude-haiku-4-5-20251001"
    max_cost = float(os.getenv("ANTHROPIC_RESEARCH_MAX_USD", "0.030"))
    client = Anthropic(api_key=required_env("ANTHROPIC_API_KEY"), max_retries=0)
    response = client.messages.create(
        model=model,
        max_tokens=1300,
        tools=[
            {
                "type": "web_search_20260318",
                "name": "web_search",
                "max_uses": 1,
                "allowed_callers": ["direct"],
                "user_location": {
                    "type": "approximate",
                    "country": "US",
                    "timezone": "America/New_York",
                },
            },
            RESEARCH_TOOL,
        ],
        messages=[{"role": "user", "content": build_prompt(topic)}],
    )

    # Save the distilled paid response BEFORE parsing/validation so a code failure never forces a second paid call.
    cache_dir.mkdir(parents=True, exist_ok=True)
    snapshot = safe_response_snapshot(response, {RESEARCH_TOOL_NAME})
    snapshot_path.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2), encoding="utf-8")

    brief = parse_snapshot(snapshot)
    validate_brief(brief, topic)
    usage = usage_dict(response)
    cost = estimate_cost_usd(model, usage)
    brief["research_model"] = model
    brief["anthropic_usage"] = usage
    brief["estimated_cost_usd"] = cost
    brief["researched_at"] = datetime.now(timezone.utc).isoformat()
    write_research(brief, cache_dir)

    if usage.get("web_search_requests", 0) > 1:
        raise RuntimeError(f"Research exceeded one web search: {usage['web_search_requests']}")
    if cost > max_cost:
        raise RuntimeError(
            f"Research cost guard tripped: ${cost:.4f} > ${max_cost:.4f}. "
            "The research is cached; Sonnet will not be called automatically."
        )

    print(json.dumps({
        "topic_id": topic["id"],
        "research_path": str(research_path),
        "cache_hit": False,
        "model": model,
        "anthropic_usage": usage,
        "estimated_cost_usd": cost,
    }, indent=2))


if __name__ == "__main__":
    main()
