// スマホ版の動画。上から: 起点 (文章 or 画像) → 動きの説明 → 長さ・画角 → 作る → 作った動画。
// 状態・保存キー・API はPC版 (hub/VideoView.jsx) と共通。
import { useEffect, useState } from "react";
import { ExternalLink, Film, ImagePlus, RefreshCw, Trash2, X } from "lucide-react";
import { cancelJob, enhancePrompt, fetchCategories, generateVideo, studioGallery, trashGeneration } from "../hub/api.js";
import { usePersisted, useStudioJob } from "../hub/ui.jsx";
import { Button, cx, Empty, Field, IconButton, inputCls, Loading, Notice, Progress, ScreenHeader, Segmented, Sheet } from "./ui.jsx";
import { jobRunning, OptionGrid, PROMPT_MODES, StudioNotice, useArmed, useStudio } from "./StudioParts.jsx";

const FPS = 24;
// Wan 2.2 5B は約121フレームを超えると崩れるため、それ以上は区間をつないで伸ばす (LGS の segments)
const LENGTHS = [
  { value: "2", label: "約2秒", frames: 49, segments: 1 },
  { value: "3", label: "約3秒", frames: 81, segments: 1 },
  { value: "5", label: "約5秒", frames: 121, segments: 1 },
  { value: "10", label: "約10秒", frames: 121, segments: 2 },
];
const FRAMES = [
  { value: "land", label: "横", sub: "832×480", w: 832, h: 480 },
  { value: "port", label: "縦", sub: "480×832", w: 480, h: 832 },
  { value: "hd", label: "横 HD", sub: "1280×704", w: 1280, h: 704 },
];

export default function VideoScreen({ eng, source, onSourceChange }) {
  const { status, ready, catalog, catalogError, items, setItems, listError, reload } = useStudio(eng, "video", 60);
  const [form, setForm] = usePersisted("hub.video.form", { ja: "", en: "", model: "", length: "2", frame: "land", promptMode: "expand" });
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [images, setImages] = useState();   // undefined=読込中 / null=失敗 / []=空
  const [armed, setArmed] = useArmed();
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const [job, startJob] = useStudioJob((j) => {
    setBusy("");
    if (j.status === "error") setError(j.error || j.progress_text || "生成に失敗しました。もう一度お試しください。");
    reload();
  });

  useEffect(() => {
    fetchCategories().then((c) => setForm((f) => (f.model ? f : { ...f, model: c.categories?.video?.model || "wan22-ti2v-5b-turbo" }))).catch(() => {});
  }, [setForm]);

  // 画像から来たら、その画像の向きに合わせる
  useEffect(() => {
    if (source?.width && source?.height) set("frame", source.height > source.width ? "port" : "land");
    if (source?.prompt_ja && !form.ja) set("ja", source.prompt_ja);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source?.id]);

  const len = LENGTHS.find((l) => l.value === form.length) ?? LENGTHS[0];
  const frame = FRAMES.find((f) => f.value === form.frame) ?? FRAMES[0];
  const running = jobRunning(job);
  const working = running || !!busy;
  const models = catalog?.video_models ?? [];
  const modelInfo = models.find((m) => m.id === form.model);

  async function generate() {
    setError("");
    try {
      let en = form.en.trim();
      if (form.promptMode !== "direct" && form.ja.trim() && (!en || form.enFrom !== form.ja)) {
        setBusy("英語プロンプトを作っています…");
        en = (await enhancePrompt(form.ja, form.promptMode)).prompt_en;
        setForm((f) => ({ ...f, en, enFrom: form.ja }));
      }
      if (!en) throw new Error("動きの説明を入力してください");
      setBusy("送信しています…");
      const res = await generateVideo({
        mode: source ? "i2v" : "t2v", source_generation_id: source?.id ?? null, video_model: form.model,
        prompt_en: en, prompt_ja: form.ja, width: frame.w, height: frame.h, frames: len.frames, segments: len.segments,
      });
      startJob(res.job_id);
      setBusy(res.gpu_switch?.length ? `${res.gpu_switch.join("・")}して生成しています…` : "生成しています…");
    } catch (e) {
      setBusy("");
      setError(e.message);
    }
  }

  function loadImages() {
    setImages(undefined);
    studioGallery("image", 60).then((d) => setImages(d.items)).catch(() => setImages(null));
  }
  function openPicker() {
    setPickerOpen(true);
    loadImages();
  }

  // 一覧は API が成功したときだけ書き換える
  async function trash(it) {
    if (armed !== it.id) { setArmed(it.id); return; }
    try {
      await trashGeneration(it.id);
      setItems((xs) => xs.filter((x) => x.id !== it.id));
      setArmed(null);
    } catch (e) {
      setArmed(null);
      setError(`削除できません: ${e.message}`);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <ScreenHeader title="動画" />
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-4">
        <StudioNotice status={status} eng={eng} />

        <section aria-labelledby="m-video-source">
          <h2 id="m-video-source" className="mb-1 text-sm font-semibold">起点</h2>
          {source ? (
            <div className="flex items-center gap-3 rounded-xl border border-m-line-strong bg-m-surface p-2">
              <img src={source.thumb_url} alt="起点の画像" width={source.width || 1024} height={source.height || 1024}
                   className="size-16 shrink-0 rounded-lg bg-m-sunken object-cover" />
              <p className="min-w-0 flex-1 text-sm"><span className="block font-semibold">画像から動画にします</span><span className="block text-m-muted">動きは下の説明で決まります</span></p>
              <IconButton label="起点の画像を外す" icon={X} onClick={() => onSourceChange?.(null)} />
            </div>
          ) : (
            <Button icon={ImagePlus} className="w-full" onClick={openPicker}>画像から始める</Button>
          )}
          {!source && <p className="mt-1 text-sm text-m-subtle">選ばなければ、文章だけから作ります。</p>}
        </section>

        <Field label={source ? "どう動かすか" : "どんな動画か"} hint="日本語でOK">
          <textarea rows={3} value={form.ja} onChange={(e) => set("ja", e.target.value)}
                    placeholder="例: カメラがゆっくり近づき、髪が風になびく" className={cx(inputCls, "resize-none")} />
        </Field>
        <div>
          <p className="mb-1 text-sm font-semibold">プロンプトの作り方</p>
          <Segmented label="プロンプトの作り方" options={PROMPT_MODES} value={form.promptMode} onChange={(v) => set("promptMode", v)} />
        </div>
        {(form.promptMode === "direct" || form.en) && (
          <Field label="英語プロンプト" hint={form.promptMode === "direct" ? "そのまま使います" : "空なら自動で作ります"}>
            <textarea rows={3} value={form.en} onChange={(e) => setForm((f) => ({ ...f, en: e.target.value, enFrom: f.ja }))} className={cx(inputCls, "resize-none")} />
          </Field>
        )}

        <OptionGrid label="長さ" hint={`${len.frames}フレーム${len.segments > 1 ? `×${len.segments}区間` : ""} · ${FPS}fps`} cols="grid-cols-4"
                    options={LENGTHS} value={form.length} onChange={(v) => set("length", v)} />
        <OptionGrid label="画角" options={FRAMES} value={form.frame} onChange={(v) => set("frame", v)} />
        <Field label="モデル" hint={modelInfo ? `${modelInfo.steps} steps` : ""}>
          <select value={form.model} onChange={(e) => set("model", e.target.value)} className={inputCls}>
            {form.model && !models.some((m) => m.id === form.model) && <option value={form.model}>{form.model}</option>}
            {models.map((m) => <option key={m.id} value={m.id}>{m.id}{m.steps <= 4 ? " — 高速（蒸留）" : " — 標準品質"}</option>)}
          </select>
        </Field>
        <Notice tone="error">{catalogError}</Notice>

        <Notice tone="error" onClose={() => setError("")}>{error}</Notice>
        {working ? (
          <div className="space-y-2">
            <Progress value={running ? job.progress : undefined} text={(running && job.progress_text) || busy} />
            {running && <Button className="w-full" onClick={() => cancelJob(job.id).catch((e) => setError(`中止できません: ${e.message}`))}>生成を中止する</Button>}
          </div>
        ) : (
          <Button variant="primary" icon={Film} className="w-full" onClick={generate} disabled={!ready || (!form.ja.trim() && !form.en.trim())}>動画を作る</Button>
        )}

        <section aria-labelledby="m-video-list" className="pt-2">
          <div className="mb-2 flex items-center gap-1">
            <h2 id="m-video-list" className="mr-auto text-base font-semibold">
              作った動画{Array.isArray(items) && <span className="m-num ml-2 text-xs font-normal text-m-subtle">{items.length}本</span>}
            </h2>
            <IconButton label="動画の一覧を更新" icon={RefreshCw} onClick={reload} />
          </div>
          {listError && <Notice tone="error" action={<Button onClick={reload}>もう一度読み込む</Button>}>{listError}</Notice>}
          {items === undefined && !listError && (status?.connected === false ? null : <Loading text="動画を読み込んでいます…" />)}
          {Array.isArray(items) && !items.length && (
            <Empty icon={Film} title="まだ動画がありません" hint="説明を入れて作ると、ここで再生できます。" />
          )}
          {items?.length > 0 && (
            <ul className="space-y-4">
              {items.map((it) => (
                <li key={it.id} className="overflow-hidden rounded-xl border border-m-line bg-m-surface">
                  <video src={it.url} controls preload="metadata" playsInline
                         style={{ aspectRatio: `${it.width || 16} / ${it.height || 9}` }}
                         className="max-h-[60dvh] w-full bg-m-sunken object-contain" />
                  <div className="space-y-1 px-3 pt-2">
                    <p className="line-clamp-3 text-base">{it.prompt_ja || it.prompt_en}</p>
                    {it.width && <p className="m-num text-xs text-m-subtle">{it.width}×{it.height}{it.model ? ` · ${it.model}` : ""}</p>}
                  </div>
                  <div className="flex items-center justify-end gap-2 p-2">
                    <a href={it.url} target="_blank" rel="noreferrer"
                       className="inline-flex min-h-12 items-center gap-2 rounded-xl px-3 text-sm font-semibold text-m-primary active:bg-m-primary-soft">
                      <ExternalLink size={18} aria-hidden="true" /> 別タブで開く
                    </a>
                    {armed === it.id
                      ? <Button variant="danger" icon={Trash2} onClick={() => trash(it)}>削除する</Button>
                      : <IconButton label="この動画をゴミ箱へ" icon={Trash2} onClick={() => trash(it)} />}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <Sheet open={pickerOpen} onClose={() => setPickerOpen(false)} title="起点にする画像を選ぶ">
        {images === undefined && <Loading text="画像を読み込んでいます…" />}
        {images === null && (
          <Notice tone="error" action={<Button onClick={loadImages}>もう一度読み込む</Button>}>画像の一覧を読み込めませんでした。</Notice>
        )}
        {Array.isArray(images) && !images.length && <Empty icon={ImagePlus} title="画像がまだありません" hint="先に「画像」の画面で作ると、ここから選べます。" />}
        {images?.length > 0 && (
          <ul className="grid grid-cols-3 gap-2">
            {images.map((im) => (
              <li key={im.id}>
                <button type="button" onClick={() => { onSourceChange?.(im); setPickerOpen(false); }}
                        aria-label={`起点にする: ${im.prompt_ja || im.prompt_en || im.id}`}
                        className="block aspect-square w-full overflow-hidden rounded-lg bg-m-sunken active:opacity-70">
                  <img src={im.thumb_url} alt="" loading="lazy" width={im.width || 1024} height={im.height || 1024} className="size-full object-cover" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Sheet>
    </div>
  );
}
