"""種類別ワークスペース (チャット / エージェント / 画像 / 動画 / 音楽) の API。

- チャット: 会話専用の軽い経路。Run を作らず、種類別の最適化値でストリーミングする
- 画像・動画: Local Gen Studio (LGS) を中継する。トークンはサーバー側だけで持つ
- 音楽: ACE-Step (music.py)。歌詞の下書きはチャットモデルで作る
エージェントは既存の /run 系をそのまま使う。
"""
from __future__ import annotations

import asyncio
import ipaddress
import json
import os
import time
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

import chat_agent
import gpu_switch
import llm
import music
import openai_api

router = APIRouter()
LGS_DEFAULT = "http://127.0.0.1:8787"
_token_cache: tuple[str, float] | None = None
_background: set = set()   # create_task の参照保持 (GC で途中終了させない)


LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}


def require_local_or_key(request: Request) -> None:
    """ダッシュボード (このPC) からは素通し、それ以外は OpenAI 互換 API のキーを要求する。

    ブラウザ経由の他サイトからの要求も接続元はループバックになるため、Origin が付いていて
    自ホストと違えば拒否する (CSRF)。キー未設定のときは外部からの接続そのものを拒否する。
    """
    origin = request.headers.get("origin")
    if origin and urlsplit(origin).netloc != request.headers.get("host", ""):
        raise HTTPException(403, "別のサイトからの要求は受け付けません")
    host = request.client.host if request.client else ""
    try:
        loopback = ipaddress.ip_address(host).is_loopback
    except ValueError:
        loopback = False
    if loopback:
        # DNS リバインディング対策: 攻撃者ドメインを 127.0.0.1 に向けると Origin と Host が
        # 一致したまま接続元がループバックになる。Host はローカルの名前だけ許す
        if urlsplit("//" + request.headers.get("host", "")).hostname not in LOCAL_HOSTS:
            raise HTTPException(403, "このPCからは 127.0.0.1 か localhost で開いてください")
        return
    if not openai_api.api_key():
        raise HTTPException(403, "このPC以外から使うには OpenAI 互換 API のキーを発行してください")
    openai_api._check_auth(request)


def category_config(cfg: dict) -> dict:
    return cfg.get("categories") or {}


def _cat(cfg: dict, name: str) -> dict:
    return category_config(cfg).get(name) or {}


# ------------------------------------------------------------------ studio
def studio_base(cfg: dict) -> str:
    return (os.environ.get("LGS_BASE") or (cfg.get("studio") or {}).get("base_url")
            or LGS_DEFAULT).rstrip("/")


def studio_token(cfg: dict) -> str:
    """LGS の API トークン。ファイルは再生成され得るので mtime で読み直す。"""
    global _token_cache
    if os.environ.get("LGS_TOKEN"):
        return os.environ["LGS_TOKEN"]
    path = Path((cfg.get("studio") or {}).get("token_file") or "")
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return ""
    if _token_cache is None or _token_cache[1] != mtime:
        _token_cache = (path.read_text(encoding="utf-8").strip(), mtime)
    return _token_cache[0]


async def _studio(method: str, path: str, *, json_body=None, timeout: float = 30.0):
    cfg = llm.load_config()
    headers = {"Authorization": f"Bearer {studio_token(cfg)}"}
    try:
        async with httpx.AsyncClient(timeout=timeout, trust_env=False) as client:
            resp = await client.request(method, studio_base(cfg) + path,
                                        json=json_body, headers=headers)
    except httpx.HTTPError as exc:
        raise HTTPException(502, "Local Gen Studio に接続できません。"
                                 f"start-studio.bat で起動してください ({exc.__class__.__name__})") from exc
    if resp.status_code >= 400:
        try:
            detail = resp.json().get("detail")
        except ValueError:
            detail = None
        if resp.status_code == 401:
            detail = ("Local Gen Studio に認証を拒否されました。トークン (studio.token_file / LGS_TOKEN) の不一致か、"
                      "8787 番を別のアプリが使っている可能性があります")
        if isinstance(detail, list):   # FastAPI の検証エラー
            detail = "; ".join(str(d.get("msg", d)) for d in detail)
        raise HTTPException(resp.status_code, detail or f"Local Gen Studio: HTTP {resp.status_code}")
    return resp.json()


def _gallery_row(r: dict) -> dict:
    meta = r.get("meta") or {}
    gid = r["id"]
    return {"id": gid, "kind": r.get("kind"), "created_at": r.get("created_at"),
            "is_favorite": bool(r.get("is_favorite")),
            "model": meta.get("model"), "seed": meta.get("seed"),
            "width": meta.get("width"), "height": meta.get("height"),
            "prompt_ja": meta.get("prompt_ja", ""), "prompt_en": meta.get("prompt_en", ""),
            "url": f"/studio/files/{gid}",
            "thumb_url": f"/studio/thumbs/{gid}" if r.get("kind") == "image" else None}


@router.get("/studio/status")
async def studio_status(request: Request) -> dict:
    require_local_or_key(request)
    try:
        st = await _studio("GET", "/api/status", timeout=8)
    except HTTPException as exc:
        return {"connected": False, "reason": exc.detail}
    return {"connected": True, "comfy": st.get("comfy"), "ollama": st.get("ollama"),
            "models": [m["id"] for m in st.get("models", [])],
            "video_models": [m["id"] for m in st.get("video_models", [])]}


@router.get("/studio/catalog")
async def studio_catalog(request: Request) -> dict:
    require_local_or_key(request)
    data = await _studio("GET", "/api/models", timeout=8)
    keep = ("id", "steps", "engine", "guidance", "cfg", "fps")
    slim = lambda rows: [{k: m[k] for k in keep if k in m} for m in rows]
    return {"models": slim(data.get("models", [])),
            "video_models": slim(data.get("video_models", [])),
            "use_cases": data.get("use_cases", [])}


@router.get("/studio/gallery")
async def studio_gallery(request: Request, kind: str = "image", limit: int = 60) -> dict:
    require_local_or_key(request)
    rows = await _studio("GET", "/api/gallery", timeout=15)
    items = [_gallery_row(r) for r in rows if r.get("kind") == kind]
    return {"items": items[:max(1, min(limit, 500))], "total": len(items)}


class EnhanceReq(BaseModel):
    text_ja: str = Field(min_length=1, max_length=20000)
    mode: str = "expand"


@router.post("/studio/enhance")
async def studio_enhance(req: EnhanceReq, request: Request) -> dict:
    require_local_or_key(request)
    mode = req.mode if req.mode in ("translate", "expand") else "expand"
    return await _studio("POST", "/api/prompt/enhance",
                         json_body={"text_ja": req.text_ja, "mode": mode}, timeout=240)


@router.post("/studio/generate")
async def studio_generate(request: Request) -> dict:
    """画像生成。本体の検証 (モデル名・サイズ・未成年語の拒否) は LGS 側に任せる。"""
    require_local_or_key(request)
    body = await request.json()
    body.pop("secret", None)   # シークレットは LGS 本体の画面で扱う (中継では保存先が曖昧になる)
    return await _submit_studio("/api/generate", body, 60)


@router.post("/studio/generate-video")
async def studio_generate_video(request: Request) -> dict:
    require_local_or_key(request)
    body = await request.json()
    body.pop("secret", None)
    body.pop("source_secret_file", None)
    return await _submit_studio("/api/generate-video", body, 120)


async def _submit_studio(path: str, body: dict, timeout: float) -> dict:
    """ACE-Step を止めてから投入する。止める〜投入の間に音楽側が ComfyUI を解放しないよう
    同じロックで直列にする (投入後は ComfyUI のキューを見て音楽側が待つ)。"""
    if gpu_switch.music_busy.locked():
        raise HTTPException(409, "音楽を生成中です。終わってから画像・動画を生成してください")
    async with gpu_switch.music_busy:
        try:
            switched = await gpu_switch.for_studio(llm.load_config())
        except gpu_switch.SwitchError as exc:
            raise HTTPException(409, str(exc)) from exc
        return {**await _studio("POST", path, json_body=body, timeout=timeout), "gpu_switch": switched}


@router.get("/studio/jobs/{job_id}")
async def studio_job(job_id: str, request: Request) -> dict:
    require_local_or_key(request)
    job = await _studio("GET", f"/api/jobs/{job_id}", timeout=10)
    keep = ("status", "progress", "progress_text", "generation_id", "error", "kind", "routing_note")
    return {k: job[k] for k in keep if k in job}


@router.post("/studio/jobs/{job_id}/cancel")
async def studio_cancel(job_id: str, request: Request) -> dict:
    require_local_or_key(request)
    return await _studio("POST", f"/api/jobs/{job_id}/cancel", timeout=15)


class FavReq(BaseModel):
    is_favorite: bool


@router.post("/studio/generations/{gid}/favorite")
async def studio_favorite(gid: int, req: FavReq, request: Request) -> dict:
    require_local_or_key(request)
    return await _studio("POST", f"/api/generations/{gid}/favorite",
                         json_body={"is_favorite": req.is_favorite})


@router.delete("/studio/generations/{gid}")
async def studio_delete(gid: int, request: Request) -> dict:
    """LGS 側はゴミ箱へ移すだけ (復元可能)。"""
    require_local_or_key(request)
    return await _studio("DELETE", f"/api/generations/{gid}")


async def _studio_stream(path: str, request: Request) -> Response:
    cfg = llm.load_config()
    headers = {"Authorization": f"Bearer {studio_token(cfg)}"}
    for h in ("range", "if-none-match"):
        if request.headers.get(h):
            headers[h] = request.headers[h]
    client = httpx.AsyncClient(timeout=httpx.Timeout(60, connect=5), trust_env=False)
    try:
        upstream = await client.send(client.build_request("GET", studio_base(cfg) + path,
                                                          headers=headers), stream=True)
    except httpx.HTTPError as exc:
        await client.aclose()
        raise HTTPException(502, "Local Gen Studio に接続できません") from exc
    if upstream.status_code >= 400:
        await upstream.aclose()
        await client.aclose()
        raise HTTPException(upstream.status_code, "ファイルを取得できません")
    passthrough = {k: v for k, v in upstream.headers.items() if k.lower() in (
        "content-type", "content-length", "content-range", "accept-ranges", "etag", "cache-control")}

    async def body():
        try:
            async for chunk in upstream.aiter_raw():
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()
    return StreamingResponse(body(), status_code=upstream.status_code, headers=passthrough)


@router.get("/studio/files/{gid}")
async def studio_file(gid: int, request: Request) -> Response:
    require_local_or_key(request)
    return await _studio_stream(f"/api/files/{gid}", request)


@router.get("/studio/thumbs/{gid}")
async def studio_thumb(gid: int, request: Request) -> Response:
    require_local_or_key(request)
    return await _studio_stream(f"/api/thumbs/{gid}", request)


# ------------------------------------------------------------------ chat
def trim_history(messages: list[dict], budget_chars: int) -> list[dict]:
    """新しい発言から budget_chars に収まる分だけ残す (最新の1件は必ず残す)。"""
    kept, used = [], 0
    for m in reversed(messages):
        size = len(m.get("content") or "")
        if kept and used + size > budget_chars:
            break
        kept.append(m)
        used += size
    return list(reversed(kept))


async def pick_chat_model(cfg: dict, requested: str | None, cat: dict) -> str:
    """明示指定ならそのモデルだけ。auto なら種類の既定 → fallback → default の順で使えるもの。"""
    installed = set(await llm.list_models())
    if requested and requested != "auto":
        ok, status = await llm.model_usable(cfg, requested, installed)
        if ok:
            return requested
        raise HTTPException(400, llm.unusable_reason(llm.resolve(cfg, requested), status))
    order = [cat.get("model")] + list(cat.get("fallback") or []) + [cfg.get("default")]
    for key in dict.fromkeys(k for k in order if k):
        if key in (cfg.get("models") or {}):
            ok, _ = await llm.model_usable(cfg, key, installed)
            if ok:
                return key
    raise HTTPException(503, "チャットに使えるモデルがありません (Ollama の起動とモデル導入を確認してください)")


class ChatMsg(BaseModel):
    role: str
    content: str = Field(max_length=200000)


class ChatReq(BaseModel):
    messages: list[ChatMsg] = Field(min_length=1, max_length=400)
    model: str | None = None
    think: bool | None = None
    temperature: float | None = Field(default=None, ge=0.0, le=2.0)
    system: str | None = Field(default=None, max_length=20000)
    tools: bool | None = None    # ツールを使って作業する (ファイル作成・Web 調査)。None は種類の既定
    conv: str = Field(default="default", pattern=r"^[A-Za-z0-9-]{1,64}$")   # 作業フォルダ projects/chat_<conv>/


@router.post("/hub/chat")
async def hub_chat(req: ChatReq, request: Request) -> StreamingResponse:
    require_local_or_key(request)
    cfg = llm.load_config()
    cat = _cat(cfg, "chat")
    key = await pick_chat_model(cfg, req.model, cat)
    msgs = [m.model_dump() for m in req.messages if m.role in ("user", "assistant")]
    if not msgs or msgs[-1]["role"] != "user":
        raise HTTPException(400, "最後の発言は user にしてください")
    msgs = trim_history(msgs, int(cat.get("history_chars", 24000)))
    system = req.system if req.system is not None else cat.get("system")
    if system:
        msgs.insert(0, {"role": "system", "content": system})
    think = req.think if req.think is not None else cat.get("think")
    info = llm.resolve(cfg, key)
    tool_cfg = cat.get("tools") or {}
    use_tools = bool(info["tools"] and (req.tools if req.tools is not None else tool_cfg.get("enabled", True)))

    async def events():
        started = time.monotonic()
        yield _sse({"model": key, "tag": info["tag"], "for": info.get("for", ""), "tools": use_tools})
        if use_tools:
            stream = chat_agent.run(cfg, key, msgs, subdir=f"chat_{req.conv}", think=think,
                                    temperature=req.temperature, opts=tool_cfg)
        else:
            stream = llm.chat_stream(cfg, key, msgs, temperature=req.temperature,
                                     num_ctx=cat.get("num_ctx"), think=think,
                                     num_predict=cat.get("num_predict"))
        try:
            async for ev in stream:
                if ev.get("done"):
                    meta = ev.get("meta") or {}
                    meta["elapsed_sec"] = round(time.monotonic() - started, 2)
                    yield _sse({"done": True, "meta": meta})
                else:
                    yield _sse(ev)
        except llm.OllamaError as exc:
            yield _sse({"error": str(exc)})
    return StreamingResponse(events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


class PrewarmReq(BaseModel):
    model: str | None = None


@router.post("/hub/prewarm")
async def hub_prewarm(req: PrewarmReq, request: Request) -> dict:
    """チャット画面を開いた時点でモデルを先読みし、初回応答のロード待ち (実測約25秒) を隠す。
    エージェント実行中は載っているモデルを追い出さないよう何もしない。"""
    require_local_or_key(request)
    from runs import manager
    if manager.running_count():
        return {"model": None, "skipped": "agent_running"}
    cfg = llm.load_config()
    key = await pick_chat_model(cfg, req.model, _cat(cfg, "chat"))
    task = asyncio.create_task(llm.prewarm(cfg, key))
    _background.add(task)
    task.add_done_callback(_background.discard)
    return {"model": key}


def _sse(obj: dict) -> str:
    return "data: " + json.dumps(obj, ensure_ascii=False) + "\n\n"


# ------------------------------------------------------------------ music
LYRICS_SCHEMA = {"type": "object", "required": ["style", "lyrics"], "properties": {
    "style": {"type": "string"}, "lyrics": {"type": "string"}}}


class LyricsReq(BaseModel):
    theme: str = Field(min_length=1, max_length=4000)
    language: str = "ja"
    duration: float | None = None


@router.post("/hub/lyrics")
async def hub_lyrics(req: LyricsReq, request: Request) -> dict:
    """テーマから ACE-Step 向けの曲調タグ (英語) と構成タグ付き歌詞を下書きする。"""
    require_local_or_key(request)
    cfg = llm.load_config()
    cat = _cat(cfg, "music")
    key = await pick_chat_model(cfg, cat.get("lyrics_model"), _cat(cfg, "chat"))
    lines = "短め (8〜12行)" if (req.duration or 30) <= 45 else "標準 (16〜24行)"
    system = ("あなたは作詞家です。JSON だけを返します。style は ACE-Step に渡す英語の曲調タグを"
              "カンマ区切りで (例: j-pop, upbeat, female vocal, piano, 120 bpm)。lyrics は "
              "[verse] [chorus] [bridge] などの構成タグを行頭に置いた歌詞。"
              f"歌詞の言語は {req.language}、長さは{lines}。")
    try:
        msg = await llm.chat(cfg, key, [{"role": "system", "content": system},
                                        {"role": "user", "content": req.theme}],
                             json_schema=LYRICS_SCHEMA, think=False, num_predict=1500,
                             timeout=180, retries=1)
        data = json.loads(msg.get("content") or "{}")
    except (llm.OllamaError, json.JSONDecodeError) as exc:
        raise HTTPException(502, f"歌詞の下書きに失敗しました: {exc}") from exc
    return {"style": str(data.get("style", "")).strip(),
            "lyrics": str(data.get("lyrics", "")).strip(), "model": key}


async def free_vram_for_generation(cfg: dict, cat: dict, running_runs: int) -> list[str]:
    """生成前に Ollama のモデルを降ろす。エージェント実行中は奪わない (再ロードの往復になる)。"""
    if not cat.get("unload_llm") or running_runs:
        return []
    tags = await llm.loaded_model_tags()
    if not tags:
        return []
    async with httpx.AsyncClient(timeout=20, trust_env=False) as client:
        for tag in tags:
            try:
                await client.post(f"{llm.OLLAMA_BASE}/api/generate",
                                  json={"model": tag, "keep_alive": 0})
            except httpx.HTTPError:
                pass
    return tags


class MusicReq(BaseModel):
    model: str | None = None
    prompt: str = Field(min_length=1, max_length=4000)
    lyrics: str | None = Field(default=None, max_length=20000)
    duration: float | None = None
    seed: int | None = None
    instrumental: bool = False
    vocal_language: str | None = None
    title: str | None = Field(default=None, max_length=200)


def _music_running() -> int:
    from runs import manager
    return manager.running_count()


@router.get("/music/models")
async def music_models(request: Request) -> dict:
    require_local_or_key(request)
    return await music.music_catalog(llm.load_config())


@router.post("/music/generate")
async def music_generate(req: MusicReq, request: Request) -> dict:
    require_local_or_key(request)
    cfg = llm.load_config()
    cat = _cat(cfg, "music")
    key = req.model or cat.get("model") or "music"
    duration = req.duration if req.duration is not None else cat.get("duration")
    if (cfg.get("models") or {}).get(key, {}).get("kind") != "music":
        raise HTTPException(400, f"音楽生成モデルが見つかりません: {key}")
    async with gpu_switch.music_busy:   # 生成中に画像側が ACE-Step を止めないように
        unloaded = await free_vram_for_generation(cfg, cat, _music_running())
        try:
            switched = await gpu_switch.for_music(cfg)
            result = await music.generate_music(
                cfg, key, req.prompt, lyrics=req.lyrics, duration=duration, seed=req.seed,
                instrumental=req.instrumental, vocal_language=req.vocal_language)
        except music.MusicInputError as exc:
            raise HTTPException(400, str(exc)) from exc
        except gpu_switch.SwitchError as exc:
            raise HTTPException(409, str(exc)) from exc
        except music.MusicError as exc:
            raise HTTPException(502, str(exc)) from exc
    meta = {"title": (req.title or "").strip() or req.prompt[:40], "prompt": req.prompt,
            "lyrics": "" if req.instrumental else (req.lyrics or ""),
            "instrumental": req.instrumental, "created_at": time.time(),
            **{k: result.get(k) for k in ("duration", "elapsed_sec", "model", "seed")}}
    try:
        Path(result["path"]).with_suffix(".json").write_text(
            json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    except OSError:
        pass   # メタ情報は一覧表示用。保存に失敗しても音声は返す
    return {**meta, "file": result["file"], "url": "/music/file/" + result["file"],
            "unloaded": unloaded, "gpu_switch": switched}


def list_music(root: Path, limit: int = 100) -> list[dict]:
    if not root.is_dir():
        return []
    files = sorted(root.glob("*.mp3"), key=lambda p: p.stat().st_mtime, reverse=True)
    items = []
    for p in files[:limit]:
        meta = {}
        side = p.with_suffix(".json")
        if side.is_file():
            try:
                meta = json.loads(side.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                meta = {}
        items.append({"title": meta.get("title") or p.stem[:8], **meta, "file": p.name,
                      "url": "/music/file/" + p.name,
                      "created_at": meta.get("created_at") or p.stat().st_mtime})
    return items


def _music_path(name: str) -> Path:
    root = music.MUSIC_OUT.resolve()
    path = (root / name).resolve()
    if not name or "/" in name or "\\" in name or path.parent != root or path.suffix != ".mp3":
        raise HTTPException(400, "音声ファイル名が不正です")
    if not path.is_file():
        raise HTTPException(404, "音声ファイルが見つかりません")
    return path


@router.get("/music/list")
async def music_list(request: Request) -> dict:
    require_local_or_key(request)
    return {"items": list_music(music.MUSIC_OUT)}


@router.get("/music/file/{name}")
async def music_file(name: str, request: Request):
    require_local_or_key(request)
    return FileResponse(_music_path(name), media_type="audio/mpeg", filename=name)


@router.delete("/music/file/{name}")
async def music_delete(name: str, request: Request) -> dict:
    require_local_or_key(request)
    path = _music_path(name)
    path.unlink()
    path.with_suffix(".json").unlink(missing_ok=True)
    return {"deleted": name}


# ------------------------------------------------------------------ categories
@router.get("/hub/categories")
async def hub_categories(request: Request) -> dict:
    """UI の種類切替に使う定義と、チャットで選べるモデル一覧。"""
    require_local_or_key(request)
    cfg = llm.load_config()
    cats = category_config(cfg)
    want = set((cats.get("chat") or {}).get("candidates") or [])
    chat_models = []
    for key, m in (cfg.get("models") or {}).items():
        if m.get("kind") == "music" or m.get("tier") == "archive" or m.get("hidden"):
            continue
        if want and not want & set(m.get("strengths") or []):
            continue
        chat_models.append({"key": key, "tag": m.get("tag"), "label": m.get("label", ""),
                            "for": m.get("for", ""), "backend": m.get("backend", "ollama")})
    public = {name: {k: v for k, v in c.items() if k != "system"} for name, c in cats.items()}
    return {"categories": public, "chat_models": chat_models}


def register(app) -> None:
    app.include_router(router)
