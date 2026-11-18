"""拒否の救済 (2026-11-18): 文章回答が拒否だったら refusal_fallback のモデルで答え直す。"""
import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import llm
import orchestrator
from events import EventBus
from orchestrator import _REFUSAL_RE, _unrefuse

CFG = {"models": {"big": {"tag": "big"}, "free": {"tag": "free"}}, "refusal_fallback": "free"}
MSGS = [{"role": "user", "content": "q"}]


@pytest.mark.parametrize("text", [
    "I’m sorry, but I can’t help with that.",   # gpt-oss:20b 実測
    "具体的な手順を公開することは、ガイドラインおよび倫理的観点から控えております。",   # gemma 実測
    "申し訳ありませんが、その質問にはお答えできません。",
    "申し訳ありませんが、そのご要望には対応できません。",   # gpt-oss:20b + DIRECT_SYSTEM 実測
])
def test_refusal_detected(text):
    assert _REFUSAL_RE.search(text)


@pytest.mark.parametrize("text", [
    "分数の割り算は、割る数の逆数を掛けて計算します。",
    "Web の検索、ファイルの作成、画像の生成ができます。",
    "I'm sorry to hear that. Here are some suggestions.",
])
def test_normal_answer_not_detected(text):
    assert not _REFUSAL_RE.search(text)


def run(monkeypatch, final, reply="答えです", cfg=CFG, model="big", usable=True):
    used = []

    async def stream(bus, node_id, messages, cfg, key, **kw):
        used.append(key)
        return reply

    async def list_models():
        return []

    async def model_usable(cfg, key, installed):
        return usable, "ok"
    monkeypatch.setattr(orchestrator, "_stream_llm", stream)
    monkeypatch.setattr(llm, "list_models", list_models)
    monkeypatch.setattr(llm, "model_usable", model_usable)
    bus = EventBus()
    root = bus.create_node("task", "t", "")
    answer = bus.create_node("answer", "最終回答", "", root)
    bus.complete(answer, final)
    out = asyncio.run(_unrefuse(bus, answer, cfg, model, MSGS, final))
    answers = [n.output for n in bus.nodes.values() if n.kind == "answer"]
    return out, used, answers


def test_refusal_is_reanswered(monkeypatch):
    out, used, answers = run(monkeypatch, "I'm sorry, but I can't help with that.")
    assert out == "答えです" and used == ["free"] and answers[-1] == "答えです"


def test_no_intervention_cases(monkeypatch):
    refusal = "申し訳ありませんが、お答えできません。"
    assert run(monkeypatch, "普通の回答です。")[1] == []                       # 拒否でない
    assert run(monkeypatch, refusal, cfg={**CFG, "refusal_fallback": ""})[1] == []   # 無効
    assert run(monkeypatch, refusal, model="free")[1] == []                    # 既に無検閲モデル
    assert run(monkeypatch, refusal, usable=False)[1] == []                    # 未導入


def test_empty_reanswer_keeps_original(monkeypatch):
    refusal = "申し訳ありませんが、お答えできません。"
    out, used, answers = run(monkeypatch, refusal, reply="")
    assert out == refusal and used == ["free"] and answers[-1] == refusal
