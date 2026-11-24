// スマホ版の「一括書き出し」。CSV の台詞を1行ずつ音声ファイルにして、ZIP でまとめて受け取る。
// 状態と操作は PC 版と同じ (hub/useBatch.js)。
import { useRef } from "react";
import { Download, FileUp, Package, Square, Trash2 } from "lucide-react";
import { Button, cx, Empty, Field, inputCls, Loading, Notice, Progress, Segmented, SwitchRow } from "./ui.jsx";
import { CSV_HELP, fmtDate, FORMATS, isRunning, useBatch } from "../hub/useBatch.js";

const STATE = { running: "実行中", done: "完了", cancelled: "中止", error: "失敗" };
const FISH_NOTE = "Fish は非商用ライセンス。販売するゲームには使えません";
const zipCls = "inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-m-line-strong bg-m-surface px-4 text-base font-semibold text-m-fg active:bg-m-sunken";

export default function BatchScreen({ s, active }) {
  const b = useBatch(s, active);
  const { form, set, engine, job, items } = b;
  const file = useRef(null);
  const running = isRunning(job);

  return (
    <div className="space-y-4 px-4 py-4">
      <Field label="CSV" hint={<span className="m-num">{b.rows}行</span>}>
        <textarea rows={8} value={form.csv} onChange={(e) => set("csv", e.target.value)} spellCheck={false}
                  placeholder={"line_001,おはようございます\nline_002,こんにちは,見本の名前,やさしく"} className={cx(inputCls, "font-mono")} />
      </Field>
      <input ref={file} type="file" accept=".csv,.txt,text/csv,text/plain" className="hidden" aria-label="CSV ファイル"
             onChange={(e) => { const f = e.target.files[0]; e.target.value = ""; if (f) b.loadFile(f); }} />
      <Button icon={FileUp} onClick={() => file.current.click()} className="w-full">.csv / .txt を読み込む</Button>
      <p className="text-sm text-m-subtle">{CSV_HELP}</p>

      {s.info === undefined && <Loading text="エンジンの情報を読み込んでいます…" />}
      {s.info && engine && (
        <div className="space-y-4">
          <Field label="エンジン">
            <select value={engine.key} onChange={(e) => set("engine", e.target.value)} className={inputCls}>
              {s.info.engines.map((e) => <option key={e.key} value={e.key}>{e.label}</option>)}
            </select>
          </Field>
          {engine.key === "fish" && <Notice tone="warn">{FISH_NOTE}</Notice>}
          <Field label="声の見本">
            <select value={b.voice} onChange={(e) => set("voice", e.target.value)} className={inputCls}>
              <option value="">なし (エンジンの声)</option>
              {s.voices.map((v) => <option key={v.name} value={v.name}>{v.name}</option>)}
            </select>
          </Field>
          <Field label="言語">
            <select value={b.language} onChange={(e) => set("language", e.target.value)} className={inputCls}>
              <option value="">自動</option>
              {engine.languages.map((l) => <option key={l} value={l}>{s.info.languages[l] ?? l}</option>)}
            </select>
          </Field>
          {engine.speakers.length > 0 && (
            <Field label="話者">
              <select value={b.speaker} onChange={(e) => set("speaker", e.target.value)} className={inputCls}>
                <option value="">{`自動 (${engine.default_speaker})`}</option>
                {engine.speakers.map((sp) => <option key={sp} value={sp}>{sp}</option>)}
              </select>
            </Field>
          )}
          <Field label="話し方" hint="空でもOK">
            <input value={form.style} onChange={(e) => set("style", e.target.value)} placeholder={engine.style_placeholder} className={inputCls} />
          </Field>
          <div>
            <p className="mb-1 text-sm font-semibold">形式</p>
            <Segmented label="形式" options={FORMATS.map((f) => ({ value: f, label: f }))} value={form.format} onChange={(v) => set("format", v)} />
          </div>
          <SwitchRow label="音量をそろえる" checked={form.normalize} onChange={(v) => set("normalize", v)} />
          <Field label="書き出し名" hint="空でもOK">
            <input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="例: 村人のセリフ" className={inputCls} />
          </Field>
        </div>
      )}

      <div className="space-y-2">
        <Notice tone="error" onClose={() => b.setError("")}>{b.error}</Notice>
        <Button variant="primary" icon={Package} busy={b.busy} disabled={b.busy || running || !engine || !form.csv.trim()} onClick={b.start} className="w-full">
          {running ? "書き出し中です" : "書き出し開始"}
        </Button>
      </div>

      {job && (
        <section aria-label="書き出しの進み具合" className="space-y-3 rounded-2xl border border-m-primary bg-m-surface p-4">
          <h2 className="text-base font-semibold">{job.name || job.job} <span className="text-sm font-normal text-m-muted">{STATE[job.state] ?? job.state}</span></h2>
          <Progress value={job.total ? job.done / job.total : 0} text={<><span className="m-num">{job.done} / {job.total}</span>{running && job.current ? ` · 今: ${job.current}` : ""}</>} />
          {!!job.failed?.length && (
            <details open className="text-sm">
              <summary className="flex min-h-12 cursor-pointer items-center font-semibold text-m-danger">失敗 {job.failed.length}件</summary>
              <ul className="space-y-1">{job.failed.map((f) => <li key={f.id}><span className="font-mono">{f.id}</span>: {f.error}</li>)}</ul>
            </details>
          )}
          <div className="flex flex-wrap gap-2">
            {running && <Button icon={Square} onClick={b.cancel}>中止</Button>}
            {job.zip_url && <a href={job.zip_url} download className={zipCls}><Download size={18} aria-hidden="true" /> ZIP をダウンロード</a>}
          </div>
        </section>
      )}

      <section aria-labelledby="m-batch-items" className="pt-4">
        <div className="mb-3 flex min-h-12 items-center gap-2">
          <h2 id="m-batch-items" className="min-w-0 flex-1 text-base font-semibold">過去の書き出し {Array.isArray(items) && <span className="m-num text-sm font-normal text-m-muted">{items.length}件</span>}</h2>
          <Button variant="ghost" onClick={b.reload}>更新</Button>
        </div>
        {items === undefined ? <Loading text="履歴を読み込んでいます…" />
          : !items.length ? <Empty icon={Package} title="まだ書き出しがありません" hint="CSV を入れて「書き出し開始」を押すと、ここに残ります。" />
          : (
            <ul className="space-y-3">
              {items.map((j) => (
                <li key={j.job} className="rounded-2xl border border-m-line bg-m-surface p-4">
                  <h3 className="text-base font-semibold">{j.name || j.job}</h3>
                  <p className="text-sm text-m-subtle">{[STATE[j.state] ?? j.state, `${j.done} / ${j.total}`, !!j.failed?.length && `失敗${j.failed.length}`, j.engine, j.format, fmtDate(j.created_at)].filter(Boolean).join(" · ")}</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {j.zip_url && <a href={j.zip_url} download aria-label={`「${j.name || j.job}」の ZIP をダウンロード`} className={zipCls}><Download size={18} aria-hidden="true" /> ZIP</a>}
                    <Button variant={b.armed === j.job ? "danger" : "secondary"} icon={Trash2} disabled={isRunning(j)} onClick={() => b.remove(j)}
                            aria-label={b.armed === j.job ? `もう一度押すと「${j.name || j.job}」を削除` : `「${j.name || j.job}」を削除`}>
                      {b.armed === j.job ? "削除する" : "削除"}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
      </section>
    </div>
  );
}
