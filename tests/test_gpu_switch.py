import asyncio
import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import gpu_switch

CFG = {"gpu_switch": {"start_timeout": 1, "acestep_start": "start.ps1"}}
REAL_CLIENT = httpx.AsyncClient


def mock_http(monkeypatch, handler):
    monkeypatch.setattr(gpu_switch.httpx, "AsyncClient",
                        lambda **kw: REAL_CLIENT(transport=httpx.MockTransport(handler), **kw))


def test_music_frees_comfy_and_starts_acestep(monkeypatch):
    calls, started = [], []
    state = {"up": False}

    def handler(req):
        calls.append(f"{req.method} {req.url.port}{req.url.path}")
        if req.url.path == "/health":
            return httpx.Response(200 if state["up"] else 503)
        return httpx.Response(200, json={})

    def fake_run(script):
        started.append(script)
        state["up"] = True
    mock_http(monkeypatch, handler)
    monkeypatch.setattr(gpu_switch, "find_processes", lambda pattern: [])
    monkeypatch.setattr(gpu_switch, "run_start_script", fake_run)
    done = asyncio.run(gpu_switch.for_music(CFG))
    assert calls[:2] == ["GET 8188/queue", "POST 8188/free"] and started == ["start.ps1"]
    assert done == ["ComfyUI のモデルを解放", "ACE-Step を起動"]


def test_music_when_acestep_already_up_does_not_start(monkeypatch):
    mock_http(monkeypatch, lambda req: httpx.Response(200, json={}))
    monkeypatch.setattr(gpu_switch, "run_start_script", lambda script: pytest.fail("started twice"))
    assert asyncio.run(gpu_switch.for_music(CFG)) == ["ComfyUI のモデルを解放"]


def test_music_start_timeout_is_reported(monkeypatch):
    def handler(req):
        if req.url.port == 8188:
            raise httpx.ConnectError("comfy down")
        return httpx.Response(503)
    mock_http(monkeypatch, handler)
    monkeypatch.setattr(gpu_switch, "find_processes",
                        lambda pattern: ["starting"] if "acestep" in pattern else [])   # 起動途中
    with pytest.raises(gpu_switch.SwitchError, match="起動しませんでした"):
        asyncio.run(gpu_switch.for_music(CFG))


def test_studio_stops_acestep(monkeypatch):
    killed = []

    class P:
        def kill(self):
            killed.append(1)
    monkeypatch.setattr(gpu_switch, "find_processes",
                        lambda pattern: [P(), P()] if "acestep" in pattern else [P()] if "fish" in pattern else [])
    monkeypatch.setattr(gpu_switch.psutil, "wait_procs", lambda procs, timeout: (procs, []))
    assert asyncio.run(gpu_switch.for_studio(CFG)) == ["ACE-Step を停止", "音声合成 fish を停止"]
    assert killed == [1, 1, 1]


def test_studio_reports_unkillable_acestep(monkeypatch):
    class P:
        pid = 42

        def kill(self):
            pass
    monkeypatch.setattr(gpu_switch, "find_processes", lambda pattern: [P()] if "acestep" in pattern else [])
    monkeypatch.setattr(gpu_switch.psutil, "wait_procs", lambda procs, timeout: ([], procs))
    with pytest.raises(gpu_switch.SwitchError, match="pid 42"):
        asyncio.run(gpu_switch.for_studio(CFG))


def test_music_refuses_while_comfy_is_busy(monkeypatch):
    def handler(req):
        if req.url.path == "/queue":
            return httpx.Response(200, json={"queue_running": [["x"]], "queue_pending": []})
        return pytest.fail("must not free or start")
    mock_http(monkeypatch, handler)
    with pytest.raises(gpu_switch.SwitchError, match="画像・動画を生成中"):
        asyncio.run(gpu_switch.for_music(CFG))


def test_disabled_does_nothing(monkeypatch):
    monkeypatch.setattr(gpu_switch, "find_processes", lambda pattern: pytest.fail("touched"))
    off = {"gpu_switch": {"enabled": False}}
    assert asyncio.run(gpu_switch.for_studio(off)) == []
    assert asyncio.run(gpu_switch.for_music(off)) == []


def test_process_pattern_matches_only_acestep():
    import re
    rx = re.compile(gpu_switch.DEFAULTS["acestep_process"])
    assert rx.search(r"C:\venv\python.exe -u acestep\api_server.py --port 8001")
    assert not rx.search(r'"C:\Python312\pythonw.exe" server.py')


def test_speech_process_pattern_matches_only_its_engine():
    import re
    rx = re.compile(gpu_switch.speech_process("qwen3"))
    assert rx.search(r"C:\project\tts-qwen3\.venv\Scripts\python.exe -u C:\project\tts-qwen3\server.py")
    assert not rx.search(r"C:\project\tts-fish\.venv\Scripts\python.exe -u C:\project\tts-fish\server.py")


def test_speech_stops_others_and_starts_engine(monkeypatch):
    killed, started = [], []
    state = {"up": False}

    class P:
        def __init__(self, name):
            self.name = name

        def kill(self):
            killed.append(self.name)

    def procs(pattern):
        if "acestep" in pattern:
            return [P("ace")]
        if "fish" in pattern:
            return [P("fish")]
        return []   # qwen3 / indextts は止まっている

    def handler(req):
        if req.url.path == "/health":
            return httpx.Response(200 if state["up"] else 503)
        return httpx.Response(200, json={})

    def fake_run(script):
        started.append(script)
        state["up"] = True
    mock_http(monkeypatch, handler)
    monkeypatch.setattr(gpu_switch, "find_processes", procs)
    monkeypatch.setattr(gpu_switch, "run_start_script", fake_run)
    monkeypatch.setattr(gpu_switch.psutil, "wait_procs", lambda procs, timeout: (procs, []))
    done = asyncio.run(gpu_switch.for_speech(CFG, "qwen3"))
    assert killed == ["ace", "fish"] and started == ["C:/project/tts-qwen3/start-detached.ps1"]
    assert done == ["ComfyUI のモデルを解放", "ACE-Step を停止", "音声合成 fish を停止", "音声合成 qwen3 を起動"]


def test_speech_unknown_engine_is_reported():
    with pytest.raises(gpu_switch.SwitchError, match="見つかりません: nope"):
        asyncio.run(gpu_switch.for_speech(CFG, "nope"))


def test_speech_up_checks_only_the_engines_health(monkeypatch):
    urls = []

    async def up(url, timeout=3.0):
        urls.append(url)
        return url.startswith("http://127.0.0.1:8011")
    monkeypatch.setattr(gpu_switch, "_up", up)
    assert asyncio.run(gpu_switch.speech_up({}, "qwen3")) is True
    assert asyncio.run(gpu_switch.speech_up({}, "fish")) is False
    assert asyncio.run(gpu_switch.speech_up({}, "nope")) is False
    assert urls == ["http://127.0.0.1:8011/health", "http://127.0.0.1:8013/health"]
