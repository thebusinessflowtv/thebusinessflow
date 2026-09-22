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
    items = yt.channels().list(part="snippet,contentDetails", id=channel_id).execute().get("items") or []
    return items[0] if items else None


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
        age_days = max((now - published).total_seconds() / 86400, 0.25)
        views = int(stats.get("viewCount") or 0)
        rows.append({
            "video_id": video["id"],
            "title": snippet.get("title"),
            "published_at": snippet.get("publishedAt"),
            "views": views,
            "views_per_day": round(views / age_days, 2),
        })
    positive = [r["views_per_day"] for r in rows if r["views_per_day"] > 0]
    baseline = statistics.median(positive) if positive else 1.0
    for row in rows:
        row["outlier_ratio"] = round(row["views_per_day"] / max(baseline, 1.0), 2)
    return rows


def collect_youtube() -> dict[str, Any]:
    yt = youtube_client()
    channels, videos = [], []
    for query in REFERENCE_CHANNELS:
        channel = resolve_channel(yt, query)
        if not channel:
            continue
        title = channel["snippet"]["title"]
        rows = recent_videos(yt, channel)
        channels.append({"query": query, "channel_id": channel["id"], "title": title, "videos": len(rows)})
        for row in rows:
            row["channel"] = title
            videos.append(row)
    videos.sort(key=lambda r: (r.get("outlier_ratio", 0), r.get("views_per_day", 0)), reverse=True)
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "reference_channels": channels,
        "top_recent_videos": videos[:70],
    }


def extract_json(text: str) -> dict[str, Any]:
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise RuntimeError("Anthropic response did not contain JSON")
    return json.loads(text[start:end + 1])


def next_numeric_id(topics: list[dict[str, Any]]) -> int:
    numbers = []
    for topic in topics:
        match = re.fullmatch(r"tbf-(\d+)", str(topic.get("id") or ""))
        if match:
            numbers.append(int(match.group(1)))
    return max(numbers, default=0) + 1


def ask_anthropic(youtube_sample: dict[str, Any], topics_data: dict[str, Any]) -> dict[str, Any]:
    topics = topics_data.get("topics") or []
    ready = [t for t in topics if t.get("status") == "ready"]
    all_names = [str(t.get("topic") or "") for t in topics]
    client = Anthropic(api_key=need("ANTHROPIC_API_KEY"))
    model = os.getenv("ANTHROPIC_MODEL", "claude-sonnet-5").strip() or "claude-sonnet-5"
    prompt = f"""
You are the audience-development editor for The Business Flow, a US-focused faceless business documentary YouTube channel.
Maintain a reservoir of 50 evergreen episodes ordered by likely CLICK POTENTIAL. This is ranking for packaging opportunity, not a moral judgment about companies.

RECENT REFERENCE-CHANNEL PERFORMANCE
{json.dumps(youtube_sample, ensure_ascii=False)}

CURRENT READY TOPICS
{json.dumps(ready, ensure_ascii=False)}

ALL STORED TOPICS - NEVER DUPLICATE THESE
{json.dumps(all_names, ensure_ascii=False)}

Score EVERY current ready topic from 0 to 100. Weight: recognizable subject, clear conflict/reversal, hidden economics, financial stakes, proven title-pattern demand in the supplied outliers, evergreen US interest, thumbnail simplicity, and novelty.
Then propose exactly 20 new evergreen candidates that are not duplicates. Favor factual clickbait: huge stakes, strange incentives, hidden business models, collapses, reversals, or 'how it really makes money'. Never invent a crime, number, motive, or allegation.

Return JSON only:
{{
  "patterns": ["..."],
  "scores": [{{"id":"tbf-001","click_score":92,"reason":"...","recommended_angle":"...","title_seed":"...","thumbnail_text_seed":"max 4 words"}}],
  "candidates": [{{"topic":"...","category":"...","working_angle":"...","title_seed":"...","thumbnail_text_seed":"max 4 words","click_score":90,"reason":"..."}}]
}}
""".strip()
    response = client.messages.create(
        model=model,
        max_tokens=8000,
        temperature=0.6,
        messages=[{"role": "user", "content": prompt}],
    )
    text = "\n".join(block.text for block in response.content if getattr(block, "type", None) == "text")
    result = extract_json(text)
    if len(result.get("scores") or []) < len(ready):
        raise RuntimeError("Anthropic did not score every ready topic")
    if len(result.get("candidates") or []) < 10:
        raise RuntimeError("Anthropic returned too few candidates")
    return result


def apply(topics_data: dict[str, Any], analysis: dict[str, Any]) -> dict[str, Any]:
    now = datetime.now(timezone.utc).isoformat()
    topics: list[dict[str, Any]] = topics_data.get("topics") or []
    by_id = {str(t.get("id")): t for t in topics}
    for score in analysis.get("scores") or []:
        topic = by_id.get(str(score.get("id")))
        if not topic or topic.get("status") != "ready":
            continue
        topic["click_score"] = max(0, min(100, int(score.get("click_score") or 0)))
        topic["click_reason"] = str(score.get("reason") or "")
        topic["scored_at"] = now
        for source_key, target_key in [
            ("recommended_angle", "working_angle"),
            ("title_seed", "title_seed"),
            ("thumbnail_text_seed", "thumbnail_text_seed"),
        ]:
            if score.get(source_key):
                topic[target_key] = str(score[source_key])

    existing = {str(t.get("topic") or "").strip().lower() for t in topics}
    nid = next_numeric_id(topics)
    fresh = []
    for candidate in sorted(analysis.get("candidates") or [], key=lambda c: int(c.get("click_score") or 0), reverse=True):
        name = str(candidate.get("topic") or "").strip()
        if not name or name.lower() in existing:
            continue
        existing.add(name.lower())
        fresh.append({
            "id": f"tbf-{nid:03d}",
            "topic": name,
            "category": str(candidate.get("category") or "business documentary"),
            "working_angle": str(candidate.get("working_angle") or ""),
            "title_seed": str(candidate.get("title_seed") or ""),
            "thumbnail_text_seed": str(candidate.get("thumbnail_text_seed") or ""),
            "status": "candidate",
            "click_score": max(0, min(100, int(candidate.get("click_score") or 0))),
            "click_reason": str(candidate.get("reason") or ""),
            "scored_at": now,
        })
        nid += 1

    ready = [t for t in topics if t.get("status") == "ready"]
    ready.sort(key=lambda t: int(t.get("click_score") or 0), reverse=True)

    while len(ready) < TARGET_READY and fresh:
        topic = fresh.pop(0)
        topic["status"] = "ready"
        topics.append(topic)
        ready.append(topic)

    # Strong new ideas can replace weak ready ideas; weaker ideas remain backlog.
    for candidate in list(fresh):
        ready.sort(key=lambda t: int(t.get("click_score") or 0), reverse=True)
        weakest = ready[-1]
        if int(candidate.get("click_score") or 0) >= int(weakest.get("click_score") or 0) + 8:
            weakest["status"] = "backlog"
            candidate["status"] = "ready"
            topics.append(candidate)
            ready[-1] = candidate
            fresh.remove(candidate)

    for candidate in fresh:
        candidate["status"] = "backlog"
        topics.append(candidate)

    ready = [t for t in topics if t.get("status") == "ready"]
    ready.sort(key=lambda t: int(t.get("click_score") or 0), reverse=True)
    if len(ready) > TARGET_READY:
        for topic in ready[TARGET_READY:]:
            topic["status"] = "backlog"
        ready = ready[:TARGET_READY]
    if len(ready) != TARGET_READY:
        raise RuntimeError(f"Expected exactly {TARGET_READY} ready topics, found {len(ready)}")

    backlog = sorted(
        [t for t in topics if t.get("status") == "backlog"],
        key=lambda t: int(t.get("click_score") or 0),
        reverse=True,
    )
    used = [t for t in topics if t.get("status") == "used"]
    other = [t for t in topics if t.get("status") not in {"ready", "backlog", "used"}]
    topics_data["topics"] = ready + backlog + other + used
    topics_data["reservoir"] = {
        "target_ready": TARGET_READY,
        "ready_count": len(ready),
        "backlog_count": len(backlog),
        "last_refreshed_at": now,
        "ranking": "click_score_desc",
        "replacement_margin": 8,
    }
    return topics_data


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    data = json.loads(TOPICS_PATH.read_text(encoding="utf-8"))
    youtube_sample = collect_youtube()
    analysis = ask_anthropic(youtube_sample, data)
    updated = apply(data, analysis)
    TOPICS_PATH.write_text(json.dumps(updated, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    ready = [t for t in updated["topics"] if t.get("status") == "ready"]
    (OUT / "youtube-sample.json").write_text(json.dumps(youtube_sample, indent=2), encoding="utf-8")
    (OUT / "anthropic-analysis.json").write_text(json.dumps(analysis, ensure_ascii=False, indent=2), encoding="utf-8")
    (OUT / "ranked-ready-topics.json").write_text(json.dumps(ready, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({
        "ready_topics": len(ready),
        "top_topic": ready[0]["topic"],
        "top_score": ready[0].get("click_score"),
        "videos_analyzed": len(youtube_sample["top_recent_videos"]),
    }, indent=2))


if __name__ == "__main__":
    main()
