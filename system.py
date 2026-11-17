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
OLLAMA_EXE = Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Ollama" / "ollama.exe"
# 画面から起動する Ollama に補う最適化 env (ユーザー設定があればそちらを優先。旧 start.ps1 / app.py と同じ値)
OLLAMA_ENV_DEFAULTS = {
    "OLLAMA_FLASH_ATTENTION": "1",       # q8_0 KV の前提 + プロンプト処理の高速化
    "OLLAMA_KV_CACHE_TYPE": "q8_0",      # KV キャッシュのメモリ半減
    "OLLAMA_NUM_PARALLEL": "2",          # swarm の同一モデル2並列
    "OLLAMA_MAX_LOADED_MODELS": "1",     # VRAM 16GB では常駐1本
}
# Local Gen Studio の部品。start-studio.bat はブラウザまで開くので、部品を直接起動する
STUDIO_ROOT = Path("C:/project/local-gen-studio")
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


def _spawn(args: list[str], env: dict | None = None) -> None:
    """サーバーの再起動に巻き込まれないよう切り離して起動する。"""
    subprocess.Popen(args, creationflags=_DETACHED, close_fds=True, env=env,
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
        "studio": {"up": studio, "startable": all(p.is_file() for p in _studio_parts(cfg))},
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
                r = await client.post(f"{llm.OLLAMA_BASE}/api/generate", json={"model": name, "keep_alive": 0})
                if r.status_code != 200:
                    raise HTTPException(502, f"Ollama から {name} を降ろせません (HTTP {r.status_code})")
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
        llm.keepwarm_paused = True   # 空けた直後に裏で温め直さない
        done += await _unload_ollama(None if "ollama" in targets else picked)
    if "comfy" in targets:
        try:
            async with httpx.AsyncClient(timeout=20, trust_env=False) as client:
                q = (await client.get(s["comfy_base"].rstrip("/") + "/queue")).json()
                if q.get("queue_running") or q.get("queue_pending"):
                    raise HTTPException(409, "画像・動画を生成中です。終わってから空けてください")
                r = await client.post(s["comfy_base"].rstrip("/") + "/free",
                                      json={"unload_models": True, "free_memory": True})
                if r.status_code != 200:
                    raise HTTPException(502, f"ComfyUI のモデルを解放できません (HTTP {r.status_code})")
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
    env = {**OLLAMA_ENV_DEFAULTS, **os.environ}
    exe = str(OLLAMA_EXE) if OLLAMA_EXE.is_file() else "ollama"
    try:
        await asyncio.to_thread(_spawn, [exe, "serve"], env)
    except OSError as e:
        raise HTTPException(404, f"Ollama を起動できません (未導入?): {e}") from e
    for _ in range(30):
        await asyncio.sleep(1)
        if await llm.is_alive():
            return {"done": ["Ollama を起動しました"]}
    raise HTTPException(504, "Ollama が30秒以内に起動しませんでした")


@router.post("/system/ollama/stop")
async def ollama_stop() -> dict:
    if _agent_running():
        raise HTTPException(409, "エージェントの実行中は Ollama を終了できません。先にタスクを止めてください")
    llm.keepwarm_paused = True
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
                if resp.status_code != 200:
                    raise RuntimeError(f"HTTP {resp.status_code}: {(await resp.aread())[:200]!r}")
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
def _studio_parts(cfg: dict) -> tuple[Path, Path]:
    root = Path((cfg.get("studio") or {}).get("root") or STUDIO_ROOT)
    return root / "comfyui" / "run-comfy.bat", root / "app" / "run-app.bat"


@router.post("/system/studio/start")
async def studio_start() -> dict:
    cfg = llm.load_config()
    comfy_bat, app_bat = _studio_parts(cfg)
    if not (comfy_bat.is_file() and app_bat.is_file()):
        raise HTTPException(404, f"Local Gen Studio が見つかりません: {comfy_bat.parent.parent}")
    done = []
    if not await _up(gpu_switch.settings(cfg)["comfy_base"].rstrip("/") + "/system_stats"):
        await asyncio.to_thread(_spawn, ["cmd", "/c", str(comfy_bat)])
        done.append("ComfyUI を起動しています (準備に1〜3分かかります)")
    if not await _up(hub.studio_base(cfg) + "/"):
        await asyncio.to_thread(_spawn, ["cmd", "/c", str(app_bat)])
        done.append("Local Gen Studio のアプリを起動しています")
    return {"done": done or ["Local Gen Studio は起動済みです"]}


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


@router.post("/system/engines/start")
async def start_all() -> dict:
    """ワンボタン起動: Ollama → 画像・動画 → 音楽。1つ失敗しても残りは続ける。"""
    done, failed = [], []
    for label, fn in (("Ollama", ollama_start), ("画像・動画", studio_start), ("音楽", acestep_start)):
        try:
            done += (await fn())["done"]
        except HTTPException as e:
            failed.append(f"{label}: {e.detail}")
    if await llm.is_alive():
        llm.keepwarm_paused = False
        task = asyncio.create_task(llm.prewarm_default())   # 初回タスクのロード待ちを先に済ませる
        _background.add(task)
        task.add_done_callback(_background.discard)
        done.append("既定モデルを読み込んでいます")
    return {"done": done, "failed": failed}


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
