// スマホ版の音楽。曲調タグと歌詞を組み立てて ACE-Step で生成し、トラック一覧で聴く。
// 入力は PC 版と同じ保存先 (hub.music.form)。シークレット中の入力と曲はメモリにだけ置き、終えるときにサーバーの音声ファイルも消す。
import { useEffect, useRef, useState } from "react";
import { Check, ChevronRight, Disc3, Download, EyeOff, Music, PenLine, Power, RefreshCw, RotateCcw, SlidersHorizontal, Trash2 } from "lucide-react";
import { startEngines } from "../api.js";
import { deleteMusic, discardMusic, draftLyrics, fetchCategories, generateMusic, musicList, musicModels } from "../hub/api.js";
import { Button, cx, Empty, Field, inputCls, Loading, Notice, Progress, ScreenHeader, Sheet, SwitchRow, usePersisted } from "./ui.jsx";

const TAGS = {
  ジャンル: ["j-pop", "rock", "edm", "lo-fi hip hop", "jazz", "orchestral", "acoustic", "city pop"],
  雰囲気: ["upbeat", "emotional", "chill", "epic", "dark", "nostalgic"],
  声と楽器: ["female vocal", "male vocal", "piano", "guitar", "synth", "strings"],
};

const BLANK = { theme: "", style: "", lyrics: "", instrumental: false, duration: 30, model: "", title: "" };
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

export default function MusicScreen({ eng }) {
  const [models, setModels] = useState(undefined);   // undefined=読込中
  const [modelsError, setModelsError] = useState("");
  const [saved, setSaved] = useState(undefined);     // undefined=読込中 / null=取得失敗
  const [listError, setListError] = useState("");
  const [listBusy, setListBusy] = useState(false);
  const [kept, setKept] = usePersisted("hub.music.form", BLANK);
  // シークレット中の入力と曲。localStorage にも一覧 (/music/list) にも入れない。null は通常モード
  const [secret, setSecret] = useState(null);
  const form = { ...BLANK, ...(secret?.form ?? kept) };
  const setForm = (fn) => (secret ? setSecret((s) => s && { ...s, form: fn(s.form) }) : setKept(fn));
  const tracks = secret ? secret.tracks : saved;
  const [busy, setBusy] = useState("");              // "" / "draft" / "make"
  const [elapsed, setElapsed] = useState(0);
  const [draftError, setDraftError] = useState("");
  const [makeError, setMakeError] = useState("");
  const [fresh, setFresh] = useState(null);
  const [done, setDone] = useState("");
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const timer = useRef(null);
  const scrollRef = useRef(null);
  const listRef = useRef(null);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const loadModels = (silent) => musicModels()
    .then((d) => { setModels(d.models); setModelsError(""); })
    .catch((e) => { if (!silent) { setModels((m) => m ?? []); setModelsError(e.message); } });
  const reload = () => {
    setListBusy(true);
    return musicList()
      .then((d) => { setSaved(d.items); setListError(""); })
      .catch((e) => { setListError(e.message); setSaved((s) => s ?? null); })
      .finally(() => setListBusy(false));
  };
  // 画面は隠れても残るので、エンジンの起動・停止のたびに ACE-Step の状態を取り直す
  useEffect(() => {
    const refresh = () => loadModels(true);
    window.addEventListener("system-changed", refresh);
    return () => window.removeEventListener("system-changed", refresh);
  }, []);
  useEffect(() => {
    loadModels(false);
    fetchCategories().then((c) => setKept((f) => ({ ...f, model: f.model || c.categories?.music?.model || "music", duration: f.duration || c.categories?.music?.duration || 30 }))).catch(() => {});
    reload();
    return () => clearInterval(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (fresh) listRef.current?.scrollIntoView({ block: "start" });
  }, [fresh]);

  // 画面を離れる・閉じる・再読み込みでもシークレットの曲を残さない
  const secretFiles = useRef(null);
  secretFiles.current = secret && secret.tracks.map((t) => t.file);
  useEffect(() => {
    const drop = () => secretFiles.current?.forEach(discardMusic);
    window.addEventListener("pagehide", drop);
    return () => { window.removeEventListener("pagehide", drop); drop(); };
  }, []);
  const toggleSecret = () => {
    secretFiles.current?.forEach(discardMusic);
    setSecret(secret ? null : { form: { ...BLANK, model: kept.model, duration: kept.duration }, tracks: [] });
    setDraftError(""); setMakeError(""); setDone(""); setFresh(null);
  };

  const current = models?.find((m) => m.key === form.model);
  const tagSet = new Set(form.style.split(",").map((t) => t.trim()).filter(Boolean));
  const toggleTag = (t) => {
    const next = new Set(tagSet);
    if (next.has(t)) next.delete(t); else next.add(t);
    set("style", [...next].join(", "));
  };

  async function draft() {
    setDraftError("");
    setBusy("draft");
    try {
      const d = await draftLyrics({ theme: form.theme, language: "ja", duration: form.duration });
      setForm((f) => ({ ...f, style: d.style || f.style, lyrics: d.lyrics || f.lyrics, title: f.title || f.theme.slice(0, 30) }));
    } catch (e) {
      setDraftError(e.message);
    } finally {
      setBusy("");
    }
  }

  async function generate() {
    setMakeError("");
    setDone("");
    setBusy("make");
    setElapsed(0);
    const sent = form;
    const t0 = Date.now();
    timer.current = setInterval(() => setElapsed((Date.now() - t0) / 1000), 1000);
    try {
      const r = await generateMusic({
        model: form.model, prompt: form.style || form.theme, lyrics: form.instrumental ? null : form.lyrics,
        instrumental: form.instrumental, duration: Number(form.duration), title: form.title || form.theme.slice(0, 40),
        secret: !!secret,
      });
      setFresh(r.file);
      // できあがったら入力を空に戻す (生成中に書き換えた欄は残す)
      setForm((f) => ({ ...f, ...Object.fromEntries(["theme", "style", "lyrics", "title"].filter((k) => f[k] === sent[k]).map((k) => [k, ""])) }));
      setDone(`「${r.title || "曲"}」ができました。${r.gpu_switch?.length ? `GPU の切り替え: ${r.gpu_switch.join("・")}` : ""}`);
      if (secret) setSecret((s) => s && { ...s, tracks: [r, ...s.tracks] });
      else reload();
    } catch (e) {
      setMakeError(e.message);
    } finally {
      clearInterval(timer.current);
      setBusy("");
    }
  }

  // 曲の削除は元に戻せないので2段階(1回目で「削除する」→3秒以内にもう一度)。一覧は成功時だけ外す
  const [armed, setArmed] = useState(null);
  const [removing, setRemoving] = useState(null);
  useEffect(() => {
    if (!armed) return undefined;
    const t = setTimeout(() => setArmed(null), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  async function remove(t) {
    if (armed !== t.file) return setArmed(t.file);
    setArmed(null);
    setRemoving(t.file);
    try {
      await deleteMusic(t.file);
      if (secret) setSecret((s) => s && { ...s, tracks: s.tracks.filter((x) => x.file !== t.file) });
      else setSaved((xs) => xs?.filter((x) => x.file !== t.file));
      setListError("");
    } catch (e) { setListError(`削除できませんでした: ${e.message}`); }
    setRemoving(null);
  }

  const [reused, setReused] = useState(null);
  useEffect(() => {
    if (!reused) return undefined;
    const t = setTimeout(() => setReused(null), 2000);
    return () => clearTimeout(t);
  }, [reused]);
  const reuse = (t) => {
    setForm((f) => ({ ...f, style: t.prompt || "", lyrics: t.lyrics || "", instrumental: !!t.instrumental, duration: Math.round(t.duration || f.duration), title: t.title || "" }));
    setReused(t.file);
    scrollRef.current?.scrollTo({ top: 0 });
  };

  // ACE-Step が止まっているときの案内 (状態の確認中・取得失敗のときは出さない。上の1行が知らせる)
  const ace = eng.byId.acestep;
  const aceDown = !!eng.st && ace?.state !== "up";
  const aceStarting = ace?.state === "starting";
  const startAce = async () => {
    setStarting(true);
    await eng.run(() => startEngines(["acestep"]), "起動しています…");
    setStarting(false);
  };

  const canMake = !!(form.style.trim() || form.theme.trim());
  const summary = [form.model || "モデル未選択", fmtTime(form.duration), form.instrumental && "インスト", secret && "シークレット"].filter(Boolean).join(" · ");

  return (
    <div className="flex h-full flex-col">
      <ScreenHeader title={secret ? <span className="flex items-center gap-2"><EyeOff size={18} aria-hidden="true" className="shrink-0 text-m-primary" />音楽（シークレット）</span> : "音楽"} />

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">
        <div className="space-y-4">
          {aceDown && (
            <Notice
              tone="warn"
              action={!aceStarting && (
                <Button icon={Power} busy={starting} disabled={ace?.startable === false} onClick={startAce}>ACE-Step を起動する</Button>
              )}
            >
              {aceStarting
                ? "ACE-Step を起動しています…（1分ほどかかります）"
                : ace?.startable === false
                  ? `ACE-Step を起動できません: ${ace.why}`
                  : "ACE-Step が止まっています。このまま作ると自動で起動しますが、先に起動しておくと待たずに済みます。"}
            </Notice>
          )}
          {secret && <Notice>シークレット中です。入力と曲は保存されず、解除・再読み込み・画面を閉じたときに消えます。</Notice>}

          <Field label="テーマ" hint="日本語でOK">
            <input aria-label="テーマ" value={form.theme} onChange={(e) => set("theme", e.target.value)} placeholder="例: 雨上がりの帰り道、少し前向きな気持ち" className={inputCls} />
          </Field>
          <div className="space-y-2">
            <Button icon={PenLine} busy={busy === "draft"} disabled={!!busy || !form.theme.trim()} onClick={draft} className="w-full">歌詞と曲調を下書きする</Button>
            {busy === "draft" && <p role="status" className="text-sm text-m-muted">歌詞と曲調を考えています…</p>}
            {!busy && !form.theme.trim() && <p className="text-sm text-m-subtle">テーマを入れると、ローカルLLMが下書きします。</p>}
            <Notice tone="error" onClose={() => setDraftError("")}>{draftError && `下書きできませんでした: ${draftError}`}</Notice>
          </div>

          <Field label="曲調タグ" hint="英語・カンマ区切り">
            <input aria-label="曲調タグ" value={form.style} onChange={(e) => set("style", e.target.value)} placeholder="j-pop, upbeat, female vocal, piano" className={inputCls} />
          </Field>
          {!form.instrumental && (
            <Field label="歌詞" hint="[verse] [chorus] で構成を指定">
              <textarea rows={8} value={form.lyrics} onChange={(e) => set("lyrics", e.target.value)} placeholder={"[verse]\n…\n[chorus]\n…"} className={inputCls} />
            </Field>
          )}

          <button type="button" onClick={() => setOptionsOpen(true)}
                  className="flex min-h-12 w-full items-center gap-3 rounded-xl border border-m-line-strong bg-m-surface px-3 text-left active:bg-m-sunken">
            <SlidersHorizontal size={20} aria-hidden="true" className="shrink-0 text-m-muted" />
            <span className="min-w-0 flex-1">
              <span className="block text-base font-semibold">曲の設定</span>
              <span className="block truncate text-sm text-m-muted">{summary}</span>
            </span>
            <ChevronRight size={18} aria-hidden="true" className="shrink-0 text-m-subtle" />
          </button>

          <div className="space-y-2">
            <Notice tone="error" onClose={() => setMakeError("")}>{makeError && `曲を作れませんでした: ${makeError}`}</Notice>
            <Button variant="primary" icon={Disc3} busy={busy === "make"} disabled={!!busy || !canMake} onClick={generate} className="w-full">曲を作る</Button>
            {!busy && !canMake && <p className="text-sm text-m-subtle">テーマか曲調タグを入れると作れます。</p>}
            {busy === "make" && (
              <>
                <Progress text={<>作曲しています… <span className="m-num">{fmtTime(elapsed)}</span></>} />
                <p className="text-sm text-m-subtle">30秒の曲でおよそ40秒から。ACE-Step の起動やモデルの読み込みがあると、1分ほど余分にかかります。生成の前に、チャットと画像のモデルを VRAM から降ろします。</p>
              </>
            )}
          </div>
        </div>

        <section ref={listRef} aria-labelledby="m-music-tracks" className="mt-8 scroll-mt-2">
          <div className="mb-3 flex min-h-12 items-center gap-2">
            <h2 id="m-music-tracks" className="min-w-0 flex-1 text-base font-semibold">
              トラック {Array.isArray(tracks) && <span className="m-num text-sm font-normal text-m-muted">{tracks.length}曲</span>}
            </h2>
            {!secret && <Button variant="ghost" icon={RefreshCw} busy={listBusy} onClick={reload}>更新</Button>}
          </div>
          {done && <div className="mb-3"><Notice onClose={() => setDone("")}>{done}</Notice></div>}
          {listError && saved !== null && <div className="mb-3"><Notice tone="error" onClose={() => setListError("")}>{listError}</Notice></div>}

          {tracks === undefined ? <Loading text="曲の一覧を読み込んでいます…" />
            : tracks === null ? (
              <Empty icon={Music} title="曲の一覧を取得できませんでした" hint={listError || "PCにつながっているか確認してください。"}
                     action={<Button icon={RefreshCw} busy={listBusy} onClick={reload}>もう一度読み込む</Button>} />
            ) : !tracks.length ? (
              <Empty icon={Music} title="まだ曲がありません" hint={secret ? "ここに出る曲は、解除すると消えます。" : "テーマか曲調タグを入れて「曲を作る」を押すと、ここに並びます。"} />
            ) : (
              <ul className="space-y-3">
                {tracks.map((t) => (
                  <li key={t.file} className={cx("rounded-2xl border bg-m-surface p-4", t.file === fresh ? "border-m-primary" : "border-m-line")}>
                    {t.file === fresh && <p className="mb-1 flex items-center gap-1 text-sm font-semibold text-m-primary"><Check size={16} aria-hidden="true" /> できあがり</p>}
                    <h3 className="text-base font-semibold">{t.title}</h3>
                    {t.prompt && <p className="text-sm text-m-muted">{t.prompt}</p>}
                    <p className="text-sm text-m-subtle">{[t.duration && fmtTime(t.duration), t.model, t.elapsed_sec && `生成${Math.round(t.elapsed_sec)}秒`].filter(Boolean).join(" · ")}</p>
                    <audio src={t.url} controls preload="none" aria-label={`「${t.title}」を再生`} className="mt-3 w-full" />
                    {t.lyrics && (
                      <details className="mt-2 text-sm text-m-muted">
                        <summary className="flex min-h-12 cursor-pointer items-center">歌詞を見る</summary>
                        <pre className="whitespace-pre-wrap font-sans">{t.lyrics}</pre>
                      </details>
                    )}
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button icon={reused === t.file ? Check : RotateCcw} onClick={() => reuse(t)}>{reused === t.file ? "入れました" : "設定を使う"}</Button>
                      <a href={t.url} download={t.file} aria-label={`「${t.title}」を保存`}
                         className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-m-line-strong bg-m-surface px-4 text-base font-semibold text-m-fg active:bg-m-sunken">
                        <Download size={18} aria-hidden="true" /> 保存
                      </a>
                      <Button variant={armed === t.file ? "danger" : "secondary"} icon={Trash2} busy={removing === t.file} disabled={!!removing}
                              aria-label={armed === t.file ? `もう一度押すと「${t.title}」を削除` : `「${t.title}」を削除`} onClick={() => remove(t)}>
                        {armed === t.file ? "削除する" : "削除"}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
        </section>
      </div>

      <Sheet open={optionsOpen} onClose={() => setOptionsOpen(false)} title="曲の設定"
             footer={<Button className="w-full" onClick={() => setOptionsOpen(false)}>閉じる</Button>}>
        <div className="space-y-4">
          {modelsError && (
            <Notice tone="error" action={<Button onClick={() => loadModels(false)}>もう一度読み込む</Button>}>モデルの一覧を取得できませんでした: {modelsError}</Notice>
          )}
          <Field label="モデル">
            <select value={form.model} onChange={(e) => set("model", e.target.value)} className={inputCls}>
              {models === undefined && <option value={form.model}>読み込んでいます…</option>}
              {models && !current && <option value={form.model}>{form.model || "選んでください"}</option>}
              {models?.map((m) => <option key={m.key} value={m.key}>{m.key}{m.connected ? "" : "（未接続）"}</option>)}
            </select>
          </Field>
          {current?.for && <p className="text-sm text-m-muted">{current.for}</p>}
          <Field label="長さ" hint={<span className="m-num">{fmtTime(form.duration)}</span>}>
            <input type="range" min={10} max={240} step={5} value={form.duration} onChange={(e) => set("duration", Number(e.target.value))}
                   className="block h-12 w-full accent-m-primary" />
          </Field>
          <Field label="曲名">
            <input aria-label="曲名" value={form.title} onChange={(e) => set("title", e.target.value)} placeholder="空ならテーマから付けます" className={inputCls} />
          </Field>

          {Object.entries(TAGS).map(([group, tags]) => (
            <fieldset key={group}>
              <legend className="mb-1 text-sm font-semibold">{group}のタグ</legend>
              <div className="flex flex-wrap gap-2">
                {tags.map((t) => (
                  <button key={t} type="button" onClick={() => toggleTag(t)} aria-pressed={tagSet.has(t)}
                          className={cx("m-num inline-flex min-h-12 items-center gap-1 rounded-full border px-4 text-sm transition-colors motion-reduce:transition-none",
                            tagSet.has(t) ? "border-m-primary bg-m-primary-soft font-semibold text-m-fg" : "border-m-line-strong text-m-muted active:bg-m-sunken")}>
                    {tagSet.has(t) && <Check size={14} aria-hidden="true" />}{t}
                  </button>
                ))}
              </div>
            </fieldset>
          ))}

          <div className="divide-y divide-m-line">
            <SwitchRow label="インスト（歌なし）" hint="歌詞を使わず、演奏だけを作る" checked={form.instrumental} onChange={(on) => set("instrumental", on)} />
            <SwitchRow icon={EyeOff} label="シークレット" hint="入力と曲を保存せず、解除や画面を閉じたときに曲ごと消す" checked={!!secret} disabled={!!busy} onChange={toggleSecret} />
          </div>
        </div>
      </Sheet>
    </div>
  );
}
