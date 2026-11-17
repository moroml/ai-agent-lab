import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Power, X } from "lucide-react";
import { fetchSystemStatus, startAllEngines } from "../api.js";

/**
 * エンジン(Ollama・画像/動画の Local Gen Studio・音楽の ACE-Step)の状態とワンボタン起動。
 * アプリの起動ではエンジンを立ち上げないため、ここからまとめて起動する。
 * 以前はレール下端の灰色ボタンだけで、どこから起動するのか分からなかった(2026-11-17 ユーザー指摘)。
 * いま開いている画面に要るエンジンが止まっていれば、画面上部の帯で起動を促す。
 */
export function useEngines() {
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
    window.addEventListener("system-changed", load);   // 操作パネルなど他の場所での起動・停止も拾う
    return () => { clearInterval(t); window.removeEventListener("system-changed", load); };
  }, [load, busy]);
  useEffect(() => {
    if (!note || note.error) return undefined;   // 失敗は読み終えて閉じるまで残す
    const t = setTimeout(() => setNote(null), 8000);
    return () => clearTimeout(t);
  }, [note]);

  // 画像・動画はアプリと ComfyUI の両方がそろって初めて生成できる
  const parts = st ? { ollama: st.ollama.up, studio: st.studio.up && st.comfy.up, music: st.acestep.up } : null;

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
      window.dispatchEvent(new Event("system-changed"));   // 接続表示・モデル一覧を取り直させる(load もここで走る)
    }
  };
  return { st, parts, busy, note, setNote, start };
}

const NAMES = { ollama: "Ollama", studio: "画像・動画", music: "音楽" };
// 画面ごとに要るエンジン
export const NEEDS = { agent: ["ollama"], chat: ["ollama"], image: ["studio"], video: ["studio"], music: ["music"] };

/** レールのボタン。止まっているものがあれば色を付け、何がいくつ動いているかを文字で出す */
export default function EngineButton({ eng }) {
  const { st, parts, busy, start } = eng;
  const keys = Object.keys(NAMES);
  const upCount = parts ? keys.filter((k) => parts[k]).length : 0;
  const allUp = !!parts && upCount === keys.length;
  const summary = st === undefined ? "確認中" : st === null ? "サーバーに接続できません"
    : keys.map((k) => `${NAMES[k]}: ${parts[k] ? "稼働中" : "停止中"}`).join(" / ");
  const label = busy ? "起動中…" : st === undefined ? "確認中…" : allUp ? "稼働中" : "エンジン起動";
  const look = !parts || allUp ? "text-slate-400" : "border border-amber-500/50 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20";
  return (
    <button
      type="button"
      onClick={start}
      disabled={busy || allUp || !st}
      aria-label={`${allUp ? "エンジン稼働中" : "エンジンをまとめて起動"}(${summary})`}
      className={`flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg px-1 text-xs transition disabled:cursor-default md:mx-2 md:mt-auto md:flex-none ${look}`}
    >
      {busy || st === undefined ? <Loader2 size={20} className="animate-spin" aria-hidden="true" /> : <Power size={20} aria-hidden="true" />}
      <span className="leading-tight">{label}</span>
      {parts && <span className="text-xs leading-tight tabular-nums opacity-80">{upCount}/{keys.length} 稼働</span>}
    </button>
  );
}

/** いま開いている画面に要るエンジンが止まっているときだけ出す帯 */
export function EngineBanner({ eng, kind }) {
  const { st, parts, busy, start } = eng;
  const [hidden, setHidden] = useState("");
  const down = parts ? (NEEDS[kind] ?? []).filter((k) => !parts[k]) : [];
  const conflict = st?.studio?.conflict;
  if (!down.length || hidden === kind) return null;
  return (
    <div role="region" aria-label="エンジンの状態" className="flex flex-wrap items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-100">
      <Power size={16} className="shrink-0 text-amber-300" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        この画面で使う {down.map((k) => NAMES[k]).join("・")} のエンジンが止まっています。
        {down.includes("studio") && conflict && <span className="text-amber-200/80"> ({conflict} が既定の番号を使用中。起動すると空き番号を使います)</span>}
      </span>
      <button type="button" onClick={start} disabled={busy}
              className="flex min-h-9 items-center gap-1.5 rounded-lg bg-amber-500 px-3 text-sm font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-60">
        {busy ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Power size={14} aria-hidden="true" />}
        {busy ? "起動しています…" : "エンジンを起動"}
      </button>
      <button type="button" onClick={() => setHidden(kind)} className="rounded p-1 text-amber-300 hover:text-white" aria-label="この案内を閉じる">
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

/** 起動の結果。ツールチップではなく画面下に出す */
export function EngineToast({ eng }) {
  const { note, setNote } = eng;
  return (
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
  );
}
