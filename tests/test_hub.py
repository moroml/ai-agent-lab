import json
import sys
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import hub
import llm
import music

CFG = {"studio": {"base_url": "http://lgs.test", "token_file": ""},
       "categories": {"chat": {"model": "a", "fallback": ["b"], "system": "SYS", "history_chars": 10},
                      "music": {"model": "music", "unload_llm": True}},
       "models": {"a": {"tag": "ta", "strengths": ["chat"]}, "b": {"tag": "tb", "strengths": ["chat"]},
                  "music": {"kind": "music", "dit_model": "d"}}}


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(llm, "load_config", lambda *a, **k: CFG)
    monkeypatch.setenv("LGS_TOKEN", "tok")
    monkeypatch.delenv("LGS_BASE", raising=False)

    async def no_switch(cfg):
        return []
    # 実機の ComfyUI / ACE-Step に触れない (差し替え忘れで本物の ACE-Step を止めた 2026-11-13)
    monkeypatch.setattr(hub.gpu_switch, "for_studio", no_switch)
    monkeypatch.setattr(hub.gpu_switch, "for_music", no_switch)
    app = FastAPI()
    hub.register(app)
    return TestClient(app, base_url="http://127.0.0.1:8765", client=("127.0.0.1", 50000))


REAL_CLIENT = httpx.AsyncClient


def mock_studio(monkeypatch, handler):
    monkeypatch.setattr(hub.httpx, "AsyncClient", lambda **kw: REAL_CLIENT(transport=httpx.MockTransport(handler), **kw))


def test_trim_history_keeps_latest_within_budget():
    msgs = [{"role": "user", "content": "x" * 8}, {"role": "assistant", "content": "y" * 5},
            {"role": "user", "content": "z" * 4}]
    assert hub.trim_history(msgs, 10) == msgs[1:]
    # 最新1件は予算を超えても必ず残す
    assert hub.trim_history([{"role": "user", "content": "q" * 50}], 10)[0]["content"] == "q" * 50


def test_studio_proxy_injects_token_and_strips_secret(client, monkeypatch):
    seen = {}

    def handler(req):
        seen["auth"] = req.headers.get("authorization")
        seen["url"] = str(req.url)
        seen["body"] = json.loads(req.content)
        return httpx.Response(200, json={"job_id": "j1"})
    mock_studio(monkeypatch, handler)
    r = client.post("/studio/generate", json={"model": "flux2-klein", "prompt_en": "x", "secret": True})
    assert r.json() == {"job_id": "j1", "gpu_switch": []}
    assert seen["auth"] == "Bearer tok" and seen["url"] == "http://lgs.test/api/generate"
    assert "secret" not in seen["body"]


def test_studio_errors_are_explained(client, monkeypatch):
    mock_studio(monkeypatch, lambda req: httpx.Response(401, json={"detail": "x"}))
    r = client.get("/studio/catalog")
    assert r.status_code == 401 and "トークン" in r.json()["detail"]

    def down(req):
        raise httpx.ConnectError("refused")
    mock_studio(monkeypatch, down)
    assert client.get("/studio/status").json()["connected"] is False


def test_gallery_filters_kind_and_rewrites_urls(client, monkeypatch):
    rows = [{"id": 1, "kind": "image", "meta": {"model": "m", "prompt_ja": "猫"}},
            {"id": 2, "kind": "video", "meta": {}}]
    mock_studio(monkeypatch, lambda req: httpx.Response(200, json=rows))
    items = client.get("/studio/gallery?kind=image").json()["items"]
    assert [i["id"] for i in items] == [1]
    assert items[0]["url"] == "/studio/files/1" and items[0]["thumb_url"] == "/studio/thumbs/1"


def test_chat_falls_back_and_adds_system(client, monkeypatch):
    async def installed():
        return ["tb"]

    async def usable(cfg, key, inst, _p=None):
        return (llm.resolve(cfg, key)["tag"] in inst, "ok")
    sent = {}

    async def stream(cfg, key, msgs, **kw):
        sent.update(key=key, msgs=msgs, think=kw.get("think"))
        yield {"content": "hi"}
        yield {"done": True, "meta": {"eval_count": 1}}
    monkeypatch.setattr(llm, "list_models", installed)
    monkeypatch.setattr(llm, "model_usable", usable)
    monkeypatch.setattr(llm, "chat_stream", stream)
    r = client.post("/hub/chat", json={"messages": [{"role": "user", "content": "hello"}]})
    events = [json.loads(line[6:]) for line in r.text.split("\n\n") if line.startswith("data: ")]
    assert sent["key"] == "b" and sent["msgs"][0] == {"role": "system", "content": "SYS"}
    assert events[0]["model"] == "b" and events[1] == {"content": "hi"} and events[-1]["done"]


def test_chat_refusal_is_reanswered_once(client, monkeypatch):
    """拒否の回答は refusal_fallback のモデルで1回だけ答え直す (答え直しも拒否ならそのまま返す)。"""
    cfg = {**CFG, "refusal_fallback": "b"}
    used = []

    async def installed():
        return []

    async def usable(cfg, key, inst, _p=None):
        return (True, "ok")

    async def stream(cfg, key, msgs, **kw):
        used.append(key)
        yield {"content": "申し訳ありませんが、そのようなコンテンツの取得や生成を支援することはできません。"}
        yield {"done": True, "meta": {}}
    monkeypatch.setattr(llm, "load_config", lambda *a, **k: cfg)
    monkeypatch.setattr(llm, "list_models", installed)
    monkeypatch.setattr(llm, "model_usable", usable)
    monkeypatch.setattr(llm, "chat_stream", stream)
    r = client.post("/hub/chat", json={"messages": [{"role": "user", "content": "q"}], "model": "a", "tools": False})
    events = [json.loads(line[6:]) for line in r.text.split("\n\n") if line.startswith("data: ")]
    assert used == ["a", "b"]
    assert [e["model"] for e in events if e.get("retry")] == ["b"] and events[-1]["done"]


def test_chat_reanswer_keeps_finished_tool_results(client, monkeypatch):
    """ツールを使ったあとの拒否は、実行済みのツール結果を引き継いで答え直す (同じ操作を繰り返さない)。"""
    cfg = {**CFG, "refusal_fallback": "b",
           "models": {k: {**m, "tools": True} for k, m in CFG["models"].items()}}
    seen = []

    async def installed():
        return []

    async def usable(cfg, key, inst, _p=None):
        return (True, "ok")

    async def run(cfg, key, msgs, **kw):
        seen.append([m["role"] for m in msgs])
        if key == "a":
            yield {"content": "お答えできませんが、調べます。"}   # 途中の発言は拒否判定に使わない
            yield {"tool": {"id": 1, "name": "write_file", "label": "x"}}
            msgs += [{"role": "assistant", "content": "", "tool_calls": [{}]},
                     {"role": "tool", "tool_name": "write_file", "content": "書き込み完了"}]
            yield {"content": "申し訳ありませんが、お答えできません。"}
        else:
            yield {"content": "答えです"}
        yield {"done": True, "meta": {}}
    monkeypatch.setattr(llm, "load_config", lambda *a, **k: cfg)
    monkeypatch.setattr(llm, "list_models", installed)
    monkeypatch.setattr(llm, "model_usable", usable)
    monkeypatch.setattr(hub.chat_agent, "run", run)
    r = client.post("/hub/chat", json={"messages": [{"role": "user", "content": "q"}], "model": "a"})
    assert seen == [["system", "user"], ["system", "user", "assistant", "tool"]]
    assert r.text.count('"retry"') == 1


def test_chat_rejects_trailing_assistant(client, monkeypatch):
    async def installed():
        return ["ta"]

    async def usable(cfg, key, inst, _p=None):
        return True, "ok"
    monkeypatch.setattr(llm, "list_models", installed)
    monkeypatch.setattr(llm, "model_usable", usable)
    r = client.post("/hub/chat", json={"messages": [{"role": "assistant", "content": "x"}]})
    assert r.status_code == 400


def test_secret_chat_workspace_is_discarded(client, monkeypatch, tmp_path):
    monkeypatch.setattr(hub, "WORKSPACE", str(tmp_path))
    for name in ("chat_secret-abc", "chat_secret-old", "chat_normal"):
        (tmp_path / name / "inputs").mkdir(parents=True)
    batch = tmp_path / "_attach" / "0123456789ab"
    batch.mkdir(parents=True)
    import attach
    monkeypatch.setattr(attach, "STORE", tmp_path / "_attach")
    assert client.delete("/hub/chat/secret-abc?batch=0123456789ab").json() == {"ok": True}
    assert not (tmp_path / "chat_secret-abc").exists() and not batch.exists()
    # 通常の会話のフォルダは消せない
    assert client.delete("/hub/chat/normal").status_code == 400
    hub.sweep_secret()
    assert sorted(p.name for p in tmp_path.iterdir()) == ["_attach", "chat_normal"]


def test_secret_music_is_unlisted_and_swept(client, monkeypatch, tmp_path):
    """シークレットの曲は一覧に出さず、メタ情報も書かず、起動時の掃除で消す。"""
    monkeypatch.setattr(music, "MUSIC_OUT", tmp_path)

    async def gen(cfg, key, prompt, **kw):
        (tmp_path / "x.mp3").write_bytes(b"ID3")
        return {"path": str(tmp_path / "x.mp3"), "file": "x.mp3", "duration": 1, "model": key}

    async def no_unload(cfg, cat, running):
        return []
    monkeypatch.setattr(music, "generate_music", gen)
    monkeypatch.setattr(hub, "free_vram_for_generation", no_unload)
    r = client.post("/music/generate", json={"prompt": "p", "secret": True}).json()
    assert r["file"] == "secret-x.mp3" and [p.name for p in tmp_path.iterdir()] == ["secret-x.mp3"]
    assert client.get("/music/list").json()["items"] == []
    assert client.get(r["url"]).status_code == 200
    hub.sweep_secret()
    assert not list(tmp_path.iterdir())


def test_music_files_list_and_traversal(client, monkeypatch, tmp_path):
    monkeypatch.setattr(music, "MUSIC_OUT", tmp_path)
    (tmp_path / "a.mp3").write_bytes(b"ID3")
    (tmp_path / "a.json").write_text(json.dumps({"title": "曲A", "prompt": "pop"}), encoding="utf-8")
    (tmp_path / "secret.txt").write_text("x")
    items = client.get("/music/list").json()["items"]
    assert [(i["file"], i["title"]) for i in items] == [("a.mp3", "曲A")]
    assert client.get("/music/file/a.mp3").content == b"ID3"
    assert client.get("/music/file/secret.txt").status_code == 400
    assert client.delete("/music/file/..%5Ca.mp3").status_code in (400, 404)
    assert client.delete("/music/file/a.mp3").status_code == 200
    assert not (tmp_path / "a.json").exists()


@pytest.mark.anyio
async def test_free_vram_skips_while_agent_runs(monkeypatch):
    called = []

    async def loaded():
        called.append(1)
        return ["ta"]
    monkeypatch.setattr(llm, "loaded_model_tags", loaded)
    assert await hub.free_vram_for_generation(CFG, {"unload_llm": True}, running_runs=1) == []
    assert await hub.free_vram_for_generation(CFG, {"unload_llm": False}, running_runs=0) == []
    assert called == []


def test_remote_requests_need_api_key(monkeypatch):
    class Req:
        client = type("C", (), {"host": "192.168.1.5"})()
        headers = {"host": "127.0.0.1:8765"}
        cookies = {}
    monkeypatch.setattr(hub.openai_api, "api_key", lambda: "k")
    with pytest.raises(Exception) as e:
        hub.require_local_or_key(Req())
    assert getattr(e.value, "status_code", None) == 401
    monkeypatch.setattr(hub.openai_api, "api_key", lambda: "")
    with pytest.raises(Exception) as e:
        hub.require_local_or_key(Req())   # キー未設定なら外部は拒否
    assert e.value.status_code == 403
    Req.client.host = "127.0.0.1"
    hub.require_local_or_key(Req())   # このPCからは素通し


def test_cross_site_post_is_rejected(client):
    r = client.post("/studio/jobs/j1/cancel", headers={"Origin": "https://evil.example"})
    assert r.status_code == 403
    # DNS リバインディング: Origin と Host が攻撃者ドメインで一致していても拒否する
    r = client.post("/studio/jobs/j1/cancel", headers={"Host": "evil.example:8765", "Origin": "http://evil.example:8765"})
    assert r.status_code == 403


def test_studio_refuses_while_music_runs(client, monkeypatch):
    mock_studio(monkeypatch, lambda req: pytest.fail("must not submit"))

    async def hold():
        async with hub.gpu_switch.music_busy:
            return client.post("/studio/generate", json={"model": "m", "prompt_en": "x"})
    import asyncio
    r = asyncio.run(hold())
    assert r.status_code == 409 and "音楽" in r.json()["detail"]


def test_categories_hide_music_and_system_prompt(client):
    d = client.get("/hub/categories").json()
    assert "system" not in d["categories"]["chat"]
    assert {m["key"] for m in d["chat_models"]} == {"a", "b"}


def test_explicit_chat_model_is_not_replaced(client, monkeypatch):
    async def installed():
        return ["ta"]

    async def usable(cfg, key, inst, _p=None):
        return (llm.resolve(cfg, key)["tag"] in inst, "not_installed")
    monkeypatch.setattr(llm, "list_models", installed)
    monkeypatch.setattr(llm, "model_usable", usable)
    r = client.post("/hub/chat", json={"model": "b", "messages": [{"role": "user", "content": "x"}]})
    assert r.status_code == 400   # b が使えないとき a に黙って差し替えない


# ---- チャットの run_command ----
def agent_cfg(monkeypatch, seen):
    cfg = {**CFG, "models": {k: {**m, "tools": True} for k, m in CFG["models"].items()}}

    async def installed():
        return []

    async def usable(cfg, key, inst, _p=None):
        return (True, "ok")

    async def run(cfg, key, msgs, **kw):
        seen.append(kw)
        yield {"content": "ok"}
        yield {"done": True, "meta": {}}
    monkeypatch.setattr(llm, "load_config", lambda *a, **k: cfg)
    monkeypatch.setattr(llm, "list_models", installed)
    monkeypatch.setattr(llm, "model_usable", usable)
    monkeypatch.setattr(hub.chat_agent, "run", run)


BODY = {"messages": [{"role": "user", "content": "q"}], "model": "a"}


def test_chat_commands_off_by_default_and_on_for_pc(client, monkeypatch):
    seen = []
    agent_cfg(monkeypatch, seen)
    client.post("/hub/chat", json=BODY)
    client.post("/hub/chat", json={**BODY, "commands": True})
    client.post("/hub/chat", json={**BODY, "commands": True, "tools": False})
    assert [kw["commands"] for kw in seen] == [False, True]   # ツールを切っていれば commands も効かない


@pytest.mark.parametrize("headers", [{"X-Forwarded-For": "100.64.0.2"}, {"Tailscale-User-Login": "a@b"}])
def test_chat_commands_refused_when_not_pc_local(client, monkeypatch, headers):
    seen = []
    agent_cfg(monkeypatch, seen)
    monkeypatch.setattr(hub.openai_api, "is_tailnet", lambda r: True)   # 認証は通るが、PC の画面ではない
    r = client.post("/hub/chat", json={**BODY, "commands": True}, headers=headers)
    assert r.status_code == 403 and "このPC" in r.json()["detail"] and not seen
    assert client.post("/hub/chat", json=BODY, headers=headers).status_code == 200   # 使わなければ通る
    assert seen[-1]["commands"] is False


def test_chat_approval_endpoint(client, monkeypatch):
    got = {}

    def resolve(aid, ok):
        got[aid] = ok
        return aid == "a1"
    monkeypatch.setattr(hub.chat_agent, "resolve_approval", resolve)
    assert client.post("/hub/chat/approvals/a1", json={"approve": True}).status_code == 200
    assert got == {"a1": True}
    assert client.post("/hub/chat/approvals/zz", json={"approve": True}).status_code == 409
    monkeypatch.setattr(hub.openai_api, "is_tailnet", lambda r: True)
    r = client.post("/hub/chat/approvals/a1", json={"approve": True}, headers={"X-Forwarded-For": "100.64.0.2"})
    assert r.status_code == 403   # 中継経由 (スマホ) からは承認できない


def test_categories_tells_whether_commands_are_usable(client):
    assert client.get("/hub/categories").json()["can_commands"] is True


def test_chat_keepalive_is_an_sse_comment_not_data(client, monkeypatch):
    seen = []
    agent_cfg(monkeypatch, seen)

    async def run(cfg, key, msgs, **kw):
        yield {"keepalive": True}
        yield {"content": "ok"}
        yield {"done": True, "meta": {}}
    monkeypatch.setattr(hub.chat_agent, "run", run)
    text = client.post("/hub/chat", json=BODY).text
    assert ": keepalive" in text and "data: " + '{"keepalive' not in text
    assert all(ln.startswith(("data: ", ":")) for ln in text.split("\n\n") if ln)
