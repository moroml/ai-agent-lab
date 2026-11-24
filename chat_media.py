"""チャットから画像・動画・音楽・音声・3D を作るツール (画像・動画は Local Gen Studio、音楽は ACE-Step、
音声はローカルの音声合成 (C:/project/tts-<engine>)、3D は LGS の ComfyUI 上の TRELLIS 2 と、承認制の Blender スクリプト)。

結果は会話の作業フォルダ (Toolbox の root) へ保存し、相対パスを返す。画面はそのパスから
プレビューとリンクを出す。LGS が止まっているときは、例外にせず日本語のエラー文字列を返す。
"""
from __future__ import annotations

import asyncio
import json
import os
import random
import re
import shutil
import time
import uuid

import httpx
from fastapi import HTTPException

POLL_SEC = 2.0
IMAGE_WAIT = 900     # 画像の完了を待つ上限秒
VIDEO_WAIT = 1800
IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp")
FILE_EXT = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp",
            "video/mp4": ".mp4", "video/webm": ".webm"}
VIDEO_FPS = 24
BLENDER = os.environ.get("BLENDER_EXE") or "C:/Program Files/Blender Foundation/Blender 5.2/blender.exe"
BLENDER_WAIT = 180   # Blender を待つ上限秒
TAIL_BYTES = 20000   # Blender の出力で残す末尾 (エラー文の探索用)
SCRIPT_MAX = 50000
NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
SPEECH_WAIT = 900    # 音声合成を待つ上限秒 (初回はモデルの読み込みを含む)
SPEECH_ENGINES = ("qwen3", "indextts", "fish")
AUDIO_EXTS = (".wav", ".mp3", ".flac", ".ogg", ".m4a")
TRELLIS_WAIT = 3600 # TRELLIS 2 (形→高解像度→色の3段) を待つ上限秒
TRELLIS_WORKFLOW = os.path.join(os.path.dirname(os.path.abspath(__file__)), "workflows", "trellis2_image_to_3d.json")
TRELLIS_SEEDS = ("3", "12", "18", "23")   # ワークフローの KSampler
TRELLIS_IMAGE_NODE, TRELLIS_SAVE_NODE = "122", "322"   # LoadImage と SaveGLB
OBJECT_HINT = (", a single object, whole object in view, centered, three-quarter view, "
               "plain white background, soft even lighting, no text")
# 子プロセスへ渡す環境変数は許可リスト方式 (名前が秘密らしくない鍵も漏らさないため)。python / node / git / blender が動く最小限
ENV_ALLOW = {"PATH", "PATHEXT", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR",
             "USERPROFILE", "USERNAME", "USERDOMAIN", "COMPUTERNAME", "HOME", "HOMEDRIVE", "HOMEPATH",
             "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "ALLUSERSPROFILE", "PUBLIC", "OS", "NUMBER_OF_PROCESSORS",
             "LANG", "TZ", "TERM", "PYTHONIOENCODING", "PYTHONUTF8"}
ENV_ALLOW_PREFIX = ("PROGRAMFILES", "COMMONPROGRAMFILES", "PROCESSOR_", "LC_")

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
    {"type": "function", "function": {
        "name": "generate_music",
        "description": "音楽(mp3)を生成して作業フォルダに保存する(ACE-Step。数分かかる)",
        "parameters": {"type": "object", "properties": {
            "prompt": {"type": "string", "description": "曲調・ジャンル・雰囲気の説明"},
            "lyrics": {"type": "string", "description": "歌詞。省略可"},
            "duration": {"type": "number", "description": "長さ(秒)。10〜600。省略で設定の既定"},
            "instrumental": {"type": "boolean", "description": "true で歌なし"}},
            "required": ["prompt"]}}},
    {"type": "function", "function": {
        "name": "generate_speech",
        "description": "文章を読み上げた音声(wav)を作業フォルダに保存する(ローカルの音声合成。初回はモデルの読み込みで1〜数分)。"
                       "engine: qwen3=速く安定・多言語・プリセット話者や声の説明から声を作れる(既定) / "
                       "indextts=声のまねと感情の指示に強い / fish=表現が最も豊かで演技の指示が効く(重い・非商用ライセンス)。"
                       "voice に作業フォルダの音声を渡すと、その声で読む",
        "parameters": {"type": "object", "properties": {
            "text": {"type": "string", "description": "読み上げる文章 (5000字まで)"},
            "engine": {"type": "string", "enum": list(SPEECH_ENGINES), "description": "省略で設定の既定"},
            "language": {"type": "string", "description": "ja / en / zh など。省略で自動"},
            "voice": {"type": "string", "description": "まねる声の音声 (作業フォルダからの相対。wav/mp3/flac、3〜20秒)"},
            "voice_text": {"type": "string", "description": "voice の音声で話している内容 (分かれば。似せる精度が上がる)"},
            "style": {"type": "string", "description": "話し方の指示。qwen3: 声の特徴や口調の説明 (日本語可)。indextts: 感情 "
                                                       "(例 とても嬉しそうに)。fish: 英語の短い演技指示 (例 whisper / cheerful, excited)"},
            "speaker": {"type": "string", "description": "qwen3 のプリセット話者。Ono_Anna (日本語・女性・既定) / Vivian / Serena / "
                                                         "Uncle_Fu / Dylan / Eric / Ryan / Aiden / Sohee。省略可"}},
            "required": ["text"]}}},
    {"type": "function", "function": {
        "name": "generate_3d",
        "description": "3Dモデル(glb)を AI (TRELLIS 2) で作り、確認用の png と一緒に作業フォルダに保存する(10〜30分かかる)。"
                       "image_path の画像の物体を立体にする。画像が無ければ prompt から先に画像を作ってから立体にする",
        "parameters": {"type": "object", "properties": {
            "prompt": {"type": "string", "description": "作りたい物の英語の説明 (image_path が無いとき)"},
            "image_path": {"type": "string", "description": "元にする画像(作業フォルダからの相対)。背景は自動で除く"}}}}},
]
NAMES = tuple(t["function"]["name"] for t in SCHEMA)

# make_3d はモデルが書いた Python をそのまま実行する (コマンド実行と同じ重さ) ので、NAMES には入れず、
# commands=True のときだけ載せて実行前の承認を求める (chat_agent)
SCHEMA_3D = {"type": "function", "function": {
    "name": "make_3d",
    "description": "Blender (bpy 5.x) の Python スクリプトで3Dモデルを作り、name.glb と、見た目の確認用の name.png を"
                   "作業フォルダに保存する(実行前にユーザーの承認が要る)。script は空のシーンにメッシュとマテリアルを作る部分だけ"
                   "を書く(カメラ・ライト・書き出し・レンダーは自動)。失敗するとエラー全文が返るので、直して再実行できる。"
                   "Blender 4 以降の名前に注意: Principled BSDF の入力は 'Transmission Weight' 'Emission Color' "
                   "'Subsurface Weight' 'Specular IOR Level'('Transmission' 'Emission' 'Specular' は無い)。"
                   "色分けは複雑なノードより、部品ごとに Base Color だけのマテリアルを割り当てる方が確実",
    "parameters": {"type": "object", "properties": {
        "name": {"type": "string", "description": "ファイル名の元(英数字・_・-、40字まで)"},
        "script": {"type": "string", "description": "bpy のスクリプト。import bpy から書く"}},
        "required": ["name", "script"]}}}

# 空のシーンから始め、書き出しと確認用のレンダーを後ろに足す (書き出しを先にして、レンダーが落ちても glb は残す)
RUNNER_HEAD = "import bpy\nbpy.ops.wm.read_factory_settings(use_empty=True)\n"
_ARGS = """
import sys
import mathutils
_glb, _png = sys.argv[sys.argv.index("--") + 1:][:2]
_scene = bpy.context.scene
"""
_MESHES = """
_meshes = [o for o in _scene.objects if o.type == "MESH"]
if not _meshes:
    raise RuntimeError("メッシュがありません。スクリプトで形を作ること")
"""
_RENDER = """
_pts = [o.matrix_world @ mathutils.Vector(c) for o in _meshes for c in o.bound_box]
_lo = mathutils.Vector([min(p[i] for p in _pts) for i in range(3)])
_hi = mathutils.Vector([max(p[i] for p in _pts) for i in range(3)])
_mid, _r = (_lo + _hi) / 2, max((_hi - _lo).length / 2, 0.1)
_cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
_scene.collection.objects.link(_cam)
_cam.location = _mid + mathutils.Vector((1.6, -2.2, 1.2)).normalized() * _r * 3.2
_cam.rotation_euler = (_mid - _cam.location).to_track_quat("-Z", "Y").to_euler()
_scene.camera = _cam
_sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
_sun.rotation_euler = (0.9, 0.2, 0.6)
_scene.collection.objects.link(_sun)
_scene.render.engine = "BLENDER_EEVEE"
_scene.render.resolution_x = _scene.render.resolution_y = 768
_scene.render.filepath = _png
bpy.ops.render.render(write_still=True)
"""
RUNNER_TAIL = _ARGS + _MESHES + 'bpy.ops.export_scene.gltf(filepath=_glb, export_format="GLB")\n' + _RENDER
# generate_3d の確認用レンダー (固定のスクリプト。モデルの書いたコードは走らせない)。頂点色は glTF の読み込みが材質にする
PREVIEW_SCRIPT = RUNNER_HEAD + _ARGS + """
bpy.ops.import_scene.gltf(filepath=_glb)
_scene.world = bpy.data.worlds.new("bg")
_scene.world.color = (0.5, 0.5, 0.5)
""" + _MESHES + _RENDER


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


async def _cancel(job_id):
    """LGS のジョブを止める (できなくてもよい)。"""
    try:
        await _lgs("POST", f"/api/jobs/{job_id}/cancel", timeout=5)
    except MediaError:
        pass


async def _wait(job_id, limit):
    """ジョブの完了を待って generation_id を返す。時間切れや呼び出しの取り消しでは LGS のジョブも止める。"""
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
        await _cancel(job_id)
        raise
    await _cancel(job_id)
    raise MediaError(f"生成が {limit} 秒以内に終わりませんでした。止めました。もう一度頼むか、Local Gen Studio の画面で状況を確認してください")


async def _download(who, url, tmp, headers=None, params=None):
    """url を tmp へストリームで保存して Content-Type を返す (全量をメモリに載せず、書き込みはスレッドで)。"""
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(30, read=120), trust_env=False) as client:
            async with client.stream("GET", url, headers=headers, params=params) as resp:
                if resp.status_code >= 400:
                    raise MediaError(f"{who}: 生成物を取得できません (HTTP {resp.status_code})")
                with open(tmp, "wb") as f:
                    async for chunk in resp.aiter_bytes(1 << 16):
                        await asyncio.to_thread(f.write, chunk)
                return resp.headers.get("content-type", "")
    except httpx.HTTPError as exc:
        raise MediaError(f"{who} から生成物を受け取れません ({exc.__class__.__name__})") from exc


async def _fetch_file(gid, tmp):
    """LGS の生成物を tmp へ保存して Content-Type を返す。"""
    hub = _hub()
    cfg = hub.llm.load_config()
    return await _download("Local Gen Studio", hub.studio_base(cfg) + f"/api/files/{gid}", tmp,
                           headers={"Authorization": f"Bearer {hub.studio_token(cfg)}"})


def _unlink(path):
    try:
        os.unlink(path)
    except OSError:
        pass


async def _save(box, gid, kind):
    tmp = box._safe_path(f".{kind}_{gid}.part")
    await asyncio.to_thread(os.makedirs, os.path.dirname(tmp), exist_ok=True)
    try:
        ctype = await _fetch_file(gid, tmp)
        ext = FILE_EXT.get(ctype.split(";")[0].strip(), ".mp4" if kind == "video" else ".png")
        rel = f"{kind}_{gid}{ext}"
        await asyncio.to_thread(os.replace, tmp, box._safe_path(rel))
    finally:
        await asyncio.to_thread(_unlink, tmp)
    return rel


def _read_bytes(path):
    with open(path, "rb") as f:
        return f.read()


async def _upload(box, path):
    """作業フォルダの画像を LGS へ渡して生成番号を返す。"""
    p = box._safe_path(path)
    if not os.path.isfile(p) or os.path.splitext(p)[1].lower() not in IMAGE_EXTS:
        raise MediaError(f"画像ファイル(png/jpg/webp)が作業フォルダに見つかりません: {path}")
    data = await asyncio.to_thread(_read_bytes, p)
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


async def generate_music(cfg, box, prompt, lyrics=None, duration=None, instrumental=False):
    hub = _hub()
    cat = hub._cat(cfg, "music")
    async with hub.gpu_switch.music_busy:   # 生成中に画像側が ACE-Step を止めないように (/music/generate と同じ)
        await _free_vram(cfg, "music")
        try:
            await hub.gpu_switch.for_music(cfg)
            result = await hub.music.generate_music(
                cfg, cat.get("model") or "music", str(prompt), lyrics=lyrics or None,
                duration=float(duration) if duration else cat.get("duration"), instrumental=bool(instrumental))
        except (hub.music.MusicError, hub.gpu_switch.SwitchError) as e:
            raise MediaError(str(e)) from e
    rel = f"music_{os.path.splitext(result['file'])[0][:8]}.mp3"
    path = box._safe_path(rel)
    await asyncio.to_thread(os.makedirs, os.path.dirname(path), exist_ok=True)
    await asyncio.to_thread(shutil.move, result["path"], path)   # 音楽画面の一覧には出さず、この会話の作業フォルダに置く
    return f"音楽を作成しました: {rel}", [rel]


def _write_bytes(path, data):
    with open(path, "wb") as f:
        f.write(data)


async def generate_speech(cfg, box, text, engine=None, language=None, voice=None, voice_text=None,
                          style=None, speaker=None):
    hub = _hub()
    engine = engine or hub._cat(cfg, "speech").get("engine") or SPEECH_ENGINES[0]
    if engine not in SPEECH_ENGINES:
        raise ValueError(f"engine は {' / '.join(SPEECH_ENGINES)} のどれか")
    body = {"text": str(text)}
    if voice:
        path = box._safe_path(str(voice))
        if not path.lower().endswith(AUDIO_EXTS) or not await asyncio.to_thread(os.path.isfile, path):
            raise MediaError(f"声の見本の音声が作業フォルダにありません (wav/mp3/flac): {voice}")
        body["ref_audio"] = path
    body.update({k: str(v) for k, v in (("ref_text", voice_text), ("language", language),
                                         ("style", style), ("speaker", speaker)) if v})
    sw = hub.gpu_switch
    async with sw.music_busy:   # 生成中に音楽・画像側がこのエンジンを止めないように
        await _free_vram(cfg, "speech")
        try:
            await sw.for_speech(cfg, engine)
        except sw.SwitchError as exc:
            raise MediaError(str(exc)) from exc
        base = sw.settings(cfg)["speech"][engine]["base"].rstrip("/")
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(30, read=SPEECH_WAIT), trust_env=False) as client:
                try:
                    resp = await client.post(base + "/tts", json=body)
                finally:
                    if hub._cat(cfg, "speech").get("unload_after", True):   # 続く返答の LLM に VRAM を返す
                        try:
                            await client.post(base + "/unload", timeout=30)
                        except httpx.HTTPError:
                            pass
        except httpx.HTTPError as exc:
            raise MediaError(f"音声合成 {engine} から応答がありません ({exc.__class__.__name__})") from exc
    if resp.status_code >= 400:
        try:
            detail = resp.json().get("error")
        except ValueError:
            detail = None
        raise MediaError(f"音声合成 {engine}: {detail or f'HTTP {resp.status_code}'}")
    rel = f"speech_{uuid.uuid4().hex[:8]}.wav"
    path = box._safe_path(rel)
    await asyncio.to_thread(os.makedirs, os.path.dirname(path), exist_ok=True)
    await asyncio.to_thread(_write_bytes, path, resp.content)
    return f"音声を作成しました: {rel} ({engine})", [rel]


def _comfy_base(cfg):
    return _hub().gpu_switch.settings(cfg)["comfy_base"].rstrip("/")


async def _comfy(cfg, method, path, *, timeout=30.0, **kw):
    """LGS の ComfyUI を直接呼ぶ (TRELLIS 2 は LGS の API に無いため)。失敗は MediaError。"""
    try:
        async with httpx.AsyncClient(timeout=timeout, trust_env=False) as client:
            resp = await client.request(method, _comfy_base(cfg) + path, **kw)
    except httpx.HTTPError as exc:
        raise MediaError("ComfyUI に接続できません。Local Gen Studio を起動してから、もう一度頼んでください"
                         f" ({exc.__class__.__name__})") from exc
    if resp.status_code >= 400:
        raise MediaError(f"ComfyUI: HTTP {resp.status_code} {resp.text[:500]}")
    return resp


async def _cancel_comfy(cfg, pid):
    """このジョブだけを止める (実行中なら中断、待ち行列なら外す。他のジョブには触れない)。"""
    try:
        await _comfy(cfg, "POST", f"/api/jobs/{pid}/cancel", timeout=5)
    except MediaError:
        pass


async def _queue_comfy(cfg, workflow):
    """ACE-Step を止めてから ComfyUI に投入する (LGS への投入と同じロックで直列にする)。"""
    sw = _hub().gpu_switch
    if sw.music_busy.locked():
        raise MediaError("音楽か音声を生成中です。終わってから3Dを作ってください")
    async with sw.music_busy:
        try:
            await sw.for_studio(cfg)
        except sw.SwitchError as exc:
            raise MediaError(str(exc)) from exc
        resp = await _comfy(cfg, "POST", "/prompt", json={"prompt": workflow, "client_id": "ai-agent-lab"})
    return resp.json()["prompt_id"]


def _comfy_error(status):
    for kind, data in status.get("messages") or []:
        if kind == "execution_error":
            return f"{data.get('node_type')}: {data.get('exception_message', '').strip()[:500]}"
        if kind == "execution_interrupted":
            return "中断されました"
    return status.get("status_str") or "原因不明"


async def _wait_comfy(cfg, pid, limit):
    """ジョブの完了を待って outputs を返す。時間切れ・呼び出しの取り消し・監視の通信の失敗ではジョブも止める。"""
    end = time.monotonic() + limit
    try:
        while time.monotonic() < end:
            hist = (await _comfy(cfg, "GET", f"/history/{pid}", timeout=10)).json()
            if pid in hist:
                break
            await asyncio.sleep(POLL_SEC)
        else:
            hist = None
    except (asyncio.CancelledError, MediaError):   # 監視できなくなったら、結果を受け取れないので止める
        await _cancel_comfy(cfg, pid)
        raise
    if hist is None:
        await _cancel_comfy(cfg, pid)
        raise MediaError(f"3Dの生成が {limit} 秒以内に終わりませんでした。止めました")
    status = hist[pid].get("status") or {}
    if status.get("status_str") != "success":
        raise MediaError(f"3Dの生成に失敗しました: {_comfy_error(status)}")
    return hist[pid].get("outputs") or {}


def _load_workflow():
    with open(TRELLIS_WORKFLOW, encoding="utf-8") as f:
        return json.load(f)


def _write_text(path, text):
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


async def _preview_3d(box, glb, png):
    """glb を Blender でレンダーして png を作る。Blender が無い・失敗したときは False (glb は使える)。"""
    if not os.path.isfile(BLENDER):
        return False
    py = box._safe_path(f".preview_{os.path.basename(png)}.py")
    await asyncio.to_thread(_write_text, py, PREVIEW_SCRIPT)
    try:
        code, _ = await _blender(box, py, glb, png)
    except MediaError:
        return False
    finally:
        await asyncio.to_thread(_unlink, py)
    return code == 0 and os.path.isfile(png)


async def generate_3d(cfg, box, prompt=None, image_path=None):
    if image_path:
        return await _image_to_3d(cfg, box, image_path)
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError("prompt か image_path のどちらかが要る")
    _, made = await generate_image(cfg, box, prompt.strip() + OBJECT_HINT)
    try:
        text, files = await _image_to_3d(cfg, box, made[0])
    except MediaError as e:   # 先に作った画像は残っているので、失敗しても画面に出す
        return f"[生成失敗] {e} (元にした画像 {made[0]} は作業フォルダにあります)", made
    return text, made + files


async def _image_to_3d(cfg, box, image_path):
    src = box._safe_path(image_path)
    ext = os.path.splitext(src)[1].lower()
    if not os.path.isfile(src) or ext not in IMAGE_EXTS:
        raise MediaError(f"画像ファイル(png/jpg/webp)が作業フォルダに見つかりません: {image_path}")
    data = await asyncio.to_thread(_read_bytes, src)
    workflow = await asyncio.to_thread(_load_workflow)
    tag = uuid.uuid4().hex[:8]
    up = (await _comfy(cfg, "POST", "/upload/image", files={"image": (f"agentlab_{tag}{ext}", data)},
                       data={"overwrite": "true"})).json()
    workflow[TRELLIS_IMAGE_NODE]["inputs"]["image"] = f"{up['subfolder']}/{up['name']}" if up.get("subfolder") else up["name"]
    seed = random.randrange(1 << 31)
    for node in TRELLIS_SEEDS:
        workflow[node]["inputs"]["seed"] = seed
    workflow[TRELLIS_SAVE_NODE]["inputs"]["filename_prefix"] = f"agentlab/model3d_{tag}"
    await _free_vram(cfg, "image")
    outputs = await _wait_comfy(cfg, await _queue_comfy(cfg, workflow), TRELLIS_WAIT)
    out = next((f for o in outputs.values() for v in o.values() if isinstance(v, list)
                for f in v if isinstance(f, dict) and str(f.get("filename", "")).endswith(".glb")), None)
    if out is None:
        raise MediaError("3Dの生成は終わりましたが glb が出力されませんでした")
    rel = f"model3d_{tag}.glb"
    glb, tmp = box._safe_path(rel), box._safe_path(f".{rel}.part")
    try:
        await _download("ComfyUI", _comfy_base(cfg) + "/view", tmp,
                        params={"filename": out["filename"], "subfolder": out.get("subfolder", ""), "type": "output"})
        await asyncio.to_thread(os.replace, tmp, glb)
    finally:
        await asyncio.to_thread(_unlink, tmp)
    png = f"model3d_{tag}.png"
    if await _preview_3d(box, glb, box._safe_path(png)):
        return f"3Dモデルを作成しました: {rel} (確認用の画像 {png})", [png, rel]
    return f"3Dモデルを作成しました: {rel} (確認用の画像は作れませんでした)", [rel]


def safe_env():
    """子プロセスへ渡す環境変数。ENV_ALLOW にある名前だけ (API キー・トークン類は渡さない)。"""
    return {k: v for k, v in os.environ.items()
            if k.upper() in ENV_ALLOW or k.upper().startswith(ENV_ALLOW_PREFIX)}


# Blender 4 で改名された Principled BSDF の入力。説明に書いてもモデルは古い名前を使い続けた (2026-11-20 実機)
OLD_BSDF = {"Transmission": "Transmission Weight", "Emission": "Emission Color", "Specular": "Specular IOR Level",
            "Subsurface": "Subsurface Weight", "Clearcoat": "Coat Weight", "Clearcoat Roughness": "Coat Roughness",
            "Sheen": "Sheen Weight"}
OLD_BSDF_RE = re.compile(r"""inputs\[(['"])(%s)\1\]""" % "|".join(sorted(map(re.escape, OLD_BSDF), key=len, reverse=True)))


def check_3d(args):
    """make_3d の引数の検査。問題があれば理由を返す (承認を求める前に弾く)。
    古い入力名はここで直す (承認画面には直した後の、実際に実行するスクリプトが出る)。"""
    name, script = args.get("name"), args.get("script")
    if not isinstance(name, str) or not NAME_RE.match(name):
        return "[引数エラー] make_3d: name は英数字・_・- の40字以内"
    if not isinstance(script, str) or not script.strip() or len(script) > SCRIPT_MAX:
        return f"[引数エラー] make_3d: script が空か、{SCRIPT_MAX}字を超えている"
    args["script"] = OLD_BSDF_RE.sub(lambda m: f"inputs[{m[1]}{OLD_BSDF[m[2]]}{m[1]}]", script)
    return None


async def _read_tail(stream, keep=TAIL_BYTES):
    """出力を読み切り、末尾 keep バイトだけを返す (Blender は大量に出すので全量を溜めない)。"""
    tail = bytearray()
    while chunk := await stream.read(1 << 16):
        tail += chunk
        if len(tail) > keep * 2:
            del tail[:-keep]
    return bytes(tail[-keep:])


def _prepare_3d(py, source, olds):
    """スクリプトを書き、前の試行の出力を消す (残りを成功と取り違えないため)。"""
    os.makedirs(os.path.dirname(py), exist_ok=True)
    with open(py, "w", encoding="utf-8") as f:
        f.write(source)
    for old in olds:
        _unlink(old)


async def _blender(box, py, glb, png):
    """Blender で py を走らせ (glb, png を引数に渡す)、終了コードと出力の末尾を返す。時間切れは MediaError。"""
    proc = await asyncio.create_subprocess_exec(
        BLENDER, "-b", "--factory-startup", "--python-exit-code", "1", "--python", py, "--", glb, png,
        cwd=box.root, env=safe_env(), stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    async def drain():   # 出力が閉じた後に終わらない場合も、上限に含める
        tail = await _read_tail(proc.stdout)
        await proc.wait()
        return tail
    try:
        out = await asyncio.wait_for(drain(), BLENDER_WAIT)
    except asyncio.TimeoutError:
        raise MediaError(f"Blender が {BLENDER_WAIT} 秒以内に終わりませんでした。形を単純にして再実行してください") from None
    finally:
        if proc.returncode is None:
            proc.kill()
            await proc.wait()
    return proc.returncode, out.decode("utf-8", errors="replace")


async def make_3d(cfg, box, name, script):
    if not os.path.isfile(BLENDER):
        raise MediaError(f"Blender が見つかりません: {BLENDER} (環境変数 BLENDER_EXE で場所を指定できます)")
    py = box._safe_path(f"{name}.py")
    glb, png = box._safe_path(f"{name}.glb"), box._safe_path(f"{name}.png")
    await asyncio.to_thread(_prepare_3d, py, RUNNER_HEAD + script + "\n" + RUNNER_TAIL, (glb, png))
    code, text = await _blender(box, py, glb, png)
    if code != 0 or not (os.path.isfile(glb) and os.path.isfile(png)):
        tail = text[text.rfind("Traceback"):] if "Traceback" in text else text
        raise MediaError(f"Blender のスクリプトが失敗しました (exit={code}):\n{tail[-2500:]}")
    return f"3Dモデルを作成しました: {name}.glb (確認用の画像 {name}.png)。スクリプトは {name}.py", [f"{name}.png", f"{name}.glb"]


async def call(cfg, box, name, args):
    """ツールを実行し (結果の文字列, 作業フォルダ内の作成ファイルの相対パス) を返す。"""
    if not isinstance(args, dict):
        return f"[引数エラー] {name}: 引数がオブジェクトでない", []
    fn = {"generate_image": generate_image, "edit_image": edit_image, "generate_video": generate_video,
          "generate_music": generate_music, "generate_speech": generate_speech, "generate_3d": generate_3d,
          "make_3d": make_3d}[name]
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
