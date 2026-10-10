#!/usr/bin/env python3
"""Safely merge only approved Lofi Hip Hop tracks into MediaForge OVH local library.

Uses existing administrator login; does not require the missing OVH_AGENT_TOKEN.
The local API validates each track and preserves all other catalog entries.
"""
import json
import os
import re
import time
import urllib.request

BASE=os.getenv("MEDIAFORGE_OVH_URL","https://peterlofi.odsgn.com.br").rstrip("/")
SOURCE="https://raw.githubusercontent.com/thebusinessflowtv/theofficemusic/main/control/music-library.json"
KEY="lofi-hip-hop"

def api(url,body=None,bearer=""):
    headers={"user-agent":"MediaForge-LofiHipHop-Sync/2"}
    if bearer: headers["authorization"]="Bearer "+bearer
    data=json.dumps(body).encode("utf-8") if body is not None else None
    if data: headers["content-type"]="application/json"
    req=urllib.request.Request(url,headers=headers,data=data,method="POST" if data else "GET")
    with urllib.request.urlopen(req,timeout=55) as response: return json.load(response)

def find(library):
    return next((x for x in library.get("playlists",[]) if isinstance(x,dict) and x.get("key")==KEY),None)

def main():
    email=os.environ["ADMIN_EMAIL"].strip()
    password=os.environ["ADMIN_PASSWORD"]
    if not email or not password: raise RuntimeError("Missing MediaForge admin credentials")
    source=api(SOURCE+"?t="+str(int(time.time())))
    playlist=find(source)
    if playlist is None: raise RuntimeError("Lofi Hip Hop source playlist missing")
    tracks=playlist.get("tracks",[])
    if not (1<=len(tracks)<=36): raise RuntimeError("Invalid approved track count: "+str(len(tracks)))
    ids=set()
    for t in tracks:
        tid=str(t.get("id") or "")
        if not re.fullmatch(r"lofi-hip-hop-20261008-\d{2}",tid) or tid in ids:
            raise RuntimeError("Unexpected or duplicate track ID: "+tid)
        if int(t.get("duration_seconds") or 0)!=300 or t.get("quality_gate")!="technical_and_45s_intro_diversity_passed":
            raise RuntimeError("Track not approved: "+tid)
        if not str(t.get("url") or "").startswith("https://github.com/thebusinessflowtv/theofficemusic/releases/download/peter-lofi-lofi-hip-hop-"):
            raise RuntimeError("Unexpected audio URL for "+tid)
        ids.add(tid)
    auth=api(BASE+"/api/auth/login",{"email":email,"password":password})
    bearer=str(auth.get("token") or "")
    if not bearer: raise RuntimeError("MediaForge admin login did not return a token")
    print("::add-mask::"+bearer,flush=True)
    update=api(BASE+"/api/music-library/lofi-hip-hop-sync",{"playlist":playlist},bearer=bearer)
    if update.get("ok") is not True:
        raise RuntimeError("OVH catalog rejected Lofi Hip Hop update")
    visible=api(BASE+"/api/music-library",bearer=bearer)
    live=find(visible)
    if live is None or len(live.get("tracks") or [])<len(tracks):
        raise RuntimeError("MediaForge selector still does not contain approved Lofi Hip Hop tracks")
    print(json.dumps({"status":"LOFI_HIP_HOP_VISIBLE_IN_MEDIAFORGE",
        "track_count":len(live["tracks"]),"minutes_available":len(live["tracks"])*5,
        "remaining":max(0,36-len(live["tracks"])),
        "other_playlists_preserved":update.get("other_playlists_preserved"),
        "rtmp_restart":False},ensure_ascii=False),flush=True)

if __name__=="__main__":main()
