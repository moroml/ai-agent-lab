// 種類別ビュー共通の小さな部品。色は種類ごとの accent (Tailwind の色名) で切り替える。
import { useEffect, useRef, useState } from "react";
import { startStudio } from "../api.js";
import { fetchJob, studioStatus } from "./api.js";

export const ACCENTS = {
  emerald: { btn: "bg-emerald-600 hover:bg-emerald-500", ring: "focus:ring-emerald-500/50", text: "text-emerald-300", soft: "bg-emerald-500/10 border-emerald-500/30", bar: "bg-emerald-500" },
  violet: { btn: "bg-violet-600 hover:bg-violet-500", ring: "focus:ring-violet-500/50", text: "text-violet-300", soft: "bg-violet-500/10 border-violet-500/30", bar: "bg-violet-500" },
  rose: { btn: "bg-rose-600 hover:bg-rose-500", ring: "focus:ring-rose-500/50", text: "text-rose-300", soft: "bg-rose-500/10 border-rose-500/30", bar: "bg-rose-500" },
  amber: { btn: "bg-amber-600 hover:bg-amber-500", ring: "focus:ring-amber-500/50", text: "text-amber-300", soft: "bg-amber-500/10 border-amber-500/30", bar: "bg-amber-500" },
};

export function Button({ accent = "violet", variant = "solid", className = "", ...props }) {
  const a = ACCENTS[accent];
  const base = "inline-flex min-h-10 shrink-0 items-center whitespace-nowrap justify-center gap-1.5 rounded-lg px-3 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50";
  const look = variant === "solid" ? `${a.btn} text-white` : "border border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800";
  return <button type="button" className={`${base} ${look} ${className}`} {...props} />;
}

export function Field({ label, hint, children }) {
  return (
    <label className="block space-y-1">
      <span className="flex items-baseline justify-between text-xs font-medium text-slate-300">
        {label}
        {hint && <span className="font-normal text-slate-500">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

export const inputCls = "w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2";

export function Chips({ options, value, onChange, accent = "violet" }) {
  const a = ACCENTS[accent];
  return (
    <div className="flex flex-wrap gap-1.5" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={`min-h-9 rounded-full border px-3 text-xs transition ${value === o.value ? `${a.soft} ${a.text}` : "border-slate-700 text-slate-400 hover:text-slate-200"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function ErrorNote({ text, onClose }) {
  if (!text) return null;
  return (
    <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
      <span className="flex-1 whitespace-pre-wrap">{text}</span>
      {onClose && <button type="button" onClick={onClose} className="text-red-300 hover:text-white" aria-label="閉じる">×</button>}
    </div>
  );
}

export function Progress({ value, text, accent }) {
  return (
    <div className="space-y-1">
      <div className="h-1.5 overflow-hidden rounded-full bg-slate-800">
        <div className={`h-full ${ACCENTS[accent].bar} transition-all`} style={{ width: `${Math.round((value ?? 0) * 100)}%` }} />
      </div>
      {text && <p className="text-xs text-slate-400">{text}</p>}
    </div>
  );
}

export function StudioOffline({ reason, onReady }) {
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900/60 p-4 text-sm text-slate-300">
      <p className="font-medium text-slate-100">Local Gen Studio に接続できません</p>
      <p className="mt-1 text-slate-400">{reason}</p>
      <StudioStartButton onReady={onReady} />
    </div>
  );
}

// LGS のジョブを1秒ごとに追う。完了/失敗で onDone を1回呼ぶ
export function useStudioJob(onDone) {
  const [job, setJob] = useState(null); // {id, status, progress, progress_text}
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  useEffect(() => {
    if (!job?.id || job.status === "done" || job.status === "error" || job.status === "cancelled") return;
    let alive = true;
    const t = setTimeout(async () => {
      try {
        const j = await fetchJob(job.id);
        if (!alive) return;
        setJob({ id: job.id, ...j });
        if (j.status === "done" || j.status === "error" || j.status === "cancelled") doneRef.current?.({ id: job.id, ...j });
      } catch (e) {
        if (!alive) return;
        const failed = { id: job.id, status: "error", error: `進捗を取得できません: ${e.message}` };
        setJob(failed);
        doneRef.current?.(failed);
      }
    }, 1000);
    return () => { alive = false; clearTimeout(t); };
  }, [job]);
  return [job, (id) => setJob(id ? { id, status: "queued", progress: 0 } : null)];
}

export function usePersisted(key, initial) {
  const [v, setV] = useState(() => {
    try { const s = localStorage.getItem(key); return s == null ? initial : JSON.parse(s); } catch { return initial; }
  });
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* 保存不可でも動作は続ける */ }
  }, [key, v]);
  return [v, setV];
}

/**
 * Local Gen Studio をアプリ内から起動する(以前は start-studio.bat を手で実行していた)。
 * ComfyUI まで準備できたら onReady で呼び出し元に状態を取り直させる。ページの再読込はしない
 * (エージェントの下書きなど、他の画面の入力途中の内容が消えるため)。
 */
export function StudioStartButton({ className = "mt-3", onReady }) {
  const [state, setState] = useState({ busy: false, text: "", error: false });
  const timer = useRef(null);
  const readyRef = useRef(onReady);
  readyRef.current = onReady;
  useEffect(() => () => clearTimeout(timer.current), []);
  const start = () => {
    setState({ busy: true, text: "", error: false });
    startStudio()
      .then((r) => {
        setState({ busy: true, text: (r.done ?? []).join(" / "), error: false });
        const until = Date.now() + 5 * 60 * 1000;
        const again = () => { timer.current = setTimeout(poll, 3000); };
        const poll = () => studioStatus().then((s) => {
          if (s.connected && s.comfy !== false) {
            setState({ busy: false, text: "準備できました", error: false });
            readyRef.current?.();
          } else if (Date.now() < until) again();
          else setState({ busy: false, text: "5分待っても準備できませんでした。もう一度押してください", error: true });
        }).catch(again);
        poll();
      })
      .catch((e) => setState({ busy: false, text: e.message, error: true }));
  };
  return (
    <div className={`${className} flex flex-wrap items-center gap-2`}>
      <button type="button" onClick={start} disabled={state.busy}
              className="min-h-9 rounded-lg border border-violet-500/40 bg-violet-500/10 px-3 text-xs text-violet-200 hover:bg-violet-500/20 disabled:opacity-50">
        {state.busy ? "起動しています…" : "Local Gen Studio を起動"}
      </button>
      {state.text && <span role="status" className={`text-xs ${state.error ? "text-red-300" : "text-slate-400"}`}>{state.text}</span>}
    </div>
  );
}
