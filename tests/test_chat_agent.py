import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import chat_agent
import llm
import tools
from orchestrator import _web_research   # conftest が差し替える前の本物


def collect(agen):
    async def go():
        return [ev async for ev in agen]
    return asyncio.run(go())


@pytest.fixture
def workspace(monkeypatch, tmp_path):
    monkeypatch.setattr(tools, "WORKSPACE", str(tmp_path))
    return tmp_path


def fake_chat(replies):
    """replies を順に返す llm.chat の差し替え。渡された tools を calls に記録する。"""
    calls = []

    async def chat(cfg, key, messages, tools=None, on_delta=None, **kw):
        calls.append(tools)
        msg = dict(replies[len(calls) - 1])
        if msg.get("content"):
            on_delta("content", msg["content"])
        return {"role": "assistant", "_usage": 5, "_done_reason": "stop", **msg}
    return chat, calls


def call(name, **args):
    return {"tool_calls": [{"function": {"name": name, "arguments": args}}], "content": ""}


def test_write_file_creates_file_and_reports_link(monkeypatch, workspace):
    chat, _ = fake_chat([call("write_file", path="a/index.html", content="<p>hi</p>"), {"content": "作りました"}])
    monkeypatch.setattr(llm, "chat", chat)
    msgs = [{"role": "user", "content": "HTML作って"}]
    evs = collect(chat_agent.run({}, "m", msgs, subdir="chat_t1"))
    assert (workspace / "chat_t1" / "a" / "index.html").read_text(encoding="utf-8") == "<p>hi</p>"
    assert {"file": {"path": "a/index.html", "url": "/projects/chat_t1/a/index.html"}} in evs
    assert evs[-1] == {"done": True, "meta": {"eval_count": 10}}
    assert msgs[0]["role"] == "system" and "write_file" in msgs[0]["content"]
    assert [m["role"] for m in msgs[1:]] == ["user", "assistant", "tool", "assistant"]


def test_write_outside_workdir_is_refused(monkeypatch, workspace):
    chat, _ = fake_chat([call("write_file", path="../../evil.txt", content="x"), {"content": "ok"}])
    monkeypatch.setattr(llm, "chat", chat)
    evs = collect(chat_agent.run({}, "m", [{"role": "user", "content": "q"}], subdir="chat_t2"))
    result = next(e["tool_result"] for e in evs if "tool_result" in e)
    assert result["ok"] is False
    assert not any("file" in e for e in evs)
    assert not (workspace.parent / "evil.txt").exists()


def test_last_step_gets_no_tools(monkeypatch, workspace):
    chat, calls = fake_chat([call("list_dir"), {"content": "まとめ"}])
    monkeypatch.setattr(llm, "chat", chat)
    collect(chat_agent.run({}, "m", [{"role": "user", "content": "q"}], subdir="chat_t3", opts={"max_steps": 2}))
    assert calls[0] and calls[1] is None


@pytest.mark.parametrize("url", ["http://127.0.0.1:8765/", "http://localhost/", "http://192.168.1.1/",
                                 "http://[::1]/", "file:///c:/x", "ftp://example.com/"])
def test_fetch_url_refuses_non_public(url):
    assert asyncio.run(chat_agent.fetch_url(url)).startswith("[拒否]")


def test_shrink_keeps_latest_tool_result():
    msgs = [{"role": "tool", "content": "a" * 40000}, {"role": "tool", "content": "b" * 5000}]
    chat_agent._shrink(msgs)
    assert len(msgs[0]["content"]) < 400 and len(msgs[1]["content"]) == 5000


# ---- 文章回答の前段の Web 調査 (orchestrator._web_research) ----
def research(monkeypatch, replies, cfg=None):
    from events import EventBus
    chat, calls = fake_chat(replies)
    monkeypatch.setattr(llm, "chat", lambda *a, on_delta=None, **kw: chat(*a, on_delta=lambda *_: None, **kw))
    monkeypatch.setattr(chat_agent, "web_search", lambda query, max_results=6: f"1. 結果\nhttps://example.com/{query}")
    bus = EventBus()
    root = bus.create_node("task", "t", "")
    out = asyncio.run(_web_research(bus, root, cfg or {"models": {}}, "m", "今日のニュースは？"))
    return out, calls, [n.kind for n in bus.nodes.values()]


def test_research_appends_results(monkeypatch):
    out, calls, kinds = research(monkeypatch, [call("web_search", query="news"), {"content": "不要"}])
    assert out.startswith("今日のニュースは？") and "https://example.com/news" in out
    assert calls[0] == chat_agent.WEB_SCHEMA and "research" in kinds


def test_research_skips_when_not_needed(monkeypatch):
    out, calls, kinds = research(monkeypatch, [{"content": "不要"}])
    assert out == "今日のニュースは？" and len(calls) == 1 and "research" not in kinds


def test_research_ignores_unknown_tool_and_can_be_disabled(monkeypatch):
    out, _, _ = research(monkeypatch, [call("write_file", path="a", content="b"), {"content": "不要"}])
    assert out == "今日のニュースは？"
    out, calls, _ = research(monkeypatch, [], cfg={"models": {}, "web_research": False})
    assert out == "今日のニュースは？" and calls == []


def test_research_gets_history_and_survives_errors(monkeypatch):
    seen = []

    async def chat(cfg, key, messages, **kw):
        seen.append([m["role"] for m in messages])
        raise RuntimeError("boom")
    monkeypatch.setattr(llm, "chat", chat)
    from events import EventBus
    bus = EventBus()
    hist = [{"role": "user", "content": "A社について"}, {"role": "assistant", "content": "A社は…"}]
    out = asyncio.run(_web_research(bus, bus.create_node("task", "t", ""), {"models": {}}, "m", "株価は？", history=hist))
    assert out == "株価は？" and seen == [["system", "user", "assistant", "user"]]


# ---- run_command (承認つき) ----
def run_commands(monkeypatch, replies, answer, **kw):
    """answer が True/False なら承認要求にそう答え、None なら答えずに待たせる。"""
    chat, calls = fake_chat(replies)
    monkeypatch.setattr(llm, "chat", chat)

    async def go():
        evs = []
        async for ev in chat_agent.run({}, "m", [{"role": "user", "content": "q"}], subdir="chat_c1",
                                       commands=True, **kw):
            evs.append(ev)
            if "approval" in ev and answer is not None:
                assert chat_agent.resolve_approval(ev["approval"]["id"], answer)
        return evs
    return asyncio.run(go()), calls


def tool_names(tools_):
    return {t["function"]["name"] for t in tools_}


def test_run_command_only_offered_when_enabled(monkeypatch, workspace):
    assert "run_command" not in tool_names(chat_agent.schema())
    assert "run_command" in tool_names(chat_agent.schema(commands=True))
    chat, calls = fake_chat([call("run_command", command="echo hi"), {"content": "ok"}])
    monkeypatch.setattr(llm, "chat", chat)
    evs = collect(chat_agent.run({}, "m", [{"role": "user", "content": "q"}], subdir="chat_c0"))
    assert "run_command" not in tool_names(calls[0])
    assert not any("approval" in e for e in evs)   # 呼ばれても実行せず、承認も求めない
    assert next(e["tool_result"] for e in evs if "tool_result" in e)["summary"].startswith("[不正ツール]")


def test_run_command_runs_after_approval(monkeypatch, workspace):
    evs, calls = run_commands(monkeypatch, [call("run_command", command="echo hello-chat"), {"content": "ok"}], True)
    ap = next(e["approval"] for e in evs if "approval" in e)
    assert ap["command"] == "echo hello-chat" and ap["working_dir"] == "."
    res = next(e["tool_result"] for e in evs if "tool_result" in e)
    assert res["ok"] and "exit=0" in res["summary"]
    assert (workspace / "chat_c1").is_dir()   # 作業フォルダの中で走った


def test_run_command_denied_does_not_run(monkeypatch, workspace):
    evs, _ = run_commands(monkeypatch, [call("run_command", command="echo x > made.txt"), {"content": "ok"}], False)
    res = next(e["tool_result"] for e in evs if "tool_result" in e)
    assert res["ok"] is False and res["summary"] == "[拒否] ユーザーが実行を許可しませんでした"
    assert not (workspace / "chat_c1" / "made.txt").exists()
    assert not chat_agent._approvals   # 待ちを残さない


def test_run_command_approval_timeout_is_denied(monkeypatch, workspace):
    monkeypatch.setattr(chat_agent, "APPROVAL_TIMEOUT", 0.05)
    evs, _ = run_commands(monkeypatch, [call("run_command", command="echo x > made.txt"), {"content": "ok"}], None)
    res = next(e["tool_result"] for e in evs if "tool_result" in e)
    assert res["ok"] is False and "承認されなかった" in res["summary"]
    assert not (workspace / "chat_c1" / "made.txt").exists()
    assert chat_agent.resolve_approval("nope", True) is False


@pytest.mark.parametrize("args", [
    {"command": "echo hi", "working_dir": "../.."},          # 作業フォルダの外
    {"command": "echo hi", "working_dir": "C:/Windows"},      # 絶対パス
    {"command": r"type ..\..\secret.txt"},               # コマンド側の .. 参照
    {"command": "rm -rf sub"},                                # denylist
    {"command": ""},
])
def test_run_command_refused_before_asking(monkeypatch, workspace, args):
    evs, _ = run_commands(monkeypatch, [call("run_command", **args), {"content": "ok"}], True)
    res = next(e["tool_result"] for e in evs if "tool_result" in e)
    assert not any("approval" in e for e in evs)
    assert res["ok"] is False
