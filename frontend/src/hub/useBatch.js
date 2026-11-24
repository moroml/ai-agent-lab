// 音声画面の「一括書き出し」の状態と操作。CSV → POST /speech/batch → 2秒ごとに進み具合を取る。
// active が false の間 (別のタブを見ている間) と、画面が消えたあとは進み具合の取得を止める。
import { useEffect, useState } from "react";
import { batchCancel, batchDelete, batchGet, batchList, batchStart } from "./api.js";
import { usePersisted } from "./ui.jsx";
import { useArmed } from "./useSpeech.js";

export const FORMATS = ["wav", "ogg", "mp3"];
export const CSV_HELP = "1行に1つ。「id,文章」か「id,文章,声,話し方」(声・話し方は空なら下の設定)。1列だけなら id は自動で付きます。最大500行。";
const POLL_MS = 2000;
const BLANK = { csv: "", engine: "", voice: "", language: "", style: "", speaker: "", format: "wav", normalize: true, name: "" };

// CSV はテキスト。Excel の保存した Shift_JIS でも読めるよう、UTF-8 で読めなければ Shift_JIS にする
function readText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error("ファイルを読めませんでした"));
    r.onload = () => {
      const buf = r.result;
      try { resolve(new TextDecoder("utf-8", { fatal: true }).decode(buf).replace(/^﻿/, "")); }
      catch { resolve(new TextDecoder("shift_jis").decode(buf)); }
    };
    r.readAsArrayBuffer(file);
  });
}

export const isRunning = (j) => j?.state === "running";
export const fmtDate = (t) => (t ? new Date(t * 1000).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "");

export function useBatch(s, active) {
  const [kept, setKept] = usePersisted("hub.speech.batch", BLANK);
  const form = { ...BLANK, ...kept };
  const set = (k, v) => setKept((f) => ({ ...f, [k]: v }));
  const [job, setJob] = useState(null);
  const [items, setItems] = useState(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [armed, setArmed] = useArmed();

  const { info } = s;
  const engine = info?.engines.find((e) => e.key === (form.engine || info.default)) ?? info?.engines[0];
  const language = engine?.languages.includes(form.language) ? form.language : "";
  const speaker = engine?.speakers.includes(form.speaker) ? form.speaker : "";
  const voice = s.voices.some((v) => v.name === form.voice) ? form.voice : "";
  const rows = form.csv.split(/\r?\n/).filter((l) => l.trim()).length;

  const reload = () => batchList()
    .then((d) => { setItems(d.items); return d.items; })
    .catch((e) => { setError(e.message); setItems((x) => x ?? []); return []; });

  // 開いたとき履歴を取り、実行中のものがあれば続きを追う (ページを開き直したあとなど)
  useEffect(() => {
    if (!active) return;
    reload().then((xs) => setJob((cur) => cur ?? xs.find(isRunning) ?? null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // 進み具合。終わったら履歴を取り直して止める
  const jobId = job?.job;
  const running = isRunning(job);
  useEffect(() => {
    if (!active || !jobId || !running) return undefined;
    let alive = true;
    let t;
    const tick = async () => {
      try {
        const j = await batchGet(jobId);
        if (!alive) return;
        setJob(j);
        if (!isRunning(j)) return void reload();
      } catch (e) {   // 一時的な通信の失敗でも追い続ける (止めると終わっても実行中のままになる)
        if (!alive) return;
        setError(`進み具合を取得できません (再試行します): ${e.message}`);
        t = setTimeout(tick, POLL_MS * 3);
        return;
      }
      setError((m) => (m.startsWith("進み具合") ? "" : m));
      t = setTimeout(tick, POLL_MS);
    };
    t = setTimeout(tick, POLL_MS);
    return () => { alive = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, jobId, running]);

  async function loadFile(f) {
    setError("");
    try { set("csv", await readText(f)); } catch (e) { setError(e.message); }
  }

  async function start() {
    if (!engine || !form.csv.trim()) return;
    setError("");
    setBusy(true);
    try {
      const v = s.voices.find((x) => x.name === voice);
      const r = await batchStart({
        engine: engine.key, voice: voice || null, voice_text: v?.text || null, language: language || null,
        style: form.style.trim() || null, speaker: speaker || null, format: form.format, normalize: form.normalize,
        csv: form.csv, name: form.name.trim() || null,
      });
      setJob({ job: r.job, name: form.name.trim(), state: "running", done: 0, total: r.total, failed: [], current: null, zip_url: null });
      reload();
    } catch (e) {
      setError(`書き出しを始められませんでした: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!jobId) return;
    setError("");
    try { setJob(await batchCancel(jobId)); reload(); } catch (e) { setError(`中止できませんでした: ${e.message}`); }
  }

  async function remove(j) {
    if (armed !== j.job) return setArmed(j.job);
    setArmed(null);
    try {
      await batchDelete(j.job);
      setItems((xs) => xs.filter((x) => x.job !== j.job));
      setJob((cur) => (cur?.job === j.job ? null : cur));
    } catch (e) { setError(`削除できませんでした: ${e.message}`); }
  }

  return { form, set, engine, language, speaker, voice, rows, job, items, busy, error, setError, armed, loadFile, start, cancel, remove, reload };
}
