from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any

try:
    from production.generate_episode import (
        PACKAGE_CACHE_ROOT,
        RESEARCH_ROOT,
        finalize_package,
        load_json,
        parse_snapshot,
        select_topic,
        write_outputs,
    )
except ModuleNotFoundError:
    from generate_episode import (
        PACKAGE_CACHE_ROOT,
        RESEARCH_ROOT,
        finalize_package,
        load_json,
        parse_snapshot,
        select_topic,
        write_outputs,
    )

ROOT = Path(__file__).resolve().parents[1]
OVERRIDE_ROOT = ROOT / "production" / "recovery-overrides"


def deterministic_tags(topic: dict[str, Any], research: dict[str, Any]) -> list[str]:
    brand = str(topic.get("topic") or "Business").strip()
    tags = [
        brand,
        f"{brand} business model",
        f"how {brand} makes money",
        "business documentary",
        "business strategy",
        "corporate strategy",
        "The Business Flow",
    ]
    thesis = str(research.get("thesis") or "").lower()
    for keyword in ["AWS", "advertising", "marketplace", "Prime", "cloud computing", "retail", "subscriptions"]:
        if keyword.lower() in thesis and keyword not in tags:
            tags.append(keyword)
    return tags[:15]


def apply_curated_script_insert(script: str, topic_id: str) -> tuple[str, bool]:
    path = OVERRIDE_ROOT / f"{topic_id}-script-insert.txt"
    if not path.exists():
        return script, False
    insert = path.read_text(encoding="utf-8").strip()
    if not insert:
        return script, False

    markers = [
        "So why does this matter?",
        "Put it all together,",
        "None of this means",
    ]
    for marker in markers:
        idx = script.find(marker)
        if idx >= 0:
            return script[:idx].rstrip() + "\n\n" + insert + "\n\n" + script[idx:].lstrip(), True
    return script.rstrip() + "\n\n" + insert, True


def repair_package(package: dict[str, Any], topic: dict[str, Any], research: dict[str, Any]) -> dict[str, Any]:
    repaired = dict(package)

    # Claude can occasionally serialize the next tool parameter into the previous string.
    # Recover that locally instead of paying for another model call.
    description = str(repaired.get("description") or "").strip()
    if not repaired.get("tags") and description:
        patterns = [
            r'</description>\s*\\?n?\s*<parameter\s+name=["\']tags["\']>\s*(\[[\s\S]*?\])',
            r'<parameter\s+name=["\']tags["\']>\s*(\[[\s\S]*?\])',
        ]
        for pattern in patterns:
            match = re.search(pattern, description, flags=re.IGNORECASE)
            if match:
                try:
                    value = json.loads(match.group(1))
                    if isinstance(value, list) and value:
                        repaired["tags"] = [str(x).strip() for x in value if str(x).strip()]
                        break
                except json.JSONDecodeError:
                    pass

    if "</description>" in description:
        description = description.split("</description>", 1)[0].strip()
    description = re.sub(r'<parameter\s+name=["\']tags["\']>[\s\S]*$', '', description, flags=re.IGNORECASE).strip()
    repaired["description"] = description

    if not repaired.get("tags"):
        repaired["tags"] = deterministic_tags(topic, research)

    if not repaired.get("description"):
        title = str(repaired.get("selected_title") or topic.get("topic") or "The Business Flow")
        repaired["description"] = f"{title}. A data-driven business documentary from The Business Flow."

    script = str(repaired.get("script") or "").strip()
    if len(script.split()) < 1750:
        script, inserted = apply_curated_script_insert(script, str(topic["id"]))
        if inserted:
            repaired["script"] = script
            repaired["local_recovery_note"] = "Paid Sonnet draft was short; a curated source-backed local insert was applied without another API call."

    return repaired


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--topic-id", required=True)
    args = parser.parse_args()

    topic = select_topic(args.topic_id)
    topic_id = str(topic["id"])
    research_path = RESEARCH_ROOT / topic_id / "research.json"
    snapshot_path = PACKAGE_CACHE_ROOT / topic_id / "sonnet-response.json"
    package_path = PACKAGE_CACHE_ROOT / topic_id / "episode-package.json"

    if not research_path.exists():
        raise RuntimeError(f"Missing cached research: {research_path}")
    if not snapshot_path.exists():
        raise RuntimeError(f"Missing paid Sonnet snapshot: {snapshot_path}")

    research = load_json(research_path)
    snapshot = load_json(snapshot_path)
    package = parse_snapshot(snapshot)
    package = repair_package(package, topic, research)
    model = str(snapshot.get("model") or "claude-sonnet-5")
    package = finalize_package(package, topic, research, snapshot.get("usage") or {}, model)

    package_path.parent.mkdir(parents=True, exist_ok=True)
    package_path.write_text(json.dumps(package, ensure_ascii=False, indent=2), encoding="utf-8")
    output_dir = write_outputs(package)

    print(json.dumps({
        "topic_id": topic_id,
        "recovered_without_api": True,
        "selected_title": package["selected_title"],
        "script_word_count": package["script_word_count"],
        "tags": package["tags"],
        "anthropic_usage": package["anthropic_usage"],
        "anthropic_cost": package["anthropic_cost"],
        "local_recovery_note": package.get("local_recovery_note"),
        "output_dir": str(output_dir),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
