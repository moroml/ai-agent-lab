import { useCallback, useEffect, useRef, useState } from "react";
import { Cpu, Loader2, Power, X } from "lucide-react";
import { fetchSystemStatus, startEngines } from "../api.js";

/**
 * エンジン(Ollama・ComfyUI・Local Gen Studio・ACE-Step)の状態を全画面で共有する。
 * 操作の本体は「エンジン」画面(EnginesView)。ここはレールの入口・止まっているときの帯・結果の通知だけ。
 * 2026-11-17 ユーザー指摘: 起動・停止を自分で選べず、モデルも止められず使いにくい → 専用画面へ集約。
 */
export function useEngines() {
  const [st, setSt] = useState(undefined);   // undefined=確認中 / null=取得失敗
  const [note, setNote] = useState(null);    // { lines, error }
  const sig = useRef(null);
  const load = useCallback(() => fetchSystemStatus().then((s) => {
    setSt(s);
    // 後から立ち上がった・落ちたときも各画面に知らせる (起動ボタンの応答後に準備が終わる ComfyUI など)
    const now = s.services.map((x) => x.state).join();
    if (sig.current !== null && sig.current !== now) window.dispatchEvent(new Event("system-changed"));
    sig.current = now;
  }).catch(() => setSt(null)), []);
  const starting = !!st?.services?.some((s) => s.state === "starting");
  useEffect(() => {
    load();
    const t = setInterval(() => { if (!document.hidden) load(); }, starting ? 2000 : 8000);
    window.addEventListener("system-changed", load);
    return () => { clearInterval(t); window.removeEventListener("system-changed", load); };
  }, [load, starting]);
  useEffect(() => {
    if (!note || note.error) return undefined;   // 失敗は読み終えて閉じるまで残す
    const t = setTimeout(() => setNote(null), 8000);
    return () => clearTimeout(t);
  }, [note]);

  /** 操作を実行し、結果を通知に出して全画面に取り直させる。成功で true */
  const run = useCallback(async (fn, pending = "実行しています…") => {
    setNote({ lines: [pending], error: false });
    try {
      const r = await fn();
      const failed = r?.failed ?? [];
      setNote({ lines: [...(r?.done ?? []), ...failed.map((f) => `失敗 ${f}`)], error: failed.length > 0 });
      return !failed.length;
    } catch (e) {
      setNote({ lines: [e.message], error: true });
      return false;
    } finally {
      window.dispatchEvent(new Event("system-changed"));
    }
  }, []);
  const byId = Object.fromEntries((st?.services ?? []).map((s) => [s.id, s]));
  return { st, byId, note, setNote, run, reload: load };
}

// 画面ごとに要るサービス
export const NEEDS = { agent: ["ollama"], chat: ["ollama"], image: ["comfy", "studio"], video: ["comfy", "studio"], music: ["acestep"] };

/** レールの「エンジン」。稼働数と、止まっているものがあるかを色で示す */
export function EngineNavButton({ eng, active, onClick }) {
  const list = eng.st?.services ?? [];
  const up = list.filter((s) => s.state === "up").length;
  const starting = list.some((s) => s.state === "starting");
  const dot = !eng.st ? "bg-slate-500" : starting ? "bg-sky-400 animate-pulse" : up === list.length ? "bg-green-400" : up ? "bg-amber-400" : "bg-red-400";
  return (
    <button type="button" onClick={onClick} aria-current={active ? "page" : undefined}
            aria-label={`エンジン(${eng.st ? `${up}/${list.length} 稼働` : "確認中"})`}
            className={`relative flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg px-1 text-xs transition md:mx-2 md:mt-auto md:flex-none ${active ? "bg-teal-500/10 text-teal-300" : "text-slate-400 hover:bg-slate-900 hover:text-slate-200"}`}>
      <Cpu size={20} aria-hidden="true" />
      <span className="leading-tight">エンジン</span>
      <span className="text-xs leading-tight tabular-nums opacity-80">{eng.st ? `${up}/${list.length}` : "…"}</span>
      <span className={`absolute right-2 top-2 h-2 w-2 rounded-full ${dot}`} aria-hidden="true" />
    </button>
  );
}

/** いま開いている画面に要るサービスが止まっているときだけ出す帯 */
export function EngineBanner({ eng, kind, onOpen }) {
  const [hidden, setHidden] = useState("");
  const [busy, setBusy] = useState(false);
  const down = (NEEDS[kind] ?? []).map((id) => eng.byId[id]).filter((s) => s && s.state !== "up");
  if (!down.length || hidden === kind) return null;
  const starting = down.every((s) => s.state === "starting");
  const start = async () => {
    setBusy(true);
    await eng.run(() => startEngines(down.map((s) => s.id)), "起動しています…");
    setBusy(false);
  };
  return (
    <div role="region" aria-label="エンジンの状態" className="flex flex-wrap items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-100">
      {starting ? <Loader2 size={16} className="shrink-0 animate-spin text-sky-300" aria-hidden="true" /> : <Power size={16} className="shrink-0 text-amber-300" aria-hidden="true" />}
      <span className="min-w-0 flex-1">
        {starting ? `${down.map((s) => s.label).join("・")} を起動しています…` : `この画面で使う ${down.map((s) => s.label).join("・")} が止まっています。`}
      </span>
      {!starting && (
        <button type="button" onClick={start} disabled={busy}
                className="flex min-h-9 items-center gap-1.5 rounded-lg bg-amber-500 px-3 text-sm font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-60">
          {busy ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Power size={14} aria-hidden="true" />} 起動
        </button>
      )}
      <button type="button" onClick={onOpen} className="min-h-9 rounded-lg border border-amber-500/40 px-3 text-sm text-amber-100 hover:bg-amber-500/20">
        エンジン画面
      </button>
      <button type="button" onClick={() => setHidden(kind)} className="rounded p-1 text-amber-300 hover:text-white" aria-label="この案内を閉じる">
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

/** 操作の結果。ツールチップではなく画面下に出す */
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
