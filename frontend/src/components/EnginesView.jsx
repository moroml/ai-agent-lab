import { useCallback, useEffect, useMemo, useState } from "react";
import { Cpu, Eraser, KeyRound, Loader2, Play, Power, RotateCw, Search, Square } from "lucide-react";
import {
  fetchGpu, fetchSystemModels, freeVram, loadModel, serviceAction, setAnthropicKey, setAutoload, startEngines, stopEngines, unloadModel,
} from "../api.js";
import { fmtGB } from "../derive.js";
import { PullButton } from "./ModelPicker.jsx";

/**
 * エンジン画面: 常駐サービスとモデルを1か所で、自分で起動・停止する。
 * 以前は操作がメーターのポップオーバー・レールのボタン・各画面に散らばり、
 * 個別の停止やモデルの停止ができなかった (2026-11-17 ユーザー指摘で作り直し)。
 */
const STATE = {
  up: { text: "稼働中", cls: "border-green-500/40 bg-green-500/10 text-green-300", dot: "bg-green-400" },
  starting: { text: "起動中…", cls: "border-sky-500/40 bg-sky-500/10 text-sky-300", dot: "bg-sky-400 animate-pulse" },
  down: { text: "停止中", cls: "border-slate-600 bg-slate-800 text-slate-300", dot: "bg-slate-500" },
};
const btn = "flex min-h-9 items-center gap-1.5 rounded-lg border px-3 text-sm transition disabled:cursor-not-allowed disabled:opacity-40";
const ghost = `${btn} border-slate-700 text-slate-200 hover:border-slate-500 hover:bg-slate-800`;
const primary = `${btn} border-teal-500 bg-teal-600 font-semibold text-white hover:bg-teal-500`;
const danger = `${btn} border-red-500 bg-red-600 font-semibold text-white`;

function useArm() {
  const [armed, setArmed] = useState("");
  useEffect(() => {
    if (!armed) return undefined;
    const t = setTimeout(() => setArmed(""), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  // 1回目で「もう一度押すと…」に変わり、3秒以内の2回目で実行する
  return [armed, (id, fn) => (armed === id ? (setArmed(""), fn()) : setArmed(id))];
}

export default function EnginesView({ eng }) {
  const { st } = eng;
  const [busy, setBusy] = useState("");   // 操作中のボタン id
  const [armed, arm] = useArm();
  const [models, setModels] = useState(undefined);   // undefined=読込中 / null=失敗
  const [gpu, setGpu] = useState(null);

  const loadModels = useCallback(() => fetchSystemModels().then(setModels).catch(() => setModels(null)), []);
  const loadGpu = useCallback(() => fetchGpu().then(setGpu).catch(() => setGpu(null)), []);
  const loading = models?.models?.some((m) => m.state === "loading");
  useEffect(() => {
    loadModels(); loadGpu();
    const t = setInterval(() => { if (!document.hidden) { loadModels(); loadGpu(); } }, loading ? 2000 : 6000);
    const onChange = () => { loadModels(); loadGpu(); };
    window.addEventListener("system-changed", onChange);
    return () => { clearInterval(t); window.removeEventListener("system-changed", onChange); };
  }, [loadModels, loadGpu, loading]);

  const act = async (id, fn, pending) => {
    setBusy(id);
    const ok = await eng.run(fn, pending);
    setBusy("");
    return ok;
  };
  const spin = (id, Icon) => (busy === id ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Icon size={14} aria-hidden="true" />);

  if (st === undefined) {
    return <p role="status" className="flex items-center gap-2 p-6 text-sm text-slate-400"><Loader2 size={16} className="animate-spin" aria-hidden="true" /> エンジンの状態を確認しています…</p>;
  }
  if (st === null) {
    return (
      <div role="alert" className="flex items-center gap-3 p-6 text-sm text-red-300">
        サーバーから状態を取得できませんでした
        <button type="button" onClick={eng.reload} className={ghost}><RotateCw size={14} aria-hidden="true" /> 再試行</button>
      </div>
    );
  }
  const services = st.services;
  const anyUp = services.some((s) => s.state !== "down");
  const allUp = services.every((s) => s.state === "up");

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">
        <header className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-100"><Cpu size={22} aria-hidden="true" /> エンジン</h1>
            <p className="mt-1 text-sm text-slate-400">アプリの起動ではエンジンを立ち上げません。使うものだけ、ここで起動・停止してください。</p>
          </div>
          <button type="button" disabled={!!busy || allUp} onClick={() => act("all-start", () => startEngines(), "すべて起動しています…")} className={primary}>
            {spin("all-start", Play)} すべて起動
          </button>
          <button type="button" disabled={!!busy || !anyUp} onClick={() => arm("all-stop", () => act("all-stop", () => stopEngines(), "すべて停止しています…"))}
                  className={armed === "all-stop" ? danger : ghost}>
            {spin("all-stop", Square)} {armed === "all-stop" ? "もう一度押すと全部停止" : "すべて停止"}
          </button>
        </header>

        <GpuBar gpu={gpu} />

        {/* サービス */}
        <section aria-labelledby="eng-svc">
          <h2 id="eng-svc" className="mb-2 text-sm font-semibold text-slate-300">サービス</h2>
          <ul className="grid gap-3 md:grid-cols-2">
            {services.map((s) => {
              const look = STATE[s.state] ?? STATE.down;
              return (
                <li key={s.id} className="rounded-xl border border-slate-800 bg-slate-900 p-4">
                  <div className="flex items-center gap-2">
                    <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${look.dot}`} aria-hidden="true" />
                    <h3 className="min-w-0 flex-1 truncate text-base font-semibold text-slate-100">{s.label}</h3>
                    <span className={`shrink-0 rounded-full border px-2 py-0.5 text-xs font-semibold ${look.cls}`}>{look.text}</span>
                  </div>
                  <p className="mt-1 text-sm text-slate-400">{s.purpose}</p>
                  <p className="mt-1 font-mono text-xs text-slate-500">ポート {s.port}{s.pid ? ` ・ PID ${s.pid}` : ""}</p>
                  {s.conflict && <p className="mt-1 text-xs text-amber-300">{s.conflict} が既定の番号を使っています。起動すると空いている番号を使います</p>}
                  {!s.startable && <p className="mt-1 text-xs text-amber-300">{s.why}</p>}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {s.state === "down" ? (
                      <button type="button" disabled={!!busy || !s.startable} onClick={() => act(`${s.id}-start`, () => serviceAction(s.id, "start"), `${s.label} を起動しています…`)} className={primary}>
                        {spin(`${s.id}-start`, Play)} 起動
                      </button>
                    ) : (
                      <>
                        <button type="button" disabled={!!busy} onClick={() => act(`${s.id}-stop`, () => serviceAction(s.id, "stop"), `${s.label} を停止しています…`)} className={ghost}>
                          {spin(`${s.id}-stop`, Square)} 停止
                        </button>
                        <button type="button" disabled={!!busy || !s.startable} onClick={() => act(`${s.id}-restart`, () => serviceAction(s.id, "restart"), `${s.label} を再起動しています…`)} className={ghost}>
                          {spin(`${s.id}-restart`, RotateCw)} 再起動
                        </button>
                        {s.id === "comfy" && s.state === "up" && (
                          // 止めずに、載っている画像・動画のモデルだけ外す
                          <button type="button" disabled={!!busy} onClick={() => act("comfy-free", () => freeVram(["comfy"]), "ComfyUI のモデルを解放しています…")} className={ghost}>
                            {spin("comfy-free", Eraser)} VRAM を解放
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>

        <ModelsSection models={models} ollama={st.services.find((s) => s.id === "ollama")} autoload={st.autoload}
                       busy={busy} act={act} spin={spin} armed={armed} arm={arm} />

        <KeySection hasKey={st.anthropic_key} busy={busy} act={act} armed={armed} arm={arm} />
      </div>
    </div>
  );
}

function GpuBar({ gpu }) {
  if (!gpu?.available) return <p className="text-xs text-slate-500">GPU の使用量を取得できません</p>;
  const total = gpu.total_bytes || 1;
  const own = gpu.ollama_bytes ?? 0;
  const other = Math.max(0, (gpu.used_bytes ?? 0) - own);
  return (
    <section aria-label="VRAM の使用量" className="rounded-xl border border-slate-800 bg-slate-900 p-4">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
        <span className="font-semibold text-slate-200">VRAM</span>
        <span className="tabular-nums text-slate-300">{fmtGB(gpu.used_bytes)} / {fmtGB(total)} GB 使用</span>
        <span className="flex items-center gap-1 text-xs text-slate-400"><span className="h-2 w-2 rounded-sm bg-teal-400" aria-hidden="true" /> Ollama のモデル {fmtGB(own)} GB</span>
        <span className="flex items-center gap-1 text-xs text-slate-400"><span className="h-2 w-2 rounded-sm bg-slate-500" aria-hidden="true" /> ほかのプロセス(画像・音楽など) {fmtGB(other)} GB</span>
      </div>
      <div className="mt-2 flex h-2.5 w-full overflow-hidden rounded-full bg-slate-800">
        <div className="h-full bg-teal-400" style={{ width: `${(own / total) * 100}%` }} />
        <div className="h-full bg-slate-500" style={{ width: `${(other / total) * 100}%` }} />
      </div>
    </section>
  );
}

function remain(expires) {
  if (!expires) return "";
  const min = Math.round((new Date(expires) - Date.now()) / 60000);
  return min > 60 * 24 ? "ずっと" : min > 0 ? `あと約${min}分で自動解放` : "";
}

function ModelsSection({ models, ollama, autoload, busy, act, spin, armed, arm }) {
  const [q, setQ] = useState("");
  const [all, setAll] = useState(false);
  const rows = models?.models ?? [];
  const loadedCount = rows.filter((m) => m.loaded).length;
  const shown = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return rows.filter((m) => (all || ql || m.loaded || m.state === "loading" || m.state === "error")
      && (!ql || `${m.label} ${m.tag} ${m.for}`.toLowerCase().includes(ql)));
  }, [rows, q, all]);
  const ollamaUp = ollama?.state === "up";

  return (
    <section aria-labelledby="eng-models">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 id="eng-models" className="text-sm font-semibold text-slate-300">モデル (Ollama)</h2>
        <span className="text-xs text-slate-500">VRAM に載っているもの {loadedCount} 件</span>
        <button type="button" disabled={!!busy || !loadedCount} onClick={() => arm("unload-all", () => act("unload-all", () => unloadModel(""), "すべて降ろしています…"))}
                className={`${armed === "unload-all" ? danger : ghost} ml-auto`}>
          {spin("unload-all", Eraser)} {armed === "unload-all" ? "もう一度押すと全部降ろす" : "すべて降ろす"}
        </button>
      </div>

      <label className="mb-3 flex items-start gap-3 rounded-xl border border-slate-800 bg-slate-900 p-3 text-sm">
        <input type="checkbox" checked={!!autoload} disabled={!!busy}
               onChange={(e) => act("autoload", () => setAutoload(e.target.checked).then((r) => ({ done: [r.autoload ? "自動読み込みを入れました" : "自動読み込みを切りました"] })))}
               className="mt-0.5 h-4 w-4 accent-teal-500" />
        <span>
          <span className="font-medium text-slate-200">自動読み込み</span>
          <span className="block text-xs text-slate-400">入れると、チャットを開いたときや待機中にモデルを先に読み込みます (初回の待ちが短くなる)。切っておけば、降ろしたモデルが勝手に戻りません。</span>
        </span>
      </label>

      {!ollamaUp ? (
        <p className="rounded-xl border border-slate-800 bg-slate-900 p-4 text-sm text-slate-400">Ollama が{ollama?.state === "starting" ? "起動中です" : "止まっています。上の「Ollama」を起動すると"}モデルを操作できます。</p>
      ) : models === undefined ? (
        <p role="status" className="text-sm text-slate-400">モデルの一覧を読み込んでいます…</p>
      ) : models === null ? (
        <p role="alert" className="text-sm text-red-300">モデルの一覧を取得できませんでした</p>
      ) : (
        <div className="rounded-xl border border-slate-800 bg-slate-900">
          <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 p-3">
            <Search size={14} className="text-slate-500" aria-hidden="true" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="モデルを検索" aria-label="モデルを検索"
                   className="min-w-0 flex-1 rounded bg-transparent text-sm text-slate-100 outline-none placeholder:text-slate-500 focus-visible:ring-2 focus-visible:ring-teal-500/50" />
            <div role="radiogroup" aria-label="表示するモデル" className="flex gap-1">
              {[[false, "載っているもの"], [true, `すべて (${rows.length})`]].map(([v, label]) => (
                <button key={label} type="button" role="radio" aria-checked={all === v} onClick={() => setAll(v)}
                        className={`min-h-8 rounded-full border px-3 text-xs ${all === v ? "border-teal-500/50 bg-teal-500/10 text-teal-200" : "border-slate-700 text-slate-400 hover:text-slate-200"}`}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <ul className="divide-y divide-slate-800">
            {shown.map((m) => (
              <li key={m.tag} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-100">{m.label} <span className="font-mono text-xs font-normal text-slate-500">{m.tag}</span></p>
                  {m.for && <p className="truncate text-xs text-slate-400">{m.for}</p>}
                  {m.state === "error" && <p role="alert" className="text-xs text-red-400">読み込みに失敗: {m.error}</p>}
                </div>
                {m.loaded && (
                  <span className="shrink-0 text-xs tabular-nums text-teal-300">VRAM {fmtGB(m.size_vram)} GB{remain(m.expires_at) && ` ・ ${remain(m.expires_at)}`}</span>
                )}
                {!m.installed ? (
                  <PullButton tag={m.tag} onDone={() => window.dispatchEvent(new Event("system-changed"))} />
                ) : m.loaded ? (
                  <button type="button" disabled={!!busy} onClick={() => act(`u-${m.tag}`, () => unloadModel(m.tag), `${m.label} を降ろしています…`)} className={ghost}>
                    {spin(`u-${m.tag}`, Power)} 降ろす
                  </button>
                ) : m.state === "loading" ? (
                  <span role="status" className="flex items-center gap-1.5 text-xs text-sky-300"><Loader2 size={14} className="animate-spin" aria-hidden="true" /> 読み込み中…</span>
                ) : (
                  <button type="button" disabled={!!busy} onClick={() => act(`l-${m.tag}`, () => loadModel(m.tag), `${m.label} の読み込みを始めています…`)} className={ghost}>
                    {spin(`l-${m.tag}`, Play)} 読み込む
                  </button>
                )}
              </li>
            ))}
            {!shown.length && (
              <li className="px-3 py-4 text-sm text-slate-400">
                {q ? "一致するモデルがありません" : "VRAM に載っているモデルはありません。「すべて」から読み込めます"}
              </li>
            )}
          </ul>
        </div>
      )}
    </section>
  );
}

function KeySection({ hasKey, busy, act, armed, arm }) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [err, setErr] = useState("");
  return (
    <section aria-labelledby="eng-key" className="rounded-xl border border-slate-800 bg-slate-900 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <KeyRound size={16} className="text-slate-400" aria-hidden="true" />
        <h2 id="eng-key" className="flex-1 text-sm font-semibold text-slate-200">Claude API キー: {hasKey ? "設定済み" : "未設定"}</h2>
        {hasKey && (
          <button type="button" disabled={!!busy} className={armed === "key-del" ? danger : ghost}
                  onClick={() => arm("key-del", () => act("key-del", () => setAnthropicKey("").then(() => ({ done: ["キーを削除しました"] }))))}>
            {armed === "key-del" ? "もう一度押すと削除" : "削除"}
          </button>
        )}
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className={ghost}>{hasKey ? "変更" : "設定"}</button>
      </div>
      <p className="mt-1 text-xs text-slate-400">Claude レビューで使います。この PC の .env にだけ保存し、画面には表示しません。</p>
      {open && (
        <form className="mt-3 flex flex-wrap gap-2" onSubmit={async (e) => {
          e.preventDefault();
          if (!key.trim()) return setErr("キーを入力してください（削除は「削除」ボタン）");
          setErr("");
          if (await act("key", () => setAnthropicKey(key).then(() => ({ done: ["キーを保存しました"] })))) {
            setKey("");
            setOpen(false);
          }
        }}>
          <label htmlFor="eng-key-input" className="sr-only">Claude API キー</label>
          <input id="eng-key-input" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-ant-…"
                 className="min-h-9 min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100" />
          <button type="submit" disabled={!!busy} className={primary}>保存</button>
          {err && <p role="alert" className="w-full text-xs text-red-400">{err}</p>}
        </form>
      )}
    </section>
  );
}
