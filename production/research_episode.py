from __future__ import annotations

import argparse
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

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
                "minItems": 6,
                "maxItems": 6,
                "items": {
                    "type": "object",
                    "properties": {
                        "claim": {"type": "string"},
                        "source_url": {"type": "string"},
                        "safe_for_packaging": {"type": "boolean"},
                    },
                    "required": ["claim", "source_url", "safe_for_packaging"],
                    "additionalProperties": False,
                },
            },
            "verified_numbers": {
                "type": "array",
                "maxItems": 4,
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
                "maxItems": 4,
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
                "minItems": 4,
                "maxItems": 4,
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
            "risk_flags": {"type": "array", "maxItems": 2, "items": {"type": "string"}},
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


def valid_http_url(value: Any) -> str:
    url = str(value or "").strip()
    return url if url.startswith(("http://", "https://")) else ""


def source_label(url: str) -> str:
    try:
        host = (urlparse(url).hostname or "").lower()
    except Exception:
        host = ""
    if host.startswith("www."):
        host = host[4:]
    return host or "Source"


def normalize_brief_sources(brief: dict[str, Any]) -> bool:
    """Repair a paid brief only from source URLs the model already cited.

    Haiku can occasionally return a valid six-fact payload while leaving the
    top-level `sources` array empty. The facts/numbers/timeline still contain
    the URLs required by the schema. Rebuilding the source index from those
    already-cited URLs avoids a second paid call without inventing evidence.
    """
    changed = False
    ordered: dict[str, dict[str, str]] = {}

    raw_sources = brief.get("sources")
    if not isinstance(raw_sources, list):
        raw_sources = []
        changed = True

    for source in raw_sources:
        if not isinstance(source, dict):
            changed = True
            continue
        url = valid_http_url(source.get("url"))
        if not url:
            changed = True
            continue
        title = str(source.get("title") or "").strip() or source_label(url)
        source_type = str(source.get("source_type") or "").strip() or "web"
        if title != str(source.get("title") or "").strip() or source_type != str(source.get("source_type") or "").strip():
            changed = True
        ordered.setdefault(url, {"title": title, "url": url, "source_type": source_type})

    for collection_name in ("facts", "verified_numbers", "timeline"):
        collection = brief.get(collection_name) or []
        if not isinstance(collection, list):
            continue
        for item in collection:
            if not isinstance(item, dict):
                continue
            url = valid_http_url(item.get("source_url"))
            if not url or url in ordered:
                continue
            ordered[url] = {
                "title": source_label(url),
                "url": url,
                "source_type": "web",
            }
            changed = True

    normalized = list(ordered.values())[:4]
    if normalized != raw_sources:
        brief["sources"] = normalized
        changed = True

    return changed


def validate_brief(brief: dict[str, Any], topic: dict[str, Any]) -> None:
    normalize_brief_sources(brief)
    if not str(brief.get("thesis") or "").strip():
        raise RuntimeError("Research brief is missing thesis")
    facts = brief.get("facts") or []
    sources = brief.get("sources") or []
    if len(facts) < 6:
        raise RuntimeError(f"Research brief needs at least 6 sourced facts; got {len(facts)}")
    if len(sources) < 3:
        cited_urls = []
        for collection_name in ("facts", "verified_numbers", "timeline"):
            for item in brief.get(collection_name) or []:
                if isinstance(item, dict):
                    url = valid_http_url(item.get("source_url"))
                    if url and url not in cited_urls:
                        cited_urls.append(url)
        raise RuntimeError(
            f"Research brief needs at least 3 sources; got {len(sources)}. "
            f"Recoverable distinct cited URLs: {len(cited_urls)}"
        )
    urls = [valid_http_url(s.get("url")) for s in sources if isinstance(s, dict)]
    if len(urls) < 3 or any(not url for url in urls):
        raise RuntimeError("Research brief contains an invalid source URL")
    brief["topic_id"] = topic["id"]
    brief["topic"] = topic["topic"]


def enforce_research_budget(cost: float, max_cost: float, *, already_paid: bool = False) -> None:
    if cost <= max_cost:
        return
    if already_paid:
        total_budget = float(os.getenv("ANTHROPIC_TOTAL_BUDGET_USD", "0.080"))
        if cost >= total_budget:
            raise RuntimeError(
                f"Cached research alone costs ${cost:.4f}, which leaves no room inside the ${total_budget:.4f} total budget."
            )
        print(
            f"WARNING: cached/recovered research cost ${cost:.4f} exceeded the ${max_cost:.4f} research target. "
            "No new research call will be made; the total episode budget guard remains active."
        )
        return
    raise RuntimeError(
        f"Research cost guard: research cost ${cost:.4f} exceeds ${max_cost:.4f}. "
        "The paid result is preserved; do not retry the paid research automatically."
    )


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

STRICT COST / OUTPUT RULES
- Perform AT MOST ONE web search total. Never perform a second search.
- Do not narrate your process before or after searching.
- Make the one search broad and information-dense, prioritizing the company's latest annual report/SEC filing, investor relations, official documentation and reputable financial reporting.
- After the search, call {RESEARCH_TOOL_NAME} immediately and exactly once.
- Keep the tool payload extremely compact: thesis <= 60 words; exactly 6 factual claims, each <= 32 words; exactly 4 sources; at most 4 verified numbers; at most 4 timeline entries; at most 2 short risk flags.
- The `sources` array MUST contain exactly four distinct HTTP(S) URLs.
- Every facts[].source_url, verified_numbers[].source_url and timeline[].source_url MUST match one of those four sources[].url values.
- Do not repeat source titles/types inside each fact. Facts need only claim, source_url and safe_for_packaging.

RESEARCH RULES
- Treat the seed angle as a hypothesis, not a fact.
- Prefer annual reports, SEC/regulator/court/official sources and established financial journalism.
- Use only claims directly supported by the cited URL.
- Mark safe_for_packaging=true only when the cited source directly supports title/thumbnail/hook use.
- Do not infer crimes, fraud, motives or causation beyond evidence.
- If a dramatic claim cannot be supported within the single-search budget, omit it rather than spending another search.
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
    max_cost = float(os.getenv("ANTHROPIC_RESEARCH_MAX_USD", "0.030"))

    if args.force_new_research:
        research_path.unlink(missing_ok=True)
        snapshot_path.unlink(missing_ok=True)

    if research_path.exists():
        brief = load_json(research_path)
        repaired = normalize_brief_sources(brief)
        validate_brief(brief, topic)
        if repaired:
            write_research(brief, cache_dir)
        cost = float(brief.get("estimated_cost_usd") or 0)
        enforce_research_budget(cost, max_cost, already_paid=True)
        print(json.dumps({
            "topic_id": topic["id"],
            "research_path": str(research_path),
            "cache_hit": True,
            "source_index_repaired": repaired,
            "estimated_cost_usd": cost,
        }, indent=2))
        return

    # If a paid call previously completed but validation/parsing failed, recover it for free.
    if snapshot_path.exists():
        snapshot = load_json(snapshot_path)
        try:
            brief = parse_snapshot(snapshot)
            repaired = normalize_brief_sources(brief)
            validate_brief(brief, topic)
            usage = snapshot.get("usage") or {}
            model = str(snapshot.get("model") or os.getenv("ANTHROPIC_RESEARCH_MODEL") or "claude-haiku-4-5-20251001")
            cost = estimate_cost_usd(model, usage)
            brief["research_model"] = model
            brief["anthropic_usage"] = usage
            brief["estimated_cost_usd"] = cost
            brief["recovered_from_paid_response"] = True
            brief["source_index_repaired"] = repaired
            brief["researched_at"] = datetime.now(timezone.utc).isoformat()
            write_research(brief, cache_dir)
            enforce_research_budget(cost, max_cost, already_paid=True)
            print(json.dumps({
                "topic_id": topic["id"],
                "research_path": str(research_path),
                "cache_hit": True,
                "recovered_response": True,
                "source_index_repaired": repaired,
                "estimated_cost_usd": cost,
            }, indent=2))
            return
        except RuntimeError:
            raise
        except Exception as exc:
            raise RuntimeError(
                "A previous paid Haiku response exists but could not be recovered. "
                "Refusing to spend again automatically. Fix/review the cached response or rerun explicitly with --force-new-research."
            ) from exc

    model = os.getenv("ANTHROPIC_RESEARCH_MODEL", "claude-haiku-4-5-20251001").strip() or "claude-haiku-4-5-20251001"
    client = Anthropic(api_key=required_env("ANTHROPIC_API_KEY"), max_retries=0)
    response = client.messages.create(
        model=model,
        max_tokens=1500,
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
    repaired = normalize_brief_sources(brief)
    validate_brief(brief, topic)
    usage = usage_dict(response)
    cost = estimate_cost_usd(model, usage)
    brief["research_model"] = model
    brief["anthropic_usage"] = usage
    brief["estimated_cost_usd"] = cost
    brief["source_index_repaired"] = repaired
    brief["researched_at"] = datetime.now(timezone.utc).isoformat()
    write_research(brief, cache_dir)

    if usage.get("web_search_requests", 0) > 1:
        raise RuntimeError(f"Research exceeded one web search: {usage['web_search_requests']}")
    enforce_research_budget(cost, max_cost, already_paid=True)

    print(json.dumps({
        "topic_id": topic["id"],
        "research_path": str(research_path),
        "cache_hit": False,
        "model": model,
        "anthropic_usage": usage,
        "source_index_repaired": repaired,
        "estimated_cost_usd": cost,
    }, indent=2))


if __name__ == "__main__":
    main()
