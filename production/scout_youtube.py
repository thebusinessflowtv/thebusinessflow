from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from anthropic import Anthropic
from google.auth.transport.requests import Request as GoogleAuthRequest
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

try:
    from production.anthropic_budget import estimate_cost_usd, safe_response_snapshot, usage_dict
except ModuleNotFoundError:
    from anthropic_budget import estimate_cost_usd, safe_response_snapshot, usage_dict

ROOT = Path(__file__).resolve().parents[1]
TOPICS_PATH = ROOT / "production" / "topics.json"
OUT = ROOT / "production" / "scout-output"
CACHE = ROOT / "production" / "scout-cache"

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
    items = yt.playlistItems().list(part="contentDetails", playlistId=uploads, maxResults=min(50, limit)).execute().get("items") or []
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
    channels, all_videos = [], []
    for name in REFERENCE_CHANNELS:
        channel = resolve_channel(yt, name)
        if not channel:
            continue
        title, cid = channel["snippet"]["title"], channel["id"]
        videos = recent_videos(yt, channel, 20)
        channels.append({"query": name, "channel_id": cid, "title": title, "videos": len(videos)})
        for video in videos:
            video["channel"] = title
            all_videos.append(video)
    all_videos.sort(key=lambda x: x["views_per_day"], reverse=True)
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "reference_channels": channels,
        "top_recent_videos": all_videos[:60],
    }


def extract_json(text: str) -> dict[str, Any]:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise RuntimeError("Anthropic scout response did not contain JSON")
    return json.loads(text[start:end + 1])


def propose_topics(scout: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    existing = json.loads(TOPICS_PATH.read_text(encoding="utf-8"))
    existing_topics = [str(x.get("topic")) for x in existing.get("topics") or []]
    week_key = datetime.now(timezone.utc).strftime("%G-W%V")
    cache_path = CACHE / "latest.json"
    snapshot_path = CACHE / "haiku-response.json"

    if cache_path.exists():
        cached = json.loads(cache_path.read_text(encoding="utf-8"))
        if cached.get("week_key") == week_key and isinstance(cached.get("recommendations"), dict):
            return cached["recommendations"], {
                "cache_hit": True,
                "model": cached.get("model"),
                "estimated_cost_usd": cached.get("estimated_cost_usd", 0),
            }

    # A prior paid response from this same week is reusable even if parsing failed downstream.
    if snapshot_path.exists():
        snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
        if snapshot.get("week_key") == week_key:
            text = "\n".join(
                str(block.get("text") or "") for block in snapshot.get("content") or [] if block.get("type") == "text"
            )
            recommendations = extract_json(text)
            CACHE.mkdir(parents=True, exist_ok=True)
            cache_path.write_text(json.dumps({
                "week_key": week_key,
                "model": snapshot.get("model"),
                "estimated_cost_usd": snapshot.get("estimated_cost_usd", 0),
                "recommendations": recommendations,
            }, ensure_ascii=False, indent=2), encoding="utf-8")
            return recommendations, {
                "cache_hit": True,
                "recovered_response": True,
                "model": snapshot.get("model"),
                "estimated_cost_usd": snapshot.get("estimated_cost_usd", 0),
            }

    model = os.getenv("ANTHROPIC_SCOUT_MODEL", "claude-haiku-4-5-20251001").strip() or "claude-haiku-4-5-20251001"
    prompt = f"""
You are the low-cost audience-development analyst for The Business Flow, a US-focused business documentary channel.
Analyze the YouTube performance sample below. Do not browse the web; the data you need is already supplied.
Infer repeatable topic and packaging patterns, then propose exactly 20 original evergreen episode seeds not already in the queue.
Favor recognizable companies, industries, hidden economics, corporate reversals, large verified business decisions, failures and business-model contradictions.
Do not assert unverified crimes, motives or numbers.

RECENT REFERENCE-CHANNEL DATA
{json.dumps(scout, ensure_ascii=False)}

EXISTING TOPICS
{json.dumps(existing_topics, ensure_ascii=False)}

Return compact JSON only:
{{"patterns":["..."],"candidates":[{{"topic":"...","working_angle":"...","title_seed":"...","thumbnail_text_seed":"max 4 words","why_now":"..."}}]}}
""".strip()

    client = Anthropic(api_key=env("ANTHROPIC_API_KEY"), max_retries=0)
    response = client.messages.create(
        model=model,
        max_tokens=1800,
        messages=[{"role": "user", "content": prompt}],
    )

    CACHE.mkdir(parents=True, exist_ok=True)
    snapshot = safe_response_snapshot(response)
    usage = usage_dict(response)
    cost = estimate_cost_usd(model, usage)
    snapshot["week_key"] = week_key
    snapshot["estimated_cost_usd"] = cost
    snapshot_path.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2), encoding="utf-8")

    text = "\n".join(str(block.get("text") or "") for block in snapshot.get("content") or [] if block.get("type") == "text")
    recommendations = extract_json(text)
    if len(recommendations.get("candidates") or []) != 20:
        raise RuntimeError("Haiku scout must return exactly 20 candidates")

    cache_path.write_text(json.dumps({
        "week_key": week_key,
        "model": model,
        "estimated_cost_usd": cost,
        "recommendations": recommendations,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    return recommendations, {"cache_hit": False, "model": model, "anthropic_usage": usage, "estimated_cost_usd": cost}


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    scout = collect()
    recommendations, meta = propose_topics(scout)
    (OUT / "youtube-scout.json").write_text(json.dumps(scout, indent=2), encoding="utf-8")
    (OUT / "topic-candidates.json").write_text(json.dumps(recommendations, ensure_ascii=False, indent=2), encoding="utf-8")
    (OUT / "anthropic-cost.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({
        "channels": len(scout["reference_channels"]),
        "videos_analyzed": len(scout["top_recent_videos"]),
        "new_candidates": len(recommendations.get("candidates") or []),
        **meta,
    }, indent=2))


if __name__ == "__main__":
    main()
