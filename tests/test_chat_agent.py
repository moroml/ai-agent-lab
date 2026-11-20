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


# ---- 画像・動画 (LGS は差し替え) ----
import chat_media   # noqa: E402


class FakeStudio:
    """LGS の差し替え。投入と upload を記録し、ジョブは1回目に running、2回目に done を返す。"""

    def __init__(self, monkeypatch, status=("running", "done"), content_type="image/png"):
        self.submitted, self.uploads, self.polls = [], [], 0
        self.status, self.content_type = status, content_type

        class Hub:
            _cat = staticmethod(lambda cfg, name: (cfg.get("categories") or {}).get(name) or {})
            _music_running = staticmethod(lambda: 0)

            async def free_vram_for_generation(s, cfg, cat, running):
                return []

            async def _submit_studio(s2, path, body, timeout):
                self.submitted.append((path, body))
                return {"job_id": "j1"}
        hub = Hub()
        hub.free_vram_for_generation = Hub.free_vram_for_generation.__get__(hub)
        hub._submit_studio = Hub._submit_studio.__get__(hub)
        monkeypatch.setattr(chat_media, "_hub", lambda: hub)
        monkeypatch.setattr(chat_media, "POLL_SEC", 0)
        monkeypatch.setattr(chat_media, "_lgs", self.lgs)

    async def lgs(self, method, path, *, files=None, timeout=60.0):
        class R:
            pass
        r = R()
        if path.startswith("/api/jobs/"):
            st = self.status[min(self.polls, len(self.status) - 1)]
            self.polls += 1
            r.json = lambda: {"status": st, "generation_id": 7, "error": "boom"}
        elif path == "/api/images/upload":
            self.uploads.append(files["file"][0])
            r.json = lambda: {"id": 5}
        else:
            r.headers, r.content = {"content-type": self.content_type}, b"BYTES"
        return r


def media_run(monkeypatch, replies):
    chat, calls = fake_chat(replies)
    monkeypatch.setattr(llm, "chat", chat)
    return collect(chat_agent.run({"categories": {"image": {"model": "m1", "width": 512, "height": 768}}}, "m",
                                  [{"role": "user", "content": "q"}], subdir="chat_m1")), calls


def test_generate_image_saves_into_workdir_and_reports_file(monkeypatch, workspace):
    st = FakeStudio(monkeypatch)
    evs, calls = media_run(monkeypatch, [call("generate_image", prompt="a cat", width=1000), {"content": "できた"}])
    assert "generate_image" in tool_names(calls[0])
    assert st.submitted == [("/api/generate", {"model": "m1", "prompt_en": "a cat", "width": 1000, "height": 768})]
    assert (workspace / "chat_m1" / "image_7.png").read_bytes() == b"BYTES"
    assert {"file": {"path": "image_7.png", "url": "/projects/chat_m1/image_7.png"}} in evs
    assert next(e["tool_result"] for e in evs if "tool_result" in e)["ok"]


def test_edit_image_uploads_workdir_image(monkeypatch, workspace):
    st = FakeStudio(monkeypatch, status=("done",))
    (workspace / "chat_m1").mkdir()
    (workspace / "chat_m1" / "src.png").write_bytes(b"png")
    evs, _ = media_run(monkeypatch, [call("edit_image", path="src.png", instruction="make it red"), {"content": "ok"}])
    assert st.uploads == ["src.png"]
    assert st.submitted == [("/api/generate-edit", {"source_generation_id": 5, "prompt_en": "make it red"})]
    assert any("file" in e for e in evs)


@pytest.mark.parametrize("path", ["missing.png", "../../x.png", "notes.txt"])
def test_edit_image_refuses_bad_source(monkeypatch, workspace, path):
    st = FakeStudio(monkeypatch)
    evs, _ = media_run(monkeypatch, [call("edit_image", path=path, instruction="x"), {"content": "ok"}])
    assert next(e["tool_result"] for e in evs if "tool_result" in e)["ok"] is False
    assert not st.submitted and not any("file" in e for e in evs)


def test_generate_video_from_image_uses_4n_plus_1_frames(monkeypatch, workspace):
    st = FakeStudio(monkeypatch, status=("done",), content_type="video/mp4")
    (workspace / "chat_m1").mkdir()
    (workspace / "chat_m1" / "a.jpg").write_bytes(b"jpg")
    evs, _ = media_run(monkeypatch, [call("generate_video", prompt="walk", image_path="a.jpg", seconds=3), {"content": "ok"}])
    path, body = st.submitted[0]
    assert path == "/api/generate-video" and body["frames"] == 73 and body["mode"] == "i2v" and body["source_generation_id"] == 5
    assert (workspace / "chat_m1" / "video_7.mp4").exists()
    assert any(e.get("file", {}).get("path") == "video_7.mp4" for e in evs)


def test_studio_down_is_an_error_string_not_a_crash(monkeypatch, workspace):
    FakeStudio(monkeypatch)

    async def down(*a, **k):
        raise chat_media.MediaError("Local Gen Studio に接続できません")
    monkeypatch.setattr(chat_media, "_lgs", down)
    evs, _ = media_run(monkeypatch, [call("generate_image", prompt="x"), {"content": "ok"}])
    res = next(e["tool_result"] for e in evs if "tool_result" in e)
    assert res["ok"] is False and "接続できません" in res["summary"]
    assert evs[-1]["done"]


def test_failed_job_is_reported(monkeypatch, workspace):
    FakeStudio(monkeypatch, status=("error",))
    evs, _ = media_run(monkeypatch, [call("generate_image", prompt="x"), {"content": "ok"}])
    assert "生成に失敗しました: boom" in next(e["tool_result"] for e in evs if "tool_result" in e)["summary"]


def test_generate_music_moves_mp3_into_workdir(monkeypatch, workspace, tmp_path):
    src = tmp_path / "ab12cd34ef56.mp3"
    src.write_bytes(b"MP3")
    seen = {}

    class Music:
        MusicError = type("MusicError", (Exception,), {})

        @staticmethod
        async def generate_music(cfg, key, prompt, **kw):
            seen.update(key=key, prompt=prompt, **kw)
            return {"path": str(src), "file": src.name}

    class Switch:
        SwitchError = type("SwitchError", (Exception,), {})
        music_busy = asyncio.Lock()

        @staticmethod
        async def for_music(cfg):
            return []

    class Hub:
        music, gpu_switch = Music, Switch
        _cat = staticmethod(lambda cfg, name: (cfg.get("categories") or {}).get(name) or {})
        _music_running = staticmethod(lambda: 0)

        @staticmethod
        async def free_vram_for_generation(cfg, cat, running):
            seen["unload"] = cat.get("unload_llm")
            return []
    monkeypatch.setattr(chat_media, "_hub", lambda: Hub)
    chat, calls = fake_chat([call("generate_music", prompt="lofi", duration=20, instrumental=True), {"content": "ok"}])
    monkeypatch.setattr(llm, "chat", chat)
    cfg = {"categories": {"music": {"model": "mus", "duration": 30, "unload_llm": True}}}
    evs = collect(chat_agent.run(cfg, "m", [{"role": "user", "content": "q"}], subdir="chat_m2"))
    assert seen == {"key": "mus", "prompt": "lofi", "lyrics": None, "duration": 20.0, "instrumental": True, "unload": True}
    assert (workspace / "chat_m2" / "music_ab12cd34.mp3").read_bytes() == b"MP3" and not src.exists()
    assert any(e.get("file", {}).get("url") == "/projects/chat_m2/music_ab12cd34.mp3" for e in evs)


def test_generate_music_service_error_is_a_string(monkeypatch, workspace):
    class Music:
        MusicError = type("MusicError", (Exception,), {})

        @staticmethod
        async def generate_music(cfg, key, prompt, **kw):
            raise Music.MusicError("音楽サービスに接続できません")

    class Switch:
        SwitchError = type("SwitchError", (Exception,), {})
        music_busy = asyncio.Lock()

        @staticmethod
        async def for_music(cfg):
            return []

    class Hub:
        music, gpu_switch = Music, Switch
        _cat = staticmethod(lambda cfg, name: {})
        _music_running = staticmethod(lambda: 0)

        @staticmethod
        async def free_vram_for_generation(cfg, cat, running):
            return []
    monkeypatch.setattr(chat_media, "_hub", lambda: Hub)
    chat, _ = fake_chat([call("generate_music", prompt="x"), {"content": "ok"}])
    monkeypatch.setattr(llm, "chat", chat)
    evs = collect(chat_agent.run({}, "m", [{"role": "user", "content": "q"}], subdir="chat_m3"))
    res = next(e["tool_result"] for e in evs if "tool_result" in e)
    assert res["ok"] is False and "接続できません" in res["summary"]


# ---- make_3d (Blender は差し替え。承認が要る) ----
class FakeBlender:
    """create_subprocess_exec の差し替え。成功なら引数の glb / png を作り、失敗なら Traceback を返す。"""

    def __init__(self, monkeypatch, fail=False):
        self.spawned, self.fail = [], fail
        monkeypatch.setattr(chat_media, "BLENDER", __file__)
        monkeypatch.setattr(chat_media.asyncio, "create_subprocess_exec", self.spawn)

    async def spawn(self, *argv, **kw):
        self.spawned.append((argv, kw))
        fake = self

        class Proc:
            returncode = 0

            async def communicate(self):
                if fake.fail:
                    self.returncode = 1
                    return b"INFO lots of noise\nTraceback (most recent call last):\n  File x\nNameError: foo", None
                glb, png = argv[-2:]
                open(glb, "wb").write(b"glTF")
                open(png, "wb").write(b"PNG")
                return b"Blender quit", None
        return Proc()


def call_3d(args):   # call() は name= を取れないので直接組む
    return {"tool_calls": [{"function": {"name": "make_3d", "arguments": args}}], "content": ""}


def run_3d(monkeypatch, answer, **args):
    return run_commands(monkeypatch, [call_3d(args), {"content": "ok"}], answer)


def test_make_3d_needs_commands_and_is_hidden_otherwise(monkeypatch, workspace):
    assert "make_3d" not in tool_names(chat_agent.schema())
    assert "make_3d" in tool_names(chat_agent.schema(commands=True))
    blender = FakeBlender(monkeypatch)
    chat, _ = fake_chat([call_3d({"name": "a", "script": "import bpy"}), {"content": "ok"}])
    monkeypatch.setattr(llm, "chat", chat)
    evs = collect(chat_agent.run({}, "m", [{"role": "user", "content": "q"}], subdir="chat_d0"))
    assert next(e["tool_result"] for e in evs if "tool_result" in e)["summary"].startswith("[不正ツール]")
    assert not blender.spawned


def test_make_3d_runs_after_approval_and_returns_previews(monkeypatch, workspace):
    blender = FakeBlender(monkeypatch)
    evs, _ = run_3d(monkeypatch, True, name="box", script="import bpy\nbpy.ops.mesh.primitive_cube_add()")
    ap = next(e["approval"] for e in evs if "approval" in e)
    assert "primitive_cube_add" in ap["command"]   # 承認画面にスクリプトが出る
    work = workspace / "chat_c1"
    py = (work / "box.py").read_text(encoding="utf-8")
    assert "primitive_cube_add" in py and "export_scene.gltf" in py
    argv, kw = blender.spawned[0]
    assert "-b" in argv and kw["cwd"] == str(work)
    assert [e["file"]["path"] for e in evs if "file" in e] == ["box.png", "box.glb"]


def test_make_3d_denied_does_not_start_blender(monkeypatch, workspace):
    blender = FakeBlender(monkeypatch)
    evs, _ = run_3d(monkeypatch, False, name="box", script="import bpy")
    assert next(e["tool_result"] for e in evs if "tool_result" in e)["ok"] is False
    assert not blender.spawned and not any("file" in e for e in evs)


def test_make_3d_script_error_goes_back_to_the_model(monkeypatch, workspace):
    FakeBlender(monkeypatch, fail=True)
    evs, _ = run_3d(monkeypatch, True, name="box", script="foo()")
    res = next(e["tool_result"] for e in evs if "tool_result" in e)
    assert res["ok"] is False and "NameError: foo" in res["summary"] and "noise" not in res["summary"]
    assert not any("file" in e for e in evs)


@pytest.mark.parametrize("args", [{"name": "../x", "script": "import bpy"}, {"name": "ok", "script": " "},
                                  {"name": "ok", "script": "x" * 60000}])
def test_make_3d_bad_args_are_refused_before_asking(monkeypatch, workspace, args):
    blender = FakeBlender(monkeypatch)
    evs, _ = run_3d(monkeypatch, True, **args)
    assert not any("approval" in e for e in evs) and not blender.spawned
    assert next(e["tool_result"] for e in evs if "tool_result" in e)["ok"] is False


def test_run_command_does_not_see_secret_env(monkeypatch, workspace):
    monkeypatch.setenv("MY_API_KEY", "s3cret")
    monkeypatch.setenv("PLAIN_VALUE", "visible")
    cmd = "python -c \"import os;print(os.environ.get('MY_API_KEY'), os.environ.get('PLAIN_VALUE'))\""
    evs, _ = run_commands(monkeypatch, [call("run_command", command=cmd), {"content": "ok"}], True)
    out = next(e["tool_result"] for e in evs if "tool_result" in e)["summary"]
    assert "None visible" in out and "s3cret" not in out
