#!/usr/bin/env python3
"""Activate PeterLofi Twitch chat bot WITHOUT rebuilding any video publisher.

Runs on OVH as root. OAuth remains encrypted in the MediaForge local backend;
bot gets only a random private token for its local bridge. This only recreates
the MediaForge API and starts the new isolated twitch-chatbot service.
"""
from __future__ import annotations
import json
import os
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

BASE=Path("/opt/mediaforge-control")
VARS=BASE/"worker.dev.vars"
API_COMPOSE=BASE/"docker-compose.yml"
PANEL=Path("/home/ubuntu/thebusinessflow")
OFFICE=Path("/home/ubuntu/theofficemusic")
LIVE=OFFICE/"ovh-streaming"
STATE=LIVE/"state"
BOT_ENV=Path("/etc/peterlofi-twitch-chatbot.env")
API_URL="http://127.0.0.1:8790"


def run(*args,timeout=900):
    subprocess.run(list(args),check=True,timeout=timeout)


def read_vars():
    rows=[]
    vals={}
    for row in VARS.read_text(encoding="utf-8").splitlines():
        rows.append(row)
        if "=" not in row or row.startswith("#"):
            continue
        k,v=row.partition("=")[::2]
        try:vals[k]=json.loads(v)
        except ValueError:vals[k]=v.strip().strip("'\"")
    return rows,vals


def put_key(rows,key,value):
    return [row for row in rows if row.partition("=")[0]!=key]+[key+"="+json.dumps(value)]


def store_file(path,content):
    tmp=path.with_name(path.name+".new-"+str(os.getpid()))
    try:
        fd=os.open(str(tmp),os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(fd,"w",encoding="utf-8") as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        os.replace(tmp,path)
        os.chmod(path,0o600)
    finally:
        tmp.unlink(missing_ok=True)


def request(route,body,secret=None):
    headers={"content-type":"application/json"}
    if secret:headers["authorization"]="Bearer "+secret
    req=urllib.request.Request(
        API_URL+route,data=json.dumps(body).encode("utf-8"),
        headers=headers,method="POST"
    )
    with urllib.request.urlopen(req,timeout=18) as response:
        return json.load(response)


def verify_containers():
    p=subprocess.run(["docker","ps","--format","{{.Names}}"],capture_output=True,text=True,check=True)
    current=set(p.stdout.splitlines())
    if not {"mediaforge-api-ovh","peter-lofi-twitch"}.issubset(current):
        raise RuntimeError("API or Twitch publisher not running; stop without changing live.")
    # Old player can execute queue skip/back, and the bot itself prevents
    # chat requests while frozen; don't restart the running player.
    check=subprocess.run(["docker","exec","peter-lofi-twitch","grep","-q","audio-commands",
                          "/app/audio_engine.py"],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    if check.returncode!=0:
        raise RuntimeError("Running Twitch player does not support audio-commands; stop without changing live.")
    if not (STATE/"twitch"/"now-playing.json").is_file():
        raise RuntimeError("Twitch now-playing file missing. Do not enable bot yet.")


def main():
    if os.geteuid()!=0:
        raise RuntimeError("Execute com sudo na OVH.")
    for path in (VARS,API_COMPOSE,PANEL/".git",OFFICE/".git"):
        if not path.exists():raise RuntimeError("File/repo missing: "+str(path))
    verify_containers()
    print("Checking Twitch connection and existing publisher...",flush=True)
    rows,values=read_vars()
    for key in ("ADMIN_EMAIL","ADMIN_PASSWORD","SESSION_SECRET",
                "TWITCH_CLIENT_ID","TWITCH_CLIENT_SECRET"):
        if not values.get(key):raise RuntimeError("MediaForge OAuth configuration incomplete: "+key)
    login=request("/api/auth/login",{"email":values["ADMIN_EMAIL"],"password":values["ADMIN_PASSWORD"]})
    auth_token=login.get("token")
    if not auth_token:raise RuntimeError("MediaForge admin login failed.")
    get_status=urllib.request.Request(API_URL+"/api/oauth/twitch/status",
        headers={"authorization":"Bearer "+auth_token})
    with urllib.request.urlopen(get_status,timeout=12) as resp:
        status=json.load(resp)
    if not status.get("connected") or status.get("login")!="peterlofi":
        raise RuntimeError("Twitch OAuth is not connected as peterlofi; stop.")
    print("Twitch OAuth: connected.",flush=True)

    print("Synchronizing isolated bot source...",flush=True)
    run("runuser","-u","ubuntu","--","git","-C",str(PANEL),"pull","--ff-only",timeout=120)
    run("runuser","-u","ubuntu","--","git","-C",str(OFFICE),"pull","--ff-only",timeout=120)
    required=[PANEL/"cloudflare/mediaforge-worker/src/twitch-bot-bridge.js",
              LIVE/"app/twitch_chatbot.py",LIVE/"Dockerfile.chatbot"]
    if any(not p.exists() for p in required):
        raise RuntimeError("Bot files not present in checked-out repositories.")

    existing=str(values.get("TWITCH_BOT_BRIDGE_TOKEN") or "")
    token=existing if len(existing)>=48 else secrets.token_urlsafe(48)
    rows=put_key(rows,"TWITCH_BOT_BRIDGE_TOKEN",token)
    store_file(VARS,"\n".join(rows)+"\n")
    store_file(BOT_ENV,
        "TWITCH_BOT_BRIDGE_URL=http://127.0.0.1:8790/api/oauth/twitch/bot\n"
        "TWITCH_BOT_BRIDGE_TOKEN="+token+"\n"
        "TWITCH_BOT_COMMANDS_ENABLED=1\n"
        "TWITCH_BOT_CONVERSATION_ENABLED=1\n"
        "CHAT_STATE_ROOT=/state\n"
    )
    print("Private bridge secret stored. No tokens copied into bot.",flush=True)

    print("Updating only MediaForge API (Twitch publishers untouched)...",flush=True)
    run("docker","compose","-f",str(API_COMPOSE),"build","api")
    run("docker","compose","-f",str(API_COMPOSE),"up","-d","--no-deps","--force-recreate","api",timeout=120)
    status_data=None
    for _ in range(30):
        try:
            status_data=request("/api/oauth/twitch/bot/status",{},token)
            if status_data.get("connected"):break
        except Exception:
            pass
        time.sleep(2)
    if not status_data or not status_data.get("connected"):
        raise RuntimeError("Twitch bot bridge did not become ready. Stream publishers unchanged.")

    print("Building standalone Twitch chatbot only...",flush=True)
    run("docker","compose","-f",str(LIVE/"docker-compose.yml"),"build","twitch-chatbot")
    run("docker","compose","-f",str(LIVE/"docker-compose.yml"),"up","-d","--no-deps",
        "--force-recreate","twitch-chatbot",timeout=120)
    print("Waiting for Twitch EventSub subscription...",flush=True)
    for _ in range(36):
        try:
            d=json.loads((STATE/"twitch"/"chat-bot-runtime.json").read_text())
            if d.get("status")=="subscribed" and time.time()-float(d.get("updated_at",0))<40:
                print("TWITCH_CHATBOT_ACTIVE: EventSub subscribed.",flush=True)
                print("Music commands: !skip !song !back !freeze (180-second per-user cooldown).")
                print("Conversation: mention @PeterLofi for English chat replies.")
                print("No Twitch, Kick, or YouTube publisher containers were restarted.")
                print("To inspect: sudo docker logs --tail 30 peter-lofi-twitch-chatbot")
                return 0
        except (OSError,ValueError,TypeError):
            pass
        time.sleep(2)
    subprocess.run(["docker","logs","--tail","15","peter-lofi-twitch-chatbot"],check=False)
    raise RuntimeError("Twitch EventSub subscription not confirmed; inspect chatbot logs only.")


if __name__=="__main__":
    try:raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit("Activation interrupted; stream publishers unchanged.")
    except (RuntimeError,subprocess.CalledProcessError,subprocess.TimeoutExpired) as exc:
        print("BOT_ACTIVATION_FAILED",type(exc).__name__,str(exc)[:260],file=sys.stderr)
        raise SystemExit(1)
