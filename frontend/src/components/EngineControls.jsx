import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Play, Square } from "lucide-react";
import { fetchEngines, startEngine, stopEngine } from "../api.js";

const STATE = {
  ready: { text: "稼働中", dot: "bg-green-400" },
  starting: { text: "起動中…(読み込みに数分かかります)", dot: "bg-amber-400 animate-pulse" },
  stopped: { text: "停止中", dot: "bg-slate-500" },
};

/**
 * 選択中サーバーの推論エンジン(models.yaml の engines)を起動・停止する。
 * baseUrls はそのサーバーのモデルの接続先(省略時は全エンジン)。起動中は数秒ごとに状態を見直し、
 * 状態が変わったら onChanged でモデル一覧(使えるか)を取り直させる。
 */
export default function EngineControls({ baseUrls, onChanged, className = "mt-2" }) {
  const [engines, setEngines] = useState([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [kickedAt, setKickedAt] = useState(0);   // 起動/停止を押した時刻。タスクの状態が切り替わるまで見直し続ける
  const prev = useRef("");
  const changedRef = useRef(onChanged);
  changedRef.current = onChanged;

  const load = useCallback(() => fetchEngines()
    .then((d) => {
      const mine = baseUrls ? d.engines.filter((e) => baseUrls.includes(e.base_url)) : d.engines;
      const sig = mine.map((e) => e.state).join();
      if (prev.current && prev.current !== sig) changedRef.current?.();
      prev.current = sig;
      setEngines(mine);
    })
    .catch(() => setEngines([])), [baseUrls?.join()]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load]);
  const starting = engines.some((e) => e.state === "starting");
  useEffect(() => {
    if (!starting && !kickedAt) return undefined;
    const t = setInterval(() => {
      if (!starting && Date.now() - kickedAt > 60000) setKickedAt(0);
      load();
    }, 4000);
    return () => clearInterval(t);
  }, [starting, kickedAt, load]);

  if (!engines.length) return null;

  const act = async (e, fn) => {
    setBusy(e.name);
    setError("");
    try {
      await fn(e.name);
      setKickedAt(Date.now());
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
      load();
    }
  };

  return (
    <div className={`${className} space-y-1.5 rounded-lg border border-slate-800 bg-slate-950/60 p-2`}>
      {engines.map((e) => {
        const st = STATE[e.state] ?? STATE.stopped;
        const working = busy === e.name;
        return (
          <div key={e.name} className="flex flex-wrap items-center gap-2 text-[12.5px]">
            <span className={`h-2 w-2 shrink-0 rounded-full ${st.dot}`} />
            <span className="font-medium text-slate-200">{e.label}</span>
            <span className="text-slate-400">{st.text}</span>
            {e.state === "stopped" && e.startable && (
              <button
                type="button"
                disabled={working}
                onClick={() => act(e, startEngine)}
                aria-label={`${e.label} を起動`}
                title="Ollama のモデルを VRAM から降ろしてから起動します"
                className="ml-auto flex min-h-8 items-center gap-1 rounded-md border border-green-600/60 px-2.5 text-xs font-semibold text-green-300 hover:bg-green-600/15 disabled:opacity-50"
              >
                {working ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />} 起動
              </button>
            )}
            {e.state !== "stopped" && (
              <button
                type="button"
                disabled={working}
                onClick={() => act(e, stopEngine)}
                aria-label={`${e.label} を停止`}
                className="ml-auto flex min-h-8 items-center gap-1 rounded-md border border-slate-600 px-2.5 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-50"
              >
                {working ? <Loader2 size={12} className="animate-spin" /> : <Square size={12} />} 停止
              </button>
            )}
          </div>
        );
      })}
      {error && <p className="text-xs text-red-300">{error}</p>}
    </div>
  );
}
