#!/usr/bin/env python3
"""Secure, one-time setup for PeterLofi Twitch bot OAuth on the OVH host.

Only recreates the MediaForge *control API* container. Does not restart any
Twitch, Kick, YouTube, audio, visual, or streaming publisher containers.
"""
from __future__ import annotations
import getpass
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path("/opt/mediaforge-control")
VARS = ROOT / "worker.dev.vars"
COMPOSE = ROOT / "docker-compose.yml"
REPO = Path("/home/ubuntu/thebusinessflow")
CALLBACK = "https://peterlofi.odsgn.com.br/api/oauth/twitch/callback"
LOCAL = "http://127.0.0.1:8790"
PUBLIC = "https://peterlofi.odsgn.com.br"
KEYS = ("TWITCH_CLIENT_ID", "TWITCH_CLIENT_SECRET", "TWITCH_OAUTH_REDIRECT_URI")


def env_file():
    raw = VARS.read_text(encoding="utf-8")
    result = {}
    for line in raw.splitlines():
        if not line.strip() or line.lstrip().startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        try:
            result[k.strip()] = json.loads(v.strip())
        except ValueError:
            result[k.strip()] = v.strip().strip("'\"")
    return raw, result


def request_json(path, data=None, token=""):
    payload = json.dumps(data).encode() if data is not None else None
    headers = {"content-type": "application/json"}
    if token:
        headers["authorization"] = "Bearer " + token
    request = urllib.request.Request(LOCAL + path, data=payload, headers=headers,
                                     method="POST" if payload is not None else "GET")
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.load(response)


def server_probe(base):
    req = urllib.request.Request(base + "/api/oauth/twitch/callback",
                                 headers={"user-agent": "PeterLofi-OAuth-Setup"})
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            return response.status, response.read(700).decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read(700).decode("utf-8", "replace")


def print_status():
    _, vars = env_file()
    if not all(vars.get(k) for k in KEYS):
        print("OAuth credentials are not configured.")
        return 2
    try:
        login = request_json("/api/auth/login", {"email": vars["ADMIN_EMAIL"],
                     "password": vars["ADMIN_PASSWORD"]})
        token = login.get("token")
        status = request_json("/api/oauth/twitch/status", token=token)
        print(json.dumps(status, indent=2, ensure_ascii=False))
        return 0
    except Exception as exc:
        print("Unable to check Twitch connection:", type(exc).__name__)
        return 1


def main():
    if os.geteuid() != 0:
        raise SystemExit("Execute com sudo; não cole o Client Secret no chat.")
    if not VARS.is_file() or not COMPOSE.is_file():
        raise SystemExit("Controle local MediaForge não encontrado em /opt/mediaforge-control. Pare aqui.")
    if len(sys.argv) > 1 and sys.argv[1] == "--status":
        return print_status()
    if not (REPO / "cloudflare/mediaforge-worker/src/twitch-oauth.js").is_file():
        raise SystemExit("Atualize o repositório /home/ubuntu/thebusinessflow com git pull --ff-only primeiro.")
    print("=== Twitch OAuth / PeterLofi (somente API, sem reiniciar as lives) ===")
    client_id = input("Cole o Client ID da Twitch: ").strip()
    client_secret = getpass.getpass("Cole o Client Secret da Twitch (oculto): ").strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{8,128}", client_id):
        raise SystemExit("Client ID inválido.")
    if not client_secret or len(client_secret) > 512 or "\n" in client_secret:
        raise SystemExit("Client Secret inválido.")
    old_raw, values = env_file()
    for key in ("ADMIN_EMAIL", "ADMIN_PASSWORD", "SESSION_SECRET"):
        if not values.get(key):
            raise SystemExit("Configuração existente incompleta: " + key + ". Nada foi alterado.")
    updated_lines = []
    for line in old_raw.splitlines():
        key = line.partition("=")[0].strip()
        if key in KEYS:
            continue
        updated_lines.append(line)
    for key, value in (
        ("TWITCH_CLIENT_ID", client_id),
        ("TWITCH_CLIENT_SECRET", client_secret),
        ("TWITCH_OAUTH_REDIRECT_URI", CALLBACK),
    ):
        updated_lines.append(key + "=" + json.dumps(value))
    backup = VARS.with_name("worker.dev.vars.pre-twitch-oauth")
    if not backup.exists():
        shutil.copy2(VARS, backup)
        os.chmod(backup, 0o600)
    fd, name = tempfile.mkstemp(prefix=".twitch-oauth-", dir=str(ROOT))
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            output.write("\n".join(updated_lines) + "\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(name, VARS)
    finally:
        if os.path.exists(name):
            os.unlink(name)
    os.chmod(VARS, 0o600)
    client_secret = None
    print("Credenciais armazenadas no backend com permissão 0600.")
    print("Atualizando exclusivamente a API local (sem tocar nos encoders)...")
    subprocess.run(["docker", "compose", "-f", str(COMPOSE), "build", "api"], check=True, timeout=600)
    subprocess.run(["docker", "compose", "-f", str(COMPOSE), "up", "-d", "--no-deps", "--force-recreate", "api"], check=True, timeout=120)
    for i in range(35):
        try:
            status = request_json("/api/health")
            if status.get("ok"):
                break
        except Exception:
            pass
        time.sleep(2)
    else:
        raise SystemExit("A API não respondeu. As lives não foram reiniciadas; verifique o container da API.")
    for base, label in ((LOCAL, "local"), (PUBLIC, "public")):
        try:
            status, body = server_probe(base)
        except Exception as exc:
            raise SystemExit(f"Callback {label} inacessível ({type(exc).__name__}). Não autorize ainda.")
        if status != 400 or "Invalid OAuth authorization request" not in body:
            raise SystemExit(f"Callback {label} inesperado (HTTP {status}). Não autorize ainda.")
        print(f"OAuth callback {label}: OK (HTTP 400 esperado sem código).")
    login = request_json("/api/auth/login", {"email": values["ADMIN_EMAIL"],
                                            "password": values["ADMIN_PASSWORD"]})
    token = str(login.get("token") or "")
    if not token:
        raise SystemExit("A autenticação administrativa não funcionou. Não autorize ainda.")
    auth = request_json("/api/oauth/twitch/start", token=token)
    url = str(auth.get("authorization_url") or "")
    if not url.startswith("https://id.twitch.tv/oauth2/authorize?"):
        raise SystemExit("A rota OAuth não produziu URL válida.")
    print("\n=== AUTORIZAR TWITCH (link válido por 10 minutos) ===")
    print("Cole o endereço abaixo no navegador do Mac, conectado como PeterLofi:")
    print(url)
    print("\nApós aceitar as permissões, execute:")
    print("  sudo python3 /home/ubuntu/thebusinessflow/scripts/configure-peterlofi-twitch-oauth.py --status")
    print("Esperado: connected = true. O bot de chat ainda precisa do adaptador de mensagens.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit("\nOperação interrompida.")
