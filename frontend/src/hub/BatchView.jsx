// 音声の「一括書き出し」(PC版)。CSV の台詞を、1行ずつ音声ファイルにして ZIP でまとめて受け取る (ゲームの台詞など)。
import { useRef } from "react";
import { Download, FileUp, Package, Square, Trash2 } from "lucide-react";
import { Button, Chips, ErrorNote, Field, inputCls, Progress } from "./ui.jsx";
import { CSV_HELP, FORMATS, isRunning, useBatch } from "./useBatch.js";

const ring = "focus:ring-cyan-500/50";
const STATE = { running: "実行中", done: "完了", cancelled: "中止", error: "失敗" };
const FISH_NOTE = "Fish は非商用ライセンス。販売するゲームには使えません";

export default function BatchView({ s, active }) {
  const b = useBatch(s, active);
  const { form, set, engine, job, items } = b;
  const file = useRef(null);
  const running = isRunning(job);

  return (
    <div className="flex h-full flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
      <section className="space-y-4 p-4 lg:w-[440px] lg:shrink-0 lg:overflow-y-auto lg:border-r lg:border-slate-800">
        <h1 className="flex items-center gap-2 text-base font-semibold text-cyan-200"><Package size={18} aria-hidden="true" /> 一括書き出し</h1>

        <Field label="CSV" hint={`${b.rows}行`}>
          <textarea rows={9} value={form.csv} onChange={(e) => set("csv", e.target.value)} spellCheck={false}
                    placeholder={"line_001,おはようございます\nline_002,こんにちは,見本の名前,やさしく"} className={`${inputCls} font-mono leading-relaxed ${ring}`} />
        </Field>
        <div className="flex items-center gap-2">
          <input ref={file} type="file" accept=".csv,.txt,text/csv,text/plain" className="hidden" aria-label="CSV ファイル"
                 onChange={(e) => { const f = e.target.files[0]; e.target.value = ""; if (f) b.loadFile(f); }} />
          <Button variant="ghost" onClick={() => file.current.click()}><FileUp size={16} aria-hidden="true" /> .csv / .txt を読み込む</Button>
        </div>
        <p className="text-[11px] leading-relaxed text-slate-500">{CSV_HELP}</p>

        {s.info === undefined && <p role="status" className="text-sm text-slate-500">読み込んでいます…</p>}
        {s.info && engine && (
          <>
            <Field label="エンジン">
              <Chips accent="cyan" value={engine.key} onChange={(v) => set("engine", v)} options={s.info.engines.map((e) => ({ value: e.key, label: e.label }))} />
            </Field>
            {engine.key === "fish" && <p role="status" className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">{FISH_NOTE}</p>}

            <div className="grid grid-cols-2 gap-3">
              <Field label="声の見本">
                <select value={b.voice} onChange={(e) => set("voice", e.target.value)} className={`${inputCls} ${ring}`}>
                  <option value="">なし (エンジンの声)</option>
                  {s.voices.map((v) => <option key={v.name} value={v.name}>{v.name}</option>)}
                </select>
              </Field>
              <Field label="言語">
                <select value={b.language} onChange={(e) => set("language", e.target.value)} className={`${inputCls} ${ring}`}>
                  <option value="">自動</option>
                  {engine.languages.map((l) => <option key={l} value={l}>{s.info.languages[l] ?? l}</option>)}
                </select>
              </Field>
              {engine.speakers.length > 0 && (
                <Field label="話者">
                  <select value={b.speaker} onChange={(e) => set("speaker", e.target.value)} className={`${inputCls} ${ring}`}>
                    <option value="">{`自動 (${engine.default_speaker})`}</option>
                    {engine.speakers.map((sp) => <option key={sp} value={sp}>{sp}</option>)}
                  </select>
                </Field>
              )}
            </div>
            <Field label="話し方" hint="空でもOK">
              <input value={form.style} onChange={(e) => set("style", e.target.value)} placeholder={engine.style_placeholder} className={`${inputCls} ${ring}`} />
            </Field>

            <Field label="形式">
              <Chips accent="cyan" value={form.format} onChange={(v) => set("format", v)} options={FORMATS.map((f) => ({ value: f, label: f }))} />
            </Field>
            <label className="flex min-h-10 items-center gap-2 text-sm text-slate-300">
              <input type="checkbox" checked={form.normalize} onChange={(e) => set("normalize", e.target.checked)} className="size-4 accent-cyan-500" />
              音量をそろえる
            </label>
            <Field label="書き出し名" hint="空でもOK">
              <input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="例: 村人のセリフ" className={`${inputCls} ${ring}`} />
            </Field>
          </>
        )}

        <ErrorNote text={b.error} onClose={() => b.setError("")} />
        <Button accent="cyan" className="w-full" onClick={b.start} disabled={b.busy || running || !engine || !form.csv.trim()}>
          <Package size={16} className={b.busy ? "animate-pulse" : ""} aria-hidden="true" />
          {b.busy ? "始めています…" : running ? "書き出し中です" : "書き出し開始"}
        </Button>
      </section>

      <section className="min-h-0 flex-1 space-y-4 p-4 lg:overflow-y-auto">
        {job && (
          <div className="space-y-2 rounded-xl border border-cyan-500/40 bg-cyan-500/5 p-3">
            <div className="flex items-center gap-2">
              <h2 className="mr-auto truncate text-sm font-semibold text-slate-100">{job.name || job.job} <span className="font-normal text-slate-500">{STATE[job.state] ?? job.state}</span></h2>
              {running && <Button variant="ghost" onClick={b.cancel}><Square size={14} aria-hidden="true" /> 中止</Button>}
              {job.zip_url && <a href={job.zip_url} download className="inline-flex min-h-10 items-center gap-1.5 rounded-lg bg-cyan-600 px-3 text-sm font-medium text-white hover:bg-cyan-500"><Download size={16} aria-hidden="true" /> ZIP をダウンロード</a>}
            </div>
            <Progress accent="cyan" value={job.total ? job.done / job.total : 0}
                      text={`${job.done} / ${job.total}${running && job.current ? ` · 今: ${job.current}` : ""}`} />
            {!!job.failed?.length && (
              <details open className="text-xs text-red-200">
                <summary className="cursor-pointer select-none">失敗 {job.failed.length}件</summary>
                <ul className="mt-1 space-y-0.5">{job.failed.map((f) => <li key={f.id}><span className="font-mono">{f.id}</span>: {f.error}</li>)}</ul>
              </details>
            )}
          </div>
        )}

        <div>
          <div className="mb-3 flex items-center">
            <h2 className="mr-auto text-sm font-semibold text-slate-200">過去の書き出し <span className="font-normal text-slate-500">{items?.length ?? 0}件</span></h2>
            <button type="button" onClick={b.reload} className="min-h-9 px-2 text-xs text-slate-400 hover:text-slate-200">更新</button>
          </div>
          {items === undefined && <p role="status" className="py-8 text-center text-sm text-slate-500">読み込んでいます…</p>}
          {items && !items.length && <p className="py-8 text-center text-sm text-slate-500">まだ書き出しがありません</p>}
          <ul className="space-y-2">
            {items?.map((j) => (
              <li key={j.job} className="flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-900/40 p-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-100">{j.name || j.job}</p>
                  <p className="truncate text-[11px] text-slate-500">{[STATE[j.state] ?? j.state, `${j.done} / ${j.total}`, !!j.failed?.length && `失敗${j.failed.length}`, j.engine, j.format, j.created_at].filter(Boolean).join(" · ")}</p>
                </div>
                {j.zip_url && <a href={j.zip_url} download className="flex min-h-8 items-center gap-1 px-2 text-xs text-slate-300 hover:text-cyan-200" aria-label={`「${j.name || j.job}」の ZIP をダウンロード`}><Download size={14} aria-hidden="true" /> ZIP</a>}
                <button type="button" onClick={() => b.remove(j)} disabled={isRunning(j)}
                        className={`min-h-8 min-w-8 px-1 text-[11px] disabled:opacity-40 ${b.armed === j.job ? "font-semibold text-red-300" : "text-slate-500 hover:text-red-300"}`}
                        aria-label={b.armed === j.job ? `もう一度押すと「${j.name || j.job}」を削除` : `「${j.name || j.job}」を削除`}>
                  {b.armed === j.job ? "削除?" : <Trash2 size={14} className="mx-auto" aria-hidden="true" />}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}
