import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Power, X } from "lucide-react";
import { fetchSystemStatus, startAllEngines } from "../api.js";

/**
 * ワンボタンのエンジン起動(全画面共通のレールに置く)。アプリの起動ではエンジンを立ち上げないため、
 * Ollama・画像/動画(Local Gen Studio)・音楽(ACE-Step)をここからまとめて起動する。
 * 結果はツールチップではなく画面下の通知に出す(押したあと何が起きたか分かるように)。
 */
export default function EngineButton() {
  const [st, setSt] = useState(undefined);   // undefined=確認中 / null=取得失敗
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);    // { lines, error }

  // サービスが後から立ち上がった(または落ちた)ときも他の画面に知らせる。起動ボタンの応答後に準備が終わる ComfyUI など
  const sig = useRef(null);
  const load = useCallback(() => fetchSystemStatus().then((s) => {
    setSt(s);
    const now = [s.ollama.up, s.studio.up, s.comfy.up, s.acestep.up].join();
    if (sig.current !== null && sig.current !== now) window.dispatchEvent(new Event("system-changed"));
    sig.current = now;
  }).catch(() => setSt(null)), []);
  useEffect(() => {
    load();
    const t = setInterval(() => { if (!document.hidden) load(); }, busy ? 3000 : 10000);
    return () => clearInterval(t);
  }, [load, busy]);
  useEffect(() => {
    if (!note || note.error) return undefined;   // 失敗は読み終えて閉じるまで残す
    const t = setTimeout(() => setNote(null), 8000);
    return () => clearTimeout(t);
  }, [note]);

  // 画像・動画はアプリ(8787)と ComfyUI(8188)の両方がそろって初めて生成できる
  const parts = st ? [["Ollama", st.ollama.up], ["画像・動画", st.studio.up && st.comfy.up], ["音楽", st.acestep.up]] : [];
  const upCount = parts.filter(([, up]) => up).length;
  const allUp = !!st && upCount === parts.length;
  const summary = st === undefined ? "確認中" : st === null ? "サーバーに接続できません"
    : parts.map(([n, up]) => `${n}: ${up ? "稼働中" : "停止中"}`).join(" / ");

  const start = async () => {
    setBusy(true);
    setNote({ lines: ["エンジンを起動しています…"], error: false });
    try {
      const r = await startAllEngines();
      setNote({ lines: [...r.done, ...r.failed.map((f) => `失敗 ${f}`)], error: r.failed.length > 0 });
    } catch (e) {
      setNote({ lines: [e.message], error: true });
    } finally {
      setBusy(false);
      load();
      window.dispatchEvent(new Event("system-changed"));   // 接続表示・モデル一覧を取り直させる
    }
  };

  const dot = !st ? "bg-slate-500" : allUp ? "bg-green-400" : upCount ? "bg-amber-400" : "bg-red-400";
  const label = busy ? "起動中…" : st === undefined ? "確認中…" : allUp ? "稼働中" : "エンジン起動";
  return (
    <>
      <button
        type="button"
        onClick={start}
        disabled={busy || allUp || !st}
        title={summary}
        aria-label={`${allUp ? "エンジン稼働中" : "エンジンをまとめて起動"}(${summary})`}
        className="relative flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg px-1 text-[11px] text-slate-400 transition hover:bg-slate-900 hover:text-slate-200 disabled:cursor-default disabled:hover:bg-transparent md:mx-2 md:mt-auto md:flex-none"
      >
        {busy || st === undefined ? <Loader2 size={20} className="animate-spin" aria-hidden="true" /> : <Power size={20} aria-hidden="true" />}
        <span className="leading-tight">{label}</span>
        <span className={`absolute right-2 top-2 h-2 w-2 rounded-full ${dot}`} aria-hidden="true" />
      </button>
      <div role="status" aria-live="polite" className="pointer-events-none fixed bottom-20 left-3 z-50 md:bottom-4 md:left-20">
        {note && (
          <div className={`pointer-events-auto flex max-w-sm items-start gap-2 rounded-lg border px-3 py-2 text-xs shadow-lg ${note.error ? "border-red-500/50 bg-red-950 text-red-200" : "border-slate-700 bg-slate-900 text-slate-200"}`}>
            <ul className="space-y-0.5">{note.lines.map((l) => <li key={l}>{l}</li>)}</ul>
            <button type="button" onClick={() => setNote(null)} className="-mr-1 rounded p-0.5 text-slate-400 hover:text-slate-100" aria-label="通知を閉じる">
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        )}
      </div>
    </>
  );
}
