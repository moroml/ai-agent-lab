"""ai-agent-lab の起動係。サーバー (8765) が止まっていても、スマホのアプリから立ち上げられるようにする。

このPCのログオン時に常駐させ (install-launcher.ps1)、127.0.0.1:8766 だけで待ち受ける。
外からは Tailscale Serve の中継 (https://<このPC>:8766) を通ってくる。

  GET  /status  -> {"running": サーバーが応答するか, "starting": 起動中か, "detail": 直近の失敗}
  POST /start   -> 止まっていれば restart-server-detached.ps1 を走らせて 202 (ヘッダ X-AAL-Launcher: 1 が必要)
"""
from __future__ import annotations

import ipaddress
import json
import subprocess
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).parent
PORT = 8766
HEALTH = "http://127.0.0.1:8765/health"
TAILNET = ipaddress.ip_network("100.64.0.0/10")
LOCAL_HOSTS = ("127.0.0.1", "localhost")
START_TIMEOUT_S = 180

_state = {"starting": False, "detail": ""}
_lock = threading.Lock()


def running() -> bool:
    try:
        # 既定のプロキシ設定を通さない (このPC宛てが外へ回ると常に失敗する)
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        return opener.open(HEALTH, timeout=3).status == 200
    except OSError:
        return False


def allowed(headers) -> bool:
    """受け付けるのは、このPC自身と、Tailscale Serve が中継した Tailscale の端末だけ。

    別サイトのページからの要求 (CSRF・DNS リバインディング) は Origin と Host で弾く。このPCのブラウザは
    X-Forwarded-For を偽れるが Host は偽れないので、中継された要求は Host が Tailscale の名前のときだけ通す。
    """
    host = headers.get("Host", "")
    origin = headers.get("Origin")
    if origin and urlsplit(origin).netloc != host:
        return False
    fwd = headers.get("X-Forwarded-For")
    if not fwd:
        return urlsplit("//" + host).hostname in LOCAL_HOSTS
    if not (urlsplit("//" + host).hostname or "").endswith(".ts.net"):
        return False
    try:
        return ipaddress.ip_address(fwd.split(",")[-1].strip()) in TAILNET
    except ValueError:
        return False


def _start() -> None:
    try:
        r = subprocess.run(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(ROOT / "restart-server-detached.ps1")],
            capture_output=True, text=True, timeout=START_TIMEOUT_S, creationflags=subprocess.CREATE_NO_WINDOW)
        detail = "" if r.returncode == 0 else (r.stderr or r.stdout).strip()[-300:] or "起動に失敗しました"
    except (OSError, subprocess.TimeoutExpired) as e:
        detail = f"起動に失敗しました: {e}"
    with _lock:
        _state.update(starting=False, detail=detail)


def start() -> bool:
    """起動を始めたら True。すでに動いているか起動中なら何もしない。"""
    with _lock:
        if _state["starting"] or running():
            return False
        _state.update(starting=True, detail="")
    threading.Thread(target=_start, daemon=True).start()
    return True


class Handler(BaseHTTPRequestHandler):
    def _send(self, status: int, body: dict) -> None:
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _status(self) -> dict:
        return {"running": running(), **_state}

    def do_GET(self):
        if not allowed(self.headers):
            return self._send(403, {"detail": "このPCか Tailscale の端末からだけ使えます"})
        if self.path != "/status":
            return self._send(404, {"detail": "not found"})
        self._send(200, self._status())

    def do_POST(self):
        if not allowed(self.headers) or self.headers.get("X-AAL-Launcher") != "1":
            return self._send(403, {"detail": "このPCか Tailscale の端末からだけ使えます"})
        if self.path != "/start":
            return self._send(404, {"detail": "not found"})
        start()
        self._send(202, self._status())

    def log_message(self, *args):   # pythonw では標準エラーが無い
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
