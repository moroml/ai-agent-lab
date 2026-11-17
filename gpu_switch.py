"""画像・動画 (ComfyUI) と音楽 (ACE-Step) の GPU 切り替え。

VRAM 16GB に ACE-Step (ピーク15〜16GB) と ComfyUI のモデルは同時に載らない。
生成の直前に相手側を空ける:
- 音楽の前: ComfyUI にモデルの解放 (/free) を頼み、ACE-Step が止まっていれば起動して待つ
- 画像・動画の前: ACE-Step を止める (ACE-Step にはモデルを降ろす API が無いため)
設定は models.yaml の gpu_switch 節。enabled: false で何もしない。
"""
from __future__ import annotations

import asyncio
import re
import subprocess
import time

import httpx
import psutil

DEFAULTS = {
    "enabled": True,
    "comfy_base": "http://127.0.0.1:8188",
    "acestep_base": "http://127.0.0.1:8001",
    "acestep_start": "C:/project/ace-step/start-ace-detached.ps1",
    "acestep_process": r"acestep[\\/]api_server\.py",
    "start_timeout": 180,
}
# 切り替えと音楽生成・画像/動画の投入を直列にする (呼び出し側 hub.py が保持する)
music_busy = asyncio.Lock()


class SwitchError(Exception):
    """切り替えに失敗した (利用者向けの理由文を持つ)。"""


def settings(cfg: dict) -> dict:
    return {**DEFAULTS, **(cfg.get("gpu_switch") or {})}


async def _up(url: str, timeout: float = 3.0) -> bool:
    try:
        async with httpx.AsyncClient(timeout=timeout, trust_env=False) as client:
            return (await client.get(url)).status_code < 500
    except httpx.HTTPError:
        return False


def acestep_processes(pattern: str) -> list[psutil.Process]:
    rx = re.compile(pattern)
    found = []
    for p in psutil.process_iter(["cmdline"]):
        try:
            if rx.search(" ".join(p.info["cmdline"] or [])):
                found.append(p)
        except (psutil.Error, TypeError):
            continue
    return found


def start_acestep(script: str) -> None:
    """起動スクリプトは WMI で切り離して起動し、すぐ戻る (start-ace-detached.ps1)。"""
    subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script],
                   capture_output=True, timeout=60, check=True,
                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))


async def for_music(cfg: dict) -> list[str]:
    """ACE-Step を使える状態にする。行ったことを返す (UI 表示用)。"""
    s = settings(cfg)
    if not s["enabled"]:
        return []
    done = []
    comfy = s["comfy_base"].rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=20, trust_env=False) as client:
            q = (await client.get(comfy + "/queue")).json()
            if q.get("queue_running") or q.get("queue_pending"):
                raise SwitchError("画像・動画を生成中です。終わってから音楽を生成してください")
            r = await client.post(comfy + "/free", json={"unload_models": True, "free_memory": True})
            if r.status_code != 200:
                raise SwitchError(f"ComfyUI のモデルを解放できません (HTTP {r.status_code})")
            done.append("ComfyUI のモデルを解放")
    except httpx.ConnectError:
        pass   # ComfyUI が止まっていれば解放は不要
    except (httpx.HTTPError, ValueError) as exc:
        raise SwitchError(f"ComfyUI のモデルを解放できません: {exc.__class__.__name__}") from exc
    health = s["acestep_base"].rstrip("/") + "/health"
    if await _up(health):
        return done
    if not await asyncio.to_thread(acestep_processes, s["acestep_process"]):
        try:
            await asyncio.to_thread(start_acestep, s["acestep_start"])
        except (OSError, subprocess.SubprocessError) as exc:
            raise SwitchError(f"ACE-Step を起動できません ({s['acestep_start']}): {exc}") from exc
        done.append("ACE-Step を起動")
    deadline = time.monotonic() + float(s["start_timeout"])
    while time.monotonic() < deadline:
        if await _up(health):
            return done
        await asyncio.sleep(2)
    raise SwitchError(f"ACE-Step が {s['start_timeout']} 秒以内に起動しませんでした "
                      "(C:/project/ace-step/server.log を確認してください)")


async def for_studio(cfg: dict) -> list[str]:
    """ACE-Step を止めて ComfyUI 側に VRAM を空ける。止めきれなければ SwitchError。"""
    s = settings(cfg)
    if not s["enabled"]:
        return []
    procs = await asyncio.to_thread(acestep_processes, s["acestep_process"])
    if not procs:
        return []
    for p in procs:
        try:
            p.kill()
        except psutil.Error:
            pass
    _, alive = await asyncio.to_thread(psutil.wait_procs, procs, 15)
    if alive:
        raise SwitchError("ACE-Step を停止できませんでした (pid "
                          + ", ".join(str(p.pid) for p in alive) + ")")
    return ["ACE-Step を停止"]
