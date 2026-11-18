import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import gpu_switch
import orchestrator


@pytest.fixture(autouse=True)
def _no_real_gpu_switch(monkeypatch):
    """テストから本物の ACE-Step を止めたり起動したりしない (実際に止めた 2026-11-13)。
    個別のテストが差し替えたいときは、そのテスト内で上書きすればよい。"""
    monkeypatch.setattr(gpu_switch, "acestep_processes", lambda pattern: [])
    monkeypatch.setattr(gpu_switch, "start_acestep",
                        lambda script: pytest.fail("テストから ACE-Step を起動しようとした"))


@pytest.fixture(autouse=True)
def _no_real_web_research(monkeypatch):
    """文章回答の前段の Web 調査で、テストから本物の LLM と Web を呼ばない。"""
    async def skip(bus, root_id, cfg, key, task, history=()):
        return task
    monkeypatch.setattr(orchestrator, "_web_research", skip)
