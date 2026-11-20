import launcher


def test_allowed_only_local_or_tailnet_via_serve():
    ok = launcher.allowed
    assert ok({"Host": "127.0.0.1:8766"})
    assert not ok({"Host": "evil.example"})                                        # DNS リバインディング
    assert not ok({"Host": "127.0.0.1:8766", "Origin": "https://evil.example"})    # 別サイトのページ
    assert ok({"Host": "pc.tail.ts.net:8766", "X-Forwarded-For": "100.64.0.9"})
    assert ok({"Host": "pc.tail.ts.net:8766", "X-Forwarded-For": "100.64.0.9", "Origin": "https://pc.tail.ts.net:8766"})
    assert not ok({"Host": "pc.tail.ts.net:8766", "X-Forwarded-For": "203.0.113.5"})
    assert not ok({"Host": "pc.tail.ts.net:8766", "X-Forwarded-For": "100.64.0.9, 203.0.113.5"})   # 最後の中継元で判定
    assert not ok({"Host": "pc.tail.ts.net:8766", "X-Forwarded-For": "x"})
    assert not ok({"Host": "evil.example", "X-Forwarded-For": "100.64.0.9"})   # このPCのブラウザからの偽装


def test_start_runs_once_and_keeps_failure(monkeypatch):
    calls = []
    monkeypatch.setattr(launcher, "running", lambda: False)
    monkeypatch.setattr(launcher.threading, "Thread", lambda target, daemon: type("T", (), {"start": lambda self: calls.append(target)})())
    monkeypatch.setitem(launcher._state, "starting", False)
    assert launcher.start() and not launcher.start()   # 起動中の二重起動はしない
    assert len(calls) == 1

    def fail(*a, **k):
        raise OSError("boom")
    monkeypatch.setattr(launcher.subprocess, "run", fail)
    calls[0]()
    assert launcher._state["starting"] is False and "boom" in launcher._state["detail"]
    monkeypatch.setattr(launcher, "running", lambda: True)
    assert not launcher.start()   # 動いていれば何もしない
