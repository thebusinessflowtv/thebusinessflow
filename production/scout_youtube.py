from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from anthropic import Anthropic
from google.auth.transport.requests import Request as GoogleAuthRequest
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

ROOT = Path(__file__).resolve().parents[1]
TOPICS_PATH = ROOT / "production" / "topics.json"
OUT = ROOT / "production" / "scout-output"

REFERENCE_CHANNELS = [
    "MagnatesMedia",
    "Modern MBA",
    "Company Man",
    "How Money Works",
    "Wall Street Millennial",
    "Logically Answered",
    "ColdFusion",
]

SCOPES = [
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube.readonly",
]


def env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing {name}")
    return value


def youtube_client():
    creds = Credentials(
        token=None,
        refresh_token=env("YOUTUBE_REFRESH_TOKEN"),
        token_uri="https://oauth2.googleapis.com/token",
        client_id=env("YOUTUBE_CLIENT_ID"),
        client_secret=env("YOUTUBE_CLIENT_SECRET"),
        scopes=SCOPES,
    )
    creds.refresh(GoogleAuthRequest())
    return build("youtube", "v3", credentials=creds, cache_discovery=False)


def resolve_channel(yt, name: str) -> dict[str, Any] | None:
    result = yt.search().list(part="snippet", q=name, type="channel", maxResults=1).execute()
    items = result.get("items") or []
    if not items:
        return None
    channel_id = items[0]["snippet"]["channelId"]
    channel = yt.channels().list(part="snippet,contentDetails", id=channel_id).execute()["items"][0]
    return channel


def recent_videos(yt, channel: dict[str, Any], limit: int = 20) -> list[dict[str, Any]]:
    uploads = channel["contentDetails"]["relatedPlaylists"]["uploads"]
    items = yt.playlistItems().list(
        part="contentDetails", playlistId=uploads, maxResults=min(50, limit)
    ).execute().get("items") or []
    ids = [item["contentDetails"]["videoId"] for item in items]
    if not ids:
        return []
    videos = yt.videos().list(part="snippet,statistics", id=",".join(ids)).execute().get("items") or []
    now = datetime.now(timezone.utc)
    out = []
    for video in videos:
        snippet = video.get("snippet") or {}
        stats = video.get("statistics") or {}
        published = datetime.fromisoformat(snippet["publishedAt"].replace("Z", "+00:00"))
        age_days = max((now - published).total_seconds() / 86400.0, 0.25)
        views = int(stats.get("viewCount") or 0)
        out.append({
            "video_id": video["id"],
            "title": snippet.get("title"),
            "published_at": snippet.get("publishedAt"),
            "views": views,
            "views_per_day": round(views / age_days, 2),
        })
    return out


def collect() -> dict[str, Any]:
    yt = youtube_client()
    channels = []
    all_videos = []
    for name in REFERENCE_CHANNELS:
        channel = resolve_channel(yt, name)
        if not channel:
            continue
        title = channel["snippet"]["title"]
        cid = channel["id"]
        videos = recent_videos(yt, channel, 20)
        channels.append({"query": name, "channel_id": cid, "title": title, "videos": len(videos)})
        for v in videos:
            v["channel"] = title
            all_videos.append(v)
    all_videos.sort(key=lambda x: x["views_per_day"], reverse=True)
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "reference_channels": channels,
        "top_recent_videos": all_videos[:60],
    }


def propose_topics(scout: dict[str, Any]) -> dict[str, Any]:
    existing = json.loads(TOPICS_PATH.read_text(encoding="utf-8"))
    existing_topics = [str(x.get("topic")) for x in existing.get("topics") or []]
    client = Anthropic(api_key=env("ANTHROPIC_API_KEY"))
    model = os.getenv("ANTHROPIC_MODEL", "claude-sonnet-5")
    prompt = f"""
You are the audience-development strategist for The Business Flow, a US-focused faceless business documentary channel.
Analyze the recent YouTube performance sample below. Do not copy titles. Infer topic and packaging patterns that appear to create curiosity and strong demand.

RECENT REFERENCE-CHANNEL DATA
{json.dumps(scout, ensure_ascii=False)}

ALREADY IN OUR 50-TOPIC QUEUE
{json.dumps(existing_topics, ensure_ascii=False)}

Propose exactly 20 ORIGINAL future episode seeds that are not duplicates of the existing queue.
Favor recognizable companies, industries, hidden economics, corporate reversals, huge verified decisions, failures and business-model contradictions.
Avoid daily news that will be stale in weeks.
Clickbait may be aggressive but the seed cannot assert an unverified crime, number or motive.

Return JSON only:
{{"patterns":["..."],"candidates":[{{"topic":"...","working_angle":"...","title_seed":"...","thumbnail_text_seed":"max 4 words","why_now":"..."}}]}}
""".strip()
    response = client.messages.create(
        model=model,
        max_tokens=5000,
        temperature=0.7,
        messages=[{"role": "user", "content": prompt}],
    )
    text = "\n".join(block.text for block in response.content if getattr(block, "type", None) == "text")
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise RuntimeError("Anthropic scout response did not contain JSON")
    return json.loads(text[start:end+1])


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    scout = collect()
    recommendations = propose_topics(scout)
    (OUT / "youtube-scout.json").write_text(json.dumps(scout, indent=2), encoding="utf-8")
    (OUT / "topic-candidates.json").write_text(
        json.dumps(recommendations, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps({
        "channels": len(scout["reference_channels"]),
        "videos_analyzed": len(scout["top_recent_videos"]),
        "new_candidates": len(recommendations.get("candidates") or []),
    }, indent=2))


if __name__ == "__main__":
    main()
