#!/usr/bin/env python3
"""Provision PeterLofi Kick OAuth + webhook inbox on OVH without touching publishers.

--setup: configures API creds and private Kick bot secret, rebuilds API ONLY.
--finish: after user OAuth authorization, subscribes verified chat webhooks,
          then builds/recreates only the isolated Kick chatbot.
--status: reads connection status without modifying anything.
Never paste secret or OAuth callback code into the chat.
"""
from __future__ import annotations
import getpass
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT=Path("/opt/mediaforge-control")
VARS=ROOT/"worker.dev.vars"
COMPOSE=ROOT/"docker-compose.yml"
REPO=Path("/home/ubuntu/thebusinessflow")
LIVE=Path("/home/ubuntu/theofficemusic/ovh-streaming")
KICK_ENV=Path("/etc/peterlofi-kick-chatbot.env")
LOCAL="http://127.0.0.1:8790"
PUBLIC="https://peterlofi.odsgn.com.br"
CALLBACK=PUBLIC+"/api/oauth/kick/callback"
WEBHOOK=PUBLIC+"/api/webhooks/kick"
KEYS={"KICK_CLIENT_ID","KICK_CLIENT_SECRET","KICK_OAUTH_REDIRECT_URI","KICK_BOT_BRIDGE_TOKEN"}


def config():
    raw=VARS.read_text(encoding="utf-8")
    data={}
    for line in raw.splitlines():
        if line.lstrip().startswith("#") or "=" not in line:continue
        key,value=line.split("=",1)
        try:data[key.strip()]=json.loads(value.strip())
        except ValueError:data[key.strip()]=value.strip().strip("'\"")
    return raw,data


def write_atomic(path,value):
    path.parent.mkdir(parents=True,exist_ok=True)
    fd,tmp=tempfile.mkstemp(prefix=".kick-setup-",dir=str(path.parent))
    try:
        os.fchmod(fd,0o600)
        with os.fdopen(fd,"w",encoding="utf-8") as f:
            f.write(value);f.flush();os.fsync(f.fileno())
        os.replace(tmp,path)
    finally:
        if os.path.exists(tmp):os.unlink(tmp)


def api(endpoint,payload=None,token=""):
    raw=json.dumps(payload).encode() if payload is not None else None
    h={"Content-Type":"application/json"}
    if token:h["Authorization"]="Bearer "+token
    req=urllib.request.Request(LOCAL+endpoint,data=raw,headers=h,
                               method="POST" if raw is not None else "GET")
    with urllib.request.urlopen(req,timeout=22) as resp:
        return json.load(resp)


def admin_token(config_vars):
    if not config_vars.get("ADMIN_EMAIL") or not config_vars.get("ADMIN_PASSWORD"):
        raise RuntimeError("MediaForge admin credentials missing")
    response=api("/api/auth/login",{"email":config_vars["ADMIN_EMAIL"],
                                   "password":config_vars["ADMIN_PASSWORD"]})
    return str(response.get("token") or "")


def status():
    _,vars=config()
    if not all(vars.get(k) for k in KEYS):
        print("KICK_NOT_CONFIGURED");return 2
    result=api("/api/oauth/kick/status",token=admin_token(vars))
    print(json.dumps(result,ensure_ascii=False,indent=2))
    return 0


def setup():
    if not VARS.is_file() or not COMPOSE.is_file():
        raise RuntimeError("OVH MediaForge control API installation not found")
    if not (REPO/"cloudflare/mediaforge-worker/src/kick-oauth-bot.js").is_file():
        raise RuntimeError("Update /home/ubuntu/thebusinessflow with git pull --ff-only")
    if not (LIVE/"app/kick_chatbot.py").is_file():
        raise RuntimeError("Update /home/ubuntu/theofficemusic with git pull --ff-only")
    client=input("Kick Client ID (private): ").strip()
    secret=getpass.getpass("Kick Client Secret (hidden): ").strip()
    if not re.fullmatch(r"[a-zA-Z0-9_-]{8,130}",client):
        raise RuntimeError("Invalid Kick Client ID")
    if not secret or len(secret)>500 or "\n" in secret:
        raise RuntimeError("Invalid Kick Client Secret")
    raw,vars=config()
    for key in ("ADMIN_EMAIL","ADMIN_PASSWORD","SESSION_SECRET"):
        if not vars.get(key):raise RuntimeError("Missing existing admin session config: "+key)
    bot_secret=str(vars.get("KICK_BOT_BRIDGE_TOKEN") or "")
    if len(bot_secret)<48:bot_secret=secrets.token_urlsafe(48)
    updated=[line for line in raw.splitlines() if line.split("=",1)[0].strip() not in KEYS]
    new={
        "KICK_CLIENT_ID":client,"KICK_CLIENT_SECRET":secret,
        "KICK_OAUTH_REDIRECT_URI":CALLBACK,"KICK_BOT_BRIDGE_TOKEN":bot_secret,
    }
    for key,value in new.items():updated.append(key+"="+json.dumps(value))
    backup=ROOT/"worker.dev.vars.before-kick-oauth"
    if not backup.exists():
        shutil.copy2(VARS,backup);os.chmod(backup,0o600)
    write_atomic(VARS,"\n".join(updated)+"\n")
    write_atomic(KICK_ENV,"\n".join([
        "CHAT_STATE_ROOT=/state",
        "KICK_BOT_BRIDGE_URL=http://127.0.0.1:8790/api/oauth/kick/bot",
        "KICK_BOT_COMMANDS_ENABLED=1",
        "KICK_BOT_CONVERSATION_ENABLED=1",
        "KICK_BOT_BRIDGE_TOKEN="+bot_secret,
    ])+"\n")
    del secret
    print("Credentials stored privately on OVH; 0600 permissions.",flush=True)
    print("Building/recreating only the MediaForge CONTROL API; publishers remain untouched.",flush=True)
    subprocess.run(["docker","compose","-f",str(COMPOSE),"build","api"],check=True,timeout=600)
    subprocess.run(["docker","compose","-f",str(COMPOSE),"up","-d","--no-deps","--force-recreate","api"],check=True,timeout=120)
    for _ in range(45):
        try:
            if api("/api/health").get("ok"):break
        except Exception:pass
        time.sleep(2)
    else:raise RuntimeError("API did not become healthy; check mediaforge-api-ovh logs.")
    token=admin_token(vars)
    probe=api("/api/oauth/kick/status",token=token)
    print("Kick API route reachable. Connected:",probe.get("connected"),flush=True)
    start=api("/api/oauth/kick/start",{},token=token)
    url=start.get("authorization_url","")
    if not url.startswith("https://id.kick.com/oauth/authorize?"):
        raise RuntimeError("Kick authorize URL not produced")
    print("\nOpen this 10-minute authorization URL in your own browser, logged in as PeterLofi.")
    print("DO NOT SHARE THE URL:",url,sep="\n")
    print("\nAfter authorization shows Connected, run:")
    print("sudo python3 /home/ubuntu/thebusinessflow/scripts/configure-peterlofi-kick-oauth.py --finish")
    return 0


def finish():
    _,vars=config()
    token=admin_token(vars)
    check=api("/api/oauth/kick/status",token=token)
    if not check.get("connected"):
        raise RuntimeError("OAuth not yet authorized; open the one-time URL from --setup.")
    if not check.get("subscribed"):
        print("Subscribing to signed Kick chat events...",flush=True)
        r=api("/api/oauth/kick/subscribe",{},token=token)
        if not r.get("ok"):raise RuntimeError("Kick event subscription unsuccessful.")
    if not KICK_ENV.is_file() or not (LIVE/"app/kick_chatbot.py").is_file():
        raise RuntimeError("Kick bot or environment not installed")
    print("Webhook subscription active. Recreating ONLY the Kick chat bot.",flush=True)
    subprocess.run(["docker","compose","-f",str(LIVE/"docker-compose.yml"),
                    "--project-directory",str(LIVE),"build","kick-chatbot"],check=True,timeout=600)
    subprocess.run(["docker","compose","-f",str(LIVE/"docker-compose.yml"),
                    "--project-directory",str(LIVE),"up","-d","--no-deps",
                    "--force-recreate","kick-chatbot"],check=True,timeout=120)
    print("KICK_BOT_STARTED: Please enable Kick webhooks in app settings and test !song.")
    print("Live Twitch, Kick and YouTube publishers were NOT restarted.")
    return 0


def main():
    if os.geteuid()!=0:raise RuntimeError("Run via sudo on the OVH host")
    if len(sys.argv)!=2 or sys.argv[1] not in ("--setup","--finish","--status"):
        raise RuntimeError("Usage: --setup | --finish | --status")
    return {"--setup":setup,"--finish":finish,"--status":status}[sys.argv[1]]()


if __name__=="__main__":
    try:raise SystemExit(main())
    except KeyboardInterrupt:raise SystemExit("Cancelled; no stream containers restarted.")
    except (OSError,ValueError,RuntimeError,subprocess.CalledProcessError,urllib.error.HTTPError) as err:
        print("KICK_SETUP_ERROR",type(err).__name__,str(err)[:250],file=sys.stderr)
        raise SystemExit(1)
