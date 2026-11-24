// 音声の「声を作る」(PC版)。文章・画像・動画のどれかから声の説明を作り、試し声を聴き比べて、気に入ったものを声の見本に保存する。
import { useRef } from "react";
import { Check, Film, ImagePlus, Mic, Save, Sparkles, UserRound, Wand2 } from "lucide-react";
import { Button, Chips, ErrorNote, Field, inputCls } from "./ui.jsx";
import { fmtTime } from "./useSpeech.js";
import { DESC_PLACEHOLDER, SOURCES, useVoiceCreate } from "./useVoiceCreate.js";

const ring = "focus:ring-cyan-500/50";

export default function VoiceCreateView({ s, onUse }) {
  const c = useVoiceCreate(s);
  const pick = useRef(null);
  const hasFile = !!c.file;
  const fromFile = c.source !== "text";

  const describeBlock = (
    <div className="space-y-2">
      <Field label="追加の指示" hint="任意">
        <input value={c.hint} onChange={(e) => c.setHint(e.target.value)} maxLength={500} placeholder="例: クールな感じで" className={`${inputCls} ${ring}`} />
      </Field>
      <Button accent="cyan" className="w-full" onClick={c.describe} disabled={c.describing || !hasFile}>
        <Wand2 size={16} className={c.describing ? "animate-pulse" : ""} aria-hidden="true" />
        {c.describing ? `考えています… ${fmtTime(c.descElapsed)}` : "声を考える"}
      </Button>
      <p className="text-[11px] leading-relaxed text-slate-500">初回はモデルの読み込みで約30秒かかります。考えた説明は下の欄に入るので、手で直せます。</p>
    </div>
  );

  return (
    <div className="flex h-full flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
      <section className="space-y-4 p-4 lg:w-[440px] lg:shrink-0 lg:overflow-y-auto lg:border-r lg:border-slate-800">
        <h1 className="flex items-center gap-2 text-base font-semibold text-cyan-200"><Sparkles size={18} aria-hidden="true" /> 声を作る</h1>
        <p className="text-[11px] leading-relaxed text-slate-400">声の特徴を説明して、試し声で確かめます。気に入ったら名前を付けて保存すると、読み上げで使えます。</p>

        {s.info === undefined && <p role="status" className="text-sm text-slate-500">読み込んでいます…</p>}
        {s.info && !c.qwen && <p className="text-sm text-amber-300">声を作るには Qwen3 のエンジンが必要ですが、見つかりません。</p>}
        {s.info && c.qwen && (
          <>
            <Field label="どこから作る？">
              <Chips accent="cyan" value={c.source} onChange={c.setSource} options={SOURCES} />
            </Field>

            {fromFile && (
              <div className="space-y-3 rounded-xl border border-slate-800 p-3">
                <input ref={pick} type="file" accept={c.source === "image" ? "image/*" : "video/*"} className="hidden"
                       aria-label={c.source === "image" ? "画像ファイル" : "動画ファイル"}
                       onChange={(e) => { const f = e.target.files[0]; e.target.value = ""; if (f) c.pickFile(f); }} />
                <Button variant="ghost" onClick={() => pick.current.click()}>
                  {c.source === "image" ? <ImagePlus size={16} aria-hidden="true" /> : <Film size={16} aria-hidden="true" />}
                  {hasFile ? "選び直す" : c.source === "image" ? "画像を選ぶ" : "動画を選ぶ"}
                </Button>
                {hasFile && (c.isVideo
                  ? <video src={c.preview} controls className="max-h-56 w-full rounded-lg bg-black" aria-label="選んだ動画" />
                  : <img src={c.preview} alt="選んだ画像" className="max-h-56 w-full rounded-lg object-contain" />)}
                {hasFile && <p className="truncate text-[11px] text-slate-500">{c.file.name}</p>}

                {hasFile && c.isVideo && (
                  <div className="space-y-3">
                    <div className="space-y-2 rounded-lg border border-slate-700 p-3">
                      <h2 className="text-xs font-medium text-slate-200">映っている人の声をそのまま使う</h2>
                      <div className="grid grid-cols-2 gap-2">
                        <Field label="見本の名前">
                          <input value={c.videoName} onChange={(e) => c.setVideoName(e.target.value)} className={`${inputCls} ${ring}`} />
                        </Field>
                        <Field label="開始秒" hint="30秒を使う">
                          <input type="number" min="0" step="1" inputMode="numeric" value={c.start} onChange={(e) => c.setStart(e.target.value)} className={`${inputCls} ${ring}`} />
                        </Field>
                      </div>
                      <Button accent="cyan" variant="ghost" className="w-full" onClick={c.useVideoVoice} disabled={c.videoBusy || !c.videoName.trim()}>
                        <Mic size={16} aria-hidden="true" /> {c.videoBusy ? "保存しています…" : "声の見本として保存"}
                      </Button>
                      {c.videoVoice && (
                        <p role="status" className="flex flex-wrap items-center gap-2 text-xs text-cyan-200">
                          <Check size={14} aria-hidden="true" /> 「{c.videoVoice}」を保存しました
                          <button type="button" onClick={() => onUse(c.videoVoice)} className="min-h-8 rounded-lg border border-cyan-500/40 px-2 hover:bg-cyan-500/10">読み上げで使う</button>
                        </p>
                      )}
                    </div>
                    <div className="space-y-2 rounded-lg border border-slate-700 p-3">
                      <h2 className="text-xs font-medium text-slate-200">見た目から声を考える</h2>
                      {describeBlock}
                    </div>
                  </div>
                )}
                {hasFile && !c.isVideo && describeBlock}
              </div>
            )}

            <Field label="声の説明" hint="試し声はこの説明どおりに作ります">
              <textarea rows={4} value={c.desc} onChange={(e) => c.setDesc(e.target.value)} placeholder={DESC_PLACEHOLDER} className={`${inputCls} leading-relaxed ${ring}`} />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="言語">
                <select value={c.language} onChange={(e) => c.setLang(e.target.value)} className={`${inputCls} ${ring}`}>
                  <option value="">自動</option>
                  {c.qwen.languages.map((l) => <option key={l} value={l}>{s.info.languages[l] ?? l}</option>)}
                </select>
              </Field>
            </div>
            <Field label="試し読みの文">
              <textarea rows={2} value={c.testText} onChange={(e) => c.setTestText(e.target.value)} className={`${inputCls} leading-relaxed ${ring}`} />
            </Field>

            <ErrorNote text={c.error} onClose={() => c.setError("")} />
            <Button accent="cyan" className="w-full" onClick={c.tryVoice} disabled={c.trying || !c.desc.trim() || !c.testText.trim()}>
              <Sparkles size={16} className={c.trying ? "animate-pulse" : ""} aria-hidden="true" />
              {c.trying ? `作っています… ${fmtTime(c.tryElapsed)}` : "試し声を作る"}
            </Button>
            <p className="text-[11px] leading-relaxed text-slate-500">同じ説明でも、作るたびに声が変わります。気に入るまで何度でも作り直せます。</p>
          </>
        )}
      </section>

      <section className="min-h-0 flex-1 p-4 lg:overflow-y-auto">
        <h2 className="mb-3 text-sm font-semibold text-slate-200">試し声 <span className="font-normal text-slate-500">{c.trials.length}件</span></h2>
        {!c.trials.length && <p className="py-16 text-center text-sm text-slate-500">「試し声を作る」を押すと、ここに並びます。聴き比べて、気に入った声を保存できます。</p>}
        <ul className="space-y-2">
          {c.trials.map((t, i) => (
            <li key={t.file} className={`rounded-xl border p-3 ${i === 0 ? "border-cyan-500/50 bg-cyan-500/5" : "border-slate-800 bg-slate-900/40"}`}>
              <p className="truncate text-sm font-medium text-slate-100">{t.title}</p>
              <p className="truncate text-[11px] text-slate-500">{[t.duration && fmtTime(t.duration), t.elapsed && `生成${Math.round(t.elapsed)}秒`].filter(Boolean).join(" · ")}</p>
              <audio src={t.url} controls preload="auto" autoPlay={i === 0} className="mt-2 w-full" aria-label={`「${t.title}」を再生`} />
              {c.saved[t.file] ? (
                <p role="status" className="mt-2 flex flex-wrap items-center gap-2 text-xs text-cyan-200">
                  <Check size={14} aria-hidden="true" /> 「{c.saved[t.file]}」を保存しました
                  <button type="button" onClick={() => onUse(c.saved[t.file])} className="flex min-h-8 items-center gap-1 rounded-lg border border-cyan-500/40 px-2 hover:bg-cyan-500/10">
                    <UserRound size={14} aria-hidden="true" /> 読み上げで使う
                  </button>
                </p>
              ) : (
                <div className="mt-2 flex items-center gap-2">
                  <input value={c.names[t.file] ?? ""} onChange={(e) => c.setName(t.file, e.target.value)} placeholder="声の名前 (例: 優しい女性)" aria-label="声の名前"
                         className={`${inputCls} ${ring} min-w-0 flex-1`} />
                  <Button accent="cyan" onClick={() => c.saveTrial(t)} disabled={c.savingFile === t.file || !(c.names[t.file] ?? "").trim()}>
                    <Save size={16} aria-hidden="true" /> {c.savingFile === t.file ? "保存中…" : "この声を保存"}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
