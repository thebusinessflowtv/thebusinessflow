#!/usr/bin/env python3
"""Merge QC-approved Lofi Hip Hop tracks into MediaForge OVH local catalog.

Does not touch any live slot, FFmpeg encoder, YouTube session or unrelated
playlist. Safe to rerun while the separate music generation queue is active.
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = os.getenv("MEDIAFORGE_OVH_URL", "https://peterlofi.odsgn.com.br").rstrip("/")
SOURCE = "https://raw.githubusercontent.com/thebusinessflowtv/theofficemusic/main/control/music-library.json"
KEY = "lofi-hip-hop"
PATH = "control/music-library.json"


def get_json(url, *, agent_token=None, bearer=None, body=None):
    headers = {"user-agent": "MediaForge-LofiHipHop-OVH-Sync/1", "accept": "application/json"}
    if agent_token:
        headers["x-ovh-agent-token"] = agent_token
    if bearer:
        headers["authorization"] = "Bearer " + bearer
    data = None
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers["content-type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers, method="POST" if data is not None else "GET")
    with urllib.request.urlopen(request, timeout=55) as response:
        return json.load(response)


def by_key(library):
    return next((p for p in library.get("playlists", []) if isinstance(p, dict) and p.get("key") == KEY), None)


def main():
    agent_token = os.environ["OVH_AGENT_TOKEN"].strip()
    email = os.environ["ADMIN_EMAIL"].strip()
    password = os.environ["ADMIN_PASSWORD"]
    if not agent_token or not email or not password:
        raise RuntimeError("Missing OVH agent/admin credentials: refusing to touch catalog")
    source = get_json(SOURCE + "?sync=" + str(int(time.time())))
    remote = by_key(source)
    if remote is None:
        raise RuntimeError("GitHub Lofi Hip Hop playlist not found; keeping OVH unchanged")
    tracks = remote.get("tracks", [])
    if not 1 <= len(tracks) <= 36:
        raise RuntimeError("Unexpected approved track count: " + str(len(tracks)))
    ids = set()
    for item in tracks:
        tid, url = str(item.get("id") or ""), str(item.get("url") or "")
        if not re.fullmatch(r"lofi-hip-hop-20261008-\d{2}", tid):
            raise RuntimeError("Unexpected track ID: " + tid)
        if tid in ids or not url.startswith("https://github.com/thebusinessflowtv/theofficemusic/releases/download/peter-lofi-lofi-hip-hop-"):
            raise RuntimeError("Duplicate track or unexpected audio URL")
        if int(item.get("duration_seconds") or 0) != 300:
            raise RuntimeError("Invalid five-minute track length")
        if item.get("quality_gate") != "technical_and_45s_intro_diversity_passed":
            raise RuntimeError("Track did not pass quality/diversity gate: " + tid)
        ids.add(tid)

    query = urllib.parse.urlencode({"path": PATH, "raw": "1"})
    endpoint = BASE + "/api/ovh/agent/runtime-config"
    current = get_json(endpoint + "?" + query, agent_token=agent_token)
    if not isinstance(current, dict) or not isinstance(current.get("playlists"), list):
        raise RuntimeError("OVH local catalog is not valid: not overwriting it")

    previous = by_key(current)
    old_tracks = list(previous.get("tracks") or []) if previous else []
    old_by_id = {str(t.get("id")): t for t in old_tracks if isinstance(t, dict) and t.get("id")}
    new_by_id = {str(t["id"]): t for t in tracks}
    # Preserve already-localized OVH URLs if they exist, and do not discard
    # track IDs that were locally added after the GitHub snapshot was read.
    merged_tracks = {}
    for tid, t in {**old_by_id, **new_by_id}.items():
        old = old_by_id.get(tid)
        merged_tracks[tid] = {**t, **({"url": old["url"], "asset_id": old.get("asset_id")} if old and old.get("asset_id") and old.get("url") else {})}
    ordered = sorted(merged_tracks.values(), key=lambda t: (int(t.get("position") or 999), str(t.get("id"))))
    playlist = {**(previous or {}), **remote, "tracks": ordered, "track_count": len(ordered),
                "total_duration_seconds": sum(int(t.get("duration_seconds") or 0) for t in ordered),
                "status": "complete" if len(ordered) == 36 else "generating"}
    playlists = [p for p in current["playlists"] if not (isinstance(p, dict) and p.get("key") == KEY)]
    playlists.append(playlist)
    updated = {**current, "playlists": playlists, "updated_at": source.get("updated_at") or current.get("updated_at")}
    if previous != playlist:
        result = get_json(endpoint, agent_token=agent_token, body={"path": PATH, "payload": updated})
        if not result.get("ok"):
            raise RuntimeError("OVH rejected local library merge")
        print("OVH_LOFI_PLAYLIST_MERGED:", len(old_tracks), "->", len(ordered), flush=True)
    else:
        print("OVH_LOFI_PLAYLIST_ALREADY_CURRENT:", len(ordered), flush=True)

    # Check the same endpoint that powers the live-creation dropdown.
    auth = get_json(BASE + "/api/auth/login", body={"email": email, "password": password})
    bearer = str(auth.get("token") or "")
    if not bearer:
        raise RuntimeError("MediaForge login failed; cannot verify selector")
    print("::add-mask::" + bearer, flush=True)
    visible = get_json(BASE + "/api/music-library", bearer=bearer)
    listing = by_key(visible)
    if not listing or len(listing.get("tracks") or []) < len(ordered):
        raise RuntimeError("Live dropdown backend has not received the Lofi Hip Hop playlist")
    print(json.dumps({"status": "LOFI_HIP_HOP_VISIBLE_IN_MEDIAFORGE",
                      "available_tracks": len(listing["tracks"]),
                      "duration_minutes": len(listing["tracks"]) * 5,
                      "remaining": max(0, 36 - len(listing["tracks"])),
                      "other_playlists_preserved": len(current["playlists"]) - (1 if previous else 0),
                      "streaming_containers_restarted": False}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
