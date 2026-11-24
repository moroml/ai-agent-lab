import asyncio
import json
import shutil
import sys
import wave
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import gpu_switch
import hub
import server
import speech

ORIGINAL = httpx.AsyncClient


def make_wav(path_or_none=None, seconds=0.2, channels=1, rate=8000):
    import io
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"\x01\x00" * channels * int(rate * seconds))
    if path_or_none:
        Path(path_or_none).write_bytes(buf.getvalue())
    return buf.getvalue()


@pytest.fixture
def env(monkeypatch, tmp_path):
    """TTS の HTTP と GPU 切り替えを差し替える。calls に (メソッド, パス) と /tts の本文を残す。"""
    calls = {"http": [], "body": None, "stopped": 0, "for_speech": []}
    monkeypatch.setattr(speech, "SPEECH_OUT", tmp_path)
    monkeypatch.setattr(speech, "VOICES_DIR", tmp_path / "voices")
    monkeypatch.setattr(server.openai_api, "_check_auth", lambda request: None)

    async def noop(*args, **kwargs):
        return []

    async def for_speech(cfg, engine):
        calls["for_speech"].append(engine)
        return []

    async def stop_speech(cfg):
        calls["stopped"] += 1
        return []
    monkeypatch.setattr(hub, "free_vram_for_generation", noop)
    monkeypatch.setattr(gpu_switch, "for_speech", for_speech)
    monkeypatch.setattr(gpu_switch, "stop_speech", stop_speech)
    calls["handler"] = lambda req: httpx.Response(200, content=make_wav(), headers={"content-type": "audio/wav"})

    def handler(req):
        calls["http"].append((req.method, req.url.path))
        if req.url.path == "/tts":
            calls["body"] = json.loads(req.content)
        return calls["handler"](req)
    monkeypatch.setattr(speech.httpx, "AsyncClient", lambda **kw: ORIGINAL(transport=httpx.MockTransport(handler), **kw))
    monkeypatch.setattr(speech, "category", lambda cfg: calls.get("cat", {}))

    def fake_ffmpeg(src, dst):   # 本物の ffmpeg は別のテストで使う
        dst.write_bytes(make_wav(seconds=0.3))
    monkeypatch.setattr(speech, "_ffmpeg", fake_ffmpeg)
    yield calls
    speech.cancel_idle()


def run(coro_fn):
    async def main():
        async with ORIGINAL(transport=httpx.ASGITransport(app=server.app), base_url="http://127.0.0.1") as client:
            return await coro_fn(client)
    return asyncio.run(main())


def test_engines_lists_static_metadata_without_touching_servers(env):
    async def go(c):
        d = (await c.get("/speech/engines")).json()
        assert [e["key"] for e in d["engines"]] == ["qwen3", "indextts", "fish"]
        q = d["engines"][0]
        assert "Ono_Anna" in q["speakers"] and q["commercial"] is True
        assert d["engines"][2]["commercial"] is False and "Research" in d["engines"][2]["license"]
        assert d["idle_unload_sec"] == speech.IDLE_UNLOAD_SEC
    run(go)
    assert env["http"] == [] and env["for_speech"] == []


def test_generate_list_file_delete_and_no_immediate_unload(env):
    async def go(c):
        r = await c.post("/speech/generate", json={"engine": "qwen3", "text": "こんにちは", "style": "ゆっくり",
                                                   "speaker": "Ono_Anna", "language": "ja", "seed": 7})
        assert r.status_code == 200, r.text
        item = r.json()
        assert item["engine"] == "qwen3" and item["url"] == f"/speech/file/{item['file']}" and item["duration"] == 0.2
        assert env["body"] == {"text": "こんにちは", "language": "ja", "style": "ゆっくり", "speaker": "Ono_Anna", "seed": 7}
        assert ("POST", "/unload") not in env["http"]   # 画面では生成のたびに降ろさない
        listed = (await c.get("/speech/list")).json()["items"]
        assert [i["file"] for i in listed] == [item["file"]] and listed[0]["text"] == "こんにちは"
        assert (await c.get(item["url"])).content[:4] == b"RIFF"
        assert (await c.delete(item["url"])).json() == {"deleted": item["file"]}
        assert (await c.get(item["url"])).status_code == 404
        assert (await c.get("/speech/list")).json()["items"] == []
    run(go)


def test_generate_error_mapping(env):
    async def go(c):
        body = {"engine": "qwen3", "text": "hi"}
        assert (await c.post("/speech/generate", json={**body, "engine": "nope"})).status_code == 400
        assert (await c.post("/speech/generate", json={**body, "voice": "missing"})).status_code == 404
        env["handler"] = lambda req: httpx.Response(400, json={"error": "unknown speaker: x"})
        r = await c.post("/speech/generate", json={**body, "speaker": "x"})
        assert r.status_code == 400 and "unknown speaker" in r.json()["detail"]
        env["handler"] = lambda req: httpx.Response(500, json={"error": "boom"})
        assert (await c.post("/speech/generate", json=body)).status_code == 502

        async def busy(cfg, engine):
            raise gpu_switch.SwitchError("画像を生成中です")
        gpu_switch.for_speech, saved = busy, gpu_switch.for_speech
        try:
            assert (await c.post("/speech/generate", json=body)).status_code == 409
        finally:
            gpu_switch.for_speech = saved
    run(go)


def test_names_are_validated(env, tmp_path):
    (tmp_path.parent / "outside.wav").write_bytes(b"x")
    async def go(c):
        for name in ("..%2Foutside.wav", "..%5Coutside.wav", "%2Fetc%2Fpasswd", "a.mp3", "nope.wav"):
            assert (await c.get("/speech/file/" + name)).status_code in (400, 404)
            assert (await c.delete("/speech/file/" + name)).status_code in (400, 404)
        for name in ("..%2Foutside", "..%5Coutside", "a.b", "nope"):
            assert (await c.get(f"/speech/voices/{name}/file")).status_code in (400, 404)
            assert (await c.delete(f"/speech/voices/{name}")).status_code in (400, 404)
        assert (await c.post("/speech/generate", json={"engine": "qwen3", "text": "x", "voice": "../x"})).status_code == 400
    run(go)
    assert (tmp_path.parent / "outside.wav").exists()


def test_voice_upload_use_from_result_and_delete(env):
    async def go(c):
        r = await c.post("/speech/voices", files={"file": ("my voice!.webm", b"x" * 5000)}, data={"text": "見本の文章"})
        assert r.status_code == 200, r.text
        v = r.json()
        assert v["name"] == "my_voice" and v["text"] == "見本の文章" and v["duration"] == 0.3
        again = (await c.post("/speech/voices", files={"file": ("my voice!.webm", b"x" * 5000)})).json()
        assert again["name"] != v["name"]
        assert [i["name"] for i in (await c.get("/speech/voices")).json()["items"]] and (await c.get(v["url"])).content[:4] == b"RIFF"
        await c.post("/speech/generate", json={"engine": "fish", "text": "テスト", "voice": v["name"], "voice_text": "見本の文章"})
        assert env["body"]["ref_audio"].endswith("voices" + ("\\" if "\\" in env["body"]["ref_audio"] else "/") + "my_voice.wav")
        assert env["body"]["ref_text"] == "見本の文章"
        gen = (await c.post("/speech/generate", json={"engine": "qwen3", "text": "保存する文章", "title": "題"})).json()
        saved = (await c.post(f"/speech/voices/from/{gen['file']}", json={})).json()
        assert saved["name"] == "題" and saved["text"] == "保存する文章"
        assert (await c.delete(f"/speech/voices/{v['name']}")).status_code == 200
        assert (await c.get(v["url"])).status_code == 404
        names = [i["name"] for i in (await c.get("/speech/voices")).json()["items"]]
        assert v["name"] not in names and saved["name"] in names
    run(go)


def test_voice_upload_rejects_bad_input(env, monkeypatch):
    async def go(c):
        assert (await c.post("/speech/voices", files={"file": ("a.wav", b"")})).status_code == 400
        big = b"x" * (speech.VOICE_MAX_BYTES + 1)
        assert (await c.post("/speech/voices", files={"file": ("a.wav", big)})).status_code == 400

        def bad(src, dst):
            raise speech.SpeechInputError("音声として読み取れませんでした")
        monkeypatch.setattr(speech, "_ffmpeg", bad)
        r = await c.post("/speech/voices", files={"file": ("a.wav", b"not audio" * 200)})
        assert r.status_code == 400 and "読み取れ" in r.json()["detail"]

        def missing(src, dst):
            raise speech.SpeechError("ffmpeg が見つかりません")
        monkeypatch.setattr(speech, "_ffmpeg", missing)
        assert (await c.post("/speech/voices", files={"file": ("a.wav", b"x" * 2000)})).status_code == 502
        assert (await c.get("/speech/voices")).json()["items"] == []
    run(go)


def test_ffmpeg_command_and_failures(monkeypatch, tmp_path):
    seen = {}

    class Done:
        returncode = 0

    def fake_run(cmd, **kw):
        seen["cmd"] = cmd
        Path(cmd[-1]).write_bytes(b"x" * 2000)
        return Done()
    monkeypatch.setattr(speech.shutil, "which", lambda name: "ffmpeg.exe")
    monkeypatch.setattr(speech.subprocess, "run", fake_run)
    speech._ffmpeg(tmp_path / "in.bin", tmp_path / "out.wav")
    assert seen["cmd"][seen["cmd"].index("-t") + 1] == "30" and "pcm_s16le" in seen["cmd"] and "-ac" in seen["cmd"]
    Done.returncode = 1
    with pytest.raises(speech.SpeechInputError):
        speech._ffmpeg(tmp_path / "in.bin", tmp_path / "out.wav")
    monkeypatch.setattr(speech.shutil, "which", lambda name: None)
    with pytest.raises(speech.SpeechError):
        speech._ffmpeg(tmp_path / "in.bin", tmp_path / "out.wav")


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg が無い")
def test_real_ffmpeg_makes_mono_pcm16_and_trims(tmp_path):
    src = tmp_path / "stereo.wav"
    make_wav(src, seconds=35, channels=2, rate=16000)
    dest = tmp_path / "out" / "v.wav"
    seconds = asyncio.run(speech.save_voice(src.read_bytes(), dest))
    with wave.open(str(dest)) as w:
        assert (w.getnchannels(), w.getsampwidth()) == (1, 2)
    assert 29.5 <= seconds <= 30.1
    with pytest.raises(speech.SpeechInputError):
        asyncio.run(speech.save_voice(b"this is not audio at all" * 100, tmp_path / "out" / "bad.wav"))


# --- アイドル後にモデルを降ろす ---
def unloads(env):
    return [c for c in env["http"] if c == ("POST", "/unload")]


def test_idle_unload_fires_once_after_delay(env):
    env["cat"] = {"idle_unload_sec": 0.15}
    async def go():
        await speech.synthesize({}, "qwen3", "a", keep_loaded=True)
        assert unloads(env) == []
        await asyncio.sleep(0.05)
        assert unloads(env) == []
        await asyncio.sleep(0.25)
        assert len(unloads(env)) == 1 and env["stopped"] == 0
        await asyncio.sleep(0.25)
        assert len(unloads(env)) == 1
    asyncio.run(go())


def test_new_request_cancels_pending_idle_unload(env):
    env["cat"] = {"idle_unload_sec": 0.3}
    async def go():
        await speech.synthesize({}, "qwen3", "a", keep_loaded=True)
        first = speech._idle_task
        await asyncio.sleep(0.2)
        await speech.synthesize({}, "qwen3", "b", keep_loaded=True)   # 0.2 秒後の2回目で最初の予約は消える
        await asyncio.sleep(0)
        assert first.cancelled()
        await asyncio.sleep(0.2)   # 最初の予約なら 0.3 秒で発火している時刻
        assert unloads(env) == []
        await asyncio.sleep(0.25)   # 2回目の予約は 0.5 秒で発火
        assert len(unloads(env)) == 1
    asyncio.run(go())


def test_request_during_unload_wait_cancels_it(env):
    env["cat"] = {"idle_unload_sec": 0.05}
    async def go():
        await speech.synthesize({}, "qwen3", "a", keep_loaded=True)
        async with gpu_switch.music_busy:   # 発火しても音楽・画像の生成が終わるまで待つ
            await asyncio.sleep(0.15)
            assert unloads(env) == []
            speech.cancel_idle()
        await asyncio.sleep(0.1)
        assert unloads(env) == []
    asyncio.run(go())


def test_idle_unload_failure_stops_the_server(env):
    env["cat"] = {"idle_unload_sec": 0.05}
    env["handler"] = lambda req: httpx.Response(500, json={"error": "x"}) if req.url.path == "/unload" else httpx.Response(200, content=make_wav())
    async def go():
        await speech.synthesize({}, "qwen3", "a", keep_loaded=True)
        await asyncio.sleep(0.3)
    asyncio.run(go())
    assert env["stopped"] == 1


def test_chat_style_unloads_immediately_and_cancels_idle(env):
    env["cat"] = {"idle_unload_sec": 0.2}
    async def go():
        await speech.synthesize({}, "qwen3", "a", keep_loaded=True)
        await speech.synthesize({}, "qwen3", "b")   # チャットは続けてすぐ降ろす
        assert len(unloads(env)) == 1 and speech._idle_task is None
        await asyncio.sleep(0.3)
        assert len(unloads(env)) == 1
    asyncio.run(go())


def test_endpoint_schedules_idle_unless_zero(env):
    env["cat"] = {"idle_unload_sec": 0}
    async def go(c):
        assert (await c.post("/speech/generate", json={"engine": "qwen3", "text": "a"})).status_code == 200
        assert len(unloads(env)) == 1   # 0 なら従来どおり生成のたびに降ろす
    run(go)
