#!/usr/bin/env python3
"""Read-only diagnostic of the exact MediaForge production APIs used by /app.html."""
import datetime,json,os,urllib.request,urllib.error,time,urllib.parse
BASE=os.getenv("MEDIAFORGE_OVH_URL","https://peterlofi.odsgn.com.br").rstrip("/")
def call(url,token=None,payload=None):
  data=json.dumps(payload).encode() if payload is not None else None
  h={"user-agent":"MediaForge-Lofi-ReadOnly/1"}
  if token:h["authorization"]="Bearer "+token
  if data:h["content-type"]="application/json"
  request=urllib.request.Request(BASE+url,headers=h,data=data,method="POST" if data else "GET")
  try:
    with urllib.request.urlopen(request,timeout=35) as response:return json.load(response)
  except urllib.error.HTTPError as exc:
    text=exc.read().decode("utf-8","replace")
    try: data=json.loads(text)
    except Exception: data={"non_json_http_response":text[:100]}
    return {"http":exc.code,**data}
def main():
  login=call("/api/auth/login",payload={"email":os.environ["ADMIN_EMAIL"],"password":os.environ["ADMIN_PASSWORD"]})
  token=login["token"]
  print("::add-mask::"+token,flush=True)
  status=call("/api/ovh/status",token)
  print("OVH_SLOT_LOFI",json.dumps([{"name":s.get("name"),"runtime_slot":s.get("ovh_slot"),"status":s.get("status"),"current_session_id":s.get("current_session_id"),"youtube_stream_exists":bool(s.get("youtube_stream_id"))} for s in status.get("youtube_slots",[]) if s.get("ovh_slot")=="youtube-lofi-hip-hop"],ensure_ascii=False),flush=True)
  agent=status.get("agent") or {}
  svcs=(agent.get("services") or {})
  lo=svcs.get("youtube-lofi-hip-hop") or {}
  print("OVH_SERVICE_LOFI",json.dumps({k:lo.get(k) for k in ("status","session_id","encoder_pid","title","playlist_key","updated_at")},ensure_ascii=False),flush=True)
  sessions=call("/api/live-sessions",token).get("sessions") or []
  rows=[{"id":x.get("id"),"status":x.get("status"),"created_at":x.get("created_at"),"live_at":x.get("live_at"),"runtime_slot":x.get("runtime_slot"),"error":x.get("error_message")} for x in sessions if x.get("runtime_slot")=="youtube-lofi-hip-hop" or "lofi hip hop" in str(x.get("title") or "").lower()]
  print("LOFI_SESSIONS",json.dumps(rows[:12],ensure_ascii=False),flush=True)
  print("OTHER_ACTIVE_SERVICES",json.dumps({name:{"status":svc.get("status"),"encoder_pid_exists":bool(svc.get("encoder_pid"))} for name,svc in svcs.items() if name!="youtube-lofi-hip-hop"},ensure_ascii=False),flush=True)
  pre=call("/api/live/lofi-bridge-preflight",token,payload={})
  print("LOFI_REMOTE_BRIDGE_AUTH_PREFLIGHT_QUEUED",json.dumps(pre,ensure_ascii=False),flush=True)
  command_id=str(pre.get("command_id") or "")
  if command_id:
    for attempt in range(25):
      info=call("/api/ovh/deploy-status?id="+urllib.parse.quote(command_id),token)
      cmd=info.get("command") or {}
      if cmd.get("status") in ("completed","failed"):
        outcome={"status":cmd.get("status"),"error":cmd.get("error") or None,
                 "bridge_authenticated":(cmd.get("result") or {}).get("bridge_authenticated")}
        print("LOFI_HOST_BRIDGE_PREFLIGHT_RESULT",json.dumps(outcome,ensure_ascii=False),flush=True)
        if cmd.get("status")=="completed" and outcome["bridge_authenticated"] is True:
          released=call("/api/live/lofi-release-orphan",token,payload={
            "session_id":"a190cb4d-c2cb-4cab-921f-ac887d2a3690"})
          print("LOFI_ORPHAN_RELEASE_RESULT",json.dumps(released,ensure_ascii=False),flush=True)
        break
      time.sleep(3)
    else:
      print("LOFI_HOST_BRIDGE_PREFLIGHT_PENDING_TIMEOUT",flush=True)
  print("READ_ONLY_DIAGNOSTIC_FINISHED",datetime.datetime.now(datetime.timezone.utc).isoformat(),flush=True)
if __name__=="__main__":main()
