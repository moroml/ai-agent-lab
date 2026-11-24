// 音声: ローカルの音声合成 (Qwen3-TTS / IndexTTS-2.5 / Fish) で文章を読み上げ、履歴で聴き比べる画面。
// 声の見本はファイルかマイク録音で登録する。モデルは最後の生成からしばらくして自動で降ろす。
import { useRef } from "react";
import { AudioLines, Download, Mic, RefreshCw, Square, Trash2, Upload, UserRound } from "lucide-react";
import { Button, Chips, ErrorNote, Field, inputCls } from "./ui.jsx";
import { fmtTime, MAX_REC_SEC, MAX_TEXT, useSpeech } from "./useSpeech.js";

const LICENSE_NOTE = { false: "商用利用は不可 (研究・個人利用向け)", null: "商用利用はライセンスを確認してください", true: "商用利用可" };

export default function SpeechView() {
  const s = useSpeech();
  const { info, engine, form, set } = s;
  const file = useRef(null);
  const loaded = s.items !== undefined;

  return (
    <div className="flex h-full flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
      <section className="space-y-4 p-4 lg:w-[440px] lg:shrink-0 lg:overflow-y-auto lg:border-r lg:border-slate-800">
        <h1 className="flex items-center gap-2 text-base font-semibold text-cyan-200"><AudioLines size={18} aria-hidden="true" /> 音声を作る</h1>

        {info === undefined && <p role="status" className="text-sm text-slate-500">読み込んでいます…</p>}
        {info && engine && (
          <>
            <Field label="エンジン">
              <Chips accent="cyan" value={engine.key} onChange={(v) => set("engine", v)} options={info.engines.map((e) => ({ value: e.key, label: e.label }))} />
            </Field>
            <p className="text-[11px] leading-relaxed text-slate-400">{engine.description}</p>
            <p className={`text-[11px] ${engine.commercial === true ? "text-slate-500" : "text-amber-300"}`}>
              ライセンス: {engine.license}。{LICENSE_NOTE[engine.commercial]}
            </p>

            <Field label="文章" hint={`${form.text.length} / ${MAX_TEXT}`}>
              <textarea rows={7} maxLength={MAX_TEXT} value={form.text} onChange={(e) => set("text", e.target.value)}
                        placeholder="読み上げたい文章を入れてください" className={`${inputCls} leading-relaxed focus:ring-cyan-500/50`} />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="言語">
                <select value={s.language} onChange={(e) => set("language", e.target.value)} className={`${inputCls} focus:ring-cyan-500/50`}>
                  <option value="">自動</option>
                  {engine.languages.map((l) => <option key={l} value={l}>{info.languages[l] ?? l}</option>)}
                </select>
              </Field>
              {engine.speakers.length > 0 && (
                <Field label="話者">
                  <select value={s.speaker} onChange={(e) => set("speaker", e.target.value)} className={`${inputCls} focus:ring-cyan-500/50`}>
                    <option value="">{`自動 (${engine.default_speaker})`}</option>
                    {engine.speakers.map((sp) => <option key={sp} value={sp}>{sp}</option>)}
                  </select>
                </Field>
              )}
            </div>

            <Field label="スタイル" hint="空でもOK">
              <input value={form.style} onChange={(e) => set("style", e.target.value)} placeholder={engine.style_placeholder} className={`${inputCls} focus:ring-cyan-500/50`} />
            </Field>
            <p className="text-[11px] leading-relaxed text-slate-500">{engine.style_help}</p>

            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <h2 className="mr-auto text-xs font-medium text-slate-300">声の見本 <span className="font-normal text-slate-500">{s.voices.length}件</span></h2>
                <input ref={file} type="file" accept="audio/*" className="hidden" aria-label="声の見本の音声ファイル"
                       onChange={(e) => { const f = e.target.files[0]; e.target.value = ""; if (f) s.addVoice(f, f.name); }} />
                <Button variant="ghost" onClick={() => file.current.click()} disabled={s.recording}><Upload size={16} aria-hidden="true" /> ファイル</Button>
                {s.recSupport === "" && (s.recording
                  ? <Button accent="rose" onClick={s.stopRecording}><Square size={16} aria-hidden="true" /> 録音を止める {fmtTime(s.recSec)}</Button>
                  : <Button variant="ghost" onClick={s.startRecording}><Mic size={16} aria-hidden="true" /> 録音</Button>)}
              </div>
              {s.recSupport && <p className="text-[11px] text-slate-500">{s.recSupport}</p>}
              {s.recording && <p role="status" className="text-[11px] text-rose-300">録音中です。{MAX_REC_SEC}秒までで自動で止まります。</p>}
              <ul className="space-y-1.5">
                <li>
                  <button type="button" onClick={() => s.pickVoice("")} aria-pressed={!form.voice}
                          className={`flex min-h-10 w-full items-center gap-2 rounded-lg border px-3 text-left text-xs ${!form.voice ? "border-cyan-500/40 bg-cyan-500/10 text-cyan-200" : "border-slate-700 text-slate-400 hover:text-slate-200"}`}>
                    <UserRound size={14} aria-hidden="true" /> 声の見本なし (エンジンの声)
                  </button>
                </li>
                {s.voices.map((v) => (
                  <li key={v.name} className={`rounded-lg border p-2 ${form.voice === v.name ? "border-cyan-500/40 bg-cyan-500/5" : "border-slate-800"}`}>
                    <div className="flex items-center gap-2">
                      <button type="button" onClick={() => s.pickVoice(v.name)} aria-pressed={form.voice === v.name}
                              className={`min-h-8 min-w-0 flex-1 truncate text-left text-xs ${form.voice === v.name ? "font-semibold text-cyan-200" : "text-slate-300"}`}>
                        {v.name} {v.duration && <span className="font-normal text-slate-500">{fmtTime(v.duration)}</span>}
                      </button>
                      <button type="button" onClick={() => s.removeVoice(v)} className={`min-h-8 min-w-8 px-1 text-[11px] ${s.armedVoice === v.name ? "font-semibold text-red-300" : "text-slate-500 hover:text-red-300"}`}
                              aria-label={s.armedVoice === v.name ? `もう一度押すと声の見本「${v.name}」を削除` : `声の見本「${v.name}」を削除`}>
                        {s.armedVoice === v.name ? "削除?" : <Trash2 size={14} className="mx-auto" aria-hidden="true" />}
                      </button>
                    </div>
                    <audio src={v.url} controls preload="none" className="mt-1 h-8 w-full" aria-label={`声の見本「${v.name}」を再生`} />
                  </li>
                ))}
              </ul>
              {form.voice && (
                <Field label="見本の文字起こし" hint="任意。合うと声が安定します">
                  <input value={form.voiceText} onChange={(e) => set("voiceText", e.target.value)} placeholder="見本で話している内容" className={`${inputCls} focus:ring-cyan-500/50`} />
                </Field>
              )}
            </div>
          </>
        )}

        <ErrorNote text={s.error} onClose={() => s.setError("")} />
        <Button accent="cyan" className="w-full" onClick={s.generate} disabled={s.busy || !engine || !form.text.trim() || s.recording}>
          <AudioLines size={16} className={s.busy ? "animate-pulse" : ""} aria-hidden="true" />
          {s.busy ? `生成中… ${fmtTime(s.elapsed)}` : "生成する"}
        </Button>
        <p className="text-[11px] leading-relaxed text-slate-500">
          最初の生成はモデルの読み込みで12〜50秒ほど余分にかかります。続けて作る間は読み込んだままにして、最後の生成から{info?.idle_unload_sec ?? 120}秒たつと自動で VRAM を空けます。
          生成の前に、チャットと画像のモデルを VRAM から降ろします。
        </p>
      </section>

      <section className="min-h-0 flex-1 p-4 lg:overflow-y-auto">
        <div className="mb-3 flex items-center">
          <h2 className="mr-auto text-sm font-semibold text-slate-200">履歴 <span className="font-normal text-slate-500">{s.items?.length ?? 0}件</span></h2>
          <button type="button" onClick={s.reload} className="flex min-h-9 items-center gap-1 px-2 text-xs text-slate-400 hover:text-slate-200"><RefreshCw size={14} aria-hidden="true" /> 更新</button>
        </div>
        <ul className="space-y-2">
          {s.items?.map((t) => (
            <li key={t.file} className={`rounded-xl border p-3 ${t.file === s.fresh ? "border-cyan-500/50 bg-cyan-500/5" : "border-slate-800 bg-slate-900/40"}`}>
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-cyan-500/40 to-sky-500/30"><AudioLines size={18} aria-hidden="true" /></div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-100">{t.title}</p>
                  <p className="truncate text-[11px] text-slate-500">{[t.engine, t.speaker, t.voice && `見本 ${t.voice}`, t.duration && fmtTime(t.duration), t.elapsed && `生成${Math.round(t.elapsed)}秒`].filter(Boolean).join(" · ")}</p>
                </div>
                <button type="button" onClick={() => s.useAsVoice(t)} className="min-h-8 px-2 text-[11px] text-slate-400 hover:text-cyan-200" title="この音声を声の見本として保存し、次の生成で使います">この声を見本にする</button>
                <a href={t.url} download={t.file} className="flex min-h-8 min-w-8 items-center justify-center text-slate-500 hover:text-slate-200" aria-label={`「${t.title}」を保存`}><Download size={14} aria-hidden="true" /></a>
                <button type="button" onClick={() => s.remove(t)} className={`min-h-8 min-w-8 px-1 text-[11px] ${s.armed === t.file ? "font-semibold text-red-300" : "text-slate-500 hover:text-red-300"}`}
                        aria-label={s.armed === t.file ? `もう一度押すと「${t.title}」を削除` : `「${t.title}」を削除`}>
                  {s.armed === t.file ? "削除?" : <Trash2 size={14} className="mx-auto" aria-hidden="true" />}
                </button>
              </div>
              <audio src={t.url} controls preload="none" autoPlay={t.file === s.fresh} className="mt-2 w-full" />
              <details className="mt-1 text-xs text-slate-400">
                <summary className="cursor-pointer select-none">文章{t.style ? ` · ${t.style}` : ""}</summary>
                <p className="mt-1 whitespace-pre-wrap">{t.text}</p>
              </details>
            </li>
          ))}
        </ul>
        {!loaded && <p role="status" className="py-16 text-center text-sm text-slate-500">読み込んでいます…</p>}
        {loaded && !s.items.length && <p className="py-16 text-center text-sm text-slate-500">まだ音声がありません</p>}
      </section>
    </div>
  );
}
