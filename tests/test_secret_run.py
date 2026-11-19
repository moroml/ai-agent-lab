"""シークレットRun: 記録・回答キャッシュ・フォルダを残さず、破棄/起動時の掃除で消える。"""
import asyncio
import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import answer_cache
import artifacts
import runs
import server


@pytest.fixture
def env(monkeypatch, tmp_path):
    """記録・作業・成果物の置き場を tmp へ向け、Ollama 等を使わない /run を用意する。"""
    mgr = runs.RunManager()
    for mod in (runs, server):
        monkeypatch.setattr(mod, "manager", mgr, raising=False)
    monkeypatch.setattr(runs, "RUNS_DIR", tmp_path / "runs")
    monkeypatch.setattr(runs, "PROJECTS_DIR", tmp_path / "projects")
    monkeypatch.setattr(runs, "ARTIFACT_DIR", tmp_path / "workspace")
    monkeypatch.setattr(artifacts, "WORKSPACE", tmp_path / "workspace")
    monkeypatch.setattr(runs, "CHECKPOINT_SEC", 0.01)
    monkeypatch.setattr(answer_cache, "CACHE_PATH", tmp_path / "cache.json")

    async def alive():
        return True

    async def models():
        return []

    monkeypatch.setattr(server.llm, "free_ram_gb", lambda: None)
    monkeypatch.setattr(server.llm, "is_alive", alive)
    monkeypatch.setattr(server.llm, "list_models", models)
    monkeypatch.setattr(server.router, "maybe_cascade", lambda mode, *a: mode)
    monkeypatch.setattr(server, "DirectOrchestrator", _FakeDirect)
    return mgr, tmp_path


class _FakeDirect:
    """回答を1つ作り、作業/成果物フォルダにファイルを書いて終わる。"""
    def __init__(self, bus, cfg, model, gen_override=None):
        self.bus = bus

    async def run(self, task, run_id=""):
        bus = self.bus
        root = bus.create_node("task", "ユーザータスク", task)
        ans = bus.create_node("answer", "最終回答", "", root)
        bus.complete(ans, "ANSWER")
        bus.complete(root, "done")
        (runs.PROJECTS_DIR / f"run_{run_id}").mkdir(parents=True, exist_ok=True)
        (runs.PROJECTS_DIR / f"run_{run_id}" / "a.txt").write_text(task, encoding="utf-8")
        artifacts.save_artifacts(task, "```python:app.py\nprint(1)\n```", run_id)
        bus.run_finished()


def _run(coro):
    async def main():
        transport = httpx.ASGITransport(app=server.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8765") as c:
            return await coro(c)
    return asyncio.run(main())


async def _wait_done(c, rid):
    for _ in range(300):
        if (await c.get(f"/run/{rid}")).json()["status"] in ("done", "error", "cancelled"):
            return
        await asyncio.sleep(0.02)
    raise AssertionError("終わらない")


BODY = {"task": "秘密のタスク", "mode": "direct", "model": "auto"}


def test_secret_run_leaves_nothing_but_stays_viewable(env):
    mgr, tmp = env

    async def scenario(c):
        r = (await c.post("/run", json={**BODY, "secret": True})).json()
        rid = r["run_id"]
        assert rid.startswith("secret-")
        await _wait_done(c, rid)
        # 終了後もメモリから見られる(一覧・詳細・SSE の元データ・継続の可否)
        assert rid in mgr.live and not mgr.is_active(rid)
        listed = [x for x in (await c.get("/runs")).json()["runs"] if x["id"] == rid]
        assert listed and listed[0]["secret"] is True and listed[0]["status"] == "done"
        assert (await c.get(f"/run/{rid}")).json()["snapshot"]["nodes"]
        return rid

    rid = _run(scenario)
    assert not (tmp / "runs").exists() or not list((tmp / "runs").iterdir())
    assert not (tmp / "cache.json").exists()
    # 成果物フォルダ名にタスク文を含めない
    assert [p.name for p in (tmp / "workspace").iterdir()] == [rid]
    assert (tmp / "projects" / f"run_{rid}" / "a.txt").exists()


def test_secret_run_skips_answer_cache_read_and_write(env):
    mgr, tmp = env
    answer_cache.put("秘密のタスク", "x", "direct", "OLD")

    class R:
        secret = True
        mode = "direct"
        model = "x"
        id = "secret-1"
        bus = None
    ran = []

    async def inner():
        ran.append(1)

    asyncio.run(answer_cache.wrap(R(), "秘密のタスク", inner()))
    assert ran == [1]   # キャッシュにヒットしても読まず、必ず実行する


def test_delete_secret_removes_live_and_folders(env):
    mgr, tmp = env

    async def scenario(c):
        rid = (await c.post("/run", json={**BODY, "secret": True})).json()["run_id"]
        await _wait_done(c, rid)
        assert (await c.delete(f"/run/{rid}")).json() == {"status": "deleted"}
        assert rid not in mgr.live
        assert (await c.get(f"/run/{rid}")).status_code == 404
        assert (await c.delete(f"/run/{rid}")).status_code == 404
        return rid

    rid = _run(scenario)
    assert not (tmp / "projects" / f"run_{rid}").exists()
    assert not list((tmp / "workspace").iterdir())


def test_delete_running_secret_cancels_it(env, monkeypatch):
    mgr, tmp = env
    class Slow(_FakeDirect):
        async def run(self, task, run_id=""):
            (runs.PROJECTS_DIR / f"run_{run_id}").mkdir(parents=True, exist_ok=True)
            await asyncio.sleep(60)

    monkeypatch.setattr(server, "DirectOrchestrator", Slow)

    async def scenario(c):
        rid = (await c.post("/run", json={**BODY, "secret": True})).json()["run_id"]
        await asyncio.sleep(0.1)
        assert (await c.delete(f"/run/{rid}")).status_code == 200
        return rid

    rid = _run(scenario)
    assert not mgr.live and not (tmp / "projects" / f"run_{rid}").exists()


def test_secret_with_external_review_is_rejected(env):
    async def scenario(c):
        for flag in ("claude_review", "api_review"):
            r = await c.post("/run", json={**BODY, "secret": True, flag: True})
            assert r.status_code == 400

    _run(scenario)


def test_secret_run_can_be_continued_from_memory(env):
    mgr, tmp = env

    async def scenario(c):
        rid = (await c.post("/run", json={**BODY, "secret": True})).json()["run_id"]
        await _wait_done(c, rid)
        run = mgr.reopen(rid)
        assert run is not None and run.secret and run.id == rid
        assert mgr.live[rid] is run and run.bus.nodes

    _run(scenario)


def test_sweep_removes_only_secret_leftovers(env):
    mgr, tmp = env
    for d in ("projects/run_secret-aaaaaaaaaa", "projects/run_aaaaaaaaaa",
              "workspace/secret-aaaaaaaaaa", "workspace/bbbbbbbbbb_task"):
        (tmp / d).mkdir(parents=True)
    assert mgr.sweep_secret() == 2
    assert sorted(p.name for p in (tmp / "projects").iterdir()) == ["run_aaaaaaaaaa"]
    assert sorted(p.name for p in (tmp / "workspace").iterdir()) == ["bbbbbbbbbb_task"]


def test_normal_run_still_persists_and_leaves_live(env):
    mgr, tmp = env

    async def scenario(c):
        rid = (await c.post("/run", json=BODY)).json()["run_id"]
        for _ in range(300):
            if rid not in mgr.live:
                break
            await asyncio.sleep(0.02)
        return rid

    rid = _run(scenario)
    assert not rid.startswith("secret-") and rid not in mgr.live
    assert (tmp / "runs" / f"{rid}.json").is_file()
    assert any(p.name.startswith(f"{rid}_") for p in (tmp / "workspace").iterdir())
    # 通常Runは実行中でなければ DELETE で記録が消える(従来どおり)
    assert _run(lambda c: c.delete(f"/run/{rid}")).status_code == 200
    # 通常Runの回答はキャッシュされる
    assert (tmp / "cache.json").exists()


def test_valid_id_accepts_secret_prefix_only_in_front():
    assert runs._valid_id("secret-0123456789") and runs._valid_id("0123456789")
    assert not runs._valid_id("secret-") and not runs._valid_id("x-0123456789")
    assert not runs._valid_id("secret-..\\x")
