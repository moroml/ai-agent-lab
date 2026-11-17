import { useCallback, useEffect, useState } from "react";
import { Eraser, KeyRound, Loader2, Play, Power } from "lucide-react";
import {
  fetchSystemStatus, freeVram, setAnthropicKey, startAcestep, startOllama, startStudio, stopOllama,
} from "../api.js";
import { fmtGB } from "../derive.js";

const btn = "flex min-h-7 items-center gap-1 rounded-md border px-2 text-[11px] disabled:opacity-40";
const ghost = `${btn} border-zinc-700 text-zinc-300 hover:bg-zinc-800`;

/**
 * 以前はターミナルが要った操作をアプリ内で行う(system.py)。
 * VRAM に載っているモデルを降ろす・Ollama の起動/終了・生成系サービスの起動・Claude API キーの設定。
 */
export default function SystemControls({ onChanged }) {
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState({ text: "", error: false });
  const [keyOpen, setKeyOpen] = useState(false);
  const [key, setKey] = useState("");

  const load = useCallback(() => fetchSystemStatus().then(setSt).catch(() => setSt(null)), []);
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);

  const act = async (id, fn) => {
    setBusy(id);
    setMsg({ text: "", error: false });
    try {
      const r = await fn();
      setMsg({ text: (r?.done ?? []).join(" / "), error: false });
      onChanged?.();
      return true;
    } catch (e) {
      setMsg({ text: e.message, error: true });
      return false;
    } finally {
      setBusy("");
      load();
    }
  };

  if (!st) return null;
  const icon = (id, Icon) => (busy === id ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <Icon size={12} aria-hidden="true" />);
  const models = st.ollama.models;
  const services = [
    { id: "studio", label: "画像・動画 (Local Gen Studio)", up: st.studio.up && st.comfy.up, start: st.studio.startable && startStudio },
    { id: "acestep", label: "音楽 (ACE-Step)", up: st.acestep.up, start: startAcestep },
  ];

  return (
    <div className="mb-3 space-y-3 border-t border-zinc-700 pt-2 text-xs">
      {/* VRAM に載っているもの */}
      <section aria-labelledby="sys-vram">
        <div className="mb-1 flex items-center gap-2">
          <h4 id="sys-vram" className="text-zinc-300">VRAM に載っているもの</h4>
          <button type="button" disabled={!!busy} onClick={() => act("free-all", () => freeVram())}
                  className={`${btn} ml-auto border-blue-500/40 text-blue-200 hover:bg-blue-500/10`}
                  title="Ollama のモデルを降ろし、ComfyUI のモデルを解放し、ACE-Step を止めます">
            {icon("free-all", Eraser)} すべて空ける
          </button>
        </div>
        <ul className="space-y-1">
          {models.map((m) => (
            <li key={m.name} className="flex items-center gap-2 text-[11px] text-zinc-400">
              <span className="min-w-0 flex-1 truncate">{m.name}</span>
              <span className="shrink-0 tabular-nums">{fmtGB(m.size_vram)} GB</span>
              <button type="button" disabled={!!busy} onClick={() => act(`u-${m.name}`, () => freeVram([`ollama:${m.name}`]))}
                      className={ghost} aria-label={`${m.name} を VRAM から降ろす`}>
                {icon(`u-${m.name}`, Eraser)} 降ろす
              </button>
            </li>
          ))}
          {st.comfy.up && (
            <li className="flex items-center gap-2 text-[11px] text-zinc-400">
              <span className="flex-1">ComfyUI (画像・動画のモデル)</span>
              <button type="button" disabled={!!busy} onClick={() => act("u-comfy", () => freeVram(["comfy"]))} className={ghost}>
                {icon("u-comfy", Eraser)} 解放
              </button>
            </li>
          )}
          {st.acestep.up && (
            <li className="flex items-center gap-2 text-[11px] text-zinc-400">
              <span className="flex-1">ACE-Step (音楽)</span>
              <button type="button" disabled={!!busy} onClick={() => act("u-ace", () => freeVram(["acestep"]))} className={ghost}>
                {icon("u-ace", Power)} 停止
              </button>
            </li>
          )}
          {!models.length && !st.comfy.up && !st.acestep.up && <li className="text-[11px] text-zinc-500">何も載っていません</li>}
        </ul>
      </section>

      {/* サービスの起動・終了 */}
      <section aria-labelledby="sys-svc">
        <h4 id="sys-svc" className="mb-1 text-zinc-300">サービス</h4>
        <ul className="space-y-1">
          <li className="flex items-center gap-2 text-[11px] text-zinc-400">
            <span className={`h-1.5 w-1.5 rounded-full ${st.ollama.up ? "bg-green-400" : "bg-zinc-500"}`} aria-hidden="true" />
            <span className="flex-1">Ollama ({st.ollama.up ? "稼働中" : "停止中"})</span>
            {st.ollama.up ? (
              <button type="button" disabled={!!busy} onClick={() => act("o-stop", stopOllama)} className={ghost}>{icon("o-stop", Power)} 終了</button>
            ) : (
              <button type="button" disabled={!!busy} onClick={() => act("o-start", startOllama)} className={ghost}>{icon("o-start", Play)} 起動</button>
            )}
          </li>
          {services.map((s) => (
            <li key={s.id} className="flex items-center gap-2 text-[11px] text-zinc-400">
              <span className={`h-1.5 w-1.5 rounded-full ${s.up ? "bg-green-400" : "bg-zinc-500"}`} aria-hidden="true" />
              <span className="flex-1">{s.label} ({s.up ? "稼働中" : "停止中"})</span>
              {!s.up && s.start && (
                <button type="button" disabled={!!busy} onClick={() => act(s.id, s.start)} className={ghost}>{icon(s.id, Play)} 起動</button>
              )}
            </li>
          ))}
        </ul>
      </section>

      {/* Claude API キー */}
      <section aria-labelledby="sys-key">
        <div className="flex items-center gap-2">
          <KeyRound size={12} className="text-zinc-500" aria-hidden="true" />
          <h4 id="sys-key" className="flex-1 text-zinc-300">Claude API キー: {st.anthropic_key ? "設定済み" : "未設定"}</h4>
          <button type="button" onClick={() => setKeyOpen((v) => !v)} aria-expanded={keyOpen} className={ghost}>
            {st.anthropic_key ? "変更" : "設定"}
          </button>
        </div>
        {keyOpen && (
          <form className="mt-1.5 flex gap-1.5" onSubmit={(e) => {
            e.preventDefault();
            act("key", () => setAnthropicKey(key).then(() => ({ done: [key ? "キーを保存しました" : "キーを削除しました"] })))
              .then((ok) => { if (ok) { setKey(""); setKeyOpen(false); } });
          }}>
            <label htmlFor="sys-key-input" className="sr-only">Claude API キー</label>
            <input id="sys-key-input" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)}
                   placeholder="sk-ant-…（空で保存すると削除）"
                   className="min-h-7 min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-2 text-[11px] text-zinc-100" />
            <button type="submit" disabled={!!busy} className={ghost}>{icon("key", KeyRound)} 保存</button>
          </form>
        )}
      </section>

      {msg.text && <p role="status" className={`text-[11px] ${msg.error ? "text-red-400" : "text-green-400"}`}>{msg.text}</p>}
    </div>
  );
}
