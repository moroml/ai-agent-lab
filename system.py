"""アプリ外でしかできなかった操作を画面から行う API (このPCからだけ)。

- VRAM を空ける: Ollama のモデルを降ろす / ComfyUI のモデルを解放 / ACE-Step を止める
- Ollama 本体の起動・終了、models.yaml にある未導入モデルの導入 (ollama pull)
- Local Gen Studio (画像・動画) と ACE-Step (音楽) の起動
- Claude API キーの設定 (.env に保存し、再起動後も使えるようにする)
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
from pathlib import Path

import httpx
import psutil
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

import engines
import gpu_switch
import hub
import llm

router = APIRouter(dependencies=[Depends(engines.require_local)])
ENV_PATH = Path(__file__).with_name(".env")
OLLAMA_APP = Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Ollama" / "ollama app.exe"
STUDIO_START = "C:/project/local-gen-studio/start-studio.bat"
_DETACHED = (getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
             | getattr(subprocess, "CREATE_NO_WINDOW", 0))
_pulls: dict[str, dict] = {}       # tag → {status, completed, total, error}
_background: set = set()


def _agent_running() -> bool:
    from runs import manager
    return bool(manager.running_count())


async def _up(url: str) -> bool:
    try:
        async with httpx.AsyncClient(timeout=2.5, trust_env=False) as client:
            return (await client.get(url)).status_code < 500
    except httpx.HTTPError:
        return False


def _spawn(args: list[str]) -> None:
    """サーバーの再起動に巻き込まれないよう切り離して起動する。"""
    subprocess.Popen(args, creationflags=_DETACHED, close_fds=True,
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _ollama_procs() -> list[psutil.Process]:
    out = []
    for p in psutil.process_iter(["name"]):
        if (p.info["name"] or "").lower() in ("ollama.exe", "ollama app.exe", "ollama"):
            out.append(p)
    return out


# ------------------------------------------------------------------ 状態
@router.get("/system/status")
async def status() -> dict:
    cfg = llm.load_config()
    s = gpu_switch.settings(cfg)
    loaded = await llm._ollama_loaded_models()
    ollama, comfy, studio, ace = await asyncio.gather(
        llm.is_alive(), _up(s["comfy_base"].rstrip("/") + "/system_stats"),
        _up(hub.studio_base(cfg) + "/"), _up(s["acestep_base"].rstrip("/") + "/health"))
    return {
        "ollama": {"up": ollama, "models": [
            {"name": m.get("name"), "size_vram": m.get("size_vram", 0)} for m in loaded or []]},
        "comfy": {"up": comfy},
        "studio": {"up": studio, "startable": Path(_studio_script(cfg)).is_file()},
        "acestep": {"up": ace},
        "anthropic_key": llm.anthropic_ready(),
        "agent_running": _agent_running(),
        "pulls": _pulls,
    }


# ------------------------------------------------------------------ VRAM
class FreeReq(BaseModel):
    # "ollama" (全部) / "ollama:<モデル名>" / "comfy" / "acestep"。空なら全部
    targets: list[str] = Field(default_factory=list, max_length=20)


async def _unload_ollama(names: list[str] | None) -> list[str]:
    loaded = [m.get("name") for m in await llm._ollama_loaded_models() or []]
    done = []
    async with httpx.AsyncClient(timeout=30, trust_env=False) as client:
        for name in loaded:
            if names is None or name in names:
                await client.post(f"{llm.OLLAMA_BASE}/api/generate", json={"model": name, "keep_alive": 0})
                done.append(f"Ollama から {name} を降ろしました")
    return done


@router.post("/system/vram/free")
async def free_vram(req: FreeReq) -> dict:
    cfg = llm.load_config()
    s = gpu_switch.settings(cfg)
    targets = req.targets or ["ollama", "comfy", "acestep"]
    picked = [t.split(":", 1)[1] for t in targets if t.startswith("ollama:")]
    if (picked or "ollama" in targets) and _agent_running():
        raise HTTPException(409, "エージェントの実行中はモデルを降ろせません。先にタスクを止めてください")
    done = []
    if "ollama" in targets or picked:
        done += await _unload_ollama(None if "ollama" in targets else picked)
    if "comfy" in targets:
        try:
            async with httpx.AsyncClient(timeout=20, trust_env=False) as client:
                q = (await client.get(s["comfy_base"].rstrip("/") + "/queue")).json()
                if q.get("queue_running") or q.get("queue_pending"):
                    raise HTTPException(409, "画像・動画を生成中です。終わってから空けてください")
                await client.post(s["comfy_base"].rstrip("/") + "/free",
                                  json={"unload_models": True, "free_memory": True})
                done.append("ComfyUI のモデルを解放しました")
        except (httpx.HTTPError, ValueError):
            pass   # 止まっていれば空ける必要はない
    if "acestep" in targets:
        if gpu_switch.music_busy.locked():
            raise HTTPException(409, "音楽を生成中です。終わってから空けてください")
        procs = await asyncio.to_thread(gpu_switch.acestep_processes, s["acestep_process"])
        for p in procs:
            for c in [*p.children(recursive=True), p]:
                try:
                    c.kill()
                except psutil.Error:
                    pass
        if procs:
            done.append("ACE-Step を停止しました")
    return {"done": done or ["空けるものはありませんでした"]}


# ------------------------------------------------------------------ Ollama
@router.post("/system/ollama/start")
async def ollama_start() -> dict:
    if await llm.is_alive():
        return {"done": ["Ollama は起動済みです"]}
    if OLLAMA_APP.is_file():
        await asyncio.to_thread(_spawn, [str(OLLAMA_APP)])
    else:
        await asyncio.to_thread(_spawn, ["ollama", "serve"])
    for _ in range(30):
        await asyncio.sleep(1)
        if await llm.is_alive():
            return {"done": ["Ollama を起動しました"]}
    raise HTTPException(504, "Ollama が30秒以内に起動しませんでした")


@router.post("/system/ollama/stop")
async def ollama_stop() -> dict:
    if _agent_running():
        raise HTTPException(409, "エージェントの実行中は Ollama を終了できません。先にタスクを止めてください")
    procs = await asyncio.to_thread(_ollama_procs)
    for p in procs:
        try:
            p.kill()
        except psutil.Error:
            pass
    return {"done": ["Ollama を終了しました" if procs else "Ollama は動いていません"]}


class PullReq(BaseModel):
    tag: str = Field(min_length=1, max_length=200)


async def _pull(tag: str) -> None:
    st = _pulls[tag]
    try:
        timeout = httpx.Timeout(None, connect=10)
        async with httpx.AsyncClient(timeout=timeout, trust_env=False) as client:
            async with client.stream("POST", f"{llm.OLLAMA_BASE}/api/pull", json={"model": tag}) as resp:
                async for line in resp.aiter_lines():
                    if not line.strip():
                        continue
                    ev = json.loads(line)
                    if ev.get("error"):
                        raise RuntimeError(ev["error"])
                    st["status"] = ev.get("status", st["status"])
                    if ev.get("total"):
                        st["completed"], st["total"] = ev.get("completed", 0), ev["total"]
        st["status"] = "success"
    except Exception as e:   # 失敗は画面に出す (サーバーは止めない)
        st["status"], st["error"] = "error", str(e)[:300]


@router.post("/system/ollama/pull")
async def ollama_pull(req: PullReq) -> dict:
    """models.yaml にあるモデルだけを導入する (任意の名前は受けない)。"""
    tags = {(m or {}).get("tag") for m in (llm.load_config().get("models") or {}).values()}
    if req.tag not in tags:
        raise HTTPException(400, "models.yaml に無いモデルは導入できません")
    if not await llm.is_alive():
        raise HTTPException(503, "Ollama が起動していません")
    if _pulls.get(req.tag, {}).get("status") not in (None, "success", "error"):
        return {"started": False}
    _pulls[req.tag] = {"status": "starting", "completed": 0, "total": 0, "error": ""}
    task = asyncio.create_task(_pull(req.tag))
    _background.add(task)
    task.add_done_callback(_background.discard)
    return {"started": True}


# ------------------------------------------------------------------ 生成系サービス
def _studio_script(cfg: dict) -> str:
    return (cfg.get("studio") or {}).get("start_script") or STUDIO_START


@router.post("/system/studio/start")
async def studio_start() -> dict:
    cfg = llm.load_config()
    if await _up(hub.studio_base(cfg) + "/"):
        return {"done": ["Local Gen Studio は起動済みです"]}
    script = _studio_script(cfg)
    if not Path(script).is_file():
        raise HTTPException(404, f"起動スクリプトがありません: {script}")
    await asyncio.to_thread(_spawn, ["cmd", "/c", script])
    return {"done": ["Local Gen Studio を起動しています (ComfyUI の準備に1〜3分かかります)"]}


@router.post("/system/acestep/start")
async def acestep_start() -> dict:
    s = gpu_switch.settings(llm.load_config())
    if await _up(s["acestep_base"].rstrip("/") + "/health"):
        return {"done": ["ACE-Step は起動済みです"]}
    try:
        await asyncio.to_thread(gpu_switch.start_acestep, s["acestep_start"])
    except (OSError, subprocess.SubprocessError) as e:
        raise HTTPException(502, f"ACE-Step を起動できません: {e}") from e
    return {"done": ["ACE-Step を起動しています"]}


# ------------------------------------------------------------------ Claude API キー
class KeyReq(BaseModel):
    key: str = Field(default="", max_length=400)


def _write_env(name: str, value: str) -> None:
    lines = ENV_PATH.read_text(encoding="utf-8").splitlines() if ENV_PATH.exists() else []
    lines = [ln for ln in lines if not re.match(rf"\s*{name}\s*=", ln)]
    if value:
        lines.append(f"{name}={value}")
    ENV_PATH.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")


@router.post("/system/anthropic-key")
async def set_anthropic_key(req: KeyReq) -> dict:
    """空文字で削除。値はサーバー側の .env (git 管理外) にだけ置き、返さない。"""
    key = req.key.strip()
    if key and not re.fullmatch(r"sk-ant-[A-Za-z0-9_\-]{20,}", key):
        raise HTTPException(400, "Claude API キーの形式ではありません (sk-ant- で始まる文字列)")
    await asyncio.to_thread(_write_env, "ANTHROPIC_API_KEY", key)
    if key:
        os.environ["ANTHROPIC_API_KEY"] = key
    else:
        os.environ.pop("ANTHROPIC_API_KEY", None)
    return {"anthropic_key": bool(key)}


def register(app) -> None:
    app.include_router(router)
