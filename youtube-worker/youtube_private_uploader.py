from __future__ import annotations

import argparse
import json
import os
import random
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from google.auth.transport.requests import Request as GoogleAuthRequest
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from googleapiclient.http import MediaFileUpload

YOUTUBE_SCOPES = [
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube.readonly",
]
RETRIABLE_STATUS = {500, 502, 503, 504}
MAX_RETRIES = 8


def required_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def credentials() -> tuple[Credentials, str]:
    client_id = required_env("YOUTUBE_CLIENT_ID")
    client_secret = required_env("YOUTUBE_CLIENT_SECRET")
    refresh_token = required_env("YOUTUBE_REFRESH_TOKEN")
    channel_id = required_env("YOUTUBE_CHANNEL_ID")
    creds = Credentials(
        token=None,
        refresh_token=refresh_token,
        token_uri="https://oauth2.googleapis.com/token",
        client_id=client_id,
        client_secret=client_secret,
        scopes=YOUTUBE_SCOPES,
    )
    creds.refresh(GoogleAuthRequest())
    return creds, channel_id


def verify_channel(youtube: Any, expected_channel_id: str) -> dict[str, Any]:
    response = youtube.channels().list(part="id,snippet", mine=True, maxResults=1).execute()
    items = response.get("items") or []
    if not items:
        raise RuntimeError("Authenticated Google account returned no YouTube channel")
    channel = items[0]
    actual_id = str(channel.get("id") or "")
    if actual_id != expected_channel_id:
        title = str((channel.get("snippet") or {}).get("title") or "")
        raise RuntimeError(
            f"Channel safety block: authenticated {actual_id} ({title}) != expected {expected_channel_id}"
        )
    return channel


def normalize_publish_at(value: Any) -> str | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    normalized = raw.replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise RuntimeError(f"Invalid publish_at ISO 8601 value: {raw}") from exc
    if dt.tzinfo is None:
        raise RuntimeError("publish_at must include a timezone offset or Z")
    dt_utc = dt.astimezone(timezone.utc)
    if dt_utc <= datetime.now(timezone.utc):
        raise RuntimeError(f"publish_at must be in the future: {raw}")
    return dt_utc.isoformat(timespec="seconds").replace("+00:00", "Z")


def load_metadata(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    title = str(data.get("title") or "").strip()
    description = str(data.get("description") or "").strip()
    if not title or not description:
        raise RuntimeError("Metadata requires title and description")
    if len(title) > 100:
        raise RuntimeError(f"YouTube title exceeds 100 characters: {len(title)}")
    if len(description) > 5000:
        raise RuntimeError(f"YouTube description exceeds 5000 characters: {len(description)}")
    data["title"] = title
    data["description"] = description
    data["publish_at"] = normalize_publish_at(data.get("publish_at"))
    return data


def upload_video(youtube: Any, video_path: Path, metadata: dict[str, Any]) -> str:
    tags = metadata.get("tags") or [
        "business documentary",
        "business history",
        "corporate history",
        "companies",
        "business stories",
        "corporate documentary",
        "American business",
        "business empires",
        "corporate scandals",
        "The Business Flow",
    ]
    video_status: dict[str, Any] = {
        "privacyStatus": "private",
        "embeddable": True,
        "license": "youtube",
        "selfDeclaredMadeForKids": False,
    }
    if metadata.get("publish_at"):
        video_status["publishAt"] = metadata["publish_at"]

    body = {
        "snippet": {
            "title": metadata["title"],
            "description": metadata["description"],
            "tags": [str(tag) for tag in tags][:30],
            "categoryId": str(metadata.get("category_id") or "27"),
            "defaultLanguage": "en",
            "defaultAudioLanguage": "en",
        },
        "status": video_status,
    }
    media = MediaFileUpload(
        str(video_path), mimetype="video/mp4", chunksize=8 * 1024 * 1024, resumable=True
    )
    request = youtube.videos().insert(part="snippet,status", body=body, media_body=media)
    response = None
    retry = 0
    while response is None:
        try:
            status, response = request.next_chunk()
            if status:
                print(f"Upload progress: {status.progress() * 100:.1f}%")
        except HttpError as exc:
            status_code = int(getattr(exc.resp, "status", 0) or 0)
            if status_code not in RETRIABLE_STATUS or retry >= MAX_RETRIES:
                raise
            sleep_seconds = min(60, (2 ** retry) + random.random())
            print(f"Retriable YouTube HTTP {status_code}; sleeping {sleep_seconds:.1f}s")
            time.sleep(sleep_seconds)
            retry += 1
    video_id = str((response or {}).get("id") or "")
    if not video_id:
        raise RuntimeError(f"YouTube upload returned no video id: {response}")
    return video_id


def fetch_video(youtube: Any, video_id: str) -> dict[str, Any]:
    response = youtube.videos().list(part="id,snippet,status", id=video_id).execute()
    items = response.get("items") or []
    if not items:
        raise RuntimeError(f"Uploaded video not found after upload: {video_id}")
    return items[0]


def validate_uploaded_video(
    youtube: Any,
    video_id: str,
    expected_channel_id: str,
    expected_publish_at: str | None,
) -> dict[str, Any]:
    item = fetch_video(youtube, video_id)
    snippet = item.get("snippet") or {}
    status = item.get("status") or {}
    if str(snippet.get("channelId") or "") != expected_channel_id:
        raise RuntimeError("Uploaded video belongs to a different channel")
    if str(status.get("privacyStatus") or "") != "private":
        raise RuntimeError(f"Uploaded video is not private: {status}")
    actual_publish_at = str(status.get("publishAt") or "").strip() or None
    if expected_publish_at and actual_publish_at != expected_publish_at:
        raise RuntimeError(
            f"YouTube scheduling mismatch: expected {expected_publish_at}, got {actual_publish_at}"
        )
    return item


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", required=True, type=Path)
    parser.add_argument("--thumbnail", required=True, type=Path)
    parser.add_argument("--metadata", required=True, type=Path)
    parser.add_argument("--checkpoint", default=Path("output/youtube-upload.json"), type=Path)
    args = parser.parse_args()

    for path in [args.video, args.thumbnail, args.metadata]:
        if not path.is_file():
            raise RuntimeError(f"Required file not found: {path}")

    metadata = load_metadata(args.metadata)
    creds, expected_channel_id = credentials()
    youtube = build("youtube", "v3", credentials=creds, cache_discovery=False)
    channel = verify_channel(youtube, expected_channel_id)
    print("Authenticated channel:", channel.get("id"), (channel.get("snippet") or {}).get("title"))

    # Duplicate protection: if a prior checkpoint exists, verify and reuse it.
    if args.checkpoint.is_file():
        previous = json.loads(args.checkpoint.read_text(encoding="utf-8"))
        previous_id = str(previous.get("youtube_video_id") or "")
        if previous_id:
            try:
                item = validate_uploaded_video(
                    youtube,
                    previous_id,
                    expected_channel_id,
                    metadata.get("publish_at"),
                )
            except RuntimeError:
                item = None
            if item:
                print(f"Reusing existing private YouTube checkpoint: {previous_id}")
                return

    video_id = upload_video(youtube, args.video, metadata)
    youtube.thumbnails().set(
        videoId=video_id,
        media_body=MediaFileUpload(str(args.thumbnail), mimetype="image/png", resumable=False),
    ).execute()

    item = validate_uploaded_video(
        youtube,
        video_id,
        expected_channel_id,
        metadata.get("publish_at"),
    )
    status = item.get("status") or {}
    checkpoint = {
        "youtube_video_id": video_id,
        "youtube_permalink": f"https://www.youtube.com/watch?v={video_id}",
        "privacy_status": str(status.get("privacyStatus") or ""),
        "publish_at": str(status.get("publishAt") or "") or None,
        "scheduled": bool(status.get("publishAt")),
        "channel_id": expected_channel_id,
    }
    args.checkpoint.parent.mkdir(parents=True, exist_ok=True)
    args.checkpoint.write_text(json.dumps(checkpoint, indent=2), encoding="utf-8")
    print(json.dumps(checkpoint, indent=2))


if __name__ == "__main__":
    main()
