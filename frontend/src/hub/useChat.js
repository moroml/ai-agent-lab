// チャットの状態と送受信。PC版(ChatView)とスマホ版(mobile/ChatScreen)が同じものを使う。
// 会話はこのブラウザに保存する(サーバーには残さない)。シークレット中の会話はメモリにだけ置き、
// 終えるときにサーバーの作業フォルダも消す。
import { useEffect, useMemo, useRef, useState } from "react";
import { backendMeta } from "../derive.js";
import { withAttach } from "../components/Attach.jsx";
import { discardChat, fetchCategories, prewarmChat, streamChat } from "./api.js";
import { usePersisted } from "./ui.jsx";

// 次の発言で続きの作業ができるよう、作ったファイル名を履歴の本文に添える(中身は送らない)。
// 添付は説明(置き場所と小さいテキストの中身)を本文に足す
const forModel = ({ role, content, files, attach }) => {
  let text = withAttach(content, attach && { ready: true, state: attach });
  if (files?.length) text += `\n\n[作成したファイル: ${files.map((f) => f.path).join(", ")}]`;
  return { role, content: text };
};

// シークレット会話の ID は secret- で始める(hub.py がこの頭の作業フォルダだけを消す)
const newConv = (secret = false) => ({ id: (secret ? "secret-" : "") + (crypto.randomUUID?.() ?? String(Date.now())), title: "新しい会話", messages: [], updated: Date.now() });

/** att: 添付(useAttach の戻り値)。添付を使わない画面は省略する */
export function useChat(att = null) {
  const [convs, setConvs] = usePersisted("hub.chat.convs", []);
  const [currentId, setCurrentId] = usePersisted("hub.chat.current", null);
  const [model, setModel] = usePersisted("hub.chat.model", "auto");
  const [think, setThink] = usePersisted("hub.chat.think", false);
  const [tools, setTools] = usePersisted("hub.chat.tools", true);
  const [secret, setSecret] = useState(null);   // シークレット中の会話。一覧にも localStorage にも入れない
  const [catalog, setCatalog] = useState(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const abortRef = useRef(null);

  useEffect(() => { fetchCategories().then(setCatalog).catch((e) => setError(e.message)); }, []);
  useEffect(() => { prewarmChat(model).catch(() => { /* 先読み失敗は送信時に改めて表示される */ }); }, [model]);
  const conv = secret ?? convs.find((c) => c.id === currentId) ?? null;
  const sorted = useMemo(() => [...convs].sort((a, b) => b.updated - a.updated), [convs]);
  // 選択肢は接続先ごとにまとめる
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
  useEffect(() => () => abortRef.current?.abort(), []);
  // 画面を離れる・閉じる・再読み込みでもシークレット会話の作業フォルダを残さない
  const secretId = useRef(null);
  secretId.current = secret?.id ?? null;
  const pending = useRef(null);
  pending.current = att?.state?.batch ?? null;
  useEffect(() => {
    const drop = () => { if (secretId.current) discardChat(secretId.current, pending.current); };
    window.addEventListener("pagehide", drop);
    return () => { window.removeEventListener("pagehide", drop); drop(); };
  }, []);

  const patch = (id, fn) => {
    const next = (c) => (c?.id === id ? { ...fn(c), updated: Date.now() } : c);
    if (id.startsWith("secret-")) setSecret(next);
    else setConvs((cs) => cs.map(next));
  };
  // シークレットの切替と、シークレット中の「新しい会話」: 進行中の生成を止め、今のシークレット会話を未送信の入力・添付ごと捨てる
  const resetSecret = (on) => {
    abortRef.current?.abort();
    if (secret) {
      discardChat(secret.id, att?.state?.batch);
      att?.clear();
      setInput("");
    }
    setSecret(on ? newConv(true) : null);
    setError("");
  };

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
    patch(id, (c) => ({ ...c, title, messages: [...history, assistant] }));
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
        { messages: history.map(forModel), model, think, tools, conv: id, attach: history.at(-1)?.attach?.batch ?? null },
        (ev) => {
          if (ev.error) throw new Error(ev.error);
          // 回答が拒否で、無検閲モデルが答え直す: 書きかけの拒否文を消して受け直す
          if (ev.retry) update((m) => ({ ...m, content: "", thinking: "", steps: undefined, retried: true }));
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
    const text = input.trim() || (att?.ready ? "添付したファイルを確認してください" : "");
    if (!text || busy || att?.busy) return;
    setInput("");
    const attach = att?.ready ? { batch: att.state.batch, files: att.state.files, describe: att.state.describe } : undefined;
    att?.clear();
    send([...(conv?.messages ?? []).filter((m) => m.content || m.files?.length), { role: "user", content: text, attach }]);
  }

  function regenerate() {
    if (!conv || busy) return;
    const ms = conv.messages;
    const lastUser = ms.map((m) => m.role).lastIndexOf("user");
    if (lastUser >= 0) send(ms.slice(0, lastUser + 1));
  }

  const stop = () => abortRef.current?.abort();
  const select = (id) => setCurrentId(id);
  const startNew = () => { if (secret) return resetSecret(true); setCurrentId(null); setError(""); };
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

  return {
    conv, sorted, currentId, select, startNew, remove, armed,
    secret, resetSecret,
    catalog, chatGroups, model, setModel, think, setThink, tools, setTools,
    input, setInput, busy, error, setError, submit, regenerate, stop,
  };
}
