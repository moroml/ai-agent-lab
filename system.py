"""エンジン(常駐サービスとモデル)を画面から自分で操作する API (このPCからだけ)。

サービスは4つで、それぞれ個別に起動・停止・再起動できる:
  ollama  … チャット・エージェントの LLM
  comfy   … 画像・動画の生成 (ComfyUI)
  studio  … 画像・動画の受付アプリ (Local Gen Studio。comfy と両方そろって生成できる)
  acestep … 音楽の生成 (ACE-Step)
モデルは Ollama のものを1つずつ読み込む・降ろす。勝手に読み込む「自動読み込み」は既定で切ってあり、
画面のスイッチで入れたときだけ働く (降ろしたのに戻ってくる、を起こさない)。
ほかに models.yaml のモデルの導入 (ollama pull) と Claude API キーの設定を持つ。
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
import time
from pathlib import Path

import httpx
import psutil
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

import engines
import gpu_switch
import hub
import llm

router = APIRouter(dependencies=[Depends(engines.require_local_or_login)])
ENV_PATH = Path(__file__).with_name(".env")
OLLAMA_EXE = Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Ollama" / "ollama.exe"
# 画面から起動する Ollama に補う最適化 env (ユーザー設定があればそちらを優先)
OLLAMA_ENV_DEFAULTS = {
    "OLLAMA_FLASH_ATTENTION": "1",       # q8_0 KV の前提 + プロンプト処理の高速化
    "OLLAMA_KV_CACHE_TYPE": "q8_0",      # KV キャッシュのメモリ半減
    "OLLAMA_NUM_PARALLEL": "2",          # swarm の同一モデル2並列
    "OLLAMA_MAX_LOADED_MODELS": "1",     # VRAM 16GB では常駐1本
}
STUDIO_ROOT = Path("C:/project/local-gen-studio")
# DETACHED_PROCESS と併せると CREATE_NO_WINDOW が無視され、bat から起動した python が
# 別ウィンドウ (Windows Terminal) で開いてしまう。見えないコンソールを持たせて子に引き継がせる
_DETACHED = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) | getattr(subprocess, "CREATE_NO_WINDOW", 0)
SERVICES = {
    "ollama": {"label": "Ollama", "purpose": "チャット・エージェントの言語モデル", "grace": 30},
    "comfy": {"label": "ComfyUI", "purpose": "画像・動画の生成エンジン", "grace": 240},
    "studio": {"label": "Local Gen Studio", "purpose": "画像・動画の受付アプリ (ComfyUI と両方必要)", "grace": 60},
    "acestep": {"label": "ACE-Step", "purpose": "音楽の生成", "grace": 240},
}
_starting: dict[str, float] = {}   # service → 起動待ちの期限 (この間は「起動中」と出す)
_loading: dict[str, dict] = {}     # tag → {status: loading|error, error}
_pulls: dict[str, dict] = {}       # tag → {status, completed, total, error}
_background: set = set()


def _bg(coro) -> None:
    task = asyncio.create_task(coro)
    _background.add(task)
    task.add_done_callback(_background.discard)


def _agent_running() -> bool:
    from runs import manager
    return bool(manager.running_count())


async def _up(url: str) -> bool:
    try:
        async with httpx.AsyncClient(timeout=2.5, trust_env=False) as client:
            return (await client.get(url)).status_code < 500
    except httpx.HTTPError:
        return False


def _spawn(args: list[str], env: dict | None = None, cwd: Path | None = None, log: Path | None = None) -> None:
    """サーバーの再起動に巻き込まれないよう切り離して起動する。"""
    out = open(log, "ab") if log else subprocess.DEVNULL
    try:
        subprocess.Popen(args, creationflags=_DETACHED, close_fds=True, env=env, cwd=cwd,
                         stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT if log else subprocess.DEVNULL)
    finally:
        if log:
            out.close()


def _kill_tree(procs: list[psutil.Process]) -> int:
    n = 0
    for p in procs:
        try:
            kids = p.children(recursive=True)
        except psutil.Error:
            kids = []
        for c in [*kids, p]:
            try:
                c.kill()
                n += 1
            except psutil.Error:
                pass
    return n


def _port_of(base: str) -> int:
    return httpx.URL(base).port or 80


_listen_cache: tuple[float, dict[int, int]] = (0.0, {})


def _port_owner(port: int) -> psutil.Process | None:
    """その番号で待ち受けているプロセス。一覧の取得は重いので1秒だけ使い回す。
    同じ番号を 127.0.0.1 と 0.0.0.0 で別々のプロセスが待てるため、接続が届く 127.0.0.1 側を優先する。"""
    global _listen_cache
    if time.monotonic() - _listen_cache[0] > 1.0:
        owners: dict[int, int] = {}
        try:
            for c in psutil.net_connections("tcp"):
                if c.status == psutil.CONN_LISTEN and c.laddr and c.pid:
                    if c.laddr.ip == "127.0.0.1" or c.laddr.port not in owners:
                        owners[c.laddr.port] = c.pid
        except (psutil.Error, OSError):
            pass
        _listen_cache = (time.monotonic(), owners)
    pid = _listen_cache[1].get(port)
    try:
        return psutil.Process(pid) if pid else None
    except psutil.Error:
        return None


def _cmdline(p: psutil.Process) -> str:
    """コマンドラインと作業フォルダ (venv の python は素の python.exe として動き、パスが残らないため)。"""
    parts = []
    for get in (lambda: " ".join(p.cmdline()), p.cwd):
        try:
            parts.append(get())
        except (psutil.Error, OSError):
            pass
    return " ".join(parts).lower().replace("\\", "/")


def _studio_parts(cfg: dict) -> tuple[Path, Path]:
    root = Path((cfg.get("studio") or {}).get("root") or STUDIO_ROOT)
    return root / "comfyui" / "run-comfy.bat", root / "app" / "run-app.bat"


def _comfy_base(cfg: dict) -> str:
    return gpu_switch.settings(cfg)["comfy_base"].rstrip("/")


def _studio_conflict(cfg: dict) -> str:
    """LGS の番号を別のアプリが使っていればその説明を返す (401 を「起動済み」と誤判定しないため)。"""
    p = _port_owner(_port_of(hub.studio_base(cfg)))
    if p is None or "local-gen-studio" in _cmdline(p):
        return ""
    try:
        return f"{p.name()} (PID {p.pid})"
    except psutil.Error:
        return ""


async def _studio_up(cfg: dict) -> bool:
    """LGS 本体が応答し、トークンが通るときだけ True。"""
    try:
        async with httpx.AsyncClient(timeout=2.5, trust_env=False) as client:
            r = await client.get(hub.studio_base(cfg) + "/api/status",
                                 headers={"Authorization": f"Bearer {hub.studio_token(cfg)}"})
            return r.status_code == 200
    except httpx.HTTPError:
        return False


def _free_port(start: int) -> int:
    for port in range(start + 1, start + 40):
        if _port_owner(port) is None:
            return port
    raise HTTPException(409, "Local Gen Studio に使える空き番号が見つかりません")


def _studio_env(app_bat: Path) -> dict:
    env = dict(os.environ)
    text = app_bat.read_text(encoding="utf-8", errors="replace")
    for m in re.finditer(r"(?im)^\s*set\s+([A-Z0-9_]+)=(.*)$", text):
        env[m.group(1)] = m.group(2).strip()
    return env


def _studio_procs() -> list[psutil.Process]:
    """LGS のアプリ (uvicorn main:app を local-gen-studio/app で動かしているもの)。番号に関係なく探す。"""
    out = []
    for p in psutil.process_iter(["name"]):
        if "python" in (p.info["name"] or "").lower():
            cmd = _cmdline(p)
            if "uvicorn" in cmd and "main:app" in cmd and "local-gen-studio/app" in cmd:
                out.append(p)
    return out


def _ollama_procs() -> list[psutil.Process]:
    return [p for p in psutil.process_iter(["name"])
            if (p.info["name"] or "").lower() in ("ollama.exe", "ollama app.exe", "ollama")]


# ------------------------------------------------------------------ サービスの稼働判定
async def _service_up(cfg: dict) -> dict[str, bool]:
    s = gpu_switch.settings(cfg)
    ace_base = s["acestep_base"].rstrip("/")
    # 誰も待ち受けていない番号への接続は Windows では失敗まで約2秒かかる。先に待ち受けを見て即答する
    listening = await asyncio.to_thread(
        lambda: {b: _port_owner(_port_of(b)) is not None for b in (_comfy_base(cfg), hub.studio_base(cfg), ace_base)})

    async def no() -> bool:
        return False
    ollama, comfy, studio, ace = await asyncio.gather(
        llm.is_alive(),
        _up(_comfy_base(cfg) + "/system_stats") if listening[_comfy_base(cfg)] else no(),
        # 別アプリが待ち受けている番号へは LGS のトークンを送らない
        _studio_up(cfg) if listening[hub.studio_base(cfg)] and not await asyncio.to_thread(_studio_conflict, cfg) else no(),
        _up(ace_base + "/health") if listening[ace_base] else no())
    return {"ollama": ollama, "comfy": comfy, "studio": studio, "acestep": ace}


def _pid(sid: str, cfg: dict) -> int | None:
    if sid == "ollama":
        procs = [p for p in _ollama_procs() if "serve" in _cmdline(p)] or _ollama_procs()
        return procs[0].pid if procs else None
    if sid == "acestep":
        procs = gpu_switch.acestep_processes(gpu_switch.settings(cfg)["acestep_process"])
        return procs[0].pid if procs else None
    base = _comfy_base(cfg) if sid == "comfy" else hub.studio_base(cfg)
    p = _port_owner(_port_of(base))
    return p.pid if p else None


def _port(sid: str, cfg: dict) -> int | None:
    s = gpu_switch.settings(cfg)
    base = {"ollama": llm.OLLAMA_BASE, "comfy": _comfy_base(cfg), "studio": hub.studio_base(cfg),
            "acestep": s["acestep_base"]}[sid]
    return _port_of(base)


async def _models(up: bool) -> list[dict]:
    """models.yaml の Ollama モデルと、いま VRAM に載っているもの。"""
    cfg = llm.load_config()
    loaded = {m.get("name"): m for m in (await llm._ollama_loaded_models() or [])} if up else {}
    installed = set(await llm.list_models()) if up else set()
    rows, seen = [], set()
    for key, m in (cfg.get("models") or {}).items():
        m = m or {}
        tag = m.get("tag")
        if not tag or (m.get("backend") or "ollama") != "ollama" or tag in seen:
            continue
        seen.add(tag)
        rows.append({"tag": tag, "key": key, "label": m.get("label") or m.get("name") or key,
                     "for": m.get("for", ""), "installed": tag in installed})
    for tag in loaded:
        if tag not in seen:
            rows.append({"tag": tag, "key": "", "label": tag, "for": "models.yaml に未登録", "installed": True})
    for r in rows:
        lm = loaded.get(r["tag"])
        r["loaded"] = bool(lm)
        r["size_vram"] = (lm or {}).get("size_vram", 0)
        r["expires_at"] = (lm or {}).get("expires_at")
        r["state"] = ("loaded" if lm else _loading.get(r["tag"], {}).get("status", "idle"))
        r["error"] = _loading.get(r["tag"], {}).get("error", "")
    rows.sort(key=lambda r: (not r["loaded"], not r["installed"], r["label"]))
    return rows


@router.get("/system/status")
async def status() -> dict:
    cfg = llm.load_config()
    up = await _service_up(cfg)
    now = time.monotonic()
    comfy_bat, app_bat = _studio_parts(cfg)
    startable = {"ollama": True, "comfy": comfy_bat.is_file(), "studio": app_bat.is_file(),
                 "acestep": Path(gpu_switch.settings(cfg)["acestep_start"]).is_file()}
    conflict = "" if up["studio"] else await asyncio.to_thread(_studio_conflict, cfg)
    services = []
    for sid, meta in SERVICES.items():
        if up[sid]:
            _starting.pop(sid, None)
            state = "up"
        elif _starting.get(sid, 0) > now:
            state = "starting"
        else:
            state = "down"
        pid = await asyncio.to_thread(_pid, sid, cfg) if state != "down" else None
        services.append({"id": sid, **{k: meta[k] for k in ("label", "purpose")}, "state": state, "up": up[sid],
                         "port": _port(sid, cfg), "pid": pid, "startable": startable[sid],
                         "why": "" if startable[sid] else "起動用のファイルが見つかりません",
                         "conflict": conflict if sid == "studio" else ""})
    loaded = [m for m in await _models(up["ollama"]) if m["loaded"]]
    return {
        "services": services,
        # 旧形式 (他の画面が参照): 各サービスの up
        "ollama": {"up": up["ollama"], "models": [{"name": m["tag"], "size_vram": m["size_vram"]} for m in loaded]},
        "comfy": {"up": up["comfy"]},
        "studio": {"up": up["studio"], "startable": startable["studio"], "conflict": conflict},
        "acestep": {"up": up["acestep"]},
        "autoload": not llm.keepwarm_paused,
        "anthropic_key": llm.anthropic_ready(),
        "agent_running": _agent_running(),
        "pulls": _pulls,
    }


@router.get("/system/models")
async def models() -> dict:
    up = await llm.is_alive()
    return {"ollama_up": up, "models": await _models(up)}


# ------------------------------------------------------------------ サービスの起動・停止
async def _start(sid: str) -> str:
    cfg = llm.load_config()
    up = (await _service_up(cfg))[sid]
    label = SERVICES[sid]["label"]
    if up:
        return f"{label} は起動済みです"
    if _starting.get(sid, 0) > time.monotonic():   # 応答待ちの間に重ねて押しても2つ目を立ち上げない
        return f"{label} は起動中です"
    comfy_bat, app_bat = _studio_parts(cfg)
    if sid == "ollama":
        env = {**OLLAMA_ENV_DEFAULTS, **os.environ}
        exe = str(OLLAMA_EXE) if OLLAMA_EXE.is_file() else "ollama"
        try:
            await asyncio.to_thread(_spawn, [exe, "serve"], env)
        except OSError as e:
            raise HTTPException(404, f"Ollama を起動できません (未導入?): {e}") from e
        msg = "Ollama を起動しています"
    elif sid == "comfy":
        if not comfy_bat.is_file():
            raise HTTPException(404, f"ComfyUI の起動ファイルが見つかりません: {comfy_bat}")
        await asyncio.to_thread(_spawn, ["cmd", "/c", str(comfy_bat)])
        msg = "ComfyUI を起動しています (準備に1〜3分かかります)"
    elif sid == "studio":
        if not app_bat.is_file():
            raise HTTPException(404, f"Local Gen Studio の起動ファイルが見つかりません: {app_bat}")
        base = hub.studio_base(cfg)
        port = _port_of(base)
        m = re.search(r"--port\s+(\d+)", app_bat.read_text(encoding="utf-8", errors="replace"))
        bat_port = int(m.group(1)) if m else port
        busy_by = await asyncio.to_thread(_studio_conflict, cfg)
        if busy_by:
            # 接続先の番号を別のアプリが使っている → 空き番号で起動し、以後はそちらへつなぐ (.env に残す)
            port = await asyncio.to_thread(_free_port, port)
            os.environ["LGS_BASE"] = f"http://127.0.0.1:{port}"
            await asyncio.to_thread(_write_env, "LGS_BASE", os.environ["LGS_BASE"])
            msg = f"{_port_of(base)} 番を {busy_by} が使っているため、{port} 番で Local Gen Studio を起動しています"
        else:
            msg = "Local Gen Studio を起動しています"
        if port == bat_port:
            await asyncio.to_thread(_spawn, ["cmd", "/c", str(app_bat)])
        else:
            # run-app.bat の番号は固定なので、違う番号では同じ環境で直接起動する (LGS 側のファイルは書き換えない)
            app_dir = app_bat.parent
            await asyncio.to_thread(
                _spawn, [str(app_dir / ".venv" / "Scripts" / "python.exe"), "-u", "-m", "uvicorn", "main:app",
                         "--host", "127.0.0.1", "--port", str(port)],
                _studio_env(app_bat), app_dir, app_dir.parent / "_downloads" / f"app-{port}.log")
    else:
        s = gpu_switch.settings(cfg)
        try:
            await asyncio.to_thread(gpu_switch.start_acestep, s["acestep_start"])
        except (OSError, subprocess.SubprocessError) as e:
            raise HTTPException(502, f"ACE-Step を起動できません: {e}") from e
        msg = "ACE-Step を起動しています (準備に1〜3分かかります)"
    _starting[sid] = time.monotonic() + SERVICES[sid]["grace"]
    return msg


async def _stop(sid: str) -> str:
    cfg = llm.load_config()
    label = SERVICES[sid]["label"]
    _starting.pop(sid, None)
    if sid == "ollama":
        if _agent_running():
            raise HTTPException(409, "エージェントの実行中は Ollama を止められません。先にタスクを止めてください")
        llm.keepwarm_paused = True
        procs = await asyncio.to_thread(_ollama_procs)
    elif sid == "acestep":
        if gpu_switch.music_busy.locked():
            raise HTTPException(409, "音楽を生成中です。終わってから止めてください")
        procs = await asyncio.to_thread(gpu_switch.acestep_processes, gpu_switch.settings(cfg)["acestep_process"])
    elif sid == "studio":
        procs = await asyncio.to_thread(_studio_procs)
    else:
        base = _comfy_base(cfg)
        p = await asyncio.to_thread(_port_owner, _port_of(base))
        if p is not None and "comfyui" not in _cmdline(p):
            raise HTTPException(409, f"{_port_of(base)} 番は {label} ではないプロセス (PID {p.pid}) が使っています。止めません")
        if p is not None:
            try:
                async with httpx.AsyncClient(timeout=5, trust_env=False) as client:
                    q = (await client.get(base + "/queue")).json()
                if q.get("queue_running") or q.get("queue_pending"):
                    raise HTTPException(409, "画像・動画を生成中です。終わってから止めてください")
            except (httpx.HTTPError, ValueError):
                pass
        procs = [p] if p else []
    n = await asyncio.to_thread(_kill_tree, procs)
    return f"{label} を停止しました" if n else f"{label} は動いていません"


def _sid(sid: str) -> str:
    if sid not in SERVICES:
        raise HTTPException(404, f"不明なサービスです: {sid}")
    return sid


@router.post("/system/services/{sid}/start")
async def service_start(sid: str) -> dict:
    return {"done": [await _start(_sid(sid))]}


@router.post("/system/services/{sid}/stop")
async def service_stop(sid: str) -> dict:
    return {"done": [await _stop(_sid(sid))]}


@router.post("/system/services/{sid}/restart")
async def service_restart(sid: str) -> dict:
    stopped = await _stop(_sid(sid))
    for _ in range(20):   # 番号が空くのを待つ
        if sid == "ollama" and not await asyncio.to_thread(_ollama_procs):
            break
        if sid != "ollama" and not (await _service_up(llm.load_config()))[sid]:
            break
        await asyncio.sleep(0.5)
    return {"done": [stopped, await _start(sid)]}


async def _run_each(sids: list[str], fn) -> dict:
    done, failed = [], []
    for sid in sids:
        try:
            done.append(await fn(sid))
        except HTTPException as e:
            failed.append(f"{SERVICES[sid]['label']}: {e.detail}")
    return {"done": done, "failed": failed}


class Which(BaseModel):
    services: list[str] = Field(default_factory=list, max_length=10)   # 空なら全部


@router.post("/system/engines/start")
async def start_all(req: Which | None = None) -> dict:
    """まとめて起動。モデルの読み込みは自動読み込みが入っているときだけ行う。"""
    sids = [_sid(s) for s in (req.services if req and req.services else SERVICES)]
    res = await _run_each(sids, _start)
    if not llm.keepwarm_paused and "ollama" in sids:
        _bg(_prewarm_when_up())
        res["done"].append("Ollama の準備ができたら既定モデルを読み込みます (自動読み込み)")
    return res


async def _prewarm_when_up() -> None:
    for _ in range(30):
        if llm.keepwarm_paused:   # 待っている間に自動読み込みを切られたら読み込まない
            return
        if await llm.is_alive():
            await llm.prewarm_default()
            return
        await asyncio.sleep(1)


@router.post("/system/engines/stop")
async def stop_all(req: Which | None = None) -> dict:
    sids = [_sid(s) for s in (req.services if req and req.services else SERVICES)]
    return await _run_each(sids, _stop)


# ------------------------------------------------------------------ モデル
class ModelReq(BaseModel):
    tag: str = Field(default="", max_length=200)   # 空なら全部 (unload のみ)


async def _unload(tags: list[str] | None) -> list[str]:
    loaded = [m.get("name") for m in await llm._ollama_loaded_models() or []]
    done = []
    async with httpx.AsyncClient(timeout=30, trust_env=False) as client:
        for name in loaded:
            if tags is None or name in tags:
                r = await client.post(f"{llm.OLLAMA_BASE}/api/generate", json={"model": name, "keep_alive": 0})
                if r.status_code != 200:
                    raise HTTPException(502, f"{name} を降ろせません (HTTP {r.status_code})")
                done.append(f"{name} を VRAM から降ろしました")
    return done


@router.post("/system/models/unload")
async def model_unload(req: ModelReq) -> dict:
    if _agent_running():
        raise HTTPException(409, "エージェントの実行中はモデルを降ろせません。先にタスクを止めてください")
    llm.keepwarm_paused = True   # 降ろした直後に裏で読み込み直さない
    for tag, st in _loading.items():   # 読み込み途中のものは、終わったらすぐ降ろす
        if st.get("status") == "loading" and (not req.tag or tag == req.tag):
            st["cancel"] = True
    done = await _unload([req.tag] if req.tag else None)
    return {"done": done or ["載っているモデルはありません"]}


async def _load(tag: str) -> None:
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(600, connect=10), trust_env=False) as client:
            r = await client.post(f"{llm.OLLAMA_BASE}/api/generate", json={"model": tag, "keep_alive": "30m"})
        if r.status_code != 200:
            raise RuntimeError(f"HTTP {r.status_code}: {r.text[:200]}")
        if _loading.pop(tag, {}).get("cancel"):   # 読み込み中に「降ろす」が押されていた
            await _unload([tag])
    except Exception as e:   # 失敗は画面に出す
        _loading[tag] = {"status": "error", "error": str(e)[:300]}


@router.post("/system/models/load")
async def model_load(req: ModelReq) -> dict:
    if not req.tag:
        raise HTTPException(400, "読み込むモデルを指定してください")
    if not await llm.is_alive():
        raise HTTPException(503, "Ollama が起動していません。先に Ollama を起動してください")
    if req.tag not in await llm.list_models():
        raise HTTPException(404, f"{req.tag} は導入されていません")
    if _loading.get(req.tag, {}).get("status") == "loading":
        return {"done": [f"{req.tag} を読み込んでいます"]}
    _loading[req.tag] = {"status": "loading", "error": ""}
    _bg(_load(req.tag))
    return {"done": [f"{req.tag} を読み込んでいます (大きいモデルは数十秒かかります)"]}


class AutoloadReq(BaseModel):
    enabled: bool


@router.post("/system/autoload")
async def set_autoload(req: AutoloadReq) -> dict:
    """自動読み込み: チャット画面を開いたときの先読みと、高速モデルの温め直し。既定は切。"""
    llm.keepwarm_paused = not req.enabled
    return {"autoload": req.enabled}


# ------------------------------------------------------------------ VRAM をまとめて空ける
class FreeReq(BaseModel):
    # "ollama" (全部) / "ollama:<モデル名>" / "comfy" / "acestep"。空なら全部
    targets: list[str] = Field(default_factory=list, max_length=20)


@router.post("/system/vram/free")
async def free_vram(req: FreeReq) -> dict:
    cfg = llm.load_config()
    targets = req.targets or ["ollama", "comfy", "acestep"]
    picked = [t.split(":", 1)[1] for t in targets if t.startswith("ollama:")]
    if (picked or "ollama" in targets) and _agent_running():
        raise HTTPException(409, "エージェントの実行中はモデルを降ろせません。先にタスクを止めてください")
    done = []
    if "ollama" in targets or picked:
        llm.keepwarm_paused = True
        done += await _unload(None if "ollama" in targets else picked)
    if "comfy" in targets:
        base = _comfy_base(cfg)
        try:
            async with httpx.AsyncClient(timeout=20, trust_env=False) as client:
                q = (await client.get(base + "/queue")).json()
                if q.get("queue_running") or q.get("queue_pending"):
                    raise HTTPException(409, "画像・動画を生成中です。終わってから空けてください")
                r = await client.post(base + "/free", json={"unload_models": True, "free_memory": True})
                if r.status_code != 200:
                    raise HTTPException(502, f"ComfyUI のモデルを解放できません (HTTP {r.status_code})")
                done.append("ComfyUI のモデルを解放しました")
        except (httpx.HTTPError, ValueError):
            pass   # 止まっていれば空ける必要はない
    if "acestep" in targets:
        msg = await _stop("acestep")
        if "停止しました" in msg:
            done.append(msg)
    return {"done": done or ["空けるものはありませんでした"]}


# ------------------------------------------------------------------ モデルの導入
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


@router.post("/system/ollama/pull", dependencies=[Depends(engines.require_local)])
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
    _bg(_pull(req.tag))
    return {"started": True}


# ------------------------------------------------------------------ Claude API キー
class KeyReq(BaseModel):
    key: str = Field(default="", max_length=400)


def _write_env(name: str, value: str) -> None:
    lines = ENV_PATH.read_text(encoding="utf-8").splitlines() if ENV_PATH.exists() else []
    lines = [ln for ln in lines if not re.match(rf"\s*{name}\s*=", ln)]
    if value:
        lines.append(f"{name}={value}")
    ENV_PATH.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")


@router.post("/system/anthropic-key", dependencies=[Depends(engines.require_local)])
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
