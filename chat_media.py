"""チャットから画像・動画・音楽・3D を作るツール (画像・動画は Local Gen Studio、音楽は ACE-Step、3D は Blender)。

結果は会話の作業フォルダ (Toolbox の root) へ保存し、相対パスを返す。画面はそのパスから
プレビューとリンクを出す。LGS が止まっているときは、例外にせず日本語のエラー文字列を返す。
"""
from __future__ import annotations

import asyncio
import os
import re
import shutil
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
BLENDER = os.environ.get("BLENDER_EXE") or "C:/Program Files/Blender Foundation/Blender 5.2/blender.exe"
BLENDER_WAIT = 180   # Blender を待つ上限秒
SCRIPT_MAX = 50000
NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
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
]
NAMES = tuple(t["function"]["name"] for t in SCHEMA)

# make_3d はモデルが書いた Python をそのまま実行する (コマンド実行と同じ重さ) ので、NAMES には入れず、
# commands=True のときだけ載せて実行前の承認を求める (chat_agent)
SCHEMA_3D = {"type": "function", "function": {
    "name": "make_3d",
    "description": "Blender (bpy 5.x) の Python スクリプトで3Dモデルを作り、name.glb と、見た目の確認用の name.png を"
                   "作業フォルダに保存する(実行前にユーザーの承認が要る)。script は空のシーンにメッシュとマテリアルを作る部分だけ"
                   "を書く(カメラ・ライト・書き出し・レンダーは自動)。失敗するとエラー全文が返るので、直して再実行できる",
    "parameters": {"type": "object", "properties": {
        "name": {"type": "string", "description": "ファイル名の元(英数字・_・-、40字まで)"},
        "script": {"type": "string", "description": "bpy のスクリプト。import bpy から書く"}},
        "required": ["name", "script"]}}}

# 空のシーンから始め、書き出しと確認用のレンダーを後ろに足す (書き出しを先にして、レンダーが落ちても glb は残す)
RUNNER_HEAD = "import bpy\nbpy.ops.wm.read_factory_settings(use_empty=True)\n"
RUNNER_TAIL = """
import sys
import mathutils
_glb, _png = sys.argv[sys.argv.index("--") + 1:][:2]
_scene = bpy.context.scene
_meshes = [o for o in _scene.objects if o.type == "MESH"]
if not _meshes:
    raise RuntimeError("メッシュがありません。スクリプトで形を作ること")
bpy.ops.export_scene.gltf(filepath=_glb, export_format="GLB")
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
    os.makedirs(os.path.dirname(path), exist_ok=True)
    shutil.move(result["path"], path)   # 音楽画面の一覧には出さず、この会話の作業フォルダに置く
    return f"音楽を作成しました: {rel}", [rel]


def safe_env():
    """子プロセスへ渡す環境変数。ENV_ALLOW にある名前だけ (API キー・トークン類は渡さない)。"""
    return {k: v for k, v in os.environ.items()
            if k.upper() in ENV_ALLOW or k.upper().startswith(ENV_ALLOW_PREFIX)}


def check_3d(args):
    """make_3d の引数の検査。問題があれば理由を返す (承認を求める前に弾く)。"""
    name, script = args.get("name"), args.get("script")
    if not isinstance(name, str) or not NAME_RE.match(name):
        return "[引数エラー] make_3d: name は英数字・_・- の40字以内"
    if not isinstance(script, str) or not script.strip() or len(script) > SCRIPT_MAX:
        return f"[引数エラー] make_3d: script が空か、{SCRIPT_MAX}字を超えている"
    return None


async def make_3d(cfg, box, name, script):
    if not os.path.isfile(BLENDER):
        raise MediaError(f"Blender が見つかりません: {BLENDER} (環境変数 BLENDER_EXE で場所を指定できます)")
    py = box._safe_path(f"{name}.py")
    os.makedirs(os.path.dirname(py), exist_ok=True)
    with open(py, "w", encoding="utf-8") as f:
        f.write(RUNNER_HEAD + script + "\n" + RUNNER_TAIL)
    glb, png = box._safe_path(f"{name}.glb"), box._safe_path(f"{name}.png")
    for old in (glb, png):   # 前の試行の残りを成功と取り違えない
        if os.path.exists(old):
            os.unlink(old)
    proc = await asyncio.create_subprocess_exec(
        BLENDER, "-b", "--factory-startup", "--python-exit-code", "1", "--python", py, "--", glb, png,
        cwd=box.root, env=safe_env(), stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), BLENDER_WAIT)
    except asyncio.TimeoutError:
        raise MediaError(f"Blender が {BLENDER_WAIT} 秒以内に終わりませんでした。形を単純にして再実行してください") from None
    finally:
        if proc.returncode is None:
            proc.kill()
            await proc.wait()
    text = out.decode("utf-8", errors="replace")
    if proc.returncode != 0 or not (os.path.isfile(glb) and os.path.isfile(png)):
        tail = text[text.rfind("Traceback"):] if "Traceback" in text else text
        raise MediaError(f"Blender のスクリプトが失敗しました (exit={proc.returncode}):\n{tail[-2500:]}")
    return f"3Dモデルを作成しました: {name}.glb (確認用の画像 {name}.png)。スクリプトは {name}.py", [f"{name}.png", f"{name}.glb"]


async def call(cfg, box, name, args):
    """ツールを実行し (結果の文字列, 作業フォルダ内の作成ファイルの相対パス) を返す。"""
    if not isinstance(args, dict):
        return f"[引数エラー] {name}: 引数がオブジェクトでない", []
    fn = {"generate_image": generate_image, "edit_image": edit_image, "generate_video": generate_video,
          "generate_music": generate_music, "make_3d": make_3d}[name]
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
