import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import llm
import runs
import system

CFG = {"models": {"a": {"tag": "ta:1b"}}, "gpu_switch": {"enabled": True}}


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setattr(llm, "load_config", lambda *a, **k: CFG)
    monkeypatch.setattr(system, "ENV_PATH", tmp_path / ".env")
    monkeypatch.setattr(runs.manager, "running_count", lambda: 0)
    app = FastAPI()
    system.register(app)
    return TestClient(app, base_url="http://127.0.0.1:8765", client=("127.0.0.1", 50000))


def test_remote_client_is_refused(monkeypatch):
    monkeypatch.setattr(llm, "load_config", lambda *a, **k: CFG)
    app = FastAPI()
    system.register(app)
    c = TestClient(app, base_url="http://127.0.0.1:8765", client=("192.168.1.5", 50000))
    # キー未設定なら 403、設定済みでもキー無しの要求は 401。どちらでも通さない
    assert c.post("/system/vram/free", json={"targets": ["ollama"]}).status_code in (401, 403)


def test_unload_selected_ollama_model(client, monkeypatch):
    async def loaded():
        return [{"name": "ta:1b"}, {"name": "tb:2b"}]
    posted = []

    async def fake_post(self, url, json=None, **kw):
        posted.append(json)
        return system.httpx.Response(200)
    monkeypatch.setattr(llm, "_ollama_loaded_models", loaded)
    monkeypatch.setattr(system.httpx.AsyncClient, "post", fake_post)
    r = client.post("/system/vram/free", json={"targets": ["ollama:tb:2b"]})
    assert r.status_code == 200
    assert posted == [{"model": "tb:2b", "keep_alive": 0}]


def test_unload_refused_while_agent_runs(client, monkeypatch):
    monkeypatch.setattr(runs.manager, "running_count", lambda: 1)
    assert client.post("/system/vram/free", json={"targets": ["ollama"]}).status_code == 409


def test_pull_only_models_in_config(client):
    assert client.post("/system/ollama/pull", json={"tag": "evil/model"}).status_code == 400


def test_studio_starts_on_free_port_when_default_taken(client, monkeypatch, tmp_path):
    root = tmp_path / "lgs"
    (root / "comfyui").mkdir(parents=True)
    (root / "app").mkdir()
    (root / "comfyui" / "run-comfy.bat").write_text("", encoding="utf-8")
    (root / "app" / "run-app.bat").write_text("set LGS_X=1\n", encoding="utf-8")
    monkeypatch.setattr(llm, "load_config", lambda *a, **k: {**CFG, "studio": {"root": str(root), "base_url": "http://127.0.0.1:8787"}})
    monkeypatch.delenv("LGS_BASE", raising=False)
    spawned = []

    async def up(url):
        return True   # ComfyUI は起動済み
    async def studio_up(cfg):
        return False
    monkeypatch.setattr(system, "_up", up)
    monkeypatch.setattr(system, "_studio_up", studio_up)
    monkeypatch.setattr(system, "_studio_conflict", lambda cfg: "node.exe (PID 1)")
    monkeypatch.setattr(system, "_free_port", lambda start: start + 1)
    monkeypatch.setattr(system, "_spawn_studio_app", lambda bat, port: spawned.append(port))
    r = client.post("/system/studio/start")
    assert r.status_code == 200
    assert spawned == [8788]
    assert "8788" in r.json()["done"][0]
    assert system.os.environ["LGS_BASE"] == "http://127.0.0.1:8788"
    assert "LGS_BASE=http://127.0.0.1:8788" in system.ENV_PATH.read_text(encoding="utf-8")
    monkeypatch.delenv("LGS_BASE")


def test_anthropic_key_saved_and_removed(client, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    (system.ENV_PATH).write_text("OTHER=1\nANTHROPIC_API_KEY=old\n", encoding="utf-8")
    assert client.post("/system/anthropic-key", json={"key": "nope"}).status_code == 400
    key = "sk-ant-" + "x" * 30
    assert client.post("/system/anthropic-key", json={"key": key}).json() == {"anthropic_key": True}
    assert system.ENV_PATH.read_text(encoding="utf-8") == f"OTHER=1\nANTHROPIC_API_KEY={key}\n"
    assert llm.anthropic_ready()
    assert client.post("/system/anthropic-key", json={"key": ""}).json() == {"anthropic_key": False}
    assert system.ENV_PATH.read_text(encoding="utf-8") == "OTHER=1\n"
    assert not llm.anthropic_ready()
