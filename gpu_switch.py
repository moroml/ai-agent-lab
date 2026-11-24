"""画像・動画 (ComfyUI)・音楽 (ACE-Step)・音声合成 (tts-<engine>) の GPU 切り替え。

VRAM 16GB にこれらのモデルは同時に載らない。生成の直前に他の側を空ける:
- 音楽の前: ComfyUI にモデルの解放 (/free) を頼み、音声合成を止め、ACE-Step が止まっていれば起動して待つ
- 音声の前: ComfyUI を解放し、ACE-Step と他の音声合成を止め、使う音声合成が止まっていれば起動して待つ
- 画像・動画の前: ACE-Step と音声合成を止める (どちらもモデルを降ろす API に頼らず、プロセスごと止める)
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
    # 音声合成のサーバー (C:/project/tts-<engine>/server.py)。プロセスはコマンド行の tts-<engine> で見分ける
    "speech": {
        "qwen3": {"base": "http://127.0.0.1:8011", "start": "C:/project/tts-qwen3/start-detached.ps1"},
        "indextts": {"base": "http://127.0.0.1:8012", "start": "C:/project/tts-indextts/start-detached.ps1"},
        "fish": {"base": "http://127.0.0.1:8013", "start": "C:/project/tts-fish/start-detached.ps1"},
    },
}
# 切り替えと音楽・音声の生成・画像/動画の投入を直列にする (呼び出し側 hub.py / chat_media.py が保持する)
music_busy = asyncio.Lock()


class SwitchError(Exception):
    """切り替えに失敗した (利用者向けの理由文を持つ)。"""


def settings(cfg: dict) -> dict:
    return {**DEFAULTS, **(cfg.get("gpu_switch") or {})}


def speech_process(engine: str) -> str:
    return rf"tts-{re.escape(engine)}[\\/]server\.py"


async def _up(url: str, timeout: float = 3.0) -> bool:
    try:
        async with httpx.AsyncClient(timeout=timeout, trust_env=False) as client:
            return (await client.get(url)).status_code < 500
    except httpx.HTTPError:
        return False


def find_processes(pattern: str) -> list[psutil.Process]:
    rx = re.compile(pattern)
    found = []
    for p in psutil.process_iter(["name", "cmdline"]):
        try:   # python で動くサーバーだけ (そのパスを開いたエディタなどを止めない)
            if (p.info["name"] or "").lower().startswith("python") and rx.search(" ".join(p.info["cmdline"] or [])):
                found.append(p)
        except (psutil.Error, TypeError):
            continue
    return found


def run_start_script(script: str) -> None:
    """起動スクリプトは WMI で切り離して起動し、すぐ戻る (start-*-detached.ps1)。"""
    subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script],
                   capture_output=True, timeout=60, check=True,
                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))


async def _free_comfy(s: dict, what: str) -> list[str]:
    comfy = s["comfy_base"].rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=20, trust_env=False) as client:
            q = (await client.get(comfy + "/queue")).json()
            if q.get("queue_running") or q.get("queue_pending"):
                raise SwitchError(f"画像・動画を生成中です。終わってから{what}を生成してください")
            r = await client.post(comfy + "/free", json={"unload_models": True, "free_memory": True})
            if r.status_code != 200:
                raise SwitchError(f"ComfyUI のモデルを解放できません (HTTP {r.status_code})")
            return ["ComfyUI のモデルを解放"]
    except httpx.ConnectError:
        return []   # ComfyUI が止まっていれば解放は不要
    except (httpx.HTTPError, ValueError) as exc:
        raise SwitchError(f"ComfyUI のモデルを解放できません: {exc.__class__.__name__}") from exc


async def _kill(pattern: str, label: str) -> list[str]:
    procs = await asyncio.to_thread(find_processes, pattern)
    if not procs:
        return []
    for p in procs:
        try:
            p.kill()
        except psutil.Error:
            pass
    _, alive = await asyncio.to_thread(psutil.wait_procs, procs, 15)
    if alive:
        raise SwitchError(f"{label} を停止できませんでした (pid " + ", ".join(str(p.pid) for p in alive) + ")")
    return [f"{label} を停止"]


async def _stop_speech(s: dict, keep: str | None = None) -> list[str]:
    done = []
    for engine in s["speech"]:
        if engine != keep:
            done += await _kill(speech_process(engine), f"音声合成 {engine}")
    return done


async def stop_speech(cfg: dict) -> list[str]:
    """音声合成のサーバーをすべて止める (VRAM をまとめて空けるとき用)。"""
    return await _stop_speech(settings(cfg))


async def _ensure_up(base: str, pattern: str, script: str, label: str, timeout: float, log: str) -> list[str]:
    health = base.rstrip("/") + "/health"
    if await _up(health):
        return []
    done = []
    if not await asyncio.to_thread(find_processes, pattern):
        try:
            await asyncio.to_thread(run_start_script, script)
        except (OSError, subprocess.SubprocessError) as exc:
            raise SwitchError(f"{label} を起動できません ({script}): {exc}") from exc
        done.append(f"{label} を起動")
    deadline = time.monotonic() + float(timeout)
    while time.monotonic() < deadline:
        if await _up(health):
            return done
        await asyncio.sleep(2)
    raise SwitchError(f"{label} が {timeout} 秒以内に起動しませんでした ({log} を確認してください)")


async def for_music(cfg: dict) -> list[str]:
    """ACE-Step を使える状態にする。行ったことを返す (UI 表示用)。"""
    s = settings(cfg)
    if not s["enabled"]:
        return []
    done = await _free_comfy(s, "音楽") + await _stop_speech(s)
    return done + await _ensure_up(s["acestep_base"], s["acestep_process"], s["acestep_start"], "ACE-Step",
                                   s["start_timeout"], "C:/project/ace-step/server.log")


async def speech_up(cfg: dict, engine: str) -> bool:
    """音声合成 engine がもう起動していれば True。音楽・画像の前は音声合成を止めるので、起動中なら他に GPU を使うものは無く、
    for_speech の解放と確認 (実測 約2.5秒) を省ける。"""
    e = settings(cfg)["speech"].get(engine)
    return bool(e) and await _up(e["base"].rstrip("/") + "/health")


async def for_speech(cfg: dict, engine: str) -> list[str]:
    """音声合成 engine を使える状態にする。行ったことを返す。"""
    s = settings(cfg)
    if not s["enabled"]:
        return []
    e = s["speech"].get(engine)
    if not e:
        raise SwitchError(f"音声合成エンジンが見つかりません: {engine} (使えるもの: {', '.join(s['speech'])})")
    done = (await _free_comfy(s, "音声") + await _kill(s["acestep_process"], "ACE-Step")
            + await _stop_speech(s, keep=engine))
    log = e["start"].rsplit("/", 1)[0] + "/server.log"
    return done + await _ensure_up(e["base"], speech_process(engine), e["start"], f"音声合成 {engine}",
                                   s["start_timeout"], log)


async def for_studio(cfg: dict) -> list[str]:
    """ACE-Step と音声合成を止めて ComfyUI 側に VRAM を空ける。止めきれなければ SwitchError。"""
    s = settings(cfg)
    if not s["enabled"]:
        return []
    return await _kill(s["acestep_process"], "ACE-Step") + await _stop_speech(s)
