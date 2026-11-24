// スマホ版の「声を作る」。文章・画像・動画のどれかから声の説明を作り、試し声を聴き比べて、気に入ったものを声の見本に保存する。
// 状態と操作は PC 版と同じ (hub/useVoiceCreate.js)。
import { useRef } from "react";
import { Check, Film, ImagePlus, Mic, Save, Sparkles, UserRound, Wand2 } from "lucide-react";
import { Button, cx, Empty, Field, inputCls, Loading, Notice, Progress, Segmented } from "./ui.jsx";
import { fmtTime } from "../hub/useSpeech.js";
import { DESC_PLACEHOLDER, SOURCES, useVoiceCreate } from "../hub/useVoiceCreate.js";

export default function VoiceCreateScreen({ s, onUse }) {
  const c = useVoiceCreate(s);
  const pick = useRef(null);
  const hasFile = !!c.file;

  const describeBlock = (
    <div className="space-y-3">
      <Field label="追加の指示" hint="任意">
        <input value={c.hint} onChange={(e) => c.setHint(e.target.value)} maxLength={500} placeholder="例: クールな感じで" className={inputCls} />
      </Field>
      <Button variant="primary" icon={Wand2} busy={c.describing} disabled={c.describing || !hasFile} onClick={c.describe} className="w-full">声を考える</Button>
      {c.describing && <Progress text={<>考えています… <span className="m-num">{fmtTime(c.descElapsed)}</span></>} />}
      <p className="text-sm text-m-subtle">初回はモデルの読み込みで約30秒かかります。考えた説明は下の欄に入るので、手で直せます。</p>
    </div>
  );

  if (s.info === undefined) return <div className="px-4 py-4"><Loading text="エンジンの情報を読み込んでいます…" /></div>;
  if (!c.qwen) return <div className="px-4 py-4"><Notice tone="warn">声を作るには Qwen3 のエンジンが必要ですが、見つかりません。</Notice></div>;

  return (
    <div className="space-y-4 px-4 py-4">
      <p className="text-sm text-m-muted">声の特徴を説明して、試し声で確かめます。気に入ったら名前を付けて保存すると、読み上げで使えます。</p>

      <div>
        <p className="mb-1 text-sm font-semibold">どこから作る？</p>
        <Segmented label="どこから作るか" options={SOURCES} value={c.source} onChange={c.setSource} />
      </div>

      {c.source !== "text" && (
        <div className="space-y-3 rounded-2xl border border-m-line p-3">
          <input ref={pick} type="file" accept={c.source === "image" ? "image/*" : "video/*"} className="hidden"
                 aria-label={c.source === "image" ? "画像ファイル" : "動画ファイル"}
                 onChange={(e) => { const f = e.target.files[0]; e.target.value = ""; if (f) c.pickFile(f); }} />
          <Button icon={c.source === "image" ? ImagePlus : Film} onClick={() => pick.current.click()} className="w-full">
            {hasFile ? "選び直す" : c.source === "image" ? "画像を選ぶ" : "動画を選ぶ"}
          </Button>
          {hasFile && (c.isVideo
            ? <video src={c.preview} controls playsInline className="max-h-64 w-full rounded-xl bg-black" aria-label="選んだ動画" />
            : <img src={c.preview} alt="選んだ画像" className="max-h-64 w-full rounded-xl object-contain" />)}
          {hasFile && <p className="truncate text-sm text-m-subtle">{c.file.name}</p>}

          {hasFile && c.isVideo && (
            <div className="space-y-3">
              <div className="space-y-3 rounded-xl border border-m-line-strong p-3">
                <h2 className="text-base font-semibold">映っている人の声をそのまま使う</h2>
                <Field label="見本の名前">
                  <input value={c.videoName} onChange={(e) => c.setVideoName(e.target.value)} className={inputCls} />
                </Field>
                <Field label="開始秒" hint="そこから30秒を使います">
                  <input type="number" min="0" step="1" inputMode="numeric" value={c.start} onChange={(e) => c.setStart(e.target.value)} className={inputCls} />
                </Field>
                <Button icon={Mic} busy={c.videoBusy} disabled={c.videoBusy || !c.videoName.trim()} onClick={c.useVideoVoice} className="w-full">声の見本として保存</Button>
                {c.videoVoice && (
                  <Notice tone="info" action={<Button icon={UserRound} onClick={() => onUse(c.videoVoice)}>読み上げで使う</Button>}>{`「${c.videoVoice}」を保存しました`}</Notice>
                )}
              </div>
              <div className="space-y-3 rounded-xl border border-m-line-strong p-3">
                <h2 className="text-base font-semibold">見た目から声を考える</h2>
                {describeBlock}
              </div>
            </div>
          )}
          {hasFile && !c.isVideo && describeBlock}
        </div>
      )}

      <Field label="声の説明" hint="試し声はこの説明どおりに作ります">
        <textarea rows={4} value={c.desc} onChange={(e) => c.setDesc(e.target.value)} placeholder={DESC_PLACEHOLDER} className={inputCls} />
      </Field>
      <Field label="言語">
        <select value={c.language} onChange={(e) => c.setLang(e.target.value)} className={inputCls}>
          <option value="">自動</option>
          {c.qwen.languages.map((l) => <option key={l} value={l}>{s.info.languages[l] ?? l}</option>)}
        </select>
      </Field>
      <Field label="試し読みの文">
        <textarea rows={2} value={c.testText} onChange={(e) => c.setTestText(e.target.value)} className={inputCls} />
      </Field>

      <div className="space-y-2">
        <Notice tone="error" onClose={() => c.setError("")}>{c.error}</Notice>
        <Button variant="primary" icon={Sparkles} busy={c.trying} disabled={c.trying || !c.desc.trim() || !c.testText.trim()} onClick={c.tryVoice} className="w-full">試し声を作る</Button>
        {c.trying && <Progress text={<>作っています… <span className="m-num">{fmtTime(c.tryElapsed)}</span></>} />}
        <p className="text-sm text-m-subtle">同じ説明でも、作るたびに声が変わります。気に入るまで何度でも作り直せます。</p>
      </div>

      <section aria-labelledby="m-trials" className="pt-4">
        <h2 id="m-trials" className="mb-3 min-h-12 text-base font-semibold">試し声 <span className="m-num text-sm font-normal text-m-muted">{c.trials.length}件</span></h2>
        {!c.trials.length
          ? <Empty icon={Sparkles} title="まだ試し声がありません" hint="「試し声を作る」を押すと、ここに並びます。聴き比べて、気に入った声を保存できます。" />
          : (
            <ul className="space-y-3">
              {c.trials.map((t, i) => (
                <li key={t.file} className={cx("rounded-2xl border bg-m-surface p-4", i === 0 ? "border-m-primary" : "border-m-line")}>
                  <h3 className="text-base font-semibold">{t.title}</h3>
                  <p className="text-sm text-m-subtle">{[t.duration && fmtTime(t.duration), t.elapsed && `生成${Math.round(t.elapsed)}秒`].filter(Boolean).join(" · ")}</p>
                  <audio src={t.url} controls preload="auto" aria-label={`「${t.title}」を再生`} className="mt-3 w-full" />
                  {c.saved[t.file] ? (
                    <div className="mt-3 space-y-2">
                      <p role="status" className="flex items-center gap-1 text-sm font-semibold text-m-primary"><Check size={16} aria-hidden="true" /> 「{c.saved[t.file]}」を保存しました</p>
                      <Button icon={UserRound} onClick={() => onUse(c.saved[t.file])} className="w-full">読み上げで使う</Button>
                    </div>
                  ) : (
                    <div className="mt-3 space-y-2">
                      <input value={c.names[t.file] ?? ""} onChange={(e) => c.setName(t.file, e.target.value)} placeholder="声の名前 (例: 優しい女性)" aria-label="声の名前" className={inputCls} />
                      <Button icon={Save} busy={c.savingFile === t.file} disabled={!!c.savingFile || !(c.names[t.file] ?? "").trim()} onClick={() => c.saveTrial(t)} className="w-full">この声を保存</Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
      </section>
    </div>
  );
}
