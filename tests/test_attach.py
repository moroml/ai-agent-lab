import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import attach


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setattr(attach, "STORE", tmp_path / "_attach")
    monkeypatch.setattr(attach.hub, "require_local_or_key", lambda r: None)
    app = FastAPI()
    attach.register(app)
    return TestClient(app, base_url="http://127.0.0.1:8765", client=("127.0.0.1", 50000))


def test_upload_folder_and_describe(client, tmp_path):
    r = client.post("/attach/upload",
                    files=[("files", ("a.py", b"print(1)\n")), ("files", ("b.bin", b"\0\1")), ("files", (".env", b"K=1"))],
                    data={"paths": ["src/a.py", "src/b.bin", "src/.env"]})
    assert r.status_code == 200
    d = r.json()
    assert [f["path"] for f in d["files"]] == ["src/a.py", "src/b.bin"]
    assert d["skipped"] == ["src/.env"]                  # 鍵らしいものは取り込まない
    assert "inputs/src/a.py" in d["describe"] and "print(1)" in d["describe"]
    dest = tmp_path / "run_x"
    attach.materialize(d["batch"], dest)
    assert (dest / "inputs" / "src" / "a.py").read_text() == "print(1)\n"


def test_upload_rejects_traversal(client):
    r = client.post("/attach/upload", files=[("files", ("x", b"1"))], data={"paths": ["../evil.txt"]})
    assert r.status_code == 400


def test_local_folder_skips_heavy_dirs_and_remove(client, tmp_path):
    src = tmp_path / "proj"
    (src / "node_modules" / "m").mkdir(parents=True)
    (src / "node_modules" / "m" / "i.js").write_text("x")
    (src / "main.md").write_text("# hi")
    r = client.post("/attach/local", json={"paths": [str(src)]})
    d = r.json()
    assert [f["path"] for f in d["files"]] == ["proj/main.md"]
    r = client.delete(f"/attach/{d['batch']}", params={"path": "proj/main.md"})
    assert r.json()["files"] == []


def test_search_by_name(client, tmp_path, monkeypatch):
    (tmp_path / "docs").mkdir()
    (tmp_path / "docs" / "report final.docx").write_text("x")
    monkeypatch.setattr(attach, "search_roots", lambda: [tmp_path])
    r = client.get("/attach/search", params={"q": "report fin"})
    assert [i["name"] for i in r.json()["items"]] == ["report final.docx"]
    assert client.get("/attach/search", params={"q": "r"}).status_code == 400


def test_remote_client_refused(monkeypatch, tmp_path):
    monkeypatch.setattr(attach.hub, "require_local_or_key", lambda r: None)
    app = FastAPI()
    attach.register(app)
    c = TestClient(app, base_url="http://127.0.0.1:8765", client=("192.168.1.5", 50000))
    assert c.get("/attach/search", params={"q": "ab"}).status_code == 403
