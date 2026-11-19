// 画像・動画の画面で共用する部品。データ取得は hub/api.js (PC版と同じ API) を使う。
import { useCallback, useEffect, useId, useState } from "react";
import { startEngines } from "../api.js";
import { studioCatalog, studioGallery, studioStatus } from "../hub/api.js";
import { Button, cx, Notice } from "./ui.jsx";

export const jobRunning = (job) => !!job && !["done", "error", "cancelled"].includes(job.status);

/**
 * Local Gen Studio の接続状態・カタログ・生成済み一覧。
 * items: undefined=読込中 / null=失敗 / []=空。エンジンの起動・停止で状態を取り直す (再読込しない)。
 */
export function useStudio(eng, kind, limit) {
  const [status, setStatus] = useState();
  const [catalog, setCatalog] = useState();
  const [catalogError, setCatalogError] = useState("");
  const [items, setItems] = useState();
  const [listError, setListError] = useState("");

  const reload = useCallback(() => studioGallery(kind, limit)
    .then((d) => { setItems(d.items); setListError(""); })
    .catch((e) => { setItems((prev) => (Array.isArray(prev) ? prev : null)); setListError(`一覧を読み込めません: ${e.message}`); }), [kind, limit]);

  const loadStatus = useCallback(() => studioStatus()
    .then((s) => {
      setStatus(s);
      if (!s.connected) return;
      studioCatalog().then((c) => { setCatalog(c); setCatalogError(""); }).catch((e) => setCatalogError(`モデル一覧を読み込めません: ${e.message}`));
      reload();
    })
    .catch((e) => setStatus({ connected: false, reason: `状態を取得できません: ${e.message}` })), [reload]);

  useEffect(() => {
    window.addEventListener("system-changed", loadStatus);
    return () => window.removeEventListener("system-changed", loadStatus);
  }, [loadStatus]);
  const studioState = eng.byId.studio?.state;
  const comfyState = eng.byId.comfy?.state;
  useEffect(() => { loadStatus(); }, [loadStatus, studioState, comfyState]);

  const ready = !!status?.connected && status.comfy !== false;
  return { status, ready, catalog, catalogError, items, setItems, listError, reload };
}

/** 接続できない理由と、ワンタップの起動ボタン。使えるときは何も出さない */
export function StudioNotice({ status, eng }) {
  const [pending, setPending] = useState(false);
  if (!status || (status.connected && status.comfy !== false)) return null;
  const starting = pending || eng.byId.studio?.state === "starting" || eng.byId.comfy?.state === "starting";
  const start = () => {
    setPending(true);
    eng.run(() => startEngines(["comfy", "studio"]), "起動しています…").finally(() => setPending(false));
  };
  return (
    <Notice tone="warn"
            action={<Button busy={starting} onClick={start}>Local Gen Studio を起動</Button>}>
      {status.connected ? (
        <>
          <span className="block font-semibold">ComfyUI が起動していません</span>
          <span className="block">起動するまで生成できません。</span>
        </>
      ) : (
        <>
          <span className="block font-semibold">Local Gen Studio に接続できません</span>
          <span className="block">{status.reason}</span>
        </>
      )}
    </Notice>
  );
}

/** 削除などの2段階タップ。1回目で id を構え、3秒で解除する */
export function useArmed(ms = 3000) {
  const [armed, setArmed] = useState(null);
  useEffect(() => {
    if (armed == null) return undefined;
    const t = setTimeout(() => setArmed(null), ms);
    return () => clearTimeout(t);
  }, [armed, ms]);
  return [armed, setArmed];
}

/** 数個の選択肢から1つ選ぶボタンの並び。options: [{ value, label, sub? }] */
export function OptionGrid({ label, hint, options, value, onChange, cols = "grid-cols-3" }) {
  const id = useId();
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2 text-sm">
        <span id={id} className="font-semibold text-m-fg">{label}</span>
        {hint && <span className="text-m-subtle">{hint}</span>}
      </div>
      <div role="radiogroup" aria-labelledby={id} className={cx("grid gap-2", cols)}>
        {options.map((o) => (
          <button key={o.value} type="button" role="radio" aria-checked={value === o.value} onClick={() => onChange(o.value)}
                  className={cx("min-h-12 rounded-xl border px-2 text-sm transition-colors motion-reduce:transition-none",
                    value === o.value ? "border-m-primary bg-m-primary-soft font-semibold text-m-fg" : "border-m-line-strong bg-m-surface text-m-muted active:bg-m-sunken")}>
            {o.label}
            {o.sub && <span className="m-num block text-xs font-normal text-m-subtle">{o.sub}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

export const PROMPT_MODES = [
  { value: "expand", label: "描写を足す" },
  { value: "translate", label: "忠実に英訳" },
  { value: "direct", label: "英語で直接" },
];
