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

USAGE_KEYS = (
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
    "web_search_requests",
)


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
    """Rebuild the source index only from URLs already present in the brief."""
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
            ordered[url] = {"title": source_label(url), "url": url, "source_type": "web"}
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
        cited_urls: list[str] = []
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
    if len(set(urls)) != len(urls):
        raise RuntimeError("Research brief contains duplicate source URLs")

    allowed = set(urls)
    for collection_name in ("facts", "verified_numbers", "timeline"):
        for item in brief.get(collection_name) or []:
            if not isinstance(item, dict):
                continue
            url = valid_http_url(item.get("source_url"))
            if not url or url not in allowed:
                raise RuntimeError(
                    f"Research brief {collection_name} contains a source URL outside the source index"
                )

    brief["topic_id"] = topic["id"]
    brief["topic"] = topic["topic"]


def merge_usage(*records: dict[str, Any] | None) -> dict[str, int]:
    merged = {key: 0 for key in USAGE_KEYS}
    for record in records:
        for key in USAGE_KEYS:
            merged[key] += int((record or {}).get(key, 0) or 0)
    return merged


def enforce_research_budget(cost: float, max_cost: float, *, already_paid: bool = False) -> None:
    if cost <= max_cost:
        return
    if already_paid:
        total_budget = float(os.getenv("ANTHROPIC_TOTAL_BUDGET_USD", "0.100"))
        if cost >= total_budget:
            raise RuntimeError(
                f"Research costs ${cost:.4f}, which leaves no room inside the ${total_budget:.4f} total episode budget."
            )
        print(
            f"WARNING: research cost ${cost:.4f} exceeded the ${max_cost:.4f} research target. "
            "The paid result is preserved and the total episode budget guard remains active."
        )
        return
    raise RuntimeError(
        f"Research cost guard: research cost ${cost:.4f} exceeds ${max_cost:.4f}. "
        "The paid result is preserved."
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


def initial_search_limit() -> int:
    return max(1, int(os.getenv("ANTHROPIC_RESEARCH_MAX_WEB_SEARCHES", "3")))


def total_search_limit() -> int:
    return max(initial_search_limit(), int(os.getenv("ANTHROPIC_RESEARCH_MAX_TOTAL_WEB_SEARCHES", "4")))


def repair_search_limit() -> int:
    return max(1, int(os.getenv("ANTHROPIC_RESEARCH_REPAIR_WEB_SEARCHES", "2")))


def web_search_tool(max_uses: int) -> dict[str, Any]:
    return {
        "type": "web_search_20260318",
        "name": "web_search",
        "max_uses": max_uses,
        "allowed_callers": ["direct"],
        "user_location": {
            "type": "approximate",
            "country": "US",
            "timezone": "America/New_York",
        },
    }


def build_prompt(topic: dict[str, Any], max_searches: int) -> str:
    return f"""
You are the low-cost research desk for The Business Flow, a US-focused business documentary channel.

TOPIC SEED
{json.dumps(topic, ensure_ascii=False)}

STRICT COST / OUTPUT RULES
- Perform UP TO {max_searches} web searches total. Stop early as soon as you have enough evidence.
- Search deliberately: first favor primary/official/SEC/IR evidence, then reputable financial/news reporting, then use a targeted gap-filling search only if needed.
- You need four distinct, useful HTTP(S) source URLs for the final brief. Do not waste searches repeating the same domain/page when stronger independent evidence is available.
- After research, call {RESEARCH_TOOL_NAME} immediately and exactly once.
- Keep the tool payload compact: thesis <= 60 words; exactly 6 factual claims, each <= 32 words; exactly 4 distinct sources; at most 4 verified numbers; at most 4 timeline entries; at most 2 short risk flags.
- Every facts[].source_url, verified_numbers[].source_url and timeline[].source_url MUST exactly match one of sources[].url.
- Do not narrate your process before or after searching.

RESEARCH RULES
- Treat the seed angle as a hypothesis, not a fact.
- Prefer annual reports, SEC/regulator/court/official sources and established financial journalism.
- Use only claims directly supported by the cited URL.
- Mark safe_for_packaging=true only when the cited source directly supports title/thumbnail/hook use.
- Do not infer crimes, fraud, motives or causation beyond evidence.
- If a dramatic claim cannot be supported, omit or soften it rather than inventing evidence.
""".strip()


def build_repair_prompt(
    topic: dict[str, Any],
    prior_brief: dict[str, Any],
    validation_error: str,
    max_searches: int,
) -> str:
    return f"""
You are repairing an already-paid research brief for The Business Flow. The prior brief failed local validation.

TOPIC SEED
{json.dumps(topic, ensure_ascii=False)}

VALIDATION ERROR
{validation_error}

PRIOR BRIEF
{json.dumps(prior_brief, ensure_ascii=False)}

REPAIR RULES
- Preserve supported claims from the prior brief whenever possible; do not start the story over unnecessarily.
- Perform UP TO {max_searches} targeted web searches only to fill the missing evidence/source gaps.
- Prefer primary/official/SEC/IR evidence and reputable financial/news reporting.
- Return a COMPLETE corrected brief by calling {RESEARCH_TOOL_NAME} exactly once.
- The corrected brief MUST contain exactly 6 sourced facts and exactly 4 DISTINCT HTTP(S) source URLs.
- Every fact/number/timeline source_url MUST exactly match one of those four source URLs.
- Replace or remove any claim that cannot be supported. Do not invent a URL or infer bankruptcy, fraud, collapse, motive, or causation beyond the evidence.
- Do not narrate the repair process.
""".strip()


def write_research(brief: dict[str, Any], cache_dir: Path) -> Path:
    cache_dir.mkdir(parents=True, exist_ok=True)
    path = cache_dir / "research.json"
    path.write_text(json.dumps(brief, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def annotate_brief(
    brief: dict[str, Any],
    topic: dict[str, Any],
    model: str,
    usage: dict[str, int],
    *,
    repaired_source_index: bool,
    recovered: bool,
    repair_used: bool,
    repair_reason: str = "",
) -> dict[str, Any]:
    validate_brief(brief, topic)
    cost = estimate_cost_usd(model, usage)
    brief["research_model"] = model
    brief["anthropic_usage"] = usage
    brief["estimated_cost_usd"] = cost
    brief["source_index_repaired"] = repaired_source_index
    brief["recovered_from_paid_response"] = recovered
    brief["research_repair_used"] = repair_used
    if repair_reason:
        brief["research_repair_reason"] = repair_reason
    brief["researched_at"] = datetime.now(timezone.utc).isoformat()
    return brief


def paid_research_call(client: Anthropic, model: str, prompt: str, max_searches: int):
    return client.messages.create(
        model=model,
        max_tokens=1500,
        tools=[web_search_tool(max_searches), RESEARCH_TOOL],
        messages=[{"role": "user", "content": prompt}],
    )


def repair_invalid_brief(
    *,
    client: Anthropic,
    model: str,
    topic: dict[str, Any],
    cache_dir: Path,
    prior_brief: dict[str, Any],
    prior_usage: dict[str, Any],
    validation_error: str,
    max_cost: float,
) -> dict[str, Any]:
    repair_snapshot_path = cache_dir / "haiku-repair-response.json"
    prior_usage_clean = merge_usage(prior_usage)

    if repair_snapshot_path.exists():
        repair_snapshot = load_json(repair_snapshot_path)
        repair_brief = parse_snapshot(repair_snapshot)
        repaired_index = normalize_brief_sources(repair_brief)
        combined_usage = merge_usage(prior_usage_clean, repair_snapshot.get("usage") or {})
        final = annotate_brief(
            repair_brief,
            topic,
            model,
            combined_usage,
            repaired_source_index=repaired_index,
            recovered=True,
            repair_used=True,
            repair_reason=validation_error,
        )
        if combined_usage["web_search_requests"] > total_search_limit():
            raise RuntimeError("Recovered research repair exceeded the total web-search limit")
        write_research(final, cache_dir)
        enforce_research_budget(float(final["estimated_cost_usd"]), max_cost, already_paid=True)
        return final

    used_searches = int(prior_usage_clean.get("web_search_requests") or 0)
    remaining = total_search_limit() - used_searches
    if remaining <= 0:
        raise RuntimeError(
            f"Cached paid research is invalid ({validation_error}) and already used all "
            f"{total_search_limit()} allowed web searches. Refusing a blind paid retry."
        )

    allowed_repair_searches = min(repair_search_limit(), remaining)
    response = paid_research_call(
        client,
        model,
        build_repair_prompt(topic, prior_brief, validation_error, allowed_repair_searches),
        allowed_repair_searches,
    )

    cache_dir.mkdir(parents=True, exist_ok=True)
    repair_snapshot = safe_response_snapshot(response, {RESEARCH_TOOL_NAME})
    repair_snapshot_path.write_text(json.dumps(repair_snapshot, ensure_ascii=False, indent=2), encoding="utf-8")

    repair_brief = parse_snapshot(repair_snapshot)
    repaired_index = normalize_brief_sources(repair_brief)
    combined_usage = merge_usage(prior_usage_clean, usage_dict(response))
    if combined_usage["web_search_requests"] > total_search_limit():
        raise RuntimeError(
            f"Research repair exceeded web-search cap: {combined_usage['web_search_requests']} > {total_search_limit()}"
        )

    final = annotate_brief(
        repair_brief,
        topic,
        model,
        combined_usage,
        repaired_source_index=repaired_index,
        recovered=False,
        repair_used=True,
        repair_reason=validation_error,
    )
    write_research(final, cache_dir)
    enforce_research_budget(float(final["estimated_cost_usd"]), max_cost, already_paid=True)
    return final


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--topic-id", default=None)
    parser.add_argument("--force-new-research", action="store_true")
    args = parser.parse_args()

    topic = select_topic(args.topic_id)
    cache_dir = CACHE_ROOT / str(topic["id"])
    research_path = cache_dir / "research.json"
    snapshot_path = cache_dir / "haiku-response.json"
    repair_snapshot_path = cache_dir / "haiku-repair-response.json"
    max_cost = float(os.getenv("ANTHROPIC_RESEARCH_MAX_USD", "0.030"))
    model = os.getenv("ANTHROPIC_RESEARCH_MODEL", "claude-haiku-4-5-20251001").strip() or "claude-haiku-4-5-20251001"

    if args.force_new_research:
        research_path.unlink(missing_ok=True)
        snapshot_path.unlink(missing_ok=True)
        repair_snapshot_path.unlink(missing_ok=True)

    if research_path.exists():
        brief = load_json(research_path)
        repaired_index = normalize_brief_sources(brief)
        try:
            validate_brief(brief, topic)
        except RuntimeError as exc:
            client = Anthropic(api_key=required_env("ANTHROPIC_API_KEY"), max_retries=0)
            prior_usage = brief.get("anthropic_usage") or {}
            final = repair_invalid_brief(
                client=client,
                model=model,
                topic=topic,
                cache_dir=cache_dir,
                prior_brief=brief,
                prior_usage=prior_usage,
                validation_error=str(exc),
                max_cost=max_cost,
            )
            print(json.dumps({
                "topic_id": topic["id"],
                "research_path": str(research_path),
                "cache_hit": True,
                "research_repair_used": True,
                "sources": len(final.get("sources") or []),
                "anthropic_usage": final.get("anthropic_usage"),
                "estimated_cost_usd": final.get("estimated_cost_usd"),
            }, indent=2))
            return

        if repaired_index:
            write_research(brief, cache_dir)
        cost = float(brief.get("estimated_cost_usd") or 0)
        enforce_research_budget(cost, max_cost, already_paid=True)
        print(json.dumps({
            "topic_id": topic["id"],
            "research_path": str(research_path),
            "cache_hit": True,
            "source_index_repaired": repaired_index,
            "sources": len(brief.get("sources") or []),
            "estimated_cost_usd": cost,
        }, indent=2))
        return

    client = Anthropic(api_key=required_env("ANTHROPIC_API_KEY"), max_retries=0)

    if snapshot_path.exists():
        snapshot = load_json(snapshot_path)
        brief = parse_snapshot(snapshot)
        repaired_index = normalize_brief_sources(brief)
        snapshot_model = str(snapshot.get("model") or model)
        prior_usage = snapshot.get("usage") or {}
        try:
            final = annotate_brief(
                brief,
                topic,
                snapshot_model,
                merge_usage(prior_usage),
                repaired_source_index=repaired_index,
                recovered=True,
                repair_used=False,
            )
            write_research(final, cache_dir)
            enforce_research_budget(float(final["estimated_cost_usd"]), max_cost, already_paid=True)
            print(json.dumps({
                "topic_id": topic["id"],
                "research_path": str(research_path),
                "cache_hit": True,
                "recovered_response": True,
                "sources": len(final.get("sources") or []),
                "estimated_cost_usd": final.get("estimated_cost_usd"),
            }, indent=2))
            return
        except RuntimeError as exc:
            final = repair_invalid_brief(
                client=client,
                model=snapshot_model,
                topic=topic,
                cache_dir=cache_dir,
                prior_brief=brief,
                prior_usage=prior_usage,
                validation_error=str(exc),
                max_cost=max_cost,
            )
            print(json.dumps({
                "topic_id": topic["id"],
                "research_path": str(research_path),
                "cache_hit": True,
                "recovered_response": True,
                "research_repair_used": True,
                "sources": len(final.get("sources") or []),
                "anthropic_usage": final.get("anthropic_usage"),
                "estimated_cost_usd": final.get("estimated_cost_usd"),
            }, indent=2))
            return

    first_limit = min(initial_search_limit(), total_search_limit())
    response = paid_research_call(client, model, build_prompt(topic, first_limit), first_limit)

    cache_dir.mkdir(parents=True, exist_ok=True)
    snapshot = safe_response_snapshot(response, {RESEARCH_TOOL_NAME})
    snapshot_path.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2), encoding="utf-8")

    brief = parse_snapshot(snapshot)
    repaired_index = normalize_brief_sources(brief)
    initial_usage = usage_dict(response)
    if initial_usage["web_search_requests"] > total_search_limit():
        raise RuntimeError(
            f"Research exceeded web-search cap: {initial_usage['web_search_requests']} > {total_search_limit()}"
        )

    try:
        final = annotate_brief(
            brief,
            topic,
            model,
            initial_usage,
            repaired_source_index=repaired_index,
            recovered=False,
            repair_used=False,
        )
        write_research(final, cache_dir)
        enforce_research_budget(float(final["estimated_cost_usd"]), max_cost, already_paid=True)
    except RuntimeError as exc:
        final = repair_invalid_brief(
            client=client,
            model=model,
            topic=topic,
            cache_dir=cache_dir,
            prior_brief=brief,
            prior_usage=initial_usage,
            validation_error=str(exc),
            max_cost=max_cost,
        )

    print(json.dumps({
        "topic_id": topic["id"],
        "research_path": str(research_path),
        "cache_hit": False,
        "model": model,
        "sources": len(final.get("sources") or []),
        "anthropic_usage": final.get("anthropic_usage"),
        "research_repair_used": bool(final.get("research_repair_used")),
        "estimated_cost_usd": final.get("estimated_cost_usd"),
    }, indent=2))


if __name__ == "__main__":
    main()
