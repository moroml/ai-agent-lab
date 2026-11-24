"""音声の一括書き出し。CSV のセリフ一覧を順に音声にして、id 名のファイルと ZIP にまとめる (ゲームなどへ取り込む用)。

1 回に動かす書き出しは 1 つ。進み具合は job.json に書くので、サーバーを再起動しても結果の一覧と ZIP は残る
(実行中だったものは「中断」になる)。生成は speech.synthesize を 1 行ずつ呼ぶので、他の生成とは順番に GPU を使う。
"""
from __future__ import annotations

import asyncio
import csv
import io
import json
import re
import time
import uuid
import zipfile
from pathlib import Path

import gpu_switch
import speech

BATCH_DIR = speech.SPEECH_OUT / "batch"
MAX_LINES = 500
MAX_LINE_TEXT = 1000
FORMATS = {"wav": ["-c:a", "pcm_s16le"], "ogg": ["-c:a", "libvorbis", "-q:a", "5"], "mp3": ["-c:a", "libmp3lame", "-q:a", "2"]}
LOUDNORM = "loudnorm=I=-16:TP=-1.5:LRA=11"   # ゲーム・配信でよく使う -16 LUFS にそろえる
MAX_FAILS_IN_ROW = 3                        # 続けて失敗したら (GPU が使えない等) 打ち切る

_jobs: dict[str, dict] = {}
_cancel: set[str] = set()
_task: asyncio.Task | None = None
JOB_RE = re.compile(r"^[\w\-]{1,60}$")


WIN_RESERVED = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)), *(f"lpt{i}" for i in range(1, 10))}


def _safe_id(raw: str, used: set[str]) -> str:
    base = re.sub(r"[^\w\-]+", "_", raw.strip()).strip("_")[:60] or "line"
    if base.lower() in WIN_RESERVED:   # Windows では CON.wav なども作れない
        base = f"{base}_"
    name, n = base, 2
    while name.lower() in used:
        name, n = f"{base}_{n}", n + 1
    used.add(name.lower())
    return name


def parse_lines(text: str) -> list[dict]:
    """CSV を [{"id", "text", "voice", "style"}] にする。1 列の行は id を自動。1 行目が id,text… ならヘッダー。"""
    rows = [r for r in csv.reader(io.StringIO(text.lstrip("﻿"))) if any(c.strip() for c in r)]
    if rows and [c.strip().lower() for c in rows[0][:2]] == ["id", "text"]:
        rows = rows[1:]
    if not rows:
        raise speech.SpeechInputError("セリフが1行もありません")
    if len(rows) > MAX_LINES:
        raise speech.SpeechInputError(f"セリフは {MAX_LINES} 行までです ({len(rows)} 行あります)")
    used: set[str] = set()
    lines = []
    for i, r in enumerate(rows, 1):
        r = [c.strip() for c in r]
        raw_id, text = (f"line_{i:03d}", r[0]) if len(r) == 1 else (r[0] or f"line_{i:03d}", r[1])
        if not text:
            raise speech.SpeechInputError(f"{i} 行目の文章が空です")
        if len(text) > MAX_LINE_TEXT:
            raise speech.SpeechInputError(f"{i} 行目の文章が長すぎます ({MAX_LINE_TEXT} 文字まで)")
        lines.append({"id": _safe_id(raw_id, used), "text": text,
                      "voice": r[2] if len(r) > 2 else "", "style": r[3] if len(r) > 3 else ""})
    return lines


def _dir(job_id: str) -> Path:
    if not JOB_RE.match(job_id or ""):
        raise speech.SpeechInputError("書き出しの名前が不正です")
    return BATCH_DIR / job_id


def _save(job: dict) -> None:
    try:
        (_dir(job["job"]) / "job.json").write_text(json.dumps(job, ensure_ascii=False), encoding="utf-8")
    except OSError:
        pass   # 進み具合はメモリにもある


def _public(job: dict) -> dict:
    zip_ok = job["state"] != "running" and (_dir(job["job"]) / f"{job['job']}.zip").is_file()
    return {**{k: v for k, v in job.items() if k != "opts"},
            "zip_url": f"/speech/batch/{job['job']}/zip" if zip_ok else None}


def get(job_id: str) -> dict | None:
    if job_id in _jobs:
        return _public(_jobs[job_id])
    try:
        job = json.loads((_dir(job_id) / "job.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if job.get("state") == "running":   # 再起動で止まった
        job["state"], job["current"] = "error", None
        job.setdefault("failed", []).append({"id": "", "error": "サーバーの再起動で中断しました"})
    return _public(job)


def list_jobs(limit: int = 30) -> list[dict]:
    if not BATCH_DIR.is_dir():
        return []
    dirs = sorted((d for d in BATCH_DIR.iterdir() if d.is_dir()), key=lambda d: d.name, reverse=True)
    return [j for j in (get(d.name) for d in dirs[:limit]) if j]


def running() -> str | None:
    return next((k for k, j in _jobs.items() if j["state"] == "running"), None)


def _convert(src: Path, dst: Path, fmt: str, normalize: bool) -> None:
    args = ["-y", "-v", "error", "-i", str(src)]
    if normalize:
        args += ["-af", LOUDNORM, "-ar", "44100"]   # loudnorm は内部で 192kHz にするので戻す
    done = speech._run_tool("ffmpeg", [*args, *FORMATS[fmt], str(dst)])
    if done.returncode != 0 or not dst.is_file():
        raise speech.SpeechError(f"{fmt} に変換できませんでした: {done.stderr.decode(errors='replace')[-200:]}")


def _seconds(path: Path) -> float | None:
    done = speech._run_tool("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)], 30)
    try:
        return round(float(done.stdout.decode().strip()), 2)
    except ValueError:
        return None


def _zip(job: dict, rows: list[dict]) -> None:
    d = _dir(job["job"])
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["id", "text", "file", "seconds"])
    for r in rows:
        w.writerow([r["id"], r["text"], r["file"], r["seconds"]])
    (d / "lines.csv").write_bytes(("﻿" + buf.getvalue()).encode("utf-8"))   # BOM: Excel で文字化けしない
    tmp = d / f"{job['job']}.zip.part"
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        for r in rows:
            z.write(d / r["file"], r["file"])
        z.write(d / "lines.csv", "lines.csv")
    tmp.replace(d / f"{job['job']}.zip")


async def _run(cfg: dict, job: dict, lines: list[dict], voices: dict) -> None:
    d = _dir(job["job"])
    o = job["opts"]
    rows, fails_in_row = [], 0
    try:
        for line in lines:
            if job["job"] in _cancel:
                job["state"] = "cancelled"
                break
            job["current"] = line["id"]
            ref, ref_text = voices.get(line["voice"] or o["voice"] or "", (None, None))
            try:
                result = await speech.synthesize(
                    cfg, job["engine"], line["text"], language=o["language"], ref_audio=ref,
                    ref_text=ref_text if ref else None, style=line["style"] or o["style"],
                    speaker=None if ref else o["speaker"], seed=o["seed"], keep_loaded=True)
                raw = d / f"{line['id']}.raw.wav"
                raw.write_bytes(result["wav"])
                out = d / f"{line['id']}.{job['format']}"
                if job["format"] == "wav" and not o["normalize"]:
                    raw.replace(out)
                else:
                    await asyncio.to_thread(_convert, raw, out, job["format"], o["normalize"])
                    raw.unlink(missing_ok=True)
                rows.append({**line, "file": out.name, "seconds": await asyncio.to_thread(_seconds, out)})
                fails_in_row = 0
            except (speech.SpeechError, gpu_switch.SwitchError) as exc:
                job["failed"].append({"id": line["id"], "error": str(exc)})
                fails_in_row += 1
            job["done"] += 1
            _save(job)
            if fails_in_row >= MAX_FAILS_IN_ROW:
                job["state"] = "error"
                job["failed"].append({"id": "", "error": f"{MAX_FAILS_IN_ROW} 行続けて失敗したので止めました"})
                break
        if rows:
            await asyncio.to_thread(_zip, job, rows)
        if job["state"] == "running":
            job["state"] = "done"
    except Exception as exc:   # noqa: BLE001 — 想定外でも状態は残す
        job["state"] = "error"
        job["failed"].append({"id": "", "error": f"{exc.__class__.__name__}: {exc}"})
    finally:
        job["current"], job["finished_at"] = None, time.time()
        _cancel.discard(job["job"])
        _save(job)


def start(cfg: dict, *, engine: str, csv_text: str, voices: dict, voice: str | None, language: str | None,
          style: str | None, speaker: str | None, seed: int | None, fmt: str, normalize: bool, name: str) -> dict:
    """書き出しを始めて job を返す。voices は {名前: (wav のパス, 文字起こし)} (使う声はすべて解決済み)。"""
    global _task
    if engine not in speech.ENGINES:
        raise speech.SpeechInputError(f"engine は {' / '.join(speech.ENGINES)} のどれか")
    if fmt not in FORMATS:
        raise speech.SpeechInputError(f"形式は {' / '.join(FORMATS)} のどれか")
    if running():
        raise gpu_switch.SwitchError("ほかの書き出しが動いています。終わるか中止してから始めてください")
    lines = parse_lines(csv_text)
    missing = sorted({x for x in [voice, *(ln["voice"] for ln in lines)] if x and x not in voices})
    if missing:
        raise speech.SpeechInputError("見つからない声があります: " + ", ".join(missing))
    job_id = time.strftime("%Y%m%d_%H%M%S") + "_" + uuid.uuid4().hex[:4]
    _dir(job_id).mkdir(parents=True, exist_ok=True)
    job = {"job": job_id, "name": (name or "").strip()[:100] or job_id, "state": "running", "done": 0,
           "total": len(lines), "failed": [], "current": None, "engine": engine, "format": fmt,
           "created_at": time.time(), "finished_at": None,
           "opts": {"voice": voice or "", "language": language, "style": style or "", "speaker": speaker,
                    "seed": seed, "normalize": bool(normalize)}}
    _jobs[job_id] = job
    _save(job)
    _task = asyncio.get_running_loop().create_task(_run(cfg, job, lines, voices))
    return _public(job)


def cancel(job_id: str) -> dict | None:
    if job_id in _jobs and _jobs[job_id]["state"] == "running":
        _cancel.add(job_id)
    return get(job_id)


def zip_path(job_id: str) -> Path | None:
    p = _dir(job_id) / f"{job_id}.zip"
    return p if p.is_file() else None


def delete(job_id: str) -> bool:
    import shutil
    if job_id in _jobs and _jobs[job_id]["state"] == "running":
        raise gpu_switch.SwitchError("実行中の書き出しは消せません。先に中止してください")
    d = _dir(job_id)
    if not d.is_dir():
        return False
    shutil.rmtree(d)
    _jobs.pop(job_id, None)
    return True
