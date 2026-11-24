"""音声合成 (ローカルの TTS サーバー) の共通処理。チャットのツールと音声画面が同じ流れを使う。

生成の流れ: music_busy を取る → LLM を降ろす → エンジンを起動して待つ → POST /tts → モデルを降ろす。
チャットは返答の LLM に VRAM が要るので生成のたびにすぐ降ろす。音声画面は連続して作ることが多く、
読み込みのやり直し (12〜50 秒) が重いので、最後の生成から idle_unload_sec たってから降ろす。
"""
from __future__ import annotations

import asyncio
import shutil
import subprocess
import tempfile
import time
import wave
from pathlib import Path

import httpx

import gpu_switch

SPEECH_OUT = Path(__file__).resolve().parent / "speech_out"
VOICES_DIR = SPEECH_OUT / "voices"
SPEECH_WAIT = 900            # 音声合成を待つ上限秒 (初回はモデルの読み込みを含む)
IDLE_UNLOAD_SEC = 120        # 画面からの生成のあと、モデルを降ろすまでの既定秒
MAX_TEXT = 5000
VOICE_MAX_SEC = 30           # 声の見本に使う長さの上限
VOICE_MAX_BYTES = 20 * 1024 * 1024

LANGS = {"ja": "日本語", "en": "英語", "zh": "中国語", "ko": "韓国語", "de": "ドイツ語", "fr": "フランス語",
         "ru": "ロシア語", "pt": "ポルトガル語", "es": "スペイン語", "it": "イタリア語", "ar": "アラビア語"}

# エンジンごとの固定情報。一覧を出すだけでサーバーは起動しない (各 server.py の /info と同じ内容)
ENGINES = {
    "qwen3": {
        "label": "Qwen3-TTS", "description": "9人の話者から選ぶか、声の説明文・声の見本で声を決める。日本語が自然",
        "languages": ["ja", "en", "zh", "ko", "de", "fr", "ru", "pt", "es", "it"],
        "speakers": ["Vivian", "Serena", "Uncle_Fu", "Dylan", "Eric", "Ryan", "Aiden", "Ono_Anna", "Sohee"],
        "default_speaker": "Ono_Anna",
        "style_placeholder": "例: 落ち着いてゆっくり / 低めの声の落ち着いた男性",
        "style_help": "話者を選んだときは話し方の指示 (感情・速さ)。話者なしで入れると声の説明文として使う。声の見本があるときは無視される",
        "license": "Apache-2.0", "commercial": True,
    },
    "indextts": {
        "label": "IndexTTS2", "description": "声の見本から声を複製し、感情を文章で指定できる。見本なしなら付属の声",
        "languages": ["ja", "en", "zh", "es", "ar"], "speakers": [], "default_speaker": "",
        "style_placeholder": "例: とても嬉しそうに、興奮して",
        "style_help": "感情を表す文章。付属の感情モデルが感情に変換する。声は常に見本から複製する",
        "license": "Bilibili Model License", "commercial": None,
    },
    "fish": {
        "label": "Fish Audio S2-Pro", "description": "80以上の言語を自動判定。声の見本と見本の文字起こしを付けると声が安定する",
        "languages": ["ja", "en", "zh", "ko", "es", "pt", "ar", "ru", "fr", "de"], "speakers": [], "default_speaker": "",
        "style_placeholder": "例: whisper / cheerful tone",
        "style_help": "文頭に [指示] として付ける自由な指示 (英語が安定)。見本なしの声は毎回変わるので、seed を固定するか見本を使う",
        "license": "Fish Audio Research License", "commercial": False,
    },
}


class SpeechError(Exception):
    """音声合成の失敗 (利用者に見せる日本語)。"""


class SpeechInputError(SpeechError):
    """利用者が直せる入力の誤り。"""


def _hub():
    import hub   # hub が chat_agent→chat_media→speech を import するので、使うときに読む
    return hub


def category(cfg: dict) -> dict:
    return _hub()._cat(cfg, "speech")


def idle_unload_sec(cfg: dict) -> float:
    v = category(cfg).get("idle_unload_sec")
    return IDLE_UNLOAD_SEC if v is None else float(v)


# --- モデルを降ろす ---
_idle_task: asyncio.Task | None = None   # 予約は最大1つ。新しい要求で取り消す


def cancel_idle() -> None:
    global _idle_task
    task, _idle_task = _idle_task, None
    if task and not task.done():
        try:
            task.cancel()
        except RuntimeError:   # 予約したイベントループがもう閉じている
            pass


async def unload(cfg: dict, engine: str) -> None:
    """モデルを降ろして VRAM を返す。降ろせなければプロセスごと止める。music_busy を持っている間に呼ぶ。"""
    base = gpu_switch.settings(cfg)["speech"][engine]["base"].rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=30, trust_env=False) as client:
            freed = (await client.post(base + "/unload")).status_code == 200
    except httpx.HTTPError:
        freed = False
    if not freed:
        try:
            await gpu_switch.stop_speech(cfg)
        except gpu_switch.SwitchError:
            pass


async def _idle_unload(cfg: dict, engine: str, delay: float) -> None:
    await asyncio.sleep(delay)
    async with gpu_switch.music_busy:
        await unload(cfg, engine)


def schedule_idle(cfg: dict, engine: str) -> None:
    cancel_idle()
    global _idle_task
    _idle_task = asyncio.get_running_loop().create_task(_idle_unload(cfg, engine, idle_unload_sec(cfg)))


async def synthesize(cfg: dict, engine: str, text: str, *, language=None, ref_audio=None, ref_text=None,
                     style=None, speaker=None, seed=None, keep_loaded: bool = False) -> dict:
    """text を音声にして {"wav": bytes, "elapsed": 秒} を返す。

    keep_loaded=False は生成のあとすぐモデルを降ろす (チャット用)。True は idle_unload_sec 後に降ろす。
    失敗は SpeechError (入力の誤りは SpeechInputError)、GPU の切り替えの失敗は gpu_switch.SwitchError。
    """
    if engine not in ENGINES:
        raise SpeechInputError(f"engine は {' / '.join(ENGINES)} のどれか")
    if not str(text).strip() or len(str(text)) > MAX_TEXT:
        raise SpeechInputError(f"文章は1〜{MAX_TEXT}文字にしてください")
    body = {"text": str(text), **{k: str(v) for k, v in (("ref_audio", ref_audio), ("ref_text", ref_text),
                                                         ("language", language), ("style", style),
                                                         ("speaker", speaker)) if v}}
    if seed is not None:
        body["seed"] = int(seed)
    cancel_idle()   # 待っている間に降ろされないように
    started = time.monotonic()
    async with gpu_switch.music_busy:   # 生成中に音楽・画像側がこのエンジンを止めないように
        hub = _hub()
        await hub.free_vram_for_generation(cfg, category(cfg), hub._music_running())
        if not await gpu_switch.speech_up(cfg, engine):   # 起動済みなら切り替えは要らない (確認だけで毎回約2.5秒かかる)
            await gpu_switch.for_speech(cfg, engine)
        base = gpu_switch.settings(cfg)["speech"][engine]["base"].rstrip("/")
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(30, read=SPEECH_WAIT), trust_env=False) as client:
                resp = await client.post(base + "/tts", json=body)
        except httpx.HTTPError as exc:
            raise SpeechError(f"音声合成 {engine} から応答がありません ({exc.__class__.__name__})") from exc
        finally:   # 失敗しても VRAM は返す
            if keep_loaded:
                schedule_idle(cfg, engine)
            else:
                await unload(cfg, engine)
    if resp.status_code >= 400:
        try:
            detail = resp.json().get("error")
        except ValueError:
            detail = None
        err = SpeechInputError if resp.status_code == 400 else SpeechError
        raise err(f"音声合成 {engine}: {detail or f'HTTP {resp.status_code}'}")
    return {"wav": resp.content, "elapsed": round(time.monotonic() - started, 2)}


# --- 声の見本 ---
def wav_seconds(path: Path) -> float | None:
    try:
        with wave.open(str(path)) as w:
            return round(w.getnframes() / w.getframerate(), 2)
    except (wave.Error, OSError, EOFError, ZeroDivisionError):
        return None


def _ffmpeg(src: Path, dst: Path) -> None:
    exe = shutil.which("ffmpeg")
    if not exe:
        raise SpeechError("ffmpeg が見つかりません。音声の変換にはインストールが必要です")
    try:
        done = subprocess.run([exe, "-y", "-v", "error", "-i", str(src), "-vn", "-t", str(VOICE_MAX_SEC),
                               "-ac", "1", "-c:a", "pcm_s16le", str(dst)],
                              capture_output=True, timeout=60, check=False,
                              creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except (OSError, subprocess.SubprocessError) as exc:
        raise SpeechError(f"音声を変換できませんでした: {exc.__class__.__name__}") from exc
    if done.returncode != 0 or not dst.is_file() or dst.stat().st_size < 1000:
        raise SpeechInputError("音声として読み取れませんでした。別のファイルで試してください")


async def save_voice(data: bytes, dest: Path) -> float | None:
    """任意の音声 data を mono PCM16 の wav (30 秒まで) にして dest へ保存し、長さ(秒)を返す。"""
    if not data or len(data) > VOICE_MAX_BYTES:
        raise SpeechInputError("音声ファイルは 20MB 以下にしてください")
    with tempfile.TemporaryDirectory() as tmp:
        src, out = Path(tmp) / "in.bin", Path(tmp) / "out.wav"
        src.write_bytes(data)
        await asyncio.to_thread(_ffmpeg, src, out)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(out), dest)
    return wav_seconds(dest)
