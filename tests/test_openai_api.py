"""OpenAI互換API (2026-10-29): messages変換・回答抽出・認証・設定の単体テスト。

HTTP層の統合は start_run / manager を伴うため、ここでは純粋関数のみ検証する
(実サーバでの疎通は実機デプロイ時に curl で確認済み)。
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import openai_api


def test_single_user_message_passes_through():
    msgs = [{"role": "user", "content": "  分数の割り算を説明して  "}]
    assert openai_api.messages_to_task(msgs) == "分数の割り算を説明して"


def test_history_is_folded_with_last_user_as_task():
    msgs = [
        {"role": "system", "content": "短く答えて"},
        {"role": "user", "content": "フランスの首都は?"},
        {"role": "assistant", "content": "パリです"},
        {"role": "user", "content": "イタリアは?"},
    ]
    task = openai_api.messages_to_task(msgs)
    assert "短く答えて" in task
    assert "User: フランスの首都は?" in task
    assert "Assistant: パリです" in task
    assert task.rstrip().endswith("イタリアは?")


def test_multipart_content_joined():
    msgs = [{"role": "user", "content": [
        {"type": "text", "text": "前半"},
        {"type": "image_url", "image_url": {"url": "http://x/y.png"}},
        {"type": "text", "text": "後半"},
    ]}]
    assert openai_api.messages_to_task(msgs) == "前半\n後半"


def test_empty_messages():
    assert openai_api.messages_to_task([]) == ""
    assert openai_api.messages_to_task([{"role": "user", "content": "  "}]) == ""


def test_final_answer_prefers_answer_node():
    snap = {"nodes": [
        {"kind": "aggregator", "output": "統合の下書き", "tokens": 10},
        {"kind": "answer", "output": "最終回答です", "tokens": 5},
        {"kind": "task", "output": "", "tokens": 0},
    ]}
    assert openai_api.final_answer(snap) == "最終回答です"
    assert openai_api.total_tokens(snap) == 15


def test_final_answer_fallbacks():
    assert openai_api.final_answer({"nodes": [
        {"kind": "aggregator", "output": "統合のみ", "tokens": 1}]}) == "統合のみ"
    assert openai_api.final_answer({"nodes": []}) == ""


def test_auth_only_when_key_configured(monkeypatch):
    monkeypatch.setenv("AAL_API_KEY", "")
    monkeypatch.setattr(openai_api, "_settings", lambda: {})
    # キー未設定なら素通り (例外を出さない)
    openai_api._check_auth(_FakeRequest({}))
    monkeypatch.setenv("AAL_API_KEY", "secret123")
    openai_api._check_auth(_FakeRequest({"authorization": "Bearer secret123"}))
    try:
        openai_api._check_auth(_FakeRequest({"authorization": "Bearer wrong"}))
    except Exception as e:
        assert getattr(e, "status_code", None) == 401
    else:
        raise AssertionError("wrong key must be rejected")


def test_bind_host_default_and_env(monkeypatch):
    monkeypatch.delenv("AAL_HOST", raising=False)
    monkeypatch.setattr(openai_api, "_settings", lambda: {})
    assert openai_api.bind_host() == "127.0.0.1"
    monkeypatch.setenv("AAL_HOST", "0.0.0.0")
    assert openai_api.bind_host() == "0.0.0.0"


class _FakeRequest:
    cookies = {}
    client = None

    def __init__(self, headers):
        self.headers = headers


class _FakeClient:
    def __init__(self, host):
        self.host = host


def test_generate_api_key_saves_and_keeps_other_settings(monkeypatch, tmp_path):
    f = tmp_path / "api_settings.json"
    f.write_text('{"host": "0.0.0.0", "api_key": "old"}', encoding="utf-8")
    monkeypatch.setattr(openai_api, "SETTINGS_FILE", f)
    monkeypatch.delenv("AAL_API_KEY", raising=False)
    key = openai_api.generate_api_key()
    assert len(key) >= 40 and key != "old"
    assert openai_api.api_key() == key
    assert openai_api.bind_host() == "0.0.0.0"
    assert openai_api.key_source() == "file"
    assert openai_api.generate_api_key() != key


def test_model_key_issue_reissue_revoke(monkeypatch, tmp_path):
    f = tmp_path / "api_settings.json"
    f.write_text('{"host": "0.0.0.0", "api_key": "common"}', encoding="utf-8")
    monkeypatch.setattr(openai_api, "SETTINGS_FILE", f)
    monkeypatch.delenv("AAL_API_KEY", raising=False)
    k1 = openai_api.generate_api_key("coder")
    assert openai_api.model_keys() == {"coder": k1}
    assert openai_api.api_key() == "common" and openai_api.bind_host() == "0.0.0.0"
    k2 = openai_api.generate_api_key("coder")
    assert k2 != k1 and openai_api.model_keys() == {"coder": k2}
    assert openai_api.revoke_model_key("coder") is True
    assert openai_api.revoke_model_key("coder") is False
    assert openai_api.model_keys() == {} and openai_api.api_key() == "common"


def test_auth_returns_bound_model(monkeypatch):
    monkeypatch.delenv("AAL_API_KEY", raising=False)
    monkeypatch.setattr(openai_api, "_settings",
                        lambda: {"api_key": "common", "model_keys": {"coder": "ck", "smart": "sk"}})
    assert openai_api._check_auth(_FakeRequest({"authorization": "Bearer common"})) is None
    assert openai_api._check_auth(_FakeRequest({"authorization": "Bearer ck"})) == "coder"
    assert openai_api._check_auth(_FakeRequest({"authorization": "Bearer sk"})) == "smart"
    for headers in ({}, {"authorization": "Bearer nope"}):
        try:
            openai_api._check_auth(_FakeRequest(headers))
        except Exception as e:
            assert getattr(e, "status_code", None) == 401
        else:
            raise AssertionError("unknown key must be rejected")


def test_model_key_alone_makes_auth_required(monkeypatch):
    monkeypatch.delenv("AAL_API_KEY", raising=False)
    monkeypatch.setattr(openai_api, "_settings", lambda: {"model_keys": {"coder": "ck"}})
    try:
        openai_api._check_auth(_FakeRequest({}))
    except Exception as e:
        assert getattr(e, "status_code", None) == 401
    else:
        raise AssertionError("model key must make auth mandatory")


def test_key_endpoints_reject_bad_json_and_last_key_revoke(monkeypatch, tmp_path):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    f = tmp_path / "api_settings.json"
    f.write_text('{"model_keys": {"coder": "ck"}}', encoding="utf-8")
    monkeypatch.setattr(openai_api, "SETTINGS_FILE", f)
    monkeypatch.delenv("AAL_API_KEY", raising=False)
    monkeypatch.setattr(openai_api, "LOOPBACK", openai_api.LOOPBACK + ("testclient",))
    app = FastAPI()
    openai_api.register(app)
    c = TestClient(app)
    assert c.post("/api-key/generate", content="{broken").status_code == 400
    assert openai_api.api_key() == ""  # 壊れた JSON で共通キーを作らない
    assert c.post("/api-key/revoke", json={"model": "coder"}).status_code == 409
    assert openai_api.model_keys() == {"coder": "ck"}
    openai_api.generate_api_key("auto")
    assert c.post("/api-key/revoke", json={"model": "coder"}).status_code == 200
    assert c.post("/api-key/revoke", json={"model": "coder"}).status_code == 404


def test_key_source(monkeypatch):
    monkeypatch.setattr(openai_api, "_settings", lambda: {})
    monkeypatch.delenv("AAL_API_KEY", raising=False)
    assert openai_api.key_source() == "none"
    monkeypatch.setenv("AAL_API_KEY", "x")
    assert openai_api.key_source() == "env"


def test_key_issuance_only_from_loopback():
    for host in ("127.0.0.1", "::1"):
        req = _FakeRequest({})
        req.client = _FakeClient(host)
        openai_api._require_local(req)
    for client in (_FakeClient("192.168.1.20"), None):
        req = _FakeRequest({})
        req.client = client
        try:
            openai_api._require_local(req)
        except Exception as e:
            assert getattr(e, "status_code", None) == 403
        else:
            raise AssertionError("non-loopback must be rejected")


def test_key_issuance_rejects_cross_site_origin():
    for origin in ("http://127.0.0.1:8765", "http://localhost:5173"):
        req = _FakeRequest({"origin": origin})
        req.client = _FakeClient("127.0.0.1")
        openai_api._require_local(req)
    req = _FakeRequest({"origin": "https://evil.example"})
    req.client = _FakeClient("127.0.0.1")
    try:
        openai_api._require_local(req)
    except Exception as e:
        assert getattr(e, "status_code", None) == 403
    else:
        raise AssertionError("cross-site origin must be rejected")


def _remote_app(monkeypatch, key="k"):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    monkeypatch.setattr(openai_api, "api_key", lambda: key)
    monkeypatch.setattr(openai_api, "model_keys", lambda: {"m": "mk"})
    monkeypatch.setattr(openai_api, "LOGIN_FAIL_DELAY_S", 0)
    app = FastAPI()
    app.middleware("http")(openai_api.remote_guard)
    openai_api.register(app)
    app.get("/runs")(lambda: {"ok": True})
    app.get("/")(lambda: {"ui": True})
    return app, lambda host, base="http://pc.tail.ts.net:8765": TestClient(app, base_url=base if host != "127.0.0.1" else "http://127.0.0.1:8765",
                                        client=(host, 50000))


def test_remote_guard_requires_login_or_common_key(monkeypatch):
    app, client = _remote_app(monkeypatch)
    remote = client("192.168.1.9")
    assert remote.get("/runs").status_code == 401
    assert "共通キー" in remote.get("/").text and remote.get("/").status_code == 401   # 画面の入口はログイン画面
    assert remote.get("/runs", headers={"Authorization": "Bearer k"}).status_code == 200
    assert remote.get("/runs", headers={"Authorization": "Bearer mk"}).status_code == 401   # モデル専用キーは /v1 だけ
    assert remote.get("/runs", headers={"Authorization": "Bearer k", "Origin": "https://evil.example"}).status_code == 403
    local = client("127.0.0.1")
    assert local.get("/runs", headers={"Host": "127.0.0.1:8765"}).status_code == 200   # このPCからは素通し
    assert local.get("/runs", headers={"Host": "evil.example"}).status_code == 403     # DNS リバインディング
    assert local.get("/runs", headers={"Host": "127.0.0.1:8765", "Origin": "https://evil.example"}).status_code == 403


def test_remote_guard_blocks_everything_without_common_key(monkeypatch):
    app, client = _remote_app(monkeypatch, key="")
    assert client("192.168.1.9").get("/runs").status_code == 403
    monkeypatch.setattr(openai_api, "model_keys", lambda: {})
    assert client("192.168.1.9").get("/v1/models").status_code == 403   # キーが1つも無ければ /v1 も外へ出さない
    assert client("192.168.1.9").post("/login", json={"secret": ""}).status_code == 401


def test_tailnet_device_needs_no_login(monkeypatch):
    app, client = _remote_app(monkeypatch, key="")
    tail = client("100.64.0.9")
    assert tail.get("/runs").status_code == 200 and tail.get("/").json() == {"ui": True}   # キーが無くても通す
    assert tail.get("/runs", headers={"Origin": "https://evil.example"}).status_code == 403
    assert tail.post("/api-key/generate").status_code == 403   # キーの発行はこのPCだけ
    assert client("100.64.0.9", "http://100.64.0.1:8765").get("/runs").status_code == 200
    assert client("100.64.0.9", "http://evil.example").get("/runs").status_code == 403   # このPCのブラウザからの偽装
    bound = _FakeRequest({"authorization": "Bearer mk"})
    bound.client = _FakeClient("100.64.0.9")
    assert openai_api._check_auth(bound) == "m"   # キーを付けて来たら固定を効かせる
    monkeypatch.setattr(openai_api, "trust_tailnet", lambda: False)
    assert tail.get("/runs").status_code == 403


def test_login_with_common_key_sets_session(monkeypatch):
    app, client = _remote_app(monkeypatch)
    remote = client("192.168.1.9")
    assert remote.post("/login", json={"secret": "000000"}).status_code == 401
    assert remote.post("/login", json={"secret": "k"}).status_code == 200
    assert remote.get("/runs").status_code == 200   # Cookie でログイン済み
    assert remote.post("/login/code").status_code in (404, 405)   # 接続コードは廃止
    monkeypatch.setattr(openai_api, "api_key", lambda: "k2")   # キーの再発行でログアウト
    assert remote.get("/runs").status_code == 401


