#!/usr/bin/env python3
"""One-time, explicitly-triggered live next-track smoke test for isolated Lofi only.

Never touches other streams or containers. Verifies D1 acknowledgement, actual
track change, and unchanged encoder process identifiers.
"""
import json
import os
import time
import urllib.parse
import urllib.request

BASE="https://peterlofi.odsgn.com.br"

def call(path,token="",body=None):
    data=json.dumps(body).encode("utf-8") if body is not None else None
    headers={"user-agent":"MediaForge-OVH-Lofi-Skip-Smoke/1"}
    if token:headers["authorization"]="Bearer "+token
    if data:headers["content-type"]="application/json"
    request=urllib.request.Request(BASE+path,data=data,headers=headers,
        method="POST" if data is not None else "GET")
    with urllib.request.urlopen(request,timeout=25) as response:
        return json.load(response)

def services(token):
    result=call("/api/ovh/status",token)
    return (result.get("agent") or {}).get("services") or {}

def main():
    auth=call("/api/auth/login",body={"email":os.environ["ADMIN_EMAIL"],"password":os.environ["ADMIN_PASSWORD"]})
    token=str(auth["token"])
    print("::add-mask::"+token,flush=True)
    before=services(token)
    slot="youtube-lofi-hip-hop"
    sv=before.get(slot) or {}
    if sv.get("status")!="live" or not sv.get("encoder_pid") or not sv.get("session_id"):
        raise RuntimeError("Lofi is not currently a real LIVE service: no action taken")
    old_track=str((sv.get("now_playing") or {}).get("track_id") or "")
    if not old_track:raise RuntimeError("No current track was reported: refusing to skip")
    old_pid=sv["encoder_pid"]
    peers={key:item.get("encoder_pid") for key,item in before.items()
        if key!=slot and item.get("status")=="live" and item.get("encoder_pid")}
    print("BEFORE",json.dumps({"slot":slot,"old_track":old_track,
        "encoder_pid":old_pid,"peers":list(peers)},ensure_ascii=False),flush=True)
    sent=call("/api/ovh/control",token,{"action":"skip",
        "runtime_slot":slot,"session_id":sv["session_id"]})
    cid=str((sent.get("command") or {}).get("id") or "")
    if not cid:raise RuntimeError("Local MediaForge did not accept the skip command")
    print("SKIP_REQUEST_ACCEPTED",cid,flush=True)
    ack=""
    for i in range(48):
        time.sleep(2)
        st=call("/api/ovh/control/"+urllib.parse.quote(cid),token).get("command") or {}
        ack=str(st.get("status") or "")
        if ack=="failed":raise RuntimeError("Agent rejected skip: "+str(st.get("error") or "")[:250])
        current=services(token)
        now=current.get(slot) or {}
        if str(now.get("encoder_pid") or "")!=str(old_pid):
            raise RuntimeError("Lofi encoder PID unexpectedly changed during skip")
        changed_peers=[key for key,pid in peers.items()
            if str((current.get(key) or {}).get("encoder_pid") or "")!=str(pid)]
        if changed_peers:raise RuntimeError("Another live encoder changed: "+",".join(changed_peers))
        new_track=str((now.get("now_playing") or {}).get("track_id") or "")
        if ack=="completed" and new_track and new_track!=old_track:
            print("LIVE_NEXT_TRACK_VERIFIED",json.dumps({
                "before":old_track,"after":new_track,"command":cid,
                "status":ack,"encoder_pid_unchanged":True,
                "other_live_encoders_unchanged":True},ensure_ascii=False),flush=True)
            return
        if i%7==0:
            print("WAITING_FOR_AUDIO_CONTROL",json.dumps({"ack":ack,
                "reported_track":new_track,"iteration":i+1}),flush=True)
    raise RuntimeError("Skip was submitted but not confirmed by changed track and OVH acknowledgement")

if __name__=="__main__":main()
