// 画像: 左に生成パネル、右にギャラリーのスタジオ型画面。生成は Local Gen Studio に中継する。
import { useCallback, useEffect, useMemo, useState } from "react";
import { Clapperboard, Dices, Heart, RefreshCw, Sparkles, Trash2, Wand2, X } from "lucide-react";
import {
  cancelJob, enhancePrompt, fetchCategories, generateImage, setFavorite, studioCatalog,
  studioGallery, studioStatus, trashGeneration,
} from "./api.js";
import { Button, Chips, ErrorNote, Field, inputCls, Progress, StudioOffline, usePersisted, useStudioJob } from "./ui.jsx";

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
const PROMPT_MODES = [
  { value: "expand", label: "AIが描写を足す" },
  { value: "translate", label: "忠実に英訳" },
  { value: "direct", label: "英語で直接書く" },
];

export default function ImageView({ onToVideo }) {
  const [status, setStatus] = useState(null);
  const [catalog, setCatalog] = useState(null);
  const [items, setItems] = useState([]);
  const [form, setForm] = usePersisted("hub.image.form", { ja: "", en: "", negative: "", model: "", size: "1:1", seed: "", promptMode: "expand", useCase: "free" });
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [viewing, setViewing] = useState(null);
  const [favOnly, setFavOnly] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const reload = useCallback(() => studioGallery("image", 120).then((d) => setItems(d.items)).catch((e) => setError(e.message)), []);
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
    fetchCategories().then((c) => setForm((f) => (f.model ? f : { ...f, model: c.categories?.image?.model || "flux2-klein" }))).catch(() => {});
  }, [reload, setForm]);

  const useCases = useMemo(() => (catalog?.use_cases ?? []).filter((u) => u.kind !== "video"), [catalog]);
  const size = SIZES.find((s) => s.value === form.size) ?? SIZES[0];
  const running = job && !["done", "error", "cancelled"].includes(job.status);

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
    setBusy("英語プロンプトを作成中…");
    const u = useCases.find((x) => x.id === form.useCase);
    const { prompt_en } = await enhancePrompt(form.ja, form.promptMode === "translate" ? "translate" : "expand");
    const en = u?.style_hint_en ? `${prompt_en}, ${u.style_hint_en}` : prompt_en;
    set("en", en);
    return en;
  }

  async function generate() {
    setError("");
    try {
      let en = form.en.trim();
      if (form.promptMode !== "direct" && (!en || form.enFrom !== form.ja)) {
        en = await toEnglish();
        setForm((f) => ({ ...f, en, enFrom: f.ja }));
      }
      if (!en) throw new Error("プロンプトを入力してください");
      setBusy("送信中…");
      const seed = form.seed === "" ? null : Number(form.seed);
      const res = await generateImage({ model: form.model, prompt_en: en, prompt_ja: form.ja, negative_en: form.negative, width: size.w, height: size.h, seed });
      startJob(res.job_id);
      setBusy(res.gpu_switch?.length ? `${res.gpu_switch.join("・")}して生成中…` : "生成中…");
    } catch (e) {
      setBusy("");
      setError(e.message);
    }
  }

  function reuse(it) {
    setForm((f) => ({ ...f, ja: it.prompt_ja || "", en: it.prompt_en || "", enFrom: it.prompt_ja || "", model: it.model || f.model, seed: it.seed != null ? String(it.seed) : "" }));
    setViewing(null);
  }

  async function toggleFav(it) {
    await setFavorite(it.id, !it.is_favorite).catch((e) => setError(e.message));
    setItems((xs) => xs.map((x) => (x.id === it.id ? { ...x, is_favorite: !x.is_favorite } : x)));
  }

  async function trash(it) {
    await trashGeneration(it.id).catch((e) => setError(e.message));
    setItems((xs) => xs.filter((x) => x.id !== it.id));
    setViewing(null);
  }

  if (status && !status.connected) return <div className="p-6"><StudioOffline reason={status.reason} /></div>;
  const shown = favOnly ? items.filter((x) => x.is_favorite) : items;

  return (
    <div className="flex h-full flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
      <section className="space-y-4 border-slate-800 p-4 lg:w-[380px] lg:shrink-0 lg:overflow-y-auto lg:border-r">
        <h1 className="flex items-center gap-2 text-base font-semibold text-violet-200"><Sparkles size={18} aria-hidden="true" /> 画像を作る</h1>
        {status?.comfy === false && <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">ComfyUI(8188) が起動していません。生成するには start-studio.bat で起動してください。</p>}

        {useCases.length > 0 && (
          <Field label="用途">
            <select value={form.useCase} onChange={(e) => applyUseCase(e.target.value)} className={`${inputCls} focus:ring-violet-500/50`}>
              {useCases.map((u) => <option key={u.id} value={u.id}>{u.name_ja}</option>)}
            </select>
          </Field>
        )}

        <Field label="作りたい絵（日本語でOK）">
          <textarea rows={4} value={form.ja} onChange={(e) => set("ja", e.target.value)} placeholder="例: 夕焼けの海辺を走る柴犬、映画のワンシーン風" className={`${inputCls} focus:ring-violet-500/50`} />
        </Field>
        <Chips options={PROMPT_MODES} value={form.promptMode} onChange={(v) => set("promptMode", v)} accent="violet" />

        <Field label="英語プロンプト" hint={form.promptMode === "direct" ? "これをそのまま使う" : "生成時に自動作成・編集可"}>
          <div className="relative">
            <textarea rows={4} value={form.en} onChange={(e) => setForm((f) => ({ ...f, en: e.target.value, enFrom: f.ja }))} placeholder="空なら日本語から自動で作ります" className={`${inputCls} font-mono text-xs focus:ring-violet-500/50`} />
            {form.promptMode !== "direct" && (
              <button type="button" onClick={() => toEnglish().then((en) => setForm((f) => ({ ...f, en, enFrom: f.ja }))).catch((e) => { setBusy(""); setError(e.message); }).finally(() => setBusy((b) => (b.startsWith("英語") ? "" : b)))} disabled={!form.ja.trim() || !!busy} className="absolute bottom-2 right-2 flex min-h-8 items-center gap-1 rounded-md bg-slate-800 px-2 text-[11px] text-violet-200 hover:bg-slate-700 disabled:opacity-40">
                <Wand2 size={12} aria-hidden="true" /> 作り直す
              </button>
            )}
          </div>
        </Field>

        <Field label="モデル" hint={catalog?.models?.find((m) => m.id === form.model)?.steps ? `${catalog.models.find((m) => m.id === form.model).steps} steps` : ""}>
          <select value={form.model} onChange={(e) => set("model", e.target.value)} className={`${inputCls} focus:ring-violet-500/50`}>
            {(catalog?.models ?? []).map((m) => <option key={m.id} value={m.id}>{m.id}{MODEL_NOTES[m.id] ? ` — ${MODEL_NOTES[m.id]}` : ""}</option>)}
          </select>
        </Field>

        <Field label="縦横比" hint={`${size.w}×${size.h}`}>
          <Chips options={SIZES} value={form.size} onChange={(v) => set("size", v)} accent="violet" />
        </Field>

        <details className="rounded-lg border border-slate-800 px-3 py-2">
          <summary className="cursor-pointer select-none text-xs text-slate-400">詳細（seed・ネガティブ）</summary>
          <div className="mt-3 space-y-3">
            <Field label="seed" hint="空ならランダム">
              <div className="flex gap-2">
                <input inputMode="numeric" value={form.seed} onChange={(e) => set("seed", e.target.value.replace(/\D/g, "").slice(0, 15))} className={`${inputCls} focus:ring-violet-500/50`} />
                <Button variant="ghost" onClick={() => set("seed", "")} aria-label="ランダムに戻す"><Dices size={16} aria-hidden="true" /></Button>
              </div>
            </Field>
            <Field label="ネガティブ（英語）">
              <textarea rows={2} value={form.negative} onChange={(e) => set("negative", e.target.value)} className={`${inputCls} font-mono text-xs focus:ring-violet-500/50`} />
            </Field>
          </div>
        </details>

        <ErrorNote text={error} onClose={() => setError("")} />
        {running ? (
          <div className="space-y-2">
            <Progress value={job.progress} text={job.progress_text || busy} accent="violet" />
            <Button variant="ghost" className="w-full" onClick={() => cancelJob(job.id).catch((e) => setError(e.message))}>中止</Button>
          </div>
        ) : (
          <Button className="w-full" onClick={generate} disabled={!!busy || (!form.ja.trim() && !form.en.trim())}>
            <Sparkles size={16} aria-hidden="true" /> {busy || "生成する"}
          </Button>
        )}
      </section>

      <section className="min-h-0 flex-1 p-4 lg:overflow-y-auto">
        <div className="mb-3 flex items-center gap-2">
          <h2 className="mr-auto text-sm font-semibold text-slate-200">ギャラリー <span className="font-normal text-slate-500">{shown.length}枚</span></h2>
          <button type="button" onClick={() => setFavOnly((v) => !v)} aria-pressed={favOnly} className={`flex min-h-9 items-center gap-1 rounded-lg px-2 text-xs ${favOnly ? "text-pink-300" : "text-slate-400"}`}>
            <Heart size={14} aria-hidden="true" fill={favOnly ? "currentColor" : "none"} /> お気に入り
          </button>
          <button type="button" onClick={reload} className="flex min-h-9 items-center gap-1 rounded-lg px-2 text-xs text-slate-400 hover:text-slate-200"><RefreshCw size={14} aria-hidden="true" /> 更新</button>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
          {shown.map((it) => (
            <button key={it.id} type="button" onClick={() => setViewing(it)} className="group relative aspect-square overflow-hidden rounded-lg bg-slate-900" aria-label={`画像 ${it.id} を開く`}>
              <img src={it.thumb_url} alt={it.prompt_ja || it.prompt_en} loading="lazy" className="h-full w-full object-cover transition group-hover:scale-105" />
              {it.is_favorite && <Heart size={14} className="absolute right-1.5 top-1.5 text-pink-300" fill="currentColor" aria-hidden="true" />}
            </button>
          ))}
        </div>
        {!shown.length && <p className="py-16 text-center text-sm text-slate-500">まだ画像がありません</p>}
      </section>

      {viewing && (
        <div className="fixed inset-0 z-40 flex flex-col bg-black/90 p-3 md:p-6" role="dialog" aria-modal="true" aria-label="画像の詳細">
          <div className="flex items-center gap-2">
            <p className="mr-auto truncate text-xs text-slate-400">{viewing.model} · {viewing.width}×{viewing.height} · seed {viewing.seed}</p>
            <button type="button" onClick={() => setViewing(null)} className="min-h-10 min-w-10 rounded-lg text-slate-300 hover:bg-slate-800" aria-label="閉じる"><X size={20} aria-hidden="true" className="mx-auto" /></button>
          </div>
          <img src={viewing.url} alt={viewing.prompt_ja || viewing.prompt_en} className="mx-auto my-3 min-h-0 flex-1 object-contain" />
          <p className="mx-auto max-w-3xl text-center text-xs text-slate-300">{viewing.prompt_ja || viewing.prompt_en}</p>
          <div className="mt-3 flex flex-wrap justify-center gap-2">
            <Button variant="ghost" onClick={() => toggleFav(viewing).then(() => setViewing((v) => ({ ...v, is_favorite: !v.is_favorite })))}>
              <Heart size={16} aria-hidden="true" fill={viewing.is_favorite ? "currentColor" : "none"} /> お気に入り
            </Button>
            <Button variant="ghost" onClick={() => reuse(viewing)}><RefreshCw size={16} aria-hidden="true" /> 条件を再利用</Button>
            <Button accent="rose" onClick={() => onToVideo?.(viewing)}><Clapperboard size={16} aria-hidden="true" /> この画像から動画</Button>
            <Button variant="ghost" onClick={() => trash(viewing)}><Trash2 size={16} aria-hidden="true" /> ゴミ箱へ</Button>
          </div>
        </div>
      )}
    </div>
  );
}
