// チャット: Run を作らない会話専用の画面。状態と送受信は useChat.js (スマホ版と共用)。
import { useEffect, useRef, useState } from "react";
import { Brain, Check, Copy, EyeOff, FileText, Loader2, Menu, Paperclip, Plus, RotateCcw, Send, Square, Terminal, Trash2, Wrench, X } from "lucide-react";
import Markdown from "../components/md.jsx";
import { FileMedia, mediaKind } from "../components/FileMedia.jsx";
import { modelName } from "../derive.js";
import { ErrorNote, inputCls } from "./ui.jsx";
import { AttachBar, DropZone, useAttach } from "../components/Attach.jsx";
import { TOOL_LABELS, useChat } from "./useChat.js";

export default function ChatView() {
  const att = useAttach();
  const chat = useChat(att);
  const { conv, sorted, currentId, secret, armed, remove, catalog, chatGroups, model, setModel, think, setThink, tools, setTools, commands, setCommands, canCommands, answerApproval,
          input, setInput, busy, error, setError, submit, regenerate } = chat;
  const [listOpen, setListOpen] = useState(false);
  const endRef = useRef(null);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [conv?.messages]);
  const startNew = () => { chat.startNew(); setListOpen(false); };
  const resetSecret = (on) => { chat.resetSecret(on); setListOpen(false); };
  const setCurrentId = chat.select;

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
          {secret && <li className="px-3 py-2 text-xs leading-relaxed text-violet-300">シークレット中です。この会話は保存されず、解除・新しい会話・再読み込みで、添付や作成ファイルごと消えます。</li>}
          {!secret && sorted.map((c) => (
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
          {!secret && !sorted.length && <li className="px-3 py-2 text-xs text-slate-500">会話はこのブラウザに保存されます</li>}
        </ul>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-2 border-b border-slate-800 px-3 py-2">
          <button type="button" onClick={() => setListOpen(true)} className="min-h-10 rounded-lg px-2 text-slate-400 md:hidden" aria-label="会話一覧">
            <Menu size={18} aria-hidden="true" />
          </button>
          <h1 className="mr-auto truncate text-sm font-semibold text-emerald-200">{secret ? "シークレット" : conv?.title ?? "チャット"}</h1>
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
            onClick={() => resetSecret(!secret)}
            aria-pressed={!!secret}
            className={`flex min-h-10 items-center gap-1 rounded-lg border px-2.5 text-xs ${secret ? "border-violet-500/40 bg-violet-500/10 text-violet-200" : "border-slate-700 text-slate-400"}`}
            title="オンの間の会話は履歴に保存せず、解除や再読み込みで添付・作成ファイルごと消す"
          >
            <EyeOff size={14} aria-hidden="true" /> シークレット
          </button>
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
            onClick={() => setCommands((v) => !v)}
            aria-pressed={tools && commands && canCommands}
            disabled={!tools || !canCommands}
            className={`flex min-h-10 items-center gap-1 rounded-lg border px-2.5 text-xs disabled:opacity-40 ${tools && commands && canCommands ? "border-amber-500/40 bg-amber-500/10 text-amber-200" : "border-slate-700 text-slate-400"}`}
            title={canCommands ? "オンで作業フォルダ内のコマンド実行を許す（実行のたびにここで承認）" : "コマンド実行はこのPCの画面からだけ使えます"}
          >
            <Terminal size={14} aria-hidden="true" /> コマンド{tools && commands && canCommands ? "あり" : "なし"}
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
                <p className="text-lg font-semibold text-slate-100">{secret ? "シークレットモード" : "何でも聞いてください"}</p>
                <p className="mt-1 text-sm text-slate-500">{secret && "この会話は履歴に残りません。"}ローカルLLMと会話します。「ツールあり」ならファイル作成やWeb調査も実際に行います。</p>
              </div>
            )}
            {conv?.messages.map((m, i) => (
              <Message key={i} m={m} last={i === conv.messages.length - 1} busy={busy} onRegenerate={regenerate} onApprove={answerApproval} />
            ))}
            <div ref={endRef} />
          </div>
        </div>

        <DropZone att={att} className="border-t border-slate-800 p-3">
          <div className="mx-auto max-w-3xl space-y-2">
            <ErrorNote text={error} onClose={() => setError("")} />
            <AttachBar att={att} disabled={busy} />
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
                <button type="button" onClick={chat.stop} className="flex min-h-10 min-w-10 items-center justify-center rounded-lg bg-slate-700 text-white hover:bg-slate-600" aria-label="停止">
                  <Square size={16} aria-hidden="true" />
                </button>
              ) : (
                <button type="button" onClick={submit} disabled={(!input.trim() && !att.ready) || att.busy} className="flex min-h-10 min-w-10 items-center justify-center rounded-lg bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-40" aria-label="送信">
                  <Send size={16} aria-hidden="true" />
                </button>
              )}
            </div>
          </div>
        </DropZone>
      </section>
    </div>
  );
}

function Message({ m, last, busy, onRegenerate, onApprove }) {
  if (m.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-emerald-700/40 px-4 py-2 text-sm text-slate-100">
          {m.content}
          {m.attach?.files?.length > 0 && (
            <p className="mt-1 flex items-center gap-1 text-xs text-emerald-200/80">
              <Paperclip size={12} aria-hidden="true" />
              添付 {[...new Set(m.attach.files.map((f) => f.path.split("/")[0]))].join("、")}（{m.attach.files.length}件）
            </p>
          )}
        </div>
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
            <li key={s.id} title={s.summary}>
              <div className="flex items-center gap-2">
                {!s.done ? <Loader2 size={12} className={streaming ? "animate-spin" : ""} aria-hidden="true" />
                  : s.ok ? <Check size={12} className="text-emerald-400" aria-hidden="true" />
                    : <X size={12} className="text-red-400" aria-hidden="true" />}
                <span className="shrink-0 text-slate-300">{TOOL_LABELS[s.name] ?? s.name}</span>
                <span className="truncate">{s.done && !s.ok ? s.summary : s.label}</span>
              </div>
              {s.approval && streaming && (
                <div role="group" aria-label="コマンドの承認" className="mt-1.5 space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5">
                  <p className="text-amber-200">このコマンドを実行しますか？（作業フォルダ: {s.approval.working_dir}）</p>
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-slate-950 p-2 text-slate-200">{s.approval.command}</pre>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => onApprove(s.approval.id, true)} className="min-h-9 rounded-lg bg-emerald-600 px-3 text-white hover:bg-emerald-500">実行</button>
                    <button type="button" onClick={() => onApprove(s.approval.id, false)} className="min-h-9 rounded-lg border border-slate-600 px-3 text-slate-200 hover:bg-slate-800">拒否</button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {m.files?.length > 0 && (
        <div className="space-y-2">
          {m.files.filter((f) => mediaKind(f.path)).map((f) => <FileMedia key={f.path} file={f} className="rounded-lg border border-slate-800" />)}
          <div className="flex flex-wrap gap-2">
            {m.files.map((f) => (
              <a key={f.path} href={f.url} target="_blank" rel="noreferrer" className="flex min-h-8 items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2.5 text-xs text-emerald-200 hover:bg-emerald-500/20">
                <FileText size={13} aria-hidden="true" /> {f.path}
              </a>
            ))}
          </div>
        </div>
      )}
      {m.content ? <Markdown text={m.content} className="text-sm leading-relaxed text-slate-200" /> : streaming && <p className="soft-pulse text-sm text-slate-500">考え中…</p>}
      {!streaming && (
        <div className="flex items-center gap-3 text-[11px] text-slate-500">
          {m.tag && <span>{m.tag}</span>}
          {tps && <span>{m.meta.elapsed_sec}秒 · {tps} tok/s</span>}
          {m.retried && <span className="text-violet-300">拒否されたため答え直しました</span>}
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
