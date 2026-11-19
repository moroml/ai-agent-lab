// スマホ版の画像。上から: プロンプト → 条件の要約 (タップでシート) → 作る → ギャラリー。
// 状態・保存キー・API はPC版 (hub/ImageView.jsx) と共通。
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Clapperboard, Dices, ExternalLink, Heart, ImageIcon, RefreshCw, SlidersHorizontal, Sparkles, Trash2, Wand2 } from "lucide-react";
import { cancelJob, enhancePrompt, fetchCategories, generateImage, setFavorite, trashGeneration } from "../hub/api.js";
import { usePersisted, useStudioJob } from "../hub/ui.jsx";
import { Button, cx, Empty, Field, IconButton, inputCls, Loading, Notice, Progress, ScreenHeader, Segmented, Sheet } from "./ui.jsx";
import { jobRunning, OptionGrid, PROMPT_MODES, StudioNotice, useArmed, useStudio } from "./StudioParts.jsx";

const SIZES = [
  { value: "1:1", label: "1:1", w: 1024, h: 1024 },
  { value: "3:4", label: "3:4 縦", w: 896, h: 1184 },
  { value: "4:3", label: "4:3 横", w: 1184, h: 896 },
  { value: "9:16", label: "9:16 縦長", w: 768, h: 1344 },
  { value: "16:9", label: "16:9 横長", w: 1344, h: 768 },
];
const MODEL_NOTES = {
  "flux2-klein": "最速（4ステップ）",
  "flux-schnell": "高速（4ステップ）",
  "z-image": "高速・写実（8ステップ）",
  "qwen-image-fast": "文字入れ・高速",
  "flux-dev": "高品質（20ステップ）",
  "qwen-image": "文字入れ・高品質",
  "flux2-dev-turbo": "FLUX.2 dev（8ステップ）",
};

export default function ImageScreen({ eng, onToVideo }) {
  const { status, ready, catalog, catalogError, items, setItems, listError, reload } = useStudio(eng, "image", 120);
  const [form, setForm] = usePersisted("hub.image.form", { ja: "", en: "", negative: "", model: "", size: "1:1", seed: "", promptMode: "expand", useCase: "free" });
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [viewId, setViewId] = useState(null);
  const [sheetMsg, setSheetMsg] = useState({ text: "", error: false });
  const [favOnly, setFavOnly] = useState(false);
  const [armed, setArmed] = useArmed();
  const promptRef = useRef(null);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const [job, startJob] = useStudioJob((j) => {
    setBusy("");
    if (j.status === "error") setError(j.error || j.progress_text || "生成に失敗しました。もう一度お試しください。");
    reload();
  });

  useEffect(() => {
    fetchCategories().then((c) => setForm((f) => (f.model ? f : { ...f, model: c.categories?.image?.model || "flux2-klein" }))).catch(() => {});
  }, [setForm]);

  const useCases = useMemo(() => (catalog?.use_cases ?? []).filter((u) => u.kind !== "video"), [catalog]);
  const models = catalog?.models ?? [];
  const size = SIZES.find((s) => s.value === form.size) ?? SIZES[0];
  const running = jobRunning(job);
  const working = running || !!busy;
  const viewing = items?.find((x) => x.id === viewId) ?? null;
  const useCaseName = useCases.find((u) => u.id === form.useCase)?.name_ja;

  function applyUseCase(id) {
    const u = useCases.find((x) => x.id === id);
    setForm((f) => {
      const next = { ...f, useCase: id };
      if (u?.model) next.model = u.model;
      if (u?.width && u?.height) {
        const r = u.width / u.height;
        next.size = SIZES.reduce((best, s) => (Math.abs(s.w / s.h - r) < Math.abs(best.w / best.h - r) ? s : best)).value;
      }
      return next;
    });
  }

  async function toEnglish() {
    if (!form.ja.trim()) return form.en;
    setBusy("英語プロンプトを作っています…");
    const u = useCases.find((x) => x.id === form.useCase);
    const { prompt_en } = await enhancePrompt(form.ja, form.promptMode === "translate" ? "translate" : "expand");
    const en = u?.style_hint_en ? `${prompt_en}, ${u.style_hint_en}` : prompt_en;
    set("en", en);
    return en;
  }

  async function rebuildEnglish() {
    setError("");
    try {
      const en = await toEnglish();
      setForm((f) => ({ ...f, en, enFrom: form.ja }));
    } catch (e) {
      setError(`英語プロンプトを作れませんでした: ${e.message}`);
    } finally {
      setBusy("");
    }
  }

  async function generate() {
    setError("");
    setInfo("");
    try {
      let en = form.en.trim();
      if (form.promptMode !== "direct" && (!en || form.enFrom !== form.ja)) {
        en = await toEnglish();
        setForm((f) => ({ ...f, en, enFrom: form.ja }));
      }
      if (!en) throw new Error("プロンプトを入力してください");
      setBusy("送信しています…");
      const seed = form.seed === "" ? null : Number(form.seed);
      const res = await generateImage({ model: form.model, prompt_en: en, prompt_ja: form.ja, negative_en: form.negative, width: size.w, height: size.h, seed });
      startJob(res.job_id);
      setBusy(res.gpu_switch?.length ? `${res.gpu_switch.join("・")}して生成しています…` : "生成しています…");
    } catch (e) {
      setBusy("");
      setError(e.message);
    }
  }

  function reuse(it) {
    setForm((f) => ({ ...f, ja: it.prompt_ja || "", en: it.prompt_en || "", enFrom: it.prompt_ja || "", model: it.model || f.model, seed: it.seed != null ? String(it.seed) : "" }));
    setViewId(null);
    setInfo("この画像の条件を入れました。プロンプトを直して、もう一度作れます。");
  }

  function open(it) {
    setSheetMsg({ text: "", error: false });
    setArmed(null);
    setViewId(it.id);
  }

  // 一覧は API が成功したときだけ書き換える (失敗しても消えたように見せない)
  async function toggleFav(it) {
    try {
      await setFavorite(it.id, !it.is_favorite);
      setItems((xs) => xs.map((x) => (x.id === it.id ? { ...x, is_favorite: !x.is_favorite } : x)));
      setSheetMsg({ text: it.is_favorite ? "お気に入りを外しました" : "お気に入りに入れました", error: false });
    } catch (e) {
      setSheetMsg({ text: `お気に入りを変えられません: ${e.message}`, error: true });
    }
  }

  async function trash(it) {
    if (armed !== it.id) { setArmed(it.id); return; }
    try {
      await trashGeneration(it.id);
      setItems((xs) => xs.filter((x) => x.id !== it.id));
      setViewId(null);
      setArmed(null);
    } catch (e) {
      setArmed(null);
      setSheetMsg({ text: `削除できません: ${e.message}`, error: true });
    }
  }

  const shown = Array.isArray(items) ? (favOnly ? items.filter((x) => x.is_favorite) : items) : null;
  const jaOrEn = form.ja.trim() || form.en.trim();

  return (
    <div className="flex h-full flex-col">
      <ScreenHeader title="画像" />
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-4">
        <StudioNotice status={status} eng={eng} />

        <Field label="作りたい絵" hint="日本語でOK">
          <textarea ref={promptRef} rows={4} value={form.ja} onChange={(e) => set("ja", e.target.value)}
                    placeholder="例: 夕焼けの海辺を走る柴犬、映画のワンシーン風" className={cx(inputCls, "resize-none")} />
        </Field>
        {form.promptMode === "direct" && (
          <Field label="英語プロンプト" hint="そのまま使います">
            <textarea rows={4} value={form.en} onChange={(e) => setForm((f) => ({ ...f, en: e.target.value, enFrom: f.ja }))} className={cx(inputCls, "resize-none")} />
          </Field>
        )}

        <button type="button" onClick={() => setOptionsOpen(true)}
                className="flex min-h-14 w-full items-center gap-3 rounded-xl border border-m-line-strong bg-m-surface px-3 text-left active:bg-m-sunken">
          <SlidersHorizontal size={20} aria-hidden="true" className="shrink-0 text-m-muted" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-m-fg">条件を変える</span>
            <span className="block truncate text-sm text-m-muted">
              {[useCaseName, form.model, size.label].filter(Boolean).join(" · ")}
            </span>
          </span>
          <ChevronRight size={18} aria-hidden="true" className="shrink-0 text-m-subtle" />
        </button>

        <Notice tone="error" onClose={() => setError("")}>{error}</Notice>
        <Notice onClose={() => setInfo("")}>{info}</Notice>
        {working ? (
          <div className="space-y-2">
            <Progress value={running ? job.progress : undefined} text={(running && job.progress_text) || busy} />
            {running && <Button className="w-full" onClick={() => cancelJob(job.id).catch((e) => setError(`中止できません: ${e.message}`))}>生成を中止する</Button>}
          </div>
        ) : (
          <Button variant="primary" icon={Sparkles} className="w-full" onClick={generate} disabled={!ready || !jaOrEn}>画像を作る</Button>
        )}

        <section aria-labelledby="m-image-gallery" className="pt-2">
          <div className="mb-2 flex items-center gap-1">
            <h2 id="m-image-gallery" className="mr-auto text-base font-semibold">
              ギャラリー{shown && <span className="m-num ml-2 text-xs font-normal text-m-subtle">{shown.length}枚</span>}
            </h2>
            <button type="button" onClick={() => setFavOnly((v) => !v)} aria-pressed={favOnly}
                    className={cx("flex min-h-12 items-center gap-1 rounded-xl px-3 text-sm active:bg-m-sunken", favOnly ? "bg-m-primary-soft font-semibold text-m-fg" : "text-m-muted")}>
              <Heart size={18} aria-hidden="true" fill={favOnly ? "currentColor" : "none"} /> お気に入り
            </button>
            <IconButton label="ギャラリーを更新" icon={RefreshCw} onClick={reload} />
          </div>
          {listError && (
            <Notice tone="error" action={<Button onClick={reload}>もう一度読み込む</Button>}>{listError}</Notice>
          )}
          {items === undefined && !listError && (status?.connected === false ? null : <Loading text="ギャラリーを読み込んでいます…" />)}
          {shown && !shown.length && (
            favOnly
              ? <Empty icon={Heart} title="お気に入りはまだありません" hint="画像を開いて、ハートで入れられます。" />
              : <Empty icon={ImageIcon} title="まだ画像がありません" hint="プロンプトを入れて作ると、ここに並びます。"
                       action={<Button icon={Sparkles} onClick={() => promptRef.current?.focus()}>最初の1枚を作る</Button>} />
          )}
          {shown?.length > 0 && (
            <ul className="grid grid-cols-2 gap-2">
              {shown.map((it) => (
                <li key={it.id}>
                  <button type="button" onClick={() => open(it)} aria-label={`画像を開く: ${it.prompt_ja || it.prompt_en || it.id}`}
                          className="relative block aspect-square w-full overflow-hidden rounded-xl bg-m-sunken">
                    <img src={it.thumb_url} alt="" loading="lazy" width={it.width || 1024} height={it.height || 1024} className="size-full object-cover" />
                    {it.is_favorite && (
                      <span className="absolute right-2 top-2 flex size-7 items-center justify-center rounded-full bg-m-raised text-m-primary">
                        <Heart size={16} aria-hidden="true" fill="currentColor" />
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <Sheet open={optionsOpen} onClose={() => setOptionsOpen(false)} title="画像の条件"
             footer={<Button variant="primary" className="w-full" onClick={() => setOptionsOpen(false)}>閉じる</Button>}>
        <div className="space-y-4">
          <Notice tone="error">{catalogError}</Notice>
          {useCases.length > 0 && (
            <Field label="用途" hint="モデルと縦横比が合います">
              <select value={form.useCase} onChange={(e) => applyUseCase(e.target.value)} className={inputCls}>
                {useCases.map((u) => <option key={u.id} value={u.id}>{u.name_ja}</option>)}
              </select>
            </Field>
          )}
          <div>
            <p className="mb-1 text-sm font-semibold">プロンプトの作り方</p>
            <Segmented label="プロンプトの作り方" options={PROMPT_MODES} value={form.promptMode} onChange={(v) => set("promptMode", v)} />
          </div>
          {form.promptMode !== "direct" && (
            <div className="space-y-2">
              <Field label="英語プロンプト" hint="空なら生成時に自動で作ります">
                <textarea rows={4} value={form.en} onChange={(e) => setForm((f) => ({ ...f, en: e.target.value, enFrom: f.ja }))} className={cx(inputCls, "resize-none")} />
              </Field>
              <Button icon={Wand2} busy={!!busy && busy.startsWith("英語")} disabled={!form.ja.trim() || !!busy} onClick={rebuildEnglish}>日本語から作り直す</Button>
            </div>
          )}
          <Field label="モデル" hint={models.find((m) => m.id === form.model)?.steps ? `${models.find((m) => m.id === form.model).steps} steps` : ""}>
            <select value={form.model} onChange={(e) => set("model", e.target.value)} className={inputCls}>
              {form.model && !models.some((m) => m.id === form.model) && <option value={form.model}>{form.model}</option>}
              {models.map((m) => <option key={m.id} value={m.id}>{m.id}{MODEL_NOTES[m.id] ? ` — ${MODEL_NOTES[m.id]}` : ""}</option>)}
            </select>
          </Field>
          <OptionGrid label="縦横比" hint={`${size.w}×${size.h}`} options={SIZES} value={form.size} onChange={(v) => set("size", v)} />
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <Field label="seed" hint="空ならランダム">
                <input inputMode="numeric" value={form.seed} onChange={(e) => set("seed", e.target.value.replace(/\D/g, "").slice(0, 15))} className={cx(inputCls, "m-num")} />
              </Field>
            </div>
            <IconButton label="seedをランダムに戻す" icon={Dices} onClick={() => set("seed", "")} className="border border-m-line-strong" />
          </div>
          <Field label="ネガティブ" hint="英語で、出したくないもの">
            <textarea rows={2} value={form.negative} onChange={(e) => set("negative", e.target.value)} className={cx(inputCls, "resize-none")} />
          </Field>
        </div>
      </Sheet>

      <Sheet open={!!viewing} onClose={() => setViewId(null)} title="画像"
             footer={viewing && (
               <Button variant="primary" icon={Clapperboard} className="w-full" onClick={() => { onToVideo?.(viewing); setViewId(null); }}>この画像から動画を作る</Button>
             )}>
        {viewing && (
          <div className="space-y-4">
            <img src={viewing.url} alt={viewing.prompt_ja || viewing.prompt_en || "生成した画像"}
                 width={viewing.width || 1024} height={viewing.height || 1024}
                 style={{ aspectRatio: `${viewing.width || 1} / ${viewing.height || 1}` }}
                 className="mx-auto max-h-[50dvh] w-auto max-w-full rounded-xl bg-m-sunken object-contain" />
            <p className="whitespace-pre-wrap text-base">{viewing.prompt_ja || viewing.prompt_en}</p>
            <p className="m-num text-xs text-m-subtle">{viewing.model} · {viewing.width}×{viewing.height} · seed {viewing.seed}</p>
            <div className="grid grid-cols-2 gap-2">
              <Button icon={Heart} onClick={() => toggleFav(viewing)} aria-pressed={!!viewing.is_favorite}>
                {viewing.is_favorite ? "お気に入り済み" : "お気に入り"}
              </Button>
              <Button icon={RefreshCw} onClick={() => reuse(viewing)}>条件を再利用</Button>
              <a href={viewing.url} target="_blank" rel="noreferrer"
                 className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-m-line-strong bg-m-surface px-4 text-base font-semibold text-m-fg active:bg-m-sunken">
                <ExternalLink size={18} aria-hidden="true" /> 原寸で開く
              </a>
              {armed === viewing.id
                ? <Button variant="danger" icon={Trash2} onClick={() => trash(viewing)}>削除する</Button>
                : <Button icon={Trash2} onClick={() => trash(viewing)}>ゴミ箱へ</Button>}
            </div>
            {sheetMsg.text && <Notice tone={sheetMsg.error ? "error" : "info"}>{sheetMsg.text}</Notice>}
          </div>
        )}
      </Sheet>
    </div>
  );
}
