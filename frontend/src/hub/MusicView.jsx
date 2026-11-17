// 音楽: 曲調タグと歌詞を組み立てて ACE-Step で生成し、トラック一覧で聴き比べる画面。
import { useEffect, useRef, useState } from "react";
import { Disc3, Music, PenLine, RefreshCw, Trash2 } from "lucide-react";
import { deleteMusic, draftLyrics, fetchCategories, generateMusic, musicList, musicModels } from "./api.js";
import { Button, ErrorNote, Field, inputCls, usePersisted } from "./ui.jsx";

const TAGS = {
  ジャンル: ["j-pop", "rock", "edm", "lo-fi hip hop", "jazz", "orchestral", "acoustic", "city pop"],
  雰囲気: ["upbeat", "emotional", "chill", "epic", "dark", "nostalgic"],
  声と楽器: ["female vocal", "male vocal", "piano", "guitar", "synth", "strings"],
};

const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

export default function MusicView() {
  const [models, setModels] = useState([]);
  const [tracks, setTracks] = useState([]);
  const [form, setForm] = usePersisted("hub.music.form", { theme: "", style: "", lyrics: "", instrumental: false, duration: 30, model: "", title: "" });
  const [busy, setBusy] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState("");
  const [fresh, setFresh] = useState(null);
  const [notice, setNotice] = useState("");
  const timer = useRef(null);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const [loaded, setLoaded] = useState(false);   // 初回の一覧取得前に「まだありません」と出さない
  const reload = () => musicList().then((d) => setTracks(d.items)).catch((e) => setError(e.message)).finally(() => setLoaded(true));
  useEffect(() => {
    musicModels().then((d) => setModels(d.models)).catch((e) => setError(e.message));
    fetchCategories().then((c) => setForm((f) => ({ ...f, model: f.model || c.categories?.music?.model || "music", duration: f.duration || c.categories?.music?.duration || 30 }))).catch(() => {});
    reload();
    return () => clearInterval(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const current = models.find((m) => m.key === form.model);
  const tagSet = new Set(form.style.split(",").map((t) => t.trim()).filter(Boolean));
  const toggleTag = (t) => {
    const next = new Set(tagSet);
    next.has(t) ? next.delete(t) : next.add(t);
    set("style", [...next].join(", "));
  };

  async function draft() {
    setError("");
    setBusy("歌詞と曲調を考え中…");
    try {
      const d = await draftLyrics({ theme: form.theme, language: "ja", duration: form.duration });
      setForm((f) => ({ ...f, style: d.style || f.style, lyrics: d.lyrics || f.lyrics, title: f.title || f.theme.slice(0, 30) }));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  }

  async function generate() {
    setError("");
    setBusy("作曲中…");
    setElapsed(0);
    const t0 = Date.now();
    timer.current = setInterval(() => setElapsed((Date.now() - t0) / 1000), 1000);
    try {
      const r = await generateMusic({
        model: form.model, prompt: form.style || form.theme, lyrics: form.instrumental ? null : form.lyrics,
        instrumental: form.instrumental, duration: Number(form.duration), title: form.title || form.theme.slice(0, 40),
      });
      setFresh(r.file);
      setNotice(r.gpu_switch?.length ? r.gpu_switch.join("・") : "");
      reload();
    } catch (e) {
      setError(e.message);
    } finally {
      clearInterval(timer.current);
      setBusy("");
    }
  }

  // 曲の削除は元に戻せないので2段階(1回目で「削除?」→3秒以内にもう一度)。一覧は成功時だけ外す
  const [armed, setArmed] = useState(null);
  useEffect(() => {
    if (!armed) return undefined;
    const t = setTimeout(() => setArmed(null), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  async function remove(t) {
    if (armed !== t.file) return setArmed(t.file);
    setArmed(null);
    try {
      await deleteMusic(t.file);
      setTracks((xs) => xs.filter((x) => x.file !== t.file));
    } catch (e) { setError(e.message); }
  }

  const reuse = (t) => setForm((f) => ({ ...f, style: t.prompt || "", lyrics: t.lyrics || "", instrumental: !!t.instrumental, duration: Math.round(t.duration || f.duration), title: t.title || "" }));

  return (
    <div className="flex h-full flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
      <section className="space-y-4 p-4 lg:w-[440px] lg:shrink-0 lg:overflow-y-auto lg:border-r lg:border-slate-800">
        <h1 className="flex items-center gap-2 text-base font-semibold text-amber-200"><Music size={18} aria-hidden="true" /> 曲を作る</h1>
        {current && !current.connected && (
          <p className="rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-xs text-slate-300">ACE-Step は停止中です。生成するときに画像側のモデルを解放して自動で起動します（初回は1分ほど余分にかかります）。</p>
        )}

        <Field label="テーマ（日本語でOK）">
          <div className="flex gap-2">
            <input value={form.theme} onChange={(e) => set("theme", e.target.value)} placeholder="例: 雨上がりの帰り道、少し前向きな気持ち" className={`${inputCls} focus:ring-amber-500/50`} />
            <Button accent="amber" variant="ghost" onClick={draft} disabled={!form.theme.trim() || !!busy} title="ローカルLLMが歌詞と曲調タグを下書きします">
              <PenLine size={16} aria-hidden="true" /> 下書き
            </Button>
          </div>
        </Field>

        <Field label="曲調タグ（英語・カンマ区切り）">
          <input value={form.style} onChange={(e) => set("style", e.target.value)} placeholder="j-pop, upbeat, female vocal, piano" className={`${inputCls} font-mono text-xs focus:ring-amber-500/50`} />
        </Field>
        <div className="space-y-2">
          {Object.entries(TAGS).map(([group, tags]) => (
            <div key={group} className="flex flex-wrap items-center gap-1.5">
              <span className="w-16 shrink-0 text-[11px] text-slate-500">{group}</span>
              {tags.map((t) => (
                <button key={t} type="button" onClick={() => toggleTag(t)} aria-pressed={tagSet.has(t)} className={`min-h-8 rounded-full border px-2.5 text-[11px] ${tagSet.has(t) ? "border-amber-500/40 bg-amber-500/10 text-amber-200" : "border-slate-700 text-slate-400 hover:text-slate-200"}`}>{t}</button>
              ))}
            </div>
          ))}
        </div>

        <label className="flex min-h-10 items-center gap-2 text-sm text-slate-300">
          <input type="checkbox" checked={form.instrumental} onChange={(e) => set("instrumental", e.target.checked)} className="h-4 w-4 accent-amber-500" />
          インスト（歌なし）
        </label>
        {!form.instrumental && (
          <Field label="歌詞" hint="[verse] [chorus] で構成を指定">
            <textarea rows={9} value={form.lyrics} onChange={(e) => set("lyrics", e.target.value)} placeholder={"[verse]\n…\n[chorus]\n…"} className={`${inputCls} font-mono text-xs leading-relaxed focus:ring-amber-500/50`} />
          </Field>
        )}

        <Field label="長さ" hint={fmtTime(form.duration)}>
          <input type="range" min={10} max={240} step={5} value={form.duration} onChange={(e) => set("duration", Number(e.target.value))} className="w-full accent-amber-500" aria-label="曲の長さ（秒）" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="モデル">
            <select value={form.model} onChange={(e) => set("model", e.target.value)} className={`${inputCls} focus:ring-amber-500/50`}>
              {models.map((m) => <option key={m.key} value={m.key}>{m.key}{m.connected ? "" : "（未接続）"}</option>)}
            </select>
          </Field>
          <Field label="曲名">
            <input value={form.title} onChange={(e) => set("title", e.target.value)} className={`${inputCls} focus:ring-amber-500/50`} />
          </Field>
        </div>
        {current?.for && <p className="text-[11px] text-slate-500">{current.for}</p>}

        <ErrorNote text={error} onClose={() => setError("")} />
        {notice && <p className="text-[11px] text-slate-400">GPU の切り替え: {notice}</p>}
        <Button accent="amber" className="w-full" onClick={generate} disabled={!!busy || !(form.style.trim() || form.theme.trim())}>
          <Disc3 size={16} className={busy === "作曲中…" ? "animate-spin" : ""} aria-hidden="true" />
          {busy ? `${busy}${busy === "作曲中…" ? ` ${fmtTime(elapsed)}` : ""}` : "生成する"}
        </Button>
        {busy === "作曲中…" && <p className="text-[11px] text-slate-500">30秒の曲でおよそ40秒〜（ACE-Step の起動・モデル読込があると+1分ほど）。生成前にチャットと画像のモデルを VRAM から降ろします。</p>}
      </section>

      <section className="min-h-0 flex-1 p-4 lg:overflow-y-auto">
        <div className="mb-3 flex items-center">
          <h2 className="mr-auto text-sm font-semibold text-slate-200">トラック <span className="font-normal text-slate-500">{tracks.length}曲</span></h2>
          <button type="button" onClick={reload} className="flex min-h-9 items-center gap-1 px-2 text-xs text-slate-400 hover:text-slate-200"><RefreshCw size={14} aria-hidden="true" /> 更新</button>
        </div>
        <ul className="space-y-2">
          {tracks.map((t) => (
            <li key={t.file} className={`rounded-xl border p-3 ${t.file === fresh ? "border-amber-500/50 bg-amber-500/5" : "border-slate-800 bg-slate-900/40"}`}>
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-amber-500/40 to-rose-500/30"><Music size={18} aria-hidden="true" /></div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-100">{t.title}</p>
                  <p className="truncate text-[11px] text-slate-500">{[t.prompt, t.duration && fmtTime(t.duration), t.model, t.elapsed_sec && `生成${Math.round(t.elapsed_sec)}秒`].filter(Boolean).join(" · ")}</p>
                </div>
                <button type="button" onClick={() => reuse(t)} className="min-h-8 px-2 text-[11px] text-slate-400 hover:text-amber-200">再利用</button>
                <button type="button" onClick={() => remove(t)} className={`min-h-8 min-w-8 px-1 text-[11px] ${armed === t.file ? "font-semibold text-red-300" : "text-slate-500 hover:text-red-300"}`} aria-label={armed === t.file ? `もう一度押すと「${t.title}」を削除` : `「${t.title}」を削除`}>
                  {armed === t.file ? "削除?" : <Trash2 size={14} className="mx-auto" aria-hidden="true" />}
                </button>
              </div>
              <audio src={t.url} controls preload="none" autoPlay={t.file === fresh} className="mt-2 w-full" />
              {t.lyrics && (
                <details className="mt-1 text-xs text-slate-400">
                  <summary className="cursor-pointer select-none">歌詞</summary>
                  <pre className="mt-1 whitespace-pre-wrap font-sans">{t.lyrics}</pre>
                </details>
              )}
            </li>
          ))}
        </ul>
        {!loaded && <p role="status" className="py-16 text-center text-sm text-slate-500">読み込んでいます…</p>}
        {loaded && !tracks.length && <p className="py-16 text-center text-sm text-slate-500">まだ曲がありません</p>}
      </section>
    </div>
  );
}
