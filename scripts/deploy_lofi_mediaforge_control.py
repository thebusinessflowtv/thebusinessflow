#!/usr/bin/env python3
"""Deploy OVH MediaForge control-plane catalog endpoint only; preserve live encoders."""
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

BASE=os.getenv("MEDIAFORGE_OVH_URL","https://peterlofi.odsgn.com.br").rstrip("/")

def call(path,token="",body=None):
    data=json.dumps(body).encode() if body is not None else None
    headers={"user-agent":"MediaForge-Lofi-Catalog-Deploy/1"}
    if token:headers["authorization"]="Bearer "+token
    if data:headers["content-type"]="application/json"
    req=urllib.request.Request(BASE+path,data=data,headers=headers,method="POST" if data else "GET")
    with urllib.request.urlopen(req,timeout=60) as resp:return json.load(resp)

def publishers(state):
    services=((state or {}).get("agent") or {}).get("services") or {}
    return {k:{"encoder_pid":v.get("encoder_pid"),"restarts":v.get("restarts"),"status":v.get("status")}
            for k,v in services.items() if isinstance(v,dict)}

def main():
    auth=call("/api/auth/login",body={"email":os.environ["ADMIN_EMAIL"],"password":os.environ["ADMIN_PASSWORD"]})
    token=auth["token"]
    print("::add-mask::"+token,flush=True)
    before=publishers(call("/api/ovh/status",token))
    cid="lofi-catalog-control-"+os.environ["GITHUB_RUN_ID"]
    result=call("/api/ovh/deploy",token,{"action":"deploy_host_agent","target":"host-agent","request_id":cid,"source":"lofi-hip-hop-selector-catalog-only"})
    print("CONTROL_PLANE_DEPLOY_REQUESTED:",cid,flush=True)
    for i in range(130):
        info=call("/api/ovh/deploy-status?id="+urllib.parse.quote(cid),token).get("command") or {}
        status=info.get("status","")
        if i%4==0 or status in ("failed","completed"):
            print("CONTROL_PLANE_DEPLOY:",status,"poll",i+1,flush=True)
        if status=="failed":
            raise RuntimeError("Control-only rollout failed: "+str(info.get("error") or "")[:700])
        if status=="completed":
            detail=info.get("result") or {}
            cp=detail.get("control_plane_publish") or {}
            print("CONTROL_PLANE_PUBLISH:",json.dumps(cp,ensure_ascii=False)[:1000],flush=True)
            if cp.get("status")=="already_applied" and cp.get("version")!="lofi-hip-hop-selector-v1":
                raise RuntimeError("Expected Lofi control-plane update did not deploy")
            break
        time.sleep(5)
    else:
        raise RuntimeError("Timed out waiting for non-publisher control-plane deployment")

    # Non-mutating negative test: invalid payload must be rejected by the new route.
    try:
        call("/api/music-library/lofi-hip-hop-sync",token,{"playlist":{"key":"lofi-hip-hop","tracks":[]}})
    except urllib.error.HTTPError as exc:
        response=json.loads(exc.read() or b"{}")
        if exc.code!=400 or response.get("error")!="invalid_lofi_catalog":
            raise RuntimeError("Unexpected API catalog route response: "+str(exc.code)+"/"+str(response.get("error")))
    else:
        raise RuntimeError("New catalog endpoint accepted an invalid playlist")
    after=publishers(call("/api/ovh/status",token))
    changed=[k for k in before if k in after and before[k].get("encoder_pid") and before[k]["encoder_pid"]!=after[k].get("encoder_pid")]
    if changed:raise RuntimeError("Unrelated live encoder PID changed: "+",".join(changed))
    print(json.dumps({"status":"LOFI_OVH_LOCAL_API_READY","existing_publishers_preserved":True,"validated_route":"/api/music-library/lofi-hip-hop-sync"},ensure_ascii=False),flush=True)

if __name__=="__main__":main()
