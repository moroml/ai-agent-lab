import { useCallback, useEffect, useRef, useState } from "react";
import { File as FileIcon, Folder, FolderUp, Loader2, Paperclip, Search, X } from "lucide-react";
import { attachLocal, removeAttach, searchFiles, uploadAttach } from "../api.js";

/**
 * チャット・エージェントへのファイル/フォルダ添付。ドラッグ&ドロップ・選択・PC 内検索の3通り。
 * 取り込んだものはサーバーの一時置き場 (batch) に集め、送信時に作業フォルダの inputs/ へ写される。
 * 本文に付ける説明 (describe) もサーバーが作る。
 */
export function useAttach() {
  const [state, setState] = useState(null);   // { batch, files:[{path,size}], describe }
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState({ text: "", error: false });
  const batchRef = useRef(null);
  batchRef.current = state?.batch ?? null;

  // 取り込みは1つずつ順に行う(重ねてドロップしたとき、後の応答で先の添付が一覧から消えないように)
  const queue = useRef(Promise.resolve());
  const run = useCallback((fn) => {
    queue.current = queue.current.then(async () => {
      setBusy(true);
      setMsg({ text: "", error: false });
      try {
        const r = await fn(batchRef.current);
        batchRef.current = r.batch;
        setState(r);
        if (r.skipped?.length) setMsg({ text: `鍵・認証情報らしいため除外: ${r.skipped.join(", ")}`, error: false });
      } catch (e) {
        setMsg({ text: e.message, error: true });
      } finally {
        setBusy(false);
      }
    });
    return queue.current;
  }, []);

  const addFiles = useCallback((list) => list.length && run((b) => uploadAttach(list, b)), [run]);
  const addLocal = useCallback((paths) => run((b) => attachLocal(paths, b)), [run]);
  const remove = useCallback((path) => run((b) => removeAttach(b, path)), [run]);   // フォルダもパス1つで外せる
  const clear = useCallback(() => { batchRef.current = null; setState(null); setMsg({ text: "", error: false }); }, []);
  const ready = !!state?.files?.length;
  return { state, ready, busy, msg, addFiles, addLocal, remove, clear };
}

/** モデルへ渡す本文: 入力文 + 添付の説明 */
export const withAttach = (text, att) => (att?.ready ? `${text}\n\n${att.state.describe}` : text);

// ---- ドロップされた項目を {file, path} の並びへ (フォルダは中身を再帰で読む) ----
async function readEntry(entry, prefix, out) {
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    out.push({ file, path: prefix + entry.name });
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;   // readEntries は一度に全部返さないので空になるまで読む
      for (const e of batch) await readEntry(e, `${prefix}${entry.name}/`, out);
    }
  }
}

export async function filesFromDrop(dt) {
  const entries = [...(dt.items ?? [])].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...(dt.files ?? [])].map((file) => ({ file, path: file.name }));
  const out = [];
  for (const e of entries) await readEntry(e, "", out);
  return out;
}

/** 子要素の上にファイルを落とすと添付する。ドラッグ中は枠と案内を出す */
export function DropZone({ att, children, className = "" }) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes("Files");
  return (
    <div
      className={`relative ${className}`}
      onDragEnter={(e) => { if (!hasFiles(e)) return; e.preventDefault(); depth.current += 1; setOver(true); }}
      onDragOver={(e) => { if (hasFiles(e)) e.preventDefault(); }}
      onDragLeave={() => { depth.current = Math.max(0, depth.current - 1); if (!depth.current) setOver(false); }}
      onDrop={async (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current = 0;
        setOver(false);
        att.addFiles(await filesFromDrop(e.dataTransfer));
      }}
    >
      {children}
      {over && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-xl border-2 border-dashed border-blue-400 bg-blue-500/10 text-sm font-semibold text-blue-200">
          ここにドロップして添付（フォルダも可）
        </div>
      )}
    </div>
  );
}

const fmtSize = (n) => (n == null ? "" : n < 1024 ? `${n} B` : n < 2 ** 20 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 2 ** 20).toFixed(1)} MB`);

/** 添付の操作行(ファイル・フォルダ・検索のボタン)と、添付済みの一覧 */
export function AttachBar({ att, disabled = false }) {
  const fileRef = useRef(null);
  const dirRef = useRef(null);
  const [searching, setSearching] = useState(false);
  useEffect(() => { if (!att.state) setSearching(false); }, [att.state]);   // 送信して添付が空になったら検索欄も閉じる
  const pick = (e) => {
    const list = [...e.target.files].map((file) => ({ file, path: file.webkitRelativePath || file.name }));
    e.target.value = "";
    att.addFiles(list);
  };
  // 一覧は先頭の階層でまとめる(フォルダを落とすと中身が何百件にもなるため)
  const groups = {};
  for (const f of att.state?.files ?? []) {
    const [head, ...rest] = f.path.split("/");
    const g = (groups[head] ??= { name: head, dir: rest.length > 0, count: 0, size: 0 });
    g.count += 1;
    g.size += f.size;
  }
  const btn = "flex min-h-8 items-center gap-1 rounded-md border border-slate-700 px-2 text-xs text-slate-300 hover:border-slate-500 hover:text-slate-100 disabled:opacity-50";
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <button type="button" className={btn} disabled={disabled || att.busy} onClick={() => fileRef.current?.click()}>
          <Paperclip size={13} aria-hidden="true" /> ファイル
        </button>
        <button type="button" className={btn} disabled={disabled || att.busy} onClick={() => dirRef.current?.click()}>
          <FolderUp size={13} aria-hidden="true" /> フォルダ
        </button>
        <button type="button" className={btn} disabled={disabled || att.busy} onClick={() => setSearching((v) => !v)} aria-expanded={searching}>
          <Search size={13} aria-hidden="true" /> PCから検索
        </button>
        <span className="text-xs text-slate-500">ドラッグ＆ドロップでも添付できます</span>
        {att.busy && <span role="status" className="flex items-center gap-1 text-xs text-slate-400"><Loader2 size={12} className="animate-spin" aria-hidden="true" /> 取り込み中…</span>}
        <input ref={fileRef} type="file" multiple hidden onChange={pick} />
        <input ref={dirRef} type="file" hidden webkitdirectory="" onChange={pick} />
      </div>
      {searching && <SearchBox att={att} onClose={() => setSearching(false)} />}
      {Object.values(groups).length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="添付">
          {Object.values(groups).map((g) => (
            <li key={g.name} className="flex items-center gap-1 rounded-full border border-blue-500/40 bg-blue-500/10 py-0.5 pl-2 pr-1 text-xs text-blue-100">
              {g.dir ? <Folder size={12} aria-hidden="true" /> : <FileIcon size={12} aria-hidden="true" />}
              <span className="max-w-48 truncate">{g.name}</span>
              <span className="text-blue-200/70">{g.dir ? `${g.count}件・` : ""}{fmtSize(g.size)}</span>
              <button type="button" onClick={() => att.remove(g.name)} disabled={att.busy}
                      className="rounded-full p-0.5 hover:bg-blue-500/30" aria-label={`${g.name} の添付を外す`}>
                <X size={12} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {att.msg.text && <p role={att.msg.error ? "alert" : "status"} className={`text-xs ${att.msg.error ? "text-red-400" : "text-amber-300"}`}>{att.msg.text}</p>}
    </div>
  );
}

/** PC 内をファイル名で検索して添付する */
function SearchBox({ att, onClose }) {
  const [q, setQ] = useState("");
  const [res, setRes] = useState(null);   // null=未検索 / {items, truncated, roots}
  const [state, setState] = useState("");  // "" / loading / error文
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setRes(null); setState(""); return undefined; }
    setState("loading");
    let alive = true;
    const t = setTimeout(() => searchFiles(term)
      .then((r) => { if (alive) { setRes(r); setState(""); } })
      .catch((e) => { if (alive) setState(e.message); }), 300);
    return () => { alive = false; clearTimeout(t); };
  }, [q]);
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900 p-2">
      <div className="flex items-center gap-2">
        <Search size={14} className="text-slate-500" aria-hidden="true" />
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Escape" && onClose()}
               placeholder="ファイル名・フォルダ名で検索（2文字以上・空白で AND）" aria-label="PC内のファイルを検索"
               className="min-w-0 flex-1 rounded bg-transparent text-sm text-slate-100 outline-none placeholder:text-slate-500 focus-visible:ring-2 focus-visible:ring-teal-500/50" />
        <button type="button" onClick={onClose} className="rounded p-1 text-slate-400 hover:text-slate-100" aria-label="検索を閉じる"><X size={14} aria-hidden="true" /></button>
      </div>
      {state === "loading" && <p role="status" className="mt-2 text-xs text-slate-400">検索しています…</p>}
      {state && state !== "loading" && <p role="alert" className="mt-2 text-xs text-red-400">{state}</p>}
      {res && !state && (
        <>
          <ul className="mt-2 max-h-56 overflow-y-auto">
            {res.items.map((it) => (
              <li key={it.path}>
                <button type="button" onClick={() => att.addLocal([it.path])} disabled={att.busy}
                        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-slate-800 disabled:opacity-50">
                  {it.dir ? <Folder size={13} className="shrink-0 text-amber-300" aria-hidden="true" /> : <FileIcon size={13} className="shrink-0 text-slate-400" aria-hidden="true" />}
                  <span className="shrink-0 text-slate-100">{it.name}</span>
                  <span className="min-w-0 flex-1 truncate text-slate-500">{it.path}</span>
                  <span className="shrink-0 text-slate-500">{fmtSize(it.size)}</span>
                </button>
              </li>
            ))}
            {!res.items.length && <li className="px-2 py-1.5 text-xs text-slate-400">見つかりませんでした</li>}
          </ul>
          <p className="mt-1 text-xs text-slate-500">
            {res.truncated ? "件数が多いため途中まで表示しています。語を足して絞り込んでください。" : ""}
            検索先: {res.roots.join(" / ")}
          </p>
        </>
      )}
    </div>
  );
}
