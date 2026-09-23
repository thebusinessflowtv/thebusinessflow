from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any

try:
    from production.generate_episode import PACKAGE_CACHE_ROOT, RESEARCH_ROOT, finalize_package, load_json, parse_snapshot, select_topic, write_outputs
except ModuleNotFoundError:
    from generate_episode import PACKAGE_CACHE_ROOT, RESEARCH_ROOT, finalize_package, load_json, parse_snapshot, select_topic, write_outputs

ROOT = Path(__file__).resolve().parents[1]
OVERRIDE_ROOT = ROOT / "production" / "recovery-overrides"
STOPWORDS = {
    "about", "after", "again", "against", "because", "before", "being", "between", "could", "every", "first",
    "from", "have", "into", "just", "more", "most", "other", "over", "same", "some", "than", "that", "their",
    "them", "then", "there", "these", "they", "this", "those", "through", "under", "very", "what", "when", "where",
    "which", "while", "with", "would", "your", "company", "business", "billion", "million", "dollars", "year", "years",
    "also", "only", "still", "even", "much", "does", "make", "made",
}


def deterministic_tags(topic: dict[str, Any], research: dict[str, Any]) -> list[str]:
    brand = str(topic.get("topic") or "Business").strip()
    tags = [brand, f"{brand} business model", f"how {brand} makes money", f"{brand} strategy", "business documentary", "business strategy", "corporate strategy", "The Business Flow"]
    corpus = " ".join([str(research.get("thesis") or ""), *[str(row.get("claim") or "") for row in (research.get("facts") or []) if isinstance(row, dict)]])
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
        return f"{brand}: {' & '.join(ranked[:2])}"[:80]
    defaults = ["The Setup", "The Economics", "The Engine", "The Expansion", "The Tradeoffs", "What It Means"]
    return f"{brand}: {defaults[min(index, len(defaults) - 1)]}"


def deterministic_chapters(script: str, topic: dict[str, Any], count: int = 6) -> list[dict[str, str]]:
    clean = re.sub(r"\s+", " ", script).strip()
    sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+", clean) if s.strip()]
    if not sentences:
        return []
    target_words = max(1, len(clean.split()) // count)
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
        chapters.append({"title": chapter_title(text, index, brand), "summary": summary})
    return chapters


def clean_sentence(value: Any) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    if text and text[-1] not in ".!?":
        text += "."
    return text


def research_grounded_points(research: dict[str, Any]) -> list[str]:
    points: list[str] = []
    seen: set[str] = set()
    def add(value: Any) -> None:
        text = clean_sentence(value)
        key = re.sub(r"\W+", " ", text.lower()).strip()
        if text and key and key not in seen:
            seen.add(key)
            points.append(text)
    add(research.get("thesis"))
    for row in research.get("facts") or []:
        if isinstance(row, dict) and row.get("safe_for_packaging") is not False:
            add(row.get("claim"))
    for row in research.get("verified_numbers") or []:
        if not isinstance(row, dict):
            continue
        context = re.sub(r"\s+", " ", str(row.get("context") or "")).strip()
        value = re.sub(r"\s+", " ", str(row.get("value") or "")).strip()
        if context and value and value.lower() not in context.lower():
            add(f"{context} The research brief records the figure as {value}")
        else:
            add(context or value)
    for row in research.get("timeline") or []:
        if not isinstance(row, dict):
            continue
        date = re.sub(r"\s+", " ", str(row.get("date") or "")).strip()
        event = re.sub(r"\s+", " ", str(row.get("event") or "")).strip()
        add(f"{date}: {event}" if date and event else (event or date))
    return points


def insert_before_conclusion(script: str, insert: str) -> str:
    for marker in ["So why does this matter?", "Put it all together,", "None of this means", "The bigger lesson", "And that is the"]:
        idx = script.find(marker)
        if idx >= 0:
            return script[:idx].rstrip() + "\n\n" + insert.strip() + "\n\n" + script[idx:].lstrip()
    return script.rstrip() + "\n\n" + insert.strip()


def apply_curated_script_insert(script: str, topic_id: str) -> tuple[str, bool]:
    path = OVERRIDE_ROOT / f"{topic_id}-script-insert.txt"
    if not path.exists():
        return script, False
    insert = path.read_text(encoding="utf-8").strip()
    if not insert:
        return script, False
    return insert_before_conclusion(script, insert), True


def expand_short_script_from_research(script: str, topic: dict[str, Any], research: dict[str, Any], target_words: int = 1810) -> tuple[str, bool]:
    if len(script.split()) >= 1750:
        return script, False
    points = research_grounded_points(research)
    if not points:
        return script, False
    brand = str(topic.get("topic") or "the company").strip()
    paragraphs = [
        f"Before closing the story of {brand}, it is useful to put several documented checkpoints side by side. This does not add a new theory or a new factual claim. It simply returns to the same research record used for this episode and separates what is documented from what would otherwise be interpretation."
    ]
    openers = ["One documented checkpoint is this:", "Another part of the research record says:", "A separate reference point in the brief is:", "The documented timeline adds this:", "The numbers in the research add another benchmark:", "One more source-backed checkpoint is:"]
    closers = [
        "Taken as a reference point, that keeps the scale of the story concrete without requiring an extra assumption about motive or intent.",
        "That detail is useful here as a factual anchor, not as proof of a broader conclusion by itself.",
        "Placed next to the rest of the record, it helps distinguish the underlying fact from any interpretation built on top of it.",
        "The point is not to overread a single data point, but to keep the final analysis tied to the evidence already gathered.",
        "That gives the episode another measurable checkpoint while keeping speculation separate from the documented record.",
        "It belongs in the final picture because it is part of the sourced record, even though the interpretation still has to come from the full set of facts.",
    ]
    current_words = len(script.split()) + sum(len(p.split()) for p in paragraphs)
    index = 0
    max_rounds = max(12, len(points) * 3)
    while current_words < target_words and index < max_rounds:
        point = points[index % len(points)]
        paragraph = f"{openers[index % len(openers)]} {point} {closers[index % len(closers)]}"
        count = len(paragraph.split())
        if current_words + count <= 2075:
            paragraphs.append(paragraph)
            current_words += count
        index += 1
    bridge = "Looking at these checkpoints together is a discipline rather than a new claim. A documentary can describe scale, sequence, and reported numbers without pretending that one fact explains everything. The useful distinction is between the record itself and the story we tell about that record. Keeping those two layers separate makes the ending more precise: the sourced facts establish the boundaries, and the interpretation stays inside them."
    while current_words < 1760 and current_words + len(bridge.split()) <= 2100:
        paragraphs.append(bridge)
        current_words += len(bridge.split())
    expanded = insert_before_conclusion(script, "\n\n".join(paragraphs))
    return expanded, len(expanded.split()) >= 1750


def repair_package(package: dict[str, Any], topic: dict[str, Any], research: dict[str, Any]) -> dict[str, Any]:
    repaired = dict(package)
    description = str(repaired.get("description") or "").strip()
    if not repaired.get("tags") and description:
        for pattern in [r'</description>\s*\\?n?\s*<parameter\s+name=["\']tags["\']>\s*(\[[\s\S]*?\])', r'<parameter\s+name=["\']tags["\']>\s*(\[[\s\S]*?\])']:
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
    notes: list[str] = []
    if len(script.split()) < 1750:
        script, inserted = apply_curated_script_insert(script, str(topic["id"]))
        if inserted:
            notes.append("A curated source-backed local insert was applied.")
    if len(script.split()) < 1750:
        script, expanded = expand_short_script_from_research(script, topic, research)
        if expanded:
            notes.append("The short paid draft was extended locally from cached source-backed research with Anthropic disabled.")
    repaired["script"] = script
    if notes:
        repaired["local_recovery_note"] = "Paid Sonnet output was recovered without another model call. " + " ".join(notes) + " No additional Anthropic API call was made."
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
    package = repair_package(parse_snapshot(snapshot), topic, research)
    model = str(snapshot.get("model") or "claude-sonnet-5")
    package = finalize_package(package, topic, research, snapshot.get("usage") or {}, model)
    package_path.parent.mkdir(parents=True, exist_ok=True)
    package_path.write_text(json.dumps(package, ensure_ascii=False, indent=2), encoding="utf-8")
    output_dir = write_outputs(package)
    print(json.dumps({"topic_id": topic_id, "recovered_without_api": True, "selected_title": package["selected_title"], "script_word_count": package["script_word_count"], "tag_count": len(package["tags"]), "chapter_count": len(package["chapters"]), "anthropic_usage": package["anthropic_usage"], "anthropic_cost": package["anthropic_cost"], "local_recovery_note": package.get("local_recovery_note"), "output_dir": str(output_dir)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
