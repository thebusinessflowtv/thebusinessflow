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
STOPWORDS = {
    "about", "after", "again", "against", "because", "before", "being", "between", "could", "every",
    "first", "from", "have", "into", "just", "more", "most", "other", "over", "same", "some", "than",
    "that", "their", "them", "then", "there", "these", "they", "this", "those", "through", "under", "very",
    "what", "when", "where", "which", "while", "with", "would", "your", "company", "business", "billion",
    "million", "dollars", "year", "years", "also", "only", "still", "even", "much", "does", "make", "made",
}


def deterministic_tags(topic: dict[str, Any], research: dict[str, Any]) -> list[str]:
    brand = str(topic.get("topic") or "Business").strip()
    tags = [
        brand,
        f"{brand} business model",
        f"how {brand} makes money",
        f"{brand} strategy",
        "business documentary",
        "business strategy",
        "corporate strategy",
        "The Business Flow",
    ]
    corpus = " ".join([
        str(research.get("thesis") or ""),
        *[str(row.get("claim") or "") for row in (research.get("facts") or [])],
    ])
    # Add a few distinctive researched terms without an extra AI call.
    candidates = re.findall(r"\b[A-Za-z][A-Za-z0-9-]{3,}\b", corpus)
    counts: dict[str, int] = {}
    original: dict[str, str] = {}
    for word in candidates:
        low = word.lower()
        if low in STOPWORDS or low == brand.lower():
            continue
        counts[low] = counts.get(low, 0) + 1
        original.setdefault(low, word)
    for low, _ in sorted(counts.items(), key=lambda pair: (-pair[1], pair[0])):
        value = original[low]
        if value not in tags:
            tags.append(value)
        if len(tags) >= 15:
            break
    return tags[:15]


def chapter_title(text: str, index: int, brand: str) -> str:
    words = re.findall(r"\b[A-Za-z][A-Za-z0-9'-]{3,}\b", text)
    counts: dict[str, int] = {}
    original: dict[str, str] = {}
    for word in words:
        low = word.lower()
        if low in STOPWORDS or low == brand.lower():
            continue
        counts[low] = counts.get(low, 0) + 1
        original.setdefault(low, word)
    ranked = [original[key] for key, _ in sorted(counts.items(), key=lambda pair: (-pair[1], pair[0]))]
    if ranked:
        phrase = " & ".join(ranked[:2])
        return f"{brand}: {phrase}"[:80]
    defaults = ["The Setup", "The Economics", "The Engine", "The Expansion", "The Tradeoffs", "What It Means"]
    return f"{brand}: {defaults[min(index, len(defaults)-1)]}"


def deterministic_chapters(script: str, topic: dict[str, Any], count: int = 6) -> list[dict[str, str]]:
    """Create concise semantic chapter metadata locally from an already-paid script.

    Chapters are packaging metadata, not new factual content. This deliberately
    avoids repaying Sonnet when a tool payload is truncated after the narration.
    """
    clean = re.sub(r"\s+", " ", script).strip()
    sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+", clean) if s.strip()]
    if not sentences:
        return []

    # Split by approximate word mass so every chapter covers a meaningful section.
    total_words = max(1, len(clean.split()))
    target_words = max(1, total_words // count)
    groups: list[list[str]] = []
    current: list[str] = []
    current_words = 0
    for sentence in sentences:
        words = len(sentence.split())
        if current and current_words >= target_words and len(groups) < count - 1:
            groups.append(current)
            current = []
            current_words = 0
        current.append(sentence)
        current_words += words
    if current:
        groups.append(current)

    # If sentence distribution produced fewer groups, split the longest groups.
    while len(groups) < min(count, len(sentences)):
        idx = max(range(len(groups)), key=lambda i: sum(len(s.split()) for s in groups[i]))
        group = groups[idx]
        if len(group) < 2:
            break
        mid = len(group) // 2
        groups[idx:idx + 1] = [group[:mid], group[mid:]]

    brand = str(topic.get("topic") or "Business").strip()
    chapters: list[dict[str, str]] = []
    for index, group in enumerate(groups[:count]):
        text = " ".join(group)
        summary = " ".join(group[:2]).strip()
        if len(summary) > 220:
            summary = summary[:217].rsplit(" ", 1)[0] + "..."
        chapters.append({
            "title": chapter_title(text, index, brand),
            "summary": summary,
        })
    return chapters


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

    # Claude can occasionally serialize a later tool parameter into the previous string.
    # Recover it locally instead of paying for another model call.
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
    else:
        repaired["script"] = script

    # Chapters contain no new facts; derive them from the already-paid narration.
    # This specifically protects against truncated tool payloads that omit trailing
    # metadata after the expensive script has already been produced.
    if not repaired.get("chapters"):
        repaired["chapters"] = deterministic_chapters(str(repaired.get("script") or ""), topic)
        note = "Missing chapter metadata was rebuilt locally from the paid script; Anthropic API was not called."
        previous = str(repaired.get("local_recovery_note") or "").strip()
        repaired["local_recovery_note"] = f"{previous} {note}".strip()

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
        "tag_count": len(package["tags"]),
        "chapter_count": len(package["chapters"]),
        "anthropic_usage": package["anthropic_usage"],
        "anthropic_cost": package["anthropic_cost"],
        "local_recovery_note": package.get("local_recovery_note"),
        "output_dir": str(output_dir),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
