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


@pytest.fixture(autouse=True)
def _reset_state(monkeypatch):
    monkeypatch.setattr(system, "_starting", {})
    monkeypatch.setattr(system, "_loading", {})


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


def test_logged_in_remote_can_operate_but_not_configure(monkeypatch, tmp_path):
    monkeypatch.setattr(llm, "load_config", lambda *a, **k: CFG)
    monkeypatch.setattr(system, "ENV_PATH", tmp_path / ".env")
    monkeypatch.setattr(system.hub.openai_api, "api_key", lambda: "k")
    monkeypatch.setattr(system.hub.openai_api, "model_keys", lambda: {"a": "mk"})

    async def autoload(*a, **k):
        return None
    monkeypatch.setattr(llm, "prewarm_default", autoload)
    app = FastAPI()
    system.register(app)
    c = TestClient(app, base_url="http://127.0.0.1:8765", client=("192.168.1.9", 50000))
    common, bound = {"Authorization": "Bearer k"}, {"Authorization": "Bearer mk"}
    assert c.post("/system/autoload", json={"enabled": False}, headers=common).status_code == 200
    assert c.post("/system/autoload", json={"enabled": False}, headers=bound).status_code == 403   # モデル専用キーは不可
    # 鍵の設定とモデルの導入は、ログインしていてもこのPCだけ
    assert c.post("/system/anthropic-key", json={"key": ""}, headers=common).status_code == 403
    assert c.post("/system/ollama/pull", json={"tag": "ta:1b"}, headers=common).status_code == 403


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
    (root / "app" / "run-app.bat").write_text("set LGS_X=1\npython -m uvicorn main:app --port 8787\n", encoding="utf-8")
    monkeypatch.setattr(llm, "load_config", lambda *a, **k: {**CFG, "studio": {"root": str(root), "base_url": "http://127.0.0.1:8787"}})
    monkeypatch.delenv("LGS_BASE", raising=False)
    spawned = []

    async def up(cfg):
        return {"ollama": True, "comfy": True, "studio": False, "acestep": False}
    monkeypatch.setattr(system, "_service_up", up)
    monkeypatch.setattr(system, "_studio_conflict", lambda cfg: "node.exe (PID 1)")
    monkeypatch.setattr(system, "_free_port", lambda start: start + 1)
    monkeypatch.setattr(system, "_spawn", lambda args, env=None, cwd=None, log=None: spawned.append(args[-1]))
    r = client.post("/system/services/studio/start")
    assert r.status_code == 200
    assert spawned == ["8788"]
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


def test_unknown_service_is_404(client):
    assert client.post("/system/services/nope/start").status_code == 404


def test_stop_refuses_foreign_process_on_port(client, monkeypatch):
    class P:
        pid = 42
        def cmdline(self):
            return ["node.exe", "server.js"]
        def cwd(self):
            return "C:/Users/x/smartphone-ai"
    monkeypatch.setattr(system, "_port_owner", lambda port: P())
    r = client.post("/system/services/comfy/stop")
    assert r.status_code == 409 and "PID 42" in r.json()["detail"]


def test_unload_turns_autoload_off_and_prewarm_respects_it(client, monkeypatch):
    async def loaded():
        return [{"name": "ta:1b"}]
    async def fake_post(self, url, json=None, **kw):
        return system.httpx.Response(200)
    monkeypatch.setattr(llm, "_ollama_loaded_models", loaded)
    monkeypatch.setattr(system.httpx.AsyncClient, "post", fake_post)
    assert client.post("/system/autoload", json={"enabled": True}).json() == {"autoload": True}
    r = client.post("/system/models/unload", json={"tag": "ta:1b"})
    assert r.json()["done"] == ["ta:1b を VRAM から降ろしました"]
    assert llm.keepwarm_paused is True    # 降ろしたあと裏で戻さない


def test_load_requires_installed_model(client, monkeypatch):
    async def alive():
        return True
    async def installed():
        return ["ta:1b"]
    monkeypatch.setattr(llm, "is_alive", alive)
    monkeypatch.setattr(llm, "list_models", installed)
    assert client.post("/system/models/load", json={"tag": "zz:9b"}).status_code == 404
    assert client.post("/system/models/load", json={"tag": ""}).status_code == 400


def test_studio_starts_on_configured_port_when_bat_differs(client, monkeypatch, tmp_path):
    root = tmp_path / "lgs"
    (root / "comfyui").mkdir(parents=True)
    (root / "app").mkdir()
    (root / "comfyui" / "run-comfy.bat").write_text("", encoding="utf-8")
    (root / "app" / "run-app.bat").write_text("python -m uvicorn main:app --port 8787\n", encoding="utf-8")
    monkeypatch.setattr(llm, "load_config", lambda *a, **k: {**CFG, "studio": {"root": str(root), "base_url": "http://127.0.0.1:8787"}})
    monkeypatch.setenv("LGS_BASE", "http://127.0.0.1:8788")   # 以前の競合で .env に残った番号
    spawned = []

    async def up(cfg):
        return {"ollama": True, "comfy": True, "studio": False, "acestep": False}
    monkeypatch.setattr(system, "_service_up", up)
    monkeypatch.setattr(system, "_studio_conflict", lambda cfg: "")
    monkeypatch.setattr(system, "_spawn", lambda args, env=None, cwd=None, log=None: spawned.append(args))
    assert client.post("/system/services/studio/start").status_code == 200
    assert spawned[0][-1] == "8788"    # bat (8787) ではなく接続先の番号で起動する


def test_free_speech_stops_tts_servers(client, monkeypatch):
    async def stop(cfg):
        return ["音声合成 fish を停止"]
    monkeypatch.setattr(system.gpu_switch, "stop_speech", stop)
    r = client.post("/system/vram/free", json={"targets": ["speech"]})
    assert r.status_code == 200 and r.json()["done"] == ["音声合成 fish を停止しました"]
