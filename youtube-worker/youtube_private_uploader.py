from __future__ import annotations

import argparse
import json
import os
import random
import time
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
    body = {
        "snippet": {
            "title": metadata["title"],
            "description": metadata["description"],
            "tags": [str(tag) for tag in tags][:30],
            "categoryId": str(metadata.get("category_id") or "27"),
            "defaultLanguage": "en",
            "defaultAudioLanguage": "en",
        },
        "status": {
            "privacyStatus": "private",
            "embeddable": True,
            "license": "youtube",
            "selfDeclaredMadeForKids": False,
        },
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
            existing = youtube.videos().list(part="id,snippet,status", id=previous_id).execute()
            items = existing.get("items") or []
            if items:
                item = items[0]
                if str((item.get("snippet") or {}).get("channelId") or "") != expected_channel_id:
                    raise RuntimeError("Checkpointed video belongs to a different channel")
                if str((item.get("status") or {}).get("privacyStatus") or "") != "private":
                    raise RuntimeError("Checkpointed video is not private")
                print(f"Reusing existing private YouTube checkpoint: {previous_id}")
                return

    video_id = upload_video(youtube, args.video, metadata)
    youtube.thumbnails().set(
        videoId=video_id,
        media_body=MediaFileUpload(str(args.thumbnail), mimetype="image/png", resumable=False),
    ).execute()

    checkpoint = {
        "youtube_video_id": video_id,
        "youtube_permalink": f"https://www.youtube.com/watch?v={video_id}",
        "privacy_status": "private",
        "channel_id": expected_channel_id,
    }
    args.checkpoint.parent.mkdir(parents=True, exist_ok=True)
    args.checkpoint.write_text(json.dumps(checkpoint, indent=2), encoding="utf-8")
    print(json.dumps(checkpoint, indent=2))


if __name__ == "__main__":
    main()
