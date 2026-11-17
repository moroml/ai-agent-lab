import { useCallback, useEffect, useState } from "react";
import { Loader2, Power } from "lucide-react";
import { fetchSystemStatus, startAllEngines } from "../api.js";

/**
 * ワンボタンのエンジン起動(全画面共通のレールに置く)。アプリの起動ではエンジンを立ち上げないため、
 * Ollama・画像/動画(Local Gen Studio)・音楽(ACE-Step)をここからまとめて起動する。
 */
export default function EngineButton() {
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const load = useCallback(() => fetchSystemStatus().then(setSt).catch(() => setSt(null)), []);
  useEffect(() => { load(); const t = setInterval(load, busy ? 3000 : 10000); return () => clearInterval(t); }, [load, busy]);

  // 画像・動画はアプリ(8787)と ComfyUI(8188)の両方がそろって初めて生成できる
  const parts = st ? [["Ollama", st.ollama.up], ["画像・動画", st.studio.up && st.comfy.up], ["音楽", st.acestep.up]] : [];
  const upCount = parts.filter(([, up]) => up).length;
  const allUp = st && upCount === parts.length;
  const summary = st ? parts.map(([n, up]) => `${n}: ${up ? "稼働中" : "停止中"}`).join(" / ") : "状態を取得できません";

  const start = async () => {
    setBusy(true);
    setNote("");
    try {
      const r = await startAllEngines();
      setNote([...r.done, ...r.failed.map((f) => `失敗 ${f}`)].join("\n"));
    } catch (e) {
      setNote(e.message);
    } finally {
      setBusy(false);
      load();
    }
  };

  const dot = !st ? "bg-slate-500" : allUp ? "bg-green-400" : upCount ? "bg-amber-400" : "bg-red-400";
  return (
    <button
      type="button"
      onClick={start}
      disabled={busy || allUp}
      title={[summary, note].filter(Boolean).join("\n")}
      aria-label={allUp ? `エンジン稼働中(${summary})` : `エンジンをまとめて起動(${summary})`}
      className="relative flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg px-1 text-[11px] text-slate-400 transition hover:bg-slate-900 hover:text-slate-200 disabled:cursor-default disabled:hover:bg-transparent md:mx-2 md:mt-auto md:flex-none"
    >
      {busy ? <Loader2 size={20} className="animate-spin" aria-hidden="true" /> : <Power size={20} aria-hidden="true" />}
      <span className="leading-tight">{busy ? "起動中…" : allUp ? "稼働中" : "エンジン起動"}</span>
      <span className={`absolute right-2 top-2 h-2 w-2 rounded-full ${dot}`} aria-hidden="true" />
    </button>
  );
}
