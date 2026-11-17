"""チャット・エージェントへファイルやフォルダを渡す (このPCからだけ)。

- ドラッグ&ドロップ/選択したファイルを受け取る (POST /attach/upload)
- PC 内をファイル名で検索して、見つけたファイル・フォルダを取り込む (GET /attach/search, POST /attach/local)
取り込んだものは projects/_attach/<batch>/ に置き、送信時に作業フォルダの inputs/ へ写す
(エージェントは自分の作業フォルダの外を読めないため)。本文に貼るための説明文 (describe) も返す。
"""
from __future__ import annotations

import asyncio
import ipaddress
import os
import re
import shutil
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from pydantic import BaseModel, Field

import hub
from tools import WORKSPACE

STORE = Path(WORKSPACE) / "_attach"
MAX_BYTES = 50 * 1024 * 1024        # 1回の添付 (batch) の合計
MAX_FILES = 1000
INLINE_CHARS = 12000                # 本文に中身まで貼る分 (ツールを使えないモデルでも読めるように)
TEXT_EXT = {".txt", ".md", ".py", ".js", ".jsx", ".ts", ".tsx", ".json", ".yaml", ".yml", ".toml", ".csv",
            ".html", ".css", ".java", ".kt", ".c", ".cpp", ".h", ".cs", ".go", ".rs", ".rb", ".php", ".sh",
            ".ps1", ".bat", ".sql", ".xml", ".ini", ".cfg", ".log", ".tex"}
SKIP_DIRS = {".git", "node_modules", ".venv", "venv", "__pycache__", ".next", "dist", "build", ".cache",
             "AppData", "$Recycle.Bin", ".gradle", ".idea"}
# 鍵や認証情報らしいものは取り込まない (誤ってモデルや外部 API に渡さないため)
SECRET = re.compile(r"(^\.env($|\.)|\.pem$|\.key$|\.pfx$|\.p12$|^id_(rsa|ed25519|ecdsa)|credentials|secrets?\.json$|\.kdbx$)", re.I)
BATCH_RE = r"^[a-f0-9]{12}$"


def _require_local(request: Request) -> None:
    hub.require_local_or_key(request)
    try:
        if ipaddress.ip_address(request.client.host if request.client else "").is_loopback:
            return
    except ValueError:
        pass
    raise HTTPException(403, "ファイルの添付はこのPCからだけ行えます")


router = APIRouter(dependencies=[Depends(_require_local)])


def search_roots() -> list[Path]:
    home = Path.home()
    roots = [home / d for d in ("Desktop", "Documents", "Downloads", "Pictures", "OneDrive")] + [Path("C:/project")]
    extra = os.environ.get("ATTACH_ROOTS", "")
    roots += [Path(p) for p in extra.split(os.pathsep) if p]
    return [r for r in roots if r.is_dir()]


def _batch_dir(batch: str | None, create: bool = True) -> tuple[str, Path]:
    if batch and not re.fullmatch(BATCH_RE, batch):
        raise HTTPException(400, "batch の形式が不正です")
    batch = batch or uuid.uuid4().hex[:12]
    d = STORE / batch
    if create:
        d.mkdir(parents=True, exist_ok=True)
    elif not d.is_dir():
        raise HTTPException(404, "添付が見つかりません (時間がたって消えた可能性があります)")
    return batch, d


def _safe_rel(rel: str) -> Path:
    parts = [p for p in re.split(r"[\\/]+", rel) if p not in ("", ".")]
    if not parts or any(p == ".." or ":" in p for p in parts):
        raise HTTPException(400, f"不正なパスです: {rel}")
    return Path(*parts)


def _usage(d: Path) -> tuple[int, int]:
    files = [p for p in d.rglob("*") if p.is_file()]
    return len(files), sum(p.stat().st_size for p in files)


def _is_text(p: Path) -> bool:
    if p.suffix.lower() in TEXT_EXT:
        return True
    try:
        head = p.read_bytes()[:2048]
    except OSError:
        return False
    return bool(head) and b"\0" not in head


def describe(batch: str) -> dict:
    """添付の一覧と、本文に貼る説明。パスは作業フォルダからの相対 (inputs/...)。"""
    _, d = _batch_dir(batch, create=False)
    files = sorted(p for p in d.rglob("*") if p.is_file())
    rows = [{"path": p.relative_to(d).as_posix(), "size": p.stat().st_size} for p in files]
    lines = ["[添付ファイル: 作業フォルダの inputs/ に置いてあります]"]
    lines += [f"- inputs/{r['path']} ({r['size']:,} バイト)" for r in rows[:200]]
    if len(rows) > 200:
        lines.append(f"- ほか {len(rows) - 200} 件")
    budget = INLINE_CHARS
    for p, r in zip(files, rows):
        if budget <= 0 or not _is_text(p):
            continue
        try:
            text = p.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        cut = text[:budget]
        more = "\n…(以下省略。全文は read_file で読めます)" if len(text) > len(cut) else ""
        lines.append(f"\n--- inputs/{r['path']} ---\n{cut}{more}")
        budget -= len(cut)
    return {"batch": batch, "files": rows, "describe": "\n".join(lines)}


def materialize(batch: str | None, dest_root: str | Path) -> None:
    """送信時に添付を作業フォルダの inputs/ へ写す。"""
    if not batch:
        return
    _, d = _batch_dir(batch, create=False)
    shutil.copytree(d, Path(dest_root) / "inputs", dirs_exist_ok=True)


def cleanup(max_age_days: int = 7) -> None:
    if not STORE.is_dir():
        return
    limit = time.time() - max_age_days * 86400
    for d in STORE.iterdir():
        if d.is_dir() and d.stat().st_mtime < limit:
            shutil.rmtree(d, ignore_errors=True)


# ------------------------------------------------------------------ 受け取り
@router.post("/attach/upload")
async def upload(files: list[UploadFile] = File(...), paths: list[str] = Form(default=[]),
                 batch: str | None = Form(default=None)) -> dict:
    """ドロップ/選択されたファイル。paths はフォルダ内の相対パス (フォルダごとのドロップ用)。"""
    batch, d = _batch_dir(batch)
    count, total = await asyncio.to_thread(_usage, d)
    skipped = []
    for i, f in enumerate(files):
        rel = _safe_rel(paths[i] if i < len(paths) and paths[i] else (f.filename or "file"))
        if SECRET.search(rel.name):
            skipped.append(rel.as_posix())
            continue
        if f.size is not None and total + f.size > MAX_BYTES:   # 読み込む前に弾く
            raise HTTPException(413, f"添付は合計 {MAX_FILES} 件・{MAX_BYTES // 2**20}MB までです")
        data = await f.read()
        count, total = count + 1, total + len(data)
        if count > MAX_FILES or total > MAX_BYTES:
            raise HTTPException(413, f"添付は合計 {MAX_FILES} 件・{MAX_BYTES // 2**20}MB までです")
        out = d / rel
        out.parent.mkdir(parents=True, exist_ok=True)
        await asyncio.to_thread(out.write_bytes, data)
    return {**await asyncio.to_thread(describe, batch), "skipped": skipped}


class LocalReq(BaseModel):
    paths: list[str] = Field(min_length=1, max_length=50)
    batch: str | None = None


def _copy_local(src: Path, d: Path, skipped: list[str]) -> None:
    count, total = _usage(d)
    base = src.parent
    items = [src] if src.is_file() else [p for p in src.rglob("*")
                                         if p.is_file() and not (set(p.relative_to(src).parts[:-1]) & SKIP_DIRS)]
    for p in items:
        if SECRET.search(p.name):
            skipped.append(str(p))
            continue
        size = p.stat().st_size
        count, total = count + 1, total + size
        if count > MAX_FILES or total > MAX_BYTES:
            raise HTTPException(413, f"添付は合計 {MAX_FILES} 件・{MAX_BYTES // 2**20}MB までです ({src.name})")
        out = d / p.relative_to(base)
        out.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(p, out)


@router.post("/attach/local")
async def attach_local(req: LocalReq) -> dict:
    """検索で選んだ PC 内のファイル・フォルダを取り込む。"""
    batch, d = _batch_dir(req.batch)
    skipped: list[str] = []
    for raw in req.paths:
        src = Path(raw)
        if not src.is_absolute() or not src.exists():
            raise HTTPException(404, f"見つかりません: {raw}")
        if SECRET.search(src.name):
            skipped.append(raw)
            continue
        await asyncio.to_thread(_copy_local, src, d, skipped)
    return {**await asyncio.to_thread(describe, batch), "skipped": skipped}


@router.delete("/attach/{batch}")
async def remove(batch: str, path: str) -> dict:
    _, d = _batch_dir(batch, create=False)
    target = d / _safe_rel(path)
    if target.is_dir():
        shutil.rmtree(target)
    elif target.is_file():
        target.unlink()
    return await asyncio.to_thread(describe, batch)


# ------------------------------------------------------------------ 検索
def _search(q: str, limit: int, budget_s: float) -> dict:
    words = [w for w in q.lower().split() if w]
    found, deadline = [], time.monotonic() + budget_s
    for root in search_roots():
        for cur, dirs, files in os.walk(root):
            dirs[:] = [x for x in dirs if x not in SKIP_DIRS and not x.startswith(".")]
            for name, is_dir in [(x, True) for x in dirs] + [(x, False) for x in files]:
                low = name.lower()
                if all(w in low for w in words) and not SECRET.search(name):
                    p = Path(cur) / name
                    try:
                        size = None if is_dir else p.stat().st_size
                    except OSError:
                        continue
                    found.append({"path": str(p), "name": name, "dir": is_dir, "size": size})
                    if len(found) >= limit:
                        return {"items": found, "truncated": True}
            if time.monotonic() > deadline:
                return {"items": found, "truncated": True}
    return {"items": found, "truncated": False}


@router.get("/attach/search")
async def search(q: str, limit: int = 40) -> dict:
    q = q.strip()
    if len(q) < 2:
        raise HTTPException(400, "2文字以上で検索してください")
    res = await asyncio.to_thread(_search, q, max(1, min(limit, 100)), 3.0)
    return {**res, "roots": [str(r) for r in search_roots()]}


def register(app) -> None:
    app.include_router(router)
    cleanup()
