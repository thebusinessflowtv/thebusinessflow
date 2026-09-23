from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path

from production.anthropic_budget import estimate_cost_usd
from production.research_episode import (
    CACHE_ROOT,
    normalize_brief_sources,
    parse_snapshot,
    select_topic,
    valid_http_url,
    write_research,
)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--topic-id", required=True)
    parser.add_argument("--min-sources", type=int, default=2)
    args = parser.parse_args()

    topic = select_topic(args.topic_id)
    cache_dir = CACHE_ROOT / str(topic["id"])
    research_path = cache_dir / "research.json"
    snapshot_path = cache_dir / "haiku-response.json"

    # This helper is intentionally recovery-only: it never calls Anthropic.
    if research_path.exists():
        brief = json.loads(research_path.read_text(encoding="utf-8"))
    else:
        if not snapshot_path.exists():
            raise RuntimeError(f"No paid Haiku snapshot available for recovery: {snapshot_path}")
        snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
        brief = parse_snapshot(snapshot)
        normalize_brief_sources(brief)

        usage = snapshot.get("usage") or {}
        model = str(snapshot.get("model") or os.getenv("ANTHROPIC_RESEARCH_MODEL") or "claude-haiku-4-5-20251001")
        brief["research_model"] = model
        brief["anthropic_usage"] = usage
        brief["estimated_cost_usd"] = estimate_cost_usd(model, usage)
        brief["recovered_from_paid_response"] = True
        brief["recovery_mode"] = "existing_paid_snapshot_no_second_api_call"
        brief["researched_at"] = datetime.now(timezone.utc).isoformat()

    facts = brief.get("facts") or []
    sources = brief.get("sources") or []
    if len(facts) < 6:
        raise RuntimeError(f"Recovered research needs at least 6 facts; got {len(facts)}")
    if len(sources) < args.min_sources:
        raise RuntimeError(f"Recovered research needs at least {args.min_sources} distinct sources; got {len(sources)}")

    source_urls = {valid_http_url(s.get("url")) for s in sources if isinstance(s, dict)}
    source_urls.discard("")
    if len(source_urls) < args.min_sources:
        raise RuntimeError("Recovered research does not contain enough valid HTTP(S) source URLs")

    for collection_name in ("facts", "verified_numbers", "timeline"):
        for item in brief.get(collection_name) or []:
            if not isinstance(item, dict):
                continue
            url = valid_http_url(item.get("source_url"))
            if not url:
                raise RuntimeError(f"Recovered {collection_name} entry has an invalid source URL")
            if url not in source_urls:
                # normalize_brief_sources may expose an extra cited URL that was omitted
                # from the original top-level source index. Add it rather than inventing evidence.
                if len(sources) < 4:
                    sources.append({"title": url.split('/')[2], "url": url, "source_type": "web"})
                    source_urls.add(url)
                else:
                    raise RuntimeError(f"Recovered {collection_name} entry cites a URL outside the source index")

    # Preserve only already-cited evidence; no new source or claim is invented here.
    brief["sources"] = sources[:4]
    brief["topic_id"] = topic["id"]
    brief["topic"] = topic["topic"]
    brief["source_count_recovered"] = len(brief["sources"])
    write_research(brief, cache_dir)

    print(json.dumps({
        "topic_id": topic["id"],
        "topic": topic["topic"],
        "research_path": str(research_path),
        "source_count": len(brief["sources"]),
        "fact_count": len(facts),
        "estimated_cost_usd": float(brief.get("estimated_cost_usd") or 0),
        "new_anthropic_calls": 0,
    }, indent=2))


if __name__ == "__main__":
    main()
