// スマホ版の音声。文章を入れてローカルの音声合成で読み上げ、履歴で聴く。声の見本はファイルかスマホのマイク録音で登録する。
// 入力は PC 版と同じ保存先 (hub.speech.form)。モデルは最後の生成からしばらくして自動で降ろす。
import { useEffect, useRef, useState } from "react";
import { AudioLines, Check, ChevronRight, Download, Mic, RefreshCw, SlidersHorizontal, Square, Trash2, Upload, UserRound } from "lucide-react";
import { Button, cx, Empty, Field, inputCls, Loading, Notice, Progress, ScreenHeader, Segmented, Sheet } from "./ui.jsx";
import { fmtTime, MAX_REC_SEC, MAX_TEXT, useSpeech } from "../hub/useSpeech.js";
import BatchScreen from "./BatchScreen.jsx";
import VoiceCreateScreen from "./VoiceCreateScreen.jsx";

const LICENSE_NOTE = { false: "商用利用は不可 (研究・個人利用向け)", null: "商用利用はライセンスを確認してください", true: "商用利用可" };

const TABS = [
  { value: "read", label: "読み上げ" },
  { value: "create", label: "声を作る" },
  { value: "batch", label: "一括書き出し" },
];

// 上の切り替えで3つの画面を行き来する。状態は useSpeech が持ち、どの画面からも同じ声の見本を使う
export default function SpeechScreen() {
  const s = useSpeech();
  const [tab, setTab] = useState("read");
  const useVoice = (name) => { s.pickVoice(name); setTab("read"); };
  return (
    <div className="flex h-full flex-col">
      <ScreenHeader title="音声">
        <div className="px-4 pb-3"><Segmented label="音声の画面" options={TABS} value={tab} onChange={setTab} /></div>
      </ScreenHeader>
      <div className="min-h-0 flex-1">
        {/* 切り替えても試し声や入力が消えないよう、3つとも出したままにして隠す */}
        <div hidden={tab !== "read"} className="h-full"><ReadPanel s={s} /></div>
        <div hidden={tab !== "create"} className="h-full overflow-y-auto overscroll-contain"><VoiceCreateScreen s={s} onUse={useVoice} /></div>
        <div hidden={tab !== "batch"} className="h-full overflow-y-auto overscroll-contain"><BatchScreen s={s} active={tab === "batch"} /></div>
      </div>
    </div>
  );
}

function ReadPanel({ s }) {
  const { info, engine, form, set } = s;
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [saved, setSaved] = useState(null);   // 「この声を見本にする」を押した履歴
  const file = useRef(null);
  const listRef = useRef(null);
  useEffect(() => {
    if (s.fresh) listRef.current?.scrollIntoView({ block: "start" });
  }, [s.fresh]);
  useEffect(() => {
    if (!saved) return undefined;
    const t = setTimeout(() => setSaved(null), 2000);
    return () => clearTimeout(t);
  }, [saved]);

  const voice = form.voice || "見本なし";
  const summary = engine && [s.language ? info.languages[s.language] : "言語自動", engine.speakers.length > 0 && (s.speaker || engine.default_speaker), voice].filter(Boolean).join(" · ");

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">
        {info === undefined && <Loading text="エンジンの情報を読み込んでいます…" />}
        {info === null && <Notice tone="error">{`エンジンの情報を取得できませんでした: ${s.error}`}</Notice>}
        {info && engine && (
          <div className="space-y-4">
            <Field label="エンジン">
              <select aria-label="エンジン" value={engine.key} onChange={(e) => set("engine", e.target.value)} className={inputCls}>
                {info.engines.map((e) => <option key={e.key} value={e.key}>{e.label}</option>)}
              </select>
            </Field>
            <p className="text-sm text-m-muted">{engine.description}</p>
            <Notice tone={engine.commercial === true ? "info" : "warn"}>{`ライセンス: ${engine.license}。${LICENSE_NOTE[engine.commercial]}`}</Notice>

            <Field label="文章" hint={<span className="m-num">{form.text.length} / {MAX_TEXT}</span>}>
              <textarea rows={7} maxLength={MAX_TEXT} value={form.text} onChange={(e) => set("text", e.target.value)} placeholder="読み上げたい文章を入れてください" className={inputCls} />
            </Field>

            <button type="button" onClick={() => setOptionsOpen(true)}
                    className="flex min-h-12 w-full items-center gap-3 rounded-xl border border-m-line-strong bg-m-surface px-3 text-left active:bg-m-sunken">
              <SlidersHorizontal size={20} aria-hidden="true" className="shrink-0 text-m-muted" />
              <span className="min-w-0 flex-1">
                <span className="block text-base font-semibold">声と話し方</span>
                <span className="block truncate text-sm text-m-muted">{summary}</span>
              </span>
              <ChevronRight size={18} aria-hidden="true" className="shrink-0 text-m-subtle" />
            </button>

            <div className="space-y-2">
              <Notice tone="error" onClose={() => s.setError("")}>{s.error && `作れませんでした: ${s.error}`}</Notice>
              <Button variant="primary" icon={AudioLines} busy={s.busy} disabled={s.busy || !form.text.trim() || s.recording} onClick={s.generate} className="w-full">音声を作る</Button>
              {!s.busy && !form.text.trim() && <p className="text-sm text-m-subtle">文章を入れると作れます。</p>}
              {s.busy && (
                <>
                  <Progress text={<>生成しています… <span className="m-num">{fmtTime(s.elapsed)}</span></>} />
                  <p className="text-sm text-m-subtle">最初の生成はモデルの読み込みで12〜50秒ほど余分にかかります。生成の前に、チャットと画像のモデルを VRAM から降ろします。</p>
                </>
              )}
              {!s.busy && <p className="text-sm text-m-subtle">続けて作る間はモデルを読み込んだままにし、最後の生成から{info.idle_unload_sec}秒たつと自動で VRAM を空けます。</p>}
            </div>
          </div>
        )}

        <section ref={listRef} aria-labelledby="m-speech-items" className="mt-8 scroll-mt-2">
          <div className="mb-3 flex min-h-12 items-center gap-2">
            <h2 id="m-speech-items" className="min-w-0 flex-1 text-base font-semibold">
              履歴 {Array.isArray(s.items) && <span className="m-num text-sm font-normal text-m-muted">{s.items.length}件</span>}
            </h2>
            <Button variant="ghost" icon={RefreshCw} onClick={s.reload}>更新</Button>
          </div>
          {s.items === undefined ? <Loading text="履歴を読み込んでいます…" />
            : !s.items.length ? <Empty icon={AudioLines} title="まだ音声がありません" hint="文章を入れて「音声を作る」を押すと、ここに並びます。" />
            : (
              <ul className="space-y-3">
                {s.items.map((t) => (
                  <li key={t.file} className={cx("rounded-2xl border bg-m-surface p-4", t.file === s.fresh ? "border-m-primary" : "border-m-line")}>
                    {t.file === s.fresh && <p className="mb-1 flex items-center gap-1 text-sm font-semibold text-m-primary"><Check size={16} aria-hidden="true" /> できあがり</p>}
                    <h3 className="text-base font-semibold">{t.title}</h3>
                    <p className="text-sm text-m-subtle">{[t.engine, t.speaker, t.voice && `見本 ${t.voice}`, t.duration && fmtTime(t.duration), t.elapsed && `生成${Math.round(t.elapsed)}秒`].filter(Boolean).join(" · ")}</p>
                    <audio src={t.url} controls preload="none" aria-label={`「${t.title}」を再生`} className="mt-3 w-full" />
                    <details className="mt-2 text-sm text-m-muted">
                      <summary className="flex min-h-12 cursor-pointer items-center">文章を見る</summary>
                      <p className="whitespace-pre-wrap">{t.text}</p>
                    </details>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button icon={saved === t.file ? Check : UserRound} onClick={async () => { if (await s.useAsVoice(t)) setSaved(t.file); }}>{saved === t.file ? "保存しました" : "この声を見本にする"}</Button>
                      <a href={t.url} download={t.file} aria-label={`「${t.title}」を保存`}
                         className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-m-line-strong bg-m-surface px-4 text-base font-semibold text-m-fg active:bg-m-sunken">
                        <Download size={18} aria-hidden="true" /> 保存
                      </a>
                      <Button variant={s.armed === t.file ? "danger" : "secondary"} icon={Trash2}
                              aria-label={s.armed === t.file ? `もう一度押すと「${t.title}」を削除` : `「${t.title}」を削除`} onClick={() => s.remove(t)}>
                        {s.armed === t.file ? "削除する" : "削除"}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
        </section>
      </div>

      <Sheet open={optionsOpen} onClose={() => setOptionsOpen(false)} title="声と話し方"
             footer={<Button className="w-full" onClick={() => setOptionsOpen(false)}>閉じる</Button>}>
        {engine && (
          <div className="space-y-4">
            <Field label="言語">
              <select value={s.language} onChange={(e) => set("language", e.target.value)} className={inputCls}>
                <option value="">自動</option>
                {engine.languages.map((l) => <option key={l} value={l}>{info.languages[l] ?? l}</option>)}
              </select>
            </Field>
            {engine.speakers.length > 0 && (
              <Field label="話者">
                <select value={s.speaker} onChange={(e) => set("speaker", e.target.value)} className={inputCls}>
                  <option value="">{`自動 (${engine.default_speaker})`}</option>
                  {engine.speakers.map((sp) => <option key={sp} value={sp}>{sp}</option>)}
                </select>
              </Field>
            )}
            <Field label="スタイル" hint="空でもOK">
              <input aria-label="スタイル" value={form.style} onChange={(e) => set("style", e.target.value)} placeholder={engine.style_placeholder} className={inputCls} />
            </Field>
            <p className="text-sm text-m-muted">{engine.style_help}</p>

            <fieldset className="space-y-2">
              <legend className="mb-1 text-sm font-semibold">声の見本 <span className="m-num font-normal text-m-subtle">{s.voices.length}件</span></legend>
              <input ref={file} type="file" accept="audio/*" className="hidden" aria-label="声の見本の音声ファイル"
                     onChange={(e) => { const f = e.target.files[0]; e.target.value = ""; if (f) s.addVoice(f, f.name); }} />
              <div className="flex flex-wrap gap-2">
                <Button icon={Upload} onClick={() => file.current.click()} disabled={s.recording}>ファイルを選ぶ</Button>
                {s.recSupport === "" && (s.recording
                  ? <Button variant="danger" icon={Square} onClick={s.stopRecording}>録音を止める <span className="m-num">{fmtTime(s.recSec)}</span></Button>
                  : <Button icon={Mic} onClick={s.startRecording}>マイクで録音</Button>)}
              </div>
              {s.recSupport && <p className="text-sm text-m-subtle">{s.recSupport}</p>}
              {s.recording && <p role="status" className="text-sm text-m-danger">録音中です。{MAX_REC_SEC}秒までで自動で止まります。</p>}
              <Notice tone="error" onClose={() => s.setError("")}>{s.error}</Notice>

              <ul className="space-y-2">
                <li>
                  <button type="button" onClick={() => s.pickVoice("")} aria-pressed={!form.voice}
                          className={cx("flex min-h-12 w-full items-center gap-2 rounded-xl border px-3 text-left text-base", !form.voice ? "border-m-primary bg-m-primary-soft font-semibold" : "border-m-line-strong text-m-muted active:bg-m-sunken")}>
                    {!form.voice && <Check size={16} aria-hidden="true" />} 見本なし (エンジンの声)
                  </button>
                </li>
                {s.voices.map((v) => (
                  <li key={v.name} className={cx("rounded-xl border p-2", form.voice === v.name ? "border-m-primary bg-m-primary-soft" : "border-m-line")}>
                    <div className="flex items-center gap-1">
                      <button type="button" onClick={() => s.pickVoice(v.name)} aria-pressed={form.voice === v.name}
                              className={cx("flex min-h-12 min-w-0 flex-1 items-center gap-2 px-2 text-left text-base", form.voice === v.name && "font-semibold")}>
                        {form.voice === v.name && <Check size={16} aria-hidden="true" className="shrink-0" />}
                        <span className="min-w-0 truncate">{v.name}</span>
                        {v.duration && <span className="m-num shrink-0 text-sm font-normal text-m-subtle">{fmtTime(v.duration)}</span>}
                      </button>
                      <Button variant={s.armedVoice === v.name ? "danger" : "ghost"} icon={Trash2}
                              aria-label={s.armedVoice === v.name ? `もう一度押すと声の見本「${v.name}」を削除` : `声の見本「${v.name}」を削除`} onClick={() => s.removeVoice(v)}>
                        {s.armedVoice === v.name ? "削除する" : ""}
                      </Button>
                    </div>
                    <audio src={v.url} controls preload="none" aria-label={`声の見本「${v.name}」を再生`} className="mt-1 w-full" />
                  </li>
                ))}
              </ul>
              {form.voice && (
                <Field label="見本の文字起こし" hint="任意。合うと声が安定します">
                  <input value={form.voiceText} onChange={(e) => set("voiceText", e.target.value)} placeholder="見本で話している内容" className={inputCls} />
                </Field>
              )}
            </fieldset>
          </div>
        )}
      </Sheet>
    </div>
  );
}
