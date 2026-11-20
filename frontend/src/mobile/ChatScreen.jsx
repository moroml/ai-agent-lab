// スマホ版のチャット。状態と送受信は hub/useChat.js (PC版と共用・会話も同じ保存先)。
// スマホのキーボードでは Enter は改行にし、送信は右下のボタンで行う。
import { useEffect, useRef, useState } from "react";
import { Brain, Check, Copy, EyeOff, FileText, Menu, MessageSquare, RotateCcw, SendHorizontal, SlidersHorizontal, Square, SquarePen, Terminal, Trash2, Wrench, X } from "lucide-react";
import Markdown from "../components/md.jsx";
import { FileMedia, mediaKind } from "../components/FileMedia.jsx";
import { modelName } from "../derive.js";
import { TOOL_LABELS, useChat } from "../hub/useChat.js";
import { Button, cx, Empty, Field, IconButton, inputCls, Notice, Sheet, Spinner, SwitchRow } from "./ui.jsx";

export default function ChatScreen() {
  const chat = useChat();
  const { conv, sorted, currentId, secret, armed, catalog, chatGroups, model, think, tools, input, busy, error } = chat;
  const [listOpen, setListOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const logRef = useRef(null);
  const stick = useRef(true);   // 下端付近を見ているときだけ、新しい文に追従する

  useEffect(() => {
    const el = logRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [conv?.messages]);
  const onScroll = (e) => {
    const el = e.currentTarget;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };
  const submit = () => { stick.current = true; chat.submit(); };

  // 読み上げ用: 本文は逐次読ませず、開始と終了だけ知らせる
  const last = conv?.messages.at(-1);
  const live = busy ? "回答を作っています" : last?.stopped ? "停止しました" : last?.role === "assistant" && last.content ? "回答が届きました" : "";

  return (
    <div className="flex h-full flex-col">
      <header className="flex min-h-14 shrink-0 items-center gap-1 border-b border-m-line px-1">
        <IconButton label="会話の一覧" icon={Menu} onClick={() => setListOpen(true)} />
        <h1 className="flex min-w-0 flex-1 items-center gap-2 text-xl font-semibold">
          {secret && <EyeOff size={18} aria-hidden="true" className="shrink-0 text-m-primary" />}
          <span className="truncate">{secret ? "シークレット" : conv?.title ?? "チャット"}</span>
        </h1>
        <IconButton label="チャットの設定" icon={SlidersHorizontal} onClick={() => setSettingsOpen(true)} />
        <IconButton label="新しい会話" icon={SquarePen} onClick={() => { stick.current = true; chat.startNew(); }} />
      </header>

      <div ref={logRef} onScroll={onScroll} role="log" aria-label="会話" className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">
        {!conv?.messages.length ? (
          <Empty
            icon={secret ? EyeOff : MessageSquare}
            title={secret ? "この会話は履歴に残りません" : "何でも聞いてください"}
            hint={secret
              ? "解除・新しい会話・再読み込みで、作成したファイルごと消えます。"
              : tools ? "ファイルの作成やWebの調査も、PCが実際に行います。" : "PCのローカルLLMが答えます。"}
          />
        ) : (
          <div className="space-y-6">
            {conv.messages.map((m, i) => (
              <Message key={i} m={m} last={i === conv.messages.length - 1} busy={busy} onRegenerate={chat.regenerate} onApprove={chat.answerApproval} />
            ))}
          </div>
        )}
      </div>
      <p role="status" className="sr-only">{live}</p>

      <div className="shrink-0 space-y-2 border-t border-m-line bg-m-surface px-3 pt-2 pb-2">
        <Notice tone="error" onClose={() => chat.setError("")}>{error}</Notice>
        <div className="flex items-end gap-2">
          <label htmlFor="m-chat-input" className="sr-only">メッセージ</label>
          <textarea
            id="m-chat-input"
            rows={Math.min(6, Math.max(1, input.split("\n").length))}
            value={input}
            onChange={(e) => chat.setInput(e.target.value)}
            enterKeyHint="enter"
            placeholder="メッセージ"
            className={cx(inputCls, "max-h-[40dvh] resize-none")}
          />
          {busy ? (
            <button type="button" onClick={chat.stop} aria-label="生成を止める"
                    className="flex size-12 shrink-0 items-center justify-center rounded-xl border border-m-line-strong bg-m-surface text-m-fg active:bg-m-sunken">
              <Square size={20} aria-hidden="true" />
            </button>
          ) : (
            <button type="button" onClick={submit} disabled={!input.trim()} aria-label="送信"
                    className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-m-primary text-m-on-primary active:bg-m-primary-hover disabled:opacity-40">
              <SendHorizontal size={22} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      <Sheet open={listOpen} onClose={() => setListOpen(false)} title="会話"
             footer={<Button variant="primary" icon={SquarePen} className="w-full" onClick={() => { chat.startNew(); setListOpen(false); }}>新しい会話</Button>}>
        {secret ? (
          <p className="text-sm text-m-muted">シークレット中は、保存済みの会話を開けません。設定でシークレットを切ると一覧に戻ります。</p>
        ) : !sorted.length ? (
          <Empty icon={MessageSquare} title="会話はまだありません" hint="会話はこのブラウザに保存されます。" />
        ) : (
          <ul className="-mx-2">
            {sorted.map((c) => (
              <li key={c.id} className="flex items-center">
                <button type="button" onClick={() => { stick.current = true; chat.select(c.id); setListOpen(false); }}
                        aria-current={c.id === currentId ? "true" : undefined}
                        className={cx("min-h-12 min-w-0 flex-1 truncate rounded-xl px-3 text-left text-base", c.id === currentId ? "bg-m-primary-soft font-semibold text-m-fg" : "text-m-fg active:bg-m-sunken")}>
                  {c.title}
                </button>
                {armed === c.id ? (
                  <button type="button" onClick={() => chat.remove(c.id)} className="min-h-12 shrink-0 rounded-xl px-3 text-sm font-semibold text-m-danger">
                    削除する
                  </button>
                ) : (
                  <IconButton label={`「${c.title}」を削除`} icon={Trash2} onClick={() => chat.remove(c.id)} />
                )}
              </li>
            ))}
          </ul>
        )}
      </Sheet>

      <Sheet open={settingsOpen} onClose={() => setSettingsOpen(false)} title="チャットの設定">
        <Field label="モデル">
          <select value={model} onChange={(e) => chat.setModel(e.target.value)} className={inputCls}>
            <option value="auto">自動（{catalog?.categories?.chat?.model ?? "既定"}）</option>
            {chatGroups.map(([label, ms]) => (
              <optgroup key={label} label={label}>
                {ms.map((m) => <option key={m.key} value={m.key}>{modelName(m)}</option>)}
              </optgroup>
            ))}
          </select>
        </Field>
        <div className="mt-4 divide-y divide-m-line">
          <SwitchRow icon={Wrench} label="ツールを使う" hint="ファイルの作成・Web検索・ページの取得を実際に行う" checked={tools} onChange={chat.setTools} />
          <SwitchRow icon={Terminal} label="コマンド実行" disabled={!tools || !chat.canCommands}
                     hint={chat.canCommands ? "作業フォルダ内で実行。実行のたびにここで承認する" : "このPCの画面からだけ使えます"}
                     checked={tools && chat.commands && chat.canCommands} onChange={chat.setCommands} />
          <SwitchRow icon={Brain} label="考えてから答える" hint="遅くなるが、難しい質問に強い" checked={think} onChange={chat.setThink} />
          <SwitchRow icon={EyeOff} label="シークレット" hint="会話を保存せず、終えるときに作成ファイルごと消す" checked={!!secret}
                     onChange={(on) => { stick.current = true; chat.resetSecret(on); }} />
        </div>
      </Sheet>
    </div>
  );
}

function Message({ m, last, busy, onRegenerate, onApprove }) {
  if (m.role === "user") {
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-m-primary-soft px-4 py-2 text-base text-m-fg">{m.content}</p>
      </div>
    );
  }
  const streaming = last && busy;
  const tps = m.meta?.eval_count && m.meta?.elapsed_sec ? (m.meta.eval_count / m.meta.elapsed_sec).toFixed(1) : null;
  return (
    <div className="space-y-2">
      {m.thinking && (
        <details className="rounded-xl bg-m-sunken px-3 py-2 text-sm text-m-muted">
          <summary className="flex min-h-8 cursor-pointer items-center">考えた過程（<span className="m-num">{m.thinking.length}</span>字）</summary>
          <p className="mt-2 whitespace-pre-wrap">{m.thinking}</p>
        </details>
      )}
      {m.steps?.length > 0 && (
        <ul className="space-y-1 rounded-xl bg-m-sunken px-3 py-2 text-sm text-m-muted">
          {m.steps.map((s) => (
            <li key={s.id}>
              <div className="flex items-center gap-2">
                {!s.done ? (streaming ? <Spinner size={14} /> : <X size={14} aria-hidden="true" className="shrink-0 text-m-subtle" />)
                  : s.ok ? <Check size={14} aria-hidden="true" className="shrink-0 text-m-primary" />
                    : <X size={14} aria-hidden="true" className="shrink-0 text-m-danger" />}
                <span className="shrink-0 text-m-fg">{TOOL_LABELS[s.name] ?? s.name}</span>
                <span className="min-w-0 truncate">{s.done && !s.ok ? s.summary : s.label}</span>
              </div>
              {s.approval && streaming && (
                <div role="group" aria-label="コマンドの承認" className="mt-2 space-y-2 rounded-xl border border-m-warning bg-m-warning-soft p-3 text-m-fg">
                  <p>このコマンドを実行しますか？（作業フォルダ: {s.approval.working_dir}）</p>
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-m-sunken p-2 text-sm">{s.approval.command}</pre>
                  <div className="flex gap-2">
                    <Button variant="primary" className="flex-1" onClick={() => onApprove(s.approval.id, true)}>実行</Button>
                    <Button className="flex-1" onClick={() => onApprove(s.approval.id, false)}>拒否</Button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {m.files?.length > 0 && (
        <div className="space-y-2">
          {m.files.filter((f) => mediaKind(f.path)).map((f) => <FileMedia key={f.path} file={f} className="rounded-xl border border-m-line" />)}
          <div className="flex flex-wrap gap-2">
            {m.files.map((f) => (
              <a key={f.path} href={f.url} target="_blank" rel="noreferrer"
                 className="flex min-h-12 max-w-full items-center gap-2 rounded-xl border border-m-line-strong px-3 text-sm font-semibold text-m-primary">
                <FileText size={18} aria-hidden="true" className="shrink-0" /> <span className="truncate">{f.path}</span>
              </a>
            ))}
          </div>
        </div>
      )}
      {m.content
        ? <Markdown text={m.content} className="m-md" />
        : streaming && <p className="m-pulse flex items-center gap-2 text-sm text-m-muted"><Spinner /> 回答を作っています…</p>}
      {!streaming && (
        <div className="flex flex-wrap items-center gap-x-1 text-sm text-m-subtle">
          <span className="m-num mr-auto min-w-0 truncate py-2 text-xs">
            {m.tag}{tps && ` · ${m.meta.elapsed_sec}秒 · ${tps} tok/s`}
          </span>
          {m.stopped && <span className="text-m-warning">停止しました</span>}
          {m.content && <CopyButton text={m.content} />}
          {last && (
            <button type="button" onClick={onRegenerate} className="flex min-h-11 items-center gap-1 rounded-lg px-2 text-m-muted active:bg-m-sunken">
              <RotateCcw size={16} aria-hidden="true" /> 作り直す
            </button>
          )}
        </div>
      )}
    </div>
  );
}

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
    <button type="button" onClick={copy} className="flex min-h-11 items-center gap-1 rounded-lg px-2 text-m-muted active:bg-m-sunken">
      {state === "ok" ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
      <span role="status">{state === "ok" ? "コピーしました" : state === "ng" ? "コピーできません" : "コピー"}</span>
    </button>
  );
}
