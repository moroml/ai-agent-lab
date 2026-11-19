"""接続先サーバー (Strata 等) の推論エンジンを画面から起動・停止する。

起動は Windows のタスク (schtasks) に任せる。エンジン本体の起動スクリプトとログは
各タスク側が持ち、ここは「タスクを走らせる」「ポートで待ち受けているプロセスを止める」だけ。
設定は models.yaml の engines 節。同じ group のエンジンは VRAM/RAM を取り合うため同時に動かさない。
"""
from __future__ import annotations

import asyncio
import ipaddress
import subprocess
from urllib.parse import urlsplit

import httpx
import psutil
from fastapi import APIRouter, Depends, HTTPException, Request

import hub
import llm

router = APIRouter()
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def _is_local(request: Request) -> bool:
    try:
        return ipaddress.ip_address(request.client.host if request.client else "").is_loopback
    except ValueError:
        return False


def require_local(request: Request) -> None:
    """鍵の設定やモデルの導入など、ログインしていてもこのPC以外からは受け付けない操作に使う。"""
    hub.require_local_or_key(request)
    if not _is_local(request):
        raise HTTPException(403, "この操作はこのPCからだけ行えます")


def require_local_or_login(request: Request) -> None:
    """プロセスを起動・停止する操作。このPCか、画面にログイン済みの端末 (共通キー) からだけ受け付ける。

    モデル専用キーでは通さない (2026-11-19 ユーザー指示: スマホから起動・停止できるようにする)。
    """
    hub.require_local_or_key(request)
    if not _is_local(request) and hub.openai_api._check_auth(request) is not None:
        raise HTTPException(403, "エンジンの起動・停止は、このPCかログイン済みの端末からだけ行えます")


def engine_list(cfg: dict) -> list[dict]:
    return [e for e in (cfg.get("engines") or []) if e.get("name") and e.get("base_url")]


def _find(cfg: dict, name: str) -> dict:
    for e in engine_list(cfg):
        if e["name"] == name:
            return e
    raise HTTPException(404, f"エンジン '{name}' は models.yaml の engines にありません")


def _port(base_url: str) -> int | None:
    return urlsplit(base_url).port


def _listener(port: int | None) -> psutil.Process | None:
    if not port:
        return None
    for c in psutil.net_connections(kind="tcp"):
        if c.status == psutil.CONN_LISTEN and c.laddr and c.laddr.port == port and c.pid:
            try:
                return psutil.Process(c.pid)
            except psutil.Error:
                return None
    return None


def _task_running(task: str) -> bool:
    # schtasks /query は状態を表示言語で返す(日本語だと「実行中」)ので、列挙値の State を読む
    name = task.replace("'", "''")
    r = subprocess.run(["powershell", "-NoProfile", "-Command",
                        f"(Get-ScheduledTask -TaskName '{name}' -ErrorAction SilentlyContinue).State"],
                       capture_output=True, timeout=20, creationflags=_NO_WINDOW)
    return (r.stdout or b"").decode(errors="replace").strip() == "Running"


async def _reachable(base_url: str) -> bool:
    try:
        async with httpx.AsyncClient(timeout=3, trust_env=False) as client:
            return (await client.get(base_url.rstrip("/") + "/models")).status_code == 200
    except httpx.HTTPError:
        return False


async def _state(e: dict) -> str:
    """ready=応答あり / starting=タスクかプロセスが動いているが未応答 / stopped。"""
    if await _reachable(e["base_url"]):
        return "ready"
    running = await asyncio.to_thread(_task_running, e["task"]) if e.get("task") else False
    if running or await asyncio.to_thread(_listener, _port(e["base_url"])):
        return "starting"
    return "stopped"


async def statuses(cfg: dict) -> list[dict]:
    es = engine_list(cfg)
    states = await asyncio.gather(*(_state(e) for e in es))
    return [{"name": e["name"], "label": e.get("label") or e["name"], "base_url": e["base_url"],
             "group": e.get("group", ""), "note": e.get("note", ""),
             "startable": bool(e.get("task")), "state": s} for e, s in zip(es, states)]


async def _unload_ollama() -> list[str]:
    """Ollama のロード中モデルを降ろす (エンジンが VRAM をほぼ使い切るため)。"""
    tags = await llm.loaded_model_tags()
    async with httpx.AsyncClient(timeout=20, trust_env=False) as client:
        for tag in tags:
            try:
                await client.post(f"{llm.OLLAMA_BASE}/api/generate", json={"model": tag, "keep_alive": 0})
            except httpx.HTTPError:
                pass
    return tags


@router.get("/engines", dependencies=[Depends(require_local_or_login)])
async def list_engines() -> dict:
    return {"engines": await statuses(llm.load_config())}


@router.post("/engines/{name}/start", dependencies=[Depends(require_local_or_login)])
async def start_engine(name: str) -> dict:
    from runs import manager
    cfg = llm.load_config()
    e = _find(cfg, name)
    if not e.get("task"):
        raise HTTPException(400, f"{e.get('label') or name} には起動方法 (task) が設定されていません")
    if (state := await _state(e)) != "stopped":
        return {"state": state, "done": []}
    if e.get("group"):
        for other in engine_list(cfg):
            if other is not e and other.get("group") == e["group"] and await _state(other) != "stopped":
                raise HTTPException(409, f"{other.get('label') or other['name']} が動いています。"
                                         "同時には動かせないので、先に停止してください")
    if manager.running_count():
        raise HTTPException(409, "エージェントの実行中は起動できません (Ollama のモデルを降ろすため)")
    done = [f"Ollama から {t} を降ろしました" for t in await _unload_ollama()]
    r = await asyncio.to_thread(subprocess.run, ["schtasks", "/run", "/tn", e["task"]],
                                capture_output=True, timeout=30, creationflags=_NO_WINDOW)
    if r.returncode != 0:
        msg = (r.stderr or r.stdout or b"").decode("cp932", errors="replace").strip()
        raise HTTPException(502, f"タスク {e['task']} を起動できません: {msg}")
    done.append(f"タスク {e['task']} を起動しました")
    return {"state": "starting", "done": done}


@router.post("/engines/{name}/stop", dependencies=[Depends(require_local_or_login)])
async def stop_engine(name: str) -> dict:
    e = _find(llm.load_config(), name)
    proc = await asyncio.to_thread(_listener, _port(e["base_url"]))
    if proc:
        # 同じポートを別のアプリが使っていることもあるので、目印 (既定 strata) が無ければ止めない
        mark = (e.get("process_match") or "strata").lower()
        try:
            cmd = " ".join(proc.cmdline()).lower()
        except psutil.Error:
            cmd = ""
        if mark not in cmd:
            raise HTTPException(409, f"ポート {_port(e['base_url'])} は別のプログラム ({proc.name()}) が使っています。"
                                     "エンジンではないので止めません")
        # タスクの cmd を止めても子の python/エンジンが残るので、待ち受けプロセスから木ごと止める
        for p in [*proc.children(recursive=True), proc]:
            try:
                p.kill()
            except psutil.Error:
                pass
    if e.get("task"):
        await asyncio.to_thread(subprocess.run, ["schtasks", "/end", "/tn", e["task"]],
                                capture_output=True, timeout=30, creationflags=_NO_WINDOW)
    return {"state": "stopped"}


def register(app) -> None:
    app.include_router(router)
