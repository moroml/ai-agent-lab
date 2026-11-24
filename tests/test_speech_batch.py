import asyncio
import io
import shutil
import sys
import zipfile
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import speech
import speech_batch
from test_speech import ORIGINAL, env, make_wav  # noqa: F401  (env は fixture)
import server


@pytest.fixture
def benv(env, monkeypatch, tmp_path):
    monkeypatch.setattr(speech_batch, "BATCH_DIR", tmp_path / "batch")
    monkeypatch.setattr(speech_batch, "_jobs", {})
    monkeypatch.setattr(speech_batch, "_cancel", set())
    monkeypatch.setattr(speech_batch, "_seconds", lambda p: 0.2)
    return env


def run(coro_fn):
    async def main():
        async with ORIGINAL(transport=httpx.ASGITransport(app=server.app), base_url="http://127.0.0.1") as c:
            return await coro_fn(c)
    return asyncio.run(main())


async def wait_done(c, job):
    for _ in range(200):
        j = (await c.get(f"/speech/batch/{job}")).json()
        if j["state"] != "running":
            return j
        await asyncio.sleep(0.02)
    raise AssertionError("終わらない")


def test_parse_lines_header_auto_ids_dupes_and_limits():
    lines = speech_batch.parse_lines("﻿id,text\nhello,こんにちは\n\nただの文\nhello,二つ目,v1,嬉しそう\n a/b ,x")
    assert [ln["id"] for ln in lines] == ["hello", "line_002", "hello_2", "a_b"]
    assert lines[2]["voice"] == "v1" and lines[2]["style"] == "嬉しそう" and lines[1]["text"] == "ただの文"
    assert speech_batch.parse_lines('x,"カンマ, 入り"')[0]["text"] == "カンマ, 入り"
    for bad in ["", "id,text\n", "a,", "\n".join(["x"] * (speech_batch.MAX_LINES + 1)), "a," + "あ" * 1001]:
        with pytest.raises(speech.SpeechInputError):
            speech_batch.parse_lines(bad)


def test_batch_writes_files_zip_and_manifest(benv):
    async def go(c):
        r = await c.post("/speech/batch", json={"engine": "qwen3", "csv": "a,一つ目\nb,二つ目", "format": "wav",
                                                "normalize": False, "name": "村人 セリフ", "seed": 3})
        assert r.status_code == 200, r.text
        j = await wait_done(c, r.json()["job"])
        assert j["state"] == "done" and j["done"] == 2 and j["failed"] == [] and j["zip_url"]
        z = await c.get(j["zip_url"])
        assert z.status_code == 200 and "_.zip" not in z.headers["content-disposition"]
        names = zipfile.ZipFile(io.BytesIO(z.content)).namelist()
        assert sorted(names) == ["a.wav", "b.wav", "lines.csv"]
        manifest = zipfile.ZipFile(io.BytesIO(z.content)).read("lines.csv").decode("utf-8-sig")
        assert manifest.splitlines()[1] == "a,一つ目,a.wav,0.2"
        listed = (await c.get("/speech/batch")).json()["items"]
        assert [x["job"] for x in listed] == [j["job"]] and "opts" not in listed[0]
        assert (await c.delete(f"/speech/batch/{j['job']}")).status_code == 200
        assert (await c.get(f"/speech/batch/{j['job']}")).status_code == 404
    run(go)
    assert benv["body"]["seed"] == 3


def test_batch_rejects_bad_input(benv):
    async def go(c):
        base = {"engine": "qwen3", "csv": "a,x"}
        assert (await c.post("/speech/batch", json={**base, "engine": "nope"})).status_code == 400
        assert (await c.post("/speech/batch", json={**base, "format": "flac"})).status_code == 400
        r = await c.post("/speech/batch", json={**base, "csv": "a,x,ghost"})
        assert r.status_code == 400 and "ghost" in r.json()["detail"]
        assert (await c.get("/speech/batch/..%2Fx")).status_code in (400, 404)
        assert (await c.get("/speech/batch/nojob")).status_code == 404
    run(go)


def test_batch_uses_saved_voice_and_stops_after_repeated_failures(benv):
    speech.VOICES_DIR.mkdir(parents=True)
    make_wav(speech.VOICES_DIR / "hero.wav")
    (speech.VOICES_DIR / "hero.json").write_text('{"text": "見本の文"}', encoding="utf-8")
    bodies = []

    def handler(req):
        if req.url.path == "/tts":
            import json
            bodies.append(json.loads(req.content))
            return httpx.Response(500, json={"error": "boom"})
        return httpx.Response(200, json={})
    benv["handler"] = handler

    async def go(c):
        r = await c.post("/speech/batch", json={"engine": "qwen3", "voice": "hero", "speaker": "Ryan",
                                                "csv": "\n".join(f"l{i},文{i}" for i in range(6))})
        j = await wait_done(c, r.json()["job"])
        assert j["state"] == "error" and j["done"] == 3 and len(j["failed"]) == 4 and j["zip_url"] is None
    run(go)
    assert bodies[0]["ref_audio"].endswith("hero.wav") and bodies[0]["ref_text"] == "見本の文"
    assert "speaker" not in bodies[0]


def test_batch_cancel_and_single_runner(benv, monkeypatch):
    async def go(c):
        slow = {"n": 0}
        real = speech.synthesize

        async def synth(*a, **kw):
            slow["n"] += 1
            await asyncio.sleep(0.05)
            return await real(*a, **kw)
        monkeypatch.setattr(speech, "synthesize", synth)
        r = await c.post("/speech/batch", json={"engine": "qwen3", "csv": "\n".join(f"l{i},x" for i in range(20))})
        job = r.json()["job"]
        assert (await c.post("/speech/batch", json={"engine": "qwen3", "csv": "a,x"})).status_code == 409
        assert (await c.delete(f"/speech/batch/{job}")).status_code == 409
        await c.post(f"/speech/batch/{job}/cancel")
        j = await wait_done(c, job)
        assert j["state"] == "cancelled" and j["done"] < 20
    run(go)


@pytest.mark.skipif(not (shutil.which("ffmpeg") and shutil.which("ffprobe")), reason="ffmpeg が無い")
@pytest.mark.parametrize("fmt", ["ogg", "mp3", "wav"])
def test_real_convert_with_loudnorm(tmp_path, fmt):
    src = tmp_path / "in.wav"
    make_wav(src, seconds=1.0, rate=24000)
    out = tmp_path / f"out.{fmt}"
    speech_batch._convert(src, out, fmt, True)
    assert out.stat().st_size > 100 and 0.9 < speech_batch._seconds(out) < 1.2


def test_reserved_windows_names_are_renamed():
    ids = [ln["id"] for ln in speech_batch.parse_lines("CON,a\nnul,b\ncom1,c\nconsole,d")]
    assert ids == ["CON_", "nul_", "com1_", "console"]
