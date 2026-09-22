from __future__ import annotations

import json
import sys
from pathlib import Path

from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

SCOPES = [
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube.readonly",
]


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("Usage: python youtube-worker/setup_oauth.py <client_secret.json>")

    client_file = Path(sys.argv[1]).expanduser().resolve()
    if not client_file.is_file():
        raise SystemExit(f"OAuth client JSON not found: {client_file}")

    config = json.loads(client_file.read_text(encoding="utf-8"))
    desktop = config.get("installed") or config.get("web") or {}
    client_id = str(desktop.get("client_id") or "").strip()
    client_secret = str(desktop.get("client_secret") or "").strip()
    if not client_id or not client_secret:
        raise SystemExit("The JSON does not contain client_id/client_secret")

    flow = InstalledAppFlow.from_client_secrets_file(str(client_file), SCOPES)
    creds = flow.run_local_server(
        host="localhost",
        port=0,
        open_browser=True,
        authorization_prompt_message=(
            "A browser will open. Sign in with the Google account that OWNS the The Business Flow YouTube channel."
        ),
        success_message="YouTube authorization completed. You can close this tab and return to PowerShell.",
        access_type="offline",
        prompt="consent",
    )

    if not creds.refresh_token:
        raise SystemExit(
            "Google did not return a refresh token. Revoke this app in your Google Account permissions and run again."
        )

    youtube = build("youtube", "v3", credentials=creds, cache_discovery=False)
    response = youtube.channels().list(part="id,snippet", mine=True, maxResults=1).execute()
    items = response.get("items") or []
    if not items:
        raise SystemExit("Authenticated Google account did not return a YouTube channel")

    channel = items[0]
    channel_id = str(channel.get("id") or "")
    channel_title = str((channel.get("snippet") or {}).get("title") or "")

    print("\n=== THE BUSINESS FLOW YOUTUBE OAUTH READY ===")
    print(f"CHANNEL_TITLE={channel_title}")
    print(f"YOUTUBE_CHANNEL_ID={channel_id}")
    print(f"YOUTUBE_CLIENT_ID={client_id}")
    print(f"YOUTUBE_CLIENT_SECRET={client_secret}")
    print(f"YOUTUBE_REFRESH_TOKEN={creds.refresh_token}")
    print("\nCreate these four GitHub Actions secrets in thebusinessflowtv/thebusinessflow:")
    print("YOUTUBE_CHANNEL_ID")
    print("YOUTUBE_CLIENT_ID")
    print("YOUTUBE_CLIENT_SECRET")
    print("YOUTUBE_REFRESH_TOKEN")
    print("\nIMPORTANT: never commit these values to the repository.")


if __name__ == "__main__":
    main()
