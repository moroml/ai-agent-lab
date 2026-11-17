// チャット: Run を作らない会話専用の画面。会話はこのブラウザに保存する(サーバーには残さない)。
import { useEffect, useMemo, useRef, useState } from "react";
import { Brain, Check, Copy, FileText, Loader2, Menu, Plus, RotateCcw, Send, Square, Trash2, Wrench, X } from "lucide-react";
import Markdown from "../components/md.jsx";
import { backendMeta, modelName } from "../derive.js";
import { fetchCategories, prewarmChat, streamChat } from "./api.js";
import { ErrorNote, inputCls, usePersisted } from "./ui.jsx";

const TOOL_LABELS = {
  web_search: "Web検索", fetch_url: "ページ取得", write_file: "ファイル作成", edit_file: "ファイル編集",
  read_file: "ファイル読込", list_dir: "一覧", search_files: "ファイル内検索",
};
// 次の発言で続きの作業ができるよう、作ったファイル名を履歴の本文に添える(中身は送らない)
const forModel = ({ role, content, files }) => ({
  role, content: files?.length ? `${content}

[作成したファイル: ${files.map((f) => f.path).join(", ")}]` : content,
});

const newConv = () => ({ id: crypto.randomUUID?.() ?? String(Date.now()), title: "新しい会話", messages: [], updated: Date.now() });

export default function ChatView() {
  const [convs, setConvs] = usePersisted("hub.chat.convs", []);
  const [currentId, setCurrentId] = usePersisted("hub.chat.current", null);
  const [model, setModel] = usePersisted("hub.chat.model", "auto");
  const [think, setThink] = usePersisted("hub.chat.think", false);
  const [tools, setTools] = usePersisted("hub.chat.tools", true);
  const [catalog, setCatalog] = useState(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [listOpen, setListOpen] = useState(false);
  const abortRef = useRef(null);
  const endRef = useRef(null);

  useEffect(() => { fetchCategories().then(setCatalog).catch((e) => setError(e.message)); }, []);
  useEffect(() => { prewarmChat(model).catch(() => { /* 先読み失敗は送信時に改めて表示される */ }); }, [model]);
  const conv = convs.find((c) => c.id === currentId) ?? null;
  const sorted = useMemo(() => [...convs].sort((a, b) => b.updated - a.updated), [convs]);
  // 選択肢は接続先ごとにまとめ、用途の説明はツールチップへ回して一覧を短くする
  const chatGroups = useMemo(() => {
    const groups = new Map();
    for (const m of catalog?.chat_models ?? []) {
      const label = backendMeta(m).short;
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(m);
    }
    return [...groups];
  }, [catalog]);
  // 保存済みの選択が選択肢から消えていたら(非表示化など)、表示と送信先を揃えるため auto に戻す
  useEffect(() => {
    if (catalog && model !== "auto" && !catalog.chat_models?.some((m) => m.key === model)) setModel("auto");
  }, [catalog, model, setModel]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [conv?.messages]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const patch = (id, fn) => setConvs((cs) => cs.map((c) => (c.id === id ? { ...fn(c), updated: Date.now() } : c)));

  async function send(history) {
    let target = conv;
    if (!target) {
      target = newConv();
      setConvs((cs) => [target, ...cs].slice(0, 100));
      setCurrentId(target.id);
    }
    const id = target.id;
    const assistant = { role: "assistant", content: "", thinking: "", meta: null };
    const title = target.messages.length ? target.title : history[0].content.slice(0, 30);
    setConvs((cs) => cs.map((c) => (c.id === id ? { ...c, title, messages: [...history, assistant], updated: Date.now() } : c)));
    setBusy(true);
    setError("");
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const update = (fn) => patch(id, (c) => {
      const ms = [...c.messages];
      ms[ms.length - 1] = fn(ms[ms.length - 1]);
      return { ...c, messages: ms };
    });
    try {
      await streamChat(
        { messages: history.map(forModel), model, think, tools, conv: id },
        (ev) => {
          if (ev.error) throw new Error(ev.error);
          if (ev.model) update((m) => ({ ...m, model: ev.model, tag: ev.tag }));
          if (ev.thinking) update((m) => ({ ...m, thinking: m.thinking + ev.thinking }));
          if (ev.content) update((m) => ({ ...m, content: m.content + ev.content }));
          if (ev.tool) update((m) => ({ ...m, steps: [...(m.steps ?? []), ev.tool] }));
          if (ev.tool_result) update((m) => ({ ...m, steps: m.steps.map((s) => (s.id === ev.tool_result.id ? { ...s, ...ev.tool_result, done: true } : s)) }));
          if (ev.file) update((m) => ({ ...m, files: [...(m.files ?? []).filter((f) => f.path !== ev.file.path), ev.file] }));
          if (ev.done) update((m) => ({ ...m, meta: ev.meta }));
        },
        ctrl.signal,
      );
    } catch (e) {
      if (e.name !== "AbortError") setError(e.message);
      else update((m) => ({ ...m, stopped: true }));
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  function submit() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    send([...(conv?.messages ?? []).filter((m) => m.content || m.files?.length), { role: "user", content: text }]);
  }

  function regenerate() {
    if (!conv || busy) return;
    const ms = conv.messages;
    const lastUser = ms.map((m) => m.role).lastIndexOf("user");
    if (lastUser >= 0) send(ms.slice(0, lastUser + 1));
  }

  const startNew = () => { setCurrentId(null); setListOpen(false); setError(""); };
  // 会話はこのブラウザにしか無く消すと戻せないので2段階(1回目で「削除?」→3秒以内にもう一度)
  const [armed, setArmed] = useState(null);
  useEffect(() => {
    if (!armed) return undefined;
    const t = setTimeout(() => setArmed(null), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  const remove = (id) => {
    if (armed !== id) return setArmed(id);
    setArmed(null);
    setConvs((cs) => cs.filter((c) => c.id !== id));
    if (id === currentId) setCurrentId(null);
  };

  return (
    <div className="flex h-full">
      <aside className={`${listOpen ? "fixed inset-0 z-30 flex" : "hidden"} w-full flex-col border-r border-slate-800 bg-slate-950 md:static md:flex md:w-64`}>
        <div className="flex items-center gap-2 p-3">
          <button type="button" onClick={startNew} className="flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 text-sm text-emerald-200 hover:bg-emerald-500/20">
            <Plus size={16} aria-hidden="true" /> 新しい会話
          </button>
          <button type="button" onClick={() => setListOpen(false)} className="min-h-10 rounded-lg px-3 text-slate-400 md:hidden" aria-label="一覧を閉じる">×</button>
        </div>
        <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
          {sorted.map((c) => (
            <li key={c.id} className="group flex items-center">
              <button
                type="button"
                onClick={() => { setCurrentId(c.id); setListOpen(false); }}
                className={`min-h-10 flex-1 truncate rounded-lg px-3 text-left text-sm ${c.id === currentId ? "bg-slate-800 text-slate-100" : "text-slate-400 hover:bg-slate-900"}`}
              >
                {c.title}
              </button>
              <button type="button" onClick={() => remove(c.id)} className={`min-h-10 px-2 text-xs ${armed === c.id ? "font-semibold text-red-300" : "text-slate-600 opacity-0 hover:text-red-300 group-hover:opacity-100 focus:opacity-100"}`} aria-label={armed === c.id ? `もう一度押すと「${c.title}」を削除` : `「${c.title}」を削除`}>
                {armed === c.id ? "削除?" : <Trash2 size={14} aria-hidden="true" />}
              </button>
            </li>
          ))}
          {!sorted.length && <li className="px-3 py-2 text-xs text-slate-500">会話はこのブラウザに保存されます</li>}
        </ul>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-2 border-b border-slate-800 px-3 py-2">
          <button type="button" onClick={() => setListOpen(true)} className="min-h-10 rounded-lg px-2 text-slate-400 md:hidden" aria-label="会話一覧">
            <Menu size={18} aria-hidden="true" />
          </button>
          <h1 className="mr-auto truncate text-sm font-semibold text-emerald-200">{conv?.title ?? "チャット"}</h1>
          <label className="sr-only" htmlFor="chat-model">モデル</label>
          <select id="chat-model" value={model} onChange={(e) => setModel(e.target.value)} className="min-h-10 max-w-[14rem] rounded-lg border border-slate-700 bg-slate-900 px-2 text-xs text-slate-200">
            <option value="auto">自動（{catalog?.categories?.chat?.model ?? "既定"}）</option>
            {chatGroups.map(([label, ms]) => (
              <optgroup key={label} label={label}>
                {ms.map((m) => <option key={m.key} value={m.key} title={m.for}>{modelName(m)}</option>)}
              </optgroup>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setTools((v) => !v)}
            aria-pressed={tools}
            className={`flex min-h-10 items-center gap-1 rounded-lg border px-2.5 text-xs ${tools ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200" : "border-slate-700 text-slate-400"}`}
            title="オンでファイル作成・Web検索・ページ取得を実際に行う（ツール対応モデルのみ）"
          >
            <Wrench size={14} aria-hidden="true" /> ツール{tools ? "あり" : "なし"}
          </button>
          <button
            type="button"
            onClick={() => setThink((v) => !v)}
            aria-pressed={think}
            className={`flex min-h-10 items-center gap-1 rounded-lg border px-2.5 text-xs ${think ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200" : "border-slate-700 text-slate-400"}`}
            title="オンで考えてから答える（遅いが難問に強い）"
          >
            <Brain size={14} aria-hidden="true" /> 思考{think ? "あり" : "なし"}
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl space-y-5 px-4 py-6">
            {!conv?.messages.length && (
              <div className="pt-16 text-center">
                <p className="text-lg font-semibold text-slate-100">何でも聞いてください</p>
                <p className="mt-1 text-sm text-slate-500">ローカルLLMと会話します。「ツールあり」ならファイル作成やWeb調査も実際に行います。</p>
              </div>
            )}
            {conv?.messages.map((m, i) => (
              <Message key={i} m={m} last={i === conv.messages.length - 1} busy={busy} onRegenerate={regenerate} />
            ))}
            <div ref={endRef} />
          </div>
        </div>

        <div className="border-t border-slate-800 p-3">
          <div className="mx-auto max-w-3xl space-y-2">
            <ErrorNote text={error} onClose={() => setError("")} />
            <div className="flex items-end gap-2">
              <label htmlFor="chat-input" className="sr-only">メッセージ</label>
              <textarea
                id="chat-input"
                rows={Math.min(8, Math.max(1, input.split("\n").length))}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }}
                placeholder="メッセージ（Enter で送信 / Shift+Enter で改行）"
                className={`${inputCls} resize-none focus:ring-emerald-500/50`}
              />
              {busy ? (
                <button type="button" onClick={() => abortRef.current?.abort()} className="flex min-h-10 min-w-10 items-center justify-center rounded-lg bg-slate-700 text-white hover:bg-slate-600" aria-label="停止">
                  <Square size={16} aria-hidden="true" />
                </button>
              ) : (
                <button type="button" onClick={submit} disabled={!input.trim()} className="flex min-h-10 min-w-10 items-center justify-center rounded-lg bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-40" aria-label="送信">
                  <Send size={16} aria-hidden="true" />
                </button>
              )}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function Message({ m, last, busy, onRegenerate }) {
  if (m.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-emerald-700/40 px-4 py-2 text-sm text-slate-100">{m.content}</div>
      </div>
    );
  }
  const streaming = last && busy;
  const tps = m.meta?.eval_count && m.meta?.elapsed_sec ? (m.meta.eval_count / m.meta.elapsed_sec).toFixed(1) : null;
  return (
    <div className="space-y-2">
      {m.thinking && (
        <details className="rounded-lg border border-slate-800 bg-slate-900/50 px-3 py-2 text-xs text-slate-400">
          <summary className="cursor-pointer select-none">思考過程（{m.thinking.length}字）</summary>
          <p className="mt-2 whitespace-pre-wrap">{m.thinking}</p>
        </details>
      )}
      {m.steps?.length > 0 && (
        <ul className="space-y-1 rounded-lg border border-slate-800 bg-slate-900/50 px-3 py-2 text-xs text-slate-400">
          {m.steps.map((s) => (
            <li key={s.id} className="flex items-center gap-2" title={s.summary}>
              {!s.done ? <Loader2 size={12} className={streaming ? "animate-spin" : ""} aria-hidden="true" />
                : s.ok ? <Check size={12} className="text-emerald-400" aria-hidden="true" />
                  : <X size={12} className="text-red-400" aria-hidden="true" />}
              <span className="shrink-0 text-slate-300">{TOOL_LABELS[s.name] ?? s.name}</span>
              <span className="truncate">{s.done && !s.ok ? s.summary : s.label}</span>
            </li>
          ))}
        </ul>
      )}
      {m.files?.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {m.files.map((f) => (
            <a key={f.path} href={f.url} target="_blank" rel="noreferrer" className="flex min-h-8 items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2.5 text-xs text-emerald-200 hover:bg-emerald-500/20">
              <FileText size={13} aria-hidden="true" /> {f.path}
            </a>
          ))}
        </div>
      )}
      {m.content ? <Markdown text={m.content} className="text-sm leading-relaxed text-slate-200" /> : streaming && <p className="soft-pulse text-sm text-slate-500">考え中…</p>}
      {!streaming && (
        <div className="flex items-center gap-3 text-[11px] text-slate-500">
          {m.tag && <span>{m.tag}</span>}
          {tps && <span>{m.meta.elapsed_sec}秒 · {tps} tok/s</span>}
          {m.stopped && <span className="text-amber-400">停止しました</span>}
          {m.content && (
            <CopyButton text={m.content} />
          )}
          {last && (
            <button type="button" onClick={onRegenerate} className="flex min-h-8 items-center gap-1 hover:text-slate-300">
              <RotateCcw size={12} aria-hidden="true" /> 再生成
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// 押したら「コピーしました」/失敗を見せる(以前は押しても何も変わらなかった)
function CopyButton({ text }) {
  const [state, setState] = useState("");
  useEffect(() => {
    if (!state) return undefined;
    const t = setTimeout(() => setState(""), 1500);
    return () => clearTimeout(t);
  }, [state]);
  const copy = () => Promise.resolve(navigator.clipboard?.writeText(text))
    .then(() => setState(navigator.clipboard ? "ok" : "ng"), () => setState("ng"));
  return (
    <button type="button" onClick={copy} className="flex min-h-8 items-center gap-1 hover:text-slate-300">
      {state === "ok" ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
      <span role="status">{state === "ok" ? "コピーしました" : state === "ng" ? "コピーできませんでした" : "コピー"}</span>
    </button>
  );
}
