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
        monkeypatch.setattr(chat_media, "_fetch_file", self.fetch)

    async def fetch(self, gid, tmp):
        with open(tmp, "wb") as f:
            f.write(b"BYTES")
        return self.content_type

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
TRACE = b"INFO lots of noise" + chr(10).encode() + b"Traceback (most recent call last):" + chr(10).encode() + b"  File x" + chr(10).encode() + b"NameError: foo"


class FakeBlender:
    """create_subprocess_exec の差し替え。成功なら引数の glb / png を作り、失敗なら Traceback を返す。"""

    def __init__(self, monkeypatch, fail=False):
        self.spawned, self.fail, self.noise = [], fail, 0
        monkeypatch.setattr(chat_media, "BLENDER", __file__)
        monkeypatch.setattr(chat_media.asyncio, "create_subprocess_exec", self.spawn)

    async def spawn(self, *argv, **kw):
        self.spawned.append((argv, kw))
        fake = self

        class Stream:
            """read() で少しずつ返す。fake.noise があれば先に大量の出力を流す。"""
            def __init__(self):
                self.chunks = [b"n" * 65536] * fake.noise if fake.noise else []
                self.proc = None

            async def read(self, n):
                if self.chunks:
                    return self.chunks.pop()
                if self.proc.done:
                    return b""
                self.proc.done = True
                if fake.fail:
                    self.proc.returncode = 1
                    return TRACE
                glb, png = argv[-2:]
                open(glb, "wb").write(b"glTF")
                open(png, "wb").write(b"PNG")
                return b"Blender quit"

        class Proc:
            returncode = 0
            done = False

            def __init__(self):
                self.stdout = Stream()
                self.stdout.proc = self

            async def wait(self):
                return self.returncode
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
    monkeypatch.setenv("LC_ALL", "visible")
    cmd = "python -c \"import os;print(os.environ.get('MY_API_KEY'), os.environ.get('LC_ALL'))\""
    evs, _ = run_commands(monkeypatch, [call("run_command", command=cmd), {"content": "ok"}], True)
    out = next(e["tool_result"] for e in evs if "tool_result" in e)["summary"]
    assert "None visible" in out and "s3cret" not in out


def test_make_3d_approval_shows_the_whole_script(monkeypatch, workspace):
    FakeBlender(monkeypatch)
    script = "import bpy\n" + "# pad\n" * 5000 + "bpy.ops.mesh.primitive_cube_add()  # LAST"   # 3000字を大きく超える
    evs, _ = run_3d(monkeypatch, True, name="big", script=script)
    shown = next(e["approval"]["command"] for e in evs if "approval" in e)
    assert script in shown and shown.endswith("# LAST")
    assert (workspace / "chat_c1" / "big.py").read_text(encoding="utf-8").count("# pad") == 5000   # 見せたものを実行する


def test_safe_env_is_an_allowlist(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k")
    monkeypatch.setenv("DATABASE_URL", "opaque-connection-string")   # 名前が秘密らしくなくても渡さない
    monkeypatch.setenv("LC_ALL", "C")
    env = chat_media.safe_env()
    assert "ANTHROPIC_API_KEY" not in env and "DATABASE_URL" not in env
    assert "PATH" in {k.upper() for k in env} and env["LC_ALL"] == "C"


def test_wait_timeout_cancels_the_lgs_job(monkeypatch, workspace):
    st = FakeStudio(monkeypatch, status=("running",))
    posted = []
    inner = chat_media._lgs

    async def lgs(method, path, **kw):
        if method == "POST":
            posted.append(path)
            return None
        return await inner(method, path, **kw)
    monkeypatch.setattr(chat_media, "_lgs", lgs)
    monkeypatch.setattr(chat_media, "IMAGE_WAIT", 0.05)
    monkeypatch.setattr(chat_media, "POLL_SEC", 0.01)
    evs, _ = media_run(monkeypatch, [call("generate_image", prompt="x"), {"content": "ok"}])
    res = next(e["tool_result"] for e in evs if "tool_result" in e)
    assert res["ok"] is False and "止めました" in res["summary"]
    assert posted == ["/api/jobs/j1/cancel"]


def test_keepalive_while_waiting_for_approval(monkeypatch, workspace):
    monkeypatch.setattr(chat_agent, "KEEPALIVE_SEC", 0.02)
    chat, _ = fake_chat([call("run_command", command="echo hi"), {"content": "ok"}])
    monkeypatch.setattr(llm, "chat", chat)

    async def go():
        evs = []
        async for ev in chat_agent.run({}, "m", [{"role": "user", "content": "q"}], subdir="chat_k1", commands=True):
            evs.append(ev)
            if "approval" in ev:
                # 人が考えている間 (0.1秒後に答える)。読み手が止まると keepalive が出せないので、答えは別に予約する
                asyncio.get_running_loop().call_later(0.1, chat_agent.resolve_approval, ev["approval"]["id"], True)
        return evs
    evs = asyncio.run(go())
    assert sum(1 for e in evs if e.get("keepalive")) >= 2
    assert next(e["tool_result"] for e in evs if "tool_result" in e)["ok"]


def test_keepalive_while_generating(monkeypatch, workspace):
    monkeypatch.setattr(chat_agent, "KEEPALIVE_SEC", 0.02)
    FakeStudio(monkeypatch, status=("running",) * 8 + ("done",))
    monkeypatch.setattr(chat_media, "POLL_SEC", 0.01)
    evs, _ = media_run(monkeypatch, [call("generate_image", prompt="x"), {"content": "ok"}])
    assert any(e.get("keepalive") for e in evs) and any("file" in e for e in evs)


def test_fetch_file_streams_to_disk_without_leftovers(monkeypatch, workspace):
    import httpx

    class Hub:
        llm = type("L", (), {"load_config": staticmethod(lambda: {})})
        studio_base = staticmethod(lambda cfg: "http://lgs.test")
        studio_token = staticmethod(lambda cfg: "tok")
    monkeypatch.setattr(chat_media, "_hub", lambda: Hub)
    real = httpx.AsyncClient
    state = {"status": 200}

    def handler(req):
        assert req.headers["authorization"] == "Bearer tok" and req.url.path == "/api/files/9"
        return httpx.Response(state["status"], content=b"x" * 200000, headers={"content-type": "video/webm"})
    monkeypatch.setattr(chat_media.httpx, "AsyncClient", lambda **kw: real(transport=httpx.MockTransport(handler), **kw))
    box = tools.Toolbox(subdir="chat_f1", approve=False)
    assert asyncio.run(chat_media._save(box, 9, "video")) == "video_9.webm"
    work = workspace / "chat_f1"
    assert (work / "video_9.webm").stat().st_size == 200000
    assert [p.name for p in work.iterdir()] == ["video_9.webm"]   # .part を残さない
    state["status"] = 404
    with pytest.raises(chat_media.MediaError):
        asyncio.run(chat_media._save(box, 9, "video"))
    assert [p.name for p in work.iterdir()] == ["video_9.webm"]


def test_blender_output_keeps_only_a_bounded_tail(monkeypatch, workspace):
    blender = FakeBlender(monkeypatch, fail=True)
    blender.noise = 200   # 約13MBの出力。末尾のエラー文だけが結果に残る
    evs, _ = run_3d(monkeypatch, True, name="loud", script="foo()")
    res = next(e["tool_result"] for e in evs if "tool_result" in e)
    assert "NameError: foo" in res["summary"]
    assert len(asyncio.run(chat_media._read_tail(FakeStream(b"x" * 100000), keep=500))) == 500


class FakeStream:
    def __init__(self, data):
        self.data = data

    async def read(self, n):
        chunk, self.data = self.data[:n], self.data[n:]
        return chunk


def test_check_3d_renames_old_bsdf_inputs_before_approval():
    args = {"name": "x", "script": "n.inputs['Transmission'].default_value = 1\n"
                                   'n.inputs["Emission"].default_value = (1, 1, 1, 1)\n'
                                   "n.inputs['Clearcoat Roughness'].default_value = 0\n"
                                   "n.inputs['Base Color'].default_value = (1, 0, 0, 1)\n"
                                   "n.inputs['Emission Strength'].default_value = 2\n"}
    assert chat_media.check_3d(args) is None
    assert args["script"].splitlines() == [
        "n.inputs['Transmission Weight'].default_value = 1",
        'n.inputs["Emission Color"].default_value = (1, 1, 1, 1)',
        "n.inputs['Coat Roughness'].default_value = 0",
        "n.inputs['Base Color'].default_value = (1, 0, 0, 1)",
        "n.inputs['Emission Strength'].default_value = 2"]


# ---- generate_3d (LGS の ComfyUI 上の TRELLIS 2。ComfyUI と Blender は差し替え) ----
class FakeComfy:
    """ComfyUI の差し替え。upload・投入・取り消しを記録し、history は status の順に返す。"""

    def __init__(self, monkeypatch, status=(None, "success"), glb=True, busy=False):
        self.studio = FakeStudio(monkeypatch, status=("done",))
        self.prompts, self.uploads, self.cancels, self.switched, self.polls = [], [], [], 0, 0
        self.status, self.glb = status, glb
        fake = self

        class Switch:
            SwitchError = type("SwitchError", (Exception,), {})
            music_busy = asyncio.Lock()
            settings = staticmethod(lambda cfg: {"comfy_base": "http://comfy.test"})

            @staticmethod
            async def for_studio(cfg):
                fake.switched += 1
                return []
        if busy:
            asyncio.run(Switch.music_busy.acquire())
        chat_media._hub().gpu_switch = Switch
        monkeypatch.setattr(chat_media, "_comfy", self.comfy)
        monkeypatch.setattr(chat_media, "_download", self.download)
        monkeypatch.setattr(chat_media, "POLL_SEC", 0)

    async def comfy(self, cfg, method, path, *, timeout=30.0, **kw):
        class R:
            pass
        r, body = R(), {}
        if path == "/upload/image":
            self.uploads.append(kw["files"]["image"][0])
            body = {"name": kw["files"]["image"][0], "subfolder": "", "type": "input"}
        elif path == "/prompt":
            self.prompts.append(kw["json"]["prompt"])
            body = {"prompt_id": "p1"}
        elif path.startswith("/history/"):
            st = self.status[min(self.polls, len(self.status) - 1)]
            self.polls += 1
            files = [{"filename": "model3d_x_00001_.glb", "subfolder": "agentlab", "type": "output"}] if self.glb else []
            msgs = [["execution_error", {"node_type": "KSampler", "exception_message": "HIP out of memory"}]]
            body = {} if st is None else {"p1": {"status": {"status_str": st, "messages": msgs},
                                                 "outputs": {"322": {"3d": files}}}}
        elif path.endswith("/cancel"):
            self.cancels.append(path)
        r.json = lambda: body
        return r

    async def download(self, who, url, tmp, headers=None, params=None):
        self.downloaded = (url, params)
        with open(tmp, "wb") as f:
            f.write(b"glTF")
        return "model/gltf-binary"


def tool_result(evs):
    return next(e["tool_result"] for e in evs if "tool_result" in e)


def test_generate_3d_is_offered_without_commands():
    assert "generate_3d" in tool_names(chat_agent.schema())


def test_generate_3d_from_image_saves_glb_and_preview(monkeypatch, workspace):
    comfy = FakeComfy(monkeypatch)
    blender = FakeBlender(monkeypatch)
    (workspace / "chat_m1").mkdir()
    (workspace / "chat_m1" / "cup.jpg").write_bytes(b"jpg")
    evs, _ = media_run(monkeypatch, [call("generate_3d", image_path="cup.jpg"), {"content": "ok"}])
    assert tool_result(evs)["ok"], tool_result(evs)
    wf = comfy.prompts[0]
    assert wf["122"]["inputs"]["image"] == comfy.uploads[0] and comfy.uploads[0].endswith(".jpg")
    assert len({wf[k]["inputs"]["seed"] for k in chat_media.TRELLIS_SEEDS}) == 1
    tag = wf["322"]["inputs"]["filename_prefix"].removeprefix("agentlab/model3d_")
    assert comfy.switched == 1 and comfy.polls == 2 and not comfy.studio.submitted
    assert comfy.downloaded == ("http://comfy.test/view",
                                {"filename": "model3d_x_00001_.glb", "subfolder": "agentlab", "type": "output"})
    assert [e["file"]["path"] for e in evs if "file" in e] == [f"model3d_{tag}.png", f"model3d_{tag}.glb"]
    argv, _ = blender.spawned[0]
    assert argv[-2:] == (str(workspace / "chat_m1" / f"model3d_{tag}.glb"), str(workspace / "chat_m1" / f"model3d_{tag}.png"))
    assert sorted(p.name for p in (workspace / "chat_m1").iterdir()) == ["cup.jpg", f"model3d_{tag}.glb", f"model3d_{tag}.png"]


def test_generate_3d_from_prompt_makes_an_object_image_first(monkeypatch, workspace):
    comfy = FakeComfy(monkeypatch)
    monkeypatch.setattr(chat_media, "BLENDER", str(workspace / "no-blender.exe"))   # レンダーできなくても glb は返す
    evs, _ = media_run(monkeypatch, [call("generate_3d", prompt="a red mug"), {"content": "ok"}])
    path, body = comfy.studio.submitted[0]
    assert path == "/api/generate" and body["prompt_en"] == "a red mug" + chat_media.OBJECT_HINT
    assert comfy.uploads[0].endswith(".png")
    files = [e["file"]["path"] for e in evs if "file" in e]
    assert files[0] == "image_7.png" and files[1].endswith(".glb") and len(files) == 2
    assert "確認用の画像は作れませんでした" in tool_result(evs)["summary"]


@pytest.mark.parametrize("args", [{}, {"prompt": " "}, {"image_path": "missing.png"}, {"image_path": "../../x.png"}])
def test_generate_3d_bad_args_submit_nothing(monkeypatch, workspace, args):
    comfy = FakeComfy(monkeypatch)
    evs, _ = media_run(monkeypatch, [call("generate_3d", **args), {"content": "ok"}])
    assert tool_result(evs)["ok"] is False
    assert not comfy.prompts and not comfy.studio.submitted and not any("file" in e for e in evs)


def test_generate_3d_failure_reports_the_node_error(monkeypatch, workspace):
    comfy = FakeComfy(monkeypatch, status=("error",))
    (workspace / "chat_m1").mkdir()
    (workspace / "chat_m1" / "a.png").write_bytes(b"png")
    evs, _ = media_run(monkeypatch, [call("generate_3d", image_path="a.png"), {"content": "ok"}])
    assert "KSampler: HIP out of memory" in tool_result(evs)["summary"]
    assert not comfy.cancels and not any("file" in e for e in evs)


def test_generate_3d_without_glb_output_is_an_error(monkeypatch, workspace):
    FakeComfy(monkeypatch, glb=False)
    (workspace / "chat_m1").mkdir()
    (workspace / "chat_m1" / "a.png").write_bytes(b"png")
    evs, _ = media_run(monkeypatch, [call("generate_3d", image_path="a.png"), {"content": "ok"}])
    assert "glb が出力されませんでした" in tool_result(evs)["summary"]


def test_generate_3d_timeout_cancels_only_its_own_job(monkeypatch, workspace):
    comfy = FakeComfy(monkeypatch, status=(None,))
    monkeypatch.setattr(chat_media, "TRELLIS_WAIT", 0.05)
    monkeypatch.setattr(chat_media, "POLL_SEC", 0.01)
    (workspace / "chat_m1").mkdir()
    (workspace / "chat_m1" / "a.png").write_bytes(b"png")
    evs, _ = media_run(monkeypatch, [call("generate_3d", image_path="a.png"), {"content": "ok"}])
    assert "止めました" in tool_result(evs)["summary"]
    assert comfy.cancels == ["/api/jobs/p1/cancel"]


def test_generate_3d_waits_for_music_to_finish(monkeypatch, workspace):
    comfy = FakeComfy(monkeypatch, busy=True)
    (workspace / "chat_m1").mkdir()
    (workspace / "chat_m1" / "a.png").write_bytes(b"png")
    evs, _ = media_run(monkeypatch, [call("generate_3d", image_path="a.png"), {"content": "ok"}])
    assert "音楽か音声を生成中" in tool_result(evs)["summary"] and not comfy.prompts


def test_trellis_workflow_file_matches_the_node_ids():
    wf = chat_media._load_workflow()
    assert wf[chat_media.TRELLIS_IMAGE_NODE]["class_type"] == "LoadImage"
    assert wf[chat_media.TRELLIS_SAVE_NODE]["class_type"] == "SaveGLB"
    assert all(wf[k]["class_type"] == "KSampler" for k in chat_media.TRELLIS_SEEDS)
    linked = {v[0] for n in wf.values() for v in n["inputs"].values() if isinstance(v, list)}
    assert linked <= set(wf)   # つなぎ先がすべてある


def test_generate_3d_failure_still_shows_the_image_it_made(monkeypatch, workspace):
    FakeComfy(monkeypatch, status=("error",))
    evs, _ = media_run(monkeypatch, [call("generate_3d", prompt="a red mug"), {"content": "ok"}])
    res = tool_result(evs)
    assert res["ok"] is False and "image_7.png" in res["summary"]
    assert [e["file"]["path"] for e in evs if "file" in e] == ["image_7.png"]


def test_generate_3d_lost_connection_cancels_the_job(monkeypatch, workspace):
    comfy = FakeComfy(monkeypatch, status=(None,))
    inner = comfy.comfy

    async def flaky(cfg, method, path, **kw):
        if path.startswith("/history/"):
            raise chat_media.MediaError("ComfyUI に接続できません")
        return await inner(cfg, method, path, **kw)
    monkeypatch.setattr(chat_media, "_comfy", flaky)
    (workspace / "chat_m1").mkdir()
    (workspace / "chat_m1" / "a.png").write_bytes(b"png")
    evs, _ = media_run(monkeypatch, [call("generate_3d", image_path="a.png"), {"content": "ok"}])
    assert "接続できません" in tool_result(evs)["summary"] and comfy.cancels == ["/api/jobs/p1/cancel"]


# ---- generate_speech (ローカルの音声合成。GPU 切り替えと HTTP は差し替え) ----
def speech_hub(monkeypatch, handler, seen, cat=None):
    import httpx
    real = httpx.AsyncClient

    class Switch:
        SwitchError = type("SwitchError", (Exception,), {})
        music_busy = asyncio.Lock()

        @staticmethod
        async def for_speech(cfg, engine):
            seen["engine"] = engine
            return []

        @staticmethod
        def settings(cfg):
            return {"speech": {e: {"base": f"http://tts-{e}"} for e in ("qwen3", "indextts", "fish")}}

        @staticmethod
        async def stop_speech(cfg):
            seen["stopped"] = seen.get("stopped", 0) + 1
            return []

    class Hub:
        gpu_switch = Switch
        _cat = staticmethod(lambda cfg, name: cat or {})
        _music_running = staticmethod(lambda: 0)

        @staticmethod
        async def free_vram_for_generation(cfg, c, running):
            return []
    monkeypatch.setattr(chat_media, "_hub", lambda: Hub)
    monkeypatch.setattr(chat_media.httpx, "AsyncClient",
                        lambda **kw: real(transport=httpx.MockTransport(handler), **kw))


def test_generate_speech_saves_wav_with_voice(monkeypatch, workspace):
    import httpx
    import json as _json
    seen = {}

    def handler(req):
        seen.setdefault("urls", []).append(str(req.url))
        if req.url.path == "/tts":
            seen["body"] = _json.loads(req.content)
        return httpx.Response(200, content=b"RIFFwav", headers={"content-type": "audio/wav"})
    speech_hub(monkeypatch, handler, seen, cat={"engine": "indextts"})
    (workspace / "chat_s1").mkdir()
    (workspace / "chat_s1" / "me.wav").write_bytes(b"ref")
    chat, _ = fake_chat([call("generate_speech", text="こんにちは", voice="me.wav", style="嬉しそうに"), {"content": "ok"}])
    monkeypatch.setattr(llm, "chat", chat)
    evs = collect(chat_agent.run({}, "m", [{"role": "user", "content": "q"}], subdir="chat_s1"))
    assert seen["engine"] == "indextts" and seen["urls"] == ["http://tts-indextts/tts", "http://tts-indextts/unload"]
    assert seen["body"] == {"text": "こんにちは", "ref_audio": str(workspace / "chat_s1" / "me.wav"), "style": "嬉しそうに"}
    wav = [e["file"] for e in evs if "file" in e]
    assert len(wav) == 1 and wav[0]["path"].startswith("speech_") and wav[0]["path"].endswith(".wav")
    assert (workspace / "chat_s1" / wav[0]["path"]).read_bytes() == b"RIFFwav"


def test_generate_speech_reports_server_error_and_missing_voice(monkeypatch, workspace):
    import httpx
    seen = {}
    speech_hub(monkeypatch, lambda req: httpx.Response(400, json={"error": "unknown speaker: x"}), seen)
    chat, _ = fake_chat([call("generate_speech", text="hi", speaker="x"),
                         call("generate_speech", text="hi", voice="nope.wav"),
                         call("generate_speech", text="hi", engine="other"), {"content": "ok"}])
    monkeypatch.setattr(llm, "chat", chat)
    evs = collect(chat_agent.run({}, "m", [{"role": "user", "content": "q"}], subdir="chat_s2"))
    res = [e["tool_result"] for e in evs if "tool_result" in e]
    assert all(r["ok"] is False for r in res) and seen["engine"] == "qwen3"
    assert "unknown speaker: x" in res[0]["summary"] and "nope.wav" in res[1]["summary"]
    assert "引数エラー" in res[2]["summary"]
    assert not any("file" in e for e in evs) and seen["stopped"] == 1   # /unload も 400 なので止める


def test_generate_speech_stops_server_when_unload_fails(monkeypatch, workspace):
    import httpx
    seen = {}

    def handler(req):
        if req.url.path == "/unload":
            return httpx.Response(500, json={"error": "boom"})
        return httpx.Response(200, content=b"RIFFwav")
    speech_hub(monkeypatch, handler, seen)
    chat, _ = fake_chat([call("generate_speech", text="hi"), {"content": "ok"}])
    monkeypatch.setattr(llm, "chat", chat)
    evs = collect(chat_agent.run({}, "m", [{"role": "user", "content": "q"}], subdir="chat_s3"))
    assert seen["stopped"] == 1 and any("file" in e for e in evs)
