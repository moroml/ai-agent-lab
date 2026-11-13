// 動画: 起点(文章 or 画像)→ 長さ・画角 → 生成。結果は再生できるカードで並べる。
import { useCallback, useEffect, useState } from "react";
import { Clapperboard, Film, ImagePlus, RefreshCw, Trash2, X } from "lucide-react";
import {
  cancelJob, enhancePrompt, fetchCategories, generateVideo, studioCatalog, studioGallery,
  studioStatus, trashGeneration,
} from "./api.js";
import { Button, Chips, ErrorNote, Field, inputCls, Progress, StudioOffline, usePersisted, useStudioJob } from "./ui.jsx";

const FPS = 24;
// Wan 2.2 5B は約121フレームを超えると崩れるため、それ以上は区間をつないで伸ばす(LGS の segments)
const LENGTHS = [
  { value: "2", label: "約2秒", frames: 49, segments: 1 },
  { value: "3", label: "約3秒", frames: 81, segments: 1 },
  { value: "5", label: "約5秒", frames: 121, segments: 1 },
  { value: "10", label: "約10秒", frames: 121, segments: 2 },
];
const FRAMES = [
  { value: "land", label: "横 832×480", w: 832, h: 480 },
  { value: "port", label: "縦 480×832", w: 480, h: 832 },
  { value: "hd", label: "横 HD 1280×704", w: 1280, h: 704 },
];

export default function VideoView({ source, onSourceChange }) {
  const [status, setStatus] = useState(null);
  const [catalog, setCatalog] = useState(null);
  const [items, setItems] = useState([]);
  const [images, setImages] = useState(null);
  const [form, setForm] = usePersisted("hub.video.form", { ja: "", en: "", model: "", length: "2", frame: "land", promptMode: "expand" });
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const reload = useCallback(() => studioGallery("video", 60).then((d) => setItems(d.items)).catch((e) => setError(e.message)), []);
  const [job, startJob] = useStudioJob((j) => {
    setBusy("");
    if (j.status === "error") setError(j.error || j.progress_text || "生成に失敗しました");
    reload();
  });

  useEffect(() => {
    studioStatus().then((s) => {
      setStatus(s);
      if (!s.connected) return;
      studioCatalog().then(setCatalog).catch((e) => setError(e.message));
      reload();
    });
    fetchCategories().then((c) => setForm((f) => (f.model ? f : { ...f, model: c.categories?.video?.model || "wan22-ti2v-5b-turbo" }))).catch(() => {});
  }, [reload, setForm]);

  // 画像から来たら、その画像の向きに合わせる
  useEffect(() => {
    if (source?.width && source?.height) set("frame", source.height > source.width ? "port" : "land");
    if (source?.prompt_ja && !form.ja) set("ja", source.prompt_ja);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source?.id]);

  const len = LENGTHS.find((l) => l.value === form.length) ?? LENGTHS[0];
  const frame = FRAMES.find((f) => f.value === form.frame) ?? FRAMES[0];
  const running = job && !["done", "error", "cancelled"].includes(job.status);
  const modelInfo = catalog?.video_models?.find((m) => m.id === form.model);

  async function generate() {
    setError("");
    try {
      let en = form.en.trim();
      if (form.promptMode !== "direct" && form.ja.trim() && (!en || form.enFrom !== form.ja)) {
        setBusy("英語プロンプトを作成中…");
        en = (await enhancePrompt(form.ja, form.promptMode)).prompt_en;
        setForm((f) => ({ ...f, en, enFrom: f.ja }));
      }
      if (!en) throw new Error("動きの説明を入力してください");
      setBusy("送信中…");
      const res = await generateVideo({
        mode: source ? "i2v" : "t2v", source_generation_id: source?.id ?? null, video_model: form.model,
        prompt_en: en, prompt_ja: form.ja, width: frame.w, height: frame.h, frames: len.frames, segments: len.segments,
      });
      startJob(res.job_id);
      setBusy(res.gpu_switch?.length ? `${res.gpu_switch.join("・")}して生成中…` : "生成中…");
    } catch (e) {
      setBusy("");
      setError(e.message);
    }
  }

  async function openPicker() {
    setImages([]);
    studioGallery("image", 60).then((d) => setImages(d.items)).catch((e) => { setImages(null); setError(e.message); });
  }

  async function trash(it) {
    await trashGeneration(it.id).catch((e) => setError(e.message));
    setItems((xs) => xs.filter((x) => x.id !== it.id));
  }

  if (status && !status.connected) return <div className="p-6"><StudioOffline reason={status.reason} /></div>;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl space-y-6 p-4">
        <header className="flex items-center gap-2">
          <Clapperboard size={20} className="text-rose-300" aria-hidden="true" />
          <h1 className="text-base font-semibold text-rose-200">動画を作る</h1>
          <span className="text-xs text-slate-500">Wan 2.2 · {FPS}fps</span>
        </header>

        <div className="grid gap-4 rounded-2xl border border-slate-800 bg-slate-900/40 p-4 md:grid-cols-[220px_1fr]">
          <div className="space-y-2">
            <p className="text-xs font-medium text-slate-300">起点</p>
            {source ? (
              <div className="relative overflow-hidden rounded-xl border border-rose-500/40">
                <img src={source.thumb_url} alt="起点の画像" className="aspect-square w-full object-cover" />
                <button type="button" onClick={() => onSourceChange(null)} className="absolute right-1.5 top-1.5 min-h-8 min-w-8 rounded-full bg-black/70 text-slate-200" aria-label="起点の画像を外す"><X size={14} className="mx-auto" aria-hidden="true" /></button>
                <p className="bg-black/60 px-2 py-1 text-[11px] text-rose-200">画像→動画（I2V）</p>
              </div>
            ) : (
              <button type="button" onClick={openPicker} className="flex aspect-square w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-slate-700 text-xs text-slate-400 hover:border-rose-500/50 hover:text-rose-200">
                <ImagePlus size={24} aria-hidden="true" /> 画像から始める<span className="text-slate-600">（なしなら文章→動画）</span>
              </button>
            )}
          </div>

          <div className="space-y-3">
            <Field label={source ? "どう動かすか（日本語でOK）" : "どんな動画か（日本語でOK）"}>
              <textarea rows={3} value={form.ja} onChange={(e) => set("ja", e.target.value)} placeholder="例: カメラがゆっくり近づき、髪が風になびく" className={`${inputCls} focus:ring-rose-500/50`} />
            </Field>
            <Chips accent="rose" value={form.promptMode} onChange={(v) => set("promptMode", v)} options={[{ value: "expand", label: "AIが描写を足す" }, { value: "translate", label: "忠実に英訳" }, { value: "direct", label: "英語で直接書く" }]} />
            {(form.promptMode === "direct" || form.en) && (
              <Field label="英語プロンプト">
                <textarea rows={2} value={form.en} onChange={(e) => setForm((f) => ({ ...f, en: e.target.value, enFrom: f.ja }))} className={`${inputCls} font-mono text-xs focus:ring-rose-500/50`} />
              </Field>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="長さ" hint={`${len.frames}フレーム${len.segments > 1 ? `×${len.segments}区間` : ""}`}>
                <Chips accent="rose" options={LENGTHS} value={form.length} onChange={(v) => set("length", v)} />
              </Field>
              <Field label="画角">
                <Chips accent="rose" options={FRAMES} value={form.frame} onChange={(v) => set("frame", v)} />
              </Field>
            </div>
            <Field label="モデル" hint={modelInfo ? `${modelInfo.steps} steps` : ""}>
              <select value={form.model} onChange={(e) => set("model", e.target.value)} className={`${inputCls} focus:ring-rose-500/50`}>
                {(catalog?.video_models ?? []).map((m) => <option key={m.id} value={m.id}>{m.id}{m.steps <= 4 ? " — 高速（蒸留）" : " — 標準品質"}</option>)}
              </select>
            </Field>
            <ErrorNote text={error} onClose={() => setError("")} />
            {running ? (
              <div className="space-y-2">
                <Progress value={job.progress} text={job.progress_text || busy} accent="rose" />
                <Button variant="ghost" onClick={() => cancelJob(job.id).catch((e) => setError(e.message))}>中止</Button>
              </div>
            ) : (
              <Button accent="rose" onClick={generate} disabled={!!busy || (!form.ja.trim() && !form.en.trim())}>
                <Film size={16} aria-hidden="true" /> {busy || "動画を生成"}
              </Button>
            )}
          </div>
        </div>

        <section>
          <div className="mb-3 flex items-center">
            <h2 className="mr-auto text-sm font-semibold text-slate-200">作った動画 <span className="font-normal text-slate-500">{items.length}本</span></h2>
            <button type="button" onClick={reload} className="flex min-h-9 items-center gap-1 px-2 text-xs text-slate-400 hover:text-slate-200"><RefreshCw size={14} aria-hidden="true" /> 更新</button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((it) => (
              <article key={it.id} className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/50">
                <video src={it.url} controls preload="metadata" playsInline className="aspect-video w-full bg-black object-contain" />
                <div className="flex items-start gap-2 p-2">
                  <p className="line-clamp-2 flex-1 text-xs text-slate-300">{it.prompt_ja || it.prompt_en}</p>
                  <button type="button" onClick={() => trash(it)} className="min-h-8 min-w-8 text-slate-500 hover:text-red-300" aria-label="ゴミ箱へ"><Trash2 size={14} className="mx-auto" aria-hidden="true" /></button>
                </div>
              </article>
            ))}
          </div>
          {!items.length && <p className="py-12 text-center text-sm text-slate-500">まだ動画がありません</p>}
        </section>
      </div>

      {images && (
        <div className="fixed inset-0 z-40 flex flex-col bg-black/85 p-4" role="dialog" aria-modal="true" aria-label="起点の画像を選ぶ">
          <div className="mb-3 flex items-center">
            <p className="mr-auto text-sm text-slate-200">起点にする画像を選ぶ</p>
            <button type="button" onClick={() => setImages(null)} className="min-h-10 min-w-10 text-slate-300" aria-label="閉じる"><X size={20} className="mx-auto" aria-hidden="true" /></button>
          </div>
          <div className="grid min-h-0 flex-1 grid-cols-3 content-start gap-2 overflow-y-auto sm:grid-cols-5 lg:grid-cols-8">
            {images.map((im) => (
              <button key={im.id} type="button" onClick={() => { onSourceChange(im); setImages(null); }} className="aspect-square overflow-hidden rounded-lg bg-slate-900 hover:ring-2 hover:ring-rose-400" aria-label={`画像 ${im.id} を起点にする`}>
                <img src={im.thumb_url} alt="" loading="lazy" className="h-full w-full object-cover" />
              </button>
            ))}
            {!images.length && <p className="col-span-full py-10 text-center text-sm text-slate-500">読み込み中…</p>}
          </div>
        </div>
      )}
    </div>
  );
}
