#!/usr/bin/env python3
"""Repair PeterLofi OAuth callback without modifying livestream publishers.

This script only rebuilds/recreates mediaforge-api-ovh, probes GET + form POST,
checks existing OAuth status and issues a one-time new authorization if needed.
Client ID and Client Secret remain in worker.dev.vars (0600).
"""
from __future__ import annotations
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT=Path("/opt/mediaforge-control")
COMPOSE=ROOT/"docker-compose.yml"
VARS=ROOT/"worker.dev.vars"
SOURCE=Path("/home/ubuntu/thebusinessflow/cloudflare/mediaforge-worker/src/twitch-oauth.js")
LOCAL="http://127.0.0.1:8790"
PUBLIC="https://peterlofi.odsgn.com.br"
CALLBACK="/api/oauth/twitch/callback"


def config():
    values={}
    for raw in VARS.read_text().splitlines():
        key,sep,val=raw.partition("=")
        if not sep or not key.strip() or key.startswith("#"):
            continue
        try:values[key.strip()]=json.loads(val)
        except (ValueError,TypeError):values[key.strip()]=val.strip().strip("'\"")
    return values


def http(url, method="GET", body=None, bearer=""):
    headers={"user-agent":"MediaForge-OAuth-Repair/1.0"}
    if body is not None:
        headers["content-type"]="application/x-www-form-urlencoded" if isinstance(body,str) else "application/json"
        body=(body if isinstance(body,str) else json.dumps(body)).encode()
    if bearer:headers["authorization"]="Bearer "+bearer
    req=urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req,timeout=25) as resp:
            return resp.status,resp.read(16384).decode("utf-8","replace")
    except urllib.error.HTTPError as exc:
        return exc.code,exc.read(16384).decode("utf-8","replace")


def check_callback():
    for base,label in ((LOCAL,"local"),(PUBLIC,"public")):
        for method,body in (("GET",None),("POST","code=invalid&state=invalid")):
            status, response=http(base+CALLBACK,method=method,body=body)
            if status!=400 or "Invalid OAuth authorization request" not in response:
                raise RuntimeError(
                    f"Callback {label} {method}: HTTP {status}; expected OAuth 400 HTML. "
                    "Do not authorize Twitch yet."
                )
            print(f"Callback {label} {method}: OK (invalid request rejected correctly).",flush=True)


def main():
    if os.geteuid()!=0:
        raise SystemExit("Execute com sudo dentro da OVH.")
    if not COMPOSE.is_file() or not VARS.is_file() or not SOURCE.is_file():
        raise SystemExit("Controle/credenciais/codigo da API não encontrados. Verifique o git pull.")
    values=config()
    needed=("ADMIN_EMAIL","ADMIN_PASSWORD","SESSION_SECRET","TWITCH_CLIENT_ID",
            "TWITCH_CLIENT_SECRET","TWITCH_OAUTH_REDIRECT_URI")
    if any(not values.get(k) for k in needed):
        raise SystemExit("Configuração incompleta. Reexecute o instalador OAuth inicial se necessário.")
    if values["TWITCH_OAUTH_REDIRECT_URI"]!=PUBLIC+CALLBACK:
        raise SystemExit("A URL de redirecionamento no servidor não corresponde à registrada na Twitch.")
    services=subprocess.run(["docker","compose","-f",str(COMPOSE),"config","--services"],
                            capture_output=True,text=True,check=True).stdout.splitlines()
    if "api" not in services:
        raise SystemExit("Servico api nao encontrado no Docker Compose.")
    print("Atualizando exclusivamente a API (sem mexer nos containers das lives)...",flush=True)
    subprocess.run(["docker","compose","-f",str(COMPOSE),"build","api"],check=True,timeout=900)
    subprocess.run(["docker","compose","-f",str(COMPOSE),"up","-d","--no-deps",
                    "--force-recreate","api"],check=True,timeout=120)
    for _ in range(35):
        try:
            status,raw=http(LOCAL+"/api/health")
            if status==200 and json.loads(raw).get("ok"):break
        except Exception:
            pass
        time.sleep(2)
    else:raise RuntimeError("A API local não ficou saudável. Não autorize ainda.")
    check_callback()
    status,resp=http(LOCAL+"/api/auth/login",method="POST",body={
        "email":values["ADMIN_EMAIL"],"password":values["ADMIN_PASSWORD"]})
    if status!=200:raise RuntimeError("Login administrativo local indisponivel.")
    token=str(json.loads(resp).get("token") or "")
    if not token:raise RuntimeError("Login administrativo sem token.")
    status,resp=http(LOCAL+"/api/oauth/twitch/status",bearer=token)
    if status!=200:raise RuntimeError(f"Status OAuth indisponível: HTTP {status}")
    connected=bool(json.loads(resp).get("connected"))
    if connected:
        print("\nTwitch já autorizada! connected: true. Não é necessário repetir OAuth.",flush=True)
        return 0
    status,resp=http(LOCAL+"/api/oauth/twitch/start",bearer=token)
    if status!=200:raise RuntimeError(f"Não foi possível criar nova autorização: HTTP {status}")
    uri=str(json.loads(resp).get("authorization_url") or "")
    if not uri.startswith("https://id.twitch.tv/oauth2/authorize?"):
        raise RuntimeError("URL de autorização inválida.")
    print("\nAbra NO CHROME como PeterLofi o link abaixo. Valido por 10 minutos:")
    print(uri,flush=True)
    print("\nNAO compartilhe a URL nem prints que a exibam.")
    print("\nApós autorizar, execute:")
    print("  sudo python3 /home/ubuntu/thebusinessflow/scripts/configure-peterlofi-twitch-oauth.py --status")
    return 0


if __name__=="__main__":
    try:sys.exit(main())
    except (RuntimeError,subprocess.CalledProcessError) as exc:
        print("Falha no reparo:", str(exc),file=sys.stderr)
        print("As lives não foram reiniciadas.",file=sys.stderr)
        sys.exit(1)
