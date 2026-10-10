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
    for attempt in range(24):
        try:
            with urllib.request.urlopen(req,timeout=60) as resp:return json.load(resp)
        except urllib.error.HTTPError as exc:
            if exc.code not in (502,503,504,520,521,522,524) or attempt==23:
                raise
            print("TRANSIENT_OVH_API_HTTP:",exc.code,"retry",attempt+1,flush=True)
        except (urllib.error.URLError,TimeoutError,OSError) as exc:
            if attempt==23:raise
            print("TRANSIENT_OVH_API_CONNECTION:",type(exc).__name__,"retry",attempt+1,flush=True)
        time.sleep(min(15,3+attempt))

def publishers(state):
    services=((state or {}).get("agent") or {}).get("services") or {}
    return {k:{"encoder_pid":v.get("encoder_pid"),"restarts":v.get("restarts"),"status":v.get("status")}
            for k,v in services.items() if isinstance(v,dict)}

def main():
    auth=call("/api/auth/login",body={"email":os.environ["ADMIN_EMAIL"],"password":os.environ["ADMIN_PASSWORD"]})
    token=auth["token"]
    print("::add-mask::"+token,flush=True)
    before=publishers(call("/api/ovh/status",token))
    # Idempotent per GitHub run. Redeploy the control-plane only when the
    # publication marker version has changed; RTMP containers are never restarted.
    cid="youtube-slotless-control-"+os.environ["GITHUB_RUN_ID"]
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
            if cp.get("status")=="already_applied" and cp.get("version")!="lofi-release-verified-orphan-20261010-v1":
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

    # Verify the public files served by the EXACT user-facing app URL, not just
    # the repository source or a generic 'ui_verified' flag from the deployer.
    urls={
        "app.html":BASE+"/app.html?verify=20261009-slotless-live2",
        "app-core.html":BASE+"/app-core.html?verify=20261009-slotless-live2",
        "lives.html":BASE+"/lives.html?verify=20261009-slotless-live2",
        "lives-cloudflare.js":BASE+"/lives-cloudflare.js?verify=20261009-slotless-live2"
    }
    for attempt in range(12):
        bodies={}
        try:
            for name,url in urls.items():
                request=urllib.request.Request(url,headers={"user-agent":"MediaForge-Production-Route-Check","cache-control":"no-cache"})
                with urllib.request.urlopen(request,timeout=24) as res:
                    bodies[name]=res.read().decode("utf-8")
            checks={
                "app_loader":'app-core.html?v=20261009-slotless-live2' in bodies["app.html"],
                "lives_route":'lives.html?platform=' in bodies["app-core.html"] and 'v=20261009-slotless-live2' in bodies["app-core.html"],
                "live_script_reference":'lives-cloudflare.js?v=20261009-slotless-live2' in bodies["lives.html"],
                "no_manual_slot_field":'SLOT OVH DO YOUTUBE' not in bodies["lives-cloudflare.js"],
                "auto_allocator_notice":'O MediaForge escolhe automaticamente' in bodies["lives-cloudflare.js"]
            }
            print("PRODUCTION_UI_VALIDATION:",json.dumps(checks),flush=True)
            if all(checks.values()):
                print("PRODUCTION_SLOTLESS_UI_VERIFIED: https://peterlofi.odsgn.com.br/app.html#/peter-lofi/lives",flush=True)
                break
        except Exception as exc:
            print("PRODUCTION_UI_CHECK_RETRY:",type(exc).__name__,str(exc)[:170],flush=True)
        if attempt==11:
            raise RuntimeError("PRODUCTION_SLOTLESS_UI_NOT_VERIFIED; UI may still serve old YouTube slot field")
        time.sleep(3)

    # Read-only end-to-end check: the *running* host deploy-agent must advertise
    # the new dedicated publisher action before the UI can be considered ready.
    probe_id="lofi-host-capability-"+os.environ["GITHUB_RUN_ID"]
    call("/api/ovh/deploy",token,{"action":"health_check","target":"all","request_id":probe_id,"source":"lofi-safe-capability-probe"})
    capability=None
    for i in range(48):
        row=call("/api/ovh/deploy-status?id="+urllib.parse.quote(probe_id),token).get("command") or {}
        if row.get("status")=="failed":
            raise RuntimeError("OVH host capability probe failed")
        if row.get("status")=="completed":
            capability=((row.get("result") or {}).get("capabilities") or {})
            break
        time.sleep(3)
    if not capability or capability.get("isolated_lofi_youtube") is not True:
        raise RuntimeError("Live OVH host agent does not advertise isolated Lofi YouTube support")
    print("LIVE_HOST_LOFI_CAPABILITY_VERIFIED:",json.dumps(capability),flush=True)

    after=publishers(call("/api/ovh/status",token))
    changed=[k for k in before if k in after and before[k].get("encoder_pid") and before[k]["encoder_pid"]!=after[k].get("encoder_pid")]
    if changed:raise RuntimeError("Unrelated live encoder PID changed: "+",".join(changed))
    print(json.dumps({"status":"LOFI_OVH_LOCAL_API_READY","existing_publishers_preserved":True,"validated_route":"/api/music-library/lofi-hip-hop-sync"},ensure_ascii=False),flush=True)

if __name__=="__main__":main()
