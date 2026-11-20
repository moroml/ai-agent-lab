"""チャットから画像・動画を作るツール (Local Gen Studio 経由)。

結果は会話の作業フォルダ (Toolbox の root) へ保存し、相対パスを返す。画面はそのパスから
プレビューとリンクを出す。LGS が止まっているときは、例外にせず日本語のエラー文字列を返す。
"""
from __future__ import annotations

import asyncio
import os
import time

import httpx
from fastapi import HTTPException

POLL_SEC = 2.0
IMAGE_WAIT = 900     # 画像の完了を待つ上限秒
VIDEO_WAIT = 1800
IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp")
FILE_EXT = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp",
            "video/mp4": ".mp4", "video/webm": ".webm"}
VIDEO_FPS = 24

SCHEMA = [
    {"type": "function", "function": {
        "name": "generate_image",
        "description": "画像を生成して作業フォルダに保存する(Local Gen Studio。数十秒〜数分かかる)。"
                       "prompt は画像の内容を具体的に書いた英語の文",
        "parameters": {"type": "object", "properties": {
            "prompt": {"type": "string", "description": "英語のプロンプト"},
            "width": {"type": "integer", "description": "幅 px。既定1024、256〜2048 (8の倍数に丸める)"},
            "height": {"type": "integer", "description": "高さ px。既定1024"},
            "model": {"type": "string", "description": "省略可。既定は設定のモデル"}},
            "required": ["prompt"]}}},
    {"type": "function", "function": {
        "name": "edit_image",
        "description": "作業フォルダの画像(png/jpg/webp)を、指示どおりに編集した新しい画像を作る(qwen-image-edit)",
        "parameters": {"type": "object", "properties": {
            "path": {"type": "string", "description": "作業フォルダからの相対パス"},
            "instruction": {"type": "string", "description": "どう編集するか。英語で具体的に"}},
            "required": ["path", "instruction"]}}},
    {"type": "function", "function": {
        "name": "generate_video",
        "description": "動画を生成して作業フォルダに保存する(数分かかる)。image_path を渡すとその画像から始まる動画になる",
        "parameters": {"type": "object", "properties": {
            "prompt": {"type": "string", "description": "動きを含む英語のプロンプト"},
            "image_path": {"type": "string", "description": "起点の画像(作業フォルダからの相対)。省略でテキストから"},
            "seconds": {"type": "number", "description": "長さ(秒)。既定2、上限5"}},
            "required": ["prompt"]}}},
]
NAMES = tuple(t["function"]["name"] for t in SCHEMA)


class MediaError(Exception):
    """利用者に見せる失敗理由 (日本語)。"""


def _hub():
    import hub   # hub が chat_agent を import するので、循環しないよう使うときに読む
    return hub


async def _lgs(method, path, *, files=None, timeout=60.0):
    """LGS を直接呼ぶ (アップロード・ジョブ監視・ダウンロード用)。失敗は MediaError。"""
    hub = _hub()
    cfg = hub.llm.load_config()
    try:
        async with httpx.AsyncClient(timeout=timeout, trust_env=False) as client:
            resp = await client.request(method, hub.studio_base(cfg) + path, files=files,
                                        headers={"Authorization": f"Bearer {hub.studio_token(cfg)}"})
    except httpx.HTTPError as exc:
        raise MediaError("Local Gen Studio に接続できません。起動してから、もう一度頼んでください"
                         f" ({exc.__class__.__name__})") from exc
    if resp.status_code >= 400:
        try:
            detail = resp.json().get("detail")
        except ValueError:
            detail = None
        raise MediaError(f"Local Gen Studio: {detail or f'HTTP {resp.status_code}'}")
    return resp


async def _free_vram(cfg, category):
    """設定が unload_llm のとき、生成の前に Ollama のモデルを降ろす。"""
    hub = _hub()
    await hub.free_vram_for_generation(cfg, hub._cat(cfg, category), hub._music_running())


async def _wait(job_id, limit):
    """ジョブの完了を待って generation_id を返す。呼び出しが取り消されたら LGS のジョブも止める。"""
    end = time.monotonic() + limit
    try:
        while time.monotonic() < end:
            job = (await _lgs("GET", f"/api/jobs/{job_id}", timeout=10)).json()
            if job.get("status") == "done":
                if job.get("generation_id") is None:
                    raise MediaError("生成は終わりましたが保存されませんでした (シークレット設定を確認してください)")
                return job["generation_id"]
            if job.get("status") == "error":
                raise MediaError(f"生成に失敗しました: {job.get('error') or job.get('progress_text') or '原因不明'}")
            await asyncio.sleep(POLL_SEC)
    except asyncio.CancelledError:
        try:
            await _lgs("POST", f"/api/jobs/{job_id}/cancel", timeout=5)
        except MediaError:
            pass
        raise
    raise MediaError(f"生成が {limit} 秒以内に終わりませんでした。Local Gen Studio の画面で状況を確認してください")


async def _save(box, gid, kind):
    resp = await _lgs("GET", f"/api/files/{gid}", timeout=120)
    ext = FILE_EXT.get(resp.headers.get("content-type", "").split(";")[0].strip(), ".mp4" if kind == "video" else ".png")
    rel = f"{kind}_{gid}{ext}"
    path = box._safe_path(rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(resp.content)
    return rel


async def _upload(box, path):
    """作業フォルダの画像を LGS へ渡して生成番号を返す。"""
    p = box._safe_path(path)
    if not os.path.isfile(p) or os.path.splitext(p)[1].lower() not in IMAGE_EXTS:
        raise MediaError(f"画像ファイル(png/jpg/webp)が作業フォルダに見つかりません: {path}")
    with open(p, "rb") as f:
        data = f.read()
    return (await _lgs("POST", "/api/images/upload", files={"file": (os.path.basename(p), data)})).json()["id"]


def _size(value, default, mult):
    n = int(value or default)
    return max(256, min(2048, n // mult * mult))


async def _submit(path, body, limit, kind, box):
    job = await _hub()._submit_studio(path, body, 120)
    return await _save(box, await _wait(job["job_id"], limit), kind)


async def generate_image(cfg, box, prompt, width=None, height=None, model=None):
    cat = _hub()._cat(cfg, "image")
    body = {"model": model or cat.get("model") or "flux2-klein", "prompt_en": str(prompt),
            "width": _size(width, cat.get("width", 1024), 8), "height": _size(height, cat.get("height", 1024), 8)}
    await _free_vram(cfg, "image")
    rel = await _submit("/api/generate", body, IMAGE_WAIT, "image", box)
    return f"画像を作成しました: {rel}", [rel]


async def edit_image(cfg, box, path, instruction):
    source = await _upload(box, path)
    await _free_vram(cfg, "image")
    rel = await _submit("/api/generate-edit", {"source_generation_id": source, "prompt_en": str(instruction)},
                        IMAGE_WAIT, "image", box)
    return f"画像を編集しました: {rel}", [rel]


async def generate_video(cfg, box, prompt, image_path=None, seconds=None):
    cat = _hub()._cat(cfg, "video")
    frames = max(9, min(121, round(float(seconds or 2) * VIDEO_FPS / 4) * 4 + 1))   # 4n+1 フレーム
    body = {"prompt_en": str(prompt), "video_model": cat.get("model") or "wan22-ti2v-5b-turbo", "frames": frames,
            "width": _size(None, cat.get("width", 832), 16), "height": _size(None, cat.get("height", 480), 16)}
    if image_path:
        body.update(mode="i2v", source_generation_id=await _upload(box, image_path))
    await _free_vram(cfg, "video")
    rel = await _submit("/api/generate-video", body, VIDEO_WAIT, "video", box)
    return f"動画を作成しました: {rel}", [rel]


async def call(cfg, box, name, args):
    """ツールを実行し (結果の文字列, 作業フォルダ内の作成ファイルの相対パス) を返す。"""
    if not isinstance(args, dict):
        return f"[引数エラー] {name}: 引数がオブジェクトでない", []
    fn = {"generate_image": generate_image, "edit_image": edit_image, "generate_video": generate_video}[name]
    try:
        return await fn(cfg, box, **args)
    except MediaError as e:
        return f"[生成失敗] {e}", []
    except HTTPException as e:   # hub 側の検査 (音楽の生成中・GPU 切替の失敗など)
        return f"[生成失敗] {e.detail}", []
    except (TypeError, ValueError) as e:
        return f"[引数エラー] {name}: {e}", []
    except KeyError as e:
        return f"[生成失敗] Local Gen Studio の応答が想定と違います: {e}", []
