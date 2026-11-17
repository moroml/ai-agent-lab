import { useCallback, useEffect, useState } from "react";
import { Eraser, KeyRound, Loader2, Play, Power, RotateCcw } from "lucide-react";
import {
  fetchSystemStatus, freeVram, setAnthropicKey, startAcestep, startOllama, startStudio, stopOllama,
} from "../api.js";
import { fmtGB } from "../derive.js";

const btn = "flex min-h-7 items-center gap-1 rounded-md border px-2 text-[11px] disabled:opacity-40";
const ghost = `${btn} border-zinc-700 text-zinc-300 hover:bg-zinc-800`;
const danger = `${btn} border-red-500 bg-red-600 font-semibold text-white`;

/**
 * 以前はターミナルが要った操作をアプリ内で行う(system.py)。
 * VRAM に載っているモデルを降ろす・Ollama の起動/終了・生成系サービスの起動・Claude API キーの設定。
 * 元に戻しにくい操作(Ollama の終了・キーの削除)は Header の全停止と同じ2段階クリックにそろえる。
 */
export default function SystemControls() {
  const [st, setSt] = useState(undefined);   // undefined=読み込み中 / null=取得失敗
  const [busy, setBusy] = useState("");
  const [armed, setArmed] = useState("");
  const [msg, setMsg] = useState({ text: "", error: false });
  const [keyOpen, setKeyOpen] = useState(false);
  const [key, setKey] = useState("");

  const load = useCallback(() => fetchSystemStatus().then(setSt).catch(() => setSt(null)), []);
  useEffect(() => {
    load();
    const t = setInterval(() => { if (!document.hidden) load(); }, 5000);
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => {
    if (!armed) return undefined;
    const t = setTimeout(() => setArmed(""), 3000);
    return () => clearTimeout(t);
  }, [armed]);

  const act = async (id, fn) => {
    setBusy(id);
    setArmed("");
    setMsg({ text: "", error: false });
    try {
      const r = await fn();
      setMsg({ text: (r?.done ?? []).join(" / "), error: false });
      return true;
    } catch (e) {
      setMsg({ text: e.message, error: true });
      return false;
    } finally {
      setBusy("");
      load();
      window.dispatchEvent(new Event("system-changed"));   // 接続表示・モデル一覧を取り直させる
    }
  };
  // 1回目で「もう一度押すと…」に変わり、3秒以内の2回目で実行する
  const armed2 = (id, fn) => (armed === id ? act(id, fn) : setArmed(id));

  // 取得前に何も出さないと、開いた直後に中身が後から押し出されて動く。場所を確保して待つ
  if (st === undefined) {
    return (
      <p className="mb-3 flex items-center gap-1.5 border-t border-zinc-700 pt-2 text-[11px] text-zinc-500" role="status">
        <Loader2 size={12} className="animate-spin" aria-hidden="true" /> 操作パネルを読み込んでいます…
      </p>
    );
  }
  if (st === null) {
    return (
      <div className="mb-3 flex items-center gap-2 border-t border-zinc-700 pt-2 text-[11px] text-red-400" role="alert">
        <span className="flex-1">サーバーから状態を取得できませんでした</span>
        <button type="button" onClick={() => { setSt(undefined); load(); }} className={ghost}>
          <RotateCcw size={12} aria-hidden="true" /> 再試行
        </button>
      </div>
    );
  }
  const icon = (id, Icon) => (busy === id ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <Icon size={12} aria-hidden="true" />);
  const models = st.ollama.models;
  const services = [
    { id: "studio", label: "画像・動画 (Local Gen Studio)", up: st.studio.up && st.comfy.up, start: startStudio,
      why: st.studio.startable ? "" : "C:/project/local-gen-studio が見つかりません" },
    { id: "acestep", label: "音楽 (ACE-Step)", up: st.acestep.up, start: startAcestep, why: "" },
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
              <button type="button" disabled={!!busy} onClick={() => armed2("o-stop", stopOllama)}
                      className={armed === "o-stop" ? danger : ghost}>
                {icon("o-stop", Power)} {armed === "o-stop" ? "もう一度で終了" : "終了"}
              </button>
            ) : (
              <button type="button" disabled={!!busy} onClick={() => act("o-start", startOllama)} className={ghost}>{icon("o-start", Play)} 起動</button>
            )}
          </li>
          {services.map((s) => (
            <li key={s.id} className="flex items-center gap-2 text-[11px] text-zinc-400">
              <span className={`h-1.5 w-1.5 rounded-full ${s.up ? "bg-green-400" : "bg-zinc-500"}`} aria-hidden="true" />
              <span className="flex-1">{s.label} ({s.up ? "稼働中" : "停止中"})</span>
              {!s.up && (
                // 起動できない理由はボタンを消さずに添える(押せない理由が分からないのを避ける)
                <button type="button" disabled={!!busy || !!s.why} onClick={() => act(s.id, s.start)} className={ghost} title={s.why || undefined}>
                  {icon(s.id, Play)} 起動
                </button>
              )}
              {!s.up && s.why && <span className="sr-only">{s.why}</span>}
            </li>
          ))}
        </ul>
        {services.some((s) => !s.up && s.why) && (
          <p className="mt-1 text-[11px] text-amber-400">{services.filter((s) => !s.up && s.why).map((s) => s.why).join(" / ")}</p>
        )}
      </section>

      {/* Claude API キー */}
      <section aria-labelledby="sys-key">
        <div className="flex items-center gap-2">
          <KeyRound size={12} className="text-zinc-500" aria-hidden="true" />
          <h4 id="sys-key" className="flex-1 text-zinc-300">Claude API キー: {st.anthropic_key ? "設定済み" : "未設定"}</h4>
          {st.anthropic_key && (
            <button type="button" disabled={!!busy}
                    onClick={() => armed2("key-del", () => setAnthropicKey("").then(() => ({ done: ["キーを削除しました"] })))}
                    className={armed === "key-del" ? danger : ghost}>
              {armed === "key-del" ? "もう一度で削除" : "削除"}
            </button>
          )}
          <button type="button" onClick={() => setKeyOpen((v) => !v)} aria-expanded={keyOpen} className={ghost}>
            {st.anthropic_key ? "変更" : "設定"}
          </button>
        </div>
        {keyOpen && (
          <form className="mt-1.5 flex gap-1.5" onSubmit={(e) => {
            e.preventDefault();
            if (!key.trim()) return setMsg({ text: "キーを入力してください（削除は「削除」ボタン）", error: true });
            act("key", () => setAnthropicKey(key).then(() => ({ done: ["キーを保存しました（この PC の .env に保存）"] })))
              .then((ok) => { if (ok) { setKey(""); setKeyOpen(false); } });
          }}>
            <label htmlFor="sys-key-input" className="sr-only">Claude API キー</label>
            <input id="sys-key-input" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)}
                   placeholder="sk-ant-…"
                   className="min-h-7 min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-2 text-[11px] text-zinc-100" />
            <button type="submit" disabled={!!busy} className={ghost}>{icon("key", KeyRound)} 保存</button>
          </form>
        )}
      </section>

      {msg.text && <p role="status" className={`text-[11px] ${msg.error ? "text-red-400" : "text-green-400"}`}>{msg.text}</p>}
    </div>
  );
}
