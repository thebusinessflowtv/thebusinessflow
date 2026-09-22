from __future__ import annotations

import json
import os
import re
import statistics
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from anthropic import Anthropic
from google.auth.transport.requests import Request as GoogleAuthRequest
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

ROOT = Path(__file__).resolve().parents[1]
TOPICS_PATH = ROOT / "production" / "topics.json"
OUT = ROOT / "production" / "reservoir-output"
TARGET_READY = 50
REFERENCE_CHANNELS = [
    "MagnatesMedia", "Modern MBA", "Company Man", "How Money Works",
    "Wall Street Millennial", "Logically Answered", "ColdFusion",
]
SCOPES = [
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube.readonly",
]


def need(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing {name}")
    return value


def youtube_client():
    creds = Credentials(
        token=None,
        refresh_token=need("YOUTUBE_REFRESH_TOKEN"),
        token_uri="https://oauth2.googleapis.com/token",
        client_id=need("YOUTUBE_CLIENT_ID"),
        client_secret=need("YOUTUBE_CLIENT_SECRET"),
        scopes=SCOPES,
    )
    creds.refresh(GoogleAuthRequest())
    return build("youtube", "v3", credentials=creds, cache_discovery=False)


def resolve_channel(yt, name: str) -> dict[str, Any] | None:
    found = yt.search().list(part="snippet", q=name, type="channel", maxResults=1).execute().get("items") or []
    if not found:
        return None
    channel_id = found[0]["snippet"]["channelId"]
    rows = yt.channels().list(part="snippet,contentDetails", id=channel_id).execute().get("items") or []
    return rows[0] if rows else None


def recent_videos(yt, channel: dict[str, Any], limit: int = 20) -> list[dict[str, Any]]:
    uploads = channel["contentDetails"]["relatedPlaylists"]["uploads"]
    playlist = yt.playlistItems().list(part="contentDetails", playlistId=uploads, maxResults=min(50, limit)).execute()
    ids = [x["contentDetails"]["videoId"] for x in (playlist.get("items") or [])]
    if not ids:
        return []
    videos = yt.videos().list(part="snippet,statistics", id=",".join(ids)).execute().get("items") or []
    now = datetime.now(timezone.utc)
    rows = []
    for video in videos:
        snippet = video.get("snippet") or {}
        stats = video.get("statistics") or {}
        published = datetime.fromisoformat(snippet["publishedAt"].replace("Z", "+00:00"))
        age_days = max((now - published).total_seconds() / 86400.0, 0.25)
        views = int(stats.get("viewCount") or 0)
        rows.append({
            "video_id": video["id"],
            "title": snippet.get("title") or "",
            "published_at": snippet.get("publishedAt") or "",
            "views": views,
            "views_per_day": round(views / age_days, 2),
        })
    values = [x["views_per_day"] for x in rows if x["views_per_day"] > 0]
    baseline = statistics.median(values) if values else 1.0
    for row in rows:
        row["outlier_ratio"] = round(row["views_per_day"] / max(baseline, 1.0), 2)
    return rows


def collect_youtube() -> dict[str, Any]:
    yt = youtube_client()
    channels, all_videos = [], []
    for query in REFERENCE_CHANNELS:
        channel = resolve_channel(yt, query)
        if not channel:
            continue
        title = channel["snippet"]["title"]
        videos = recent_videos(yt, channel)
        channels.append({"query": query, "channel_id": channel["id"], "title": title, "videos": len(videos)})
        for video in videos:
            video["channel"] = title
            all_videos.append(video)
    all_videos.sort(key=lambda x: (x.get("outlier_ratio", 0), x.get("views_per_day", 0)), reverse=True)
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "reference_channels": channels,
        "top_recent_videos": all_videos[:60],
    }


def next_numeric_id(topics: list[dict[str, Any]]) -> int:
    numbers = []
    for topic in topics:
        match = re.fullmatch(r"tbf-(\d+)", str(topic.get("id") or ""))
        if match:
            numbers.append(int(match.group(1)))
    return max(numbers, default=0) + 1


TOOL = {
    "name": "submit_topic_reservoir",
    "description": "Submit the complete scored topic queue and original candidate topics.",
    "input_schema": {
        "type": "object",
        "properties": {
            "patterns": {"type": "array", "items": {"type": "string"}},
            "scores": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "string"},
                        "click_score": {"type": "integer", "minimum": 0, "maximum": 100},
                        "reason": {"type": "string"},
                        "recommended_angle": {"type": "string"},
                        "title_seed": {"type": "string"},
                        "thumbnail_text_seed": {"type": "string"},
                    },
                    "required": ["id", "click_score", "reason", "recommended_angle", "title_seed", "thumbnail_text_seed"],
                    "additionalProperties": False,
                },
            },
            "candidates": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "topic": {"type": "string"},
                        "category": {"type": "string"},
                        "working_angle": {"type": "string"},
                        "title_seed": {"type": "string"},
                        "thumbnail_text_seed": {"type": "string"},
                        "click_score": {"type": "integer", "minimum": 0, "maximum": 100},
                        "reason": {"type": "string"},
                    },
                    "required": ["topic", "category", "working_angle", "title_seed", "thumbnail_text_seed", "click_score", "reason"],
                    "additionalProperties": False,
                },
            },
        },
        "required": ["patterns", "scores", "candidates"],
        "additionalProperties": False,
    },
}


def ask_anthropic(youtube_sample: dict[str, Any], data: dict[str, Any]) -> dict[str, Any]:
    topics = data.get("topics") or []
    ready = [t for t in topics if t.get("status") == "ready"]
    all_names = [str(t.get("topic") or "") for t in topics]
    client = Anthropic(api_key=need("ANTHROPIC_API_KEY"))
    model = os.getenv("ANTHROPIC_MODEL", "claude-sonnet-5").strip() or "claude-sonnet-5"
    prompt = f"""
You are the audience-development editor for The Business Flow, a US-focused faceless business documentary YouTube channel.
Maintain exactly 50 evergreen ready topics ordered by likely click potential.

RECENT BUSINESS-DOCUMENTARY YOUTUBE SAMPLE
{json.dumps(youtube_sample, ensure_ascii=False)}

CURRENT READY QUEUE
{json.dumps(ready, ensure_ascii=False)}

ALL STORED TOPICS - DO NOT DUPLICATE
{json.dumps(all_names, ensure_ascii=False)}

Score EVERY ready topic 0-100 for likely packaging/click potential. Consider: recognizable subject, clear conflict or reversal, hidden economics, financial stakes, proven patterns in the supplied channel-relative outliers, evergreen US demand, thumbnail simplicity, and novelty.
Then propose EXACTLY 20 original evergreen candidates not present in ALL STORED TOPICS.
Use aggressive but factual clickbait. Do not invent a crime, number, motive, allegation, or outcome.
Call submit_topic_reservoir exactly once with the full result. Keep reasons concise so all 50 scores and 20 candidates fit.
""".strip()
    response = client.messages.create(
        model=model,
        max_tokens=16000,
        tools=[TOOL],
        tool_choice={"type": "tool", "name": "submit_topic_reservoir"},
        messages=[{"role": "user", "content": prompt}],
    )
    calls = [block for block in response.content if getattr(block, "type", None) == "tool_use" and getattr(block, "name", None) == "submit_topic_reservoir"]
    if not calls:
        raise RuntimeError("Anthropic did not return structured topic reservoir output")
    result = calls[0].input
    if len(result.get("scores") or []) != len(ready):
        raise RuntimeError(f"Expected {len(ready)} scored topics, got {len(result.get('scores') or [])}")
    if len(result.get("candidates") or []) != 20:
        raise RuntimeError(f"Expected 20 candidates, got {len(result.get('candidates') or [])}")
    return result


def apply(data: dict[str, Any], analysis: dict[str, Any]) -> dict[str, Any]:
    now = datetime.now(timezone.utc).isoformat()
    topics: list[dict[str, Any]] = data.get("topics") or []
    by_id = {str(t.get("id")): t for t in topics}
    for score in analysis["scores"]:
        topic = by_id.get(str(score["id"]))
        if not topic or topic.get("status") != "ready":
            continue
        topic["click_score"] = int(score["click_score"])
        topic["click_reason"] = score["reason"]
        topic["working_angle"] = score["recommended_angle"]
        topic["title_seed"] = score["title_seed"]
        topic["thumbnail_text_seed"] = score["thumbnail_text_seed"]
        topic["scored_at"] = now

    existing = {str(t.get("topic") or "").strip().lower() for t in topics}
    nid = next_numeric_id(topics)
    fresh = []
    for candidate in sorted(analysis["candidates"], key=lambda c: int(c["click_score"]), reverse=True):
        name = candidate["topic"].strip()
        if not name or name.lower() in existing:
            continue
        existing.add(name.lower())
        fresh.append({
            "id": f"tbf-{nid:03d}",
            "topic": name,
            "category": candidate["category"],
            "working_angle": candidate["working_angle"],
            "title_seed": candidate["title_seed"],
            "thumbnail_text_seed": candidate["thumbnail_text_seed"],
            "status": "candidate",
            "click_score": int(candidate["click_score"]),
            "click_reason": candidate["reason"],
            "scored_at": now,
        })
        nid += 1

    ready = sorted([t for t in topics if t.get("status") == "ready"], key=lambda t: int(t.get("click_score") or 0), reverse=True)
    while len(ready) < TARGET_READY and fresh:
        topic = fresh.pop(0)
        topic["status"] = "ready"
        topics.append(topic)
        ready.append(topic)

    for candidate in list(fresh):
        ready.sort(key=lambda t: int(t.get("click_score") or 0), reverse=True)
        weakest = ready[-1]
        if int(candidate["click_score"]) >= int(weakest.get("click_score") or 0) + 8:
            weakest["status"] = "backlog"
            candidate["status"] = "ready"
            topics.append(candidate)
            ready[-1] = candidate
            fresh.remove(candidate)

    for candidate in fresh:
        candidate["status"] = "backlog"
        topics.append(candidate)

    ready = sorted([t for t in topics if t.get("status") == "ready"], key=lambda t: int(t.get("click_score") or 0), reverse=True)
    if len(ready) > TARGET_READY:
        for topic in ready[TARGET_READY:]:
            topic["status"] = "backlog"
        ready = ready[:TARGET_READY]
    if len(ready) != TARGET_READY:
        raise RuntimeError(f"Expected exactly {TARGET_READY} ready topics, found {len(ready)}")

    backlog = sorted([t for t in topics if t.get("status") == "backlog"], key=lambda t: int(t.get("click_score") or 0), reverse=True)
    used = [t for t in topics if t.get("status") == "used"]
    other = [t for t in topics if t.get("status") not in {"ready", "backlog", "used"}]
    data["topics"] = ready + backlog + other + used
    data["reservoir"] = {
        "target_ready": TARGET_READY,
        "ready_count": len(ready),
        "backlog_count": len(backlog),
        "last_refreshed_at": now,
        "ranking": "click_score_desc",
        "replacement_margin": 8,
        "model": os.getenv("ANTHROPIC_MODEL", "claude-sonnet-5"),
    }
    return data


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    data = json.loads(TOPICS_PATH.read_text(encoding="utf-8"))
    sample = collect_youtube()
    analysis = ask_anthropic(sample, data)
    updated = apply(data, analysis)
    TOPICS_PATH.write_text(json.dumps(updated, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    ready = [t for t in updated["topics"] if t.get("status") == "ready"]
    (OUT / "youtube-sample.json").write_text(json.dumps(sample, ensure_ascii=False, indent=2), encoding="utf-8")
    (OUT / "anthropic-analysis.json").write_text(json.dumps(analysis, ensure_ascii=False, indent=2), encoding="utf-8")
    (OUT / "ranked-ready-topics.json").write_text(json.dumps(ready, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({
        "ready_topics": len(ready),
        "top_topic": ready[0]["topic"],
        "top_score": ready[0].get("click_score"),
        "videos_analyzed": len(sample["top_recent_videos"]),
    }, indent=2))


if __name__ == "__main__":
    main()
